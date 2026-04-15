import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../shared/types";

async function withIsolatedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-server-test-"));

  try {
    process.env.HOME = home;
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  return withIsolatedHome(async () => {
    const { startSuperAsk } = await import("./src/server");
    const running = await startSuperAsk(
      { ...DEFAULT_CONFIG, host: "127.0.0.1", port: 0 },
      "test-token",
    );

    try {
      const address = running.httpServer.address();
      assert.ok(address && typeof address === "object");
      return await fn((address as AddressInfo).port);
    } finally {
      await running.close();
    }
  });
}

test("POST /super-ask rejects removed noWait mode", async () => {
  await withServer(async (port) => {
    const resp = await fetch(`http://127.0.0.1:${port}/super-ask`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        summary: "summary",
        question: "question",
        noWait: true,
      }),
    });

    assert.equal(resp.status, 400);
    assert.deepEqual(await resp.json(), {
      error: "轮询模式已移除，请使用阻塞模式",
      code: "INVALID_REQUEST",
    });
  });
});

test("GET /api/poll is unavailable after poll mode removal", async () => {
  await withServer(async (port) => {
    const resp = await fetch(
      `http://127.0.0.1:${port}/api/poll?chatSessionId=00000000-0000-0000-0000-000000000000`,
      {
        headers: {
          Authorization: "Bearer test-token",
        },
      },
    );

    assert.equal(resp.status, 404);
    assert.match(await resp.text(), /Not Found/);
  });
});

test("POST /api/deploy accepts opencode platform for user scope", async () => {
  await withServer(async (port) => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/deploy`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        platforms: ["opencode"],
        workspacePath: "",
        scope: "user",
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.success, true);
    assert.equal(Array.isArray(body.steps), true);
    assert.ok(body.steps.length > 0);
  });
});
