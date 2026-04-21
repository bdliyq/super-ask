# Codex 独立 Hook 隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 `cli/super-ask-codex.js` 变成一个完全独立的 Codex hook 实现，不再依赖 `cli/super-ask.js`，不改 Cursor 或其他脚本，并且可以基于 `transcript_path` 为 Codex 的 Stop 汇报补充 subagent 活动摘要。

**架构：** 把当前只是 wrapper 的 `cli/super-ask-codex.js` 直接扩展成一个自包含脚本，由它自己负责 Codex 参数解析、Stop-hook payload 构建、transcript 解析、subagent 活动汇总、请求/ACK 传输和日志记录。保持 hook 命令路径不变，这样部署渲染和用户已有 hooks 配置都不用改。

**技术栈：** Node.js CommonJS CLI 脚本、`node:fs/promises` transcript 读取、`node:test` 独立 CLI 测试、现有 `server/poll-protocol.test.mjs` stub-server 集成测试框架。

> 本文件是独立版英文计划 [2026-04-21-codex-standalone-hook-isolation.md](/Users/leoli/workspace/super-ask/docs/superpowers/plans/2026-04-21-codex-standalone-hook-isolation.md) 的中文版本。它替代之前那份涉及公共 helper / Cursor 复用的思路。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `cli/super-ask-codex.js` | 修改 | 完整独立的 Codex hook 逻辑，包括 transcript enrichment |
| `cli/super-ask-codex.test.cjs` | 新建 | 独立版 Codex helper 行为测试 |
| `server/poll-protocol.test.mjs` | 修改 | 证明独立版 Codex hook 脚本仍然能端到端工作 |
| `rules/super-ask-codex.md` | 修改 | 说明 Codex hook 行为完全由 `super-ask-codex.js` 驱动，并且可能追加 transcript 派生的 subagent 活动摘要 |

## 范围边界

- **不要**修改 `cli/super-ask.js`。
- **不要**修改 `cli/super-ask-cursor.js`。
- **不要**新增共享 helper 模块。
- **不要**修改 `server/src/deployManager.ts`，因为 hook 路径仍然保持 `node ".../cli/super-ask-codex.js" --codex-hook`。
- **不要**修改 server 请求 schema。
- Phase 1 **不要**把 `state_5.sqlite`、`archived_sessions`、`hooks/logs` 引入成运行时必需依赖。

---

### 任务 1：把 Codex wrapper 替换成独立脚本

**涉及文件：**
- 修改：`cli/super-ask-codex.js`

- [ ] **步骤 1：先写失败的独立版 Codex 测试**

先创建最小测试，证明当前 wrapper 不够用。

创建：

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

- [ ] **步骤 2：运行新测试，确认它先失败**

运行：

```bash
node --test cli/super-ask-codex.test.cjs
```

期望：

```text
FAIL because the current wrapper exports nothing useful.
```

- [ ] **步骤 3：把 `cli/super-ask-codex.js` 整个替换成自包含实现**

把整个文件替换成下面这份独立实现：

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

- [ ] **步骤 4：重新运行独立版 Codex 测试**

运行：

```bash
node --test cli/super-ask-codex.test.cjs
```

期望：

```text
FAIL for deeper behavior, but the export test should no longer fail with "undefined function"
```

- [ ] **步骤 5：提交**

```bash
git add cli/super-ask-codex.js cli/super-ask-codex.test.cjs
git commit -m "feat(codex): make codex hook script standalone"
```

---

### 任务 2：补齐仅限 Codex 的 transcript enrichment 测试

**涉及文件：**
- 修改：`cli/super-ask-codex.test.cjs`

- [ ] **步骤 1：补充 transcript enrichment 行为测试**

在 `cli/super-ask-codex.test.cjs` 末尾追加：

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

- [ ] **步骤 2：追加一个 fail-open transcript 回退测试**

在同一个文件里继续追加：

