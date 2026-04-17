import React, { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { SessionInfo } from "@shared/types";
import { useI18n } from "../i18n";
import { RequestStatusBadge, SourceBadge } from "./SessionMetaBadges";

export const DEFAULT_VISIBLE_SESSIONS_PER_GROUP = 10;

export type SessionGroupKey = "today" | "yesterday" | "recent7" | "older";

export interface SessionGroup {
  key: SessionGroupKey;
  sessions: SessionInfo[];
}

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

const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.5 1.5L14.5 6.5L10 11L8.5 9.5L5 13L3 13L3 11L6.5 7.5L5 6L9.5 1.5Z" />
  </svg>
);

const TrashIcon = () => (
  <svg
    className="session-tabs__delete-icon"
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2.5 4.5H13.5" />
    <path d="M6 2.5H10" />
    <path d="M4 4.5V12.5C4 13.05 4.45 13.5 5 13.5H11C11.55 13.5 12 13.05 12 12.5V4.5" />
    <path d="M6.5 6.5V11" />
    <path d="M9.5 6.5V11" />
  </svg>
);

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addLocalDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function buildSessionGroups(sessions: SessionInfo[], now = Date.now()): SessionGroup[] {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = addLocalDays(todayStart, -1);
  const recent7Start = addLocalDays(todayStart, -8);
  const grouped: Record<SessionGroupKey, SessionInfo[]> = {
    today: [],
    yesterday: [],
    recent7: [],
    older: [],
  };

  for (const session of sessions) {
    const ts = session.lastActiveAt || session.createdAt || 0;
    if (ts >= todayStart) {
      grouped.today.push(session);
    } else if (ts >= yesterdayStart) {
      grouped.yesterday.push(session);
    } else if (ts >= recent7Start) {
      grouped.recent7.push(session);
    } else {
      grouped.older.push(session);
    }
  }

  return (["today", "yesterday", "recent7", "older"] as const)
    .map((key) => ({ key, sessions: grouped[key] }))
    .filter((group) => group.sessions.length > 0);
}

function getSessionGroupTitle(key: SessionGroupKey, t: ReturnType<typeof useI18n>["t"]): string {
  if (key === "today") return t.sessionGroupToday;
  if (key === "yesterday") return t.sessionGroupYesterday;
  if (key === "recent7") return t.sessionGroupRecent7;
  return t.sessionGroupOlder;
}

export function getVisibleCountForGroup(
  sessions: SessionInfo[],
  visibleLimit = DEFAULT_VISIBLE_SESSIONS_PER_GROUP,
): number {
  return Math.min(visibleLimit, sessions.length);
}

export function getNextVisibleCountForGroup(
  currentVisibleCount: number,
  totalSessions: number,
): number {
  return Math.min(totalSessions, currentVisibleCount + DEFAULT_VISIBLE_SESSIONS_PER_GROUP);
}

interface SessionTabsProps {
  sessions: SessionInfo[];
  pinnedSessionIds?: string[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onReorderPinned?: (newOrder: string[]) => void;
  onDelete: (id: string) => void;
  onTogglePanel?: () => void;
  collapsed?: boolean;
}

export function SessionTabs({
  sessions,
  pinnedSessionIds = [],
  activeSessionId,
  onSelect,
  onTogglePin,
  onReorderPinned,
  onDelete,
  onTogglePanel,
  collapsed = false,
}: SessionTabsProps) {
  const { t, locale } = useI18n();
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [collapsedGroups, setCollapsedGroups] = useState<Partial<Record<SessionGroupKey, boolean>>>({});
  const [visibleCountsByGroup, setVisibleCountsByGroup] = useState<Partial<Record<SessionGroupKey, number>>>({});
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSrcIdRef = useRef<string | null>(null);
  const pinnedSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
  const sessionMap = useMemo(() => new Map(sessions.map((s) => [s.chatSessionId, s])), [sessions]);

  const pinnedSessions = useMemo(
    () => pinnedSessionIds.map((id) => sessionMap.get(id)).filter((s): s is SessionInfo => !!s),
    [pinnedSessionIds, sessionMap],
  );

  const unpinnedSessions = useMemo(
    () => sessions.filter((s) => !pinnedSet.has(s.chatSessionId)),
    [sessions, pinnedSet],
  );

  const sessionGroups = useMemo(() => buildSessionGroups(unpinnedSessions), [unpinnedSessions]);

  const visibleSessions = useMemo(() => {
    const list: SessionInfo[] = [];
    for (const group of sessionGroups) {
      if (collapsedGroups[group.key]) {
        continue;
      }
      const visibleCount = getVisibleCountForGroup(group.sessions, visibleCountsByGroup[group.key]);
      list.push(...group.sessions.slice(0, visibleCount));
    }
    return list;
  }, [collapsedGroups, sessionGroups, visibleCountsByGroup]);

  const visibleSessionIndexById = useMemo(
    () => new Map(visibleSessions.map((session, index) => [session.chatSessionId, index])),
    [visibleSessions],
  );

  const focusAt = useCallback((index: number) => {
    if (visibleSessions.length === 0) return;
    const i = ((index % visibleSessions.length) + visibleSessions.length) % visibleSessions.length;
    const id = visibleSessions[i].chatSessionId;
    onSelect(id);
    requestAnimationFrame(() => {
      itemRefs.current.get(id)?.focus();
    });
  }, [onSelect, visibleSessions]);

  const onTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, index: number) => {
      if (visibleSessions.length === 0) return;
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
        focusAt(visibleSessions.length - 1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(visibleSessions[index].chatSessionId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const id = visibleSessions[index].chatSessionId;
        onDelete(id);
      }
    },
    [focusAt, onDelete, onSelect, visibleSessions],
  );

