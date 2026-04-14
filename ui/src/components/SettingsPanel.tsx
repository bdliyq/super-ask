import { useState } from "react";
import { useI18n } from "../i18n";
import { DeployPanel } from "./DeployPanel";
import { SystemSettings } from "./SystemSettings";

/**
 * 配置面板：左侧导航切换「系统设置」与「部署管理」。
 * header 和返回按钮由 App 统一页眉提供。
 */
export function SettingsPanel() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"system" | "deploy">("system");

  return (
    <div className="settings-panel">
      <div className="settings-panel__body">
        <nav className="settings-panel__nav" aria-label={t.settings}>
          <button
            type="button"
            className={`settings-panel__nav-item ${activeTab === "system" ? "settings-panel__nav-item--active" : ""}`}
            onClick={() => setActiveTab("system")}
          >
            {t.systemSettings}
          </button>
          <button
            type="button"
            className={`settings-panel__nav-item ${activeTab === "deploy" ? "settings-panel__nav-item--active" : ""}`}
            onClick={() => setActiveTab("deploy")}
          >
            {t.deployManagement}
          </button>
        </nav>
        <div className="settings-panel__content">
          {activeTab === "system" ? <SystemSettings /> : <DeployPanel />}
        </div>
      </div>
    </div>
  );
}
