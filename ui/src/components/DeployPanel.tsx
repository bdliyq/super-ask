import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeployPlatform, DeployScope, DeployStatusResponse } from "@shared/types";
import { withAuthHeaders } from "../auth";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";

/** 单平台部署探测结果（与 DeployStatusResponse.deployed 元素一致） */
type DeployStatusEntry = DeployStatusResponse["deployed"][number];

/** 单步执行状态 */
interface DeployStep {
  id: string;
  name: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  detail?: string;
}

/** 部署/卸载接口返回 */
interface DeployResponse {
  success: boolean;
  steps: DeployStep[];
}

const DEPLOY_STEP_NAME_EN: Record<string, string> = {
  "检查工作区路径是否存在": "Check workspace path",
  "创建 .cursor/rules 目录": "Create .cursor/rules directory",
  "复制 super-ask.mdc": "Copy super-ask.mdc",
  "清理旧版 super-ask-cursor.mdc": "Clean legacy super-ask-cursor.mdc",
  "验证 Cursor 规则文件已写入": "Verify Cursor rule file was written",
  "创建 .copilot/instructions 目录": "Create .copilot/instructions directory",
  "部署 super-ask.instructions.md": "Deploy super-ask.instructions.md",
  "验证 Copilot 规则文件已写入": "Verify Copilot rule file was written",
  "创建用户级 .cursor/rules 目录": "Create user-level .cursor/rules directory",
  "复制 super-ask.mdc（用户级）": "Copy super-ask.mdc (user-level)",
  "验证 Cursor 用户级规则文件已写入": "Verify Cursor user-level rule file was written",
  "创建用户级 ~/.copilot/instructions 目录": "Create user-level ~/.copilot/instructions directory",
  "验证 super-ask.instructions.md 已写入": "Verify super-ask.instructions.md was written",
  "确认 ~/.codex 目录存在": "Ensure ~/.codex directory exists",
  "注入 super-ask 规则到 AGENTS.md": "Inject super-ask rules into AGENTS.md",
  "设置 config.toml 中的 Codex 终端超时键为 86400000": "Set Codex terminal timeout keys in config.toml to 86400000",
  "验证 AGENTS.md 包含 super-ask 标记": "Verify AGENTS.md includes the super-ask marker",
  "创建用户级 ~/.config/opencode 目录": "Create user-level ~/.config/opencode directory",
  "创建用户级 OpenCode tools 目录": "Create user-level OpenCode tools directory",
  "注入 super-ask 规则到 OpenCode AGENTS.md": "Inject super-ask rules into OpenCode AGENTS.md",
  "部署用户级 OpenCode super-ask 工具": "Deploy user-level OpenCode super-ask tool",
  "验证用户级 OpenCode 规则与工具已写入": "Verify user-level OpenCode rules and tool were written",
  "创建 .opencode 目录": "Create .opencode directory",
  "创建 .opencode/tools 目录": "Create .opencode/tools directory",
  "部署 OpenCode super-ask 工具": "Deploy OpenCode super-ask tool",
  "验证 OpenCode 规则与工具已写入": "Verify OpenCode rules and tool were written",
  "创建 .qwen 目录": "Create .qwen directory",
  "部署 super-ask-qwen.md": "Deploy super-ask-qwen.md",
  "更新 .qwen/settings.json": "Update .qwen/settings.json",
  "验证 Qwen 规则文件已写入": "Verify Qwen rule file was written",
  "验证 Qwen settings 已启用规则文件": "Verify Qwen settings enabled the rule file",
  "创建用户级 ~/.qwen 目录": "Create user-level ~/.qwen directory",
  "部署用户级 super-ask-qwen.md": "Deploy user-level super-ask-qwen.md",
  "更新用户级 ~/.qwen/settings.json": "Update user-level ~/.qwen/settings.json",
  "验证用户级 Qwen 规则文件已写入": "Verify user-level Qwen rule file was written",
  "验证用户级 Qwen settings 已启用规则文件": "Verify user-level Qwen settings enabled the rule file",
  "删除 super-ask.mdc": "Delete super-ask.mdc",
  "验证 Cursor 规则文件已删除": "Verify Cursor rule file was deleted",
  "删除用户级 super-ask.mdc": "Delete user-level super-ask.mdc",
  "验证 Cursor 用户级规则文件已删除": "Verify Cursor user-level rule file was deleted",
  "删除 super-ask.instructions.md": "Delete super-ask.instructions.md",
  "验证 super-ask 指令文件已删除": "Verify super-ask instructions file was deleted",
  "删除 .copilot/instructions/super-ask.instructions.md": "Delete .copilot/instructions/super-ask.instructions.md",
  "验证 Copilot 规则文件已清理": "Verify Copilot rule file was cleaned up",
  "从 AGENTS.md 移除 super-ask 标记块": "Remove super-ask marker block from AGENTS.md",
  "验证 super-ask 标记已移除": "Verify super-ask marker was removed",
  "从 OpenCode AGENTS.md 移除 super-ask 标记块": "Remove super-ask marker block from OpenCode AGENTS.md",
  "删除用户级 OpenCode super-ask 工具": "Delete user-level OpenCode super-ask tool",
  "验证用户级 OpenCode 规则与工具已移除": "Verify user-level OpenCode rules and tool were removed",
  "删除 OpenCode super-ask 工具": "Delete OpenCode super-ask tool",
  "验证 OpenCode 规则与工具已移除": "Verify OpenCode rules and tool were removed",
  "删除 super-ask-qwen.md": "Delete super-ask-qwen.md",
  "清理 .qwen/settings.json 中的 super-ask-qwen.md 引用": "Remove super-ask-qwen.md reference from .qwen/settings.json",
  "验证 Qwen 规则文件已删除": "Verify Qwen rule file was deleted",
  "验证 Qwen settings 已移除规则引用": "Verify Qwen settings no longer reference the rule file",
  "删除用户级 super-ask-qwen.md": "Delete user-level super-ask-qwen.md",
  "清理用户级 ~/.qwen/settings.json 中的 super-ask-qwen.md 引用": "Remove super-ask-qwen.md reference from user-level ~/.qwen/settings.json",
  "验证用户级 Qwen 规则文件已删除": "Verify user-level Qwen rule file was deleted",
  "验证用户级 Qwen settings 已移除规则引用": "Verify user-level Qwen settings no longer reference the rule file",
  "停止 server": "Stop server",
  "删除 sessions.json": "Delete sessions.json",
  "删除 logs 目录": "Delete logs directory",
  "删除 config.json": "Delete config.json",
  "删除 super-ask.pid": "Delete super-ask.pid",
};

