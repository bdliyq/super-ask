import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChatView } from "./components/ChatView";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { SettingsPanel } from "./components/SettingsPanel";
import { SessionTabs } from "./components/SessionTabs";
import { StatusBar } from "./components/StatusBar";
import type { FileAttachment, WsServerMessage } from "@shared/types";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useI18n } from "./i18n";
import { getActivePredefinedSuffix, isNotificationEnabled } from "./components/SystemSettings";

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
  const { t } = useI18n();
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

  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState<boolean>(() => {
    return localStorage.getItem("super-ask-terminal-open") === "true";
  });

  useEffect(() => {
    localStorage.setItem(PANEL_VISIBLE_KEY, String(panelVisible));
  }, [panelVisible]);

  useEffect(() => {
    localStorage.setItem("super-ask-terminal-open", String(terminalDrawerOpen));
  }, [terminalDrawerOpen]);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  const togglePanel = useCallback(() => {
    setPanelVisible((v) => !v);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }, []);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(DEFAULT_PANEL_WIDTH);

  const onResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = panelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startW.current + delta));
      setPanelWidth(next);
    };

    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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

  const syncQueueState = useCallback(() => {
    const next = new Map(replyQueueRef.current);
    setQueuedMessages(next);
    saveQueueToStorage(next);
  }, []);

  const sendReplyRef = useRef<typeof sendReply>(null!);

  const getReplyErrorMessage = useCallback((code?: "not_pending" | "socket_unavailable" | "timeout") => {
    if (code === "not_pending") return t.replyRequestExpired;
    if (code === "timeout") return t.replyConfirmTimeout;
    return t.replySocketUnavailable;
  }, [t]);

  const handleServerMessageWithQueue = useCallback((msg: WsServerMessage) => {
    handleServerMessage(msg);
    if (msg.type === "new_request") {
      try {
        if (
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

  const isSettings = view === "settings";

  return (
    <div className={`app ${isSettings ? "app--settings" : ""} ${!panelVisible && !isSettings ? "app--panel-hidden" : ""}`}>
      {/* 统一页眉 */}
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

      {/* 聊天模式：会话列表 + 分割线 + 聊天区 */}
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
          />
          <div
            className="app__resize-handle"
            onMouseDown={onResizeStart}
            title="拖拽调整面板宽度"
          />
        </>
      )}
      {/* panel 隐藏时的浮动恢复按钮 */}
      {!isSettings && !panelVisible && (
        <button
          type="button"
          className="app__panel-show-btn"
          onClick={togglePanel}
          aria-label="Show sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" />
          </svg>
        </button>
      )}
      <main className={`app__main ${isSettings ? "app__main--full" : ""}`}>
        {isSettings ? (
          <SettingsPanel />
        ) : (
          <ChatView
            session={activeSession}
            onSendReply={onSendReply}
            queuedReplies={activeSessionId ? (queuedMessages.get(activeSessionId) || []) : []}
            onRemoveQueuedReply={activeSessionId ? (index: number) => onRemoveQueuedReply(activeSessionId, index) : undefined}
            onOpenTerminal={() => setTerminalDrawerOpen((v) => !v)}
            terminalOpen={terminalDrawerOpen}
            terminalSlot={
              <TerminalDrawer
                open={terminalDrawerOpen}
                onClose={() => setTerminalDrawerOpen(false)}
                sessionId={activeSessionId}
                workspaceRoot={activeSession?.workspaceRoot}
              />
            }
          />
        )}
      </main>
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
