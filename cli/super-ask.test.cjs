const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const CLI = path.join(__dirname, "super-ask.js");

test("super-ask.js --codex-hook exits 0 when a 200 body reports INVALID_REQUEST (superseded)", async () => {
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
        [CLI, "--codex-hook", "--port", String(port)],
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
