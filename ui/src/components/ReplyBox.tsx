import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { FileAttachment } from "@shared/types";
import type { QuotedRef } from "./InteractionCard";
import { withAuthHeaders } from "../auth";
import { useI18n } from "../i18n";
import {
  SlashMenu,
  type SlashCommand,
  type SlashMenuHandle,
} from "./SlashMenu";

/** 待上传的本地文件（含可选图片预览） */
interface PendingFile {
  /** 列表 key */
  key: string;
  file: File;
  /** 图片预览 data URL，非图片则无 */
  preview?: string;
}

interface QueuedReply { text: string; displayText: string; attachments?: FileAttachment[] }

interface ReplyBoxProps {
  hasPending: boolean;
  chatSessionId: string;
  options?: string[];
  queuedReplies?: QueuedReply[];
  onRemoveQueuedReply?: (index: number) => void;
  quotedRefs?: QuotedRef[];
  onRemoveQuotedRef?: (index: number) => void;
  onClearQuotedRefs?: () => void;
  onSend: (text: string, attachments?: FileAttachment[]) => Promise<void>;
  connected?: boolean;
}

const DRAFT_PREFIX = "super-ask-draft-";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 与后端一致：内联图片允许的 MIME */
const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function formatFileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function isAllowedImageFile(file: File): boolean {
  const t = (file.type || "").toLowerCase();
  if (!t.startsWith("image/")) return false;
  return ALLOWED_IMAGE_MIMES.has(t);
}

/** 用 FileReader 读 base64 段（去掉 data URL 前缀） */
function fileToBase64DataPart(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string;
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

function makePreviewIfImage(file: File): Promise<string | undefined> {
  if (!isAllowedImageFile(file)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => resolve(undefined);
    r.readAsDataURL(file);
  });
}

/**
 * 底部回复区：快捷选项、粘贴/拖拽/选择文件、上传后随 WebSocket 一并发送。
 */
const QUOTE_TYPE_LABELS: Record<string, { zh: string; en: string }> = {
  summary: { zh: "摘要", en: "Summary" },
  question: { zh: "问题", en: "Question" },
  feedback: { zh: "回复", en: "Feedback" },
  all: { zh: "全部", en: "All" },
};

function truncateText(text: string, maxLen: number): string {
  const single = text.replace(/\n+/g, " ").trim();
  return single.length > maxLen ? single.slice(0, maxLen) + "…" : single;
}

