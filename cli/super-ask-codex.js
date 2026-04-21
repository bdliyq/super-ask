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

function isSubagentTranscriptContent(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseTranscriptLine(trimmed);
    if (!entry || entry.type !== "session_meta") return false;
    return Boolean(entry.payload?.source?.subagent?.thread_spawn);
  }
  return false;
}

async function isSubagentTranscriptPath(transcriptPath) {
  if (!transcriptPath) return false;
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return isSubagentTranscriptContent(content);
  } catch (error) {
    await logEvent("codex_hook.transcript.read_error", {
      transcriptPath,
      error: String(error),
    });
    return false;
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
  await logEvent("request.attempt", {
    url,
    method: "POST",
    headers,
    payload,
    timeout: timeoutSeconds,
  });

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
    const message = isTimeout
      ? "错误: 等待回复超时"
      : "错误: Super Ask Server 未运行。请先启动: super-ask start";
    await logEvent("response.transport_error", {
      url,
      method: "POST",
      headers,
      payload,
      timeout: timeoutSeconds,
      errorType: error?.name ?? typeof error,
      error: String(error),
      message,
    });
    return { outcome: "retryable", output: message };
  }

  if (!response.ok) {
    const { message: httpMessage, code } = httpErrorMessage(rawText);
    const message = httpMessage
      ? `错误: Server 返回 HTTP ${response.status}: ${httpMessage}`
      : `错误: Server 返回 HTTP ${response.status}: ${response.statusText}`;
    await logEvent("response.http_error", {
      url,
      method: "POST",
      headers,
      payload,
      timeout: timeoutSeconds,
      status: response.status,
      reason: response.statusText,
      rawResponse: rawText,
      message,
      errorCode: code,
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
    await logEvent("response.shutdown_retry", {
      url,
      rawResponse: rawText,
      message,
    });
    return { outcome: "retryable", output: message };
  }

  // 同一会话新 ask supersede 了本长连接；头已是 200，body 为 INVALID_REQUEST（与 Cursor 相同场景）
  if (parsed.code === "INVALID_REQUEST") {
    const message =
      typeof parsed.error === "string" && parsed.error
        ? parsed.error
        : "当前请求已被同一会话的新请求接管";
    await logEvent("codex_hook.response.superseded", {
      url,
      rawResponse: rawText,
      message,
    });
    return { outcome: "superseded", output: message };
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
  await logEvent("ack.attempt", {
    url,
    method: "POST",
    headers,
    payload,
    timeout: 5,
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(5),
    });
    const rawResponse = await response.text();
    if (!response.ok) {
      await logEvent("ack.error", {
        url,
        status: response.status,
        reason: response.statusText,
        rawResponse,
        payload,
      });
      return;
    }
    await logEvent("ack.success", {
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      rawResponse,
      payload,
    });
  } catch (error) {
    await logEvent("ack.error", {
      url,
      payload,
      error: String(error),
    });
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
        await logEvent("response.invalid_blocking", {
          url,
          output: result.output,
          message: validation.message,
        });
        return { status: 1, output: validation.message };
      }
      if (validation.parsed.chatSessionId) {
        await sendAck(port, validation.parsed.chatSessionId, authToken);
      }
      await logEvent("result.returned", { url, output: result.output });
      return { status: 0, output: result.output, parsed: validation.parsed };
    }
    if (result.outcome === "superseded") {
      await logEvent("codex_hook.request.superseded", {
        url,
        message: result.output,
      });
      return { status: 0, output: "{}", superseded: true };
    }
    if (result.outcome !== "retryable") {
      await logEvent("request.fatal", {
        url,
        outcome: result.outcome,
        message: result.output,
      });
      return { status: 1, output: result.output };
    }
    if (maxRetries >= 0 && retryCount >= maxRetries) {
      await logEvent("request.retry_exhausted", {
        url,
        outcome: result.outcome,
        retryCount,
        maxRetries,
        message: result.output,
      });
      return { status: 1, output: result.output };
    }
    retryCount += 1;
    await logEvent("retry.wait", {
      url,
      retryCount,
      maxRetries,
      waitSeconds: 10,
      message: result.output,
    });
    await delay(10_000);
  }
}

function createCodexHookResponse(feedback) {
  return formatJsonCompact({
    decision: "block",
    reason: feedback,
  });
}

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    retries: -1,
    codexHook: false,
  };
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
    return {
      exitCode: 2,
      stderr: `unrecognized arguments: ${unknown.join(" ")}\n`,
    };
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
    await logEvent("codex_hook.skip", {
      hookEventName,
      reason: "missing_last_assistant_message",
    });
    return 0;
  }

  const transcriptPath = String(payload.transcript_path ?? payload.transcriptPath ?? "").trim();
  if (await isSubagentTranscriptPath(transcriptPath)) {
    await logEvent("codex_hook.skip", {
      hookEventName,
      reason: "subagent_session",
      sessionId: String(payload.session_id ?? payload.sessionId ?? "").trim() || null,
      transcriptPath,
    });
    return 0;
  }

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
  extractSubagentActivityFromTranscriptPath,
  isSubagentTranscriptContent,
  isSubagentTranscriptPath,
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
