import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, openSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import type {
  AskRequest,
  DeployRequest,
  DeployScope,
  FileAttachment,
  HealthResponse,
  OpenPathRequest,
  SuperAskConfig,
  UndeployRequest,
} from "../../shared/types";
import { SUPER_ASK_DIR } from "./config";
import { SessionManager } from "./sessionManager";
import { WsHub } from "./wsHub";
import { TerminalManager } from "./terminalManager";
import { DeployManager } from "./deployManager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = resolve(join(__dirname, "../static"));

const MAX_BODY_BYTES = 1024 * 1024;

/** 上传接口 JSON 体上限（含 base64，约可覆盖 10MB 原始文件） */
const MAX_UPLOAD_JSON_BYTES = 15 * 1024 * 1024;

/** 单文件解码后最大字节数 */
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;

/** 上传子目录名须为 UUID（与 randomUUID 输出一致） */
const UPLOAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 内联展示允许的图片 MIME（与需求一致） */
const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * 将原始文件名转为磁盘安全名（仅保留常见安全字符）
 */
function safeUploadFilename(name: string): string {
  const n = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return n || "file";
}

/**
 * 解析 GET /uploads/<id>/<filename> 对应的绝对路径；不合法则返回 null
 */
function resolveUserUploadFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/uploads/")) return null;
  const rest = decoded.slice("/uploads/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  if (!UPLOAD_ID_RE.test(id)) return null;
  const root = resolve(join(SUPER_ASK_DIR, "uploads", id));
  const candidate = resolve(join(root, basename(name)));
  if (!candidate.startsWith(root + sep)) return null;
  return candidate;
}

function mimeForPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * 读取 POST JSON 体（带大小上限）
 */
async function readJsonBody(
  req: IncomingMessage,
  limit: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(raw);
}

/** 校验 POST /api/deploy 请求体 */
function isValidDeployRequest(body: unknown): body is DeployRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as DeployRequest;
  if (typeof b.workspacePath !== "string") return false;
  const scope = b.scope ?? "workspace";
  if (scope !== "user" && scope !== "workspace") return false;
  // user 范围可不传工作区路径；workspace 范围必须非空
  if (scope === "workspace" && !b.workspacePath.trim()) {
    return false;
  }
  if (!Array.isArray(b.platforms) || b.platforms.length === 0) return false;
  for (const p of b.platforms) {
    if (p !== "cursor" && p !== "vscode" && p !== "codex" && p !== "opencode" && p !== "qwen") return false;
  }
  return true;
}

/** 校验 POST /api/undeploy 请求体（至少卸载平台之一或 cleanConfig） */
function isValidUndeployRequest(body: unknown): body is UndeployRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as UndeployRequest;
  if (typeof b.workspacePath !== "string") return false;
  const scope = b.scope ?? "workspace";
  if (scope !== "user" && scope !== "workspace") return false;
  if (scope === "workspace" && !b.workspacePath.trim()) {
    return false;
  }
  if (!Array.isArray(b.platforms)) return false;
  for (const p of b.platforms) {
    if (p !== "cursor" && p !== "vscode" && p !== "codex" && p !== "opencode" && p !== "qwen") return false;
  }
  if (b.cleanConfig !== undefined && typeof b.cleanConfig !== "boolean") {
    return false;
  }
  const hasWork = b.platforms.length > 0 || b.cleanConfig === true;
  return hasWork;
}

function getPathname(req: IncomingMessage): string {
  try {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    return u.pathname;
  } catch {
    return "";
  }
}

/**
 * 在 STATIC_ROOT 下安全解析静态文件路径
 */
function resolveStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  const rel =
    decoded === "/" || decoded === ""
      ? "index.html"
      : decoded.replace(/^\//, "");
  const candidate = resolve(STATIC_ROOT, rel);
  const root = resolve(STATIC_ROOT);
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

async function sendStatic(
  res: ServerResponse,
  filePath: string
): Promise<void> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeForPath(filePath));
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (filePath.includes("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (filePath.endsWith(".png") || filePath.endsWith(".ico")) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
  }
}

