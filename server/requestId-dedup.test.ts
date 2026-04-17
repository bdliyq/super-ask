import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { WsServerMessage, WsSync } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-dedup-"));
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

function fireAndAbort(
  port: number,
  body: Record<string, unknown>,
): Promise<void> {
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
        res.resume();
        req.destroy();
        resolve();
      },
    );
    req.on("error", () => resolve());
    req.write(data);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 400);
  });
}

function getSessionsViaWs(port: number): Promise<WsSync> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WS sync timeout"));
    }, 5000);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsServerMessage;
      if (msg.type === "sync") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("requestId dedup: retry with same requestId creates only 1 entry", async () => {
  await withIsolatedHome(async () => {
    const running = await startTestServer();
    try {
      const port = (running.httpServer.address() as AddressInfo).port;

      const payload = {
        summary: "test summary",
        question: "test question?",
        title: "dedup test",
        chatSessionId: "dedup-session-001",
        requestId: "dedup-rid-001",
        source: "test",
      };

      await fireAndAbort(port, payload);
      await delay(300);
      await fireAndAbort(port, payload);
      await delay(300);
      await fireAndAbort(port, payload);
      await delay(300);

      const sync = await getSessionsViaWs(port);

      assert.equal(sync.sessions.length, 1);
      const agentEntries = sync.sessions[0].history.filter(
        (e) => e.role === "agent",
      );
      assert.equal(agentEntries.length, 1, `expected 1 agent entry, got ${agentEntries.length}`);
    } finally {
      await running.shutdown();
    }
  });
});

test("without requestId: retries create multiple entries", async () => {
  await withIsolatedHome(async () => {
    const running = await startTestServer();
    try {
      const port = (running.httpServer.address() as AddressInfo).port;

      const payload = {
        summary: "no-dedup",
        question: "no-dedup?",
        title: "no-dedup test",
        chatSessionId: "no-dedup-session",
        source: "test",
      };

      await fireAndAbort(port, payload);
      await delay(300);
      await fireAndAbort(port, payload);
      await delay(300);

      const sync = await getSessionsViaWs(port);

      assert.equal(sync.sessions.length, 1);
      const agentEntries = sync.sessions[0].history.filter(
        (e) => e.role === "agent",
      );
      assert.equal(agentEntries.length, 2, `expected 2 entries without requestId, got ${agentEntries.length}`);
    } finally {
      await running.shutdown();
    }
  });
});

test("different requestIds create separate entries", async () => {
  await withIsolatedHome(async () => {
    const running = await startTestServer();
    try {
      const port = (running.httpServer.address() as AddressInfo).port;

      const base = {
        summary: "multi",
        question: "multi?",
        title: "multi test",
        chatSessionId: "multi-session",
        source: "test",
      };

      await fireAndAbort(port, { ...base, requestId: "rid-A" });
      await delay(300);
      await fireAndAbort(port, { ...base, requestId: "rid-B" });
      await delay(300);

      const sync = await getSessionsViaWs(port);

      const agentEntries = sync.sessions[0].history.filter(
        (e) => e.role === "agent",
      );
      assert.equal(agentEntries.length, 2, `expected 2 entries for different requestIds, got ${agentEntries.length}`);
    } finally {
      await running.shutdown();
    }
  });
});
