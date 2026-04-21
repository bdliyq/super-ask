const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");
const { mkdtemp, rm, writeFile, mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const hook = require("./super-ask-vscode-hook.js");

const CLI = path.join(__dirname, "super-ask-vscode-hook.js");

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
  const home = await mkdtemp(path.join(os.tmpdir(), "super-ask-vscode-hook-test-"));
  try {
    const superAskDir = path.join(home, ".super-ask");
    await mkdir(superAskDir, { recursive: true });
    await writeFile(path.join(superAskDir, "token"), "test-token", "utf-8");
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withStubServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    return await fn(address.port);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("exports VS Code hook helpers", () => {
  assert.equal(typeof hook.extractVscodeQuestion, "function");
  assert.equal(typeof hook.extractLastAssistantTextFromTranscriptContent, "function");
  assert.equal(typeof hook.extractLastAssistantTextFromTranscriptPath, "function");
  assert.equal(typeof hook.isSubagentTranscriptContent, "function");
  assert.equal(typeof hook.isSubagentTranscriptPath, "function");
  assert.equal(typeof hook.buildVscodeHookRequestPayload, "function");
  assert.equal(typeof hook.buildStopHookOutput, "function");
});

test("extractLastAssistantTextFromTranscriptContent returns the last assistant text block", () => {
  const transcript = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第一轮汇报" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第二轮汇报\n请确认是否继续？" }],
      },
    }),
  ].join("\n");

  assert.equal(
    hook.extractLastAssistantTextFromTranscriptContent(transcript),
    "第二轮汇报\n请确认是否继续？",
  );
});

test("isSubagentTranscriptContent returns true when session_meta marks a spawned subagent", () => {
  const transcript = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              depth: 1,
              agent_nickname: "Ada",
              agent_role: "worker",
            },
          },
        },
      },
    }),
  ].join("\n");

  assert.equal(hook.isSubagentTranscriptContent(transcript), true);
});

test("extractVscodeQuestion reuses the last question line when present", () => {
  const summary = "## 工作汇报\n- 已完成 A\n请确认是否继续？";
  assert.equal(hook.extractVscodeQuestion(summary), "请确认是否继续？");
});

test("buildVscodeHookRequestPayload maps sessionId and cwd to the super-ask request", () => {
  const payload = hook.buildVscodeHookRequestPayload({
    sessionId: "vscode-session-1",
    invocationId: "invoke-123",
    cwd: "/tmp/workspace",
  }, "## 工作汇报\n- 已完成 A");

  assert.deepEqual(payload, {
    summary: "## 工作汇报\n- 已完成 A",
    question: "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。",
    source: "copilot in vscode",
    options: ["继续", "需要修改", "我有问题"],
    chatSessionId: "vscode-session-1",
    workspaceRoot: "/tmp/workspace",
    requestId: "invoke-123",
  });
});

test("Stop hook calls the existing super-ask server and returns a blocking VS Code hook output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-ask-vscode-hook-"));

  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 A\n请确认是否继续？" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    let askBody = null;
    let ackCount = 0;

    await withCliHome(async (home) => {
      await withStubServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;

        if (req.url === "/super-ask") {
          askBody = JSON.parse(raw);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ chatSessionId: "vscode-session-1", feedback: "继续执行下一步" }));
          return;
        }

        if (req.url === "/api/ack") {
          ackCount += 1;
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end("{}");
          return;
        }

        res.statusCode = 404;
        res.end("not found");
      }, async (port) => {
        const result = await runCliWithStdin(
          ["--port", String(port)],
          JSON.stringify({
            hookEventName: "Stop",
            sessionId: "vscode-session-1",
            invocationId: "invoke-123",
            cwd: "/tmp/workspace",
            transcript_path: transcriptPath,
            stop_hook_active: false,
          }),
          { HOME: home },
        );

        if (result.code !== 0) {
          assert.fail(`unexpected exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.equal(askBody.summary, "## 工作汇报\n- 已完成 A\n请确认是否继续？");
        assert.equal(askBody.question, "请确认是否继续？");
        assert.equal(askBody.source, "copilot in vscode");
        assert.deepEqual(askBody.options, ["继续", "需要修改", "我有问题"]);
        assert.equal(askBody.chatSessionId, "vscode-session-1");
        assert.equal(askBody.workspaceRoot, "/tmp/workspace");
        assert.equal(askBody.requestId, "invoke-123");

        const hookOutput = JSON.parse(result.stdout);
        assert.deepEqual(hookOutput, {
          hookSpecificOutput: {
            hookEventName: "Stop",
            decision: "block",
            reason: "继续执行下一步",
          },
        });
        assert.equal(ackCount, 1);
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Stop hook exits 0 with empty stdout when a 200 body reports INVALID_REQUEST (superseded)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-ask-vscode-superseded-"));

  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 A\n请确认是否继续？" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    await withCliHome(async (home) => {
      await withStubServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;

        if (req.url === "/super-ask") {
          JSON.parse(raw);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              error: "同一会话发起了新的提问，当前请求已失效",
              code: "INVALID_REQUEST",
            }),
          );
          return;
        }

        res.statusCode = 404;
        res.end("not found");
      }, async (port) => {
        const result = await runCliWithStdin(
          ["--port", String(port)],
          JSON.stringify({
            hookEventName: "Stop",
            sessionId: "vscode-session-1",
            invocationId: "invoke-123",
            cwd: "/tmp/workspace",
            transcript_path: transcriptPath,
            stop_hook_active: false,
          }),
          { HOME: home },
        );

        assert.equal(result.code, 0);
        assert.equal(result.stdout.trim(), "");
        assert.equal(result.stderr.includes("错误: 响应缺少 chatSessionId 或 feedback"), false);
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Stop hook skips subagent sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-ask-vscode-subagent-hook-"));

  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "parent-thread",
                  depth: 1,
                  agent_nickname: "Ada",
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
            content: [{ type: "output_text", text: "命令：`pwd`" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    await withCliHome(async (home) => {
      await withStubServer(async (_req, res) => {
        res.statusCode = 500;
        res.end("unexpected");
      }, async (port) => {
        const result = await runCliWithStdin(
          ["--port", String(port)],
          JSON.stringify({
            hookEventName: "Stop",
            sessionId: "vscode-session-1",
            cwd: "/tmp/workspace",
            transcript_path: transcriptPath,
            stop_hook_active: false,
          }),
          { HOME: home },
        );

        if (result.code !== 0) {
          assert.fail(`unexpected exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("non-Stop hooks are ignored", async () => {
  await withCliHome(async (home) => {
    await withStubServer(async (_req, res) => {
      res.statusCode = 500;
      res.end("unexpected");
      }, async (port) => {
        const result = await runCliWithStdin(
          ["--port", String(port)],
        JSON.stringify({
          hookEventName: "PostToolUse",
          sessionId: "vscode-session-1",
          cwd: "/tmp/workspace",
        }),
        { HOME: home },
        );

        if (result.code !== 0) {
          assert.fail(`unexpected exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
    });
  });
});
