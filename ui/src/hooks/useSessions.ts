import { useCallback, useMemo, useRef, useState } from "react";
import type { FileAttachment, SessionInfo, WsServerMessage } from "@shared/types";

function sessionsMapFromSync(list: SessionInfo[]): Map<string, SessionInfo> {
  const m = new Map<string, SessionInfo>();
  for (const s of list) {
    m.set(s.chatSessionId, s);
  }
  return m;
}

/**
 * 根据 session_update 的 status 推导是否仍有待处理请求。
 */
function pendingFromStatus(status: "pending" | "cancelled" | "replied"): boolean {
  return status === "pending";
}

/**
 * 会话列表、当前选中 Tab、以及处理服务端 WebSocket 消息的 reducer 逻辑。
 */
const ACTIVE_SESSION_KEY = "super-ask:activeSessionId";

export function useSessions() {
  const [sessions, setSessions] = useState<Map<string, SessionInfo>>(() => new Map());
  const [activeSessionId, _setActiveSessionId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_SESSION_KEY),
  );

  const setActiveSessionId = useCallback((updater: string | null | ((prev: string | null) => string | null)) => {
    _setActiveSessionId((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next) localStorage.setItem(ACTIVE_SESSION_KEY, next);
      else localStorage.removeItem(ACTIVE_SESSION_KEY);
      return next;
    });
  }, []);

  const handleServerMessage = useCallback((msg: WsServerMessage) => {
    const now = Date.now();

    if (msg.type === "sync") {
      const next = sessionsMapFromSync(msg.sessions);
      for (const [, s] of next) {
        if (!s.requestStatus) {
          s.requestStatus = s.hasPending ? "pending" : "replied";
        }
      }
      setSessions(next);
      setActiveSessionId((prev) => {
        if (prev && next.has(prev)) return prev;
        const first = [...next.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        return first?.chatSessionId ?? null;
      });
      return;
    }

    if (msg.type === "new_request") {
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.chatSessionId);
        const agentEntry = {
          role: "agent" as const,
          summary: msg.summary,
          question: msg.question,
          options: msg.options,
          timestamp: now,
        };

        if (existing) {
          next.set(msg.chatSessionId, {
            ...existing,
            title: msg.title || existing.title,
            history: [...existing.history, agentEntry],
            hasPending: true,
            requestStatus: "pending",
            ...(typeof msg.source === "string"
              ? { source: msg.source.trim() || undefined }
              : {}),
            ...(typeof msg.workspaceRoot === "string"
              ? { workspaceRoot: msg.workspaceRoot.trim() || undefined }
              : {}),
            lastActiveAt: now,
          });
        } else {
          next.set(msg.chatSessionId, {
            chatSessionId: msg.chatSessionId,
            title: msg.title,
            history: [agentEntry],
            hasPending: true,
            requestStatus: "pending",
            ...(typeof msg.source === "string"
              ? { source: msg.source.trim() || undefined }
              : {}),
            ...(typeof msg.workspaceRoot === "string"
              ? { workspaceRoot: msg.workspaceRoot.trim() || undefined }
              : {}),
            createdAt: now,
            lastActiveAt: now,
          });
        }
        return next;
      });
      setActiveSessionId((prev) => prev ?? msg.chatSessionId);
      return;
    }

    if (msg.type === "session_update") {
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.chatSessionId);
        if (!existing) return prev;

        let history = existing.history;
        if (msg.historyEntry) {
          const dup = history.some(
            (h) =>
              h.role === msg.historyEntry!.role &&
              h.timestamp === msg.historyEntry!.timestamp
          );
          if (!dup) {
            history = [...history, msg.historyEntry];
          }
        }

        next.set(msg.chatSessionId, {
          ...existing,
          history,
          hasPending: pendingFromStatus(msg.status),
          requestStatus: msg.status,
          lastActiveAt: now,
        });
        return next;
      });
      return;
    }

    if (msg.type === "pin_update") {
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.chatSessionId);
        if (!existing) return prev;
        next.set(msg.chatSessionId, {
          ...existing,
          pinnedIndices: msg.pinnedIndices,
        });
        return next;
      });
      return;
    }

    if (msg.type === "tag_update") {
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.chatSessionId);
        if (!existing) return prev;
        next.set(msg.chatSessionId, {
          ...existing,
          tags: msg.tags,
        });
        return next;
      });
      return;
    }

    if (msg.type === "session_deleted") {
      setSessions((prev) => {
        const next = new Map(prev);
        next.delete(msg.chatSessionId);
        return next;
      });
      setActiveSessionId((prev) => {
        if (prev !== msg.chatSessionId) return prev;
        return null;
      });
    }
  }, []);

  const setActiveSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, [setActiveSessionId]);

  /**
   * 用户通过 WebSocket 发送回复后，乐观追加一条 user 历史记录并清除 pending（服务端 session_update 可再次校正）。
   */
  const appendUserReply = useCallback(
    (chatSessionId: string, feedback: string, attachments?: FileAttachment[]) => {
      const ts = Date.now();
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(chatSessionId);
        if (!existing) return prev;
        next.set(chatSessionId, {
          ...existing,
          history: [
            ...existing.history,
            {
              role: "user" as const,
              feedback,
              timestamp: ts,
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            },
          ],
          hasPending: false,
          requestStatus: "replied",
          lastActiveAt: ts,
        });
        return next;
      });
    },
    []
  );

  const sortedSessions = useMemo(() => {
    return [...sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [sessions]);

  const activeSession = useMemo(() => {
    if (!activeSessionId) return undefined;
    return sessions.get(activeSessionId);
  }, [sessions, activeSessionId]);

  const activeCount = sessions.size;
  const pendingCount = useMemo(() => {
    let n = 0;
    for (const s of sessions.values()) {
      if (s.hasPending) n += 1;
    }
    return n;
  }, [sessions]);

  // 与 state 同步，供异步回调读取最新会话映射，避免闭包陈旧
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  return {
    sessions,
    sessionsRef,
    sortedSessions,
    activeSessionId,
    activeSession,
    setActiveSession,
    handleServerMessage,
    appendUserReply,
    activeCount,
    pendingCount,
  };
}
