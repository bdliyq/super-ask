import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { kill } from "node:process";
import type { PidFileContent } from "../../shared/types";
import { SUPER_ASK_DIR, ensureSuperAskDir } from "./config.js";

const PID_PATH = join(SUPER_ASK_DIR, "super-ask.pid");

/**
 * 将当前进程信息写入 PID 文件
 */
export async function writePidFile(content: PidFileContent): Promise<void> {
  await ensureSuperAskDir();
  await writeFile(PID_PATH, JSON.stringify(content, null, 2), "utf-8");
}

/**
 * 读取 PID 文件；不存在则返回 null
 */
export async function readPidFile(): Promise<PidFileContent | null> {
  try {
    const raw = await readFile(PID_PATH, "utf-8");
    return JSON.parse(raw) as PidFileContent;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * 删除 PID 文件
 */
export async function removePidFile(): Promise<void> {
  try {
    await unlink(PID_PATH);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
}

/**
 * 检测指定 PID 的进程是否仍在运行（POSIX：signal 0）
 */
export function isProcessAlive(pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { PID_PATH };