const DEPLOY_STEP_ID_LABELS: Partial<Record<DeployStep["id"], Record<Locale, string>>> = {
  "client:request": {
    zh: "正在连接服务器并执行…",
    en: "Connecting to server…",
  },
  "client:parse": {
    zh: "解析响应失败",
    en: "Failed to parse response",
  },
  "client:http": {
    zh: "请求失败",
    en: "Request failed",
  },
  "client:empty": {
    zh: "服务器未返回步骤详情",
    en: "Server returned no step details",
  },
  "client:network": {
    zh: "网络或跨域错误",
    en: "Network or CORS error",
  },
};

const DEPLOY_STEP_DETAIL_EN_FRAGMENTS: Record<string, string> = {
  "当前 HTTP 进程即为 super-ask server，跳过停止服务":
    "The current HTTP process is the super-ask server, so stopping it is skipped",
  "路径存在但不是目录": "Path exists but is not a directory",
  "Qwen settings.json 未启用 super-ask-qwen.md":
    "Qwen settings.json does not enable super-ask-qwen.md",
  "Qwen settings.json 中仍引用 super-ask-qwen.md":
    "Qwen settings.json still references super-ask-qwen.md",
  "AGENTS.md 中未找到 super-ask 标记":
    "AGENTS.md does not contain the super-ask marker",
  "super-ask.ts 未写入": "super-ask.ts was not written",
  "文件仍存在:": "File still exists:",
  "AGENTS.md 中仍包含 super-ask 标记":
    "AGENTS.md still contains the super-ask marker",
  "Qwen settings.json 不是有效 JSON": "Qwen settings.json is not valid JSON",
  "Qwen settings.json 必须是 JSON 对象": "Qwen settings.json must be a JSON object",
  "Qwen settings.json 中的 context 必须是对象":
    "context in Qwen settings.json must be an object",
  "context.fileName 必须是字符串或字符串数组":
    "context.fileName must be a string or an array of strings",
};

