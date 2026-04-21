import {
  mkdir,
  unlink,
  stat,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  DeployPlatform,
  DeployRequest,
  DeployResponse,
  DeployScope,
  DeployStep,
  DeployStatusResponse,
  UndeployRequest,
  UndeployResponse,
} from "../../shared/types";
import { SUPER_ASK_DIR } from "./config";

/** 读取文本文件 */
async function readFileContent(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

/** 写入文本文件 */
async function writeFileContent(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf-8");
}

function formatBackupTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** 去掉 .mdc 的 YAML frontmatter（--- ... ---），供写入 copilot-instructions.md */
function stripMdcFrontmatter(raw: string): string {
  const s = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!s.startsWith("---\n")) {
    return s.trim();
  }
  const rest = s.slice(4);
  const idx = rest.indexOf("\n---\n");
  if (idx === -1) {
    return s.trim();
  }
  return rest.slice(idx + "\n---\n".length).trimStart();
}

const CODEX_MARKER_BEGIN = "<!-- SUPER-ASK-BEGIN -->";
const CODEX_MARKER_END = "<!-- SUPER-ASK-END -->";
const OPENCODE_MARKER_BEGIN = "<!-- SUPER-ASK-OPENCODE-BEGIN -->";
const OPENCODE_MARKER_END = "<!-- SUPER-ASK-OPENCODE-END -->";
const CURSOR_HOOKS_MARKER = "super-ask-cursor-hook";
const LEGACY_CURSOR_HOOKS_MARKER = "super-ask-stop-hook";
const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "beforeTabFileRead",
  "afterTabFileEdit",
] as const;
const CODEX_HOOKS_MARKER = "super-ask-codex-hook";
const LEGACY_CODEX_STOP_HOOKS_MARKER = "super-ask-codex-stop-hook";
const CODEX_HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] as const;
const DEFAULT_CLI_FILE = "super-ask.js";
const CODEX_CLI_FILE = "super-ask-codex.js";

const QWEN_CONTEXT_FILE_NAME = "super-ask-qwen.md";
const QWEN_SETTINGS_DIR_NAME = ".qwen";
const QWEN_SETTINGS_FILE_NAME = "settings.json";
const OPENCODE_DIR_NAME = ".opencode";
const OPENCODE_TOOLS_DIR_NAME = "tools";
const OPENCODE_TOOL_FILE_NAME = "super-ask.ts";
const VSCODE_HOOKS_RULE_FILE = "super-ask-vscode-hooks.json";
const VSCODE_HOOK_CLI_FILE = "super-ask-vscode-hook.js";
const VSCODE_HOOKS_DEPLOYED_FILE = "super-ask-vscode.json";

function deployPlatformLabel(platform: DeployPlatform): string {
  if (platform === "cursor") return "Cursor";
  if (platform === "vscode") return "Copilot";
  if (platform === "codex") return "Codex";
  if (platform === "opencode") return "OpenCode";
  return "Qwen";
}

/**
 * 向 AGENTS.md 中注入 super-ask 规则（用标记注释包裹），已存在则替换
 */
function injectMarkedBlock(
  existingContent: string,
  rulesContent: string,
  markerBegin: string,
  markerEnd: string
): string {
  const block = `${markerBegin}\n${rulesContent.trim()}\n${markerEnd}`;
  const beginIdx = existingContent.indexOf(markerBegin);
  const endIdx = existingContent.indexOf(markerEnd);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    return (
      existingContent.slice(0, beginIdx).trimEnd() +
      "\n\n" +
      block +
      "\n" +
      existingContent.slice(endIdx + markerEnd.length).trimStart()
    ).trim() + "\n";
  }
  const trimmed = existingContent.trim();
  if (!trimmed) return block + "\n";
  return trimmed + "\n\n" + block + "\n";
}

function injectCodexBlock(existingContent: string, rulesContent: string): string {
  return injectMarkedBlock(existingContent, rulesContent, CODEX_MARKER_BEGIN, CODEX_MARKER_END);
}

function injectOpencodeBlock(existingContent: string, rulesContent: string): string {
  return injectMarkedBlock(existingContent, rulesContent, OPENCODE_MARKER_BEGIN, OPENCODE_MARKER_END);
}

/**
 * 从 AGENTS.md 中移除 super-ask 标记注释块
 */
function removeMarkedBlock(content: string, markerBegin: string, markerEnd: string): string {
  const beginIdx = content.indexOf(markerBegin);
  const endIdx = content.indexOf(markerEnd);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return content;
  const before = content.slice(0, beginIdx).trimEnd();
  const after = content.slice(endIdx + markerEnd.length).trimStart();
  if (!before && !after) return "";
  if (!before) return after.trim() + "\n";
  if (!after) return before.trim() + "\n";
  return before + "\n\n" + after.trim() + "\n";
}

function removeCodexBlock(content: string): string {
  return removeMarkedBlock(content, CODEX_MARKER_BEGIN, CODEX_MARKER_END);
}

function removeOpencodeBlock(content: string): string {
  return removeMarkedBlock(content, OPENCODE_MARKER_BEGIN, OPENCODE_MARKER_END);
}

function upsertTopLevelTomlScalar(content: string, key: string, value: string): string {
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, `${key} = ${value}`);
  }

  const line = `${key} = ${value}`;
  const sectionRe = /^\s*\[/m;
  const match = sectionRe.exec(content);
  if (match && match.index !== undefined) {
    const before = content.slice(0, match.index).trimEnd();
    const after = content.slice(match.index);
    return (before ? before + "\n" : "") + line + "\n\n" + after;
  }

  return content.trimEnd() + (content.trim() ? "\n" : "") + line + "\n";
}

