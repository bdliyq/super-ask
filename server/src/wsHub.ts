import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  FileAttachment,
  WsServerMessage,
  WsClientMessage,
  WsReply,
  WsReplyResult,
  WsDeleteSession,
} from "../../shared/types";
import type { SessionManager } from "./sessionManager";

const HEARTBEAT_INTERVAL_MS = 30_000;

type ClientExt = WebSocket & { isAlive?: boolean };

/**
 * WebSocket 中心：多 UI 连接、broadcast、sync、reply 与心跳
 */
export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientExt>();

  constructor(
    private readonly sessionManager: SessionManager,
    httpServer: Server,
    private readonly authToken: string
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
      const path = this.getPathname(req);
      if (path !== "/ws") {
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const token = url.searchParams.get("token");
      if (token !== this.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws as ClientExt);
      });
    });

    const interval = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    interval.unref?.();
  }

  private getPathname(req: IncomingMessage): string {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      return u.pathname;
    } catch {
      return "";
    }
  }

  private onConnection(ws: ClientExt): void {
    ws.isAlive = true;
    this.clients.add(ws);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data) => {
      this.onClientMessage(ws, data);
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", () => {
      this.clients.delete(ws);
    });

    // 新连接：全量同步 Session
    const syncMsg: WsServerMessage = {
      type: "sync",
      sessions: this.sessionManager.listSessionsForSync(),
    };
    this.send(ws, syncMsg);
  }

  private onClientMessage(ws: WebSocket, raw: unknown): void {
    let parsed: WsClientMessage;
    try {
      const text = typeof raw === "string" ? raw : raw?.toString?.() ?? "";
      parsed = JSON.parse(text) as WsClientMessage;
    } catch {
      return;
    }

    if (!parsed || typeof parsed.type !== "string") return;

    if (parsed.type === "reply") {
      const reply = parsed as WsReply;
      if (!reply.chatSessionId || typeof reply.feedback !== "string") return;

      let attachments: FileAttachment[] | undefined;
      if (Array.isArray(reply.attachments) && reply.attachments.length > 0) {
        attachments = reply.attachments as FileAttachment[];
      }

      const accepted = this.sessionManager.handleReply(
        reply.chatSessionId,
        reply.feedback,
        attachments,
        typeof reply.displayFeedback === "string" ? reply.displayFeedback : undefined
      );
      this.send(ws, {
        type: "reply_result",
        chatSessionId: reply.chatSessionId,
        ...(typeof reply.clientRequestId === "string"
          ? { clientRequestId: reply.clientRequestId }
          : {}),
        accepted,
        ...(!accepted ? { code: "not_pending" as const } : {}),
      } satisfies WsReplyResult);
      return;
    }

    if (parsed.type === "delete_session") {
      const del = parsed as WsDeleteSession;
      if (!del.chatSessionId) return;
      this.sessionManager.deleteSession(del.chatSessionId);
    }
  }

  private send(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  /**
   * 广播给所有已连接的 Web UI
   */
  broadcast(msg: WsServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}
