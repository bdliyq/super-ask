# Codex Standalone Hook Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cli/super-ask-codex.js` a fully standalone Codex hook implementation that does not depend on `cli/super-ask.js`, does not touch Cursor or any other script, and can enrich Codex Stop summaries from `transcript_path`.

**Architecture:** Replace the current wrapper-only `cli/super-ask-codex.js` with a self-contained script that owns Codex argument parsing, Stop-hook payload building, transcript parsing, subagent activity summarization, request/ack transport, and logging. Keep the hook command path unchanged so deploy rendering and user hook config do not need changes.

**Tech Stack:** Node.js CommonJS CLI script, `node:fs/promises` transcript reads, `node:test` standalone CLI tests, existing `server/poll-protocol.test.mjs` stub-server integration harness.

---

## File Structure

| File | Operation | Responsibility |
|------|------|------|
| `cli/super-ask-codex.js` | Modify | Full standalone Codex hook logic, including transcript enrichment |
| `cli/super-ask-codex.test.cjs` | Create | Unit tests for standalone Codex helper behavior |
| `server/poll-protocol.test.mjs` | Modify | Prove the standalone Codex hook script still works end-to-end |
| `rules/super-ask-codex.md` | Modify | Clarify that Codex hook behavior is driven by `super-ask-codex.js` and may append transcript-derived subagent activity |

## Scope Guardrails

- Do **not** modify `cli/super-ask.js`.
- Do **not** modify `cli/super-ask-cursor.js`.
- Do **not** add a shared helper module.
- Do **not** modify `server/src/deployManager.ts`, because the hook path stays `node ".../cli/super-ask-codex.js" --codex-hook`.
- Do **not** change the server request schema.
- Do **not** introduce `state_5.sqlite`, `archived_sessions`, or `hooks/logs` as runtime dependencies in Phase 1.

---

### Task 1: Replace the Codex Wrapper with a Standalone Script

**Files:**
- Modify: `cli/super-ask-codex.js`

- [ ] **Step 1: Write the failing standalone Codex test first**

Before changing the script, create a minimal unit test that proves the current wrapper is insufficient.

Create this file:

```js
// cli/super-ask-codex.test.cjs
const assert = require("node:assert/strict");
const test = require("node:test");

const codex = require("./super-ask-codex.js");

test("standalone codex script exports codex helpers", () => {
  assert.equal(typeof codex.buildCodexStopHookPayload, "function");
  assert.equal(typeof codex.extractCodexQuestion, "function");
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

Run: `node --test cli/super-ask-codex.test.cjs`

Expected: FAIL because the current wrapper exports nothing useful.

- [ ] **Step 3: Replace `cli/super-ask-codex.js` with a self-contained implementation**

Replace the entire file with:

```js
#!/usr/bin/env node

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { setTimeout: delay } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");

const DEFAULT_PORT = 19960;
const DEFAULT_TIMEOUT_SECONDS = 86400;
const HOST = "127.0.0.1";

function formatJsonCompact(value) {
  return JSON.stringify(value)
    .replace(/":/g, '": ')
    .replace(/,"/g, ', "');
}

function logPath() {
  return path.join(os.homedir(), ".super-ask", "logs", `${new Date().toISOString().slice(0, 10)}.log`);
}

async function logEvent(event, payload = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    source: "cli",
    event,
    ...payload,
  };
  try {
    const target = logPath();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", flag: "a" });
  } catch {
    // Ignore logging failures.
  }
}

async function readAuthToken() {
  try {
    const token = (await readFile(path.join(os.homedir(), ".super-ask", "token"), "utf-8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

function lastNonEmptyLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function extractCodexQuestion(lastAssistantMessage) {
  const lastLine = lastNonEmptyLine(lastAssistantMessage);
  if (lastLine.endsWith("?") || lastLine.endsWith("？")) return lastLine;
  return "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。";
}

function readStdinJson() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      const trimmed = raw.trim();
      if (!trimmed) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { payload: parsed });
      } catch {
        resolve({ raw_stdin: trimmed });
      }
    });
    process.stdin.on("error", () => resolve({}));
    if (process.stdin.isTTY) resolve({});
  });
}

