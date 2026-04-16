import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { SessionInfo, WsServerMessage, WsSync } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";

function makeSession(
  chatSessionId: string,
  lastActiveAt: number,
): SessionInfo {
  return {
    chatSessionId,
    title: chatSessionId,
    history: [],
    hasPending: false,
    createdAt: lastActiveAt - 1000,
    lastActiveAt,
    requestStatus: "replied",
  };
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-session-pin-sync-"));

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

function waitForWsMessage(ws: WebSocket): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      cleanup();
      const text = typeof raw === "string" ? raw : raw?.toString?.() ?? "";
      resolve(JSON.parse(text) as WsServerMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WS_CLOSED"));
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

test("session pin order broadcasts to clients and survives restart", async () => {
  await withIsolatedHome(async () => {
    const running = await startTestServer();
    try {
      const address = running.httpServer.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;
      const sessions = (running.sessionManager as never as {
        sessions: Map<string, SessionInfo>;
        persistSession: (chatSessionId: string) => Promise<void>;
      }).sessions;
      sessions.set("session-a", makeSession("session-a", 100));
      sessions.set("session-b", makeSession("session-b", 200));
      await (running.sessionManager as never as {
        persistSession: (chatSessionId: string) => Promise<void>;
      }).persistSession("session-a");
      await (running.sessionManager as never as {
        persistSession: (chatSessionId: string) => Promise<void>;
      }).persistSession("session-b");

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      const initialSync = await waitForWsMessage(ws) as WsSync;
      assert.equal(initialSync.type, "sync");
      assert.deepEqual(initialSync.pinnedSessionIds ?? [], []);

      const updatePromise = waitForWsMessage(ws);
      const resp = await fetch(`http://127.0.0.1:${port}/api/pinned-sessions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          pinnedSessionIds: ["session-b", "session-a", "session-b", "session-missing", " "],
        }),
      });
      assert.equal(resp.status, 200);
      assert.deepEqual(await resp.json(), {
        success: true,
        pinnedSessionIds: ["session-b", "session-a"],
      });
      assert.deepEqual(running.sessionManager.listPinnedSessionIdsForSync(), [
        "session-b",
        "session-a",
      ]);
      assert.deepEqual(await updatePromise, {
        type: "pinned_session_order_update",
        pinnedSessionIds: ["session-b", "session-a"],
      });

      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));
    } finally {
      await running.close();
    }

    const restarted = await startTestServer();
    try {
      assert.deepEqual(restarted.sessionManager.listPinnedSessionIdsForSync(), [
        "session-b",
        "session-a",
      ]);

      const address = restarted.httpServer.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      const syncAfterRestart = await waitForWsMessage(ws) as WsSync;
      assert.equal(syncAfterRestart.type, "sync");
      assert.deepEqual(
        syncAfterRestart.sessions
          .map((session) => session.chatSessionId)
          .sort(),
        ["session-a", "session-b"],
      );
      assert.deepEqual(syncAfterRestart.pinnedSessionIds ?? [], [
        "session-b",
        "session-a",
      ]);
      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));
    } finally {
      await restarted.close();
    }
  });
});

test("idle purge broadcasts session removal and pin order cleanup", async () => {
  await withIsolatedHome(async () => {
    const { SessionManager } = await import("./src/sessionManager");
    const broadcasts: WsServerMessage[] = [];
    const manager = new SessionManager(
      { ...DEFAULT_CONFIG, sessionTimeout: 10 },
      (msg) => broadcasts.push(msg),
    );
    const sessions = (manager as never as { sessions: Map<string, SessionInfo> }).sessions;
    const staleTs = Date.now() - 1000;
    sessions.set("session-a", makeSession("session-a", staleTs));
    sessions.set("session-b", makeSession("session-b", staleTs));
    (manager as never as { pinnedSessionIds: string[] }).pinnedSessionIds = [
      "session-b",
      "session-a",
    ];

    (manager as never as { purgeIdleSessions: () => void }).purgeIdleSessions();

    assert.equal(sessions.size, 0);
    assert.deepEqual(manager.listPinnedSessionIdsForSync(), []);
    assert.deepEqual(broadcasts, [
      { type: "session_deleted", chatSessionId: "session-a" },
      { type: "session_deleted", chatSessionId: "session-b" },
      { type: "pinned_session_order_update", pinnedSessionIds: [] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

test("setSessionPinned prepends new pins and removes unpinned sessions without replacing the whole list", async () => {
  await withIsolatedHome(async () => {
    const { SessionManager } = await import("./src/sessionManager");
    const broadcasts: WsServerMessage[] = [];
    const manager = new SessionManager(DEFAULT_CONFIG, (msg) => broadcasts.push(msg));
    const sessions = (manager as never as { sessions: Map<string, SessionInfo> }).sessions;
    sessions.set("session-a", makeSession("session-a", 100));
    sessions.set("session-b", makeSession("session-b", 200));
    sessions.set("session-c", makeSession("session-c", 300));

    assert.equal(manager.setSessionPinned("session-b", true), true);
    assert.equal(manager.setSessionPinned("session-a", true), true);
    assert.equal(manager.setSessionPinned("session-b", false), true);
    assert.deepEqual(manager.listPinnedSessionIdsForSync(), ["session-a"]);
    assert.deepEqual(
      broadcasts.map((msg) =>
        msg.type === "pinned_session_order_update" ? msg.pinnedSessionIds : []
      ),
      [["session-b"], ["session-a", "session-b"], ["session-a"]],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
