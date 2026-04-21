import { useCallback, useMemo, useRef, useState } from "react";
import type { SessionInfo, WsServerMessage } from "@shared/types";
import { withAuthHeaders } from "../auth";

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
function pendingFromStatus(status: "pending" | "cancelled" | "replied" | "acked"): boolean {
  return status === "pending";
}

/**
 * 会话列表、当前选中 Tab、以及处理服务端 WebSocket 消息的 reducer 逻辑。
 */
const ACTIVE_SESSION_KEY = "super-ask:activeSessionId";
const PINNED_SESSION_ORDER_KEY = "super-ask:pinnedSessionOrder";

function readPinnedSessionOrder(): string[] {
  const raw = localStorage.getItem(PINNED_SESSION_ORDER_KEY);
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  } catch {
    return [];
  }
}

function persistPinnedSessionOrder(pinnedSessionIds: string[]): void {
  if (pinnedSessionIds.length > 0) {
    localStorage.setItem(PINNED_SESSION_ORDER_KEY, JSON.stringify(pinnedSessionIds));
  } else {
    localStorage.removeItem(PINNED_SESSION_ORDER_KEY);
  }
}

function sameSessionIdOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function prunePinnedSessionOrder(pinnedSessionIds: string[], sessionIds: Iterable<string>): string[] {
  const existingIds = new Set(sessionIds);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of pinnedSessionIds) {
    const chatSessionId = raw.trim();
    if (!chatSessionId || seen.has(chatSessionId) || !existingIds.has(chatSessionId)) {
      continue;
    }
    seen.add(chatSessionId);
    next.push(chatSessionId);
  }
  return next;
}

export function togglePinnedSessionOrder(pinnedSessionIds: string[], chatSessionId: string): string[] {
  const filtered = pinnedSessionIds.filter((id) => id !== chatSessionId);
  if (filtered.length !== pinnedSessionIds.length) {
    return filtered;
  }
  return [chatSessionId, ...filtered];
}

export function resolvePinnedSessionOrderFromSync(
  serverPinnedSessionIds: string[] | undefined,
  localPinnedSessionIds: string[],
  sessionIds: Iterable<string>,
): string[] {
  return prunePinnedSessionOrder(
    Array.isArray(serverPinnedSessionIds) ? serverPinnedSessionIds : localPinnedSessionIds,
    sessionIds,
  );
}

export function sortSessionsForSidebar(sessions: SessionInfo[], pinnedSessionIds: string[]): SessionInfo[] {
  const pinOrder = new Map(
    prunePinnedSessionOrder(pinnedSessionIds, sessions.map((session) => session.chatSessionId))
      .map((chatSessionId, index) => [chatSessionId, index]),
  );

  return [...sessions].sort((left, right) => {
    const leftPinOrder = pinOrder.get(left.chatSessionId);
    const rightPinOrder = pinOrder.get(right.chatSessionId);

    if (leftPinOrder !== undefined && rightPinOrder !== undefined) {
      return leftPinOrder - rightPinOrder;
    }
    if (leftPinOrder !== undefined) return -1;
    if (rightPinOrder !== undefined) return 1;
    return right.lastActiveAt - left.lastActiveAt;
  });
}

