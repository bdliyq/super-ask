import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";
import type { IPty } from "node-pty";
import type { SessionManager } from "./sessionManager";

const TERMINAL_PATH = "/ws/terminal";
const MAX_TERMINALS = 100;
const IDLE_MS = 24 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 5 * 60_000;
const SCROLLBACK_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;
const TERMINAL_DEBUG_PREFIX = "[terminal-debug]";

type PtyEntry = {
  pty: IPty;
  sessionId: string;
  ws: WebSocket | null;
  wsAlive: boolean;
  scrollback: string[];
  scrollbackLen: number;
  lastActivity: number;
  exited: boolean;
  exitCode: number;
};

function getPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function parseDim(raw: string | null, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 500);
}

async function resolveShellCwd(workspaceRoot: string | undefined): Promise<string> {
  const home = process.env.HOME?.trim();
  const tryDir = async (p: string) => {
    try { return (await stat(p)).isDirectory(); } catch { return false; }
  };
  if (workspaceRoot?.trim()) {
    const r = resolve(workspaceRoot.trim());
    if (await tryDir(r)) return r;
  }
  if (home) {
    const r = resolve(home);
    if (await tryDir(r)) return r;
  }
  return process.cwd();
}

function defaultShell(): string {
  if (process.platform === "darwin") return "/bin/zsh";
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL?.trim() || "/bin/bash";
}

