import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeployScope, DeployStatusResponse } from "@shared/types";
import { withAuthHeaders } from "../auth";
import { useI18n } from "../i18n";

/** 单平台部署探测结果（与 DeployStatusResponse.deployed 元素一致） */
type DeployStatusEntry = DeployStatusResponse["deployed"][number];

/** 部署目标平台（与后端约定一致） */
type DeployPlatform = "cursor" | "vscode" | "codex";

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

/**
 * 根据选中的平台生成请求体中的 platforms 数组（二者都选即「全部」）
 */
function platformsPayload(cursor: boolean, vscode: boolean, codex: boolean): DeployPlatform[] {
  const list: DeployPlatform[] = [];
  if (cursor) list.push("cursor");
  if (vscode) list.push("vscode");
  if (codex) list.push("codex");
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
  const { t } = useI18n();

  /** 部署范围：默认 user，避免未填工作区路径时按钮长期不可用 */
  const [scope, setScope] = useState<DeployScope>("user");
  const [workspacePath, setWorkspacePath] = useState("");
  const [cursorChecked, setCursorChecked] = useState(true);
  const [vscodeChecked, setVscodeChecked] = useState(true);
  const [codexChecked, setCodexChecked] = useState(true);
  const [cleanConfig, setCleanConfig] = useState(false);
  const [steps, setSteps] = useState<DeployStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /** 服务端返回的各平台已部署文件列表 */
  const [deployStatus, setDeployStatus] = useState<DeployStatusEntry[]>([]);

  const platforms = useMemo(
    () => platformsPayload(cursorChecked, vscodeChecked, codexChecked),
    [cursorChecked, vscodeChecked, codexChecked],
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
        <div className="deploy-panel__label">{t.deployScope}:</div>
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
        <p className="deploy-panel__scope-desc">
          {scope === "user" ? t.scopeUserDesc : t.scopeWorkspaceDesc}
        </p>

        {scope === "workspace" ? (
          <>
            <label className="deploy-panel__label" htmlFor="deploy-workspace">
              {t.workspacePath}:
            </label>
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
          </>
        ) : null}

        <div className="deploy-panel__label">{t.platforms}:</div>
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
        </div>

        <div className="deploy-panel__status" aria-live="polite">
          <div className="deploy-panel__status-title">{t.currentStatus}</div>
          {(["cursor", "vscode", "codex"] as const).map((pf) => {
            const entry = deployStatus.find((d) => d.platform === pf);
            const deployed = Boolean(entry && entry.rulesFiles.length > 0);
            const label = pf === "cursor" ? "Cursor" : pf === "vscode" ? "Copilot" : "Codex";
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

        <div className="deploy-panel__steps" aria-live="polite">
          <div className="deploy-panel__steps-title">{t.deploySteps}</div>
          {steps.length === 0 ? (
            <p className="deploy-panel__steps-empty">{t.noSteps}</p>
          ) : (
            <ul className="deploy-panel__steps-list">
              {steps.map((step) =>
                isGroupDivider(step) ? (
                  <li key={step.id} className="deploy-step deploy-step--divider">
                    <div className="deploy-step__separator">{step.name}</div>
                  </li>
                ) : (
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
                      <span className="deploy-step__name">{step.name}</span>
                      {step.detail ? (
                        <span className="deploy-step__detail"> — {step.detail}</span>
                      ) : null}
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
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
    </div>
  );
}
