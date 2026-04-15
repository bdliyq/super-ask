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
  WsTagUpdate,
  WsServerMessage,
  SuperAskConfig,
} from "../../shared/types";
import { SUPER_ASK_DIR, ensureSuperAskDir } from "./config";

/** 向 Web UI 广播（由 WsHub 实现） */
export type WsBroadcast = (msg: WsServerMessage) => void;

const SESSIONS_DIR = join(SUPER_ASK_DIR, "sessions");
const LEGACY_SESSIONS_PATH = join(SUPER_ASK_DIR, "sessions.json");

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
  private pending = new Map<string, PendingEntry>();
  private pollReplies = new Map<string, AskResponse>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private startedAt = Date.now();

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
      return;
    }

    try {
      const raw = (await readFile(LEGACY_SESSIONS_PATH, "utf-8")).trim();
      if (!raw) return;
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
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
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
      void this.removeSessionFile(id);
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
        if (this.sessions.size >= this.config.maxSessions) {
          this.sendJsonError(
            httpRes,
            503,
            "Session 数量已达上限",
            "INVALID_REQUEST"
          );
          reject(new Error("MAX_SESSIONS"));
          return;
        }
        chatSessionId = randomUUID();
        isNewSession = true;
        const title = req.title?.trim() || "新对话";
        const now = Date.now();
        this.sessions.set(chatSessionId, {
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
        });
      } else {
        const existing = this.sessions.get(chatSessionId);
        if (!existing) {
          this.sendJsonError(
            httpRes,
            404,
            "Session 不存在",
            "SESSION_NOT_FOUND"
          );
          reject(new Error("SESSION_NOT_FOUND"));
          return;
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

      const agentEntry: HistoryEntry = {
        role: "agent",
        summary: req.summary,
        question: req.question,
        options: req.options,
        timestamp: Date.now(),
      };
      session.history.push(agentEntry);
      session.hasPending = true;
      // 与 WebSocket session_update 一致，供 UI 展示当前长连接状态
      session.requestStatus = "pending";
      session.title = req.title?.trim() || session.title;

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
          httpRes.statusCode = 499;
          httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
          httpRes.end(
            JSON.stringify({
              error: "客户端已断开连接",
              code: "INVALID_REQUEST",
            } satisfies ErrorResponse)
          );
        }
        p.reject(new Error("CLIENT_CLOSED"));
      };

      const cleanup = () => {
        httpReq.off("close", onClose);
      };

      httpReq.once("close", onClose);

      const prev = this.pending.get(chatSessionId);
      if (prev) {
        prev.cleanup();
        this.pending.delete(chatSessionId);
        if (!prev.httpRes.writableEnded) {
          prev.httpRes.statusCode = 409;
          prev.httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
          prev.httpRes.end(
            JSON.stringify({
              error: "同一会话发起了新的提问，当前请求已失效",
              code: "INVALID_REQUEST",
            } satisfies ErrorResponse)
          );
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

      this.wsBroadcast({
        type: "session_update",
        chatSessionId,
        status: "pending",
      } satisfies WsSessionUpdate);

      void this.persistSession(chatSessionId);
    });
  }

  /**
   * 处理 noWait 模式的 POST /super-ask：立即返回，不阻塞
   */
  handleNoWaitRequest(req: AskRequest, httpRes: ServerResponse): void {
    if (this.shuttingDown) {
      this.sendJsonError(httpRes, 503, "服务器正在关闭", "SERVER_SHUTTING_DOWN");
      return;
    }

    let chatSessionId = req.chatSessionId;
    let isNewSession = false;

    if (!chatSessionId) {
      if (this.sessions.size >= this.config.maxSessions) {
        this.sendJsonError(httpRes, 503, "Session 数量已达上限", "INVALID_REQUEST");
        return;
      }
      chatSessionId = randomUUID();
      isNewSession = true;
      const title = req.title?.trim() || "新对话";
      const now = Date.now();
      this.sessions.set(chatSessionId, {
        chatSessionId,
        title,
        history: [],
        hasPending: false,
        createdAt: now,
        lastActiveAt: now,
        ...(req.source !== undefined ? { source: req.source.trim() || undefined } : {}),
        ...(req.workspaceRoot !== undefined ? { workspaceRoot: req.workspaceRoot.trim() || undefined } : {}),
      });
    } else {
      const existing = this.sessions.get(chatSessionId);
      if (!existing) {
        this.sendJsonError(httpRes, 404, "Session 不存在", "SESSION_NOT_FOUND");
        return;
      }
    }

    const session = this.sessions.get(chatSessionId)!;
    session.lastActiveAt = Date.now();
    if (req.source !== undefined) session.source = req.source.trim() || undefined;
    if (req.workspaceRoot !== undefined) session.workspaceRoot = req.workspaceRoot.trim() || undefined;

    const agentEntry: HistoryEntry = {
      role: "agent",
      summary: req.summary,
      question: req.question,
      options: req.options,
      timestamp: Date.now(),
    };
    session.history.push(agentEntry);
    session.hasPending = true;
    session.requestStatus = "pending";
    session.title = req.title?.trim() || session.title;

    this.pollReplies.delete(chatSessionId);

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
    this.wsBroadcast({
      type: "session_update",
      chatSessionId,
      status: "pending",
    } satisfies WsSessionUpdate);

    void this.persistSession(chatSessionId);

    httpRes.statusCode = 200;
    httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
    httpRes.end(JSON.stringify({ chatSessionId, status: "pending" }));
  }

  /**
   * 轮询检查是否有回复
   */
  pollReply(chatSessionId: string): { status: "pending" | "replied" | "not_found"; chatSessionId: string; feedback?: string; attachments?: FileAttachment[] } {
    const reply = this.pollReplies.get(chatSessionId);
    if (reply) {
      this.pollReplies.delete(chatSessionId);
      return { status: "replied", chatSessionId, feedback: reply.feedback, attachments: reply.attachments };
    }
    const session = this.sessions.get(chatSessionId);
    if (!session) return { status: "not_found", chatSessionId };
    if (session.hasPending) return { status: "pending", chatSessionId };
    return { status: "not_found", chatSessionId };
  }

  /**
   * 将 AskResponse 写入 HTTP 响应
   */
  private writeAskResponse(httpRes: ServerResponse, body: AskResponse): void {
    if (httpRes.writableEnded) return;
    httpRes.statusCode = 200;
    httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
    httpRes.end(JSON.stringify(body));
  }

  private sendJsonError(
    httpRes: ServerResponse,
    status: number,
    message: string,
    code: ErrorResponse["code"]
  ): void {
    if (httpRes.writableEnded) return;
    httpRes.statusCode = status;
    httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
    httpRes.end(
      JSON.stringify({ error: message, code } satisfies ErrorResponse)
    );
  }

  private static readonly REPLY_AGENT_HINT = "\n**使用 `super-ask` 工具回复我**";

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

    if (!pending && !(session?.hasPending)) return false;

    if (pending) {
      this.pending.delete(chatSessionId);
      pending.cleanup();
    }

    const safeAtt =
      attachments && attachments.length > 0
        ? attachments.filter(isValidFileAttachmentRef)
        : undefined;

    const cleanFeedback = (displayFeedback ?? feedback).replace(SessionManager.REPLY_AGENT_HINT, "");
    const rawFeedback = feedback.replace(SessionManager.REPLY_AGENT_HINT, "");

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

    if (pending) {
      this.writeAskResponse(pending.httpRes, response);
      pending.resolve(response);
    } else {
      this.pollReplies.set(chatSessionId, response);
    }

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

    const pending = this.pending.get(chatSessionId);
    if (pending) {
      pending.cleanup();
      this.pending.delete(chatSessionId);
      if (!pending.httpRes.writableEnded) {
        pending.httpRes.statusCode = 410;
        pending.httpRes.setHeader("Content-Type", "application/json; charset=utf-8");
        pending.httpRes.end(
          JSON.stringify({ error: "会话已被用户删除", code: "SESSION_NOT_FOUND" })
        );
      }
      pending.reject(new Error("SESSION_DELETED"));
    }

    this.sessions.delete(chatSessionId);

    this.wsBroadcast({
      type: "session_deleted",
      chatSessionId,
    } satisfies WsSessionDeleted);

    void this.removeSessionFile(chatSessionId);
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
