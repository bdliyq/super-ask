import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../shared/types";
import type { SessionInfo } from "../shared/types";

async function withIsolatedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-capacity-test-"));

  try {
    process.env.HOME = home;
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}

async function seedSession(home: string, session: SessionInfo): Promise<void> {
  const sessionsDir = join(home, ".super-ask", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `${session.chatSessionId}.json`),
    JSON.stringify(session, null, 2),
    "utf-8",
  );
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await read();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("POST /super-ask evicts the oldest inactive session when history has filled maxSessions", async () => {
  await withIsolatedHome(async (home) => {
    const now = Date.now();
    await seedSession(home, {
      chatSessionId: "oldest-session",
      title: "oldest",
      history: [],
      hasPending: false,
      createdAt: now - 2_000,
      lastActiveAt: now - 2_000,
      requestStatus: "cancelled",
    });
    await seedSession(home, {
      chatSessionId: "newer-session",
      title: "newer",
      history: [],
      hasPending: false,
      createdAt: now - 1_000,
      lastActiveAt: now - 1_000,
      requestStatus: "cancelled",
    });

    const { startSuperAsk } = await import("./src/server");
    const running = await startSuperAsk(
      { ...DEFAULT_CONFIG, host: "127.0.0.1", port: 0, maxSessions: 2 },
      "test-token",
    );

    try {
      const address = running.httpServer.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const requestPromise = fetch(`http://127.0.0.1:${port}/super-ask`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          summary: "summary",
          question: "question",
        }),
      });

      const sessions = await waitFor(
        () => running.sessionManager.listSessionsForSync(),
        (value) =>
          value.length === 2
          && value.some((item) => item.chatSessionId === "newer-session")
          && value.some((item) => item.hasPending),
      );
      const createdSession = sessions.find((item) => item.hasPending);

      assert.equal(
        sessions.some((item) => item.chatSessionId === "oldest-session"),
        false,
      );
      assert.equal(
        sessions.some((item) => item.chatSessionId === "newer-session"),
        true,
      );

      await waitFor(
        () => fileExists(join(home, ".super-ask", "sessions", "oldest-session.json")),
        (exists) => exists === false,
      );

      assert.ok(createdSession);
      assert.equal(
        running.sessionManager.handleReply(createdSession.chatSessionId, "looks good"),
        true,
      );
      const response = await requestPromise;
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.deepEqual(payload, {
        chatSessionId: createdSession.chatSessionId,
        feedback: "looks good",
      });
    } finally {
      await running.close();
    }
  });
});