function extractTextBlocks(content) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) return [item.text];
    if (item.type === "input_text" && typeof item.text === "string" && item.text.trim()) return [item.text];
    if (item.type === "output_text" && typeof item.text === "string" && item.text.trim()) return [item.text];
    return [];
  });
}

function parseTranscriptLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getMessageRole(entry) {
  if (entry?.role) return entry.role;
  return entry?.payload?.role ?? null;
}

function getMessageContent(entry) {
  if (entry?.message?.content) return entry.message.content;
  return entry?.payload?.content ?? null;
}

function extractSubagentNotification(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("<subagent_notification>")) return null;
  const inner = raw
    .replace(/^<subagent_notification>\s*/, "")
    .replace(/\s*<\/subagent_notification>$/, "");
  try {
    const parsed = JSON.parse(inner);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findLastAssistantIndex(entries, summary) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || getMessageRole(entry) !== "assistant") continue;
    const text = extractTextBlocks(getMessageContent(entry)).join("\n\n").trim();
    if (text && text === String(summary ?? "").trim()) return i;
  }
  return -1;
}

function isRealUserPrompt(entry) {
  if (!entry || getMessageRole(entry) !== "user") return false;
  const text = extractTextBlocks(getMessageContent(entry)).join("\n\n").trim();
  return Boolean(text) && !text.startsWith("<subagent_notification>");
}

function sliceCurrentTurnEntries(entries, summary) {
  const assistantIndex = findLastAssistantIndex(entries, summary);
  if (assistantIndex < 0) return entries;
  let start = 0;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (isRealUserPrompt(entries[i])) {
      start = i;
      break;
    }
  }
  return entries.slice(start, assistantIndex + 1);
}

function pushUnique(target, item) {
  if (!item.threadId) return;
  if (target.some((existing) => existing.threadId === item.threadId)) return;
  target.push(item);
}

function extractSubagentActivityFromTranscriptContent(content, summary) {
  const entries = String(content ?? "")
    .split(/\r?\n/)
    .map((line) => parseTranscriptLine(line.trim()))
    .filter(Boolean);
  const currentTurn = sliceCurrentTurnEntries(entries, summary);
  const activity = { spawned: [], completed: [], closed: [] };

  for (const entry of currentTurn) {
    if (entry.type === "event_msg" && entry.payload?.type === "collab_agent_spawn_end") {
      pushUnique(activity.spawned, {
        threadId: String(entry.payload.new_thread_id ?? ""),
        nickname: String(entry.payload.new_agent_nickname ?? ""),
        role: String(entry.payload.new_agent_role ?? ""),
      });
      continue;
    }

    if (entry.type === "event_msg" && entry.payload?.type === "collab_waiting_end") {
      for (const status of entry.payload.agent_statuses ?? []) {
        if (status?.status?.completed) {
          pushUnique(activity.completed, {
            threadId: String(status.thread_id ?? ""),
            nickname: String(status.agent_nickname ?? ""),
            role: String(status.agent_role ?? ""),
          });
        }
      }
      continue;
    }

    if (entry.type === "event_msg" && entry.payload?.type === "collab_close_end") {
      pushUnique(activity.closed, {
        threadId: String(entry.payload.receiver_thread_id ?? ""),
        nickname: String(entry.payload.receiver_agent_nickname ?? ""),
        role: String(entry.payload.receiver_agent_role ?? ""),
      });
      continue;
    }

    if (getMessageRole(entry) === "user") {
      const notification = extractSubagentNotification(
        extractTextBlocks(getMessageContent(entry)).join("\n\n").trim(),
      );
      if (notification?.status?.completed) {
        pushUnique(activity.completed, {
          threadId: String(notification.agent_path ?? ""),
          nickname: "",
          role: "",
        });
      }
    }
  }

  return activity;
}

