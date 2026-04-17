import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULT_CONFIG } from "../shared/types";

async function withIsolatedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "super-ask-open-path-"));
  try {
    process.env.HOME = home;
    return await fn(home);
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

function postOpenPath(
  port: number,
  body: Record<string, unknown>,
  token = "test-token",
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/open-path",
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode!, data: { raw: text } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("POST /api/open-path", async (t) => {
  await withIsolatedHome(async (home) => {
    const running = await startTestServer();
    const port = (running.httpServer.address() as AddressInfo).port;

    try {
      await t.test("returns 400 when path is missing", async () => {
        const { status, data } = await postOpenPath(port, {});
        assert.equal(status, 400);
        assert.ok(data.error);
      });

      await t.test("returns 400 for empty path", async () => {
        const { status } = await postOpenPath(port, { path: "   " });
        assert.equal(status, 400);
      });

      await t.test("returns 401 without auth token", async () => {
        const { status } = await postOpenPath(port, { path: "/tmp" }, "");
        assert.equal(status, 401);
      });

      await t.test("returns 404 for non-existent path", async () => {
        const { status, data } = await postOpenPath(port, {
          path: "/non/existent/path/abc123xyz",
        });
        assert.equal(status, 404);
        assert.ok(data.error);
      });

      await t.test("returns 400 for relative path without workspaceRoot", async () => {
        const { status, data } = await postOpenPath(port, {
          path: "./some/file.ts",
        });
        assert.equal(status, 400);
        assert.ok(String(data.error).includes("workspaceRoot"));
      });

      await t.test("returns 200 for existing directory", async () => {
        const testDir = join(home, "test-dir");
        await mkdir(testDir, { recursive: true });
        const { status, data } = await postOpenPath(port, { path: testDir });
        assert.equal(status, 200);
        assert.equal(data.success, true);
        assert.equal(data.type, "directory");
        assert.equal(data.resolvedPath, testDir);
      });

      await t.test("returns 200 for existing file", async () => {
        const testFile = join(home, "test-file.txt");
        await writeFile(testFile, "hello");
        const { status, data } = await postOpenPath(port, { path: testFile });
        assert.equal(status, 200);
        assert.equal(data.success, true);
        assert.equal(data.type, "file");
      });

      await t.test("resolves ~ path correctly", async () => {
        const testFile = join(home, "tilde-test.txt");
        await writeFile(testFile, "hello");
        const { status, data } = await postOpenPath(port, {
          path: "~/tilde-test.txt",
        });
        assert.equal(status, 200);
        assert.equal(data.success, true);
        assert.equal(data.resolvedPath, testFile);
      });

      await t.test("resolves relative path with workspaceRoot", async () => {
        const wsRoot = join(home, "workspace");
        await mkdir(join(wsRoot, "src"), { recursive: true });
        const testFile = join(wsRoot, "src", "app.ts");
        await writeFile(testFile, "export {}");
        const { status, data } = await postOpenPath(port, {
          path: "./src/app.ts",
          workspaceRoot: wsRoot,
        });
        assert.equal(status, 200);
        assert.equal(data.success, true);
        assert.equal(data.resolvedPath, testFile);
      });

      await t.test("resolves implicit relative path with workspaceRoot", async () => {
        const wsRoot = join(home, "workspace2");
        await mkdir(join(wsRoot, "cli"), { recursive: true });
        const testFile = join(wsRoot, "cli", "main.py");
        await writeFile(testFile, "print('hi')");
        const { status, data } = await postOpenPath(port, {
          path: "cli/main.py",
          workspaceRoot: wsRoot,
        });
        assert.equal(status, 200);
        assert.equal(data.success, true);
        assert.equal(data.resolvedPath, testFile);
      });
    } finally {
      await running.close();
    }
  });
});
