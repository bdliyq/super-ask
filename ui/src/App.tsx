import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChatView } from "./components/ChatView";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { SettingsPanel } from "./components/SettingsPanel";
import { SessionTabs } from "./components/SessionTabs";
import { StatusBar } from "./components/StatusBar";
import type { AutoReplyTemplate, FileAttachment, ReadFileResponse, WsServerMessage } from "@shared/types";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useI18n } from "./i18n";
import type { QuotedRef } from "./components/InteractionCard";
import {
  emitPredefinedMsgsSync,
  getActivePredefinedSuffix,
  isNotificationEnabled,
  loadAutoReplyTemplates,
  loadPredefinedMsgs,
} from "./components/SystemSettings";
import { withAuthHeaders } from "./auth";
import { startBodyResizeSession } from "./utils/bodyResizeSession";

const THEME_STORAGE_KEY = "super-ask-theme";
const PANEL_WIDTH_KEY = "super-ask-panel-width";
const PANEL_VISIBLE_KEY = "super-ask-panel-visible";
const QUEUE_STORAGE_KEY = "super-ask-queue";
const VIEW_STORAGE_KEY = "super-ask-view";
const DEFAULT_PANEL_WIDTH = 250;
const MIN_PANEL_WIDTH = 160;
const MAX_PANEL_WIDTH = 500;

export function resolveInitialView(stored: string | null): "chat" | "settings" {
  return stored === "settings" ? "settings" : "chat";
}

