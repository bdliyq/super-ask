import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { DEFAULT_CONFIG } from "@shared/types";
import { getAuthToken } from "../auth";

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
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(data);
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
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
    onSessionChange.current?.();
    reconnectCount.current = 0;

    function connect() {
      if (cancelled || !mountedRef.current) return;

      setError(null);
      setConnected(false);

      const url = buildTerminalWsUrl(port, token!, sessionId!, 80, 24, workspaceRoot);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        reconnectCount.current = 0;
        setConnected(true);
        setError(null);
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
            const o = JSON.parse(raw) as { type?: string; message?: string };
            if (o.type === "error") {
              setError(typeof o.message === "string" ? o.message : "Terminal error");
              return;
            }
            if (o.type === "exit") {
              onOutput.current?.("\r\n\x1b[33m[Process exited, reconnecting…]\x1b[0m\r\n");
              scheduleReconnect();
              return;
            }
          } catch { /* fallthrough */ }
        }
        onOutput.current?.(raw);
      }

      ws.onerror = () => {
        if (cancelled) return;
        setConnected(false);
      };

      ws.onclose = (ev) => {
        if (cancelled) return;
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        if (ev.code !== 1000 && ev.code !== 1001) {
          onOutput.current?.("\r\n\x1b[33m[Connection lost, reconnecting…]\x1b[0m\r\n");
          scheduleReconnect();
        }
      };
    }

    function scheduleReconnect() {
      if (cancelled || !mountedRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectCount.current), RECONNECT_MAX_MS);
      reconnectCount.current++;
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
        ws.close(1000);
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [active, sessionId, workspaceRoot, port]);

  return { connected, error, send, sendResize, onOutput, onSessionChange };
}