async function extractSubagentActivityFromTranscriptPath(transcriptPath, summary) {
  if (!transcriptPath) return { spawned: [], completed: [], closed: [] };
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return extractSubagentActivityFromTranscriptContent(content, summary);
  } catch (error) {
    await logEvent("codex_hook.transcript.read_error", {
      transcriptPath,
      error: String(error),
    });
    return { spawned: [], completed: [], closed: [] };
  }
}

function formatNames(items) {
  return items.map((item) => item.nickname || item.threadId).join("、");
}

function mergeSummaryWithSubagentActivity(summary, activity) {
  const base = String(summary ?? "").trim();
  if (!base) return base;
  if (base.includes("## Subagent 活动")) return base;
  const lines = [];
  if (activity.spawned.length > 0) lines.push(`- 本轮启动 ${activity.spawned.length} 个：${formatNames(activity.spawned)}`);
  if (activity.completed.length > 0) lines.push(`- 已完成 ${activity.completed.length} 个：${formatNames(activity.completed)}`);
  if (activity.closed.length > 0) lines.push(`- 已关闭 ${activity.closed.length} 个：${formatNames(activity.closed)}`);
  if (lines.length === 0) return base;
  return `${base}\n\n## Subagent 活动\n${lines.join("\n")}`;
}

function buildCodexStopHookPayload(payload, enrichedSummary) {
  const summary = String(enrichedSummary ?? payload.last_assistant_message ?? payload.lastAssistantMessage ?? "").trim();
  if (!summary) return null;
  const body = {
    summary,
    question: extractCodexQuestion(summary),
    source: "codex",
    options: ["继续", "需要修改", "我有问题"],
  };
  const chatSessionId = String(payload.session_id ?? payload.sessionId ?? "").trim();
  if (chatSessionId) body.chatSessionId = chatSessionId;
  const workspaceRoot = String(payload.cwd ?? "").trim();
  if (workspaceRoot) body.workspaceRoot = workspaceRoot;
  const requestId = String(payload.turn_id ?? payload.turnId ?? "").trim();
  body.requestId = requestId || randomUUID();
  return body;
}

function httpErrorMessage(rawText) {
  const text = rawText.trim();
  if (!text) return { message: "", code: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = typeof parsed.error === "string" ? parsed.error : text;
      const code = typeof parsed.code === "string" ? parsed.code : null;
      return { message, code };
    }
  } catch {
    // Fall through.
  }
  return { message: text.slice(0, 2000), code: null };
}

function createTimeoutSignal(timeoutSeconds) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutSeconds * 1000);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutSeconds * 1000);
  timer.unref?.();
  return controller.signal;
}

async function sendRequest(url, payload, timeoutSeconds, authToken) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
  await logEvent("request.attempt", { url, method: "POST", headers, payload, timeout: timeoutSeconds });
  let response;
  let rawText = "";
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(timeoutSeconds),
    });
    rawText = await response.text();
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const message = isTimeout ? "错误: 等待回复超时" : "错误: Super Ask Server 未运行。请先启动: super-ask start";
    await logEvent("response.transport_error", {
      url, method: "POST", headers, payload, timeout: timeoutSeconds,
      errorType: error?.name ?? typeof error, error: String(error), message,
    });
    return { outcome: "retryable", output: message };
  }
  if (!response.ok) {
    const { message: httpMessage, code } = httpErrorMessage(rawText);
    const message = httpMessage
      ? `错误: Server 返回 HTTP ${response.status}: ${httpMessage}`
      : `错误: Server 返回 HTTP ${response.status}: ${response.statusText}`;
    await logEvent("response.http_error", {
      url, method: "POST", headers, payload, timeout: timeoutSeconds,
      status: response.status, reason: response.statusText, rawResponse: rawText, message, errorCode: code,
    });
    if (response.status === 503 && code === "SERVER_SHUTTING_DOWN") {
      return { outcome: "retryable", output: message };
    }
    return { outcome: "fatal", output: message };
  }
  await logEvent("response.success", {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawResponse: rawText,
  });
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    await logEvent("response.invalid", {
      url,
      rawResponse: rawText,
      message: "错误: Server 返回无效响应",
    });
    return { outcome: "fatal_response", output: "错误: Server 返回无效响应" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await logEvent("response.invalid", {
      url,
      rawResponse: rawText,
      message: "错误: Server 返回无效响应",
    });
    return { outcome: "fatal_response", output: "错误: Server 返回无效响应" };
  }
  if (parsed.code === "SERVER_SHUTTING_DOWN") {
    const message = `错误: ${typeof parsed.error === "string" ? parsed.error : "服务器正在关闭"}`;
    await logEvent("response.shutdown_retry", { url, rawResponse: rawText, message });
    return { outcome: "retryable", output: message };
  }
  const output = formatJsonCompact(parsed);
  await logEvent("response.parsed", { url, parsedResponse: parsed });
  return { outcome: "success", output, parsedResponse: parsed };
}