  const handleDelete = useCallback(
    (e: MouseEvent<HTMLButtonElement>, id: string) => {
      e.stopPropagation();
      onDelete(id);
    },
    [onDelete],
  );

  const handleTogglePin = useCallback(
    (e: MouseEvent<HTMLButtonElement>, id: string) => {
      e.stopPropagation();
      onTogglePin?.(id);
    },
    [onTogglePin],
  );

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLDivElement>, id: string) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltipPos({ top: rect.top, left: rect.right + 8 });
      setHoveredId(id);
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, id: string) => {
    dragSrcIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    e.currentTarget.classList.add("session-tabs__item--dragging");
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove("session-tabs__item--dragging");
    dragSrcIdRef.current = null;
    setDragOverId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== dragSrcIdRef.current) {
      setDragOverId(id);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const srcId = dragSrcIdRef.current;
    if (!srcId || srcId === targetId || !onReorderPinned) return;
    const order = [...pinnedSessionIds];
    const srcIdx = order.indexOf(srcId);
    const tgtIdx = order.indexOf(targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    order.splice(srcIdx, 1);
    order.splice(tgtIdx, 0, srcId);
    onReorderPinned(order);
  }, [pinnedSessionIds, onReorderPinned]);

  const toggleGroupCollapsed = useCallback((key: SessionGroupKey) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const revealMoreInGroup = useCallback((key: SessionGroupKey, totalSessions: number) => {
    setVisibleCountsByGroup((prev) => {
      const currentVisibleCount = prev[key] ?? DEFAULT_VISIBLE_SESSIONS_PER_GROUP;
      const nextVisibleCount = getNextVisibleCountForGroup(currentVisibleCount, totalSessions);
      if (nextVisibleCount === currentVisibleCount) {
        return prev;
      }
      return { ...prev, [key]: nextVisibleCount };
    });
  }, []);

  const hoveredSession = hoveredId ? sessions.find((s) => s.chatSessionId === hoveredId) : null;

  if (collapsed) {
    const renderMiniItem = (s: SessionInfo) => {
      const firstChar = (s.title || "?").charAt(0).toUpperCase();
      const isActive = s.chatSessionId === activeSessionId;
      const hasPending = s.hasPending;
      return (
        <button
          key={s.chatSessionId}
          type="button"
          className={`session-tabs__mini-item${isActive ? " session-tabs__mini-item--active" : ""}${hasPending ? " session-tabs__mini-item--pending" : ""}`}
          title={s.title || t.unnamedSession}
          onClick={() => onSelect(s.chatSessionId)}
        >
          {firstChar}
        </button>
      );
    };

    return (
      <aside className="session-tabs session-tabs--mini" aria-label={t.sessionList}>
        <div className="session-tabs__mini-header">
          {onTogglePanel && (
            <button
              type="button"
              className="session-tabs__toggle"
              onClick={onTogglePanel}
              aria-label={t.toggleSidebar}
            >
              <SidebarIcon />
            </button>
          )}
        </div>
        <div className="session-tabs__mini-list">
          {pinnedSessions.length > 0 && (
            <>
              {pinnedSessions.map(renderMiniItem)}
              {(sessionGroups.length > 0) && <hr className="session-tabs__mini-divider" />}
            </>
          )}
          {sessionGroups.map((group, gi) => (
            <React.Fragment key={group.key}>
              {group.sessions.map(renderMiniItem)}
              {gi < sessionGroups.length - 1 && <hr className="session-tabs__mini-divider" />}
            </React.Fragment>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="session-tabs" aria-label={t.sessionList}>
      <div className="session-tabs__banner">
        <span className="session-tabs__banner-title">{t.sessionList}</span>
        {onTogglePanel && (
          <button
            type="button"
            className="session-tabs__toggle"
            onClick={onTogglePanel}
            aria-label={t.toggleSidebar}
          >
            <SidebarIcon />
          </button>
        )}
      </div>
      <div className="session-tabs__list">
        {sessions.length === 0 ? (
          <div className="session-tabs__empty">{t.noSessions}</div>
        ) : (
          <>
          {pinnedSessions.length > 0 && (
            <section className="session-tabs__group session-tabs__group--pinned">
              <button
                type="button"
                className="session-tabs__group-toggle session-tabs__group-toggle--pinned-header"
                aria-expanded={!pinnedCollapsed}
                onClick={() => setPinnedCollapsed((v) => !v)}
              >
                <span
                  className={`session-tabs__group-caret${pinnedCollapsed ? " session-tabs__group-caret--collapsed" : ""}`}
                  aria-hidden
                >
                  ▾
                </span>
                <PinIcon filled />
                <span className="session-tabs__group-title">{t.pin}</span>
                <span className="session-tabs__group-count">{pinnedSessions.length}</span>
              </button>
              {!pinnedCollapsed && (
              <div className="session-tabs__group-list">
                {pinnedSessions.map((s) => {
                  const selected = s.chatSessionId === activeSessionId;
                  const pinLabel = `${t.unpin} ${s.title || t.unnamed}`;
                  const visibleIndex = visibleSessionIndexById.get(s.chatSessionId) ?? 0;
                  const isDragOver = dragOverId === s.chatSessionId;

                  return (
                    <div
                      key={s.chatSessionId}
                      ref={(el) => {
                        if (el) itemRefs.current.set(s.chatSessionId, el);
                        else itemRefs.current.delete(s.chatSessionId);
                      }}
                      role="button"
                      aria-current={selected ? "page" : undefined}
                      tabIndex={selected ? 0 : -1}
                      draggable={!!onReorderPinned}
                      className={`session-tabs__item session-tabs__item--active-pin ${selected ? "session-tabs__item--active" : ""} ${
                        s.hasPending ? "session-tabs__item--pending" : ""
                      } session-tabs__item--pinned${isDragOver ? " session-tabs__item--drag-over" : ""}`}
                      onClick={() => onSelect(s.chatSessionId)}
                      onKeyDown={(e) => onTabKeyDown(e, visibleIndex)}
                      onMouseEnter={(e) => handleMouseEnter(e, s.chatSessionId)}
                      onMouseLeave={handleMouseLeave}
                      onDragStart={(e) => handleDragStart(e, s.chatSessionId)}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => handleDragOver(e, s.chatSessionId)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, s.chatSessionId)}
                    >
                      {onReorderPinned && (
                        <span className="session-tabs__drag-handle" aria-hidden>⠿</span>
                      )}
                      {onTogglePin && (
                        <button
                          type="button"
                          className="session-tabs__pin session-tabs__pin--active"
                          aria-label={pinLabel}
                          title={pinLabel}
                          onClick={(e) => handleTogglePin(e, s.chatSessionId)}
                        >
                          <PinIcon filled />
                        </button>
                      )}
                      <SourceBadge source={s.source} />
                      <span className="session-tabs__item-title">{s.title || t.unnamed}</span>
                      <RequestStatusBadge status={s.requestStatus} />
                      {s.hasPending ? (
                        <span className="session-tabs__dot" title={t.pendingReply} aria-hidden />
                      ) : null}
                      <button
                        type="button"
                        className="session-tabs__delete"
                        aria-label={`${t.deleteSession} ${s.title || t.unnamed}`}
                        onClick={(e) => handleDelete(e, s.chatSessionId)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
              )}
            </section>
          )}
          {sessionGroups.map((group) => {
            const collapsed = Boolean(collapsedGroups[group.key]);
            const containsActiveSession = group.sessions.some(
              (session) => session.chatSessionId === activeSessionId,
            );
            const visibleCount = getVisibleCountForGroup(group.sessions, visibleCountsByGroup[group.key]);
            const activeSessionIndex = containsActiveSession
              ? group.sessions.findIndex((session) => session.chatSessionId === activeSessionId)
              : -1;
            const visibleGroupSessions = collapsed
              ? []
              : group.sessions.slice(0, visibleCount);
            const title = getSessionGroupTitle(group.key, t);
            const remaining = Math.max(0, group.sessions.length - visibleCount);
            const expandLabel = `${collapsed ? t.sessionGroupExpand : t.sessionGroupCollapse} ${title}`;
            const moreLabel = remaining > 0
              ? `${t.sessionGroupShowMore} (${remaining})`
              : t.sessionGroupShowMore;
            const highlightGroupToggle = collapsed && containsActiveSession;
            const highlightShowMore = !collapsed && activeSessionIndex >= visibleCount;

            return (
              <section key={group.key} className="session-tabs__group">
                <button
                  type="button"
                  className={`session-tabs__group-toggle${
                    highlightGroupToggle ? " session-tabs__group-toggle--active" : ""
                  }`}
                  aria-expanded={!collapsed}
                  aria-label={expandLabel}
                  aria-current={highlightGroupToggle ? "page" : undefined}
                  onClick={() => toggleGroupCollapsed(group.key)}
                >
                  <span
                    className={`session-tabs__group-caret${
                      collapsed ? " session-tabs__group-caret--collapsed" : ""
                    }`}
                    aria-hidden
                  >
                    ▾
                  </span>
                  <span className="session-tabs__group-title">{title}</span>
                  <span className="session-tabs__group-count">{group.sessions.length}</span>
                </button>

                {!collapsed ? (
                  <div className="session-tabs__group-list">
                    {visibleGroupSessions.map((s) => {
                      const selected = s.chatSessionId === activeSessionId;
                      const isPinned = pinnedSet.has(s.chatSessionId);
                      const pinLabel = `${isPinned ? t.unpin : t.pin} ${s.title || t.unnamed}`;
                      const visibleIndex = visibleSessionIndexById.get(s.chatSessionId) ?? 0;

                      return (
                        <div
                          key={s.chatSessionId}
                          ref={(el) => {
                            if (el) itemRefs.current.set(s.chatSessionId, el);
                            else itemRefs.current.delete(s.chatSessionId);
                          }}
                          role="button"
                          aria-current={selected ? "page" : undefined}
                          tabIndex={selected ? 0 : -1}
                          className={`session-tabs__item ${selected ? "session-tabs__item--active" : ""} ${
                            s.hasPending ? "session-tabs__item--pending" : ""
                          } ${isPinned ? "session-tabs__item--pinned" : ""}`}
                          onClick={() => onSelect(s.chatSessionId)}
                          onKeyDown={(e) => onTabKeyDown(e, visibleIndex)}
                          onMouseEnter={(e) => handleMouseEnter(e, s.chatSessionId)}
                          onMouseLeave={handleMouseLeave}
                        >
                          {onTogglePin && (
                            <button
                              type="button"
                              className={`session-tabs__pin${isPinned ? " session-tabs__pin--active" : ""}`}
                              aria-label={pinLabel}
                              title={pinLabel}
                              onClick={(e) => handleTogglePin(e, s.chatSessionId)}
                            >
                              <PinIcon filled={isPinned} />
                            </button>
                          )}
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
                          <button
                            type="button"
                            className="session-tabs__delete"
                            aria-label={`${t.deleteSession} ${s.title || t.unnamed}`}
                            onClick={(e) => handleDelete(e, s.chatSessionId)}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      );
                    })}

                    {remaining > 0 ? (
                      <button
                        type="button"
                        className={`session-tabs__show-more${
                          highlightShowMore ? " session-tabs__show-more--active" : ""
                        }`}
                        aria-current={highlightShowMore ? "page" : undefined}
                        onClick={() => revealMoreInGroup(group.key, group.sessions.length)}
                      >
                        {moreLabel}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
          </>
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
    </aside>
  );
}
