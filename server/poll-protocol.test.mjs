import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "super-ask.py");

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [CLI, ...args], {
      cwd: join(HERE, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function withCliHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "super-ask-cli-test-"));
  try {
    const superAskDir = join(home, ".super-ask");
    await mkdir(superAskDir, { recursive: true });
    await writeFile(join(superAskDir, "token"), "test-token", "utf-8");
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withStubServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    return await fn(address.port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function currentDateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test("CLI rejects removed --poll flag", async () => {
  const result = await runCli(["--poll", "--session-id", "sid"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unrecognized arguments: --poll/);
  assert.equal(result.stdout.trim(), "");
});

test("CLI rejects removed --no-wait flag", async () => {
  const result = await runCli([
    "--no-wait",
    "--summary",
    "summary",
    "--question",
    "question",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unrecognized arguments: --no-wait/);
  assert.equal(result.stdout.trim(), "");
});

test("CLI retries shutdown 503 responses and eventually succeeds", async () => {
  await withCliHome(async (home) => {
    let askCount = 0;
    let ackCount = 0;

    await withStubServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/super-ask") {
        askCount += 1;
        if (askCount === 1) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({
            error: "服务器正在关闭",
            code: "SERVER_SHUTTING_DOWN",
          }));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          chatSessionId: "sid-123",
          feedback: "ok",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/ack") {
        ackCount += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end("{}");
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    }, async (port) => {
      const result = await runCli([
        "--summary",
        "summary",
        "--question",
        "question",
        "--port",
        String(port),
        "--retries",
        "1",
      ], { HOME: home });

      assert.equal(result.code, 0);
      assert.equal(askCount, 2);
      assert.equal(ackCount, 1);
      assert.match(result.stdout, /"chatSessionId": "sid-123"/);
      assert.match(result.stdout, /"feedback": "ok"/);
      assert.equal(result.stderr, "", "重试消息不应输出到 stderr");

      const logPath = join(home, ".super-ask", "logs", `${currentDateStamp()}.log`);
      const logContent = await readFile(logPath, "utf-8");
      assert.match(logContent, /"event":"retry\.wait"/, "重试事件应记录到日志文件");
    });
  });
});

test("CLI writes daily log file with full request response retry and ack data", async () => {
  await withCliHome(async (home) => {
    let askCount = 0;
    let ackCount = 0;

    await withStubServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/super-ask") {
        askCount += 1;
        if (askCount === 1) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({
            error: "服务器正在关闭",
            code: "SERVER_SHUTTING_DOWN",
          }));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          chatSessionId: "sid-log",
          feedback: "ok",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/ack") {
        ackCount += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end("{}");
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    }, async (port) => {
      const result = await runCli([
        "--summary",
        "summary",
        "--question",
        "question",
        "--port",
        String(port),
        "--retries",
        "1",
        "--source",
        "cursor",
        "--workspace-root",
        "/tmp/workspace",
      ], { HOME: home });

      assert.equal(result.code, 0);
      assert.equal(askCount, 2);
      assert.equal(ackCount, 1);

      const logPath = join(home, ".super-ask", "logs", `${currentDateStamp()}.log`);
      const logContent = await readFile(logPath, "utf-8");

      assert.match(logContent, /"source":"cli"/);
      assert.match(logContent, /"event":"request\.attempt"/);
      assert.match(logContent, /"Authorization":"Bearer test-token"/);
      assert.match(logContent, /"summary":"summary"/);
      assert.match(logContent, /"question":"question"/);
      assert.match(logContent, /"event":"response\.http_error"/);
      assert.match(logContent, /"SERVER_SHUTTING_DOWN"/);
      assert.match(logContent, /"event":"retry\.wait"/);
      assert.match(logContent, /"event":"response\.success"/);
      assert.match(logContent, /"chatSessionId":"sid-log"/);
      assert.match(logContent, /"feedback":"ok"/);
      assert.match(logContent, /"event":"ack\.success"/);

      const errorLine = logContent.split("\n").find(l => l.includes('"response.http_error"'));
      assert.ok(errorLine, "应包含 response.http_error 日志行");
      const errorObj = JSON.parse(errorLine);
      assert.equal(errorObj.method, "POST", "错误日志应包含 method 字段");
      assert.ok(errorObj.headers, "错误日志应包含 headers 字段");
      assert.ok(errorObj.payload, "错误日志应包含 payload 字段");
      assert.ok(typeof errorObj.timeout === "number", "错误日志应包含 timeout 字段");
      assert.ok(errorObj.rawResponse, "错误日志应包含 rawResponse 字段");
    });
  });
});

test("CLI logs ack.error with status and response body when ack returns non-ok http status", async () => {
  await withCliHome(async (home) => {
    await withStubServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/super-ask") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          chatSessionId: "sid-ack-error",
          feedback: "ok",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/ack") {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("ack failed");
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    }, async (port) => {
      const result = await runCli([
        "--summary",
        "summary",
        "--question",
        "question",
        "--port",
        String(port),
      ], { HOME: home });

      assert.equal(result.code, 0);

      const logPath = join(home, ".super-ask", "logs", `${currentDateStamp()}.log`);
      const logContent = await readFile(logPath, "utf-8");

      assert.match(logContent, /"event":"ack\.error"/);
      assert.doesNotMatch(logContent, /"event":"ack\.success"/);
      assert.match(logContent, /"status":503/);
      assert.match(logContent, /"rawResponse":"ack failed"/);
    });
  });
});
