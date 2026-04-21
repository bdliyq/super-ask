#!/usr/bin/env node

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const DEFAULT_PORT = 19960;
const DEFAULT_RETRIES = -1;
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
    source: "vscode-hook",
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

function extractTextBlocks(content) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (typeof item.text === "string" && item.text.trim()) return [item.text];
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

function getRole(entry) {
  return entry?.role ?? entry?.payload?.role ?? null;
}

function getContent(entry) {
  return entry?.message?.content ?? entry?.payload?.content ?? null;
}

function extractLastAssistantTextFromTranscriptContent(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  let lastAssistant = "";
  for (const line of lines) {
    const entry = parseTranscriptLine(line.trim());
    if (!entry || getRole(entry) !== "assistant") continue;
    const text = extractTextBlocks(getContent(entry)).join("\n\n").trim();
    if (text) lastAssistant = text;
  }
  return lastAssistant || null;
}

async function extractLastAssistantTextFromTranscriptPath(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return extractLastAssistantTextFromTranscriptContent(content);
  } catch (error) {
    await logEvent("transcript.read_error", {
      transcriptPath,
      error: String(error),
    });
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
    await logEvent("transcript.read_error", {
      transcriptPath,
      error: String(error),
    });
    return false;
  }
}

function extractVscodeQuestion(summary) {
  const lines = String(summary ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (last.endsWith("?") || last.endsWith("？")) return last;
  return "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。";
}

function buildVscodeHookRequestPayload(input, summary) {
  const body = {
    summary,
    question: extractVscodeQuestion(summary),
    source: "copilot in vscode",
    options: ["继续", "需要修改", "我有问题"],
  };

  const sessionId = String(input.sessionId ?? input.session_id ?? "").trim();
  if (sessionId) body.chatSessionId = sessionId;

  const cwd = String(input.cwd ?? "").trim();
  if (cwd) body.workspaceRoot = cwd;

  const requestId = String(
    input.requestId
      ?? input.request_id
      ?? input.invocationId
      ?? input.invocation_id
      ?? input.turn_id
      ?? input.turnId
      ?? "",
  ).trim();
  body.requestId = requestId || randomUUID();

  return body;
}

function buildStopHookOutput(feedback) {
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      decision: "block",
      reason: feedback,
    },
  };
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, retries: DEFAULT_RETRIES };
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
    if (arg === "--port") {
      const { value, error } = readValue(arg, i);
      if (error) return { exitCode: 2, stderr: `${error}\n` };
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed)) return { exitCode: 2, stderr: `argument --port: invalid int value: '${value}'\n` };
      args.port = parsed;
      i += 1;
      continue;
    }
    if (arg === "--retries") {
      const { value, error } = readValue(arg, i);
      if (error) return { exitCode: 2, stderr: `${error}\n` };
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed)) return { exitCode: 2, stderr: `argument --retries: invalid int value: '${value}'\n` };
      args.retries = parsed;
      i += 1;
      continue;
    }
    unknown.push(arg);
  }

  if (unknown.length > 0) {
    return { exitCode: 2, stderr: `unrecognized arguments: ${unknown.join(" ")}\n` };
  }
  return { args };
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

function httpErrorMessage(rawText) {
  const text = rawText.trim();
  if (!text) return { message: "", code: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        message: typeof parsed.error === "string" ? parsed.error : text,
        code: typeof parsed.code === "string" ? parsed.code : null,
      };
    }
  } catch {
    // Fall through.
  }
  return { message: text.slice(0, 2000), code: null };
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
      status: response.status,
      reason: response.statusText,
      rawResponse: rawText,
      payload,
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
    await logEvent("vscode_hook.response.superseded", {
      url,
      rawResponse: rawText,
      message,
    });
    return { outcome: "superseded", output: message };
  }

  return { outcome: "success", output: formatJsonCompact(parsed), parsedResponse: parsed };
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
    await logEvent(response.ok ? "ack.success" : "ack.error", {
      url,
      status: response.status,
      reason: response.statusText,
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
      return { status: 0, output: result.output, parsed: validation.parsed };
    }

    if (result.outcome === "superseded") {
      await logEvent("vscode_hook.request.superseded", {
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
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
    if (process.stdin.isTTY) resolve({});
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("exitCode" in parsed) {
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    return parsed.exitCode;
  }

  const args = parsed.args;
  const input = await readStdinJson();
  const hookEventName = String(input.hookEventName ?? input.hook_event_name ?? "").trim();

  if (hookEventName !== "Stop") return 0;

  const transcriptPath = String(input.transcript_path ?? input.transcriptPath ?? "").trim();
  if (await isSubagentTranscriptPath(transcriptPath)) return 0;

  const summary = await extractLastAssistantTextFromTranscriptPath(transcriptPath)
    || `## 工作汇报\n- 当前 VS Code Copilot 会话已到达停止点\n- 工作区：${String(input.cwd ?? "(unknown)").trim() || "(unknown)"}`;

  const requestPayload = buildVscodeHookRequestPayload(input, summary);
  const authToken = await readAuthToken();
  const url = `http://${HOST}:${args.port}/super-ask`;
  const result = await executeBlockingRequest(url, requestPayload, args.port, args.retries, authToken);
  if (result.status !== 0) {
    process.stdout.write(JSON.stringify({
      continue: true,
      systemMessage: result.output || "super-ask hook failed; continuing without feedback loop",
    }));
    return 0;
  }

  const feedback = typeof result.parsed?.feedback === "string" ? result.parsed.feedback.trim() : "";
  if (!feedback) return 0;

  process.stdout.write(`${JSON.stringify(buildStopHookOutput(feedback))}\n`);
  return 0;
}

module.exports = {
  extractLastAssistantTextFromTranscriptContent,
  extractLastAssistantTextFromTranscriptPath,
  isSubagentTranscriptContent,
  isSubagentTranscriptPath,
  extractVscodeQuestion,
  buildVscodeHookRequestPayload,
  buildStopHookOutput,
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