export function getDeployStepDisplayName(
  step: Pick<DeployStep, "id" | "name">,
  locale: Locale,
): string {
  const byId = DEPLOY_STEP_ID_LABELS[step.id];
  if (byId) {
    return byId[locale];
  }
  if (locale === "zh") {
    return step.name;
  }
  return DEPLOY_STEP_NAME_EN[step.name] ?? step.name;
}

export function getDeployStepDisplayDetail(
  detail: string | undefined,
  locale: Locale,
): string | undefined {
  if (!detail || locale === "zh") {
    return detail;
  }

  let translated = detail;
  for (const [zh, en] of Object.entries(DEPLOY_STEP_DETAIL_EN_FRAGMENTS)) {
    translated = translated.split(zh).join(en);
  }
  return translated;
}

/**
 * 根据选中的平台生成请求体中的 platforms 数组（二者都选即「全部」）
 */
function platformsPayload(
  cursor: boolean,
  vscode: boolean,
  codex: boolean,
  opencode: boolean,
  qwen: boolean,
): DeployPlatform[] {
  const list: DeployPlatform[] = [];
  if (cursor) list.push("cursor");
  if (vscode) list.push("vscode");
  if (codex) list.push("codex");
  if (opencode) list.push("opencode");
  if (qwen) list.push("qwen");
  return list;
}

/**
 * 分组标题行：id 以 group: 开头时仅渲染分隔标题，不显示状态图标
 */
function isGroupDivider(step: DeployStep): boolean {
  return step.id.startsWith("group:");
}

/**
 * 部署管理：工作区路径、平台多选、一键部署/卸载、步骤状态展示（无独立顶栏，由 SettingsPanel 承载）
 */
