import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { SessionInfo } from "@shared/types";
import { useI18n } from "../i18n";
import { RequestStatusBadge, SourceBadge } from "./SessionMetaBadges";

function formatRelativeTime(ts: number, isZh: boolean): string {
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return isZh ? "刚刚" : "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return isZh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return isZh ? `${h} 小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return isZh ? `${d} 天前` : `${d}d ago`;
}

const SidebarIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" />
  </svg>
);

interface SessionTabsProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePanel?: () => void;
}

export function SessionTabs({ sessions, activeSessionId, onSelect, onDelete, onTogglePanel }: SessionTabsProps) {
  const { t, locale } = useI18n();
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const focusAt = useCallback((index: number) => {
    if (sessions.length === 0) return;
    const i = ((index % sessions.length) + sessions.length) % sessions.length;
    const id = sessions[i].chatSessionId;
    onSelect(id);
    requestAnimationFrame(() => {
      itemRefs.current.get(id)?.focus();
    });
  }, [onSelect, sessions]);

  const onTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (sessions.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        focusAt(index + 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        focusAt(index - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusAt(0);
      } else if (e.key === "End") {
        e.preventDefault();
        focusAt(sessions.length - 1);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const id = sessions[index].chatSessionId;
        onDelete(id);
      }
    },
    [focusAt, onDelete, sessions],
  );

  const handleDelete = useCallback(
    (e: MouseEvent, id: string) => {
      e.stopPropagation();
      onDelete(id);
    },
    [onDelete],
  );

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLButtonElement>, id: string) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltipPos({ top: rect.top, left: rect.right + 8 });
      setHoveredId(id);
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
  }, []);

  const hoveredSession = hoveredId ? sessions.find((s) => s.chatSessionId === hoveredId) : null;

  return (
    <aside className="session-tabs" aria-label={t.sessions}>
      <div className="session-tabs__list" role="tablist" aria-orientation="vertical">
        {sessions.length === 0 ? (
          <div className="session-tabs__empty">{t.noSessions}</div>
        ) : (
          sessions.map((s, index) => {
            const selected = s.chatSessionId === activeSessionId;
            return (
              <button
                key={s.chatSessionId}
                ref={(el) => {
                  if (el) itemRefs.current.set(s.chatSessionId, el);
                  else itemRefs.current.delete(s.chatSessionId);
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={`session-tabs__item ${selected ? "session-tabs__item--active" : ""} ${
                  s.hasPending ? "session-tabs__item--pending" : ""
                }`}
                onClick={() => onSelect(s.chatSessionId)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
                onMouseEnter={(e) => handleMouseEnter(e, s.chatSessionId)}
                onMouseLeave={handleMouseLeave}
              >
                <SourceBadge source={s.source} />
                <span className="session-tabs__item-title">{s.title || t.unnamed}</span>
                {(s.tags ?? []).length > 0 && (
                  <span className="session-tabs__tags">
                    {s.tags!.map((tag) => (
                      <span key={tag} className="session-tabs__tag">{tag}</span>
                    ))}
                  </span>
                )}
                <RequestStatusBadge status={s.requestStatus} />
                {s.hasPending ? (
                  <span className="session-tabs__dot" title={t.pendingReply} aria-hidden />
                ) : null}
                <span
                  className="session-tabs__delete"
                  role="button"
                  tabIndex={-1}
                  aria-label={`${t.deleteSession} ${s.title || t.unnamed}`}
                  onClick={(e) => handleDelete(e, s.chatSessionId)}
                >
                  ✕
                </span>
              </button>
            );
          })
        )}
      </div>
      {hoveredSession && (
        <div
          className="session-tabs__tooltip"
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left }}
        >
          <table className="session-tabs__tooltip-table">
            <tbody>
              <tr>
                <td className="session-tabs__tooltip-label">{t.tooltipTitle}</td>
                <td className="session-tabs__tooltip-value">{hoveredSession.title || t.unnamed}</td>
              </tr>
              <tr>
                <td className="session-tabs__tooltip-label">{t.tooltipSource}</td>
                <td className="session-tabs__tooltip-value">
                  <SourceBadge source={hoveredSession.source} />
                </td>
              </tr>
              <tr>
                <td className="session-tabs__tooltip-label">{t.tooltipWorkspace}</td>
                <td className="session-tabs__tooltip-value">{hoveredSession.workspaceRoot || "—"}</td>
              </tr>
              <tr>
                <td className="session-tabs__tooltip-label">{t.tooltipSessionId}</td>
                <td className="session-tabs__tooltip-value session-tabs__tooltip-value--mono">
                  {hoveredSession.chatSessionId}
                </td>
              </tr>
              <tr>
                <td className="session-tabs__tooltip-label">{t.tooltipStatus}</td>
                <td className="session-tabs__tooltip-value">
                  <RequestStatusBadge status={hoveredSession.requestStatus} />
                </td>
              </tr>
              {(hoveredSession.tags ?? []).length > 0 && (
                <tr>
                  <td className="session-tabs__tooltip-label">{t.tooltipTags}</td>
                  <td className="session-tabs__tooltip-value">
                    <span className="session-tabs__tags">
                      {hoveredSession.tags!.map((tag) => (
                        <span key={tag} className="session-tabs__tag">{tag}</span>
                      ))}
                    </span>
                  </td>
                </tr>
              )}
              <tr>
                <td className="session-tabs__tooltip-label">{t.tooltipLastActive}</td>
                <td className="session-tabs__tooltip-value">
                  {hoveredSession.lastActiveAt
                    ? formatRelativeTime(hoveredSession.lastActiveAt, locale === "zh")
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {onTogglePanel && (
        <button
          type="button"
          className="session-tabs__toggle"
          onClick={onTogglePanel}
          aria-label="Toggle sidebar"
        >
          <SidebarIcon />
        </button>
      )}
    </aside>
  );
}