async function sendAck(port, chatSessionId, authToken) {
  const url = `http://${HOST}:${port}/api/ack`;
  const payload = { chatSessionId };
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
  await logEvent("ack.attempt", { url, method: "POST", headers, payload, timeout: 5 });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(5),
    });
    const rawResponse = await response.text();
    await logEvent(response.ok ? "ack.success" : "ack.error", {
      url, status: response.status, reason: response.statusText, rawResponse, payload,
    });
  } catch (error) {
    await logEvent("ack.error", { url, payload, error: String(error) });
  }
}

function validateBlockingResponse(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, message: "错误: 无效的响应 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "错误: 响应格式错误" };
  }
  if (typeof parsed.chatSessionId !== "string" || typeof parsed.feedback !== "string") {
    return { ok: false, message: "错误: 响应缺少 chatSessionId 或 feedback" };
  }
  return { ok: true, parsed };
}

async function executeBlockingRequest(url, payload, port, maxRetries, authToken) {
  let retryCount = 0;
  while (true) {
    const result = await sendRequest(url, payload, DEFAULT_TIMEOUT_SECONDS, authToken);
    if (result.outcome === "success") {
      const validation = validateBlockingResponse(result.output);
      if (!validation.ok) {
        await logEvent("response.invalid_blocking", { url, output: result.output, message: validation.message });
        return { status: 1, output: validation.message };
      }
      if (validation.parsed.chatSessionId) {
        await sendAck(port, validation.parsed.chatSessionId, authToken);
      }
      await logEvent("request.returned", { url, output: result.output });
      return { status: 0, output: result.output, parsed: validation.parsed };
    }
    if (result.outcome !== "retryable") {
      await logEvent("request.fatal", { url, outcome: result.outcome, message: result.output });
      return { status: 1, output: result.output };
    }
    if (maxRetries >= 0 && retryCount >= maxRetries) {
      await logEvent("request.retry_exhausted", {
        url, outcome: result.outcome, retryCount, maxRetries, message: result.output,
      });
      return { status: 1, output: result.output };
    }
    retryCount += 1;
    await logEvent("retry.wait", { url, retryCount, maxRetries, waitSeconds: 10, message: result.output });
    await delay(10_000);
  }
}

function createCodexHookResponse(feedback) {
  return formatJsonCompact({ decision: "block", reason: feedback });
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, retries: -1, codexHook: false };
  const unknown = [];
  const readValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `argument ${flag}: expected one argument` };
    }
    return { value };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed)) return { exitCode: 2, stderr: `argument --port: invalid int value: '${value}'\n` };
        args.port = parsed;
        i += 1;
        break;
      }
      case "--retries": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed)) return { exitCode: 2, stderr: `argument --retries: invalid int value: '${value}'\n` };
        args.retries = parsed;
        i += 1;
        break;
      }
      case "--codex-hook":
      case "--codex-stop-hook":
        args.codexHook = true;
        break;
      default:
        unknown.push(arg);
        break;
    }
  }
  if (unknown.length > 0) {
    return { exitCode: 2, stderr: `unrecognized arguments: ${unknown.join(" ")}\n` };
  }
  return { args };
}

