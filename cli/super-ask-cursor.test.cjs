const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  extractCursorQuestion,
  extractLastAssistantTextFromTranscriptContent,
  buildCursorStopHookPayload,
  pickWorkspaceRoot,
} = require("./super-ask-cursor.js");

const CLI = path.join(__dirname, "super-ask-cursor.js");

function runCliWithStdin(args, stdinText, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], {
      cwd: __dirname,
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
  const home = await mkdtemp(path.join(os.tmpdir(), "super-ask-cursor-cli-test-"));
  try {
    const superAskDir = path.join(home, ".super-ask");
    await writeFile(path.join(home, ".super-ask-token-placeholder"), "", "utf-8").catch(() => {});
    await writeFile(path.join(superAskDir, "token"), "test-token", "utf-8").catch(async () => {
      await require("node:fs/promises").mkdir(superAskDir, { recursive: true });
      await writeFile(path.join(superAskDir, "token"), "test-token", "utf-8");
    });
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
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("extractLastAssistantTextFromTranscriptContent returns the last assistant text block", () => {
  const transcript = [
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "第一轮汇报" },
          { type: "tool_use", name: "Shell", input: { command: "pwd" } },
        ],
      },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "第二轮汇报" },
          { type: "text", text: "请确认是否继续？" },
        ],
      },
    }),
  ].join("\n");

  assert.equal(
    extractLastAssistantTextFromTranscriptContent(transcript),
    "第二轮汇报\n\n请确认是否继续？",
  );
});

test("extractCursorQuestion reuses the last question line when present", () => {
  const summary = "已完成修改。\n请确认是否继续？";
  assert.equal(extractCursorQuestion(summary), "请确认是否继续？");
});

test("pickWorkspaceRoot prefers workspace_roots over cwd", () => {
  assert.equal(
    pickWorkspaceRoot({
      workspace_roots: ["/tmp/workspace", "/tmp/ignored"],
      cwd: "/tmp/cwd",
    }),
    "/tmp/workspace",
  );
});

test("buildCursorStopHookPayload reads transcript text and uses stable cursor ids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-ask-cursor-hook-"));

  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "请修复 bug" }],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "已修复 bug" },
              { type: "text", text: "请确认是否继续？" },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const payload = await buildCursorStopHookPayload({
      transcript_path: transcriptPath,
      session_id: "cursor-session-1",
      generation_id: "generation-42",
      workspace_roots: ["/Users/leoli/workspace/super-ask"],
    });

    assert.deepEqual(payload, {
      summary: "已修复 bug\n\n请确认是否继续？",
      question: "请确认是否继续？",
      source: "cursor",
      options: ["继续", "需要修改", "我有问题"],
      requestId: "cursor-stop:cursor-session-1:generation-42",
      chatSessionId: "cursor-session-1",
      workspaceRoot: "/Users/leoli/workspace/super-ask",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildCursorStopHookPayload returns null when no assistant summary is available", async () => {
  const payload = await buildCursorStopHookPayload({
    transcript_path: "",
    session_id: "cursor-session-1",
  });

  assert.equal(payload, null);
});

test("cursor hook exits cleanly with no followup when a 200 response body reports INVALID_REQUEST (superseded)", async () => {
  await withCliHome(async (home) => {
    let askCount = 0;
    let ackCount = 0;

    await withStubServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/super-ask") {
        askCount += 1;
        // 模拟服务端 supersede：长连接头已在建立时写成 200，body 里带 INVALID_REQUEST
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "同一会话发起了新的提问，当前请求已失效",
            code: "INVALID_REQUEST",
          }),
        );
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
      const result = await runCliWithStdin(
        ["--cursor-hook", "--port", String(port)],
        JSON.stringify({
          session_id: "cursor-session-1",
          generation_id: "generation-42",
          workspace_roots: ["/Users/leoli/workspace/super-ask"],
          hook_event_name: "stop",
          last_assistant_message: "## 工作汇报\n- 已完成 A\n- 待处理 B",
        }),
        { HOME: home },
      );

      // 关键断言：
      // - exit code 必须为 0（避免 Cursor failClosed hook 阻塞下一个任务）
      // - stdout 必须是空对象 {}（不触发 followup_message）
      // - 只发送一次 ask（不重试），不会触发 ack（因为没有 chatSessionId/feedback）
      // - stderr 不出现 "响应缺少 chatSessionId 或 feedback" 的 fatal 提示
      assert.equal(result.code, 0);
      assert.equal(askCount, 1);
      assert.equal(ackCount, 0);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {});
      assert.equal(result.stderr.includes("错误: 响应缺少 chatSessionId 或 feedback"), false);
    });
  });
});

test("cursor hook retries when a 200 response body reports SERVER_SHUTTING_DOWN", async () => {
  await withCliHome(async (home) => {
    let askCount = 0;
    let ackCount = 0;

    await withStubServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/super-ask") {
        askCount += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (askCount === 1) {
          res.end(JSON.stringify({ error: "服务器正在关闭", code: "SERVER_SHUTTING_DOWN" }));
        } else {
          res.end(JSON.stringify({ chatSessionId: "cursor-session-1", feedback: "继续" }));
        }
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
      const result = await runCliWithStdin(
        ["--cursor-hook", "--port", String(port)],
        JSON.stringify({
          session_id: "cursor-session-1",
          generation_id: "generation-42",
          workspace_roots: ["/Users/leoli/workspace/super-ask"],
          hook_event_name: "stop",
          last_assistant_message: "## 工作汇报\n- 已完成 A\n- 待处理 B",
        }),
        { HOME: home },
      );

      assert.equal(result.code, 0);
      assert.equal(askCount, 2);
      assert.equal(ackCount, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        followup_message: "继续",
      });
      assert.equal(result.stderr.includes("错误: 响应缺少 chatSessionId 或 feedback"), false);
    });
  });
});
