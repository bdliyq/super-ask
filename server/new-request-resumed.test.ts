import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { DEFAULT_CONFIG } from "../shared/types";
import type { WsNewRequest, WsServerMessage } from "../shared/types";

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-resumed-"));
  try {
    process.env.HOME = home;
    return await fn();
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}

async function startTestServer() {
  const { startSuperAsk } = await import("./src/server");
  return startSuperAsk(
    { ...DEFAULT_CONFIG, host: "127.0.0.1", port: 0 },
    "test-token",
  );
}

// 建立长连接但立即 destroy socket，模拟 hook 的阻塞 POST 被中断
function openAskAndDestroy(
  port: number,
  body: Record<string, unknown>,
  options: { holdMs?: number } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/super-ask",
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: "Bearer test-token",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let collected = "";
        res.on("data", (chunk: Buffer) => {
          collected += chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: collected });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.write(data);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve({ status: 0, body: "" });
    }, options.holdMs ?? 500);
  });
}

interface WsMonitor {
  messages: WsServerMessage[];
  close: () => Promise<void>;
}

function openWsMonitor(port: number): Promise<WsMonitor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    const messages: WsServerMessage[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WS connect timeout"));
    }, 2000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({
        messages,
        close: () =>
          new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) return res();
            ws.once("close", () => res());
            ws.close();
          }),
      });
    });
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()) as WsServerMessage);
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "same-requestId retry rebroadcasts new_request with resumed=true and does not duplicate agent history",
  async () => {
    await withIsolatedHome(async () => {
      const running = await startTestServer();
      try {
        const port = (running.httpServer.address() as AddressInfo).port;

        const monitor = await openWsMonitor(port);
        try {
          const payload = {
            summary: "ask summary",
            question: "ask question?",
            title: "resumed test",
            chatSessionId: "resumed-session",
            requestId: "resumed-rid-001",
            source: "test",
          };

          // 第一次 ask：建立 pending，然后客户端主动断开模拟 hook 被中断
          await openAskAndDestroy(port, payload, { holdMs: 400 });
          await delay(150);

          // 第二次 ask：同 chatSessionId + 同 requestId，模拟 CLI 的重试或
          // 服务端重启后 hook 重新挂上长连接
          await openAskAndDestroy(port, payload, { holdMs: 400 });
          await delay(150);

          const newRequestMsgs = monitor.messages.filter(
            (m): m is WsNewRequest =>
              m.type === "new_request" && m.chatSessionId === "resumed-session",
          );

          // 两次请求都应该产生 new_request 广播
          assert.equal(
            newRequestMsgs.length,
            2,
            `expected 2 new_request broadcasts, got ${newRequestMsgs.length}: ${JSON.stringify(newRequestMsgs)}`,
          );

          // 两次都必须带上 requestId，供 UI 根据幂等键去重
          assert.equal(newRequestMsgs[0].requestId, "resumed-rid-001");
          assert.equal(newRequestMsgs[1].requestId, "resumed-rid-001");

          // 首次没有 resumed 标记，第二次（dedup 分支）必须标记 resumed=true
          assert.equal(newRequestMsgs[0].resumed, undefined);
          assert.equal(newRequestMsgs[1].resumed, true);

          // 服务端历史中 agent entry 只有 1 条（同 requestId 去重不追加）
          const session = running.sessionManager
            .listSessionsForSync()
            .find((s) => s.chatSessionId === "resumed-session");
          assert.ok(session, "session should exist");
          const agentEntries = session.history.filter((e) => e.role === "agent");
          assert.equal(
            agentEntries.length,
            1,
            `expected 1 agent entry after dedup, got ${agentEntries.length}`,
          );
          assert.equal(agentEntries[0].requestId, "resumed-rid-001");
        } finally {
          await monitor.close();
        }
      } finally {
        await running.close();
      }
    });
  },
);

test(
  "superseding ask returns INVALID_REQUEST in the superseded request's body",
  async () => {
    await withIsolatedHome(async () => {
      const running = await startTestServer();
      try {
        const port = (running.httpServer.address() as AddressInfo).port;

        const basePayload = {
          summary: "first ask",
          question: "first?",
          title: "supersede",
          chatSessionId: "supersede-session",
          source: "test",
        };

        // 构造 prev pending：启动后不 abort，留住连接
        const prevPromise = new Promise<{ status: number; body: string }>((resolve) => {
          const data = JSON.stringify({ ...basePayload, requestId: "rid-A" });
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/super-ask",
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: "Bearer test-token",
                "Content-Length": Buffer.byteLength(data),
              },
            },
            (res) => {
              let collected = "";
              res.on("data", (chunk: Buffer) => {
                collected += chunk.toString("utf-8");
              });
              res.on("end", () => {
                resolve({ status: res.statusCode ?? 0, body: collected });
              });
            },
          );
          req.on("error", () => resolve({ status: 0, body: "" }));
          req.write(data);
          req.end();
        });

        await delay(150);

        // 用不同 requestId 发起同 session 的新请求，触发 supersede 路径
        void openAskAndDestroy(
          port,
          { ...basePayload, requestId: "rid-B" },
          { holdMs: 300 },
        );

        const prev = await Promise.race([
          prevPromise,
          delay(1500).then(() => {
            throw new Error("prev request did not complete in time");
          }),
        ]);

        // 长连接建立时头已经写成 200，status 不会变，但 body 必须给出结构化
        // 的 INVALID_REQUEST 错误码，让 CLI 能识别 supersede 并安静退出，避免
        // Cursor 的 failClosed hook 把下一轮任务卡住
        assert.equal(prev.status, 200);
        // 去掉心跳占位符空白字符后再解析 JSON
        const parsed = JSON.parse(prev.body.trim());
        assert.equal(parsed.code, "INVALID_REQUEST");
        assert.equal(typeof parsed.error, "string");
      } finally {
        await running.close();
      }
    });
  },
);
