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
  const home = await mkdtemp(join(tmpdir(), "super-ask-read-file-"));
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

function getReadFile(
  port: number,
  params: Record<string, string>,
  token = "test-token",
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/read-file?${qs}`,
        method: "GET",
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
    req.end();
  });
}

test("GET /api/read-file", async (t) => {
  await withIsolatedHome(async (home) => {
    const running = await startTestServer();
    const port = (running.httpServer.address() as AddressInfo).port;

    try {
      await t.test("returns 400 when path is missing", async () => {
        const { status, data } = await getReadFile(port, {});
        assert.equal(status, 400);
        assert.ok(data.error);
      });

      await t.test("returns 401 without auth", async () => {
        const { status } = await getReadFile(port, { path: "/tmp" }, "");
        assert.equal(status, 401);
      });

      await t.test("returns 404 for non-existent file", async () => {
        const { status } = await getReadFile(port, { path: "/nonexistent/file.txt" });
        assert.equal(status, 404);
      });

      await t.test("returns 400 for directory", async () => {
        const testDir = join(home, "test-dir");
        await mkdir(testDir, { recursive: true });
        const { status, data } = await getReadFile(port, { path: testDir });
        assert.equal(status, 400);
        assert.ok(String(data.error).includes("目录"));
      });

      await t.test("returns file content with correct lang", async () => {
        const testFile = join(home, "test.ts");
        await writeFile(testFile, 'const x: number = 42;\nexport default x;\n');
        const { status, data } = await getReadFile(port, { path: testFile });
        assert.equal(status, 200);
        assert.equal(data.isBinary, false);
        assert.equal(data.lang, "typescript");
        assert.equal(data.truncated, false);
        assert.equal(typeof data.content, "string");
        assert.ok((data.content as string).includes("const x"));
        assert.equal(data.resolvedPath, testFile);
      });

      await t.test("detects markdown file", async () => {
        const testFile = join(home, "readme.md");
        await writeFile(testFile, "# Hello\n\nWorld\n");
        const { status, data } = await getReadFile(port, { path: testFile });
        assert.equal(status, 200);
        assert.equal(data.lang, "markdown");
      });

      await t.test("detects binary file", async () => {
        const testFile = join(home, "binary.dat");
        const buf = Buffer.alloc(100);
        buf[50] = 0;
        buf.write("header", 0);
        await writeFile(testFile, buf);
        const { status, data } = await getReadFile(port, { path: testFile });
        assert.equal(status, 200);
        assert.equal(data.isBinary, true);
        assert.equal(data.content, null);
      });

      await t.test("resolves relative path with workspaceRoot", async () => {
        const wsRoot = join(home, "ws");
        await mkdir(join(wsRoot, "src"), { recursive: true });
        const testFile = join(wsRoot, "src", "app.tsx");
        await writeFile(testFile, "export function App() { return <div />; }");
        const { status, data } = await getReadFile(port, {
          path: "./src/app.tsx",
          workspaceRoot: wsRoot,
        });
        assert.equal(status, 200);
        assert.equal(data.lang, "tsx");
        assert.equal(data.resolvedPath, testFile);
      });

      await t.test("returns null lang for unknown extension", async () => {
        const testFile = join(home, "data.xyz");
        await writeFile(testFile, "some data");
        const { status, data } = await getReadFile(port, { path: testFile });
        assert.equal(status, 200);
        assert.equal(data.lang, null);
        assert.equal(data.isBinary, false);
      });

      await t.test("returns 400 for relative path without workspaceRoot", async () => {
        const { status, data } = await getReadFile(port, { path: "./src/file.ts" });
        assert.equal(status, 400);
        assert.ok(String(data.error).includes("workspaceRoot"));
      });
    } finally {
      await running.close();
    }
  });
});
