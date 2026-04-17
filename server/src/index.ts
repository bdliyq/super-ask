#!/usr/bin/env node
import { fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
  createWriteStream,
  type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kill } from "node:process";
import {
  loadFileConfig,
  applyCliOverrides,
  ensureSuperAskDir,
  ensureAuthToken,
  SUPER_ASK_DIR,
} from "./config";
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
} from "./pidManager";
import { startSuperAsk } from "./server";

const DAEMON_CHILD_ENV = "SUPER_ASK_DAEMON_CHILD";
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_MAX_FILES = 5;

const LOG_DIR = join(SUPER_ASK_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "server.log");

/**
 * 按 10MB 轮转、保留 5 个历史文件的日志写入器
 */
class RotatingFileLogger {
  private stream: WriteStream | null = null;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.stream = createWriteStream(this.filePath, { flags: "a" });
  }

  private rotateIfNeeded(nextChunkLen: number): void {
    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size + nextChunkLen <= LOG_MAX_BYTES) return;

    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    const base = this.filePath;
    const last = `${base}.${LOG_MAX_FILES}`;
    if (existsSync(last)) {
      try {
        unlinkSync(last);
      } catch {
        /* ignore */
      }
    }
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? base : `${base}.${i - 1}`;
      const to = `${base}.${i}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }

    this.stream = createWriteStream(this.filePath, { flags: "a" });
  }

  writeLine(line: string): void {
    const buf = `${line}\n`;
    this.rotateIfNeeded(Buffer.byteLength(buf, "utf-8"));
    if (!this.stream) {
      this.stream = createWriteStream(this.filePath, { flags: "a" });
    }
    this.stream.write(buf);
  }
}

/**
 * daemon 模式下将 console 输出重定向到轮转日志文件
 */
function installDaemonConsole(logger: RotatingFileLogger): void {
  const write = (level: string, args: unknown[]) => {
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    logger.writeLine(`[${new Date().toISOString()}] [${level}] ${text}`);
  };

  console.log = (...a: unknown[]) => write("log", a);
  console.info = (...a: unknown[]) => write("info", a);
  console.warn = (...a: unknown[]) => write("warn", a);
  console.error = (...a: unknown[]) => write("error", a);
  console.debug = (...a: unknown[]) => write("debug", a);
}

interface ParsedCli {
  command: "start" | "stop" | "status";
  port?: number;
  daemon: boolean;
}

function parseArgv(argv: string[]): ParsedCli {
  const rest = [...argv];
  let command: ParsedCli["command"] = "start";
  const first = rest[0];
  if (first === "start" || first === "stop" || first === "status") {
    command = first;
    rest.shift();
  }

  let port: number | undefined;
  let daemon = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--daemon") {
      daemon = true;
      continue;
    }
    if (a === "--port" && rest[i + 1]) {
      port = Number(rest[i + 1]);
      i++;
      continue;
    }
  }

  return { command, port, daemon };
}

async function cmdStart(portOverride?: number, daemon?: boolean): Promise<void> {
  const isDaemonChild = process.env[DAEMON_CHILD_ENV] === "1";

  if (daemon && !isDaemonChild) {
    const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
    const args = process.argv.slice(2).filter((a) => a !== "--daemon");
    const child = fork(entry, args, {
      env: { ...process.env, [DAEMON_CHILD_ENV]: "1" },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.exit(0);
  }

  if (isDaemonChild) {
    const logger = new RotatingFileLogger(LOG_FILE);
    installDaemonConsole(logger);
  }

  const fileCfg = await loadFileConfig();
  const config = applyCliOverrides(fileCfg, {
    port: portOverride,
  });

  const existing = await readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    console.error(
      `super-ask 已在运行 (pid=${existing.pid}, port=${existing.port})`
    );
    process.exit(1);
  }
  if (existing) {
    await removePidFile();
  }

  await ensureSuperAskDir();

  try {
    const authToken = await ensureAuthToken();
    const running = await startSuperAsk(config, authToken);
    await writePidFile({
      pid: process.pid,
      port: config.port,
      startedAt: Date.now(),
    });

    console.log(
      `super-ask 已启动: http://${config.host}:${config.port} (pid=${process.pid})`
    );

    const shutdown = async (signal: string) => {
      console.log(`收到 ${signal}，正在关闭…`);
      try {
        await running.close();
      } finally {
        await removePidFile();
        process.exit(0);
      }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    const crashLogPath = join(LOG_DIR, "crash.log");
    const writeCrash = (label: string, err: unknown) => {
      const ts = new Date().toISOString();
      const msg = err instanceof Error ? `${err.stack ?? err.message}` : String(err);
      const line = `[${ts}] ${label}: ${msg}\n`;
      try { require("node:fs").appendFileSync(crashLogPath, line); } catch { /* ignore */ }
      console.error(`${label}:`, err);
    };
    process.on("uncaughtException", (err) => {
      writeCrash("uncaughtException", err);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      writeCrash("unhandledRejection", reason);
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${config.port} 已被占用`);
    } else {
      console.error("启动失败:", err);
    }
    process.exit(1);
  }
}

const STOP_SIGTERM_WAIT_MS = 10_000;
const STOP_POLL_MS = 200;
const STOP_SIGKILL_WAIT_MS = 3_000;

async function cmdStop(): Promise<void> {
  const pidFile = await readPidFile();
  if (!pidFile) {
    console.log("未找到运行中的 super-ask（无 PID 文件）");
    process.exit(0);
    return;
  }
  if (!isProcessAlive(pidFile.pid)) {
    console.log(`PID ${pidFile.pid} 不存在，清理 PID 文件`);
    await removePidFile();
    process.exit(0);
    return;
  }
  try {
    kill(pidFile.pid, "SIGTERM");
  } catch (e) {
    console.error("停止失败:", e);
    process.exit(1);
    return;
  }

  // SIGTERM 后轮询 process.kill(pid, 0)，最多 10 秒等待目标进程退出
  const termDeadline = Date.now() + STOP_SIGTERM_WAIT_MS;
  while (isProcessAlive(pidFile.pid) && Date.now() < termDeadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }

  if (isProcessAlive(pidFile.pid)) {
    try {
      kill(pidFile.pid, "SIGKILL");
    } catch (e) {
      console.error("发送 SIGKILL 失败:", e);
      process.exit(1);
      return;
    }
    const killDeadline = Date.now() + STOP_SIGKILL_WAIT_MS;
    while (isProcessAlive(pidFile.pid) && Date.now() < killDeadline) {
      await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    }
  }

  if (isProcessAlive(pidFile.pid)) {
    console.error(
      `pid=${pidFile.pid} 在 SIGKILL 后仍存在，未删除 PID 文件，请手动检查`
    );
    process.exit(1);
    return;
  }

  await removePidFile();
  console.log(`已停止 super-ask（pid=${pidFile.pid}）`);
  process.exit(0);
}

async function cmdStatus(): Promise<void> {
  const pidFile = await readPidFile();
  if (!pidFile) {
    console.log("状态: 未运行（无 PID 文件）");
    process.exit(0);
    return;
  }
  const alive = isProcessAlive(pidFile.pid);
  console.log(
    alive
      ? `状态: 运行中 pid=${pidFile.pid} port=${pidFile.port} startedAt=${new Date(
          pidFile.startedAt
        ).toISOString()}`
      : `状态: 未运行（PID 文件存在但进程 ${pidFile.pid} 不存在）`
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const { command, port, daemon } = parseArgv(process.argv.slice(2));
  if (command === "stop") {
    await cmdStop();
    return;
  }
  if (command === "status") {
    await cmdStatus();
    return;
  }
  await cmdStart(port, daemon);
}

void main();
