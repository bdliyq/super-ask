import { useCallback, useEffect, useState } from "react";
import type { FileAttachment, HistoryEntry } from "@shared/types";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";
import { MarkdownContent } from "./MarkdownContent";

const CANCELLED_FEEDBACK = "[Cancelled]";

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function formatFileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function isInlineImageMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIMES.has(mime.trim().toLowerCase());
}

function formatFeedbackMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;

  return lines
    .map((line, index) => {
      const isFence = /^\s*(```|~~~)/.test(line);
      if (isFence) {
        inFence = !inFence;
        return line;
      }

      if (inFence || line.trim() === "" || index === lines.length - 1) {
        return line;
      }

      const nextLine = lines[index + 1];
      if (nextLine.trim() === "") {
        return line;
      }

      return `${line}  `;
    })
    .join("\n");
}

export type QuoteType = "summary" | "question" | "feedback" | "all";

export interface QuotedRef {
  type: QuoteType;
  text: string;
  index: number;
  sourceSessionId?: string;
  sourceSessionTitle?: string;
}

export interface InteractionCardProps {
  index: number;
  agentEntry: HistoryEntry;
  userEntry?: HistoryEntry;
  onQuote?: (ref: QuotedRef) => void;
  onForward?: (ref: QuotedRef) => void;
  isPinned?: boolean;
  onTogglePin?: (index: number) => void;
  isAcked?: boolean;
  onOpenPath?: (path: string) => void;
}

type EntryStatusKind = "pending" | "done" | "cancelled";

function getEntryStatus(userEntry: HistoryEntry | undefined): EntryStatusKind {
  if (!userEntry) return "pending";
  if ((userEntry.feedback ?? "").trim() === CANCELLED_FEEDBACK) return "cancelled";
  return "done";
}

function QuoteButton({ onClick, title, variant }: { onClick: () => void; title: string; variant?: "header" | "section" }) {
  const cls = variant === "header" ? "entry-header__quote-btn" : "entry-section__quote-btn";
  return (
    <button type="button" className={cls} title={title} onClick={onClick}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 5h4L5 11H2L3 5Z" /><path d="M9 5h4l-2 6H8l1-6Z" />
      </svg>
    </button>
  );
}

function ForwardButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button type="button" className="entry-section__quote-btn" title={title} onClick={onClick}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.75v6.5" />
        <path d="M5.25 4.5 8 1.75 10.75 4.5" />
        <path d="M4 6.75v5.5c0 .69.56 1.25 1.25 1.25h5.5c.69 0 1.25-.56 1.25-1.25v-5.5" />
      </svg>
    </button>
  );
}

export function InteractionCard({ index, agentEntry, userEntry, onQuote, onForward, isPinned, onTogglePin, isAcked, onOpenPath }: InteractionCardProps) {
  const { t } = useI18n();
  const statusKind = getEntryStatus(userEntry);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const closeLightbox = useCallback(() => setLightboxUrl(null), []);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxUrl, closeLightbox]);

  const statusLabel =
    statusKind === "pending"
      ? t.statusAwaiting
      : statusKind === "cancelled"
        ? t.statusCancelled
        : t.statusReplied;

  const statusBadgeClass =
    statusKind === "pending"
      ? "entry-status-badge entry-status-badge--pending"
      : statusKind === "cancelled"
        ? "entry-status-badge entry-status-badge--cancelled"
        : "entry-status-badge entry-status-badge--replied";

  const askedTime = formatDateTime(agentEntry.timestamp);
  const repliedText = userEntry ? `${t.replied} ${formatDateTime(userEntry.timestamp)}` : "—";
  const middleSegment = repliedText;

  const rootClass = [
    "history-entry",
    statusKind === "pending" && "pending",
    statusKind === "done" && "completed",
    statusKind === "cancelled" && "cancelled",
  ].filter(Boolean).join(" ");
  const dotClass = `entry-status ${statusKind}`;

  const feedbackMd = (userEntry?.feedback ?? "").trim();

  const buildAllText = () => {
    const parts: string[] = [];
    if (agentEntry.summary) parts.push(agentEntry.summary);
    if (agentEntry.question) parts.push(agentEntry.question);
    if (feedbackMd && feedbackMd !== CANCELLED_FEEDBACK) parts.push(feedbackMd);
    return parts.join("\n\n");
  };

  return (
    <>
      <div className={rootClass}>
        <div className="entry-header">
          <span className={dotClass} aria-hidden />
          <span className="entry-header__text">
            #{index + 1} · {t.asked} {askedTime} → {middleSegment}
          </span>
          <span className={statusBadgeClass}>{statusLabel}</span>
          {isAcked && statusKind === "done" && (
            <span className="entry-ack-badge" title={t.agentAcked ?? "已送达至 Agent"}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 8.5l3 3 4.5-6" />
                <path d="M6.5 8.5l3 3 4.5-6" />
              </svg>
            </span>
          )}
          <span className="entry-header__spacer" />
          {onQuote && (
            <QuoteButton
              variant="header"
              title={t.quoteAll}
              onClick={() => onQuote({ type: "all", text: buildAllText(), index })}
            />
          )}
          {onTogglePin && (
            <button
              type="button"
              className={`entry-header__pin-btn${isPinned ? " entry-header__pin-btn--active" : ""}`}
              title={isPinned ? t.unpin : t.pin}
              onClick={() => onTogglePin(index)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 1.5L14.5 6.5L10 11L8.5 9.5L5 13L3 13L3 11L6.5 7.5L5 6L9.5 1.5Z"/>
              </svg>
            </button>
          )}
        </div>
        <div className="entry-body">
          {agentEntry.summary ? (
            <div className="summary-card">
              <div className="summary-card__header">
                <div className="summary-card__label">{t.summary}</div>
                <div className="entry-section__actions">
                  <CopyButton className="entry-section__copy-btn" text={agentEntry.summary} />
                  {onQuote && (
                    <QuoteButton
                      title={t.quoteSummary}
                      onClick={() => onQuote({ type: "summary", text: agentEntry.summary!, index })}
                    />
                  )}
                  {onForward && (
                    <ForwardButton
                      title={t.forwardSummary}
                      onClick={() => onForward({ type: "summary", text: agentEntry.summary!, index })}
                    />
                  )}
                </div>
              </div>
              <div className="summary-card__text markdown-body">
                <MarkdownContent source={agentEntry.summary} onOpenPath={onOpenPath} />
              </div>
            </div>
          ) : null}
          {agentEntry.question ? (
            <div className="question-card">
              <div className="question-card__header">
                <div className="question-label">{t.question}</div>
                <div className="entry-section__actions">
                  <CopyButton className="entry-section__copy-btn" text={agentEntry.question} />
                  {onQuote && (
                    <QuoteButton
                      title={t.quoteQuestion}
                      onClick={() => onQuote({ type: "question", text: agentEntry.question!, index })}
                    />
                  )}
                  {onForward && (
                    <ForwardButton
                      title={t.forwardQuestion}
                      onClick={() => onForward({ type: "question", text: agentEntry.question!, index })}
                    />
                  )}
                </div>
              </div>
              <div className="question-text markdown-body">
                <MarkdownContent source={agentEntry.question} onOpenPath={onOpenPath} />
              </div>
            </div>
          ) : null}
          {userEntry ? (
            <div className="feedback-record">
              <div className="feedback-record__header">
                <div className="feedback-record-label">{t.yourFeedback}</div>
                {feedbackMd ? (
                  <div className="entry-section__actions">
                    <CopyButton className="entry-section__copy-btn" text={feedbackMd} />
                    {onQuote && feedbackMd !== CANCELLED_FEEDBACK && (
                      <QuoteButton
                        title={t.quoteFeedback}
                        onClick={() => onQuote({ type: "feedback", text: feedbackMd, index })}
                      />
                    )}
                    {onForward && feedbackMd !== CANCELLED_FEEDBACK && (
                      <ForwardButton
                        title={t.forwardFeedback}
                        onClick={() => onForward({ type: "feedback", text: feedbackMd, index })}
                      />
                    )}
                  </div>
                ) : null}
              </div>
              {feedbackMd ? (
                <div className="feedback-record-text markdown-body">
                  <MarkdownContent source={formatFeedbackMarkdown(userEntry.feedback ?? "")} onOpenPath={onOpenPath} />
                </div>
              ) : null}
              {userEntry.attachments && userEntry.attachments.length > 0 ? (
                <div className="feedback-record__attachments">
                  {userEntry.attachments.map((att) => (
                    <FeedbackAttachmentItem
                      key={att.id + att.url}
                      att={att}
                      onImageClick={setLightboxUrl}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {lightboxUrl ? (
        <div
          className="feedback-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          tabIndex={-1}
          onClick={closeLightbox}
        >
          <img
            className="feedback-image-lightbox__img"
            src={lightboxUrl}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}

function FeedbackAttachmentItem({
  att,
  onImageClick,
}: {
  att: FileAttachment;
  onImageClick: (url: string) => void;
}) {
  if (isInlineImageMime(att.mimeType)) {
    return (
      <button
        type="button"
        className="feedback-record__image-btn"
        onClick={() => onImageClick(att.url)}
        aria-label={`放大查看 ${att.filename}`}
      >
        <img className="feedback-record__image" src={att.url} alt={att.filename} loading="lazy" />
      </button>
    );
  }

  return (
    <a
      className="feedback-record__file-link"
      href={att.url}
      download={att.filename}
      target="_blank"
      rel="noopener noreferrer"
    >
      📎 {att.filename}
      <span className="feedback-record__file-meta"> {formatFileSize(att.size)}</span>
    </a>
  );
}
