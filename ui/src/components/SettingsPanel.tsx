import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";
import { AboutPanel } from "./AboutPanel";
import { DeployPanel } from "./DeployPanel";
import { SystemSettings } from "./SystemSettings";

/**
 * 配置面板：左侧导航切换「系统设置」与「部署管理」。
 * header 和返回按钮由 App 统一页眉提供。
 */
export type SettingsTab = "system" | "deploy" | "about";

const SETTINGS_TAB_STORAGE_KEY = "super-ask-settings-tab";

export function resolveInitialSettingsTab(stored: string | null): SettingsTab | null {
  if (stored === "system" || stored === "deploy" || stored === "about") {
    return stored;
  }
  return null;
}

interface SettingsPanelProps {
  initialTab?: SettingsTab;
  aboutMarkdownByLocale?: Partial<Record<Locale, string>>;
}

export function SettingsPanel({ initialTab = "system", aboutMarkdownByLocale }: SettingsPanelProps) {
  const { locale, t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    return resolveInitialSettingsTab(localStorage.getItem(SETTINGS_TAB_STORAGE_KEY)) ?? initialTab;
  });

  useEffect(() => {
    localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

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
          <button
            type="button"
            className={`settings-panel__nav-item ${activeTab === "about" ? "settings-panel__nav-item--active" : ""}`}
            onClick={() => setActiveTab("about")}
          >
            {t.about}
          </button>
        </nav>
        <div className="settings-panel__content">
          {activeTab === "system" ? (
            <SystemSettings />
          ) : activeTab === "deploy" ? (
            <DeployPanel />
          ) : (
            <AboutPanel initialMarkdown={aboutMarkdownByLocale?.[locale]} />
          )}
        </div>
      </div>
    </div>
  );
}