export class TerminalManager {
  private readonly pool = new Map<string, PtyEntry>();
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private readonly onUpgradeBound: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly authToken: string,
  ) {
    this.onUpgradeBound = (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    };
  }

  attachToServer(httpServer: Server): void {
    if (this.httpServer) return;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", this.onUpgradeBound);
    this.idleTimer = setInterval(() => this.reapIdle(), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
    this.heartbeatTimer = setInterval(() => this.pingAll(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private pingAll(): void {
    for (const entry of this.pool.values()) {
      const ws = entry.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      if (!entry.wsAlive) {
        console.warn(TERMINAL_DEBUG_PREFIX, "heartbeat terminate", {
          sessionId: entry.sessionId,
          scrollbackLen: entry.scrollbackLen,
        });
        try { ws.terminate(); } catch { /* ignore */ }
        entry.ws = null;
        continue;
      }
      entry.wsAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [sid, entry] of this.pool) {
      if (entry.ws) continue;
      if (now - entry.lastActivity > IDLE_MS) {
        this.destroyEntry(sid, entry);
      }
    }
  }

  killSession(sessionId: string): void {
    const entry = this.pool.get(sessionId);
    if (entry) this.destroyEntry(sessionId, entry);
  }

  private destroyEntry(sid: string, entry: PtyEntry): void {
    this.pool.delete(sid);
    try { entry.pty.kill(); } catch { /* ignore */ }
    if (entry.ws) {
      try { entry.ws.terminate(); } catch { /* ignore */ }
      entry.ws = null;
    }
  }

  private pushScrollback(entry: PtyEntry, data: string): void {
    entry.scrollback.push(data);
    entry.scrollbackLen += data.length;
    while (entry.scrollbackLen > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
      entry.scrollbackLen -= entry.scrollback.shift()!.length;
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (getPathname(req) !== TERMINAL_PATH) return;

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== this.authToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const cols = parseDim(url.searchParams.get("cols"), 80);
    const rows = parseDim(url.searchParams.get("rows"), 24);

    const existing = this.pool.get(sessionId);
    if (existing && !existing.exited) {
      console.info(TERMINAL_DEBUG_PREFIX, "reattach existing session", {
        sessionId,
        cols,
        rows,
        scrollbackLen: existing.scrollbackLen,
        scrollbackChunks: existing.scrollback.length,
      });
      if (existing.ws) {
        try { existing.ws.close(1000); } catch { /* ignore */ }
        existing.ws = null;
      }
      const wss = this.wss;
      if (!wss) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.reattach(existing, ws, cols, rows);
      });
      return;
    }

    if (existing?.exited) {
      this.pool.delete(sessionId);
    }

    if (this.pool.size >= MAX_TERMINALS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    let cwd: string;
    try {
      cwd = await resolveShellCwd(session.workspaceRoot);
    } catch {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
      return;
    }

    const wss = this.wss;
    if (!wss) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
      this.spawnAndAttach(ws, sessionId, cwd, cols, rows);
    });
  }

  private reattach(entry: PtyEntry, ws: WebSocket, cols: number, rows: number): void {
    entry.ws = ws;
    entry.lastActivity = Date.now();

    if (entry.scrollback.length > 0) {
      const replay = entry.scrollback.join("");
      console.info(TERMINAL_DEBUG_PREFIX, "replay scrollback", {
        sessionId: entry.sessionId,
        replayBytes: replay.length,
        scrollbackChunks: entry.scrollback.length,
        cols,
        rows,
      });
      try { ws.send(replay); } catch { /* ignore */ }
    }

    try { entry.pty.resize(cols, rows); } catch { /* ignore */ }

    this.bindWsEvents(entry, ws);
  }

  private spawnAndAttach(ws: WebSocket, sessionId: string, cwd: string, cols: number, rows: number): void {
    console.info(TERMINAL_DEBUG_PREFIX, "spawn session", {
      sessionId,
      cwd,
      cols,
      rows,
    });
    const shell = defaultShell();
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }

    let ptyProc: IPty;
    try {
      ptyProc = pty.spawn(shell, [], {
        name: "xterm-256color", cwd, cols, rows, env: cleanEnv,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "spawn failed";
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: msg }));
        ws.close();
      } catch { /* ignore */ }
      return;
    }

    const entry: PtyEntry = {
      pty: ptyProc, sessionId, ws, wsAlive: true,
      scrollback: [], scrollbackLen: 0,
      lastActivity: Date.now(),
      exited: false, exitCode: 0,
    };
    this.pool.set(sessionId, entry);

    ptyProc.onData((data) => {
      entry.lastActivity = Date.now();
      this.pushScrollback(entry, data);
      const w = entry.ws;
      if (w?.readyState === WebSocket.OPEN) {
        try {
          w.send(data, (err) => {
            if (err) { try { w.terminate(); } catch { /* ignore */ } }
          });
        } catch { /* ignore */ }
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.exitCode = exitCode;
      if (entry.ws?.readyState === WebSocket.OPEN) {
        try { entry.ws.send(JSON.stringify({ type: "exit", code: exitCode })); } catch { /* ignore */ }
        try { entry.ws.close(); } catch { /* ignore */ }
      }
      entry.ws = null;
    });

    this.bindWsEvents(entry, ws);
  }

  private bindWsEvents(entry: PtyEntry, ws: WebSocket): void {
    entry.wsAlive = true;
    ws.on("pong", () => { entry.wsAlive = true; });

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (entry.exited) return;
      entry.lastActivity = Date.now();

      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        try { entry.pty.write(buf.toString("utf8")); } catch { /* ignore */ }
        return;
      }
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
      if (!text) return;

      let msg: unknown;
      try { msg = JSON.parse(text) as unknown; } catch {
        try { entry.pty.write(text); } catch { /* ignore */ }
        return;
      }
      if (!msg || typeof msg !== "object") {
        try { entry.pty.write(text); } catch { /* ignore */ }
        return;
      }
      const o = msg as { type?: string; cols?: number; rows?: number };
      if (o.type === "resize") {
        const c = typeof o.cols === "number" && Number.isFinite(o.cols) ? Math.min(Math.max(1, o.cols), 500) : null;
        const r = typeof o.rows === "number" && Number.isFinite(o.rows) ? Math.min(Math.max(1, o.rows), 500) : null;
        if (c !== null && r !== null) { try { entry.pty.resize(c, r); } catch { /* ignore */ } }
        return;
      }
      try { entry.pty.write(text); } catch { /* ignore */ }
    };

    const onClose = (code?: number, reason?: Buffer) => {
      console.warn(TERMINAL_DEBUG_PREFIX, "ws close", {
        sessionId: entry.sessionId,
        code: code ?? null,
        reason: reason?.toString("utf8") ?? "",
        scrollbackLen: entry.scrollbackLen,
        exited: entry.exited,
      });
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      if (entry.ws === ws) entry.ws = null;
    };

    const onError = (error: Error) => {
      console.error(TERMINAL_DEBUG_PREFIX, "ws error", {
        sessionId: entry.sessionId,
        message: error.message,
      });
      onClose();
    };

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.httpServer) { this.httpServer.off("upgrade", this.onUpgradeBound); this.httpServer = null; }
    this.wss = null;
    for (const [sid, entry] of this.pool) {
      this.destroyEntry(sid, entry);
    }
  }
}
