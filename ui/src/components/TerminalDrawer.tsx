import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useTerminal } from "../hooks/useTerminal";
import { useTerminalWs } from "../hooks/useTerminalWs";

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
  onClose: () => void;
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
  const hasOpened = useRef(false);
  if (open) hasOpened.current = true;

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
    dragging.current = true;
    startX.current = e.clientX;
    startPct.current = widthPct;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const parentWidth = containerRef.current?.parentElement?.clientWidth ?? window.innerWidth;

    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const deltaPx = startX.current - ev.clientX;
      const deltaPct = (deltaPx / parentWidth) * 100;
      const next = Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, startPct.current + deltaPct));
      setWidthPct(next);
    };

    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setWidthPct((v) => {
        persistWidth(v);
        return v;
      });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
      <button
        type="button"
        className="terminal-drawer__maximize-float"
        onClick={toggleMaximize}
        aria-label={maximized ? "Exit fullscreen" : "Fullscreen"}
      >
        {maximized ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 10 1 10 1 15 6 15 6 12" />
            <polyline points="12 6 15 6 15 1 10 1 10 4" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 2 14 2 14 6" />
            <polyline points="6 14 2 14 2 10" />
            <line x1="14" y1="2" x2="9" y2="7" />
            <line x1="2" y1="14" x2="7" y2="9" />
          </svg>
        )}
      </button>
      {hasOpened.current ? (
        <TerminalDrawerCore sessionId={sessionId} workspaceRoot={workspaceRoot} visible={open} />
      ) : null}
    </aside>
  );
}
