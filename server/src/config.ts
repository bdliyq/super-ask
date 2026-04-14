import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuperAskConfig } from "../../shared/types";
import { DEFAULT_CONFIG } from "../../shared/types";

/** 用户配置目录 */
export const SUPER_ASK_DIR = join(homedir(), ".super-ask");

/** 共享密钥文件路径 */
const TOKEN_PATH = join(SUPER_ASK_DIR, "token");

/** 配置文件路径 */
const CONFIG_PATH = join(SUPER_ASK_DIR, "config.json");

/**
 * 深度合并配置（仅覆盖已定义的字段）
 */
function mergeConfig(
  base: SuperAskConfig,
  override: Partial<SuperAskConfig>
): SuperAskConfig {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(override).filter(([, v]) => v !== undefined)
    ) as Partial<SuperAskConfig>,
  };
}

/**
 * 从 ~/.super-ask/config.json 读取配置，与 DEFAULT_CONFIG 合并
 */
export async function loadFileConfig(): Promise<SuperAskConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SuperAskConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw e;
  }
}

/**
 * 确保 ~/.super-ask 目录存在（首次写入前调用）
 */
export async function ensureSuperAskDir(): Promise<void> {
  await mkdir(SUPER_ASK_DIR, { recursive: true });
}

/** 确保存在鉴权 token：文件非空则复用，否则生成 32 字节随机 hex 并写入（0600） */
export async function ensureAuthToken(): Promise<string> {
  try {
    const existing = await readFile(TOKEN_PATH, "utf-8");
    const trimmed = existing.trim();
    if (trimmed.length >= 32) return trimmed;
  } catch {
    /* 无文件或读失败则生成 */
  }
  const token = randomBytes(32).toString("hex");
  await ensureSuperAskDir();
  await writeFile(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

/** 读取已保存的 token，不存在或为空则 null */
export async function readAuthToken(): Promise<string | null> {
  try {
    const content = await readFile(TOKEN_PATH, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

export interface CliOverrides {
  port?: number;
  host?: string;
}

/**
 * 合并：DEFAULT → 文件配置 → CLI 覆盖
 */
export function applyCliOverrides(
  cfg: SuperAskConfig,
  cli: CliOverrides
): SuperAskConfig {
  return mergeConfig(cfg, {
    port: cli.port,
    host: cli.host,
  });
}
