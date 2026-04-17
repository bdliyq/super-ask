import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { withAuthHeaders } from "../auth";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";
import { CopyButton } from "./CopyButton";

export interface PredefinedMsg {
  id: string;
  text: string;
  active: boolean;
}

interface PredefinedMessagesListProps {
  messages: PredefinedMsg[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
}

const NOTIFICATION_KEY = "super-ask-notification-enabled";

export function isNotificationEnabled(): boolean {
  return localStorage.getItem(NOTIFICATION_KEY) === "true";
}

function setNotificationEnabled(val: boolean) {
  localStorage.setItem(NOTIFICATION_KEY, String(val));
}

let _cachedMsgs: PredefinedMsg[] | null = null;

export async function loadPredefinedMsgs(): Promise<PredefinedMsg[]> {
  try {
    const resp = await fetch("/api/predefined-msgs", { headers: withAuthHeaders() });
    if (resp.ok) {
      const data = (await resp.json()) as PredefinedMsg[];
      _cachedMsgs = data;
      return data;
    }
  } catch { /* 降级返回缓存或空 */ }
  return _cachedMsgs ?? [];
}

async function savePredefinedMsgs(msgs: PredefinedMsg[]) {
  _cachedMsgs = msgs;
  try {
    await fetch("/api/predefined-msgs", {
      method: "PUT",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(msgs),
    });
  } catch (e) {
    console.warn("[predefined-msgs] save failed:", e);
  }
}

export async function getActivePredefinedSuffix(): Promise<string> {
  const msgs = await loadPredefinedMsgs();
  const active = msgs.filter((m) => m.active && m.text.trim());
  if (active.length === 0) return "";
  return "\n" + active.map((m) => m.text.trim()).join("\n");
}

function PredefinedMsgItem({
  msg,
  onToggle,
  onRemove,
  onEdit,
}: {
  msg: PredefinedMsg;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: (newText: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.text);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== msg.text) {
      onEdit(trimmed);
    }
    setEditing(false);
  }, [draft, msg.text, onEdit]);

  useEffect(() => {
    if (editing) {
      setDraft(msg.text);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing, msg.text]);

  return (
    <div className="system-settings__predefined-item">
      <label className="system-settings__predefined-check">
        <input
          type="checkbox"
          checked={msg.active}
          onChange={onToggle}
        />
      </label>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="system-settings__predefined-edit-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className={`system-settings__predefined-text ${msg.active ? "" : "system-settings__predefined-text--inactive"}`}>
          {msg.text}
        </span>
      )}
      {!editing && (
        <button
          type="button"
          className="system-settings__predefined-edit"
          onClick={() => setEditing(true)}
          title="Edit"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
          </svg>
        </button>
      )}
      <CopyButton
        text={msg.text}
        className="system-settings__predefined-copy"
      />
      <button
        type="button"
        className="system-settings__predefined-remove"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

export function PredefinedMessagesList({
  messages,
  onToggle,
  onRemove,
  onEdit,
}: PredefinedMessagesListProps) {
  return (
    <div className="system-settings__predefined-list">
      {messages.map((msg) => (
        <PredefinedMsgItem
          key={msg.id}
          msg={msg}
          onToggle={() => onToggle(msg.id)}
          onRemove={() => onRemove(msg.id)}
          onEdit={(newText) => onEdit(msg.id, newText)}
        />
      ))}
    </div>
  );
}

