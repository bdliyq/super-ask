import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileAttachment, HistoryEntry, SessionInfo } from "@shared/types";
import { withAuthHeaders } from "../auth";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";
import { InteractionCard, type QuotedRef } from "./InteractionCard";
import { ReplyBox } from "./ReplyBox";
import { RequestStatusBadge, SourceBadge } from "./SessionMetaBadges";

interface QueuedReply { text: string; displayText: string; attachments?: FileAttachment[] }

interface ChatViewProps {
  session: SessionInfo | undefined;
  onSendReply: (
    chatSessionId: string,
    feedback: string,
    attachments?: FileAttachment[]
  ) => Promise<void>;
  queuedReplies?: QueuedReply[];
  onRemoveQueuedReply?: (index: number) => void;
}

/** 将 history 分组为 agent + 可选紧随的 user 交互对 */
function groupInteractions(history: HistoryEntry[]) {
  const groups: { agent: HistoryEntry; user?: HistoryEntry }[] = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry.role === "agent") {
      const next = history[i + 1];
      if (next && next.role === "user") {
        groups.push({ agent: entry, user: next });
        i++;
      } else {
        groups.push({ agent: entry });
      }
    }
  }
  return groups;
}

export function ChatView({ session, onSendReply, queuedReplies = [], onRemoveQueuedReply }: ChatViewProps) {
  const { t, locale } = useI18n();
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinPanelRef = useRef<HTMLDivElement>(null);
  const pinToggleRef = useRef<HTMLButtonElement>(null);
  const [quotedRefs, setQuotedRefs] = useState<QuotedRef[]>([]);
  const [showPinPanel, setShowPinPanel] = useState(false);
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagInputValue, setTagInputValue] = useState("");
  const tagInputRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const pinnedSet = new Set(session?.pinnedIndices ?? []);

  const handleTogglePin = useCallback(async (index: number) => {
    if (!session) return;
    const isPinned = (session.pinnedIndices ?? []).includes(index);
    const endpoint = isPinned ? "/api/unpin" : "/api/pin";
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chatSessionId: session.chatSessionId, index }),
      });
    } catch (e) {
      console.warn("[pin] request failed:", e);
    }
  }, [session]);

  const handleAddTag = useCallback(async (tag: string) => {
    if (!session || !tag.trim()) return;
    try {
      await fetch("/api/tag", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chatSessionId: session.chatSessionId, tag: tag.trim() }),
      });
    } catch (e) {
      console.warn("[tag] add failed:", e);
    }
  }, [session]);

  const handleRemoveTag = useCallback(async (tag: string) => {
    if (!session) return;
    try {
      await fetch("/api/untag", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chatSessionId: session.chatSessionId, tag }),
      });
    } catch (e) {
      console.warn("[tag] remove failed:", e);
    }
  }, [session]);

  const handleTagInputKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = tagInputValue.trim();
      if (val) {
        void handleAddTag(val);
        setTagInputValue("");
        setShowTagInput(false);
      }
    } else if (e.key === "Escape") {
      setTagInputValue("");
      setShowTagInput(false);
    }
  }, [tagInputValue, handleAddTag]);

  useEffect(() => {
    if (showTagInput) {
      tagInputRef.current?.focus();
    }
  }, [showTagInput]);

  const scrollToCard = useCallback((index: number) => {
    const anchor = document.getElementById(`interaction-${index}`);
    const container = messagesRef.current;
    if (!anchor || !container) return;
    requestAnimationFrame(() => {
      const cRect = container.getBoundingClientRect();
      const aRect = anchor.getBoundingClientRect();
      const scrollPadding = 24;
      const targetTop = aRect.top - cRect.top + container.scrollTop - scrollPadding;
      container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
      anchor.classList.add("interaction-card--highlight");
      setTimeout(() => anchor.classList.remove("interaction-card--highlight"), 1500);
    });
  }, []);

  useEffect(() => {
    if (!showPinPanel) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        pinPanelRef.current && !pinPanelRef.current.contains(target) &&
        pinToggleRef.current && !pinToggleRef.current.contains(target)
      ) {
        setShowPinPanel(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPinPanel]);

  const prevSessionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const isSwitch = prevSessionId.current !== session?.chatSessionId;
    prevSessionId.current = session?.chatSessionId;

    if (isSwitch) {
      el.style.scrollBehavior = "auto";
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        el.style.scrollBehavior = "";
      });
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [session?.chatSessionId, session?.history.length, queuedReplies.length]);

  if (!session) {
    return (
      <div className="chat-view chat-view--empty">
        <p className="chat-view__placeholder">{t.selectSessionHint}</p>
      </div>
    );
  }

  const lastAgent = [...session.history].reverse().find((h) => h.role === "agent");
  const options = lastAgent?.options;

  return (
    <div className="chat-view">
      <div className="chat-view__banner">
        <div className="chat-view__banner-left">
          <SourceBadge source={session.source} />
          <div className="chat-view__banner-title-group">
            <span className="chat-view__banner-title">{session.title || t.unnamedSession}</span>
            {showTagInput ? (
              <input
                ref={tagInputRef}
                className="chat-view__tag-input"
                type="text"
                value={tagInputValue}
                placeholder={t.addTagPlaceholder}
                onChange={(e) => setTagInputValue(e.target.value)}
                onKeyDown={handleTagInputKeyDown}
                onBlur={() => {
                  const val = tagInputValue.trim();
                  if (val) void handleAddTag(val);
                  setTagInputValue("");
                  setShowTagInput(false);
                }}
              />
            ) : (
              <button
                type="button"
                className="chat-view__tag-add-btn"
                title={t.addTag}
                onClick={() => setShowTagInput(true)}
              >
                <span className="chat-view__tag-add-glyph" aria-hidden="true">#</span>
              </button>
            )}
            {(session.tags ?? []).map((tag) => (
              <span key={tag} className="chat-view__tag">
                {tag}
                <button
                  type="button"
                  className="chat-view__tag-remove"
                  title={t.removeTag}
                  onClick={() => void handleRemoveTag(tag)}
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                </button>
              </span>
            ))}
            <RequestStatusBadge status={session.requestStatus} />
          </div>
          {session.workspaceRoot ? (
            <span className="chat-view__banner-workspace" title={session.workspaceRoot}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{marginRight: '4px', opacity: 0.85, flexShrink: 0}}>
                <path d="M1.5 2A1.5 1.5 0 0 1 3 .5h4.586a1.5 1.5 0 0 1 1.06.44l1.415 1.414A1.5 1.5 0 0 1 10.5 3.414V4H13A1.5 1.5 0 0 1 14.5 5.5v8A1.5 1.5 0 0 1 13 15H3A1.5 1.5 0 0 1 1.5 13.5V2Z" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              {session.workspaceRoot}
              <CopyButton text={session.workspaceRoot} />
            </span>
          ) : null}
          <span className="chat-view__banner-id">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{marginRight: '3px', opacity: 0.85, flexShrink: 0}}>
              <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0 0 1 14 4.5v3a2.5 2.5 0 0 1-2.5 2.5H9l-3 3v-3H4.5A2.5 2.5 0 0 1 2 7.5v-3Z" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            {session.chatSessionId}
            <CopyButton text={session.chatSessionId} />
          </span>
        </div>
        <div className="chat-view__banner-right">
          <button
            ref={pinToggleRef}
            type="button"
            className={`chat-view__pin-toggle${showPinPanel ? " chat-view__pin-toggle--active" : ""}`}
            title={locale === "zh" ? "Pin 列表" : "Pinned messages"}
            onClick={() => setShowPinPanel((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill={showPinPanel ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 1.5L14.5 6.5L10 11L8.5 9.5L5 13L3 13L3 11L6.5 7.5L5 6L9.5 1.5Z"/>
            </svg>
            {(session.pinnedIndices?.length ?? 0) > 0 && (
              <span className="chat-view__pin-count">{session.pinnedIndices!.length}</span>
            )}
          </button>
        </div>
      </div>
      <div className="chat-view__body">
        <div className="chat-view__main">
          <div ref={messagesRef} className="chat-view__messages" role="log" aria-live="polite" aria-relevant="additions">
            {groupInteractions(session.history).map((g, i, arr) => {
              const isLastPair = i === arr.length - 1;
              const acked = g.user
                ? isLastPair
                  ? session.requestStatus === "acked"
                  : true
                : false;
              return (
                <div key={`${g.agent.timestamp}-${i}`} id={`interaction-${i}`} ref={(el) => { if (el) cardRefs.current.set(i, el); else cardRefs.current.delete(i); }}>
                  <InteractionCard
                    index={i}
                    agentEntry={g.agent}
                    userEntry={g.user}
                    onQuote={(ref) => setQuotedRefs((prev) => [...prev, ref])}
                    isPinned={pinnedSet.has(i)}
                    onTogglePin={handleTogglePin}
                    isAcked={acked}
                  />
                </div>
              );
            })}
          </div>
          <ReplyBox
            hasPending={session.hasPending}
            chatSessionId={session.chatSessionId}
            options={options}
            queuedReplies={queuedReplies}
            onRemoveQueuedReply={onRemoveQueuedReply}
            quotedRefs={quotedRefs}
            onRemoveQuotedRef={(idx) => setQuotedRefs((prev) => prev.filter((_, i) => i !== idx))}
            onClearQuotedRefs={() => setQuotedRefs([])}
            onSend={async (feedback, attachments) =>
              onSendReply(session.chatSessionId, feedback, attachments)
            }
          />
        </div>
        {showPinPanel && (session.pinnedIndices?.length ?? 0) > 0 && (
          <div ref={pinPanelRef} className="chat-view__pin-panel">
            <div className="chat-view__pin-panel-header">
              <span>{locale === "zh" ? "已 Pin 的消息" : "Pinned Messages"}</span>
              <button type="button" className="chat-view__pin-panel-close" onClick={() => setShowPinPanel(false)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
              </button>
            </div>
            {(() => {
              const groups = groupInteractions(session.history);
              return session.pinnedIndices!.map((idx) => {
                const g = groups[idx];
                if (!g) return null;
                const preview = g.agent.summary || g.agent.question || "";
                return (
                  <div key={idx} className="chat-view__pin-item" onClick={() => scrollToCard(idx)}>
                    <span className="chat-view__pin-item-index">#{idx + 1}</span>
                    <span className="chat-view__pin-item-text">{preview}</span>
                    <button
                      type="button"
                      className="chat-view__pin-item-remove"
                      title={locale === "zh" ? "取消 Pin" : "Unpin"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleTogglePin(idx);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                    </button>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