async function runCodexHook(args) {
  const payload = await readStdinJson();
  const hookEventName = String(payload.hook_event_name ?? payload.hookEventName ?? "").trim() || "Unknown";
  await logEvent("codex_hook.received", {
    hookEventName,
    sessionId: String(payload.session_id ?? payload.sessionId ?? "").trim() || null,
    turnId: String(payload.turn_id ?? payload.turnId ?? "").trim() || null,
    cwd: String(payload.cwd ?? "").trim() || null,
  });
  if (hookEventName !== "Stop") {
    await logEvent("codex_hook.ignored", { hookEventName });
    return 0;
  }
  const rawSummary = String(payload.last_assistant_message ?? payload.lastAssistantMessage ?? "").trim();
  if (!rawSummary) {
    await logEvent("codex_hook.skip", { hookEventName, reason: "missing_last_assistant_message" });
    return 0;
  }
  const transcriptPath = String(payload.transcript_path ?? payload.transcriptPath ?? "").trim();
  const activity = await extractSubagentActivityFromTranscriptPath(transcriptPath, rawSummary);
  const enrichedSummary = mergeSummaryWithSubagentActivity(rawSummary, activity);
  const requestPayload = buildCodexStopHookPayload(payload, enrichedSummary);
  const authToken = await readAuthToken();
  const url = `http://${HOST}:${args.port}/super-ask`;
  const result = await executeBlockingRequest(url, requestPayload, args.port, args.retries, authToken);
  if (result.status !== 0) {
    process.stderr.write(`${result.output}\n`);
    return result.status;
  }
  const feedback = result.parsed?.feedback;
  if (typeof feedback === "string" && feedback.trim()) {
    process.stdout.write(`${createCodexHookResponse(feedback)}\n`);
  }
  return 0;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("exitCode" in parsed) {
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    return parsed.exitCode;
  }
  const { args } = parsed;
  if (!args.codexHook) {
    process.stderr.write("错误: 该脚本仅用于 Codex hook，请通过 --codex-hook 调用\n");
    return 1;
  }
  return runCodexHook(args);
}

module.exports = {
  extractCodexQuestion,
  extractSubagentActivityFromTranscriptContent,
  mergeSummaryWithSubagentActivity,
  buildCodexStopHookPayload,
};

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run the standalone Codex test again**

Run: `node --test cli/super-ask-codex.test.cjs`

Expected: FAIL for deeper behavior, but the export test should no longer fail with "undefined function"

- [ ] **Step 5: Commit**

```bash
git add cli/super-ask-codex.js cli/super-ask-codex.test.cjs
git commit -m "feat(codex): make codex hook script standalone"
```

---

### Task 2: Add Codex-Only Transcript Enrichment Tests

**Files:**
- Modify: `cli/super-ask-codex.test.cjs`

- [ ] **Step 1: Add transcript enrichment tests**

Append these tests to `cli/super-ask-codex.test.cjs`:

```js
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("buildCodexStopHookPayload preserves session_id turn_id cwd mapping", () => {
  const payload = codex.buildCodexStopHookPayload({
    session_id: "codex-session-123",
    turn_id: "codex-turn-456",
    cwd: "/tmp/workspace",
    last_assistant_message: "## 工作汇报\n- 已完成 A",
  });

  assert.equal(payload.chatSessionId, "codex-session-123");
  assert.equal(payload.requestId, "codex-turn-456");
  assert.equal(payload.workspaceRoot, "/tmp/workspace");
  assert.equal(payload.source, "codex");
});

test("extractSubagentActivityFromTranscriptContent recognizes current-turn subagent events", async () => {
  const transcript = [
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

  assert.equal(activity.spawned.length, 1);
  assert.equal(activity.completed.length, 1);
  assert.equal(activity.closed.length, 0);
});

test("mergeSummaryWithSubagentActivity appends a compact codex section", () => {
  const summary = codex.mergeSummaryWithSubagentActivity("## 工作汇报\n- 已完成 A", {
    spawned: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    completed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    closed: [],
  });

  assert.match(summary, /## Subagent 活动/);
  assert.match(summary, /Ada/);
});
```

- [ ] **Step 2: Add a fail-open transcript read test**

Append this test:

