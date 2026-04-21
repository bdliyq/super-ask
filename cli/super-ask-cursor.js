#!/usr/bin/env node

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const DEFAULT_PORT = 19960;
const DEFAULT_TIMEOUT_SECONDS = 86400;
const DEFAULT_RETRIES = -1;
const HOST = "127.0.0.1";
const CANCELLED_FEEDBACK = "[Cancelled]";

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
    source: "cursor-hook",
    event,
    ...payload,
  };
  try {
    const target = logPath();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", flag: "a" });
  } catch {
    // 忽略日志写入失败，避免影响 hook 主流程。
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
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function extractCursorQuestion(lastAssistantMessage) {
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
  await logEvent("cursor_hook.request.attempt", {
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
      : "错误: Super Ask Server 未运行。请先启动: bash install.sh";
    await logEvent("cursor_hook.response.transport_error", {
      url,
      payload,
      timeout: timeoutSeconds,
      errorType: error?.name ?? typeof error,
      error: String(error),
      message,
    });
    return { outcome: "retryable", output: message };
  }

  if (!response.ok) {
    const message = rawText.trim()
      ? `错误: Server 返回 HTTP ${response.status}: ${rawText.trim()}`
      : `错误: Server 返回 HTTP ${response.status}: ${response.statusText}`;
    await logEvent("cursor_hook.response.http_error", {
      url,
      status: response.status,
      reason: response.statusText,
      rawResponse: rawText,
      payload,
      message,
    });
    return { outcome: response.status === 503 ? "retryable" : "fatal", output: message };
  }

  await logEvent("cursor_hook.response.success", {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawResponse: rawText,
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    await logEvent("cursor_hook.response.invalid", {
      url,
      rawResponse: rawText,
      message: "错误: Server 返回无效响应",
    });
    return { outcome: "fatal_response", output: "错误: Server 返回无效响应" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await logEvent("cursor_hook.response.invalid", {
      url,
      rawResponse: rawText,
      message: "错误: Server 返回无效响应",
    });
    return { outcome: "fatal_response", output: "错误: Server 返回无效响应" };
  }

  if (parsed.code === "SERVER_SHUTTING_DOWN") {
    const message = `错误: ${typeof parsed.error === "string" ? parsed.error : "服务器正在关闭"}`;
    await logEvent("cursor_hook.response.shutdown_retry", {
      url,
      rawResponse: rawText,
      message,
    });
    return { outcome: "retryable", output: message };
  }

  // 同一会话发起了新的 ask 请求，服务端把旧的长连接 supersede 掉了。
  // 因为响应头已经在长连接建立时写成了 200，这里 body 里带的是 INVALID_REQUEST。
  // 我们不能按 "fatal_response" 处理（否则 Cursor 的 stop hook 以 failClosed:true 被阻塞，
  // 后续 agent 任务不再触发 stop hook），而是静默退出 0：让出控制权给接管的新 hook。
  if (parsed.code === "INVALID_REQUEST") {
    const message =
      typeof parsed.error === "string" && parsed.error
        ? parsed.error
        : "当前请求已被同一会话的新请求接管";
    await logEvent("cursor_hook.response.superseded", {
      url,
      rawResponse: rawText,
      message,
    });
    return { outcome: "superseded", output: message };
  }

  const output = formatJsonCompact(parsed);
  await logEvent("cursor_hook.response.parsed", { url, parsedResponse: parsed });
  return { outcome: "success", output, parsedResponse: parsed };
}

async function sendAck(port, chatSessionId, authToken) {
  const url = `http://${HOST}:${port}/api/ack`;
  const payload = { chatSessionId };
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(5),
    });
    const rawResponse = await response.text();
    await logEvent(response.ok ? "cursor_hook.ack.success" : "cursor_hook.ack.error", {
      url,
      status: response.status,
      reason: response.statusText,
      rawResponse,
      payload,
    });
  } catch (error) {
    await logEvent("cursor_hook.ack.error", {
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
        await logEvent("cursor_hook.response.invalid_blocking", {
          url,
          output: result.output,
          message: validation.message,
        });
        return { status: 1, output: validation.message };
      }
      if (validation.parsed.chatSessionId) {
        await sendAck(port, validation.parsed.chatSessionId, authToken);
      }
      await logEvent("cursor_hook.result.returned", { url, output: result.output });
      return { status: 0, output: result.output, parsed: validation.parsed };
    }
    if (result.outcome === "superseded") {
      await logEvent("cursor_hook.request.superseded", {
        url,
        message: result.output,
      });
      return { status: 0, output: "{}", superseded: true };
    }
    if (result.outcome !== "retryable") {
      await logEvent("cursor_hook.request.fatal", {
        url,
        outcome: result.outcome,
        message: result.output,
      });
      return { status: 1, output: result.output };
    }
    if (maxRetries >= 0 && retryCount >= maxRetries) {
      await logEvent("cursor_hook.request.retry_exhausted", {
        url,
        outcome: result.outcome,
        retryCount,
        maxRetries,
        message: result.output,
      });
      return { status: 1, output: result.output };
    }
    retryCount += 1;
    await logEvent("cursor_hook.retry.wait", {
      url,
      retryCount,
      maxRetries,
      waitSeconds: 10,
      message: result.output,
    });
    await delay(10_000);
  }
}

function createCursorHookResponse(feedback) {
  return formatJsonCompact({
    followup_message: feedback,
  });
}

function normalizeHookEventName(payload) {
  const raw = String(payload.hook_event_name ?? payload.hookEventName ?? "").trim();
  return raw || "unknown";
}

function extractTextBlocks(content) {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      return [item.text];
    }
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

function extractLastAssistantTextFromTranscriptContent(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  let lastAssistantText = "";
  for (const line of lines) {
    const entry = parseTranscriptLine(line.trim());
    if (!entry || entry.role !== "assistant") continue;
    const blocks = extractTextBlocks(entry.message?.content);
    if (blocks.length > 0) {
      lastAssistantText = blocks.join("\n\n").trim();
    }
  }
  return lastAssistantText || null;
}

async function extractLastAssistantTextFromTranscriptPath(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return extractLastAssistantTextFromTranscriptContent(content);
  } catch (error) {
    await logEvent("cursor_hook.transcript.read_error", {
      transcriptPath,
      error: String(error),
    });
    return null;
  }
}

