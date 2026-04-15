import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { SessionInfo, WsServerMessage } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";
import { SessionManager } from "./src/sessionManager";
import { WsHub } from "./src/wsHub";

function makeSession(
  chatSessionId: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    chatSessionId,
    title: "测试会话",
    history: [],
    hasPending: true,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    requestStatus: "pending",
    ...overrides,
  };
}

function makeFakeWs(messages: unknown[]) {
  return {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      messages.push(JSON.parse(payload));
    },
  };
}

function makePendingHttpRes(messages: unknown[]) {
  return {
    writableEnded: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(payload?: string) {
      if (payload) messages.push(JSON.parse(payload));
      this.writableEnded = true;
    },
  };
}

async function withIsolatedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-ws-hub-test-"));

  try {
    process.env.HOME = home;
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("WsHub sends accepted reply_result after a valid reply", async () => {
  await withIsolatedHome(async () => {
    const broadcasts: WsServerMessage[] = [];
    const manager = new SessionManager(DEFAULT_CONFIG, (msg) => broadcasts.push(msg));
    const httpServer = createServer();
    const hub = new WsHub(manager, httpServer, "token");
    const sent: unknown[] = [];
    const blockingResponses: unknown[] = [];
    const sid = "reply-ok-session";

    (manager as never as { sessions: Map<string, SessionInfo> }).sessions.set(
      sid,
      makeSession(sid),
    );
    (
      manager as never as {
        pending: Map<
          string,
          {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            httpRes: unknown;
            cleanup: () => void;
          }
        >;
      }
    ).pending.set(sid, {
      resolve: () => {},
      reject: () => {},
      httpRes: makePendingHttpRes(blockingResponses),
      cleanup: () => {},
    });

    (hub as never as { onClientMessage: (ws: unknown, raw: unknown) => void }).onClientMessage(
      makeFakeWs(sent),
      JSON.stringify({
        type: "reply",
        chatSessionId: sid,
        feedback: "已收到，开始处理",
        displayFeedback: "已收到，开始处理",
        clientRequestId: "req-accepted",
      }),
    );

    assert.deepEqual(sent, [
      {
        type: "reply_result",
        chatSessionId: sid,
        clientRequestId: "req-accepted",
        accepted: true,
      },
    ]);
    assert.equal(blockingResponses.length, 1);

    assert.equal(
      (manager as never as { sessions: Map<string, SessionInfo> }).sessions.get(sid)
        ?.requestStatus,
      "replied",
    );
    assert.equal(
      broadcasts.some(
        (msg) =>
          msg.type === "session_update" &&
          msg.chatSessionId === sid &&
          msg.status === "replied",
      ),
      true,
    );

  });
});

test("WsHub sends rejected reply_result when the request is no longer pending", async () => {
  await withIsolatedHome(async () => {
    const broadcasts: WsServerMessage[] = [];
    const manager = new SessionManager(DEFAULT_CONFIG, (msg) => broadcasts.push(msg));
    const httpServer = createServer();
    const hub = new WsHub(manager, httpServer, "token");
    const sent: unknown[] = [];
    const sid = "reply-rejected-session";

    (manager as never as { sessions: Map<string, SessionInfo> }).sessions.set(
      sid,
      makeSession(sid, { hasPending: false, requestStatus: "cancelled" }),
    );

    (hub as never as { onClientMessage: (ws: unknown, raw: unknown) => void }).onClientMessage(
      makeFakeWs(sent),
      JSON.stringify({
        type: "reply",
        chatSessionId: sid,
        feedback: "这条反馈其实已经发不进去了",
        displayFeedback: "这条反馈其实已经发不进去了",
        clientRequestId: "req-rejected",
      }),
    );

    assert.deepEqual(sent, [
      {
        type: "reply_result",
        chatSessionId: sid,
        clientRequestId: "req-rejected",
        accepted: false,
        code: "not_pending",
      },
    ]);
    assert.equal(
      (manager as never as { sessions: Map<string, SessionInfo> }).sessions.get(sid)
        ?.requestStatus,
      "cancelled",
    );
    assert.equal(broadcasts.length, 0);

  });
});

test("WsHub rejects reply when session claims pending but no blocking request exists", async () => {
  await withIsolatedHome(async () => {
    const broadcasts: WsServerMessage[] = [];
    const manager = new SessionManager(DEFAULT_CONFIG, (msg) => broadcasts.push(msg));
    const httpServer = createServer();
    const hub = new WsHub(manager, httpServer, "token");
    const sent: unknown[] = [];
    const sid = "reply-missing-pending-http";

    (manager as never as { sessions: Map<string, SessionInfo> }).sessions.set(
      sid,
      makeSession(sid, { hasPending: true, requestStatus: "pending" }),
    );

    (hub as never as { onClientMessage: (ws: unknown, raw: unknown) => void }).onClientMessage(
      makeFakeWs(sent),
      JSON.stringify({
        type: "reply",
        chatSessionId: sid,
        feedback: "这条回复不应该被接受",
        displayFeedback: "这条回复不应该被接受",
        clientRequestId: "req-missing-pending",
      }),
    );

    assert.deepEqual(sent, [
      {
        type: "reply_result",
        chatSessionId: sid,
        clientRequestId: "req-missing-pending",
        accepted: false,
        code: "not_pending",
      },
    ]);
    assert.equal(
      (manager as never as { sessions: Map<string, SessionInfo> }).sessions.get(sid)
        ?.requestStatus,
      "pending",
    );
    assert.equal(
      (manager as never as { sessions: Map<string, SessionInfo> }).sessions.get(sid)
        ?.history.length,
      0,
    );
    assert.equal(broadcasts.length, 0);
  });
});
