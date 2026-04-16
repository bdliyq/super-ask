import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 19960;
const SUPER_ASK_DIR = join(homedir(), ".super-ask");
const SUPER_ASK_TOKEN_PATH = join(SUPER_ASK_DIR, "token");
const SUPER_ASK_CONFIG_PATH = join(SUPER_ASK_DIR, "config.json");
const RETRY_DELAY_MS = 10_000;
const DEFAULT_RETRIES = -1;
const REQUEST_TIMEOUT_MS = 86_400_000;
const ACK_TIMEOUT_MS = 5_000;
const INSTALL_HINT = `bash "{{SUPER_ASK_INSTALL_SH}}"`;
const LOGS_DIR = join(SUPER_ASK_DIR, "logs");

interface SuperAskConfigFile {
  host?: unknown;
  port?: unknown;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function currentDateStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function currentLogPath(date = new Date()): string {
  return join(LOGS_DIR, `${currentDateStamp(date)}.log`);
}

async function logEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  const entry = {
    timestamp: new Date().toISOString(),
    source: "opencode-tool",
    event,
    ...payload,
  };
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    await appendFile(currentLogPath(), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // 日志为 best-effort，不影响主流程。
  }
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

function buildServerUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

async function readServerUrl(): Promise<string> {
  const envUrl =
    process.env.SUPER_ASK_SERVER_URL?.trim() || process.env.SUPER_ASK_SERVER?.trim();
  if (envUrl) {
    return trimTrailingSlash(envUrl);
  }

  try {
    const raw = await readFile(SUPER_ASK_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SuperAskConfigFile;
    const host =
      typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : DEFAULT_HOST;
    const port =
      typeof parsed.port === "number" && Number.isFinite(parsed.port) ? parsed.port : DEFAULT_PORT;
    return buildServerUrl(host, port);
  } catch {
    return buildServerUrl(DEFAULT_HOST, DEFAULT_PORT);
  }
}

async function readAuthToken(): Promise<string> {
  const envToken = process.env.SUPER_ASK_AUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    const token = (await readFile(SUPER_ASK_TOKEN_PATH, "utf-8")).trim();
    if (token) {
      return token;
    }
  } catch {
    // 忽略，统一走下面的报错。
  }

  throw new Error(
    `未找到 super-ask 鉴权 token。请先启动服务端（${INSTALL_HINT}）或设置 SUPER_ASK_AUTH_TOKEN。`,
  );
}

function getWorkspaceRoot(context: { worktree?: unknown; directory?: unknown }, value?: string): string | undefined {
  const explicit = value?.trim();
  if (explicit) {
    return explicit;
  }
  if (typeof context.worktree === "string" && context.worktree.trim()) {
    return context.worktree;
  }
  if (typeof context.directory === "string" && context.directory.trim()) {
    return context.directory;
  }
  return undefined;
}

function normalizeOptions(options?: string[]): string[] | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const cleaned = options.map((item) => item.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

async function parseError(response: Response): Promise<{
  message: string;
  code?: string;
  rawText: string;
}> {
  const text = await response.text();
  if (!text) {
    return { message: `HTTP ${response.status}`, rawText: "" };
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return {
        message: parsed.error,
        code: typeof parsed.code === "string" ? parsed.code : undefined,
        rawText: text,
      };
    }
  } catch {
    // 响应不是 JSON 时直接回退原文。
  }

  return { message: text, rawText: text };
}

function buildTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  return controller.signal;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const detail = `${error.name} ${error.message}`.toLowerCase();
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    detail.includes("timeout") ||
    detail.includes("timed out")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMaxRetries(): number {
  const retries = Number.parseInt(process.env.SUPER_ASK_RETRIES ?? "", 10);
  return Number.isFinite(retries) ? retries : DEFAULT_RETRIES;
}

async function postJson(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: buildTimeoutSignal(timeoutMs),
  });
}

