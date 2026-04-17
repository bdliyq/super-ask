import { readFile, writeFile, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  AskRequest,
  AskResponse,
  ErrorResponse,
  FileAttachment,
  HealthResponse,
  SessionInfo,
  HistoryEntry,
  WsNewRequest,
  WsSessionUpdate,
  WsSessionDeleted,
  WsPinUpdate,
  WsPinnedSessionOrderUpdate,
  WsTagUpdate,
  WsServerMessage,
  SuperAskConfig,
} from "../../shared/types";
import { SUPER_ASK_DIR } from "./config";

/** 向 Web UI 广播（由 WsHub 实现） */
export type WsBroadcast = (msg: WsServerMessage) => void;

/**
 * 长连接心跳间隔（毫秒）。
 * 立即发送响应头后，每隔此间隔向 HTTP 响应写入一个空白字符，
 * 防止客户端 bodyTimeout（默认 300s）触发。
 */
const LONG_POLL_HEARTBEAT_MS = 30_000;

const SESSIONS_DIR = join(SUPER_ASK_DIR, "sessions");
const LEGACY_SESSIONS_PATH = join(SUPER_ASK_DIR, "sessions.json");
const PINNED_SESSIONS_PATH = join(SUPER_ASK_DIR, "pinned-sessions.json");

/** 上传目录使用的 UUID 格式（与 randomUUID 一致） */
const UPLOAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 校验 WebSocket 上报的附件元数据，避免任意 URL 注入
 */
function isValidFileAttachmentRef(a: unknown): a is FileAttachment {
  if (!a || typeof a !== "object") return false;
  const o = a as FileAttachment;
  if (typeof o.id !== "string" || !UPLOAD_ID_RE.test(o.id)) return false;
  if (typeof o.filename !== "string" || !o.filename.trim()) return false;
  if (typeof o.mimeType !== "string") return false;
  if (typeof o.url !== "string" || !o.url.startsWith("/uploads/")) return false;
  if (typeof o.size !== "number" || o.size < 0 || !Number.isFinite(o.size)) {
    return false;
  }
  return true;
}

/**
 * 规范化会话 pin 顺序：
 * - 仅保留现存 session
 * - 去重
 * - 忽略空字符串
 */
