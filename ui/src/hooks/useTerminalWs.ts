import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { DEFAULT_CONFIG } from "@shared/types";
import { getAuthToken } from "../auth";

const TERMINAL_DEBUG_PREFIX = "[terminal-debug]";

export interface UseTerminalWsOptions {
  sessionId: string | null;
  workspaceRoot?: string;
  active: boolean;
  port?: number;
}

export interface UseTerminalWsReturn {
  connected: boolean;
  error: string | null;
  send: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  onOutput: MutableRefObject<((data: string) => void) | null>;
  onSessionChange: MutableRefObject<(() => void) | null>;
}

function buildTerminalWsUrl(
  port: number,
  token: string,
  sessionId: string,
  cols: number,
  rows: number,
  workspaceRoot?: string,
): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let origin: string;
  if (import.meta.env.DEV || window.location.port) {
    origin = `${wsProtocol}//${window.location.host}`;
  } else {
    origin = `${wsProtocol}//${window.location.hostname}:${port}`;
  }
  const q = new URLSearchParams({
    token,
    sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  if (workspaceRoot) {
    q.set("workspaceRoot", workspaceRoot);
  }
  return `${origin}/ws/terminal?${q.toString()}`;
}

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 15000;

export function useTerminalWs(options: UseTerminalWsOptions): UseTerminalWsReturn {
  const { sessionId, workspaceRoot, active, port = DEFAULT_CONFIG.port } = options;
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onOutput = useRef<((data: string) => void) | null>(null);
  const onSessionChange = useRef<(() => void) | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCount = useRef(0);
  const mountedRef = useRef(true);

  const send = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(TERMINAL_DEBUG_PREFIX, "drop input while socket not open", {
        sessionId,
        readyState: ws?.readyState ?? null,
        size: data.length,
      });
      return;
    }
    ws.send(data);
  }, [sessionId]);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(TERMINAL_DEBUG_PREFIX, "drop resize while socket not open", {
        sessionId,
        readyState: ws?.readyState ?? null,
        cols,
        rows,
      });
      return;
    }
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    console.info(TERMINAL_DEBUG_PREFIX, "effect start", {
      sessionId,
      workspaceRoot,
      active,
      port,
    });
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    if (!active || !sessionId) {
      setConnected(false);
      setError(null);
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      return;
    }

    const token = getAuthToken();
    if (!token) {
      setError("Not authenticated");
      setConnected(false);
      return;
    }

    let cancelled = false;
    console.info(TERMINAL_DEBUG_PREFIX, "session change clear", { sessionId });
    onSessionChange.current?.();
    reconnectCount.current = 0;

    function connect() {
      if (cancelled || !mountedRef.current) return;

      setError(null);
      setConnected(false);

      const url = buildTerminalWsUrl(port, token!, sessionId!, 80, 24, workspaceRoot);
      console.info(TERMINAL_DEBUG_PREFIX, "connect", { sessionId, url });
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        reconnectCount.current = 0;
        setConnected(true);
        setError(null);
        console.info(TERMINAL_DEBUG_PREFIX, "open", { sessionId });
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          handleMsg(ev.data);
        } else if (ev.data instanceof Blob) {
          void ev.data.text().then(handleMsg);
        }
      };

      function handleMsg(raw: string) {
        if (raw.startsWith("{")) {
          try {
            const o = JSON.parse(raw) as { type?: string; message?: string; code?: number };
            if (o.type === "error") {
              console.error("[terminal-ws] server error:", o.message);
              setError(typeof o.message === "string" ? o.message : "Terminal error");
              return;
            }
            if (o.type === "exit") {
              console.warn("[terminal-ws] process exited, code:", o.code);
              console.warn(TERMINAL_DEBUG_PREFIX, "process exit event", {
                sessionId,
                code: o.code ?? null,
              });
              onOutput.current?.(`\r\n\x1b[33m[Process exited (code=${o.code ?? "?"}), reconnecting…]\x1b[0m\r\n`);
              scheduleReconnect();
              return;
            }
          } catch { /* fallthrough */ }
        }
        onOutput.current?.(raw);
      }

      ws.onerror = (ev) => {
        if (cancelled) return;
        setConnected(false);
        console.error("[terminal-ws] error", ev);
        console.error(TERMINAL_DEBUG_PREFIX, "socket error", { sessionId });
        onOutput.current?.("\r\n\x1b[31m[WS error]\x1b[0m\r\n");
      };

      ws.onclose = (ev) => {
        if (cancelled) return;
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        console.warn("[terminal-ws] closed", ev.code, ev.reason);
        console.warn(TERMINAL_DEBUG_PREFIX, "socket close", {
          sessionId,
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
        });
        if (ev.code !== 1000 && ev.code !== 1001) {
          onOutput.current?.(`\r\n\x1b[33m[Connection lost (code=${ev.code}), reconnecting…]\x1b[0m\r\n`);
          scheduleReconnect();
        }
      };
    }

    function scheduleReconnect() {
      if (cancelled || !mountedRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectCount.current), RECONNECT_MAX_MS);
      reconnectCount.current++;
      console.info(TERMINAL_DEBUG_PREFIX, "schedule reconnect", {
        sessionId,
        attempt: reconnectCount.current,
        delay,
      });
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        console.info(TERMINAL_DEBUG_PREFIX, "cleanup close", { sessionId });
        ws.close(1000);
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [active, sessionId, workspaceRoot, port]);

  return { connected, error, send, sendResize, onOutput, onSessionChange };
}