export function useSessions() {
  const [sessions, setSessions] = useState<Map<string, SessionInfo>>(() => new Map());
  const [activeSessionId, _setActiveSessionId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_SESSION_KEY),
  );
  const [pinnedSessionIds, _setPinnedSessionIds] = useState<string[]>(() => readPinnedSessionOrder());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const pinnedSessionIdsRef = useRef(pinnedSessionIds);
  pinnedSessionIdsRef.current = pinnedSessionIds;

  const setActiveSessionId = useCallback((updater: string | null | ((prev: string | null) => string | null)) => {
    _setActiveSessionId((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next) localStorage.setItem(ACTIVE_SESSION_KEY, next);
      else localStorage.removeItem(ACTIVE_SESSION_KEY);
      return next;
    });
  }, []);

  const setPinnedSessionIds = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    _setPinnedSessionIds((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (sameSessionIdOrder(prev, next)) {
        return prev;
      }
      persistPinnedSessionOrder(next);
      return next;
    });
  }, []);

  const syncPinnedSessionToggle = useCallback(async (chatSessionId: string, pinned: boolean) => {
    try {
      const resp = await fetch("/api/pinned-sessions", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chatSessionId, pinned }),
      });
      if (!resp.ok) {
        console.warn("[session-pin] sync failed:", resp.status);
        return;
      }
      const data = await resp.json() as { pinnedSessionIds?: unknown };
      if (Array.isArray(data.pinnedSessionIds)) {
        setPinnedSessionIds(
          prunePinnedSessionOrder(
            data.pinnedSessionIds.filter((item): item is string => typeof item === "string"),
            sessionsRef.current.keys(),
          ),
        );
        return;
      }
    } catch (e) {
      console.warn("[session-pin] sync failed:", e);
    }
  }, [setPinnedSessionIds]);

  const handleServerMessage = useCallback((msg: WsServerMessage) => {
    const now = Date.now();

    if (msg.type === "sync") {
      const next = sessionsMapFromSync(msg.sessions);
      for (const [, s] of next) {
        if (!s.requestStatus) {
          s.requestStatus = s.hasPending ? "pending" : "replied";
        }
      }
      const nextPinnedSessionIds = resolvePinnedSessionOrderFromSync(
        msg.pinnedSessionIds,
        pinnedSessionIdsRef.current,
        next.keys(),
      );
      setPinnedSessionIds(nextPinnedSessionIds);
      setSessions(next);
      setActiveSessionId((prev) => {
        if (prev && next.has(prev)) return prev;
        const first = sortSessionsForSidebar([...next.values()], nextPinnedSessionIds)[0];
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
          ...(typeof msg.requestId === "string" && msg.requestId
            ? { requestId: msg.requestId }
            : {}),
        };

        // 基于 requestId 去重：若同 requestId 的 agent 历史项已存在且其后无用户回复，
        // 视为"同一请求重新挂上长连接"（CLI 重试或服务端重启后恢复），
        // 只刷新会话状态，不追加历史项，避免出现重复的 agent 消息。
        let shouldAppendAgentEntry = true;
        if (existing && msg.requestId) {
          for (let i = existing.history.length - 1; i >= 0; i -= 1) {
            const entry = existing.history[i];
            if (entry.role === "agent" && entry.requestId === msg.requestId) {
              shouldAppendAgentEntry = false;
              break;
            }
            if (entry.role === "user") break;
          }
        }

        if (existing) {
          next.set(msg.chatSessionId, {
            ...existing,
            title: msg.title || existing.title,
            history: shouldAppendAgentEntry
              ? [...existing.history, agentEntry]
              : existing.history,
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

    if (msg.type === "pinned_session_order_update") {
      setPinnedSessionIds(prunePinnedSessionOrder(msg.pinnedSessionIds, sessionsRef.current.keys()));
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

    if (msg.type === "session_title_update") {
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.chatSessionId);
        if (!existing) return prev;
        next.set(msg.chatSessionId, {
          ...existing,
          title: msg.title,
        });
        return next;
      });
      return;
    }

    if (msg.type === "auto_reply_update") {
      setSessions((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.chatSessionId);
        if (!existing) return prev;
        next.set(msg.chatSessionId, {
          ...existing,
          autoReplyTemplateId: msg.autoReplyTemplateId,
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
      setPinnedSessionIds((prev) => prev.filter((chatSessionId) => chatSessionId !== msg.chatSessionId));
      setActiveSessionId((prev) => {
        if (prev !== msg.chatSessionId) return prev;
        return null;
      });
    }
  }, [setActiveSessionId, setPinnedSessionIds]);

  const setActiveSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, [setActiveSessionId]);

  const togglePinnedSession = useCallback((chatSessionId: string) => {
    const pinned = !pinnedSessionIdsRef.current.includes(chatSessionId);
    void syncPinnedSessionToggle(chatSessionId, pinned);
  }, [syncPinnedSessionToggle]);

  const reorderPinnedSessions = useCallback(async (newOrder: string[]) => {
    setPinnedSessionIds(newOrder);
    try {
      const resp = await fetch("/api/pinned-sessions", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ pinnedSessionIds: newOrder }),
      });
      if (!resp.ok) {
        console.warn("[session-pin] reorder sync failed:", resp.status);
      }
    } catch (e) {
      console.warn("[session-pin] reorder sync failed:", e);
    }
  }, [setPinnedSessionIds]);

  const sortedSessions = useMemo(() => {
    return sortSessionsForSidebar([...sessions.values()], pinnedSessionIds);
  }, [pinnedSessionIds, sessions]);

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

  return {
    sessions,
    sessionsRef,
    sortedSessions,
    pinnedSessionIds,
    activeSessionId,
    activeSession,
    setActiveSession,
    togglePinnedSession,
    reorderPinnedSessions,
    handleServerMessage,
    activeCount,
    pendingCount,
  };
}