export function DeployPanel() {
  const { t, locale } = useI18n();

  /** 部署范围：默认 user，避免未填工作区路径时按钮长期不可用 */
  const [scope, setScope] = useState<DeployScope>("user");
  const [workspacePath, setWorkspacePath] = useState("");
  const [cursorChecked, setCursorChecked] = useState(true);
  const [vscodeChecked, setVscodeChecked] = useState(true);
  const [codexChecked, setCodexChecked] = useState(true);
  const [opencodeChecked, setOpencodeChecked] = useState(true);
  const [qwenChecked, setQwenChecked] = useState(true);
  const [cleanConfig, setCleanConfig] = useState(false);
  const [steps, setSteps] = useState<DeployStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /** 服务端返回的各平台已部署文件列表 */
  const [deployStatus, setDeployStatus] = useState<DeployStatusEntry[]>([]);

  const platforms = useMemo(
    () => platformsPayload(cursorChecked, vscodeChecked, codexChecked, opencodeChecked, qwenChecked),
    [cursorChecked, vscodeChecked, codexChecked, opencodeChecked, qwenChecked],
  );

  /**
   * 部署/卸载是否可点：user 仅需至少选一个平台；workspace 还需非空工作区路径
   */
  const canSubmit =
    platforms.length > 0 &&
    (scope === "user" || workspacePath.trim().length > 0) &&
    !busy;

  /** 用于手动触发状态刷新的计数器 */
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  /** 随工作区路径、范围或 refreshKey 变化时拉取当前安装状态 */
  useEffect(() => {
    const workspace = scope === "user" ? "" : workspacePath.trim();
    if (scope === "workspace" && !workspace) {
      setDeployStatus([]);
      return;
    }
    const abortCtrl = new AbortController();
    const qs = new URLSearchParams({
      workspace,
      scope,
    });
    fetch(`/api/deploy/status?${qs.toString()}`, {
      signal: abortCtrl.signal,
      headers: withAuthHeaders(),
    })
      .then((r) => r.json())
      .then((data: DeployStatusResponse) => {
        setDeployStatus(Array.isArray(data.deployed) ? data.deployed : []);
      })
      .catch(() => {
        /* 取消或网络错误时忽略 */
      });
    return () => abortCtrl.abort();
  }, [workspacePath, scope, statusRefreshKey]);

  const runRequest = useCallback(
    async (path: "/api/deploy" | "/api/undeploy", body: Record<string, unknown>) => {
      setLastError(null);
      setBusy(true);
      // 先展示「正在请求」步骤，收到响应后替换为服务端返回的完整步骤列表
      setSteps([
        {
          id: "client:request",
          name: t.deployConnecting,
          status: "running",
        },
      ]);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: withAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let data: DeployResponse | null = null;
        try {
          data = text ? (JSON.parse(text) as DeployResponse) : null;
        } catch {
          setLastError(t.deployInvalidJson.replace("{status}", String(res.status)));
          setSteps([
            {
              id: "client:parse",
              name: t.deployParseFailed,
              status: "failed",
              detail: text.slice(0, 200),
            },
          ]);
          return;
        }
        if (!res.ok) {
          const msg =
            data && typeof data === "object" && "error" in data
              ? String((data as { error?: string }).error)
              : `HTTP ${res.status}`;
          setLastError(msg);
          if (data?.steps?.length) {
            setSteps(data.steps);
          } else {
            setSteps([
              {
                id: "client:http",
                name: t.deployRequestFailed,
                status: "failed",
                detail: msg,
              },
            ]);
          }
          return;
        }
        if (data?.steps?.length) {
          setSteps(data.steps);
        } else {
          setSteps([
            {
              id: "client:empty",
              name: t.deployNoServerSteps,
              status: data?.success ? "success" : "failed",
            },
          ]);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setLastError(message);
        setSteps([
          {
            id: "client:network",
            name: t.deployNetworkOrCors,
            status: "failed",
            detail: message,
          },
        ]);
      } finally {
        setBusy(false);
        setStatusRefreshKey((k) => k + 1);
      }
    },
    [t],
  );

  const handleDeploy = () => {
    void runRequest("/api/deploy", {
      platforms,
      workspacePath: scope === "user" ? "" : workspacePath.trim(),
      scope,
    });
  };

  const handleUndeploy = () => {
    void runRequest("/api/undeploy", {
      platforms,
      workspacePath: scope === "user" ? "" : workspacePath.trim(),
      cleanConfig,
      scope,
    });
  };

  return (
    <div className="deploy-panel">
      <div className="deploy-panel__body">
        <div className="system-settings__section">
          <h2 className="system-settings__section-title">{t.deployScope}</h2>
          <p className="system-settings__section-desc">
            {scope === "user" ? t.scopeUserDesc : t.scopeWorkspaceDesc}
          </p>
          <div className="deploy-panel__scope" role="radiogroup" aria-label={t.deployScope}>
            <label className="deploy-panel__scope-option">
              <input
                type="radio"
                name="deploy-scope"
                checked={scope === "user"}
                onChange={() => setScope("user")}
                disabled={busy}
              />
              <span>{t.scopeUser}</span>
            </label>
            <label className="deploy-panel__scope-option">
              <input
                type="radio"
                name="deploy-scope"
                checked={scope === "workspace"}
                onChange={() => setScope("workspace")}
                disabled={busy}
              />
              <span>{t.scopeWorkspace}</span>
            </label>
          </div>
        </div>

        {scope === "workspace" ? (
          <div className="system-settings__section">
            <h2 className="system-settings__section-title">{t.workspacePath}</h2>
            <input
              id="deploy-workspace"
              className="deploy-panel__input"
              type="text"
              autoComplete="off"
              placeholder={t.workspacePathPlaceholder}
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              disabled={busy}
            />
          </div>
        ) : null}

        <div className="system-settings__section">
          <h2 className="system-settings__section-title">{t.platforms}</h2>
          <div className="deploy-panel__platforms">
            <label className="deploy-panel__check">
              <input
                type="checkbox"
                checked={cursorChecked}
                onChange={(e) => setCursorChecked(e.target.checked)}
                disabled={busy}
              />
              <span>Cursor</span>
            </label>
            <label className="deploy-panel__check">
              <input
                type="checkbox"
                checked={vscodeChecked}
                onChange={(e) => setVscodeChecked(e.target.checked)}
                disabled={busy}
              />
              <span>Copilot</span>
            </label>
            <label className="deploy-panel__check">
              <input
                type="checkbox"
                checked={codexChecked}
                onChange={(e) => setCodexChecked(e.target.checked)}
                disabled={busy}
              />
              <span>Codex</span>
            </label>
            <label className="deploy-panel__check">
              <input
                type="checkbox"
                checked={qwenChecked}
                onChange={(e) => setQwenChecked(e.target.checked)}
                disabled={busy}
              />
              <span>Qwen</span>
            </label>
            <label className="deploy-panel__check">
              <input
                type="checkbox"
                checked={opencodeChecked}
                onChange={(e) => setOpencodeChecked(e.target.checked)}
                disabled={busy}
              />
              <span>OpenCode</span>
            </label>
          </div>

          <div className="deploy-panel__actions">
            <button
              type="button"
              className="deploy-panel__btn deploy-panel__btn--deploy"
              onClick={handleDeploy}
              disabled={!canSubmit}
            >
              {t.deploy}
            </button>
            <button
              type="button"
              className="deploy-panel__btn deploy-panel__btn--undeploy"
              onClick={handleUndeploy}
              disabled={!canSubmit}
            >
              {t.undeploy}
            </button>
          </div>

          <label className="deploy-panel__clean">
            <input
              type="checkbox"
              checked={cleanConfig}
              onChange={(e) => setCleanConfig(e.target.checked)}
              disabled={busy}
            />
            <span>{t.cleanConfig}</span>
          </label>

          {lastError ? <p className="deploy-panel__error">{lastError}</p> : null}
        </div>

        <div className="system-settings__section">
          <h2 className="system-settings__section-title">{t.currentStatus}</h2>
          <div className="deploy-panel__status" aria-live="polite">
            {(["cursor", "vscode", "codex", "opencode", "qwen"] as const).map((pf) => {
              const entry = deployStatus.find((d) => d.platform === pf);
              const deployed = Boolean(entry && entry.rulesFiles.length > 0);
              const label =
                pf === "cursor"
                  ? "Cursor"
                  : pf === "vscode"
                    ? "Copilot"
                    : pf === "codex"
                      ? "Codex"
                      : pf === "opencode"
                        ? "OpenCode"
                        : "Qwen";
              const filesText = deployed && entry ? entry.rulesFiles.join(", ") : "";
              return (
                <div key={pf} className="deploy-panel__status-item">
                  <span aria-hidden>{deployed ? "✅" : "❌"}</span>
                  <span>
                    <strong>{label}</strong>
                    {deployed ? (
                      <>
                        ：{t.deployStateDeployed}
                        <span className="deploy-panel__status-detail">（{filesText}）</span>
                      </>
                    ) : (
                      <>：{t.deployStateNotDeployed}</>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="system-settings__section">
          <h2 className="system-settings__section-title">{t.deploySteps}</h2>
          <div className="deploy-panel__steps" aria-live="polite">
            {steps.length === 0 ? (
              <p className="deploy-panel__steps-empty">{t.noSteps}</p>
            ) : (
              <ul className="deploy-panel__steps-list">
                {steps.map((step) =>
                  isGroupDivider(step) ? (
                    <li key={step.id} className="deploy-step deploy-step--divider">
                      <div className="deploy-step__separator">{getDeployStepDisplayName(step, locale)}</div>
                    </li>
                  ) : (
                    (() => {
                      const displayDetail = getDeployStepDisplayDetail(step.detail, locale);
                      return (
                        <li key={step.id} className="deploy-step">
                      <span
                        className={`deploy-step__icon deploy-step__icon--${step.status}`}
                        aria-hidden
                      >
                        {step.status === "pending" && "○"}
                        {step.status === "running" && <span className="deploy-step__spinner" />}
                        {step.status === "success" && "✓"}
                        {step.status === "failed" && "✗"}
                        {step.status === "skipped" && "—"}
                      </span>
                      <span className="deploy-step__text">
                        <span className="deploy-step__name">{getDeployStepDisplayName(step, locale)}</span>
                        {displayDetail ? (
                          <span className="deploy-step__detail"> — {displayDetail}</span>
                        ) : null}
                      </span>
                        </li>
                      );
                    })()
                  ),
                )}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