export function ReplyBox({ hasPending, chatSessionId, options, queuedReplies = [], onRemoveQueuedReply, quotedRefs = [], onRemoveQuotedRef, onClearQuotedRefs, onSend, connected }: ReplyBoxProps) {
  const { t, locale } = useI18n();
  const draftKey = DRAFT_PREFIX + chatSessionId;
  const [text, setText] = useState(() => {
    return localStorage.getItem(draftKey) || "";
  });
  const [attachments, setAttachments] = useState<PendingFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);
  const prevConnectedRef = useRef(connected);
  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<SlashMenuHandle | null>(null);
  const prevDraftKeyRef = useRef(draftKey);

  const disabled = false;

  useEffect(() => {
    if (prevDraftKeyRef.current !== draftKey) {
      setText(localStorage.getItem(draftKey) || "");
      prevDraftKeyRef.current = draftKey;
      return;
    }
    if (text) {
      localStorage.setItem(draftKey, text);
    } else {
      localStorage.removeItem(draftKey);
    }
  }, [draftKey, text]);

  useEffect(() => {
    const wasDisconnected = prevConnectedRef.current === false;
    prevConnectedRef.current = connected;

    if (connected && wasDisconnected && uploadError) {
      setUploadError(null);
      const msg = locale === "zh" ? "连接已恢复" : "Connection restored";
      setReconnectNotice(msg);
      const timer = setTimeout(() => setReconnectNotice(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [connected, locale, uploadError]);

  useEffect(() => {
    if (quotedRefs.length > 0) {
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [quotedRefs.length]);

  const removePending = useCallback((key: string) => {
    setAttachments((prev) => prev.filter((p) => p.key !== key));
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    const errs: string[] = [];
    const next: PendingFile[] = [];

    for (const file of list) {
      if (file.size > MAX_FILE_BYTES) {
        errs.push(`${file.name}：超过 10MB`);
        continue;
      }
      const t = (file.type || "").toLowerCase();
      if (t.startsWith("image/") && !ALLOWED_IMAGE_MIMES.has(t)) {
        errs.push(`${file.name}：图片仅支持 JPEG/PNG/GIF/WebP`);
        continue;
      }
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = await makePreviewIfImage(file);
      next.push({ key, file, preview });
    }

    if (errs.length) {
      setUploadError(errs.join("；"));
    } else {
      setUploadError(null);
    }

    if (next.length) {
      setAttachments((prev) => [...prev, ...next]);
    }
  }, []);

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const cd = e.clipboardData;
      if (!cd) return;

      const collected: File[] = [];
      if (cd.files && cd.files.length > 0) {
        collected.push(...Array.from(cd.files));
      }
      if (collected.length === 0 && cd.items) {
        for (let i = 0; i < cd.items.length; i++) {
          const item = cd.items[i];
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f) collected.push(f);
          }
        }
      }
      if (collected.length === 0) return;
      e.preventDefault();
      void addFiles(collected);
    },
    [addFiles, disabled]
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [disabled]);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      void addFiles(files);
    },
    [addFiles, disabled]
  );

  const openFilePicker = useCallback(() => {
    if (disabled) return;
    fileInputRef.current?.click();
  }, [disabled]);

  const onFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        void addFiles(files);
      }
      e.target.value = "";
    },
    [addFiles]
  );

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    setUploadError(null);
    const uploaded: FileAttachment[] = [];
    const failMsgs: string[] = [];

    for (const pf of attachments) {
      try {
        const data = await fileToBase64DataPart(pf.file);
        const resp = await fetch("/api/upload", {
          method: "POST",
          headers: withAuthHeaders({
            "Content-Type": "application/json; charset=utf-8",
          }),
          body: JSON.stringify({
            filename: pf.file.name,
            mimeType: pf.file.type || "application/octet-stream",
            data,
          }),
        });
        if (!resp.ok) {
          let detail = resp.statusText;
          try {
            const j = (await resp.json()) as { error?: string };
            if (j.error) detail = j.error;
          } catch {
            /* 忽略非 JSON */
          }
          failMsgs.push(`${pf.file.name}：${detail}`);
          continue;
        }
        const result = (await resp.json()) as FileAttachment;
        uploaded.push(result);
      } catch {
        failMsgs.push(`${pf.file.name}：上传失败`);
      }
    }

    if (failMsgs.length) {
      setUploadError(failMsgs.join("；"));
    }

    let fullText = trimmed;
    if (quotedRefs.length > 0) {
      const quoteParts = quotedRefs.map((ref) => {
        const label = QUOTE_TYPE_LABELS[ref.type]?.[locale as "zh" | "en"] ?? ref.type;
        const lines = ref.text.split("\n").map((l) => `> ${l}`).join("\n");
        return `> **[#${ref.index + 1} ${label}]**\n${lines}`;
      });
      fullText = quoteParts.join("\n\n") + "\n\n" + trimmed;
    }
    try {
      await onSend(fullText, uploaded.length > 0 ? uploaded : undefined);
      onClearQuotedRefs?.();
      setAttachments([]);
      setText("");
      localStorage.removeItem(draftKey);
      taRef.current?.focus();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : (locale === "zh" ? "发送失败" : "Send failed");
      setUploadError(message);
    }
  }, [attachments, draftKey, locale, onClearQuotedRefs, onSend, quotedRefs, text]);

  const onInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    if (
      val === "/" ||
      (val.startsWith("/") && !val.includes(" ") && !val.includes("\n"))
    ) {
      setShowSlash(true);
      setSlashFilter(val);
    } else {
      setShowSlash(false);
      setSlashFilter("");
    }
  }, []);

  const onSlashSelect = useCallback((cmd: SlashCommand) => {
    setText(cmd.text);
    setShowSlash(false);
    setSlashFilter("");
    taRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlash && !disabled) {
        const handled = slashMenuRef.current?.handleKeyDown(e);
        if (handled) return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    },
    [disabled, showSlash, submit]
  );

  const pickOption = useCallback(
    async (opt: string) => {
      if (disabled) return;
      try {
        await onSend(opt);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : (locale === "zh" ? "发送失败" : "Send failed");
        setUploadError(message);
      }
      taRef.current?.focus();
    },
    [disabled, locale, onSend],
  );

  const canSend = text.trim().length > 0 || attachments.length > 0;

  const isQueued = queuedReplies.length > 0;
  const placeholder = hasPending
    ? t.replyPlaceholder
    : isQueued
      ? (t.replyPlaceholder + " [queued]")
      : t.noRequestPlaceholder;

  return (
    <div className="reply-box">
      {isQueued && (
        <div className="reply-box__queued-hint" role="status">
          <div className="reply-box__queued-title">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, marginRight: 4, verticalAlign: "middle" }}><circle cx="8" cy="8" r="6.5"/><polyline points="8 4 8 8 11 10"/></svg>
            {locale === "zh"
              ? `${queuedReplies.length} 条消息已排队，等待新请求到来后自动提交`
              : `${queuedReplies.length} message${queuedReplies.length > 1 ? "s" : ""} queued, will auto-submit when next request arrives`}
          </div>
          <ul className="reply-box__queued-list">
            {queuedReplies.map((q, i) => (
              <li key={i} className="reply-box__queued-item">
                <span className="reply-box__queued-index">#{i + 1}</span>
                <span className="reply-box__queued-text">{q.displayText.length > 80 ? q.displayText.slice(0, 80) + "…" : q.displayText}</span>
                {q.attachments && q.attachments.length > 0 && (
                  <span className="reply-box__queued-attachments">📎{q.attachments.length}</span>
                )}
                <button
                  type="button"
                  className="reply-box__queued-copy"
                  title={locale === "zh" ? "复制" : "Copy"}
                  onClick={() => {
                    void navigator.clipboard.writeText(q.displayText);
                    setCopiedIndex(i);
                    setTimeout(() => setCopiedIndex((prev) => prev === i ? null : prev), 1500);
                  }}
                >
                  {copiedIndex === i ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 8 7 12 13 4"/></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>
                  )}
                </button>
                {onRemoveQueuedReply && (
                  <button
                    type="button"
                    className="reply-box__queued-remove"
                    title={locale === "zh" ? "撤销" : "Remove"}
                    onClick={() => onRemoveQueuedReply(i)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {quotedRefs.length > 0 && (
        <div className="reply-box__quoted-refs" role="list">
          {quotedRefs.map((ref, i) => {
            const label = QUOTE_TYPE_LABELS[ref.type]?.[locale as "zh" | "en"] ?? ref.type;
            return (
              <div key={i} className="reply-box__quoted-ref" role="listitem">
                <div className="reply-box__quoted-ref-bar" />
                <div className="reply-box__quoted-ref-body">
                  <span className="reply-box__quoted-ref-label">#{ref.index + 1} · {label}</span>
                  <span className="reply-box__quoted-ref-text">{truncateText(ref.text, 80)}</span>
                </div>
                {onRemoveQuotedRef && (
                  <button
                    type="button"
                    className="reply-box__queued-remove"
                    title={locale === "zh" ? "移除引用" : "Remove quote"}
                    onClick={() => onRemoveQuotedRef(i)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {options && options.length > 0 && hasPending ? (
        <div className="reply-box__options" role="group" aria-label="快捷选项">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="reply-box__option-btn"
              disabled={disabled}
              onClick={() => pickOption(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : null}

      {uploadError ? (
        <div className="reply-box__upload-error" role="alert">
          {uploadError}
        </div>
      ) : reconnectNotice ? (
        <div className="reply-box__reconnect-notice" role="status">
          {reconnectNotice}
        </div>
      ) : null}

      <div
        className="reply-box__drop-zone"
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {attachments.length > 0 ? (
          <div className="reply-box__attachments" aria-label="已选文件">
            {attachments.map((pf) => (
              <div key={pf.key} className="reply-box__attachment">
                {pf.preview ? (
                  <img
                    className="reply-box__attachment-thumb"
                    src={pf.preview}
                    alt=""
                  />
                ) : (
                  <span className="reply-box__attachment-thumb reply-box__attachment-thumb--doc" aria-hidden>
                    📎
                  </span>
                )}
                <span className="reply-box__attachment-name" title={pf.file.name}>
                  {pf.file.name}
                </span>
                <span className="reply-box__attachment-size">
                  {formatFileSize(pf.file.size)}
                </span>
                <button
                  type="button"
                  className="reply-box__attachment-remove"
                  aria-label={`移除 ${pf.file.name}`}
                  onClick={() => removePending(pf.key)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* 输入框与右下角工具栏（附件、发送）同层，工具栏绝对定位 */}
        <div className="reply-box__composer">
          {showSlash && !disabled ? (
            <SlashMenu
              ref={slashMenuRef}
              filter={slashFilter}
              onSelect={onSlashSelect}
              onClose={() => {
                setShowSlash(false);
                setSlashFilter("");
              }}
            />
          ) : null}
          <textarea
            ref={taRef}
            className="reply-box__input"
            placeholder={placeholder}
            value={text}
            disabled={disabled}
            rows={3}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <input
            ref={fileInputRef}
            type="file"
            className="reply-box__file-input"
            multiple
            aria-hidden
            tabIndex={-1}
            onChange={onFileInputChange}
          />
          <div className="reply-box__toolbar">
            <button
              type="button"
              className="reply-box__file-btn"
              disabled={disabled}
              title={t.addAttachment}
              aria-label={t.addAttachment}
              onClick={openFilePicker}
            >
              📎
            </button>
            <button
              type="button"
              className="reply-box__send"
              disabled={disabled || !canSend}
              onClick={() => void submit()}
            >
              {t.send}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