export default function App() {
  const { t, locale } = useI18n();
  const [view, setView] = useState<"chat" | "settings">(() =>
    resolveInitialView(localStorage.getItem(VIEW_STORAGE_KEY)),
  );

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as "light" | "dark" | null;
    return stored === "dark" ? "dark" : "light";
  });

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = localStorage.getItem(PANEL_WIDTH_KEY);
    const n = stored ? Number(stored) : NaN;
    return Number.isFinite(n) && n >= MIN_PANEL_WIDTH && n <= MAX_PANEL_WIDTH
      ? n
      : DEFAULT_PANEL_WIDTH;
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    document.documentElement.style.setProperty("--tab-width", `${panelWidth}px`);
  }, [panelWidth]);

  const [panelVisible, setPanelVisible] = useState<boolean>(() => {
    return localStorage.getItem(PANEL_VISIBLE_KEY) !== "false";
  });

  const [terminalOpenMap, setTerminalOpenMap] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("super-ask-terminal-open-map");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  const [showPinPanel, setShowPinPanel] = useState(false);
  const [autoReplyTemplates, setAutoReplyTemplates] = useState<AutoReplyTemplate[]>([]);
  const [sessionFileMap, setSessionFileMap] = useState<Record<string, ReadFileResponse>>({});
  const [sessionFileOpen, setSessionFileOpen] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("super-ask-docs-open-map");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [sessionFilePathMap, setSessionFilePathMap] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("super-ask-docs-path-map");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  useEffect(() => {
    localStorage.setItem(PANEL_VISIBLE_KEY, String(panelVisible));
  }, [panelVisible]);

  useEffect(() => {
    localStorage.setItem("super-ask-terminal-open-map", JSON.stringify(terminalOpenMap));
  }, [terminalOpenMap]);

  useEffect(() => {
    localStorage.setItem("super-ask-docs-open-map", JSON.stringify(sessionFileOpen));
  }, [sessionFileOpen]);

  useEffect(() => {
    localStorage.setItem("super-ask-docs-path-map", JSON.stringify(sessionFilePathMap));
  }, [sessionFilePathMap]);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  useEffect(() => {
    void loadAutoReplyTemplates().then(setAutoReplyTemplates);
  }, []);

  const handleSetAutoReply = useCallback(async (chatSessionId: string, templateId: string | null) => {
    try {
      await fetch("/api/auto-reply", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chatSessionId, templateId }),
      });
    } catch (e) {
      console.warn("[auto-reply] set failed:", e);
    }
  }, []);

  const handleSetSessionTitle = useCallback(async (chatSessionId: string, title: string) => {
    try {
      const resp = await fetch("/api/session-title", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chatSessionId, title }),
      });
      if (!resp.ok) {
        console.warn("[session-title] set failed:", resp.status);
        return false;
      }
      return true;
    } catch (e) {
      console.warn("[session-title] set failed:", e);
      return false;
    }
  }, []);

  const togglePanel = useCallback(() => {
    setPanelVisible((v) => !v);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }, []);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(DEFAULT_PANEL_WIDTH);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
  }, []);

  const onResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    resizeCleanupRef.current?.();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = panelWidth;

    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startW.current + delta));
      setPanelWidth(next);
    };

    resizeCleanupRef.current = startBodyResizeSession({
      onMove,
      onEnd: () => {
        dragging.current = false;
        resizeCleanupRef.current = null;
      },
    });
  }, [panelWidth]);

  const {
    sortedSessions,
    pinnedSessionIds,
    activeSessionId,
    activeSession,
    sessionsRef,
    setActiveSession,
    togglePinnedSession,
    reorderPinnedSessions,
    handleServerMessage,
    activeCount,
    pendingCount,
  } = useSessions();

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    setShowPinPanel(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (sessionFileMap[activeSessionId]) return;
    const storedPath = sessionFilePathMap[activeSessionId];
    if (!storedPath) return;
    if (!sessionFileOpen[activeSessionId]) return;
    const params = new URLSearchParams({ path: storedPath });
    if (activeSession?.workspaceRoot) params.set("workspaceRoot", activeSession.workspaceRoot);
    let cancelled = false;
    fetch(`/api/read-file?${params}`, { headers: withAuthHeaders() })
      .then(res => res.ok ? res.json() : null)
      .then((data: ReadFileResponse | null) => {
        if (cancelled || !data || data.isBinary) return;
        setSessionFileMap(prev => ({ ...prev, [activeSessionId]: data }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeSessionId, activeSession?.workspaceRoot, sessionFileMap, sessionFilePathMap, sessionFileOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === ".") {
        e.preventDefault();
        const sid = activeSessionIdRef.current;
        if (sid) {
          setTerminalOpenMap((m) => ({ ...m, [sid]: !m[sid] }));
        }
      } else if (e.key === "/") {
        e.preventDefault();
        setPanelVisible((v) => !v);
      } else if (e.key === "'") {
        e.preventDefault();
        toggleDocsRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  interface QueuedReply { text: string; displayText: string; attachments?: FileAttachment[] }

  function loadQueueFromStorage(): Map<string, QueuedReply[]> {
    try {
      const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw) as Record<string, QueuedReply[]>;
      return new Map(Object.entries(obj));
    } catch { return new Map(); }
  }
  function saveQueueToStorage(map: Map<string, QueuedReply[]>) {
    if (map.size === 0) {
      localStorage.removeItem(QUEUE_STORAGE_KEY);
    } else {
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    }
  }

  const replyQueueRef = useRef<Map<string, QueuedReply[]>>(loadQueueFromStorage());
  const [queuedMessages, setQueuedMessages] = useState<Map<string, QueuedReply[]>>(() => loadQueueFromStorage());
  const [quotedRefsBySession, setQuotedRefsBySession] = useState<Record<string, QuotedRef[]>>({});

  const syncQueueState = useCallback(() => {
    const next = new Map(replyQueueRef.current);
    setQueuedMessages(next);
    saveQueueToStorage(next);
  }, []);

  useEffect(() => {
    setQuotedRefsBySession((prev) => {
      const existingSessionIds = new Set(sortedSessions.map((session) => session.chatSessionId));
      let changed = false;
      const next: Record<string, QuotedRef[]> = {};
      for (const [chatSessionId, refs] of Object.entries(prev)) {
        if (existingSessionIds.has(chatSessionId)) {
          next[chatSessionId] = refs;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sortedSessions]);

  const sendReplyRef = useRef<typeof sendReply>(null!);

  const getReplyErrorMessage = useCallback((code?: "not_pending" | "socket_unavailable" | "timeout") => {
    if (code === "not_pending") return t.replyRequestExpired;
    if (code === "timeout") return t.replyConfirmTimeout;
    return t.replySocketUnavailable;
  }, [t]);

  const handleServerMessageWithQueue = useCallback((msg: WsServerMessage) => {
    if (msg.type === "predefined_msgs_sync") {
      emitPredefinedMsgsSync(msg.messages);
      return;
    }
    handleServerMessage(msg);
    if (msg.type === "sync") {
      void loadPredefinedMsgs().then((msgs) => emitPredefinedMsgsSync(msgs));
    }
    if (msg.type === "new_request") {
      try {
        // resumed=true 表示同一 requestId 的 hook 重新挂上长连接（CLI 重试
        // 或服务端重启后恢复），此时不再弹系统通知，以免用户反复被打扰；
        // UI 内部仍然会通过 useSessions 激活该会话并恢复 pending 状态。
        if (
          !msg.resumed &&
          isNotificationEnabled() &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          const rawTitle = msg.title || "Super Ask";
          const title = `[来自 Super Ask] ${rawTitle}`;
          const body = msg.question || msg.summary || "";
          const notif = new Notification(title, {
            body: body.length > 200 ? body.slice(0, 200) + "…" : body,
            tag: msg.chatSessionId,
            icon: "/logo.png",
          });
          const sid = msg.chatSessionId;
          notif.onclick = () => {
            window.focus();
            setView("chat");
            setActiveSession(sid);
            notif.close();
          };
        }
      } catch (e) {
        console.warn("[super-ask] notification failed:", e);
      }

      const queue = replyQueueRef.current.get(msg.chatSessionId);
      if (queue && queue.length > 0) {
        const first = queue.shift()!;
        if (queue.length === 0) {
          replyQueueRef.current.delete(msg.chatSessionId);
        }
        syncQueueState();
        setTimeout(() => {
          void sendReplyRef
            .current(msg.chatSessionId, first.text, first.attachments, first.displayText)
            .then((result) => {
              if (result.accepted) return;
              const existing = replyQueueRef.current.get(msg.chatSessionId) || [];
              existing.unshift(first);
              replyQueueRef.current.set(msg.chatSessionId, existing);
              syncQueueState();
            });
        }, 100);
      } else {
        const session = sessionsRef.current.get(msg.chatSessionId);
        if (session?.autoReplyTemplateId) {
          const tid = session.autoReplyTemplateId;
          setTimeout(() => {
            void (async () => {
              const templates = await loadAutoReplyTemplates();
              const tpl = templates.find((t) => t.id === tid);
              const rawText = tpl?.text?.trim() || "继续";
              const suffix = await getActivePredefinedSuffix();
              const fullText = rawText + suffix;
              void sendReplyRef.current(msg.chatSessionId, fullText, undefined, rawText);
            })();
          }, 300);
        }
      }
    }
  }, [handleServerMessage, syncQueueState]);

  const { connected, sendReply, sendDeleteSession } = useWebSocket({
    onMessage: handleServerMessageWithQueue,
  });

  sendReplyRef.current = sendReply;

  const onSendReply = useCallback(
    async (chatSessionId: string, feedback: string, attachments?: FileAttachment[]) => {
      const suffix = await getActivePredefinedSuffix();
      const feedbackWithSuffix = feedback + suffix;
      const session = sessionsRef.current.get(chatSessionId);
      if (session?.hasPending) {
        const result = await sendReply(chatSessionId, feedbackWithSuffix, attachments, feedback);
        if (!result.accepted) {
          throw new Error(getReplyErrorMessage(result.code));
        }
        return;
      }

      const existing = replyQueueRef.current.get(chatSessionId) || [];
      existing.push({ text: feedbackWithSuffix, displayText: feedback, attachments });
      replyQueueRef.current.set(chatSessionId, existing);
      syncQueueState();
    },
    [getReplyErrorMessage, sendReply, sessionsRef, syncQueueState],
  );

  const onRemoveQueuedReply = useCallback(
    (chatSessionId: string, index: number) => {
      const queue = replyQueueRef.current.get(chatSessionId);
      if (!queue) return;
      queue.splice(index, 1);
      if (queue.length === 0) {
        replyQueueRef.current.delete(chatSessionId);
      }
      syncQueueState();
    },
    [syncQueueState],
  );

  const handleSessionSelect = useCallback(
    (id: string) => {
      setActiveSession(id);
      setView("chat");
    },
    [setActiveSession],
  );

  const handleDeleteSession = useCallback(
    (id: string) => {
      sendDeleteSession(id);
    },
    [sendDeleteSession],
  );

  const appendQuotedRefForSession = useCallback((chatSessionId: string, ref: QuotedRef) => {
    setQuotedRefsBySession((prev) => ({
      ...prev,
      [chatSessionId]: [...(prev[chatSessionId] ?? []), ref],
    }));
  }, []);

  const removeQuotedRefForSession = useCallback((chatSessionId: string, index: number) => {
    setQuotedRefsBySession((prev) => ({
      ...prev,
      [chatSessionId]: (prev[chatSessionId] ?? []).filter((_, itemIndex) => itemIndex !== index),
    }));
  }, []);

  const clearQuotedRefsForSession = useCallback((chatSessionId: string) => {
    setQuotedRefsBySession((prev) => {
      if (!prev[chatSessionId] || prev[chatSessionId].length === 0) {
        return prev;
      }
      return {
        ...prev,
        [chatSessionId]: [],
      };
    });
  }, []);

  const handleForwardQuotedRef = useCallback((chatSessionId: string, ref: QuotedRef) => {
    appendQuotedRefForSession(chatSessionId, ref);
    setActiveSession(chatSessionId);
    setView("chat");
  }, [appendQuotedRefForSession, setActiveSession]);

  const fileDrawerOpen = Boolean(activeSessionId && sessionFileOpen[activeSessionId]);
  const fileDrawerData = activeSessionId
    ? (sessionFileMap[activeSessionId] ?? null)
    : null;

  const handleSetFileDrawerData = useCallback((data: ReadFileResponse | null) => {
    if (!activeSessionId) return;
    if (data) {
      setSessionFileMap(prev => ({ ...prev, [activeSessionId]: data }));
      setSessionFileOpen(prev => ({ ...prev, [activeSessionId]: true }));
      setSessionFilePathMap(prev => ({ ...prev, [activeSessionId]: data.resolvedPath }));
    } else {
      setSessionFileOpen(prev => ({ ...prev, [activeSessionId]: false }));
    }
  }, [activeSessionId]);

  const toggleDocs = useCallback(() => {
    if (!activeSessionId) return;
    setSessionFileOpen(prev => ({ ...prev, [activeSessionId]: !prev[activeSessionId] }));
  }, [activeSessionId]);

  const toggleDocsRef = useRef(toggleDocs);
  toggleDocsRef.current = toggleDocs;

  const isSettings = view === "settings";
  const terminalOpen = Boolean(activeSessionId && terminalOpenMap[activeSessionId]);

  return (
    <div className={`app ${isSettings ? "app--settings" : ""} ${!panelVisible && !isSettings ? "app--panel-hidden" : ""}`}>
      <header className="app__header">
        <img src="/logo.png" alt="" className="app__header-logo" />
        <h1 className="app__header-brand">{t.appTitle}</h1>
        <span className="app__header-subtitle">{isSettings ? t.settings : t.sessions}</span>
        <div className="app__header-actions">
          {isSettings ? (
            <button type="button" className="app__header-btn" onClick={() => setView("chat")}>
              ← {t.back}
            </button>
          ) : (
            <button type="button" className="app__header-btn" onClick={() => setView("settings")}>
              ⚙ {t.settings}
            </button>
          )}
        </div>
      </header>

      {!isSettings && (
        <>
          <SessionTabs
            sessions={sortedSessions}
            pinnedSessionIds={pinnedSessionIds}
            activeSessionId={activeSessionId}
            onSelect={handleSessionSelect}
            onTogglePin={togglePinnedSession}
            onReorderPinned={reorderPinnedSessions}
            onDelete={handleDeleteSession}
            onTogglePanel={togglePanel}
            collapsed={!panelVisible}
          />
          <div
            className="app__resize-handle"
            onMouseDown={onResizeStart}
            title="拖拽调整面板宽度"
          />
        </>
      )}
      
      <main className={`app__main ${isSettings ? "app__main--full" : ""}`}>
        {isSettings ? (
          <SettingsPanel />
        ) : (
          <ChatView
            session={activeSession}
            onSendReply={onSendReply}
            connected={connected}
            queuedReplies={activeSessionId ? (queuedMessages.get(activeSessionId) || []) : []}
            onRemoveQueuedReply={activeSessionId ? (index: number) => onRemoveQueuedReply(activeSessionId, index) : undefined}
            quotedRefs={activeSessionId ? (quotedRefsBySession[activeSessionId] ?? []) : []}
            onAppendQuotedRef={activeSessionId ? (ref) => appendQuotedRefForSession(activeSessionId, ref) : undefined}
            onRemoveQuotedRef={activeSessionId ? (index) => removeQuotedRefForSession(activeSessionId, index) : undefined}
            onClearQuotedRefs={activeSessionId ? () => clearQuotedRefsForSession(activeSessionId) : undefined}
            forwardSessions={sortedSessions}
            onForwardQuotedRef={handleForwardQuotedRef}
            terminalSlot={
              <TerminalDrawer
                open={terminalOpen}
                sessionId={activeSessionId}
                workspaceRoot={activeSession?.workspaceRoot}
              />
            }
            showPinPanel={showPinPanel}
            onSetShowPinPanel={setShowPinPanel}
            onSetTitle={handleSetSessionTitle}
            fileDrawerOpen={fileDrawerOpen}
            fileDrawerData={fileDrawerData}
            onSetFileDrawerData={handleSetFileDrawerData}
            autoReplyTemplates={autoReplyTemplates}
            onSetAutoReply={handleSetAutoReply}
          />
        )}
      </main>

      {!isSettings && (
        <div className="app__right-rail">
          <button
            type="button"
            className={`app__right-rail-btn${terminalOpen ? " app__right-rail-btn--active" : ""}`}
            title={locale === "zh" ? "终端" : "Terminal"}
            onClick={() => {
              if (activeSessionId) {
                setTerminalOpenMap((m) => ({ ...m, [activeSessionId]: !m[activeSessionId] }));
              }
            }}
            disabled={!activeSessionId}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="12" height="10" rx="1" />
              <path d="M5 6l2 2-2 2" />
              <path d="M9 10h3" />
            </svg>
          </button>
          <button
            type="button"
            className={`app__right-rail-btn${fileDrawerOpen ? " app__right-rail-btn--active" : ""}`}
            title={locale === "zh" ? "文档" : "Docs"}
            onClick={toggleDocs}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 1.5h7l3.5 3.5V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2.5A1 1 0 0 1 3 1.5Z" />
              <path d="M10 1.5V5h3.5" />
              <path d="M5 8.5h6" />
              <path d="M5 11h4" />
            </svg>
          </button>
        </div>
      )}

      <StatusBar
        connected={connected}
        activeSessions={activeCount}
        pendingRequests={pendingCount}
        theme={theme}
        toggleTheme={toggleTheme}
      />
    </div>
  );
}
