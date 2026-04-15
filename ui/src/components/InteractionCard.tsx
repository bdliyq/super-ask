import { useCallback, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileAttachment, HistoryEntry } from "@shared/types";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";

const CANCELLED_FEEDBACK = "[Cancelled]";

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

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

export type QuoteType = "summary" | "question" | "feedback" | "all";

export interface QuotedRef {
  type: QuoteType;
  text: string;
  index: number;
}

export interface InteractionCardProps {
  index: number;
  agentEntry: HistoryEntry;
  userEntry?: HistoryEntry;
  onQuote?: (ref: QuotedRef) => void;
  isPinned?: boolean;
  onTogglePin?: (index: number) => void;
  isAcked?: boolean;
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

export function InteractionCard({ index, agentEntry, userEntry, onQuote, isPinned, onTogglePin, isAcked }: InteractionCardProps) {
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
                </div>
              </div>
              <div className="summary-card__text markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {agentEntry.summary}
                </ReactMarkdown>
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
                </div>
              </div>
              <div className="question-text markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {agentEntry.question}
                </ReactMarkdown>
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
                  </div>
                ) : null}
              </div>
              {feedbackMd ? (
                <div className="feedback-record-text markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {(userEntry.feedback ?? "").replace(/\n/g, "  \n")}
                  </ReactMarkdown>
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