function formatUptime(seconds: number, isZh: boolean): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (isZh) {
    if (d > 0) return `${d}天 ${h}小时 ${m}分`;
    if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
    if (m > 0) return `${m}分 ${s}秒`;
    return `${s}秒`;
  }
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function SystemSettings() {
  const { locale, t, setLocale } = useI18n();
  const [restartStatus, setRestartStatus] = useState<"idle" | "restarting" | "reconnecting" | "success" | "failed">("idle");
  const [predefinedMsgs, setPredefinedMsgs] = useState<PredefinedMsg[]>([]);
  const [, setPredefinedLoaded] = useState(false);
  const [newMsgText, setNewMsgText] = useState("");
  const [serverPid, setServerPid] = useState<number | null>(null);
  const [serverUptime, setServerUptime] = useState<number | null>(null);
  const [notifEnabled, setNotifEnabled] = useState(isNotificationEnabled);
  const [notifDenied, setNotifDenied] = useState(false);
  /** 测试通知按钮是否处于“已发送”反馈态 */
  const [notifTestSent, setNotifTestSent] = useState(false);
  /** 测试通知失败时的错误文案 */
  const [notifTestError, setNotifTestError] = useState<string | null>(null);

  const currentServerUrl = window.location.origin;

  const fetchServerInfo = useCallback(async () => {
    try {
      const resp = await fetch("/health", { headers: withAuthHeaders() });
      if (resp.ok) {
        const data = await resp.json();
        setServerPid(data.pid ?? null);
        setServerUptime(data.uptime ?? null);
      }
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    void fetchServerInfo();
  }, [fetchServerInfo]);

  useEffect(() => {
    void loadPredefinedMsgs().then((msgs) => {
      setPredefinedMsgs(msgs);
      setPredefinedLoaded(true);
    });
  }, []);

  const onLocaleChange = (next: Locale) => {
    setLocale(next);
  };

  const handleRestart = useCallback(async () => {
    if (!window.confirm(t.restartServerConfirm)) return;
    setRestartStatus("restarting");
    const base = "";
    try {
      await fetch(`${base}/api/server/restart`, {
        method: "POST",
        headers: withAuthHeaders(),
      });
    } catch {
      /* 服务已断开，属预期行为 */
    }
    setRestartStatus("reconnecting");
    let attempts = 0;
    const maxAttempts = 30;
    const poll = () => {
      setTimeout(async () => {
        attempts++;
        try {
          const resp = await fetch(`${base}/health`, { headers: withAuthHeaders() });
          if (resp.ok) {
            const data = await resp.json();
            setServerPid(data.pid ?? null);
            setServerUptime(data.uptime ?? null);
            setRestartStatus("success");
            setTimeout(() => setRestartStatus("idle"), 3000);
            return;
          }
        } catch { /* 继续轮询 */ }
        if (attempts < maxAttempts) {
          poll();
        } else {
          setRestartStatus("failed");
          setTimeout(() => setRestartStatus("idle"), 5000);
        }
      }, 1000);
    };
    poll();
  }, [t.restartServerConfirm]);

  const restartLabel =
    restartStatus === "restarting" ? t.restartServerSuccess
    : restartStatus === "reconnecting" ? t.restartServerReconnecting
    : restartStatus === "failed" ? t.restartServerFailed
    : restartStatus === "success" ? "✓"
    : t.restartServerBtn;

  return (
    <div className="system-settings">
      <div className="system-settings__section">
        <h2 className="system-settings__section-title">{t.language}</h2>
        <p className="system-settings__section-desc">{t.languageDesc}</p>
        <div className="system-settings__options">
          <label className="system-settings__option">
            <input
              type="radio"
              name="locale"
              value="zh"
              checked={locale === "zh"}
              onChange={() => onLocaleChange("zh")}
            />
            {t.langZh}
          </label>
          <label className="system-settings__option">
            <input
              type="radio"
              name="locale"
              value="en"
              checked={locale === "en"}
              onChange={() => onLocaleChange("en")}
            />
            {t.langEn}
          </label>
        </div>
      </div>

      <div className="system-settings__section">
        <h2 className="system-settings__section-title">{t.notification}</h2>
        <p className="system-settings__section-desc">{t.notificationDesc}</p>
        <div className="system-settings__options">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <label className="system-settings__option" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={notifEnabled}
                onChange={async () => {
                  if (!notifEnabled) {
                    if (!("Notification" in window)) return;
                    if (Notification.permission === "denied") {
                      setNotifDenied(true);
                      return;
                    }
                    if (Notification.permission !== "granted") {
                      const perm = await Notification.requestPermission();
                      if (perm !== "granted") {
                        setNotifDenied(true);
                        return;
                      }
                    }
                    setNotifDenied(false);
                    setNotifEnabled(true);
                    setNotificationEnabled(true);
                  } else {
                    setNotifEnabled(false);
                    setNotificationEnabled(false);
                  }
                }}
              />
              {notifEnabled ? t.notificationEnabled : t.notificationDisabled}
            </label>
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              Notification API: {"Notification" in window ? "✓" : "✗"}
              {" | "}Permission: {"Notification" in window ? Notification.permission : "N/A"}
              {" | "}Browser: {navigator.userAgent.includes("Edg") ? "Edge" : navigator.userAgent.includes("Chrome") ? "Chrome" : navigator.userAgent.includes("Safari") ? "Safari" : "Other"}
            </span>
          </div>
        </div>
        {notifTestError && (
          <p className="system-settings__section-desc" style={{ color: "#e53935" }}>
            {notifTestError}
          </p>
        )}
        {notifDenied && (
          <p className="system-settings__section-desc" style={{ color: "#e53935" }}>
            {t.notificationPermissionDenied}
          </p>
        )}
        <button
          type="button"
          className="deploy-panel__btn deploy-panel__btn--deploy"
          style={{ marginTop: 12 }}
          disabled={!notifEnabled}
          onClick={() => {
            setNotifTestError(null);
            if (!("Notification" in window)) {
              setNotifTestError(t.notificationTestUnsupported);
              return;
            }
            try {
              new Notification("[来自 Super Ask] 测试通知", {
                body: "如果你看到这条消息，说明通知功能正常工作！",
                icon: "/logo.png",
              });
              setNotifTestSent(true);
              window.setTimeout(() => setNotifTestSent(false), 2000);
            } catch (err) {
              setNotifTestError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {notifTestSent ? t.notificationTestSent : t.notificationTest}
        </button>
      </div>

      <div className="system-settings__section">
        <h2 className="system-settings__section-title">{t.serverAddress}</h2>
        <p className="system-settings__section-desc">{t.serverAddressDesc}</p>
        <code className="system-settings__server-url">{currentServerUrl}</code>
      </div>

      <div className="system-settings__section">
        <h2 className="system-settings__section-title">{t.predefinedMessages}</h2>
        <p className="system-settings__section-desc">{t.predefinedMessagesDesc}</p>
        {predefinedMsgs.length === 0 ? (
          <p className="system-settings__section-desc">{t.predefinedMsgEmpty}</p>
        ) : (
          <PredefinedMessagesList
            messages={predefinedMsgs}
            onToggle={(id) => {
              const next = predefinedMsgs.map((msg) =>
                msg.id === id ? { ...msg, active: !msg.active } : msg
              );
              setPredefinedMsgs(next);
              void savePredefinedMsgs(next);
            }}
            onRemove={(id) => {
              const next = predefinedMsgs.filter((msg) => msg.id !== id);
              setPredefinedMsgs(next);
              void savePredefinedMsgs(next);
            }}
            onEdit={(id, newText) => {
              const next = predefinedMsgs.map((msg) =>
                msg.id === id ? { ...msg, text: newText } : msg
              );
              setPredefinedMsgs(next);
              void savePredefinedMsgs(next);
            }}
          />
        )}
        <div className="system-settings__predefined-add">
          <input
            type="text"
            className="deploy-panel__input"
            placeholder={t.predefinedMsgPlaceholder}
            value={newMsgText}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewMsgText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newMsgText.trim()) {
                const next = [...predefinedMsgs, { id: Date.now().toString(36), text: newMsgText.trim(), active: true }];
                setPredefinedMsgs(next);
                void savePredefinedMsgs(next);
                setNewMsgText("");
              }
            }}
          />
          <button
            type="button"
            className="deploy-panel__btn deploy-panel__btn--deploy"
            disabled={!newMsgText.trim()}
            onClick={() => {
              if (!newMsgText.trim()) return;
              const next = [...predefinedMsgs, { id: Date.now().toString(36), text: newMsgText.trim(), active: true }];
              setPredefinedMsgs(next);
              void savePredefinedMsgs(next);
              setNewMsgText("");
            }}
          >
            {t.predefinedMsgAdd}
          </button>
        </div>
      </div>

      <div className="system-settings__section">
        <h2 className="system-settings__section-title">{t.restartServer}</h2>
        <p className="system-settings__section-desc">{t.restartServerDesc}</p>
        <div className="system-settings__server-info">
          <span className="system-settings__server-info-label">{t.serverPid}:</span>
          <code className="system-settings__server-info-value">
            {serverPid !== null ? serverPid : t.serverPidLoading}
          </code>
          <span className="system-settings__server-info-label">{t.serverUptime}:</span>
          <code className="system-settings__server-info-value">
            {serverUptime !== null ? formatUptime(serverUptime, locale === "zh") : t.serverPidLoading}
          </code>
        </div>
        <button
          type="button"
          className="deploy-panel__btn deploy-panel__btn--deploy"
          disabled={restartStatus !== "idle" && restartStatus !== "failed" && restartStatus !== "success"}
          onClick={() => void handleRestart()}
        >
          {restartLabel}
        </button>
      </div>
    </div>
  );
}
