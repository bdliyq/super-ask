const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const codex = require("./super-ask-codex.js");

test("standalone codex script exports codex helpers", () => {
  assert.equal(typeof codex.extractCodexQuestion, "function");
  assert.equal(typeof codex.extractSubagentActivityFromTranscriptContent, "function");
  assert.equal(typeof codex.isSubagentTranscriptContent, "function");
  assert.equal(typeof codex.isSubagentTranscriptPath, "function");
  assert.equal(typeof codex.mergeSummaryWithSubagentActivity, "function");
  assert.equal(typeof codex.buildCodexStopHookPayload, "function");
});

test("extractCodexQuestion reuses the last question line when present", () => {
  const question = codex.extractCodexQuestion("## 工作汇报\n- 已完成 A\n是否继续？");
  assert.equal(question, "是否继续？");
});

test("buildCodexStopHookPayload preserves session_id turn_id cwd mapping", () => {
  const payload = codex.buildCodexStopHookPayload({
    session_id: "codex-session-123",
    turn_id: "codex-turn-456",
    cwd: "/tmp/workspace",
    last_assistant_message: "## 工作汇报\n- 已完成 A",
  });

  assert.deepEqual(payload, {
    summary: "## 工作汇报\n- 已完成 A",
    question: "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。",
    source: "codex",
    options: ["继续", "需要修改", "我有问题"],
    chatSessionId: "codex-session-123",
    workspaceRoot: "/tmp/workspace",
    requestId: "codex-turn-456",
  });
});

test("extractSubagentActivityFromTranscriptContent recognizes current-turn subagent events", () => {
  const transcript = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "旧问题" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        new_thread_id: "old-thread",
        new_agent_nickname: "Old",
        new_agent_role: "worker",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "旧汇报" }],
      },
    }),
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
      type: "event_msg",
      payload: {
        type: "collab_waiting_end",
        agent_statuses: [
          {
            thread_id: "thread-1",
            agent_nickname: "Ada",
            agent_role: "explorer",
            status: { completed: "done" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_close_end",
        receiver_thread_id: "thread-1",
        receiver_agent_nickname: "Ada",
        receiver_agent_role: "explorer",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<subagent_notification>\n{\"agent_path\":\"thread-1\",\"status\":{\"completed\":\"done\"}}\n</subagent_notification>",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 A" }],
      },
    }),
  ].join("\n");

  const activity = codex.extractSubagentActivityFromTranscriptContent(
    transcript,
    "## 工作汇报\n- 已完成 A",
  );

  assert.deepEqual(activity, {
    spawned: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    completed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    closed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
  });
});

test("isSubagentTranscriptContent returns true when session_meta marks a spawned subagent", () => {
  const transcript = [
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
        content: [{ type: "output_text", text: "命令：`pwd`" }],
      },
    }),
  ].join("\n");

  assert.equal(codex.isSubagentTranscriptContent(transcript), true);
});

test("isSubagentTranscriptContent returns false for a normal main-thread transcript", () => {
  const transcript = [
    JSON.stringify({
      timestamp: "2026-04-21T01:11:37.064Z",
      type: "session_meta",
      payload: {
        id: "main-session",
        source: "user",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "## 工作汇报" }],
      },
    }),
  ].join("\n");

  assert.equal(codex.isSubagentTranscriptContent(transcript), false);
});

test("mergeSummaryWithSubagentActivity appends a compact codex section once", () => {
  const summary = codex.mergeSummaryWithSubagentActivity("## 工作汇报\n- 已完成 A", {
    spawned: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    completed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    closed: [],
  });

  assert.match(summary, /## Subagent 活动/);
  assert.match(summary, /本轮启动 1 个：Ada/);
  assert.match(summary, /已完成 1 个：Ada/);
});

test("codex hook exits 0 with no stdout when a 200 body reports INVALID_REQUEST (superseded)", async () => {
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    let raw = "";
    for await (const chunk of req) raw += chunk;

    if (req.url === "/super-ask") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "同一会话发起了新的提问，当前请求已失效",
          code: "INVALID_REQUEST",
        }),
      );
      return;
    }

    if (req.url === "/api/ack") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
      return;
    }

    throw new Error(`unexpected path: ${req.url}`);
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();

    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "super-ask-codex.js"), "--codex-hook", "--port", String(port)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(
        `${JSON.stringify({
          hook_event_name: "Stop",
          session_id: "codex-session-1",
          turn_id: "codex-turn-1",
          cwd: "/tmp/workspace",
          last_assistant_message: "## 工作汇报\n- 已完成 A",
        })}\n`,
      );
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.includes("错误: 响应缺少 chatSessionId 或 feedback"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("codex hook falls back to the original summary when transcript file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-standalone-hook-"));
  const summary = "## 工作汇报\n- 已完成 A";
  const transcriptPath = path.join(tempDir, "missing.jsonl");

  let askBody = null;
  let ackBody = null;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    let raw = "";
    for await (const chunk of req) raw += chunk;

    if (req.url === "/super-ask") {
      askBody = JSON.parse(raw);
      assert.equal(askBody.summary, summary);
      assert.ok(!askBody.summary.includes("Subagent 活动"));

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ chatSessionId: "codex-session-1", feedback: "继续" }));
      return;
    }

    if (req.url === "/api/ack") {
      ackBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
      return;
    }

    throw new Error(`unexpected path: ${req.url}`);
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();

    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "super-ask-codex.js"), "--codex-hook", "--port", String(port)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(
        `${JSON.stringify({
          hook_event_name: "Stop",
          session_id: "codex-session-1",
          turn_id: "codex-turn-1",
          cwd: "/tmp/workspace",
          transcript_path: transcriptPath,
          last_assistant_message: summary,
        })}\n`,
      );
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), '{"decision": "block", "reason": "继续"}');
    assert.ok(askBody);
    assert.equal(askBody.chatSessionId, "codex-session-1");
    assert.equal(askBody.requestId, "codex-turn-1");
    assert.equal(askBody.workspaceRoot, "/tmp/workspace");
    assert.equal(askBody.summary, summary);
    assert.equal(askBody.question, "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。");
    assert.ok(ackBody);
    assert.equal(ackBody.chatSessionId, "codex-session-1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("isSubagentTranscriptPath returns false when transcript file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagent-detect-"));
  try {
    const result = await codex.isSubagentTranscriptPath(path.join(tempDir, "missing.jsonl"));
    assert.equal(result, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildCodexStopHookPayload accepts an enriched summary", () => {
  const payload = codex.buildCodexStopHookPayload(
    {
      session_id: "codex-session-123",
      turn_id: "codex-turn-456",
      cwd: "/tmp/workspace",
      last_assistant_message: "## 工作汇报\n- 已完成 A",
    },
    "## 工作汇报\n- 已完成 A\n\n## Subagent 活动\n- 本轮启动 1 个：Ada",
  );

  assert.match(payload.summary, /## Subagent 活动/);
  assert.equal(payload.chatSessionId, "codex-session-123");
});
