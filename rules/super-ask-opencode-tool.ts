import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 19960;
const SUPER_ASK_DIR = join(homedir(), ".super-ask");
const SUPER_ASK_TOKEN_PATH = join(SUPER_ASK_DIR, "token");
const SUPER_ASK_CONFIG_PATH = join(SUPER_ASK_DIR, "config.json");
const RETRY_DELAY_MS = 10_000;
const DEFAULT_RETRIES = 6;
const INSTALL_HINT = `bash "{{SUPER_ASK_INSTALL_SH}}"`;

interface SuperAskConfigFile {
  host?: unknown;
  port?: unknown;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

async function parseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // 响应不是 JSON 时直接回退原文。
  }

  return text;
}

async function postJson(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
}

async function requestWithRetries(url: string, token: string, body: unknown): Promise<Response> {
  const retries = Number.parseInt(process.env.SUPER_ASK_RETRIES ?? "", 10);
  const maxRetries =
    Number.isFinite(retries) && retries >= 0 ? retries : DEFAULT_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await postJson(url, token, body);
    } catch (error) {
      if (attempt >= maxRetries) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `连接 super-ask server 失败：${message}。请确认服务已启动（${INSTALL_HINT}）。`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  throw new Error("连接 super-ask server 失败。");
}

async function sendAck(serverUrl: string, token: string, chatSessionId: string): Promise<void> {
  try {
    await postJson(`${serverUrl}/api/ack`, token, { chatSessionId });
  } catch {
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
    const payload = {
      summary: args.summary,
      question: args.question,
      title: args.title,
      chatSessionId: args.chatSessionId,
      options: normalizeOptions(args.options),
      workspaceRoot,
      source: "opencode",
    };

    const response = await requestWithRetries(
      `${serverUrl}/super-ask`,
      token,
      Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== undefined && value !== ""),
      ),
    );

    if (!response.ok) {
      throw new Error(await parseError(response));
    }

    const result = (await response.json()) as {
      chatSessionId?: unknown;
      feedback?: unknown;
    };

    if (typeof result.chatSessionId !== "string" || typeof result.feedback !== "string") {
      throw new Error("super-ask 响应缺少 chatSessionId 或 feedback。");
    }

    await sendAck(serverUrl, token, result.chatSessionId);
    return JSON.stringify({
      chatSessionId: result.chatSessionId,
      feedback: result.feedback,
    });
  },
});