async function requestWithRetries(
  url: string,
  token: string,
  buildBody: () => Record<string, unknown>,
): Promise<Response> {
  const maxRetries = readMaxRetries();
  let retryCount = 0;

  while (true) {
    const body = buildBody();
    const headers = buildHeaders(token);
    await logEvent("request.attempt", {
      url,
      method: "POST",
      headers,
      payload: body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retryCount,
      maxRetries,
    });
    let response: Response;
    try {
      response = await postJson(url, token, body, REQUEST_TIMEOUT_MS);
    } catch (error) {
      await logEvent("response.transport_error", {
        url,
        method: "POST",
        headers,
        payload: body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        retryCount,
        maxRetries,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (maxRetries >= 0 && retryCount >= maxRetries) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTimeoutError(error)) {
          await logEvent("request.retry_exhausted", {
            url,
            retryCount,
            maxRetries,
            message: `错误: 等待回复超时（已重试 ${maxRetries} 次）`,
          });
          throw new Error(`错误: 等待回复超时（已重试 ${maxRetries} 次）`);
        }
        await logEvent("request.fatal", {
          url,
          retryCount,
          maxRetries,
          message: `连接 super-ask server 失败：${message}。请确认服务已启动（${INSTALL_HINT}）。`,
        });
        throw new Error(
          `连接 super-ask server 失败：${message}。请确认服务已启动（${INSTALL_HINT}）。`,
        );
      }
      retryCount += 1;
      await logEvent("retry.wait", {
        url,
        retryCount,
        maxRetries,
        waitMs: RETRY_DELAY_MS,
        reason: error instanceof Error ? error.message : String(error),
      });
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (response.ok) {
      return response;
    }

    const { message, code, rawText } = await parseError(response);
    await logEvent("response.http_error", {
      url,
      method: "POST",
      headers,
      payload: body,
      status: response.status,
      code,
      message,
      rawResponse: rawText,
      retryCount,
      maxRetries,
    });
    if (response.status === 503 && code === "SERVER_SHUTTING_DOWN") {
      if (maxRetries >= 0 && retryCount >= maxRetries) {
        await logEvent("request.retry_exhausted", {
          url,
          retryCount,
          maxRetries,
          message: `错误: Server 返回 HTTP ${response.status}: ${message}`,
        });
        throw new Error(`错误: Server 返回 HTTP ${response.status}: ${message}`);
      }
      retryCount += 1;
      await logEvent("retry.wait", {
        url,
        retryCount,
        maxRetries,
        waitMs: RETRY_DELAY_MS,
        reason: message,
      });
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    await logEvent("request.fatal", {
      url,
      retryCount,
      maxRetries,
      message: `错误: Server 返回 HTTP ${response.status}: ${message}`,
    });
    throw new Error(`错误: Server 返回 HTTP ${response.status}: ${message}`);
  }
}

async function sendAck(serverUrl: string, token: string, chatSessionId: string): Promise<void> {
  const url = `${serverUrl}/api/ack`;
  const payload = { chatSessionId };
  const headers = buildHeaders(token);
  await logEvent("ack.attempt", {
    url,
    method: "POST",
    headers,
    payload,
    timeoutMs: ACK_TIMEOUT_MS,
  });
  try {
    const response = await postJson(
      url,
      token,
      payload,
      ACK_TIMEOUT_MS,
    );
    const rawResponse = await response.text();
    if (!response.ok) {
      await logEvent("ack.error", {
        url,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        payload,
        rawResponse,
      });
      return;
    }
    await logEvent("ack.success", {
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      payload,
      rawResponse,
    });
  } catch (error) {
    await logEvent("ack.error", {
      url,
      payload,
      headers,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    // 确认回执仅影响 UI 状态，不影响主流程。
  }
}

export default tool({
  description: "通过 super-ask 向用户汇报、提问，并阻塞等待用户回复。",
  args: {
    summary: tool.schema.string().describe("Markdown 格式的工作汇报摘要"),
    question: tool.schema.string().describe("想让用户回答的问题"),
    title: tool.schema.string().optional().describe("会话标题"),
    chatSessionId: tool.schema.string().optional().describe("同一会话的 chatSessionId"),
    options: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("可选的快捷回复列表"),
    workspaceRoot: tool.schema
      .string()
      .optional()
      .describe("工作区根路径；不传时自动使用当前 OpenCode 工作目录"),
  },
  async execute(args, context) {
    const token = await readAuthToken();
    const serverUrl = await readServerUrl();
    const workspaceRoot = getWorkspaceRoot(context, args.workspaceRoot);
    let stableChatSessionId =
      typeof args.chatSessionId === "string" && args.chatSessionId.trim() ? args.chatSessionId.trim() : undefined;

    const buildPayload = (): Record<string, unknown> => {
      if (!stableChatSessionId) {
        stableChatSessionId = randomUUID();
      }
      const payload = {
        summary: args.summary,
        question: args.question,
        title: args.title,
        chatSessionId: stableChatSessionId,
        options: normalizeOptions(args.options),
        workspaceRoot,
        source: "opencode",
      };
      return Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== undefined && value !== ""),
      );
    };

    const askUrl = `${serverUrl}/super-ask`;

    // 外层循环处理 response body 阶段的可恢复错误（如 Server 重启时连接中断）。
    // requestWithRetries 只保护 fetch 发送阶段；body 读取和 shutdown 响应需额外重试。
    while (true) {
      const response = await requestWithRetries(askUrl, token, buildPayload);

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        await logEvent("response.body_error", {
          url: askUrl,
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      await logEvent("response.success", {
        url: askUrl,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        rawResponse: raw,
      });
      let result: {
        chatSessionId?: unknown;
        feedback?: unknown;
        code?: unknown;
      };
      try {
        result = JSON.parse(raw) as {
          chatSessionId?: unknown;
          feedback?: unknown;
          code?: unknown;
        };
      } catch {
        await logEvent("response.invalid", {
          url: askUrl,
          rawResponse: raw,
          message: "错误: Server 返回无效响应",
        });
        throw new Error("错误: Server 返回无效响应");
      }

      if (result?.code === "SERVER_SHUTTING_DOWN") {
        await logEvent("response.shutdown_retry", {
          url: askUrl,
          rawResponse: raw,
          parsedResponse: result,
        });
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (
        !result ||
        typeof result !== "object" ||
        typeof result.chatSessionId !== "string" ||
        typeof result.feedback !== "string"
      ) {
        await logEvent("response.invalid", {
          url: askUrl,
          rawResponse: raw,
          parsedResponse: result,
          message: "错误: Server 返回无效响应",
        });
        throw new Error("错误: Server 返回无效响应");
      }

      await logEvent("response.parsed", {
        url: askUrl,
        parsedResponse: result,
      });
      await sendAck(serverUrl, token, result.chatSessionId);
      const output = JSON.stringify({
        chatSessionId: result.chatSessionId,
        feedback: result.feedback,
      });
      await logEvent("result.returned", {
        url: askUrl,
        output,
        result,
      });
      return output;
    }
  },
});