function upsertTomlSectionScalar(content: string, section: string, key: string, value: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const sectionHeader = `[${section}]`;

  let sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionStart === -1) {
    const base = normalized.trimEnd();
    const block = `${sectionHeader}\n${key} = ${value}\n`;
    if (!base) return block;
    return `${base}\n\n${block}`;
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return `${lines.join("\n").trimEnd()}\n`;
    }
  }

  lines.splice(sectionEnd, 0, `${key} = ${value}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeQwenContextFileNames(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  }
  throw new Error("context.fileName 必须是字符串或字符串数组");
}

function encodeQwenContextFileNames(names: string[]): string | string[] | undefined {
  if (names.length === 0) {
    return undefined;
  }
  return names.length === 1 ? names[0] : names;
}

function mergeQwenSettingsContent(existingContent: string, contextFileName: string): string {
  const settings = parseJsonObject(existingContent, "Qwen settings.json");
  const contextValue = settings.context;
  if (
    contextValue !== undefined &&
    (!contextValue || Array.isArray(contextValue) || typeof contextValue !== "object")
  ) {
    throw new Error("Qwen settings.json 中的 context 必须是对象");
  }
  const context = contextValue
    ? { ...(contextValue as Record<string, unknown>) }
    : {};
  const existingNames = normalizeQwenContextFileNames(context.fileName);
  const mergedNames = [contextFileName, ...existingNames.filter((name) => name !== contextFileName)];
  context.fileName = encodeQwenContextFileNames(mergedNames);
  settings.context = context;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function stripQwenSettingsContent(existingContent: string, contextFileName: string): string | null {
  const settings = parseJsonObject(existingContent, "Qwen settings.json");
  const contextValue = settings.context;
  if (
    contextValue !== undefined &&
    (!contextValue || Array.isArray(contextValue) || typeof contextValue !== "object")
  ) {
    throw new Error("Qwen settings.json 中的 context 必须是对象");
  }
  if (!contextValue) {
    return Object.keys(settings).length === 0 ? null : `${JSON.stringify(settings, null, 2)}\n`;
  }
  const context = { ...(contextValue as Record<string, unknown>) };
  const filteredNames = normalizeQwenContextFileNames(context.fileName)
    .filter((name) => name !== contextFileName);
  const encoded = encodeQwenContextFileNames(filteredNames);
  if (encoded === undefined) {
    delete context.fileName;
  } else {
    context.fileName = encoded;
  }
  if (Object.keys(context).length === 0) {
    delete settings.context;
  } else {
    settings.context = context;
  }
  return Object.keys(settings).length === 0 ? null : `${JSON.stringify(settings, null, 2)}\n`;
}

function qwenSettingsIncludesContextFile(content: string, contextFileName: string): boolean {
  const settings = parseJsonObject(content, "Qwen settings.json");
  const contextValue = settings.context;
  if (!contextValue || Array.isArray(contextValue) || typeof contextValue !== "object") {
    return false;
  }
  return normalizeQwenContextFileNames((contextValue as Record<string, unknown>).fileName)
    .includes(contextFileName);
}

interface CursorHooksJson {
  version?: number;
  hooks?: Record<string, unknown[]>;
}

interface CodexHooksJson {
  hooks?: Record<string, unknown[]>;
}

function buildSuperAskCursorHook(event: typeof CURSOR_HOOK_EVENTS[number], cliPath: string): Record<string, unknown> {
  const hook: Record<string, unknown> = {
    _id: CURSOR_HOOKS_MARKER,
    type: "command",
    command: `node "${cliPath}" --cursor-hook`,
    timeout: 86400,
  };
  if (event === "stop") {
    hook.loop_limit = 3;
    hook.failClosed = true;
  }
  return hook;
}

function isSuperAskHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const h = hook as Record<string, unknown>;
  if (h._id === CURSOR_HOOKS_MARKER || h._id === LEGACY_CURSOR_HOOKS_MARKER) return true;
  if (typeof h.command === "string" && h.command.includes("super-ask-cursor.js")) return true;
  if (typeof h.prompt === "string" && h.prompt.includes("super-ask")) return true;
  return false;
}

function mergeCursorHooks(existing: string, cliPath: string): string {
  let config: CursorHooksJson;
  try {
    config = existing.trim() ? JSON.parse(existing) as CursorHooksJson : {};
  } catch {
    config = {};
  }
  if (!config.version) config.version = 1;
  if (!config.hooks) config.hooks = {};
  for (const event of CURSOR_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    config.hooks[event] = config.hooks[event].filter((h) => !isSuperAskHook(h));
    config.hooks[event].push(buildSuperAskCursorHook(event, cliPath));
  }
  return JSON.stringify(config, null, 2) + "\n";
}

function stripCursorHooks(existing: string): string | null {
  let config: CursorHooksJson;
  try {
    config = JSON.parse(existing) as CursorHooksJson;
  } catch {
    return null;
  }
  if (!config.hooks || typeof config.hooks !== "object") return null;
  let modified = false;
  for (const [event, hooks] of Object.entries(config.hooks)) {
    if (!Array.isArray(hooks)) continue;
    const filtered = hooks.filter((h) => !isSuperAskHook(h));
    if (filtered.length !== hooks.length) {
      config.hooks[event] = filtered;
      modified = true;
    }
  }
  if (!modified) return null;
  for (const [event, hooks] of Object.entries(config.hooks)) {
    if (Array.isArray(hooks) && hooks.length === 0) delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) return "";
  return JSON.stringify(config, null, 2) + "\n";
}

function buildSuperAskCodexHook(eventName: typeof CODEX_HOOK_EVENTS[number], cliPath: string): Record<string, unknown> {
  return {
    _id: CODEX_HOOKS_MARKER,
    type: "command",
    command: `node "${cliPath}" --codex-hook`,
    timeout: eventName === "Stop" ? 86400 : 30,
  };
}

function buildSuperAskCodexHookGroup(
  eventName: typeof CODEX_HOOK_EVENTS[number],
  cliPath: string,
): Record<string, unknown> {
  const matcher = eventName === "SessionStart"
    ? "startup|resume"
    : (eventName === "PreToolUse" || eventName === "PostToolUse")
      ? "Bash"
      : null;

  return {
    ...(matcher ? { matcher } : {}),
    hooks: [buildSuperAskCodexHook(eventName, cliPath)],
  };
}

function isSuperAskCodexHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const h = hook as Record<string, unknown>;
  if (h._id === CODEX_HOOKS_MARKER) return true;
  if (h._id === LEGACY_CODEX_STOP_HOOKS_MARKER) return true;
  return typeof h.command === "string"
    && (h.command.includes("--codex-hook") || h.command.includes("--codex-stop-hook"));
}

function mergeCodexHooks(existing: string, cliPath: string): string {
  let config: CodexHooksJson;
  try {
    config = existing.trim() ? JSON.parse(existing) as CodexHooksJson : {};
  } catch {
    config = {};
  }
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  for (const eventName of CODEX_HOOK_EVENTS) {
    const entries = Array.isArray(config.hooks[eventName]) ? [...config.hooks[eventName]!] : [];
    const cleanedEntries = entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const group = entry as Record<string, unknown>;
        const hooks = Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isSuperAskCodexHook(hook)) : [];
        return { ...group, hooks };
      })
      .filter((entry) => {
        if (!entry || typeof entry !== "object") return true;
        const hooks = (entry as Record<string, unknown>).hooks;
        return !Array.isArray(hooks) || hooks.length > 0;
      });

    cleanedEntries.push(buildSuperAskCodexHookGroup(eventName, cliPath));
    config.hooks[eventName] = cleanedEntries;
  }
  return JSON.stringify(config, null, 2) + "\n";
}

function stripCodexHooks(existing: string): string | null {
  let config: CodexHooksJson;
  try {
    config = JSON.parse(existing) as CodexHooksJson;
  } catch {
    return null;
  }
  if (!config.hooks || typeof config.hooks !== "object") return null;

  let modified = false;
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    const nextEntries = entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const group = entry as Record<string, unknown>;
        if (!Array.isArray(group.hooks)) return entry;
        const filteredHooks = group.hooks.filter((hook) => !isSuperAskCodexHook(hook));
        if (filteredHooks.length !== group.hooks.length) {
          modified = true;
        }
        return { ...group, hooks: filteredHooks };
      })
      .filter((entry) => {
        if (!entry || typeof entry !== "object") return true;
        const hooks = (entry as Record<string, unknown>).hooks;
        return !Array.isArray(hooks) || hooks.length > 0;
      });

    if (nextEntries.length !== entries.length) {
      modified = true;
    }
    config.hooks[event] = nextEntries;
  }

  if (!modified) return null;
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (Array.isArray(entries) && entries.length === 0) delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) return "";
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * 将规则文件部署到 Cursor / VSCode / Codex（工作区或用户全局），或卸载与清理全局配置
 */
export class DeployManager {
  /** super-ask 项目根目录（含 rules/） */
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /** 执行单步：pending → running → success | failed，失败写入 detail，不向外抛错 */
  private async runStep(
    steps: DeployStep[],
    id: string,
    name: string,
    action: (step: DeployStep) => Promise<void>,
    detail?: string
  ): Promise<void> {
    const step: DeployStep = { id, name, status: "pending", detail };
    steps.push(step);
    step.status = "running";
    try {
      await action(step);
      step.status = "success";
    } catch (e) {
      step.status = "failed";
      const errMsg = e instanceof Error ? e.message : String(e);
      step.detail = step.detail ? `${step.detail}\n${errMsg}` : errMsg;
    }
  }

  private appendStepDetail(step: DeployStep, extra: string): void {
    step.detail = step.detail ? `${step.detail}\n${extra}` : extra;
  }

  private async reserveBackupPath(targetPath: string): Promise<string> {
    const stamp = formatBackupTimestamp();
    let attempt = 0;
    while (true) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const candidate = `${targetPath}.backup-${stamp}${suffix}`;
      try {
        await stat(candidate);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return candidate;
        throw e;
      }
      attempt += 1;
    }
  }

  private async backupFileIfExists(targetPath: string, step: DeployStep): Promise<string | null> {
    let content: Buffer;
    try {
      content = await readFile(targetPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw e;
    }

    const backupPath = await this.reserveBackupPath(targetPath);
    await writeFile(backupPath, content);
    this.appendStepDetail(step, `backup: ${backupPath}`);
    return backupPath;
  }

  private async writeFileWithBackup(
    step: DeployStep,
    targetPath: string,
    content: string,
  ): Promise<void> {
    await this.backupFileIfExists(targetPath, step);
    await writeFileContent(targetPath, content);
  }

  private async unlinkWithBackup(step: DeployStep, targetPath: string): Promise<void> {
    await this.backupFileIfExists(targetPath, step);
    await unlink(targetPath);
  }

  private rulesPath(name: string): string {
    return join(this.projectRoot, "rules", name);
  }

  private cliPath(fileName = DEFAULT_CLI_FILE): string {
    return join(this.projectRoot, "cli", fileName);
  }

  private renderRuleTemplate(content: string, cliPath = this.cliPath()): string {
    const replacements = new Map<string, string>([
      ["{{SUPER_ASK_ROOT}}", this.projectRoot],
      ["{{SUPER_ASK_CLI}}", cliPath],
      ["{{SUPER_ASK_CURSOR_CLI}}", this.cliPath("super-ask-cursor.js")],
      ["{{SUPER_ASK_VSCODE_HOOK_CLI}}", this.cliPath(VSCODE_HOOK_CLI_FILE)],
      ["{{SUPER_ASK_INSTALL_SH}}", join(this.projectRoot, "install.sh")],
    ]);

    let rendered = content;
    for (const [key, value] of replacements) {
      rendered = rendered.split(key).join(value);
    }
    return rendered;
  }

  private async readRenderedRule(name: string): Promise<string> {
    const raw = await readFileContent(this.rulesPath(name));
    const cliPath = name === "super-ask-codex.md"
      ? this.cliPath(CODEX_CLI_FILE)
      : name === VSCODE_HOOKS_RULE_FILE
        ? this.cliPath(VSCODE_HOOK_CLI_FILE)
      : this.cliPath();
    return this.renderRuleTemplate(raw, cliPath);
  }

  private async writeQwenSettings(settingsPath: string, step: DeployStep): Promise<void> {
    let existing = "";
    try {
      existing = await readFileContent(settingsPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
    await this.writeFileWithBackup(
      step,
      settingsPath,
      mergeQwenSettingsContent(existing, QWEN_CONTEXT_FILE_NAME)
    );
  }

  private async cleanupQwenSettings(settingsPath: string, step: DeployStep): Promise<void> {
    let existing: string;
    try {
      existing = await readFileContent(settingsPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
    const next = stripQwenSettingsContent(existing, QWEN_CONTEXT_FILE_NAME);
    if (next === null) {
      await this.unlinkWithBackup(step, settingsPath);
      return;
    }
    await this.writeFileWithBackup(step, settingsPath, next);
  }

  private async verifyQwenSettings(settingsPath: string): Promise<void> {
    const content = await readFileContent(settingsPath);
    if (!qwenSettingsIncludesContextFile(content, QWEN_CONTEXT_FILE_NAME)) {
      throw new Error("Qwen settings.json 未启用 super-ask-qwen.md");
    }
  }

  private async verifyQwenSettingsRemoved(settingsPath: string): Promise<void> {
    try {
      const content = await readFileContent(settingsPath);
      if (qwenSettingsIncludesContextFile(content, QWEN_CONTEXT_FILE_NAME)) {
        throw new Error("Qwen settings.json 中仍引用 super-ask-qwen.md");
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      if (e instanceof Error && e.message.includes("super-ask-qwen.md")) throw e;
      throw e;
    }
  }

  /**
   * 部署到 Cursor：.cursor/rules/ 下 super-ask.mdc（源文件 super-ask-cursor.mdc）
   */
  async deployCursor(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const rulesDir = join(root, ".cursor", "rules");
    const dest = join(rulesDir, "super-ask.mdc");
    const src = this.rulesPath("super-ask-cursor.mdc");

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "create_rules_dir", "创建 .cursor/rules 目录", async () => {
      await mkdir(rulesDir, { recursive: true });
    }, rulesDir);

    await this.runStep(steps, "copy_rules", "复制 super-ask.mdc", async (step) => {
      const rendered = await this.readRenderedRule("super-ask-cursor.mdc");
      await this.writeFileWithBackup(step, dest, ensureTrailingNewline(rendered));
    }, `${src} → ${dest}`);

    await this.runStep(steps, "clean_legacy", "清理旧版 super-ask-cursor.mdc", async (step) => {
      try { await this.unlinkWithBackup(step, join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
    }, join(rulesDir, "super-ask-cursor.mdc"));

    await this.runStep(steps, "verify", "验证 Cursor 规则文件已写入", async () => {
      await stat(dest);
    }, dest);

    const hooksFile = join(root, ".cursor", "hooks.json");
    const cliPath = join(this.projectRoot, "cli", "super-ask-cursor.js");

    await this.runStep(steps, "deploy_hooks", "部署 Cursor hooks.json（全事件 hook）", async (step) => {
      let existing = "";
      try { existing = await readFileContent(hooksFile); } catch { /* 不存在 */ }
      await this.writeFileWithBackup(step, hooksFile, mergeCursorHooks(existing, cliPath));
    }, hooksFile);

    return steps;
  }

  /**
   * 部署到 VSCode Copilot（工作区级）：.copilot/instructions/super-ask.instructions.md
   */
  async deployVscode(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const copilotDir = join(root, ".copilot", "instructions");
    const destFile = join(copilotDir, "super-ask.instructions.md");
    const githubHooksDir = join(root, ".github", "hooks");
    const hooksFile = join(githubHooksDir, VSCODE_HOOKS_DEPLOYED_FILE);
    const srcVscodeRules = this.rulesPath("super-ask-copilot.md");
    const srcVscodeHooks = this.rulesPath(VSCODE_HOOKS_RULE_FILE);

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "create_copilot_dir", "创建 .copilot/instructions 目录", async () => {
      await mkdir(copilotDir, { recursive: true });
    }, copilotDir);

    await this.runStep(steps, "create_github_hooks_dir", "创建 .github/hooks 目录", async () => {
      await mkdir(githubHooksDir, { recursive: true });
    }, githubHooksDir);

    await this.runStep(steps, "deploy_instructions", "部署 super-ask.instructions.md", async (step) => {
      const renderedRules = await this.readRenderedRule("super-ask-copilot.md");
      await this.writeFileWithBackup(step, destFile, ensureTrailingNewline(renderedRules.trimEnd()));
    }, `${srcVscodeRules} → ${destFile}`);

    await this.runStep(steps, "deploy_vscode_hooks", "部署 VS Code Copilot hooks 配置", async (step) => {
      const renderedHooks = await this.readRenderedRule(VSCODE_HOOKS_RULE_FILE);
      await this.writeFileWithBackup(step, hooksFile, ensureTrailingNewline(renderedHooks.trimEnd()));
    }, `${srcVscodeHooks} → ${hooksFile}`);

    await this.runStep(steps, "verify", "验证 Copilot 规则文件与 hook 配置已写入", async () => {
      await stat(destFile);
      await stat(hooksFile);
    }, `${destFile}\n${hooksFile}`);

    return steps;
  }

  /**
   * Cursor 用户级（全局）部署：写入 ~/.cursor/rules/ 下 super-ask.mdc（源文件 super-ask-cursor.mdc）
   */
  async deployCursorUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const rulesDir = join(homedir(), ".cursor", "rules");
    const dest = join(rulesDir, "super-ask.mdc");
    const src = this.rulesPath("super-ask-cursor.mdc");

    await this.runStep(steps, "create_rules_dir_user", "创建用户级 .cursor/rules 目录", async () => {
      await mkdir(rulesDir, { recursive: true });
    }, rulesDir);

    await this.runStep(steps, "copy_rules_user", "复制 super-ask.mdc（用户级）", async (step) => {
      const rendered = await this.readRenderedRule("super-ask-cursor.mdc");
      await this.writeFileWithBackup(step, dest, ensureTrailingNewline(rendered));
    }, `${src} → ${dest}`);

    await this.runStep(steps, "clean_legacy_user", "清理旧版 super-ask-cursor.mdc", async (step) => {
      try { await this.unlinkWithBackup(step, join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
    }, join(rulesDir, "super-ask-cursor.mdc"));

    await this.runStep(steps, "verify_user", "验证 Cursor 用户级规则文件已写入", async () => {
      await stat(dest);
    }, dest);

    const hooksFile = join(homedir(), ".cursor", "hooks.json");
    const cliPath = join(this.projectRoot, "cli", "super-ask-cursor.js");

    await this.runStep(steps, "deploy_hooks_user", "部署用户级 Cursor hooks.json（全事件 hook）", async (step) => {
      let existing = "";
      try { existing = await readFileContent(hooksFile); } catch { /* 不存在 */ }
      await this.writeFileWithBackup(step, hooksFile, mergeCursorHooks(existing, cliPath));
    }, hooksFile);

    return steps;
  }

  /**
   * VSCode 用户级（全局）部署：写入 ~/.copilot/instructions/super-ask.instructions.md
   * VSCode 2026.2+ 支持从 ~/.copilot/instructions/ 读取自定义指令
   */
  async deployVscodeUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const copilotDir = join(homedir(), ".copilot", "instructions");
    const destFile = join(copilotDir, "super-ask.instructions.md");
    const hooksDir = join(homedir(), ".copilot", "hooks");
    const hooksFile = join(hooksDir, VSCODE_HOOKS_DEPLOYED_FILE);
    const srcVscodeRules = this.rulesPath("super-ask-copilot.md");
    const srcVscodeHooks = this.rulesPath(VSCODE_HOOKS_RULE_FILE);

    await this.runStep(steps, "create_copilot_dir_user", "创建用户级 ~/.copilot/instructions 目录", async () => {
      await mkdir(copilotDir, { recursive: true });
    }, copilotDir);

    await this.runStep(steps, "create_copilot_hooks_dir_user", "创建用户级 ~/.copilot/hooks 目录", async () => {
      await mkdir(hooksDir, { recursive: true });
    }, hooksDir);

    await this.runStep(steps, "deploy_instructions_user", "部署 super-ask.instructions.md", async (step) => {
      const renderedRules = await this.readRenderedRule("super-ask-copilot.md");
      await this.writeFileWithBackup(step, destFile, ensureTrailingNewline(renderedRules.trimEnd()));
    }, `${srcVscodeRules} → ${destFile}`);

    await this.runStep(steps, "deploy_vscode_hooks_user", "部署用户级 VS Code Copilot hooks 配置", async (step) => {
      const renderedHooks = await this.readRenderedRule(VSCODE_HOOKS_RULE_FILE);
      await this.writeFileWithBackup(step, hooksFile, ensureTrailingNewline(renderedHooks.trimEnd()));
    }, `${srcVscodeHooks} → ${hooksFile}`);

    await this.runStep(steps, "verify_user_vscode", "验证 super-ask.instructions.md 与 hook 配置已写入", async () => {
      await stat(destFile);
      await stat(hooksFile);
    }, `${destFile}\n${hooksFile}`);

    return steps;
  }

  /**
   * Codex 用户级（全局）部署：向 ~/.codex/AGENTS.md 中注入 super-ask 标记块
   */
  async deployCodexUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const codexDir = join(homedir(), ".codex");
    const agentsMd = join(codexDir, "AGENTS.md");
    const configToml = join(codexDir, "config.toml");
    const hooksFile = join(codexDir, "hooks.json");
    const src = this.rulesPath("super-ask-codex.md");
    const cliPath = this.cliPath(CODEX_CLI_FILE);

    await this.runStep(steps, "ensure_codex_dir", "确认 ~/.codex 目录存在", async () => {
      await mkdir(codexDir, { recursive: true });
    }, codexDir);

    await this.runStep(steps, "inject_codex_rules", "注入 super-ask 规则到 AGENTS.md", async (step) => {
      const rulesContent = await this.readRenderedRule("super-ask-codex.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectCodexBlock(existing, rulesContent);
      await this.writeFileWithBackup(step, agentsMd, updated);
    }, agentsMd);

    await this.runStep(steps, "set_background_timeout", "设置 config.toml 中的 Codex 终端超时键为 86400000", async (step) => {
      let content = "";
      try {
        content = await readFileContent(configToml);
      } catch { /* 文件不存在 */ }
      content = upsertTopLevelTomlScalar(content, "background_terminal_max_timeout", "86400000");
      content = upsertTopLevelTomlScalar(content, "background_terminal_timeout", "86400000");
      content = upsertTomlSectionScalar(content, "features", "codex_hooks", "true");
      await this.writeFileWithBackup(step, configToml, content);
    }, configToml);

    await this.runStep(steps, "deploy_codex_hooks", "部署 ~/.codex/hooks.json 中的 super-ask Codex hooks", async (step) => {
      let existing = "";
      try {
        existing = await readFileContent(hooksFile);
      } catch { /* 文件不存在 */ }
      await this.writeFileWithBackup(step, hooksFile, mergeCodexHooks(existing, cliPath));
    }, hooksFile);

    await this.runStep(steps, "verify_codex_user", "验证 AGENTS.md 包含 super-ask 标记", async () => {
      const content = await readFileContent(agentsMd);
      if (!content.includes(CODEX_MARKER_BEGIN)) {
        throw new Error("AGENTS.md 中未找到 super-ask 标记");
      }
    }, agentsMd);

    await this.runStep(steps, "verify_codex_hooks", "验证 Codex hooks.json 已启用 super-ask Codex hooks", async () => {
      const content = await readFileContent(hooksFile);
      if (!content.includes(CODEX_HOOKS_MARKER)) {
        throw new Error("hooks.json 中未找到 super-ask Codex hook");
      }
    }, hooksFile);

    return steps;
  }

  /**
   * Codex 项目级部署：向 <project>/AGENTS.md 中注入 super-ask 标记块
   */
  async deployCodex(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const agentsMd = join(root, "AGENTS.md");
    const configToml = join(homedir(), ".codex", "config.toml");
    const hooksFile = join(homedir(), ".codex", "hooks.json");
    const src = this.rulesPath("super-ask-codex.md");
    const cliPath = this.cliPath(CODEX_CLI_FILE);

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "inject_codex_rules", "注入 super-ask 规则到 AGENTS.md", async (step) => {
      const rulesContent = await this.readRenderedRule("super-ask-codex.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectCodexBlock(existing, rulesContent);
      await this.writeFileWithBackup(step, agentsMd, updated);
    }, agentsMd);

    await this.runStep(steps, "enable_codex_hooks_feature", "确保 ~/.codex/config.toml 中启用 codex_hooks", async (step) => {
      await mkdir(join(homedir(), ".codex"), { recursive: true });
      let content = "";
      try {
        content = await readFileContent(configToml);
      } catch { /* 文件不存在 */ }
      content = upsertTomlSectionScalar(content, "features", "codex_hooks", "true");
      await this.writeFileWithBackup(step, configToml, content);
    }, configToml);

    await this.runStep(steps, "deploy_codex_hooks_shared", "确保 ~/.codex/hooks.json 中已安装 super-ask Codex hooks", async (step) => {
      await mkdir(join(homedir(), ".codex"), { recursive: true });
      let existing = "";
      try {
        existing = await readFileContent(hooksFile);
      } catch { /* 文件不存在 */ }
      await this.writeFileWithBackup(step, hooksFile, mergeCodexHooks(existing, cliPath));
    }, hooksFile);

    await this.runStep(steps, "verify_codex", "验证 AGENTS.md 包含 super-ask 标记", async () => {
      const content = await readFileContent(agentsMd);
      if (!content.includes(CODEX_MARKER_BEGIN)) {
        throw new Error("AGENTS.md 中未找到 super-ask 标记");
      }
    }, agentsMd);

    await this.runStep(steps, "verify_codex_hooks_shared", "验证共享 Codex hooks.json 已启用 super-ask Codex hooks", async () => {
      const content = await readFileContent(hooksFile);
      if (!content.includes(CODEX_HOOKS_MARKER)) {
        throw new Error("共享 hooks.json 中未找到 super-ask Codex hook");
      }
    }, hooksFile);

    return steps;
  }

  /**
   * OpenCode 用户级（全局）部署：~/.config/opencode/AGENTS.md + tools/super-ask.ts
   */
  async deployOpencodeUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const opencodeDir = join(homedir(), ".config", "opencode");
    const toolsDir = join(opencodeDir, OPENCODE_TOOLS_DIR_NAME);
    const agentsMd = join(opencodeDir, "AGENTS.md");
    const toolFile = join(toolsDir, OPENCODE_TOOL_FILE_NAME);
    const srcRules = this.rulesPath("super-ask-opencode.md");
    const srcTool = this.rulesPath("super-ask-opencode-tool.ts");

    await this.runStep(steps, "create_opencode_dir_user", "创建用户级 ~/.config/opencode 目录", async () => {
      await mkdir(opencodeDir, { recursive: true });
    }, opencodeDir);

    await this.runStep(steps, "create_opencode_tools_user", "创建用户级 OpenCode tools 目录", async () => {
      await mkdir(toolsDir, { recursive: true });
    }, toolsDir);

    await this.runStep(steps, "inject_opencode_rules_user", "注入 super-ask 规则到 OpenCode AGENTS.md", async (step) => {
      const rulesContent = await this.readRenderedRule("super-ask-opencode.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectOpencodeBlock(existing, rulesContent);
      await this.writeFileWithBackup(step, agentsMd, updated);
    }, `${srcRules} → ${agentsMd}`);

    await this.runStep(steps, "deploy_opencode_tool_user", "部署用户级 OpenCode super-ask 工具", async (step) => {
      const toolContent = await this.readRenderedRule("super-ask-opencode-tool.ts");
      await this.writeFileWithBackup(step, toolFile, ensureTrailingNewline(toolContent.trimEnd()));
    }, `${srcTool} → ${toolFile}`);

    await this.runStep(steps, "verify_opencode_user", "验证用户级 OpenCode 规则与工具已写入", async () => {
      const content = await readFileContent(agentsMd);
      if (!content.includes(OPENCODE_MARKER_BEGIN)) {
        throw new Error("AGENTS.md 中未找到 super-ask 标记");
      }
      const st = await stat(toolFile);
      if (!st.isFile()) {
        throw new Error("super-ask.ts 未写入");
      }
    }, `${agentsMd}\n${toolFile}`);

    return steps;
  }

  /**
   * OpenCode 项目级部署：<project>/AGENTS.md + .opencode/tools/super-ask.ts
   */
  async deployOpencode(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const opencodeDir = join(root, OPENCODE_DIR_NAME);
    const toolsDir = join(opencodeDir, OPENCODE_TOOLS_DIR_NAME);
    const agentsMd = join(root, "AGENTS.md");
    const toolFile = join(toolsDir, OPENCODE_TOOL_FILE_NAME);
    const srcRules = this.rulesPath("super-ask-opencode.md");
    const srcTool = this.rulesPath("super-ask-opencode-tool.ts");

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "create_opencode_dir", "创建 .opencode 目录", async () => {
      await mkdir(opencodeDir, { recursive: true });
    }, opencodeDir);

    await this.runStep(steps, "create_opencode_tools", "创建 .opencode/tools 目录", async () => {
      await mkdir(toolsDir, { recursive: true });
    }, toolsDir);

    await this.runStep(steps, "inject_opencode_rules", "注入 super-ask 规则到 OpenCode AGENTS.md", async (step) => {
      const rulesContent = await this.readRenderedRule("super-ask-opencode.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectOpencodeBlock(existing, rulesContent);
      await this.writeFileWithBackup(step, agentsMd, updated);
    }, `${srcRules} → ${agentsMd}`);

    await this.runStep(steps, "deploy_opencode_tool", "部署 OpenCode super-ask 工具", async (step) => {
      const toolContent = await this.readRenderedRule("super-ask-opencode-tool.ts");
      await this.writeFileWithBackup(step, toolFile, ensureTrailingNewline(toolContent.trimEnd()));
    }, `${srcTool} → ${toolFile}`);

    await this.runStep(steps, "verify_opencode", "验证 OpenCode 规则与工具已写入", async () => {
      const content = await readFileContent(agentsMd);
      if (!content.includes(OPENCODE_MARKER_BEGIN)) {
        throw new Error("AGENTS.md 中未找到 super-ask 标记");
      }
      const st = await stat(toolFile);
      if (!st.isFile()) {
        throw new Error("super-ask.ts 未写入");
      }
    }, `${agentsMd}\n${toolFile}`);

    return steps;
  }

  /**
   * 部署到 Qwen（工作区级）：<project>/super-ask-qwen.md + .qwen/settings.json
   */
  async deployQwen(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const qwenDir = join(root, QWEN_SETTINGS_DIR_NAME);
    const destFile = join(root, QWEN_CONTEXT_FILE_NAME);
    const settingsPath = join(qwenDir, QWEN_SETTINGS_FILE_NAME);
    const src = this.rulesPath("super-ask-qwen.md");

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "create_qwen_dir", "创建 .qwen 目录", async () => {
      await mkdir(qwenDir, { recursive: true });
    }, qwenDir);

    await this.runStep(steps, "deploy_qwen_rules", "部署 super-ask-qwen.md", async (step) => {
      const rendered = await this.readRenderedRule("super-ask-qwen.md");
      await this.writeFileWithBackup(step, destFile, ensureTrailingNewline(rendered.trimEnd()));
    }, `${src} → ${destFile}`);

    await this.runStep(steps, "update_qwen_settings", "更新 .qwen/settings.json", async (step) => {
      await this.writeQwenSettings(settingsPath, step);
    }, settingsPath);

    await this.runStep(steps, "verify_qwen_rules", "验证 Qwen 规则文件已写入", async () => {
      await stat(destFile);
    }, destFile);

    await this.runStep(steps, "verify_qwen_settings", "验证 Qwen settings 已启用规则文件", async () => {
      await this.verifyQwenSettings(settingsPath);
    }, settingsPath);

    return steps;
  }

  /**
   * 部署到 Qwen（用户级）：~/.qwen/super-ask-qwen.md + ~/.qwen/settings.json
   */
  async deployQwenUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const qwenDir = join(homedir(), QWEN_SETTINGS_DIR_NAME);
    const destFile = join(qwenDir, QWEN_CONTEXT_FILE_NAME);
    const settingsPath = join(qwenDir, QWEN_SETTINGS_FILE_NAME);
    const src = this.rulesPath("super-ask-qwen.md");

    await this.runStep(steps, "create_qwen_dir_user", "创建用户级 ~/.qwen 目录", async () => {
      await mkdir(qwenDir, { recursive: true });
    }, qwenDir);

    await this.runStep(steps, "deploy_qwen_rules_user", "部署用户级 super-ask-qwen.md", async (step) => {
      const rendered = await this.readRenderedRule("super-ask-qwen.md");
      await this.writeFileWithBackup(step, destFile, ensureTrailingNewline(rendered.trimEnd()));
    }, `${src} → ${destFile}`);

    await this.runStep(steps, "update_qwen_settings_user", "更新用户级 ~/.qwen/settings.json", async (step) => {
      await this.writeQwenSettings(settingsPath, step);
    }, settingsPath);

    await this.runStep(steps, "verify_qwen_rules_user", "验证用户级 Qwen 规则文件已写入", async () => {
      await stat(destFile);
    }, destFile);

    await this.runStep(steps, "verify_qwen_settings_user", "验证用户级 Qwen settings 已启用规则文件", async () => {
      await this.verifyQwenSettings(settingsPath);
    }, settingsPath);

    return steps;
  }

  /**
   * 从 Cursor 工作区移除 super-ask 规则文件
   */
  async undeployCursor(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const rulesDir = join(root, ".cursor", "rules");
    const dest = join(rulesDir, "super-ask.mdc");

    await this.runStep(steps, "remove_rules", "删除 super-ask.mdc", async (step) => {
      try { await this.unlinkWithBackup(step, dest); } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, dest);

    await this.runStep(steps, "clean_legacy", "清理旧版 super-ask-cursor.mdc", async (step) => {
      try { await this.unlinkWithBackup(step, join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
    }, join(rulesDir, "super-ask-cursor.mdc"));

    await this.runStep(steps, "verify", "验证 Cursor 规则文件已删除", async () => {
      try {
        await stat(dest);
        throw new Error(`文件仍存在: ${dest}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
    }, dest);

    const hooksFile = join(root, ".cursor", "hooks.json");
    await this.runStep(steps, "remove_hooks", "清理 Cursor hooks.json 中的 super-ask hook", async (step) => {
      let existing: string;
      try { existing = await readFileContent(hooksFile); } catch { return; }
      const result = stripCursorHooks(existing);
      if (result === null) return;
      if (result === "") {
        try { await this.unlinkWithBackup(step, hooksFile); } catch { /* 不存在 */ }
      } else {
        await this.writeFileWithBackup(step, hooksFile, result);
      }
    }, hooksFile);

    return steps;
  }

  /**
   * 从用户主目录 ~/.cursor/rules/ 删除 super-ask 相关 .mdc 文件
   */
  async undeployCursorUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const rulesDir = join(homedir(), ".cursor", "rules");
    const dest = join(rulesDir, "super-ask.mdc");

    await this.runStep(steps, "remove_rules_user", "删除用户级 super-ask.mdc", async (step) => {
      try { await this.unlinkWithBackup(step, dest); } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, dest);

    await this.runStep(steps, "clean_legacy_user", "清理旧版 super-ask-cursor.mdc", async (step) => {
      try { await this.unlinkWithBackup(step, join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
    }, join(rulesDir, "super-ask-cursor.mdc"));

    await this.runStep(steps, "verify_user", "验证 Cursor 用户级规则文件已删除", async () => {
      try {
        await stat(dest);
        throw new Error(`文件仍存在: ${dest}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
    }, dest);

    const hooksFile = join(homedir(), ".cursor", "hooks.json");
    await this.runStep(steps, "remove_hooks_user", "清理用户级 Cursor hooks.json 中的 super-ask hook", async (step) => {
      let existing: string;
      try { existing = await readFileContent(hooksFile); } catch { return; }
      const result = stripCursorHooks(existing);
      if (result === null) return;
      if (result === "") {
        try { await this.unlinkWithBackup(step, hooksFile); } catch { /* 不存在 */ }
      } else {
        await this.writeFileWithBackup(step, hooksFile, result);
      }
    }, hooksFile);

    return steps;
  }

  /**
   * VSCode 用户级卸载：删除 ~/.copilot/instructions/super-ask.instructions.md
   */
  async undeployVscodeUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const destFile = join(homedir(), ".copilot", "instructions", "super-ask.instructions.md");
    const hooksFile = join(homedir(), ".copilot", "hooks", VSCODE_HOOKS_DEPLOYED_FILE);

    await this.runStep(steps, "remove_copilot_instructions_user", "删除 super-ask.instructions.md", async (step) => {
      try {
        await this.unlinkWithBackup(step, destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "remove_copilot_hooks_user", "删除用户级 VS Code Copilot hook 配置", async (step) => {
      try {
        await this.unlinkWithBackup(step, hooksFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, hooksFile);

    await this.runStep(steps, "verify_user_vscode_undeploy", "验证 super-ask 指令文件与 hook 配置已删除", async () => {
      let instructionsMissing = false;
      try {
        await stat(destFile);
        throw new Error(`文件仍存在: ${destFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") instructionsMissing = true;
        else if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
        else throw e;
      }

      let hooksMissing = false;
      try {
        await stat(hooksFile);
        throw new Error(`文件仍存在: ${hooksFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") hooksMissing = true;
        else if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
        else throw e;
      }

      if (!instructionsMissing) {
        throw new Error(`文件仍存在: ${destFile}`);
      }
      if (!hooksMissing) {
        throw new Error(`文件仍存在: ${hooksFile}`);
      }
    }, `${destFile}\n${hooksFile}`);

    return steps;
  }

  /**
   * 从 VSCode Copilot 工作区移除 super-ask 规则文件（.copilot/instructions/）
   */
  async undeployVscode(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const destFile = join(root, ".copilot", "instructions", "super-ask.instructions.md");
    const hooksFile = join(root, ".github", "hooks", VSCODE_HOOKS_DEPLOYED_FILE);

    await this.runStep(steps, "remove_copilot_instructions", "删除 .copilot/instructions/super-ask.instructions.md", async (step) => {
      try {
        await this.unlinkWithBackup(step, destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "remove_vscode_hooks", "删除 .github/hooks 下的 VS Code Copilot hook 配置", async (step) => {
      try {
        await this.unlinkWithBackup(step, hooksFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, hooksFile);

    await this.runStep(steps, "verify", "验证 Copilot 规则文件与 hook 配置已清理", async () => {
      let instructionsMissing = false;
      try {
        await stat(destFile);
        throw new Error(`文件仍存在: ${destFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") instructionsMissing = true;
        else if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
        else throw e;
      }

      let hooksMissing = false;
      try {
        await stat(hooksFile);
        throw new Error(`文件仍存在: ${hooksFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") hooksMissing = true;
        else if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
        else throw e;
      }

      if (!instructionsMissing) {
        throw new Error(`文件仍存在: ${destFile}`);
      }
      if (!hooksMissing) {
        throw new Error(`文件仍存在: ${hooksFile}`);
      }
    }, `${destFile}\n${hooksFile}`);

    return steps;
  }

  /**
   * Codex 用户级卸载：从 ~/.codex/AGENTS.md 中移除 super-ask 标记块
   */
  async undeployCodexUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const agentsMd = join(homedir(), ".codex", "AGENTS.md");
    const hooksFile = join(homedir(), ".codex", "hooks.json");

    await this.runStep(steps, "remove_codex_block_user", "从 AGENTS.md 移除 super-ask 标记块", async (step) => {
      let content: string;
      try {
        content = await readFileContent(agentsMd);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
      if (!content.includes(CODEX_MARKER_BEGIN)) return;
      const updated = removeCodexBlock(content);
      if (!updated.trim()) {
        await this.writeFileWithBackup(step, agentsMd, "");
      } else {
        await this.writeFileWithBackup(step, agentsMd, updated);
      }
    }, agentsMd);

    await this.runStep(steps, "verify_codex_user_undeploy", "验证 super-ask 标记已移除", async () => {
      try {
        const content = await readFileContent(agentsMd);
        if (content.includes(CODEX_MARKER_BEGIN)) {
          throw new Error("AGENTS.md 中仍包含 super-ask 标记");
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        if (e instanceof Error && e.message.includes("super-ask 标记")) throw e;
      }
    }, agentsMd);

    await this.runStep(steps, "remove_codex_hooks_user", "清理 ~/.codex/hooks.json 中的 super-ask Codex hooks", async (step) => {
      let existing: string;
      try {
        existing = await readFileContent(hooksFile);
      } catch { return; }
      const result = stripCodexHooks(existing);
      if (result === null) return;
      if (result === "") {
        try { await this.unlinkWithBackup(step, hooksFile); } catch { /* 不存在 */ }
      } else {
        await this.writeFileWithBackup(step, hooksFile, result);
      }
    }, hooksFile);

    return steps;
  }

  /**
   * Codex 项目级卸载：从 <project>/AGENTS.md 中移除 super-ask 标记块
   */
  async undeployCodex(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const agentsMd = join(root, "AGENTS.md");

    await this.runStep(steps, "remove_codex_block", "从 AGENTS.md 移除 super-ask 标记块", async (step) => {
      let content: string;
      try {
        content = await readFileContent(agentsMd);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
      if (!content.includes(CODEX_MARKER_BEGIN)) return;
      const updated = removeCodexBlock(content);
      if (!updated.trim()) {
        try { await this.unlinkWithBackup(step, agentsMd); } catch { /* 忽略 */ }
      } else {
        await this.writeFileWithBackup(step, agentsMd, updated);
      }
    }, agentsMd);

    await this.runStep(steps, "verify_codex_undeploy", "验证 super-ask 标记已移除", async () => {
      try {
        const content = await readFileContent(agentsMd);
        if (content.includes(CODEX_MARKER_BEGIN)) {
          throw new Error("AGENTS.md 中仍包含 super-ask 标记");
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        if (e instanceof Error && e.message.includes("super-ask 标记")) throw e;
      }
    }, agentsMd);

    return steps;
  }

  /**
   * OpenCode 用户级卸载：移除 ~/.config/opencode/AGENTS.md 中的 super-ask 标记块与 tools/super-ask.ts
   */
  async undeployOpencodeUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const opencodeDir = join(homedir(), ".config", "opencode");
    const agentsMd = join(opencodeDir, "AGENTS.md");
    const toolFile = join(opencodeDir, OPENCODE_TOOLS_DIR_NAME, OPENCODE_TOOL_FILE_NAME);

    await this.runStep(steps, "remove_opencode_block_user", "从 OpenCode AGENTS.md 移除 super-ask 标记块", async (step) => {
      let content: string;
      try {
        content = await readFileContent(agentsMd);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
      if (!content.includes(OPENCODE_MARKER_BEGIN)) return;
      const updated = removeOpencodeBlock(content);
      if (!updated.trim()) {
        await this.writeFileWithBackup(step, agentsMd, "");
      } else {
        await this.writeFileWithBackup(step, agentsMd, updated);
      }
    }, agentsMd);

    await this.runStep(steps, "remove_opencode_tool_user", "删除用户级 OpenCode super-ask 工具", async (step) => {
      try {
        await this.unlinkWithBackup(step, toolFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, toolFile);

    await this.runStep(steps, "verify_opencode_user_undeploy", "验证用户级 OpenCode 规则与工具已移除", async () => {
      try {
        const content = await readFileContent(agentsMd);
        if (content.includes(OPENCODE_MARKER_BEGIN)) {
          throw new Error("AGENTS.md 中仍包含 super-ask 标记");
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          if (e instanceof Error && e.message.includes("super-ask 标记")) throw e;
          throw e;
        }
      }
      try {
        await stat(toolFile);
        throw new Error(`文件仍存在: ${toolFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
        throw e;
      }
    }, `${agentsMd}\n${toolFile}`);

    return steps;
  }

  /**
   * OpenCode 项目级卸载：移除 <project>/AGENTS.md 中的 super-ask 标记块与 .opencode/tools/super-ask.ts
   */
  async undeployOpencode(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const agentsMd = join(root, "AGENTS.md");
    const toolFile = join(root, OPENCODE_DIR_NAME, OPENCODE_TOOLS_DIR_NAME, OPENCODE_TOOL_FILE_NAME);

    await this.runStep(steps, "remove_opencode_block", "从 OpenCode AGENTS.md 移除 super-ask 标记块", async (step) => {
      let content: string;
      try {
        content = await readFileContent(agentsMd);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
      if (!content.includes(OPENCODE_MARKER_BEGIN)) return;
      const updated = removeOpencodeBlock(content);
      if (!updated.trim()) {
        try {
          await this.unlinkWithBackup(step, agentsMd);
        } catch { /* 忽略 */ }
      } else {
        await this.writeFileWithBackup(step, agentsMd, updated);
      }
    }, agentsMd);

    await this.runStep(steps, "remove_opencode_tool", "删除 OpenCode super-ask 工具", async (step) => {
      try {
        await this.unlinkWithBackup(step, toolFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, toolFile);

    await this.runStep(steps, "verify_opencode_undeploy", "验证 OpenCode 规则与工具已移除", async () => {
      try {
        const content = await readFileContent(agentsMd);
        if (content.includes(OPENCODE_MARKER_BEGIN)) {
          throw new Error("AGENTS.md 中仍包含 super-ask 标记");
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          if (e instanceof Error && e.message.includes("super-ask 标记")) throw e;
          throw e;
        }
      }
      try {
        await stat(toolFile);
        throw new Error(`文件仍存在: ${toolFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
        throw e;
      }
    }, `${agentsMd}\n${toolFile}`);

    return steps;
  }

  /**
   * 从 Qwen 工作区移除 super-ask-qwen.md 与 settings 引用
   */
  async undeployQwen(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const destFile = join(root, QWEN_CONTEXT_FILE_NAME);
    const settingsPath = join(root, QWEN_SETTINGS_DIR_NAME, QWEN_SETTINGS_FILE_NAME);

    await this.runStep(steps, "remove_qwen_rules", "删除 super-ask-qwen.md", async (step) => {
      try {
        await this.unlinkWithBackup(step, destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "cleanup_qwen_settings", "清理 .qwen/settings.json 中的 super-ask-qwen.md 引用", async (step) => {
      await this.cleanupQwenSettings(settingsPath, step);
    }, settingsPath);

    await this.runStep(steps, "verify_qwen_rules_removed", "验证 Qwen 规则文件已删除", async () => {
      try {
        await stat(destFile);
        throw new Error(`文件仍存在: ${destFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
    }, destFile);

    await this.runStep(steps, "verify_qwen_settings_removed", "验证 Qwen settings 已移除规则引用", async () => {
      await this.verifyQwenSettingsRemoved(settingsPath);
    }, settingsPath);

    return steps;
  }

  /**
   * 从用户主目录 ~/.qwen/ 删除 super-ask-qwen.md 与 settings 引用
   */
  async undeployQwenUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const qwenDir = join(homedir(), QWEN_SETTINGS_DIR_NAME);
    const destFile = join(qwenDir, QWEN_CONTEXT_FILE_NAME);
    const settingsPath = join(qwenDir, QWEN_SETTINGS_FILE_NAME);

    await this.runStep(steps, "remove_qwen_rules_user", "删除用户级 super-ask-qwen.md", async (step) => {
      try {
        await this.unlinkWithBackup(step, destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "cleanup_qwen_settings_user", "清理用户级 ~/.qwen/settings.json 中的 super-ask-qwen.md 引用", async (step) => {
      await this.cleanupQwenSettings(settingsPath, step);
    }, settingsPath);

    await this.runStep(steps, "verify_qwen_rules_user_removed", "验证用户级 Qwen 规则文件已删除", async () => {
      try {
        await stat(destFile);
        throw new Error(`文件仍存在: ${destFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        throw e;
      }
    }, destFile);

    await this.runStep(steps, "verify_qwen_settings_user_removed", "验证用户级 Qwen settings 已移除规则引用", async () => {
      await this.verifyQwenSettingsRemoved(settingsPath);
    }, settingsPath);

    return steps;
  }

  /**
   * 清理 ~/.super-ask/ 下的会话、日志、配置与 PID（不停止当前 server 进程）
   */
  async cleanGlobalConfig(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];

    steps.push({
      id: "stop_server",
      name: "停止 server",
      status: "skipped",
      detail: "当前 HTTP 进程即为 super-ask server，跳过停止服务",
    });

    const sessionsPath = join(SUPER_ASK_DIR, "sessions.json");
    const logsDir = join(SUPER_ASK_DIR, "logs");
    const configPath = join(SUPER_ASK_DIR, "config.json");
    const pidPath = join(SUPER_ASK_DIR, "super-ask.pid");

    await this.runStep(steps, "remove_sessions", "删除 sessions.json", async () => {
      try {
        await unlink(sessionsPath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, sessionsPath);

    await this.runStep(steps, "remove_logs", "删除 logs 目录", async () => {
      await rm(logsDir, { recursive: true, force: true });
    }, logsDir);

    await this.runStep(steps, "remove_config", "删除 config.json", async () => {
      try {
        await unlink(configPath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, configPath);

    await this.runStep(steps, "remove_pid", "删除 super-ask.pid", async () => {
      try {
        await unlink(pidPath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, pidPath);

    return steps;
  }

  /**
   * 探测指定范围下各平台是否已部署规则文件
   * @param workspacePath workspace 模式下为工作区根路径；user 模式下忽略
   * @param scope user 时检查 ~/.cursor/rules/ 与 ~/.github/copilot-instructions.md 中的 super-ask 区块；workspace 时检查给定路径
   */
  async checkStatus(
    workspacePath: string,
    scope: DeployScope = "workspace"
  ): Promise<DeployStatusResponse> {
    const deployed: DeployStatusResponse["deployed"] = [];

    if (scope === "user") {
      const home = homedir();

      const cursorDir = join(home, ".cursor", "rules");
      const cursorHooks = join(home, ".cursor", "hooks.json");
      const cursorFiles: string[] = [];
      for (const name of ["super-ask.mdc"]) {
        const p = join(cursorDir, name);
        try {
          const s = await stat(p);
          if (s.isFile()) cursorFiles.push(name);
        } catch {
          /* 忽略 */
        }
      }
      try {
        const hooksContent = await readFileContent(cursorHooks);
        if (hooksContent.includes(CURSOR_HOOKS_MARKER) || hooksContent.includes(LEGACY_CURSOR_HOOKS_MARKER)) {
          cursorFiles.push("hooks.json");
        }
      } catch {
        /* 忽略 */
      }
      if (cursorFiles.length > 0) {
        deployed.push({
          platform: "cursor",
          workspacePath: cursorDir,
          rulesFiles: cursorFiles,
        });
      }

      const vscodeFiles: string[] = [];
      const copilotDir = join(home, ".copilot", "instructions");
      const copilotFile = join(copilotDir, "super-ask.instructions.md");
      const hooksFile = join(home, ".copilot", "hooks", VSCODE_HOOKS_DEPLOYED_FILE);
      try {
        const st = await stat(copilotFile);
        if (st.isFile()) vscodeFiles.push("super-ask.instructions.md");
      } catch { /* 不存在 */ }
      try {
        const st = await stat(hooksFile);
        if (st.isFile()) vscodeFiles.push(VSCODE_HOOKS_DEPLOYED_FILE);
      } catch { /* 不存在 */ }
      const legacyPath = join(home, ".github", "copilot-instructions.md");
      try {
        const st = await stat(legacyPath);
        if (st.isFile()) {
          const content = await readFileContent(legacyPath);
          if (content.includes("<!-- super-ask:begin -->")) {
            vscodeFiles.push("copilot-instructions.md (legacy)");
          }
        }
      } catch { /* 不存在 */ }
      if (vscodeFiles.length > 0) {
        deployed.push({
          platform: "vscode",
          workspacePath: copilotDir,
          rulesFiles: vscodeFiles,
        });
      }

      const codexDir = join(home, ".codex");
      const codexAgentsMd = join(codexDir, "AGENTS.md");
      const codexHooks = join(codexDir, "hooks.json");
      try {
        const content = await readFileContent(codexAgentsMd);
        if (content.includes(CODEX_MARKER_BEGIN)) {
          const rulesFiles = ["AGENTS.md"];
          try {
            const hooksContent = await readFileContent(codexHooks);
            if (hooksContent.includes(CODEX_HOOKS_MARKER)) {
              rulesFiles.push("hooks.json");
            }
          } catch { /* 不存在 */ }
          deployed.push({
            platform: "codex",
            workspacePath: codexDir,
            rulesFiles,
          });
        }
      } catch { /* 不存在 */ }

      const opencodeDir = join(home, ".config", "opencode");
      const opencodeAgentsMd = join(opencodeDir, "AGENTS.md");
      const opencodeTool = join(opencodeDir, OPENCODE_TOOLS_DIR_NAME, OPENCODE_TOOL_FILE_NAME);
      try {
        const content = await readFileContent(opencodeAgentsMd);
        const toolStat = await stat(opencodeTool);
        if (content.includes(OPENCODE_MARKER_BEGIN) && toolStat.isFile()) {
          deployed.push({
            platform: "opencode",
            workspacePath: opencodeDir,
            rulesFiles: ["AGENTS.md", `${OPENCODE_TOOLS_DIR_NAME}/${OPENCODE_TOOL_FILE_NAME}`],
          });
        }
      } catch { /* 不存在 */ }

      const qwenDir = join(home, QWEN_SETTINGS_DIR_NAME);
      const qwenFile = join(qwenDir, QWEN_CONTEXT_FILE_NAME);
      const qwenSettings = join(qwenDir, QWEN_SETTINGS_FILE_NAME);
      try {
        const st = await stat(qwenFile);
        if (st.isFile()) {
          const settings = await readFileContent(qwenSettings);
          if (qwenSettingsIncludesContextFile(settings, QWEN_CONTEXT_FILE_NAME)) {
            deployed.push({
              platform: "qwen",
              workspacePath: qwenDir,
              rulesFiles: [QWEN_CONTEXT_FILE_NAME, QWEN_SETTINGS_FILE_NAME],
            });
          }
        }
      } catch { /* 不存在或未启用 */ }

      return { deployed };
    }

    const trimmed = workspacePath.trim();
    if (!trimmed) {
      return { deployed };
    }

    const root = resolve(trimmed);
    try {
      const st = await stat(root);
      if (!st.isDirectory()) {
        return { deployed };
      }
    } catch {
      return { deployed };
    }

    const cursorFiles: string[] = [];
    const cursorDir = join(root, ".cursor", "rules");
    const cursorHooks = join(root, ".cursor", "hooks.json");
    for (const name of ["super-ask.mdc"]) {
      const p = join(cursorDir, name);
      try {
        const s = await stat(p);
        if (s.isFile()) cursorFiles.push(name);
      } catch {
        /* 忽略 */
      }
    }
    try {
      const hooksContent = await readFileContent(cursorHooks);
      if (hooksContent.includes(CURSOR_HOOKS_MARKER) || hooksContent.includes(LEGACY_CURSOR_HOOKS_MARKER)) {
        cursorFiles.push("hooks.json");
      }
    } catch {
      /* 忽略 */
    }
    if (cursorFiles.length > 0) {
      deployed.push({
        platform: "cursor",
        workspacePath: root,
        rulesFiles: cursorFiles,
      });
    }

    const vscodeFiles: string[] = [];
    const copilotDir = join(root, ".copilot", "instructions");
    const copilotFile = join(copilotDir, "super-ask.instructions.md");
    const hooksFile = join(root, ".github", "hooks", VSCODE_HOOKS_DEPLOYED_FILE);
    try {
      const st = await stat(copilotFile);
      if (st.isFile()) vscodeFiles.push("super-ask.instructions.md");
    } catch { /* 不存在 */ }
    try {
      const st = await stat(hooksFile);
      if (st.isFile()) vscodeFiles.push(`.github/hooks/${VSCODE_HOOKS_DEPLOYED_FILE}`);
    } catch { /* 不存在 */ }
    const githubDir = join(root, ".github");
    const legacyInstructions = join(githubDir, "copilot-instructions.md");
    try {
      const content = await readFileContent(legacyInstructions);
      if (content.includes("<!-- super-ask:begin -->")) {
        vscodeFiles.push("copilot-instructions.md (legacy)");
      }
    } catch { /* 忽略 */ }
    try {
      const st = await stat(join(githubDir, "super-ask-copilot.md"));
      if (st.isFile()) vscodeFiles.push("super-ask-copilot.md (legacy)");
    } catch { /* 忽略 */ }
    if (vscodeFiles.length > 0) {
      deployed.push({
        platform: "vscode",
        workspacePath: copilotDir,
        rulesFiles: vscodeFiles,
      });
    }

    const codexAgentsMd = join(root, "AGENTS.md");
    const sharedCodexHooks = join(homedir(), ".codex", "hooks.json");
    try {
      const content = await readFileContent(codexAgentsMd);
      if (content.includes(CODEX_MARKER_BEGIN)) {
        const rulesFiles = ["AGENTS.md"];
        try {
          const hooksContent = await readFileContent(sharedCodexHooks);
          if (hooksContent.includes(CODEX_HOOKS_MARKER)) {
            rulesFiles.push("~/.codex/hooks.json");
          }
        } catch { /* 不存在 */ }
        deployed.push({
          platform: "codex",
          workspacePath: root,
          rulesFiles,
        });
      }
    } catch { /* 不存在 */ }

    const opencodeAgentsMd = join(root, "AGENTS.md");
    const opencodeTool = join(root, OPENCODE_DIR_NAME, OPENCODE_TOOLS_DIR_NAME, OPENCODE_TOOL_FILE_NAME);
    try {
      const content = await readFileContent(opencodeAgentsMd);
      const toolStat = await stat(opencodeTool);
      if (content.includes(OPENCODE_MARKER_BEGIN) && toolStat.isFile()) {
        deployed.push({
          platform: "opencode",
          workspacePath: root,
          rulesFiles: ["AGENTS.md", `${OPENCODE_DIR_NAME}/${OPENCODE_TOOLS_DIR_NAME}/${OPENCODE_TOOL_FILE_NAME}`],
        });
      }
    } catch { /* 不存在 */ }

    const qwenFile = join(root, QWEN_CONTEXT_FILE_NAME);
    const qwenSettings = join(root, QWEN_SETTINGS_DIR_NAME, QWEN_SETTINGS_FILE_NAME);
    try {
      const st = await stat(qwenFile);
      if (st.isFile()) {
        const settings = await readFileContent(qwenSettings);
        if (qwenSettingsIncludesContextFile(settings, QWEN_CONTEXT_FILE_NAME)) {
          deployed.push({
            platform: "qwen",
            workspacePath: root,
            rulesFiles: [QWEN_CONTEXT_FILE_NAME, `${QWEN_SETTINGS_DIR_NAME}/${QWEN_SETTINGS_FILE_NAME}`],
          });
        }
      }
    } catch { /* 不存在或未启用 */ }

    return { deployed };
  }

  /** 一键部署：按 scope 选择工作区或用户全局，再按平台依次执行 */
  async deploy(req: DeployRequest): Promise<DeployResponse> {
    const steps: DeployStep[] = [];
    const seen = new Set<DeployPlatform>();
    const scope = req.scope ?? "workspace";
    const platforms = req.platforms.filter((platform) => {
      if (seen.has(platform)) return false;
      seen.add(platform);
      return true;
    });

    for (const p of platforms) {
      steps.push({
        id: `group:deploy:${p}`,
        name: deployPlatformLabel(p),
        status: "success",
      });
      if (scope === "user") {
        if (p === "cursor") {
          steps.push(...(await this.deployCursorUser()));
        } else if (p === "vscode") {
          steps.push(...(await this.deployVscodeUser()));
        } else if (p === "codex") {
          steps.push(...(await this.deployCodexUser()));
        } else if (p === "opencode") {
          steps.push(...(await this.deployOpencodeUser()));
        } else if (p === "qwen") {
          steps.push(...(await this.deployQwenUser()));
        }
      } else {
        if (p === "cursor") {
          steps.push(...(await this.deployCursor(req.workspacePath)));
        } else if (p === "vscode") {
          steps.push(...(await this.deployVscode(req.workspacePath)));
        } else if (p === "codex") {
          steps.push(...(await this.deployCodex(req.workspacePath)));
        } else if (p === "opencode") {
          steps.push(...(await this.deployOpencode(req.workspacePath)));
        } else if (p === "qwen") {
          steps.push(...(await this.deployQwen(req.workspacePath)));
        }
      }
    }

    const success = !steps.some((s) => s.status === "failed");
    return { success, steps };
  }

  /** 一键卸载：按 scope 与平台移除规则；可选清理全局配置 */
  async undeploy(req: UndeployRequest): Promise<UndeployResponse> {
    const steps: DeployStep[] = [];
    const seen = new Set<DeployPlatform>();
    const scope = req.scope ?? "workspace";
    const platforms = req.platforms.filter((platform) => {
      if (seen.has(platform)) return false;
      seen.add(platform);
      return true;
    });

    for (const p of platforms) {
      steps.push({
        id: `group:undeploy:${p}`,
        name: deployPlatformLabel(p),
        status: "success",
      });
      if (scope === "user") {
        if (p === "cursor") {
          steps.push(...(await this.undeployCursorUser()));
        } else if (p === "vscode") {
          steps.push(...(await this.undeployVscodeUser()));
        } else if (p === "codex") {
          steps.push(...(await this.undeployCodexUser()));
        } else if (p === "opencode") {
          steps.push(...(await this.undeployOpencodeUser()));
        } else if (p === "qwen") {
          steps.push(...(await this.undeployQwenUser()));
        }
      } else {
        if (p === "cursor") {
          steps.push(...(await this.undeployCursor(req.workspacePath)));
        } else if (p === "vscode") {
          steps.push(...(await this.undeployVscode(req.workspacePath)));
        } else if (p === "codex") {
          steps.push(...(await this.undeployCodex(req.workspacePath)));
        } else if (p === "opencode") {
          steps.push(...(await this.undeployOpencode(req.workspacePath)));
        } else if (p === "qwen") {
          steps.push(...(await this.undeployQwen(req.workspacePath)));
        }
      }
    }

    if (req.cleanConfig) {
      steps.push(...(await this.cleanGlobalConfig()));
    }

    const success = !steps.some((s) => s.status === "failed");
    return { success, steps };
  }
}
