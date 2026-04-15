import { useCallback, useEffect, useRef, useState } from "react";
import type { FileAttachment, WsReplyResult, WsServerMessage } from "@shared/types";
import { DEFAULT_CONFIG } from "@shared/types";
import { getAuthToken } from "../auth";

export interface UseWebSocketOptions {
  /** 收到服务端推送时的回调 */
  onMessage: (msg: WsServerMessage) => void;
  /** 服务端口，生产环境若与页面同源可忽略，由 getWsUrl 决定 */
  port?: number;
}

/**
 * 根据当前页面协议与主机构造 WebSocket URL。
 * 开发模式下通过 Vite 代理 /ws；构建后与 API 同源时直接使用当前 host。
 */
function getWsUrl(port: number, token: string): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let baseUrl: string;
  if (import.meta.env.DEV) {
    baseUrl = `${wsProtocol}//${window.location.host}/ws`;
  } else if (window.location.port) {
    baseUrl = `${wsProtocol}//${window.location.host}/ws`;
  } else {
    baseUrl = `${wsProtocol}//${window.location.hostname}:${port}/ws`;
  }
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;
const REPLY_RESULT_TIMEOUT_MS = 5000;

export interface SendReplyResult {
  accepted: boolean;
  code?: WsReplyResult["code"] | "socket_unavailable" | "timeout";
}

interface PendingReplyResolver {
  resolve: (result: SendReplyResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 管理 WebSocket：连接、指数退避重连、解析 WsServerMessage、发送回复。
 */
export function useWebSocket(options: UseWebSocketOptions) {
  const { onMessage, port = DEFAULT_CONFIG.port } = options;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const pendingRepliesRef = useRef<Map<string, PendingReplyResolver>>(new Map());

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    clearReconnectTimer();
    const url = getWsUrl(port, getAuthToken());
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WsServerMessage;
        if (data.type === "reply_result") {
          const requestId =
            typeof data.clientRequestId === "string" ? data.clientRequestId : "";
          if (requestId) {
            const pendingReply = pendingRepliesRef.current.get(requestId);
            if (pendingReply) {
              clearTimeout(pendingReply.timer);
              pendingRepliesRef.current.delete(requestId);
              pendingReply.resolve({
                accepted: data.accepted,
                code: data.code,
              });
            }
          }
          return;
        }
        onMessageRef.current(data);
      } catch {
        // 忽略无法解析的帧
      }
    };

    ws.onerror = () => {
      // 具体错误在 onclose 中统一处理重连
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      for (const [requestId, pendingReply] of pendingRepliesRef.current) {
        clearTimeout(pendingReply.timer);
        pendingReply.resolve({ accepted: false, code: "socket_unavailable" });
        pendingRepliesRef.current.delete(requestId);
      }
      if (!shouldReconnectRef.current) return;

      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, [clearReconnectTimer, port]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();
    return () => {
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      for (const [requestId, pendingReply] of pendingRepliesRef.current) {
        clearTimeout(pendingReply.timer);
        pendingReply.resolve({ accepted: false, code: "socket_unavailable" });
        pendingRepliesRef.current.delete(requestId);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect, clearReconnectTimer]);

  const sendReply = useCallback(
    (
      chatSessionId: string,
      feedback: string,
      attachments?: FileAttachment[],
      displayFeedback?: string,
    ): Promise<SendReplyResult> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve({ accepted: false, code: "socket_unavailable" });
      }

      const clientRequestId =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return new Promise<SendReplyResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingRepliesRef.current.delete(clientRequestId);
          resolve({ accepted: false, code: "timeout" });
        }, REPLY_RESULT_TIMEOUT_MS);

        pendingRepliesRef.current.set(clientRequestId, { resolve, timer });

        try {
          ws.send(
            JSON.stringify({
              type: "reply",
              chatSessionId,
              feedback,
              clientRequestId,
              ...(displayFeedback !== undefined ? { displayFeedback } : {}),
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            }),
          );
        } catch {
          clearTimeout(timer);
          pendingRepliesRef.current.delete(clientRequestId);
          resolve({ accepted: false, code: "socket_unavailable" });
        }
      });
    },
    [],
  );

  const sendDeleteSession = useCallback((chatSessionId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "delete_session", chatSessionId }));
  }, []);

  return { connected, sendReply, sendDeleteSession };
}
