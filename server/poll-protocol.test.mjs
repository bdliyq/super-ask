import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "super-ask.js");
const CODEX_CLI = join(HERE, "..", "cli", "super-ask-codex.js");

function runCli(args, env = {}, cliPath = CLI) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
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

function runCliWithStdin(args, stdinText, env = {}, cliPath = CLI) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd: join(HERE, ".."),
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(stdinText);
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

test("CLI codex stop hook mode reuses Codex session_id and turns feedback into a stop block", async () => {
  await withCliHome(async (home) => {
    let askBody = null;
    let ackCount = 0;

    await withStubServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/super-ask") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += String(chunk);
        });
        req.on("end", () => {
          askBody = JSON.parse(raw);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({
            chatSessionId: "codex-session-123",
            feedback: "请继续修复并补测试",
          }));
        });
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
      const transcriptDir = await mkdtemp(join(tmpdir(), "super-ask-codex-transcript-"));
      const transcriptPath = join(transcriptDir, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "collab_agent_spawn_end",
              new_thread_id: "thread-1",
              new_agent_nickname: "Ada",
              new_agent_role: "explorer",
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 A\n- 待处理 B" }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const result = await runCliWithStdin(
        ["--codex-hook", "--port", String(port)],
        JSON.stringify({
          session_id: "codex-session-123",
          turn_id: "codex-turn-456",
          cwd: "/tmp/workspace",
          hook_event_name: "Stop",
          transcript_path: transcriptPath,
          last_assistant_message: "## 工作汇报\n- 已完成 A\n- 待处理 B",
        }),
        { HOME: home },
        CODEX_CLI,
      );

      assert.equal(result.code, 0);
      assert.equal(ackCount, 1);
      assert.equal(askBody.chatSessionId, "codex-session-123");
      assert.equal(askBody.requestId, "codex-turn-456");
      assert.equal(askBody.source, "codex");
      assert.equal(askBody.workspaceRoot, "/tmp/workspace");
      assert.match(askBody.summary, /^## 工作汇报\n- 已完成 A\n- 待处理 B/);
      assert.match(askBody.summary, /## Subagent 活动/);
      assert.match(askBody.summary, /Ada/);
      assert.match(askBody.question, /反馈|回复|下一步/);

      const hookOutput = JSON.parse(result.stdout);
      assert.deepEqual(hookOutput, {
        decision: "block",
        reason: "请继续修复并补测试",
      });
      assert.equal(result.stderr, "");
    });
  });
});

test("CLI codex hook ignores non-Stop events without calling the server", async () => {
  await withCliHome(async (home) => {
    let requestCount = 0;

    await withStubServer(async (_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected");
    }, async (port) => {
      const result = await runCliWithStdin(
        ["--codex-hook", "--port", String(port)],
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "codex-session-123",
          cwd: "/tmp/workspace",
        }),
        { HOME: home },
        CODEX_CLI,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(requestCount, 0);

      const logPath = join(home, ".super-ask", "logs", `${currentDateStamp()}.log`);
      const logContent = await readFile(logPath, "utf-8");
      assert.match(logContent, /"event":"codex_hook\.received"/);
      assert.match(logContent, /"event":"codex_hook\.ignored"/);
    });
  });
});

test("CLI codex stop hook skips subagent sessions and does not call the server", async () => {
  await withCliHome(async (home) => {
    let requestCount = 0;

    await withStubServer(async (_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected");
    }, async (port) => {
      const transcriptDir = await mkdtemp(join(tmpdir(), "super-ask-codex-subagent-"));
      const transcriptPath = join(transcriptDir, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-04-21T01:11:37.064Z",
            type: "session_meta",
            payload: {
              id: "subagent-session",
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: "parent-thread",
                    depth: 1,
                    agent_nickname: "James",
                    agent_role: "worker",
                  },
                },
              },
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "命令：`pwd`\n\n原始输出：\n```text\n/Users/leoli/workspace/super-ask\n```" }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const result = await runCliWithStdin(
        ["--codex-hook", "--port", String(port)],
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "subagent-session",
          turn_id: "subagent-turn",
          cwd: "/Users/leoli/workspace/super-ask",
          transcript_path: transcriptPath,
          last_assistant_message: "命令：`pwd`\n\n原始输出：\n```text\n/Users/leoli/workspace/super-ask\n```",
        }),
        { HOME: home },
        CODEX_CLI,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(requestCount, 0);

      const logPath = join(home, ".super-ask", "logs", `${currentDateStamp()}.log`);
      const logContent = await readFile(logPath, "utf-8");
      assert.match(logContent, /"event":"codex_hook\.received"/);
      assert.match(logContent, /"event":"codex_hook\.skip"/);
      assert.match(logContent, /"reason":"subagent_session"/);
    });
  });
});
