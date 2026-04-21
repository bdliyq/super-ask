import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useTerminal } from "../hooks/useTerminal";
import { useTerminalWs } from "../hooks/useTerminalWs";
import { useI18n } from "../i18n";
import { startBodyResizeSession } from "../utils/bodyResizeSession";

const WIDTH_MAP_KEY = "super-ask-terminal-width-map";
const MAX_MAP_KEY = "super-ask-terminal-maximized-map";
const DEFAULT_WIDTH_PCT = 50;
const MIN_WIDTH_PCT = 20;
const MAX_WIDTH_PCT = 90;

function loadMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveMap<T>(key: string, map: Record<string, T>): void {
  localStorage.setItem(key, JSON.stringify(map));
}

export interface TerminalDrawerProps {
  open: boolean;
  sessionId: string | null;
  workspaceRoot?: string;
}

interface TerminalDrawerCoreProps {
  sessionId: string | null;
  workspaceRoot?: string;
  visible: boolean;
}

function TerminalDrawerCore({ sessionId, workspaceRoot, visible }: TerminalDrawerCoreProps) {
  const sendRef = useRef<(data: string) => void>(() => {});
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {});

  const { containerRef, write, focus, clear, readSize } = useTerminal({
    onData: (data) => sendRef.current(data),
    onResize: (cols, rows) => sendResizeRef.current(cols, rows),
  });

  const { connected, send, sendResize, onOutput, onSessionChange } = useTerminalWs({
    sessionId,
    workspaceRoot,
    active: Boolean(sessionId),
  });

  sendRef.current = send;
  sendResizeRef.current = sendResize;
  onOutput.current = write;
  onSessionChange.current = clear;

  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      focus();
      const s = readSize();
      if (s && connected) sendResize(s.cols, s.rows);
    });
    return () => cancelAnimationFrame(id);
  }, [visible, focus, readSize, connected, sendResize]);

  useEffect(() => {
    if (!connected || !sessionId) return;
    const id = requestAnimationFrame(() => {
      const s = readSize();
      if (s) sendResize(s.cols, s.rows);
    });
    return () => cancelAnimationFrame(id);
  }, [connected, sessionId, readSize, sendResize]);

  return <div ref={containerRef} className="terminal-drawer__body" />;
}

export function TerminalDrawer({ open, sessionId, workspaceRoot }: TerminalDrawerProps) {
  const { locale } = useI18n();
  const sid = sessionId ?? "";

  const [maximized, setMaximized] = useState<boolean>(() => {
    return sid ? Boolean(loadMap<boolean>(MAX_MAP_KEY)[sid]) : false;
  });

  const [widthPct, setWidthPct] = useState<number>(() => {
    if (!sid) return DEFAULT_WIDTH_PCT;
    const n = loadMap<number>(WIDTH_MAP_KEY)[sid];
    return typeof n === "number" && n >= MIN_WIDTH_PCT && n <= MAX_WIDTH_PCT ? n : DEFAULT_WIDTH_PCT;
  });

  useEffect(() => {
    if (!sid) return;
    const m = loadMap<boolean>(MAX_MAP_KEY);
    setMaximized(Boolean(m[sid]));
    const w = loadMap<number>(WIDTH_MAP_KEY);
    const n = w[sid];
    setWidthPct(typeof n === "number" && n >= MIN_WIDTH_PCT && n <= MAX_WIDTH_PCT ? n : DEFAULT_WIDTH_PCT);
  }, [sid]);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startPct = useRef(DEFAULT_WIDTH_PCT);
  const containerRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const widthPctRef = useRef(widthPct);

  useEffect(() => {
    widthPctRef.current = widthPct;
  }, [widthPct]);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
  }, []);

  const toggleMaximize = useCallback(() => {
    setMaximized((v) => {
      const next = !v;
      if (sid) {
        const m = loadMap<boolean>(MAX_MAP_KEY);
        m[sid] = next;
        saveMap(MAX_MAP_KEY, m);
      }
      return next;
    });
  }, [sid]);

  const persistWidth = useCallback((v: number) => {
    if (!sid) return;
    const m = loadMap<number>(WIDTH_MAP_KEY);
    m[sid] = Math.round(v);
    saveMap(WIDTH_MAP_KEY, m);
  }, [sid]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    resizeCleanupRef.current?.();
    dragging.current = true;
    startX.current = e.clientX;
    startPct.current = widthPct;
    widthPctRef.current = widthPct;

    const parentWidth = containerRef.current?.parentElement?.clientWidth ?? window.innerWidth;

    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const deltaPx = startX.current - ev.clientX;
      const deltaPct = (deltaPx / parentWidth) * 100;
      const next = Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, startPct.current + deltaPct));
      widthPctRef.current = next;
      setWidthPct(next);
    };

    resizeCleanupRef.current = startBodyResizeSession({
      onMove,
      onEnd: () => {
        dragging.current = false;
        persistWidth(widthPctRef.current);
        resizeCleanupRef.current = null;
      },
    });
  }, [widthPct, maximized, persistWidth]);

  const effectiveWidth = open ? (maximized ? "100%" : `${widthPct}%`) : "0";

  return (
    <aside
      ref={containerRef}
      className={`terminal-drawer${open ? " terminal-drawer--open" : ""}${maximized ? " terminal-drawer--maximized" : ""}`}
      style={{ width: effectiveWidth }}
      aria-hidden={!open}
    >
      {!maximized && <div className="terminal-drawer__resize-handle" onMouseDown={onResizeStart} />}
      <div className="terminal-drawer__banner">
        <span className="terminal-drawer__banner-title">
          {locale === "zh" ? "终端" : "Terminal"}
        </span>
        <div className="terminal-drawer__banner-actions">
          <button
            type="button"
            className="terminal-drawer__banner-btn"
            onClick={toggleMaximize}
            title={maximized
              ? (locale === "zh" ? "退出全屏" : "Exit fullscreen")
              : (locale === "zh" ? "全屏" : "Fullscreen")}
          >
            {maximized ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 1v3H1M12 1v3h3M4 15v-3H1M12 15v-3h3" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 5V1h4M11 1h4v4M1 11v4h4M15 11v4h-4" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {sessionId ? (
        <TerminalDrawerCore
          key={sessionId}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          visible={open}
        />
      ) : null}
    </aside>
  );
}
