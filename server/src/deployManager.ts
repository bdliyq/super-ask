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
const CURSOR_HOOKS_MARKER = "super-ask-stop-hook";

const QWEN_CONTEXT_FILE_NAME = "super-ask-qwen.md";
const QWEN_SETTINGS_DIR_NAME = ".qwen";
const QWEN_SETTINGS_FILE_NAME = "settings.json";
const OPENCODE_DIR_NAME = ".opencode";
const OPENCODE_TOOLS_DIR_NAME = "tools";
const OPENCODE_TOOL_FILE_NAME = "super-ask.ts";

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

function buildSuperAskStopHook(cliPath: string): Record<string, unknown> {
  const prompt =
    `检查 agent 在本轮工作中是否通过终端执行了 super-ask CLI 命令（python3 ${cliPath}）来与用户通信。\n\n` +
    `判断规则：\n` +
    `1. 如果 agent 执行了 super-ask 命令并收到了用户反馈 → 允许停止，不返回任何内容\n` +
    `2. 如果 agent 正在执行用户任务（非子代理/subagent）但没有调用 super-ask 就要停止 → 必须返回 followup_message 提醒 agent 调用 super-ask\n` +
    `3. 如果 agent 是子代理（subagent）或者本轮没有执行任何实质任务 → 允许停止\n\n` +
    `followup_message 格式：\n` +
    `"你还没有通过 super-ask 工具向用户汇报本轮工作结果。请立即调用 super-ask CLI (python3 ${cliPath}) 汇报结果并等待用户反馈。如果有 SUPER_ASK_SID 环境变量，使用 --session-id 传入。"\n\n` +
    `Hook input: $ARGUMENTS`;
  return {
    _id: CURSOR_HOOKS_MARKER,
    type: "prompt",
    prompt,
    loop_limit: 3,
    timeout: 15,
  };
}

function isSuperAskHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const h = hook as Record<string, unknown>;
  if (h._id === CURSOR_HOOKS_MARKER) return true;
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
  if (!Array.isArray(config.hooks.stop)) config.hooks.stop = [];
  config.hooks.stop = config.hooks.stop.filter((h) => !isSuperAskHook(h));
  config.hooks.stop.push(buildSuperAskStopHook(cliPath));
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
    action: () => Promise<void>,
    detail?: string
  ): Promise<void> {
    const step: DeployStep = { id, name, status: "pending", detail };
    steps.push(step);
    step.status = "running";
    try {
      await action();
      step.status = "success";
    } catch (e) {
      step.status = "failed";
      const errMsg = e instanceof Error ? e.message : String(e);
      step.detail = detail ? `${detail}\n${errMsg}` : errMsg;
    }
  }

  private rulesPath(name: string): string {
    return join(this.projectRoot, "rules", name);
  }

  private renderRuleTemplate(content: string): string {
    const replacements = new Map<string, string>([
      ["{{SUPER_ASK_ROOT}}", this.projectRoot],
      ["{{SUPER_ASK_CLI}}", join(this.projectRoot, "cli", "super-ask.py")],
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
    return this.renderRuleTemplate(raw);
  }

  private async writeQwenSettings(settingsPath: string): Promise<void> {
    let existing = "";
    try {
      existing = await readFileContent(settingsPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
    await writeFileContent(
      settingsPath,
      mergeQwenSettingsContent(existing, QWEN_CONTEXT_FILE_NAME)
    );
  }

  private async cleanupQwenSettings(settingsPath: string): Promise<void> {
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
      await unlink(settingsPath);
      return;
    }
    await writeFileContent(settingsPath, next);
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

    await this.runStep(steps, "copy_rules", "复制 super-ask.mdc", async () => {
      const rendered = await this.readRenderedRule("super-ask-cursor.mdc");
      await writeFileContent(dest, ensureTrailingNewline(rendered));
    }, `${src} → ${dest}`);

    await this.runStep(steps, "clean_legacy", "清理旧版 super-ask-cursor.mdc", async () => {
      try { await unlink(join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
    }, join(rulesDir, "super-ask-cursor.mdc"));

    await this.runStep(steps, "verify", "验证 Cursor 规则文件已写入", async () => {
      await stat(dest);
    }, dest);

    const hooksFile = join(root, ".cursor", "hooks.json");
    const cliPath = join(this.projectRoot, "cli", "super-ask.py");

    await this.runStep(steps, "deploy_hooks", "部署 Cursor hooks.json（stop hook）", async () => {
      let existing = "";
      try { existing = await readFileContent(hooksFile); } catch { /* 不存在 */ }
      await writeFileContent(hooksFile, mergeCursorHooks(existing, cliPath));
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
    const srcVscodeRules = this.rulesPath("super-ask-copilot.md");

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "create_copilot_dir", "创建 .copilot/instructions 目录", async () => {
      await mkdir(copilotDir, { recursive: true });
    }, copilotDir);

    await this.runStep(steps, "deploy_instructions", "部署 super-ask.instructions.md", async () => {
      const renderedRules = await this.readRenderedRule("super-ask-copilot.md");
      await writeFileContent(destFile, ensureTrailingNewline(renderedRules.trimEnd()));
    }, `${srcVscodeRules} → ${destFile}`);

    await this.runStep(steps, "verify", "验证 Copilot 规则文件已写入", async () => {
      await stat(destFile);
    }, destFile);

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

    await this.runStep(steps, "copy_rules_user", "复制 super-ask.mdc（用户级）", async () => {
      const rendered = await this.readRenderedRule("super-ask-cursor.mdc");
      await writeFileContent(dest, ensureTrailingNewline(rendered));
    }, `${src} → ${dest}`);

    await this.runStep(steps, "clean_legacy_user", "清理旧版 super-ask-cursor.mdc", async () => {
      try { await unlink(join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
    }, join(rulesDir, "super-ask-cursor.mdc"));

    await this.runStep(steps, "verify_user", "验证 Cursor 用户级规则文件已写入", async () => {
      await stat(dest);
    }, dest);

    const hooksFile = join(homedir(), ".cursor", "hooks.json");
    const cliPath = join(this.projectRoot, "cli", "super-ask.py");

    await this.runStep(steps, "deploy_hooks_user", "部署用户级 Cursor hooks.json（stop hook）", async () => {
      let existing = "";
      try { existing = await readFileContent(hooksFile); } catch { /* 不存在 */ }
      await writeFileContent(hooksFile, mergeCursorHooks(existing, cliPath));
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
    const srcVscodeRules = this.rulesPath("super-ask-copilot.md");

    await this.runStep(steps, "create_copilot_dir_user", "创建用户级 ~/.copilot/instructions 目录", async () => {
      await mkdir(copilotDir, { recursive: true });
    }, copilotDir);

    await this.runStep(steps, "deploy_instructions_user", "部署 super-ask.instructions.md", async () => {
      const renderedRules = await this.readRenderedRule("super-ask-copilot.md");
      await writeFileContent(destFile, ensureTrailingNewline(renderedRules.trimEnd()));
    }, `${srcVscodeRules} → ${destFile}`);

    await this.runStep(steps, "verify_user_vscode", "验证 super-ask.instructions.md 已写入", async () => {
      await stat(destFile);
    }, destFile);

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
    const src = this.rulesPath("super-ask-codex.md");

    await this.runStep(steps, "ensure_codex_dir", "确认 ~/.codex 目录存在", async () => {
      await mkdir(codexDir, { recursive: true });
    }, codexDir);

    await this.runStep(steps, "inject_codex_rules", "注入 super-ask 规则到 AGENTS.md", async () => {
      const rulesContent = await this.readRenderedRule("super-ask-codex.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectCodexBlock(existing, rulesContent);
      await writeFileContent(agentsMd, updated);
    }, agentsMd);

    await this.runStep(steps, "set_background_timeout", "设置 config.toml 中的 Codex 终端超时键为 86400000", async () => {
      let content = "";
      try {
        content = await readFileContent(configToml);
      } catch { /* 文件不存在 */ }
      content = upsertTopLevelTomlScalar(content, "background_terminal_max_timeout", "86400000");
      content = upsertTopLevelTomlScalar(content, "background_terminal_timeout", "86400000");
      await writeFileContent(configToml, content);
    }, configToml);

    await this.runStep(steps, "verify_codex_user", "验证 AGENTS.md 包含 super-ask 标记", async () => {
      const content = await readFileContent(agentsMd);
      if (!content.includes(CODEX_MARKER_BEGIN)) {
        throw new Error("AGENTS.md 中未找到 super-ask 标记");
      }
    }, agentsMd);

    return steps;
  }

  /**
   * Codex 项目级部署：向 <project>/AGENTS.md 中注入 super-ask 标记块
   */
  async deployCodex(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const agentsMd = join(root, "AGENTS.md");
    const src = this.rulesPath("super-ask-codex.md");

    await this.runStep(steps, "check_workspace", "检查工作区路径是否存在", async () => {
      const st = await stat(root);
      if (!st.isDirectory()) {
        throw new Error("路径存在但不是目录");
      }
    }, root);

    await this.runStep(steps, "inject_codex_rules", "注入 super-ask 规则到 AGENTS.md", async () => {
      const rulesContent = await this.readRenderedRule("super-ask-codex.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectCodexBlock(existing, rulesContent);
      await writeFileContent(agentsMd, updated);
    }, agentsMd);

    await this.runStep(steps, "verify_codex", "验证 AGENTS.md 包含 super-ask 标记", async () => {
      const content = await readFileContent(agentsMd);
      if (!content.includes(CODEX_MARKER_BEGIN)) {
        throw new Error("AGENTS.md 中未找到 super-ask 标记");
      }
    }, agentsMd);

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

    await this.runStep(steps, "inject_opencode_rules_user", "注入 super-ask 规则到 OpenCode AGENTS.md", async () => {
      const rulesContent = await this.readRenderedRule("super-ask-opencode.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectOpencodeBlock(existing, rulesContent);
      await writeFileContent(agentsMd, updated);
    }, `${srcRules} → ${agentsMd}`);

    await this.runStep(steps, "deploy_opencode_tool_user", "部署用户级 OpenCode super-ask 工具", async () => {
      const toolContent = await this.readRenderedRule("super-ask-opencode-tool.ts");
      await writeFileContent(toolFile, ensureTrailingNewline(toolContent.trimEnd()));
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

    await this.runStep(steps, "inject_opencode_rules", "注入 super-ask 规则到 OpenCode AGENTS.md", async () => {
      const rulesContent = await this.readRenderedRule("super-ask-opencode.md");
      let existing = "";
      try {
        existing = await readFileContent(agentsMd);
      } catch { /* 文件不存在 */ }
      const updated = injectOpencodeBlock(existing, rulesContent);
      await writeFileContent(agentsMd, updated);
    }, `${srcRules} → ${agentsMd}`);

    await this.runStep(steps, "deploy_opencode_tool", "部署 OpenCode super-ask 工具", async () => {
      const toolContent = await this.readRenderedRule("super-ask-opencode-tool.ts");
      await writeFileContent(toolFile, ensureTrailingNewline(toolContent.trimEnd()));
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

    await this.runStep(steps, "deploy_qwen_rules", "部署 super-ask-qwen.md", async () => {
      const rendered = await this.readRenderedRule("super-ask-qwen.md");
      await writeFileContent(destFile, ensureTrailingNewline(rendered.trimEnd()));
    }, `${src} → ${destFile}`);

    await this.runStep(steps, "update_qwen_settings", "更新 .qwen/settings.json", async () => {
      await this.writeQwenSettings(settingsPath);
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

    await this.runStep(steps, "deploy_qwen_rules_user", "部署用户级 super-ask-qwen.md", async () => {
      const rendered = await this.readRenderedRule("super-ask-qwen.md");
      await writeFileContent(destFile, ensureTrailingNewline(rendered.trimEnd()));
    }, `${src} → ${destFile}`);

    await this.runStep(steps, "update_qwen_settings_user", "更新用户级 ~/.qwen/settings.json", async () => {
      await this.writeQwenSettings(settingsPath);
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

    await this.runStep(steps, "remove_rules", "删除 super-ask.mdc", async () => {
      try { await unlink(dest); } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, dest);

    await this.runStep(steps, "clean_legacy", "清理旧版 super-ask-cursor.mdc", async () => {
      try { await unlink(join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
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
    await this.runStep(steps, "remove_hooks", "清理 Cursor hooks.json 中的 super-ask hook", async () => {
      let existing: string;
      try { existing = await readFileContent(hooksFile); } catch { return; }
      const result = stripCursorHooks(existing);
      if (result === null) return;
      if (result === "") {
        try { await unlink(hooksFile); } catch { /* 不存在 */ }
      } else {
        await writeFileContent(hooksFile, result);
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

    await this.runStep(steps, "remove_rules_user", "删除用户级 super-ask.mdc", async () => {
      try { await unlink(dest); } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, dest);

    await this.runStep(steps, "clean_legacy_user", "清理旧版 super-ask-cursor.mdc", async () => {
      try { await unlink(join(rulesDir, "super-ask-cursor.mdc")); } catch { /* 不存在 */ }
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
    await this.runStep(steps, "remove_hooks_user", "清理用户级 Cursor hooks.json 中的 super-ask hook", async () => {
      let existing: string;
      try { existing = await readFileContent(hooksFile); } catch { return; }
      const result = stripCursorHooks(existing);
      if (result === null) return;
      if (result === "") {
        try { await unlink(hooksFile); } catch { /* 不存在 */ }
      } else {
        await writeFileContent(hooksFile, result);
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

    await this.runStep(steps, "remove_copilot_instructions_user", "删除 super-ask.instructions.md", async () => {
      try {
        await unlink(destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "verify_user_vscode_undeploy", "验证 super-ask 指令文件已删除", async () => {
      try {
        await stat(destFile);
        throw new Error(`文件仍存在: ${destFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
      }
    }, destFile);

    return steps;
  }

  /**
   * 从 VSCode Copilot 工作区移除 super-ask 规则文件（.copilot/instructions/）
   */
  async undeployVscode(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const destFile = join(root, ".copilot", "instructions", "super-ask.instructions.md");

    await this.runStep(steps, "remove_copilot_instructions", "删除 .copilot/instructions/super-ask.instructions.md", async () => {
      try {
        await unlink(destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "verify", "验证 Copilot 规则文件已清理", async () => {
      try {
        await stat(destFile);
        throw new Error(`文件仍存在: ${destFile}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return;
        if (e instanceof Error && e.message.startsWith("文件仍存在")) throw e;
      }
    }, destFile);

    return steps;
  }

  /**
   * Codex 用户级卸载：从 ~/.codex/AGENTS.md 中移除 super-ask 标记块
   */
  async undeployCodexUser(): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const agentsMd = join(homedir(), ".codex", "AGENTS.md");

    await this.runStep(steps, "remove_codex_block_user", "从 AGENTS.md 移除 super-ask 标记块", async () => {
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
        await writeFileContent(agentsMd, "");
      } else {
        await writeFileContent(agentsMd, updated);
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

    return steps;
  }

  /**
   * Codex 项目级卸载：从 <project>/AGENTS.md 中移除 super-ask 标记块
   */
  async undeployCodex(workspacePath: string): Promise<DeployStep[]> {
    const steps: DeployStep[] = [];
    const root = resolve(workspacePath);
    const agentsMd = join(root, "AGENTS.md");

    await this.runStep(steps, "remove_codex_block", "从 AGENTS.md 移除 super-ask 标记块", async () => {
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
        try { await unlink(agentsMd); } catch { /* 忽略 */ }
      } else {
        await writeFileContent(agentsMd, updated);
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

    await this.runStep(steps, "remove_opencode_block_user", "从 OpenCode AGENTS.md 移除 super-ask 标记块", async () => {
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
        await writeFileContent(agentsMd, "");
      } else {
        await writeFileContent(agentsMd, updated);
      }
    }, agentsMd);

    await this.runStep(steps, "remove_opencode_tool_user", "删除用户级 OpenCode super-ask 工具", async () => {
      try {
        await unlink(toolFile);
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

    await this.runStep(steps, "remove_opencode_block", "从 OpenCode AGENTS.md 移除 super-ask 标记块", async () => {
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
          await unlink(agentsMd);
        } catch { /* 忽略 */ }
      } else {
        await writeFileContent(agentsMd, updated);
      }
    }, agentsMd);

    await this.runStep(steps, "remove_opencode_tool", "删除 OpenCode super-ask 工具", async () => {
      try {
        await unlink(toolFile);
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

    await this.runStep(steps, "remove_qwen_rules", "删除 super-ask-qwen.md", async () => {
      try {
        await unlink(destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "cleanup_qwen_settings", "清理 .qwen/settings.json 中的 super-ask-qwen.md 引用", async () => {
      await this.cleanupQwenSettings(settingsPath);
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

    await this.runStep(steps, "remove_qwen_rules_user", "删除用户级 super-ask-qwen.md", async () => {
      try {
        await unlink(destFile);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
    }, destFile);

    await this.runStep(steps, "cleanup_qwen_settings_user", "清理用户级 ~/.qwen/settings.json 中的 super-ask-qwen.md 引用", async () => {
      await this.cleanupQwenSettings(settingsPath);
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
      try {
        const st = await stat(copilotFile);
        if (st.isFile()) vscodeFiles.push("super-ask.instructions.md");
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
      try {
        const content = await readFileContent(codexAgentsMd);
        if (content.includes(CODEX_MARKER_BEGIN)) {
          deployed.push({
            platform: "codex",
            workspacePath: codexDir,
            rulesFiles: ["AGENTS.md"],
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
    for (const name of ["super-ask.mdc"]) {
      const p = join(cursorDir, name);
      try {
        const s = await stat(p);
        if (s.isFile()) cursorFiles.push(name);
      } catch {
        /* 忽略 */
      }
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
    try {
      const st = await stat(copilotFile);
      if (st.isFile()) vscodeFiles.push("super-ask.instructions.md");
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
    try {
      const content = await readFileContent(codexAgentsMd);
      if (content.includes(CODEX_MARKER_BEGIN)) {
        deployed.push({
          platform: "codex",
          workspacePath: root,
          rulesFiles: ["AGENTS.md"],
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
