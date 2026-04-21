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
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    chatSessionId,
    title: chatSessionId,
    history: [],
    hasPending: false,
    createdAt: Date.now() - 1000,
    lastActiveAt: Date.now(),
    requestStatus: "replied",
    ...overrides,
  };
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-session-title-"));

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

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return read();
}

function waitForWsMessage(ws: WebSocket, timeoutMs = 1_000): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("WS_TIMEOUT"));
    }, timeoutMs);
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
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

test("POST /api/session-title broadcasts the new title and persists the manual-title flag", async () => {
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
      sessions.set("session-a", makeSession("session-a"));
      await (running.sessionManager as never as {
        persistSession: (chatSessionId: string) => Promise<void>;
      }).persistSession("session-a");

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      try {
        const initialSync = await waitForWsMessage(ws) as WsSync;
        assert.equal(initialSync.type, "sync");

        const updatePromise = waitForWsMessage(ws);
        const resp = await fetch(`http://127.0.0.1:${port}/api/session-title`, {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            chatSessionId: "session-a",
            title: "Renamed Session",
          }),
        });

        assert.equal(resp.status, 200);
        assert.deepEqual(await resp.json(), {
          success: true,
          title: "Renamed Session",
        });
        assert.deepEqual(await updatePromise, {
          type: "session_title_update",
          chatSessionId: "session-a",
          title: "Renamed Session",
        });

        const updated = await waitFor(
          () => running.sessionManager.getSession("session-a"),
          (value) => Boolean(value) && value.title === "Renamed Session",
        );
        assert.ok(updated);
        assert.equal(updated.title, "Renamed Session");
        assert.equal(
          (updated as SessionInfo & { titleManuallySet?: boolean }).titleManuallySet,
          true,
        );
      } finally {
        await closeWs(ws);
      }
    } finally {
      await running.close();
    }

    const restarted = await startTestServer();
    try {
      const restored = await waitFor(
        () => restarted.sessionManager.getSession("session-a"),
        Boolean,
      );
      assert.ok(restored);
      assert.equal(restored.title, "Renamed Session");
      assert.equal(
        (restored as SessionInfo & { titleManuallySet?: boolean }).titleManuallySet,
        true,
      );
    } finally {
      await restarted.close();
    }
  });
});

test("POST /super-ask keeps the manual title after the user renames the session", async () => {
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

      sessions.set(
        "session-a",
        makeSession("session-a", { title: "Original Agent Title" }),
      );
      await (running.sessionManager as never as {
        persistSession: (chatSessionId: string) => Promise<void>;
      }).persistSession("session-a");

      const renameResp = await fetch(`http://127.0.0.1:${port}/api/session-title`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          chatSessionId: "session-a",
          title: "Manual Session Name",
        }),
      });
      assert.equal(renameResp.status, 200);

      const controller = new AbortController();
      const requestPromise = fetch(`http://127.0.0.1:${port}/super-ask`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          chatSessionId: "session-a",
          title: "Fresh Agent Title",
          summary: "summary",
          question: "question",
        }),
        signal: controller.signal,
      });

      const updated = await waitFor(
        () => running.sessionManager.getSession("session-a"),
        (value) =>
          Boolean(value) &&
          value.title === "Manual Session Name" &&
          value.hasPending === true,
      );
      assert.ok(updated);
      assert.equal(updated.title, "Manual Session Name");
      assert.equal(
        (updated as SessionInfo & { titleManuallySet?: boolean }).titleManuallySet,
        true,
      );

      controller.abort();
      await assert.rejects(requestPromise, /AbortError/);
    } finally {
      await running.close();
    }
  });
});
