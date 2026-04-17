import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";
import { AboutPanel } from "./AboutPanel";
import { DeployPanel } from "./DeployPanel";
import { SystemSettings } from "./SystemSettings";

export type SettingsTab = "system" | "deploy" | "hotkeys" | "about";

const SETTINGS_TAB_STORAGE_KEY = "super-ask-settings-tab";

export function resolveInitialSettingsTab(stored: string | null): SettingsTab | null {
  if (stored === "system" || stored === "deploy" || stored === "hotkeys" || stored === "about") {
    return stored;
  }
  return null;
}

interface SettingsPanelProps {
  initialTab?: SettingsTab;
  aboutMarkdownByLocale?: Partial<Record<Locale, string>>;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl";

function ShortcutsPanel() {
  const { t } = useI18n();
  const shortcuts = [
    { keys: `${MOD} + .`, desc: t.shortcutTerminalToggle },
    { keys: `${MOD} + /`, desc: t.shortcutSessionListToggle },
    { keys: `${MOD} + '`, desc: t.shortcutDocsToggle },
    { keys: `${MOD} + Enter`, desc: t.shortcutSendReply },
  ];

  return (
    <div className="settings-shortcuts">
      <table className="settings-shortcuts__table">
        <thead>
          <tr>
            <th className="settings-shortcuts__th-keys">{isMac ? "Shortcut" : "Shortcut"}</th>
            <th className="settings-shortcuts__th-desc">{isMac ? "Action" : "Action"}</th>
          </tr>
        </thead>
        <tbody>
          {shortcuts.map((s) => (
            <tr key={s.keys}>
              <td className="settings-shortcuts__keys">
                {s.keys.split(" + ").map((k, i) => (
                  <span key={i}>
                    {i > 0 && <span className="settings-shortcuts__plus">+</span>}
                    <kbd className="settings-shortcuts__kbd">{k}</kbd>
                  </span>
                ))}
              </td>
              <td className="settings-shortcuts__desc">{s.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
            className={`settings-panel__nav-item ${activeTab === "hotkeys" ? "settings-panel__nav-item--active" : ""}`}
            onClick={() => setActiveTab("hotkeys")}
          >
            {t.hotKeys}
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
          ) : activeTab === "hotkeys" ? (
            <ShortcutsPanel />
          ) : (
            <AboutPanel initialMarkdown={aboutMarkdownByLocale?.[locale]} />
          )}
        </div>
      </div>
    </div>
  );
}
