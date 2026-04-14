import { useI18n } from "../i18n";

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.4 9.3A5.3 5.3 0 016.7 2.6 5.5 5.5 0 1013.4 9.3z" />
  </svg>
);

interface StatusBarProps {
  connected: boolean;
  activeSessions: number;
  pendingRequests: number;
  theme: "light" | "dark";
  toggleTheme: () => void;
}

/**
 * 底部状态栏：连接状态、活跃会话数、待处理请求数、主题切换。
 */
export function StatusBar({
  connected,
  activeSessions,
  pendingRequests,
  theme,
  toggleTheme,
}: StatusBarProps) {
  const { t } = useI18n();

  return (
    <footer className="status-bar" role="status">
      <div className="status-bar__cluster">
        <span className={`status-bar__led ${connected ? "status-bar__led--on" : "status-bar__led--off"}`} aria-hidden />
        <span>{connected ? t.connected : t.disconnected}</span>
      </div>
      <div className="status-bar__cluster">
        <span className="status-bar__label">{t.activeSessions}</span>
        <span className="status-bar__value">{activeSessions}</span>
      </div>
      <div className="status-bar__cluster">
        <span className="status-bar__label">{t.pending}</span>
        <span className="status-bar__value">{pendingRequests}</span>
      </div>
      <button
        type="button"
        className="status-bar__theme-toggle"
        onClick={toggleTheme}
        title={theme === "light" ? "Dark" : "Light"}
        aria-label={theme === "light" ? "Dark" : "Light"}
      >
        {theme === "light" ? <MoonIcon /> : <SunIcon />}
      </button>
    </footer>
  );
}
