import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { PredefinedMessage, WsPredefinedMsgsSync, WsServerMessage, WsSync } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-predefined-msgs-"));
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
  return startSuperAsk({ ...DEFAULT_CONFIG, host: "127.0.0.1", port: 0 }, "test-token");
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

const sampleMsgs: PredefinedMessage[] = [
  { id: "a", text: "line-a", active: true },
  { id: "b", text: "line-b", active: false },
];

test("PUT predefined-msgs persists, broadcasts predefined_msgs_sync to all WS clients, survives server restart", async () => {
  await withIsolatedHome(async () => {
    const running = await startTestServer();
    const home = process.env.HOME!;
    const filePath = join(home, ".super-ask", "predefined-msgs.json");
    try {
      const address = running.httpServer.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      const sync1 = (await waitForWsMessage(ws1)) as WsSync;
      const sync2 = (await waitForWsMessage(ws2)) as WsSync;
      assert.equal(sync1.type, "sync");
      assert.equal(sync2.type, "sync");

      const next1 = waitForWsMessage(ws1);
      const next2 = waitForWsMessage(ws2);

      const resp = await fetch(`http://127.0.0.1:${port}/api/predefined-msgs`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(sampleMsgs),
      });
      assert.equal(resp.status, 200);
      assert.deepEqual(await resp.json(), { success: true });

      const msgA = (await next1) as WsPredefinedMsgsSync;
      const msgB = (await next2) as WsPredefinedMsgsSync;
      assert.deepEqual(msgA, { type: "predefined_msgs_sync", messages: sampleMsgs });
      assert.deepEqual(msgB, { type: "predefined_msgs_sync", messages: sampleMsgs });

      const disk = JSON.parse(await readFile(filePath, "utf-8")) as PredefinedMessage[];
      assert.deepEqual(disk, sampleMsgs);

      ws1.close();
      ws2.close();
      await Promise.all([
        new Promise<void>((r) => ws1.once("close", () => r())),
        new Promise<void>((r) => ws2.once("close", () => r())),
      ]);
    } finally {
      await running.close();
    }

    const restarted = await startTestServer();
    try {
      const diskAfter = JSON.parse(await readFile(filePath, "utf-8")) as PredefinedMessage[];
      assert.deepEqual(diskAfter, sampleMsgs);

      const address = restarted.httpServer.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      const syncAfter = (await waitForWsMessage(ws)) as WsSync;
      assert.equal(syncAfter.type, "sync");
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    } finally {
      await restarted.close();
    }
  });
});

test("PUT predefined-msgs rejects invalid body with 400", async () => {
  await withIsolatedHome(async () => {
    const running = await startTestServer();
    try {
      const address = running.httpServer.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const resp = await fetch(`http://127.0.0.1:${port}/api/predefined-msgs`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify([{ id: 1, text: "x" }]),
      });
      assert.equal(resp.status, 400);
    } finally {
      await running.close();
    }
  });
});