function normalizePinnedSessionIds(
  pinnedSessionIds: Iterable<string>,
  sessionIds: Iterable<string>
): string[] {
  const existingIds = new Set(sessionIds);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of pinnedSessionIds) {
    const id = raw.trim();
    if (!id || seen.has(id) || !existingIds.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function sameSessionIdOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

type PendingEntry = {
  resolve: (r: AskResponse) => void;
  reject: (e: Error) => void;
  httpRes: ServerResponse;
  cleanup: () => void;
};

/**
 * 管理 Session、待回复的 HTTP 长连接、持久化与空闲清理
 */
export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private pinnedSessionIds: string[] = [];
  private pinnedSessionPersistChain: Promise<void> = Promise.resolve();
  private pinnedSessionPersistSeq = 0;
  private pending = new Map<string, PendingEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private startedAt = Date.now();
  onSessionDeleted: ((chatSessionId: string) => void) | null = null;

  constructor(
    private config: SuperAskConfig,
    private wsBroadcast: WsBroadcast
  ) {}

  /**
   * 启动时从磁盘恢复 Session（不恢复 pending）
   * 优先从 sessions/ 目录逐文件加载，兼容旧的 sessions.json 单文件格式
   */
  async loadFromDisk(): Promise<void> {
    await mkdir(SESSIONS_DIR, { recursive: true });

    let loaded = 0;
    try {
      const files = await readdir(SESSIONS_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = (await readFile(join(SESSIONS_DIR, f), "utf-8")).trim();
          if (!raw) continue;
          const s = JSON.parse(raw) as SessionInfo;
          if (!s.chatSessionId) continue;
          const restored = { ...s, hasPending: false };
          if (restored.requestStatus === "pending") {
            restored.requestStatus = "cancelled";
          }
          this.sessions.set(s.chatSessionId, restored);
          loaded++;
        } catch {
          console.warn(`[sessionManager] 跳过损坏的会话文件: ${f}`);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }

    if (loaded > 0) {
      const fixups = [...this.sessions.values()].filter(
        (s) => s.requestStatus === "cancelled" && !s.hasPending
      );
      if (fixups.length > 0) {
        await Promise.all(fixups.map((s) => this.persistSession(s.chatSessionId)));
        console.log(`[sessionManager] 已修正 ${fixups.length} 个孤立 pending 会话`);
      }
    } else {
      try {
        const raw = (await readFile(LEGACY_SESSIONS_PATH, "utf-8")).trim();
        if (raw) {
          const data = JSON.parse(raw) as { sessions?: SessionInfo[] };
          const list = Array.isArray(data.sessions) ? data.sessions : [];
          for (const s of list) {
            const restored = { ...s, hasPending: false };
            if (restored.requestStatus === "pending") {
              restored.requestStatus = "cancelled";
            }
            this.sessions.set(s.chatSessionId, restored);
          }
          if (list.length > 0) {
            for (const s of list) {
              await this.persistSession(s.chatSessionId);
            }
            console.log(`[sessionManager] 已从旧 sessions.json 迁移 ${list.length} 个会话`);
          }
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }

    try {
      const raw = (await readFile(PINNED_SESSIONS_PATH, "utf-8")).trim();
      if (raw) {
        const parsed = JSON.parse(raw) as { pinnedSessionIds?: unknown } | unknown[];
        const parsedObj = Array.isArray(parsed) ? null : parsed;
        const inputList = (Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsedObj?.pinnedSessionIds)
            ? parsedObj.pinnedSessionIds
            : []).filter((item): item is string => typeof item === "string");
        this.pinnedSessionIds = normalizePinnedSessionIds(
          inputList,
          this.sessions.keys()
        );
        const shouldRewrite =
          Array.isArray(parsed) ||
          !Array.isArray(parsedObj?.pinnedSessionIds) ||
          !sameSessionIdOrder(inputList, this.pinnedSessionIds);
        if (shouldRewrite) {
          await this.persistPinnedSessionOrder();
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.warn("[sessionManager] 跳过损坏的会话 pin 文件");
      }
    }
  }

  private ensureSessionCapacity(
    httpRes: ServerResponse,
    reject: (error: Error) => void
  ): boolean {
    if (this.sessions.size < this.config.maxSessions) {
      return true;
    }
    this.sendJsonError(
      httpRes,
      503,
      "Session 数量已达上限",
      "INVALID_REQUEST"
    );
    reject(new Error("MAX_SESSIONS"));
    return false;
  }

  private createSession(chatSessionId: string, req: AskRequest): SessionInfo {
    const title = req.title?.trim() || "新对话";
    const now = Date.now();
    const session: SessionInfo = {
      chatSessionId,
      title,
      history: [],
      hasPending: false,
      createdAt: now,
      lastActiveAt: now,
      ...(req.source !== undefined
        ? { source: req.source.trim() || undefined }
        : {}),
      ...(req.workspaceRoot !== undefined
        ? { workspaceRoot: req.workspaceRoot.trim() || undefined }
        : {}),
    };
    this.sessions.set(chatSessionId, session);
    return session;
  }

  /**
   * 原子写入单个会话文件（tmp + rename）
   */
  private async persistSession(chatSessionId: string): Promise<void> {
    const session = this.sessions.get(chatSessionId);
    if (!session) return;
    try {
      await mkdir(SESSIONS_DIR, { recursive: true });
      const filePath = join(SESSIONS_DIR, `${chatSessionId}.json`);
      const tmpPath = filePath + ".tmp";
      await writeFile(tmpPath, JSON.stringify(session, null, 2), "utf-8");
      await rename(tmpPath, filePath);
    } catch (err) {
      console.error(`[sessionManager] 持久化会话 ${chatSessionId} 失败:`, err);
    }
  }

  /**
   * 原子写入会话 pin 顺序文件（tmp + rename）
   */
  private persistPinnedSessionOrder(): Promise<void> {
    const snapshot = [...this.pinnedSessionIds];
    const seq = ++this.pinnedSessionPersistSeq;
    this.pinnedSessionPersistChain = this.pinnedSessionPersistChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(SUPER_ASK_DIR, { recursive: true });
          const tmpPath = `${PINNED_SESSIONS_PATH}.tmp-${process.pid}-${seq}`;
          await writeFile(
            tmpPath,
            JSON.stringify({ pinnedSessionIds: snapshot }, null, 2),
            "utf-8"
          );
          await rename(tmpPath, PINNED_SESSIONS_PATH);
        } catch (err) {
          console.error("[sessionManager] 持久化会话 pin 顺序失败:", err);
        }
      });
    return this.pinnedSessionPersistChain;
  }

  /**
   * 删除会话文件
   */
  private async removeSessionFile(chatSessionId: string): Promise<void> {
    try {
      await unlink(join(SESSIONS_DIR, `${chatSessionId}.json`));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.error(`[sessionManager] 删除会话文件 ${chatSessionId} 失败:`, err);
      }
    }
    try {
      await unlink(join(SESSIONS_DIR, `${chatSessionId}.json.tmp`));
    } catch { /* 忽略 */ }
  }

  /**
   * 兼容旧接口：持久化所有会话
   */
  private async persist(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.persistSession(id)));
    await this.persistPinnedSessionOrder();
  }

  /**
   * 启动空闲 Session 清理定时器
   */
  startIdleCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.purgeIdleSessions(), 60_000);
    this.cleanupTimer.unref?.();
  }

  stopIdleCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 移除超过 sessionTimeout 且无 pending 的 Session
   */
  private purgeIdleSessions(): void {
    const now = Date.now();
    const ttl = this.config.sessionTimeout;
    const toRemove: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.hasPending || this.pending.has(id)) continue;
      if (now - s.lastActiveAt > ttl) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.sessions.delete(id);
      this.wsBroadcast({
        type: "session_deleted",
        chatSessionId: id,
      } satisfies WsSessionDeleted);
      void this.removeSessionFile(id);
      this.onSessionDeleted?.(id);
    }
    if (toRemove.length > 0) {
      const nextPinnedSessionIds = normalizePinnedSessionIds(
        this.pinnedSessionIds,
        this.sessions.keys()
      );
      if (!sameSessionIdOrder(this.pinnedSessionIds, nextPinnedSessionIds)) {
        this.pinnedSessionIds = nextPinnedSessionIds;
        this.wsBroadcast({
          type: "pinned_session_order_update",
          pinnedSessionIds: [...this.pinnedSessionIds],
        } satisfies WsPinnedSessionOrderUpdate);
        void this.persistPinnedSessionOrder();
      }
    }
  }

  setShuttingDown(value: boolean): void {
    this.shuttingDown = value;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  getHealthSnapshot(): Pick<
    HealthResponse,
    "activeSessions" | "pendingRequests"
  > {
    return {
      activeSessions: this.sessions.size,
      pendingRequests: this.pending.size,
    };
  }

  getUptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * 供 WebSocket sync：返回当前全量 Session 列表
   */
  listSessionsForSync(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  /** 供终端等子系统按 chatSessionId 查询会话 */
  getSession(chatSessionId: string): SessionInfo | undefined {
    const s = this.sessions.get(chatSessionId);
    return s ? { ...s } : undefined;
  }

  /**
   * 供 WebSocket sync：返回当前会话 pin 顺序
   */
  listPinnedSessionIdsForSync(): string[] {
    return [...this.pinnedSessionIds];
  }

  /**
   * 应用会话列表 pin 顺序（服务端为真源）
   */
  private applyPinnedSessionOrder(pinnedSessionIds: string[]): boolean {
    const next = normalizePinnedSessionIds(pinnedSessionIds, this.sessions.keys());
    if (sameSessionIdOrder(this.pinnedSessionIds, next)) {
      return true;
    }
    this.pinnedSessionIds = next;
    this.wsBroadcast({
      type: "pinned_session_order_update",
      pinnedSessionIds: [...this.pinnedSessionIds],
    } satisfies WsPinnedSessionOrderUpdate);
    void this.persistPinnedSessionOrder();
    return true;
  }

  /**
   * 设置会话列表 pin 顺序（兼容全量更新调用）
   */
  setPinnedSessionOrder(pinnedSessionIds: string[]): boolean {
    return this.applyPinnedSessionOrder(pinnedSessionIds);
  }

  /**
   * 单条设置会话是否 pinned，避免前端并发提交整份列表时互相覆盖
   */
  setSessionPinned(chatSessionId: string, pinned: boolean): boolean {
    if (!this.sessions.has(chatSessionId)) return false;
    const filtered = this.pinnedSessionIds.filter((id) => id !== chatSessionId);
    return this.applyPinnedSessionOrder(
      pinned ? [chatSessionId, ...filtered] : filtered
    );
  }

  /**
   * 处理 Agent 的 POST /super-ask：长连接直到用户回复或客户端断开
   */
  handleAskRequest(
    req: AskRequest,
    httpReq: IncomingMessage,
    httpRes: ServerResponse
  ): Promise<AskResponse> {
    if (this.shuttingDown) {
      this.sendJsonError(
        httpRes,
        503,
        "服务器正在关闭",
        "SERVER_SHUTTING_DOWN"
      );
      return Promise.reject(new Error("SERVER_SHUTTING_DOWN"));
    }

    return new Promise((resolve, reject) => {
      let chatSessionId = req.chatSessionId;
      let isNewSession = false;

      if (!chatSessionId) {
        if (!this.ensureSessionCapacity(httpRes, reject)) {
          return;
        }
        chatSessionId = randomUUID();
        isNewSession = true;
        this.createSession(chatSessionId, req);
      } else {
        const existing = this.sessions.get(chatSessionId);
        if (!existing) {
          if (!this.ensureSessionCapacity(httpRes, reject)) {
            return;
          }
          isNewSession = true;
          this.createSession(chatSessionId, req);
        }
      }

      const session = this.sessions.get(chatSessionId)!;
      session.lastActiveAt = Date.now();

      if (req.source !== undefined) {
        const trimmed = req.source.trim();
        session.source = trimmed || undefined;
      }
      if (req.workspaceRoot !== undefined) {
        const trimmed = req.workspaceRoot.trim();
        session.workspaceRoot = trimmed || undefined;
      }

      let deduplicated = false;
      if (req.requestId) {
        for (let i = session.history.length - 1; i >= 0; i--) {
          const entry = session.history[i];
          if (entry.role === "agent" && entry.requestId === req.requestId) {
            deduplicated = true;
            break;
          }
          if (entry.role === "user") break;
        }
      }

      if (!deduplicated) {
        const agentEntry: HistoryEntry = {
          role: "agent",
          summary: req.summary,
          question: req.question,
          options: req.options,
          timestamp: Date.now(),
          ...(req.requestId ? { requestId: req.requestId } : {}),
        };
        session.history.push(agentEntry);
      }
      session.hasPending = true;
      session.requestStatus = "pending";
      session.title = req.title?.trim() || session.title;

      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const onClose = () => {
        const p = this.pending.get(chatSessionId!);
        if (!p) return;
        this.pending.delete(chatSessionId!);
        p.cleanup();
        const s = this.sessions.get(chatSessionId!);
        if (s) {
          s.hasPending = false;
          s.requestStatus = "cancelled";
        }
        void this.persistSession(chatSessionId!);
        this.wsBroadcast({
          type: "session_update",
          chatSessionId: chatSessionId!,
          status: "cancelled",
        } satisfies WsSessionUpdate);
        if (!httpRes.writableEnded) {
          try { httpRes.end(); } catch { /* 客户端已断开 */ }
        }
        p.reject(new Error("CLIENT_CLOSED"));
      };

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        httpRes.off("close", onClose);
      };

      const prev = this.pending.get(chatSessionId);
      if (prev) {
        prev.cleanup();
        this.pending.delete(chatSessionId);
        if (!prev.httpRes.writableEnded) {
          if (!prev.httpRes.headersSent) {
            prev.httpRes.statusCode = 409;
            prev.httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
          }
          try {
            prev.httpRes.end(
              JSON.stringify({
                error: "同一会话发起了新的提问，当前请求已失效",
                code: "INVALID_REQUEST",
              } satisfies ErrorResponse)
            );
          } catch { /* ignore */ }
        }
        prev.reject(new Error("SUPERSEDED"));
      }

      const pendingEntry: PendingEntry = {
        resolve: (r: AskResponse) => {
          cleanup();
          resolve(r);
        },
        reject: (e: Error) => {
          cleanup();
          reject(e);
        },
        httpRes,
        cleanup,
      };

      this.pending.set(chatSessionId, pendingEntry);
      httpRes.once("close", onClose);

      // 立即发送 HTTP 响应头，防止客户端 headersTimeout（默认 300s）触发。
      // 后续通过心跳空白字符保活，用户回复后 httpRes.end(json) 结束响应。
      // JSON.parse 天然忽略前导空白，客户端无需修改。
      httpRes.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      heartbeatTimer = setInterval(() => {
        if (!httpRes.writableEnded && !httpRes.destroyed) {
          try { httpRes.write(" "); } catch { /* ignore */ }
        }
      }, LONG_POLL_HEARTBEAT_MS);
      heartbeatTimer.unref?.();

      if (!deduplicated) {
        const wsMsg: WsNewRequest = {
          type: "new_request",
          chatSessionId,
          title: session.title,
          summary: req.summary,
          question: req.question,
          options: req.options,
          isNewSession,
          source: session.source,
          workspaceRoot: session.workspaceRoot,
        };
        this.wsBroadcast(wsMsg);
      }

      this.wsBroadcast({
        type: "session_update",
        chatSessionId,
        status: "pending",
      } satisfies WsSessionUpdate);

      void this.persistSession(chatSessionId);
    });
  }

  /**
   * 将 AskResponse 写入 HTTP 响应。
   * 长连接模式下响应头已提前发送（writeHead(200)），仅写入 body。
   */
  private writeAskResponse(httpRes: ServerResponse, body: AskResponse): void {
    if (httpRes.writableEnded) return;
    if (!httpRes.headersSent) {
      httpRes.statusCode = 200;
      httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    httpRes.end(JSON.stringify(body));
  }

  private sendJsonError(
    httpRes: ServerResponse,
    status: number,
    message: string,
    code: ErrorResponse["code"]
  ): void {
    if (httpRes.writableEnded) return;
    if (!httpRes.headersSent) {
      httpRes.statusCode = status;
      httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    // 长连接已发送 200 响应头时无法更改状态码，
    // 但仍需正确结束 chunked 编码，客户端通过 code 字段识别可重试错误。
    try {
      httpRes.end(
        JSON.stringify({ error: message, code } satisfies ErrorResponse)
      );
    } catch { /* 连接可能已被销毁 */ }
  }

  private static readonly REPLY_AGENT_HINT =
    "\n**使用super-ask工具回复我，回复时必须传入上次调用super-ask工具时返回的chatsessionid**";

  /**
   * Web UI 通过 WebSocket 提交用户回复（可选带附件元数据）
   * history 存储干净文本，AI response 中追加 hint 引导 agent 继续使用 super-ask。
   */
  handleReply(
    chatSessionId: string,
    feedback: string,
    attachments?: FileAttachment[],
    displayFeedback?: string
  ): boolean {
    const pending = this.pending.get(chatSessionId);
    const session = this.sessions.get(chatSessionId);

    if (!pending || !session || !session.hasPending) return false;

    this.pending.delete(chatSessionId);
    pending.cleanup();

    const safeAtt =
      attachments && attachments.length > 0
        ? attachments.filter(isValidFileAttachmentRef)
        : undefined;

    const cleanFeedback = (displayFeedback ?? feedback)
      .split(SessionManager.REPLY_AGENT_HINT)
      .join("");
    const rawFeedback = feedback
      .split(SessionManager.REPLY_AGENT_HINT)
      .join("");

    const userEntry: HistoryEntry = {
      role: "user",
      feedback: cleanFeedback,
      timestamp: Date.now(),
      ...(safeAtt && safeAtt.length > 0 ? { attachments: safeAtt } : {}),
    };

    if (session) {
      session.history.push(userEntry);
      session.hasPending = false;
      session.requestStatus = "replied";
      session.lastActiveAt = Date.now();
    }

    const feedbackForAgent = rawFeedback + SessionManager.REPLY_AGENT_HINT;
    const response: AskResponse = {
      chatSessionId,
      feedback: feedbackForAgent,
      ...(safeAtt && safeAtt.length > 0 ? { attachments: safeAtt } : {}),
    };

    this.writeAskResponse(pending.httpRes, response);
    pending.resolve(response);

    this.wsBroadcast({
      type: "session_update",
      chatSessionId,
      status: "replied",
      historyEntry: userEntry,
    } satisfies WsSessionUpdate);

    void this.persistSession(chatSessionId);
    return true;
  }

  /**
   * Agent 确认已收到回复
   */
  ackReply(chatSessionId: string): boolean {
    const session = this.sessions.get(chatSessionId);
    if (!session) return false;
    if (session.requestStatus !== "replied") return false;
    session.requestStatus = "acked";
    session.lastActiveAt = Date.now();
    this.wsBroadcast({
      type: "session_update",
      chatSessionId,
      status: "acked",
    } satisfies WsSessionUpdate);
    void this.persistSession(chatSessionId);
    return true;
  }

  /**
   * Pin 一条消息（添加到 pinnedIndices）
   */
  pinMessage(chatSessionId: string, index: number): boolean {
    const session = this.sessions.get(chatSessionId);
    if (!session) return false;
    if (index < 0 || index >= session.history.length) return false;
    if (!session.pinnedIndices) session.pinnedIndices = [];
    if (session.pinnedIndices.includes(index)) return true;
    session.pinnedIndices.push(index);
    this.wsBroadcast({
      type: "pin_update",
      chatSessionId,
      pinnedIndices: [...session.pinnedIndices],
    } satisfies WsPinUpdate);
    void this.persistSession(chatSessionId);
    return true;
  }

  /**
   * Unpin 一条消息（从 pinnedIndices 移除）
   */
  unpinMessage(chatSessionId: string, index: number): boolean {
    const session = this.sessions.get(chatSessionId);
    if (!session || !session.pinnedIndices) return false;
    const pos = session.pinnedIndices.indexOf(index);
    if (pos === -1) return false;
    session.pinnedIndices.splice(pos, 1);
    this.wsBroadcast({
      type: "pin_update",
      chatSessionId,
      pinnedIndices: [...session.pinnedIndices],
    } satisfies WsPinUpdate);
    void this.persistSession(chatSessionId);
    return true;
  }

  /**
   * 为会话添加自定义标签
   */
  addTag(chatSessionId: string, tag: string): boolean {
    const session = this.sessions.get(chatSessionId);
    if (!session) return false;
    const trimmed = tag.trim();
    if (!trimmed) return false;
    if (!session.tags) session.tags = [];
    if (session.tags.includes(trimmed)) return true;
    session.tags.push(trimmed);
    this.wsBroadcast({
      type: "tag_update",
      chatSessionId,
      tags: [...session.tags],
    } satisfies WsTagUpdate);
    void this.persistSession(chatSessionId);
    return true;
  }

  /**
   * 移除会话的自定义标签
   */
  removeTag(chatSessionId: string, tag: string): boolean {
    const session = this.sessions.get(chatSessionId);
    if (!session || !session.tags) return false;
    const trimmed = tag.trim();
    const pos = session.tags.indexOf(trimmed);
    if (pos === -1) return false;
    session.tags.splice(pos, 1);
    this.wsBroadcast({
      type: "tag_update",
      chatSessionId,
      tags: [...session.tags],
    } satisfies WsTagUpdate);
    void this.persistSession(chatSessionId);
    return true;
  }

  /**
   * 从列表中删除指定 Session（若该 Session 有 pending 请求则先取消）
   */
  deleteSession(chatSessionId: string): boolean {
    const session = this.sessions.get(chatSessionId);
    if (!session) return false;
    const nextPinnedSessionIds = this.pinnedSessionIds.filter((id) => id !== chatSessionId);
    const pinnedChanged = !sameSessionIdOrder(this.pinnedSessionIds, nextPinnedSessionIds);

    const pending = this.pending.get(chatSessionId);
    if (pending) {
      pending.cleanup();
      this.pending.delete(chatSessionId);
      if (!pending.httpRes.writableEnded) {
        if (!pending.httpRes.headersSent) {
          pending.httpRes.statusCode = 410;
          pending.httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
        }
        try {
          pending.httpRes.end(
            JSON.stringify({ error: "会话已被用户删除", code: "SESSION_NOT_FOUND" })
          );
        } catch { /* 连接可能已被销毁 */ }
      }
      pending.reject(new Error("SESSION_DELETED"));
    }

    this.sessions.delete(chatSessionId);
    if (pinnedChanged) {
      this.pinnedSessionIds = nextPinnedSessionIds;
    }

    this.wsBroadcast({
      type: "session_deleted",
      chatSessionId,
    } satisfies WsSessionDeleted);
    if (pinnedChanged) {
      this.wsBroadcast({
        type: "pinned_session_order_update",
        pinnedSessionIds: [...this.pinnedSessionIds],
      } satisfies WsPinnedSessionOrderUpdate);
      void this.persistPinnedSessionOrder();
    }

    void this.removeSessionFile(chatSessionId);
    this.onSessionDeleted?.(chatSessionId);
    return true;
  }

  /**
   * 优雅关闭：拒绝新请求、断开 pending 的 Agent 连接
   */
  async shutdownNotifyAgents(): Promise<void> {
    this.shuttingDown = true;
    const pendingIds = new Set<string>();
    for (const [id, p] of this.pending) {
      pendingIds.add(id);
      p.cleanup();
      this.sendJsonError(
        p.httpRes,
        503,
        "服务器正在关闭",
        "SERVER_SHUTTING_DOWN"
      );
      p.reject(new Error("SERVER_SHUTTING_DOWN"));
    }
    this.pending.clear();
    for (const s of this.sessions.values()) {
      s.hasPending = false;
      if (pendingIds.has(s.chatSessionId) || s.requestStatus === "pending") {
        s.requestStatus = "cancelled";
      }
    }
    await this.persist();
  }
}