export interface RunningServer {
  readonly httpServer: ReturnType<typeof createServer>;
  readonly sessionManager: SessionManager;
  readonly close: () => Promise<void>;
}

/**
 * 启动 HTTP + WebSocket，绑定 config.host / config.port
 */
export function startSuperAsk(
  config: SuperAskConfig,
  authToken: string
): Promise<RunningServer> {
  let wsHub: WsHub;
  let terminalManager: TerminalManager;

  // 项目根目录：server/src → 上两级到 super-ask 仓库根（含 rules/）
  const projectRoot = resolve(join(__dirname, "..", ".."));
  const deployManager = new DeployManager(projectRoot);

  const sessionManager = new SessionManager(config, (msg) =>
    wsHub.broadcast(msg)
  );

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res);
  });

  // 禁用 Node.js 18+ 默认的 5 分钟请求/头部超时，
  // 否则 /super-ask 长连接会被服务端主动断开。
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;

  wsHub = new WsHub(sessionManager, httpServer, authToken);
  terminalManager = new TerminalManager(sessionManager, authToken);
  terminalManager.attachToServer(httpServer);
  sessionManager.onSessionDeleted = (id) => terminalManager.killSession(id);

  /** 校验 Bearer 或 X-Super-Ask-Token，未通过则写 401 并返回 false */
  function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers["authorization"];
    const tokenHeader = req.headers["x-super-ask-token"];
    let token: string | undefined;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else if (typeof tokenHeader === "string") {
      token = tokenHeader;
    }
    if (token === authToken) return true;
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "未授权：无效或缺少 token",
        code: "UNAUTHORIZED",
      })
    );
    return false;
  }

  function resolveOpenPath(rawPath: string, workspaceRoot?: string): string {
    let resolved: string;
    if (rawPath.startsWith("~/") || rawPath === "~") {
      resolved = resolve(homedir(), rawPath.slice(2));
    } else if (rawPath.startsWith("/") || /^[A-Za-z]:\\/.test(rawPath)) {
      resolved = resolve(rawPath);
    } else {
      if (!workspaceRoot) throw new Error("MISSING_WORKSPACE_ROOT");
      resolved = resolve(workspaceRoot, rawPath);
    }
    if (resolved.includes("\0")) throw new Error("INVALID_PATH");
    return resolved;
  }

  async function openInFileManager(
    targetPath: string,
  ): Promise<{ type: "file" | "directory" }> {
    const st = await stat(targetPath);
    const isDir = st.isDirectory();
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "open";
      args = isDir ? [targetPath] : ["-R", targetPath];
    } else if (platform === "win32") {
      cmd = "explorer";
      args = isDir ? [targetPath] : ["/select,", targetPath];
    } else {
      cmd = "xdg-open";
      args = isDir ? [targetPath] : [dirname(targetPath)];
    }
    return new Promise((res, rej) => {
      execFile(cmd, args, { timeout: 5000 }, (err) => {
        if (err && platform !== "win32") rej(err);
        else res({ type: isDir ? "directory" : "file" });
      });
    });
  }

  async function handleHttp(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const method = req.method ?? "GET";
    const pathname = getPathname(req);

    if (method === "GET" && pathname === "/health") {
      const snap = sessionManager.getHealthSnapshot();
      const body: HealthResponse = {
        status: "ok",
        pid: process.pid,
        uptime: Math.floor(sessionManager.getUptimeMs() / 1000),
        activeSessions: snap.activeSessions,
        pendingRequests: snap.pendingRequests,
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
      return;
    }

    if (method === "GET" && pathname === "/api/auth-token") {
      const remoteAddr = req.socket.remoteAddress ?? "";
      const isLocal =
        remoteAddr === "127.0.0.1" ||
        remoteAddr === "::1" ||
        remoteAddr === "::ffff:127.0.0.1";
      if (!isLocal) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "仅允许本地访问" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ token: authToken }));
      return;
    }

    if (method === "POST" && pathname === "/super-ask") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req, MAX_BODY_BYTES);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.statusCode = msg === "BODY_TOO_LARGE" ? 413 : 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "请求体无效或过大",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const ask = parsed as AskRequest;
      if (
        !ask ||
        typeof ask.summary !== "string" ||
        typeof ask.question !== "string"
      ) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "缺少必填字段 summary 或 question",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      if ((parsed as Record<string, unknown>).noWait === true) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "轮询模式已移除，请使用阻塞模式",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      try {
        await sessionManager.handleAskRequest(ask, req, res);
      } catch {
        /* 错误响应已由 handleAskRequest / close 处理，或已 end */
      }
      return;
    }

    // POST /api/deploy — 一键部署规则到 Cursor / VSCode 工作区
    if (method === "POST" && pathname === "/api/deploy") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req, MAX_BODY_BYTES);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.statusCode = msg === "BODY_TOO_LARGE" ? 413 : 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "请求体无效或过大",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      if (!isValidDeployRequest(parsed)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error:
              "缺少有效字段：platforms（非空数组）与 workspacePath（非空字符串）",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const result = await deployManager.deploy(parsed);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/undeploy — 一键卸载并可选清理 ~/.super-ask/
    if (method === "POST" && pathname === "/api/undeploy") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req, MAX_BODY_BYTES);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.statusCode = msg === "BODY_TOO_LARGE" ? 413 : 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "请求体无效或过大",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      if (!isValidUndeployRequest(parsed)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error:
              "缺少有效字段：workspacePath；且需 platforms 非空或 cleanConfig 为 true",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const result = await deployManager.undeploy(parsed);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/deploy/status?workspace=...&scope=user|workspace — 查询已部署规则
    if (method === "GET" && pathname === "/api/deploy/status") {
      if (!requireAuth(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const workspace = url.searchParams.get("workspace") ?? "";
      const scopeRaw = url.searchParams.get("scope") ?? "workspace";
      const scope: DeployScope =
        scopeRaw === "user" ? "user" : "workspace";
      const result = await deployManager.checkStatus(workspace, scope);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/ack — Agent 确认已收到回复
    if (method === "POST" && pathname === "/api/ack") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 4096); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const sid = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      if (!sid) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 chatSessionId" }));
        return;
      }
      const ok = sessionManager.ackReply(sid);
      res.statusCode = ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // POST /api/pin — Pin 一条消息
    if (method === "POST" && pathname === "/api/pin") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 4096); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const sid = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      const idx = typeof b.index === "number" ? b.index : -1;
      if (!sid || idx < 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 chatSessionId 或 index" }));
        return;
      }
      const ok = sessionManager.pinMessage(sid, idx);
      res.statusCode = ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // POST /api/unpin — Unpin 一条消息
    if (method === "POST" && pathname === "/api/unpin") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 4096); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const sid = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      const idx = typeof b.index === "number" ? b.index : -1;
      if (!sid || idx < 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 chatSessionId 或 index" }));
        return;
      }
      const ok = sessionManager.unpinMessage(sid, idx);
      res.statusCode = ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // POST /api/tag — 为会话添加标签
    if (method === "POST" && pathname === "/api/tag") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 4096); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const sid = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      const tag = typeof b.tag === "string" ? b.tag : "";
      if (!sid || !tag.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 chatSessionId 或 tag" }));
        return;
      }
      const ok = sessionManager.addTag(sid, tag);
      res.statusCode = ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // POST /api/untag — 移除会话标签
    if (method === "POST" && pathname === "/api/untag") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 4096); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const sid = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      const tag = typeof b.tag === "string" ? b.tag : "";
      if (!sid || !tag.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 chatSessionId 或 tag" }));
        return;
      }
      const ok = sessionManager.removeTag(sid, tag);
      res.statusCode = ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // POST /api/pinned-sessions — 更新会话列表 pin 顺序
    if (method === "POST" && pathname === "/api/pinned-sessions") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 8192); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const chatSessionId = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      const pinned = typeof b.pinned === "boolean" ? b.pinned : undefined;
      const pinnedSessionIds = b.pinnedSessionIds;
      if (chatSessionId && pinned !== undefined) {
        const ok = sessionManager.setSessionPinned(chatSessionId, pinned);
        res.statusCode = ok ? 200 : 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            success: ok,
            pinnedSessionIds: sessionManager.listPinnedSessionIdsForSync(),
          })
        );
        return;
      }
      if (
        !Array.isArray(pinnedSessionIds) ||
        pinnedSessionIds.some((item) => typeof item !== "string")
      ) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 pinnedSessionIds 或 chatSessionId/pinned" }));
        return;
      }
      sessionManager.setPinnedSessionOrder(pinnedSessionIds);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          success: true,
          pinnedSessionIds: sessionManager.listPinnedSessionIdsForSync(),
        })
      );
      return;
    }

    // POST /api/open-path — 用系统文件管理器打开路径
    if (method === "POST" && pathname === "/api/open-path") {
      if (!requireAuth(req, res)) return;
      let body: unknown;
      try {
        body = await readJsonBody(req, 4096);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const { path: rawPath, workspaceRoot } = (body ?? {}) as Partial<OpenPathRequest>;
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "path 字段必填" }));
        return;
      }
      let resolved: string;
      try {
        resolved = resolveOpenPath(
          rawPath.trim(),
          typeof workspaceRoot === "string" ? workspaceRoot.trim() : undefined,
        );
      } catch (e: unknown) {
        const code = e instanceof Error ? e.message : "INVALID_PATH";
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: code === "MISSING_WORKSPACE_ROOT" ? "相对路径需要 workspaceRoot" : "无效路径",
          }),
        );
        return;
      }
      try {
        const result = await openInFileManager(resolved);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true, resolvedPath: resolved, type: result.type }));
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "路径不存在或无法打开" }));
      }
      return;
    }

    // GET /api/read-file — 读取文件内容用于预览
    if (method === "GET" && pathname === "/api/read-file") {
      if (!requireAuth(req, res)) return;
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const rawPath = url.searchParams.get("path") ?? "";
      const wsRoot = url.searchParams.get("workspaceRoot") ?? "";
      if (!rawPath.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "path 参数必填" }));
        return;
      }
      let resolved: string;
      try {
        resolved = resolveOpenPath(rawPath.trim(), wsRoot.trim() || undefined);
      } catch (e: unknown) {
        const code = e instanceof Error ? e.message : "INVALID_PATH";
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          error: code === "MISSING_WORKSPACE_ROOT" ? "相对路径需要 workspaceRoot" : "无效路径",
        }));
        return;
      }
      try {
        const st = await stat(resolved);
        if (st.isDirectory()) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "不支持预览目录" }));
          return;
        }
        const fileSize = st.size;
        const MAX_READ = 2 * 1024 * 1024;
        const truncated = fileSize > MAX_READ;
        const probe = await readFile(resolved, { encoding: null, flag: "r" });
        const slice = truncated ? probe.subarray(0, MAX_READ) : probe;
        const isBinary = slice.includes(0);
        const ext = extname(resolved).toLowerCase().replace(/^\./, "");
        const langMap: Record<string, string> = {
          ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
          mjs: "javascript", cjs: "javascript", mts: "typescript",
          py: "python", pyi: "python", rb: "ruby",
          go: "go", rs: "rust", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
          java: "java", kt: "kotlin", swift: "swift", cs: "csharp",
          css: "css", scss: "scss", less: "less",
          html: "html", htm: "html", vue: "vue", svelte: "svelte",
          json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
          xml: "xml", svg: "xml",
          sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
          ps1: "powershell", bat: "batch",
          sql: "sql", graphql: "graphql", gql: "graphql",
          md: "markdown", mdx: "mdx", markdown: "markdown",
          dockerfile: "dockerfile", makefile: "makefile",
          ini: "ini", env: "ini", gitignore: "ini", editorconfig: "ini",
          txt: "plaintext", log: "plaintext", csv: "plaintext",
          r: "r", lua: "lua", perl: "perl", php: "php",
          dart: "dart", ex: "elixir", exs: "elixir", erl: "erlang",
          zig: "zig", nim: "nim", v: "v",
          tf: "hcl", hcl: "hcl",
          proto: "protobuf",
          mdc: "markdown",
        };
        const lang = isBinary ? null : (langMap[ext] ?? null);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          content: isBinary ? null : slice.toString("utf-8"),
          resolvedPath: resolved,
          size: fileSize,
          lang,
          isBinary,
          truncated,
        }));
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "文件不存在或无法读取" }));
      }
      return;
    }

    // PUT /api/write-file — 保存文件内容
    if (method === "PUT" && pathname === "/api/write-file") {
      if (!requireAuth(req, res)) return;
      let body: unknown;
      try {
        body = await readJsonBody(req, 4 * 1024 * 1024);
      } catch (e: unknown) {
        const msg = e instanceof Error && e.message === "BODY_TOO_LARGE" ? "文件过大" : "无效请求体";
        res.statusCode = e instanceof Error && e.message === "BODY_TOO_LARGE" ? 413 : 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: msg }));
        return;
      }
      const { path: filePath, content } = (body ?? {}) as { path?: string; content?: string };
      if (typeof filePath !== "string" || !filePath.trim() || typeof content !== "string") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "path 和 content 字段必填" }));
        return;
      }
      const resolved = resolve(filePath.trim());
      if (resolved.includes("\0")) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "无效路径" }));
        return;
      }
      try {
        await writeFile(resolved, content, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true, resolvedPath: resolved }));
      } catch {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "写入失败" }));
      }
      return;
    }

    // GET /api/predefined-msgs — 获取预定义消息列表
    if (method === "GET" && pathname === "/api/predefined-msgs") {
      if (!requireAuth(req, res)) return;
      const filePath = join(SUPER_ASK_DIR, "predefined-msgs.json");
      try {
        const raw = await readFile(filePath, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(raw);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(err.code === "ENOENT" ? "[]" : "[]");
      }
      return;
    }

    // PUT /api/predefined-msgs — 保存预定义消息列表
    if (method === "PUT" && pathname === "/api/predefined-msgs") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req, MAX_BODY_BYTES);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "请求体无效或过大" }));
        return;
      }
      if (!Array.isArray(parsed)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "请求体须为 JSON 数组" }));
        return;
      }
      const filePath = join(SUPER_ASK_DIR, "predefined-msgs.json");
      try {
        await mkdir(SUPER_ASK_DIR, { recursive: true });
        await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error("[server] 保存预定义消息失败:", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "写入文件失败" }));
      }
      return;
    }

    // GET /api/auto-reply-templates — 获取自动回复模板
    if (method === "GET" && pathname === "/api/auto-reply-templates") {
      if (!requireAuth(req, res)) return;
      const filePath = join(SUPER_ASK_DIR, "auto-reply-templates.json");
      try {
        const raw = await readFile(filePath, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(raw);
      } catch {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end("[]");
      }
      return;
    }

    // PUT /api/auto-reply-templates — 保存自动回复模板
    if (method === "PUT" && pathname === "/api/auto-reply-templates") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req, MAX_BODY_BYTES);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "请求体无效或过大" }));
        return;
      }
      if (!Array.isArray(parsed)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "请求体须为 JSON 数组" }));
        return;
      }
      const filePath = join(SUPER_ASK_DIR, "auto-reply-templates.json");
      try {
        await mkdir(SUPER_ASK_DIR, { recursive: true });
        await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error("[server] 保存自动回复模板失败:", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "写入文件失败" }));
      }
      return;
    }

    // POST /api/auto-reply — 设置/关闭会话的自动回复
    if (method === "POST" && pathname === "/api/auto-reply") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try { parsed = await readJsonBody(req, 4096); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const b = parsed as Record<string, unknown>;
      const sid = typeof b.chatSessionId === "string" ? b.chatSessionId : "";
      const templateId = b.templateId === null || typeof b.templateId === "string" ? (b.templateId as string | null) : undefined;
      if (!sid || templateId === undefined) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "缺少 chatSessionId 或 templateId" }));
        return;
      }
      const ok = sessionManager.setAutoReply(sid, templateId);
      res.statusCode = ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // POST /api/server/restart — 重启服务端进程
    if (method === "POST" && pathname === "/api/server/restart") {
      if (!requireAuth(req, res)) return;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: true }));

      const logFile = join(SUPER_ASK_DIR, "super-ask.log");
      setTimeout(() => {
        try {
          const out = openSync(logFile, "a");
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: ["ignore", out, out],
            cwd: process.cwd(),
            env: { ...process.env },
          });
          child.unref();
        } catch (e) {
          console.error("[server] 重启失败:", e);
        }
        process.exit(0);
      }, 500);
      return;
    }

    // POST /api/upload — JSON + base64 存盘，供会话附件引用
    if (method === "POST" && pathname === "/api/upload") {
      if (!requireAuth(req, res)) return;
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req, MAX_UPLOAD_JSON_BYTES);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.statusCode = msg === "BODY_TOO_LARGE" ? 413 : 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error:
              msg === "BODY_TOO_LARGE"
                ? "请求体过大"
                : "请求体无效或 JSON 解析失败",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "请求体须为 JSON 对象",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const b = parsed as Record<string, unknown>;
      if (
        typeof b.filename !== "string" ||
        typeof b.mimeType !== "string" ||
        typeof b.data !== "string"
      ) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "缺少 filename、mimeType 或 data（base64）字段",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      let b64 = b.data.trim();
      const dataUrl = /^data:[^;]+;base64,/i;
      if (dataUrl.test(b64)) {
        b64 = b64.replace(dataUrl, "");
      }

      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "base64 解码失败",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      if (buf.length === 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "文件内容为空",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      if (buf.length > MAX_UPLOAD_FILE_BYTES) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "单文件超过 10MB 上限",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const mimeLower = b.mimeType.trim().toLowerCase();
      if (mimeLower.startsWith("image/") && !ALLOWED_IMAGE_MIMES.has(mimeLower)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "不支持的图片类型，仅支持 JPEG、PNG、GIF、WebP",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const displayName = basename(b.filename.trim()) || "file";
      const safeName = safeUploadFilename(displayName);
      const id = randomUUID();
      const dir = join(SUPER_ASK_DIR, "uploads", id);

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, safeName), buf);
      } catch (err) {
        console.error("[server] 写入上传文件失败:", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "服务器写入文件失败",
            code: "INVALID_REQUEST",
          })
        );
        return;
      }

      const mimeType =
        b.mimeType.trim() || "application/octet-stream";
      const payload: FileAttachment = {
        id,
        filename: displayName,
        mimeType,
        url: `/uploads/${id}/${encodeURIComponent(safeName)}`,
        size: buf.length,
      };

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
      return;
    }

    if (method === "GET") {
      const uploadFile = resolveUserUploadFile(pathname);
      if (uploadFile) {
        await sendStatic(res, uploadFile);
        return;
      }

      if (pathname === "/favicon.ico") {
        const pngPath = resolve(STATIC_ROOT, "favicon.png");
        try {
          await stat(pngPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=86400");
          createReadStream(pngPath).pipe(res);
        } catch {
          res.statusCode = 204;
          res.end();
        }
        return;
      }

      const filePath = resolveStaticPath(pathname);
      if (!filePath) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      await sendStatic(res, filePath);
      return;
    }

    res.statusCode = 405;
    res.end("Method Not Allowed");
  }

  return new Promise((resolvePromise, rejectPromise) => {
    void sessionManager
      .loadFromDisk()
      .then(() => {
        sessionManager.startIdleCleanup();
        httpServer.listen(config.port, config.host, () => {
          resolvePromise({
            httpServer,
            sessionManager,
            close: async () => {
              sessionManager.stopIdleCleanup();
              await sessionManager.shutdownNotifyAgents();
              await terminalManager.close();
              await new Promise<void>((r, j) => {
                httpServer.close((err) => (err ? j(err) : r()));
              });
            },
          });
        });
      })
      .catch(rejectPromise);

    httpServer.on("error", (err) => {
      rejectPromise(err);
    });
  });
}