```js
test("standalone codex hook falls back to the original summary when transcript file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-standalone-hook-"));
  try {
    const rawSummary = "## 工作汇报\n- 已完成 A";
    const transcriptPath = path.join(tempDir, "missing.jsonl");

    let activity;
    try {
      const content = await require("node:fs/promises").readFile(transcriptPath, "utf-8");
      activity = codex.extractSubagentActivityFromTranscriptContent(content, rawSummary);
    } catch {
      activity = { spawned: [], completed: [], closed: [] };
    }

    const merged = codex.mergeSummaryWithSubagentActivity(rawSummary, activity);
    assert.equal(merged, rawSummary);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 3：运行 Codex 单元测试套件**

运行：

```bash
node --test cli/super-ask-codex.test.cjs
```

期望：

```text
PASS
```

- [ ] **步骤 4：提交**

```bash
git add cli/super-ask-codex.test.cjs
git commit -m "test(codex): cover standalone transcript enrichment"
```

---

### 任务 3：只更新 Codex 端到端覆盖

**涉及文件：**
- 修改：`server/poll-protocol.test.mjs`

- [ ] **步骤 1：扩展现有 Codex Stop-hook 测试，引入 transcript 输入**

在 `server/poll-protocol.test.mjs` 中，找到现有测试 `CLI codex stop hook mode reuses Codex session_id and turns feedback into a stop block`，把 `runCliWithStdin` 的输入构造替换成下面这个带临时 transcript 的版本：

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

然后在现有 `askBody.summary` 断言后面追加：

```js
      assert.match(askBody.summary, /## Subagent 活动/);
      assert.match(askBody.summary, /Ada/);
```

- [ ] **步骤 2：保留现有非 Stop Codex 测试不动**

不要修改 `CLI codex hook ignores non-Stop events without calling the server` 这个测试，除了为了上一步可能需要补充 import。

- [ ] **步骤 3：只运行 Codex 集成覆盖**

运行：

```bash
node --test server/poll-protocol.test.mjs
```

期望：

```text
PASS, including both Codex hook tests
```

- [ ] **步骤 4：提交**

```bash
git add server/poll-protocol.test.mjs
git commit -m "test(codex): verify standalone codex hook end to end"
```

---

### 任务 4：只更新 Codex 文档

**涉及文件：**
- 修改：`rules/super-ask-codex.md`

- [ ] **步骤 1：补充独立脚本说明**

在 `rules/super-ask-codex.md` 现有说明区块下，追加：

```md
- Codex hook 的实际执行逻辑由 `cli/super-ask-codex.js` 独立承担；它不依赖 Cursor 脚本，也不要求与其他 hook 脚本共享实现
- Codex `Stop` hook 可能会结合 `transcript_path` 补充一小段 subagent 活动摘要，但主 agent 的最后一条 assistant 消息仍然是面向用户汇报的权威来源
```

- [ ] **步骤 2：做一次聚焦 grep，确认措辞仍然只限定在 Codex**

运行：

```bash
rg -n "Cursor|super-ask-cursor|共享实现|transcript_path" rules/super-ask-codex.md
```

期望：
- `transcript_path` 出现在新增说明里
- 没有新引入的 `Cursor` 或 `super-ask-cursor` 引用

- [ ] **步骤 3：提交**

```bash
git add rules/super-ask-codex.md
git commit -m "docs(codex): document standalone codex hook behavior"
```

---

## 覆盖检查

- 独立版 Codex 运行逻辑：只在 `cli/super-ask-codex.js` 中实现。
- Codex 单元测试：只在 `cli/super-ask-codex.test.cjs` 中覆盖。
- Codex 端到端 hook 行为：只在 `server/poll-protocol.test.mjs` 中验证。
- Codex 面向用户的规则文本：只在 `rules/super-ask-codex.md` 中更新。
- `cli/super-ask.js` 和 `cli/super-ask-cursor.js` 保持不动。

## 执行时重点关注的风险

- 这份计划是刻意接受“复制一部分逻辑”来换取隔离性，这符合这次显式需求。
- `cli/super-ask.js` 里原来那些 Codex 相关逻辑可能会保留为未使用代码，但 Phase 1 故意不碰它。
- transcript 结构可能变化，独立脚本必须忽略未知行，并在读取失败时 fail-open。
- 必须保持 CLI 路径仍然是 `cli/super-ask-codex.js`，这样部署输出和现有 hooks 才不会失效。