function pickWorkspaceRoot(payload) {
  if (Array.isArray(payload.workspace_roots)) {
    const workspaceRoot = payload.workspace_roots.find((item) => typeof item === "string" && item.trim());
    if (typeof workspaceRoot === "string" && workspaceRoot.trim()) {
      return workspaceRoot.trim();
    }
  }
  const cwd = String(payload.cwd ?? "").trim();
  if (cwd) return cwd;
  return "";
}

async function buildCursorStopHookPayload(payload) {
  const inlineSummary = String(payload.last_assistant_message ?? payload.lastAssistantMessage ?? "").trim();
  const summary = inlineSummary || await extractLastAssistantTextFromTranscriptPath(
    String(payload.transcript_path ?? payload.transcriptPath ?? "").trim(),
  );
  if (!summary) return null;

  const chatSessionId = String(payload.session_id ?? payload.sessionId ?? "").trim();
  const generationId = String(payload.generation_id ?? payload.generationId ?? "").trim();
  const workspaceRoot = pickWorkspaceRoot(payload);

  const body = {
    summary,
    question: extractCursorQuestion(summary),
    source: "cursor",
    options: ["继续", "需要修改", "我有问题"],
    requestId: generationId
      ? `cursor-stop:${chatSessionId || "unknown-session"}:${generationId}`
      : randomUUID(),
  };

  if (chatSessionId) body.chatSessionId = chatSessionId;
  if (workspaceRoot) body.workspaceRoot = workspaceRoot;
  return body;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function logHookPayload(hookEventName, payload) {
  await logEvent("cursor_hook.received", {
    hookEventName,
    payload,
  });
  process.stderr.write(
    `[super-ask-cursor] hook=${hookEventName}\n${prettyJson(payload)}\n`,
  );
}

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    retries: DEFAULT_RETRIES,
    cursorHook: false,
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
      case "--cursor-hook":
        args.cursorHook = true;
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

async function runCursorHook(args) {
  const payload = await readStdinJson();
  const hookEventName = normalizeHookEventName(payload);
  await logHookPayload(hookEventName, payload);

  if (hookEventName.toLowerCase() !== "stop") {
    await logEvent("cursor_hook.ignored", { hookEventName });
    return 0;
  }

  const requestPayload = await buildCursorStopHookPayload(payload);
  if (requestPayload === null) {
    await logEvent("cursor_hook.skip", {
      hookEventName,
      reason: "missing_last_assistant_message",
    });
    process.stdout.write("{}\n");
    return 0;
  }

  const authToken = await readAuthToken();
  const url = `http://${HOST}:${args.port}/super-ask`;
  const result = await executeBlockingRequest(url, requestPayload, args.port, args.retries, authToken);
  if (result.status !== 0) {
    process.stderr.write(`${result.output}\n`);
    return result.status;
  }

  const feedback = typeof result.parsed?.feedback === "string" ? result.parsed.feedback.trim() : "";
  if (!feedback || feedback === CANCELLED_FEEDBACK) {
    process.stdout.write("{}\n");
    return 0;
  }

  process.stdout.write(`${createCursorHookResponse(feedback)}\n`);
  return 0;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("exitCode" in parsed) {
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    return parsed.exitCode;
  }

  const { args } = parsed;
  if (!args.cursorHook) {
    process.stderr.write("错误: 该脚本仅用于 Cursor hook，请通过 --cursor-hook 调用\n");
    return 1;
  }
  return runCursorHook(args);
}

module.exports = {
  extractCursorQuestion,
  extractLastAssistantTextFromTranscriptContent,
  buildCursorStopHookPayload,
  pickWorkspaceRoot,
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