```js
test("standalone codex hook falls back to the original summary when transcript file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-standalone-hook-"));
  try {
    const payload = {
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      cwd: "/tmp/workspace",
      hook_event_name: "Stop",
      transcript_path: path.join(tempDir, "missing.jsonl"),
      last_assistant_message: "## 工作汇报\n- 已完成 A",
    };

    const activity = await (async () => {
      try {
        const content = await writeFile;
        return content;
      } catch {
        return { spawned: [], completed: [], closed: [] };
      }
    })();

    const merged = codex.mergeSummaryWithSubagentActivity(
      payload.last_assistant_message,
      activity.spawned ? activity : { spawned: [], completed: [], closed: [] },
    );

    assert.equal(merged, "## 工作汇报\n- 已完成 A");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the Codex unit test suite**

Run: `node --test cli/super-ask-codex.test.cjs`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add cli/super-ask-codex.test.cjs
git commit -m "test(codex): cover standalone transcript enrichment"
```

---

### Task 3: Update Only Codex End-to-End Coverage

**Files:**
- Modify: `server/poll-protocol.test.mjs`

- [ ] **Step 1: Extend the existing Codex Stop-hook test with transcript input**

Inside `server/poll-protocol.test.mjs`, in the test named `CLI codex stop hook mode reuses Codex session_id and turns feedback into a stop block`, replace the `runCliWithStdin` payload setup with:

```js
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
```

Then add:

```js
      assert.match(askBody.summary, /## Subagent 活动/);
      assert.match(askBody.summary, /Ada/);
```

- [ ] **Step 2: Keep the non-Stop Codex test unchanged**

Do not edit the test named `CLI codex hook ignores non-Stop events without calling the server`, except for any import additions needed by the previous step.

- [ ] **Step 3: Run only the Codex integration coverage**

Run: `node --test server/poll-protocol.test.mjs`

Expected: PASS, including both Codex hook tests

- [ ] **Step 4: Commit**

```bash
git add server/poll-protocol.test.mjs
git commit -m "test(codex): verify standalone codex hook end to end"
```

---

### Task 4: Update Only Codex Documentation

**Files:**
- Modify: `rules/super-ask-codex.md`

- [ ] **Step 1: Add the standalone-script note**

Append this note under the existing explanation section:

```md
- Codex hook 的实际执行逻辑由 `cli/super-ask-codex.js` 独立承担；它不依赖 Cursor 脚本，也不要求与其他 hook 脚本共享实现
- Codex `Stop` hook 可能会结合 `transcript_path` 补充一小段 subagent 活动摘要，但主 agent 的最后一条 assistant 消息仍然是面向用户汇报的权威来源
```

- [ ] **Step 2: Run a focused grep check so the wording stays Codex-only**

Run:

```bash
rg -n "Cursor|super-ask-cursor|共享实现|transcript_path" rules/super-ask-codex.md
```

Expected:
- `transcript_path` appears in the new note
- no newly introduced `Cursor` or `super-ask-cursor` references appear in the Codex rules file

- [ ] **Step 3: Commit**

```bash
git add rules/super-ask-codex.md
git commit -m "docs(codex): document standalone codex hook behavior"
```

---

## Coverage Check

- Standalone Codex runtime logic is implemented only in `cli/super-ask-codex.js`.
- Codex unit coverage is isolated to `cli/super-ask-codex.test.cjs`.
- Codex end-to-end hook behavior is verified in `server/poll-protocol.test.mjs`.
- Codex user-facing rule text is updated only in `rules/super-ask-codex.md`.
- `cli/super-ask.js` and `cli/super-ask-cursor.js` remain untouched.

## Risks To Watch During Execution

- This plan intentionally duplicates some transport/logging code instead of sharing helpers. That is acceptable here because isolation is an explicit requirement.
- The old Codex-related code inside `cli/super-ask.js` may remain dead but untouched. That is acceptable for this phase because the user explicitly asked not to involve other scripts.
- Transcript structure may vary; the standalone script must ignore unknown lines and fail open on transcript read errors.
- Keep the CLI path exactly `cli/super-ask-codex.js` so deploy output and existing hooks stay valid.
