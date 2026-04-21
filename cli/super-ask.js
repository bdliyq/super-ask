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
const REMOVED_FLAGS = new Set(["--poll", "--no-wait"]);

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

function unescapeNewlines(text) {
  return text.replace(/\\n/g, "\n");
}

function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
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

function buildPayload(args) {
  const body = {
    summary: unescapeNewlines(args.summary),
    question: unescapeNewlines(args.question),
  };
  if (args.title !== null) body.title = args.title;
  if (args.chatSessionId !== null) body.chatSessionId = args.chatSessionId;
  if (args.options !== null) body.options = args.options;
  if (args.source !== null) body.source = args.source;
  if (args.workspaceRoot !== null) body.workspaceRoot = args.workspaceRoot;
  return body;
}

function buildCodexStopHookPayload(payload) {
  const summary = String(payload.last_assistant_message ?? payload.lastAssistantMessage ?? "").trim();
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

  if (parsed.code === "INVALID_REQUEST") {
    const message =
      typeof parsed.error === "string" && parsed.error
        ? parsed.error
        : "当前请求已被同一会话的新请求接管";
    await logEvent("super_ask_cli.response.superseded", {
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
      await logEvent("super_ask_cli.request.superseded", {
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

  const requestPayload = buildCodexStopHookPayload(payload);
  if (requestPayload === null) {
    await logEvent("codex_hook.skip", {
      hookEventName,
      reason: "missing_last_assistant_message",
    });
    return 0;
  }

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

function parseArgs(argv) {
  const args = {
    summary: null,
    question: null,
    title: null,
    chatSessionId: null,
    options: null,
    port: DEFAULT_PORT,
    source: null,
    workspaceRoot: null,
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
    if (REMOVED_FLAGS.has(arg)) {
      unknown.push(arg);
      continue;
    }
    switch (arg) {
      case "--summary": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        args.summary = value;
        i += 1;
        break;
      }
      case "--question": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        args.question = value;
        i += 1;
        break;
      }
      case "--title": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        args.title = value;
        i += 1;
        break;
      }
      case "--session-id": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        args.chatSessionId = value;
        i += 1;
        break;
      }
      case "--options": {
        const values = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          values.push(argv[i + 1]);
          i += 1;
        }
        args.options = values;
        break;
      }
      case "--port": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed)) return { exitCode: 2, stderr: `argument --port: invalid int value: '${value}'\n` };
        args.port = parsed;
        i += 1;
        break;
      }
      case "--source": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        args.source = value;
        i += 1;
        break;
      }
      case "--workspace-root": {
        const { value, error } = readValue(arg, i);
        if (error) return { exitCode: 2, stderr: `${error}\n` };
        args.workspaceRoot = value;
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
        if (arg.startsWith("--")) unknown.push(arg);
        else unknown.push(arg);
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("exitCode" in parsed) {
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    return parsed.exitCode;
  }
  const { args } = parsed;

  if (args.codexHook) {
    return runCodexHook(args);
  }

  if (!args.summary || !args.question) {
    process.stderr.write("错误: --summary 和 --question 是必填参数\n");
    return 1;
  }

  const authToken = await readAuthToken();
  const url = `http://${HOST}:${args.port}/super-ask`;
  const payload = buildPayload(args);
  payload.requestId = randomUUID();
  const result = await executeBlockingRequest(url, payload, args.port, args.retries, authToken);
  const stream = result.status === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  return result.status;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
