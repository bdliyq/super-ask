import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadFileResponse } from "@shared/types";
import { withAuthHeaders } from "../auth";
import { highlightCode, isMarkdownFile } from "../utils/shikiHighlighter";
import { MarkdownContent } from "./MarkdownContent";
import { useI18n } from "../i18n";

const WIDTH_KEY = "super-ask-file-drawer-width";
const DEFAULT_WIDTH_PCT = 50;
const MIN_WIDTH_PCT = 20;
const MAX_WIDTH_PCT = 90;

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n >= MIN_WIDTH_PCT && n <= MAX_WIDTH_PCT ? n : DEFAULT_WIDTH_PCT;
  } catch { return DEFAULT_WIDTH_PCT; }
}

function persistWidth(v: number) {
  localStorage.setItem(WIDTH_KEY, String(Math.round(v)));
}

interface FileDrawerProps {
  file: ReadFileResponse | null;
  onClose: () => void;
  onOpenInFinder?: (path: string) => void;
}

type ViewMode = "preview" | "source" | "edit";

export function FileDrawer({ file, onClose, onOpenInFinder }: FileDrawerProps) {
  const { locale } = useI18n();
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [highlightedHtml, setHighlightedHtml] = useState("");
  const [highlighting, setHighlighting] = useState(false);
  const [widthPct, setWidthPct] = useState(loadWidth);
  const [maximized, setMaximized] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startPct = useRef(0);
  const prevPathRef = useRef("");

  const isMd = file ? isMarkdownFile(file.lang, file.resolvedPath) : false;
  const fileName = file?.resolvedPath.split("/").pop() ?? "";

  useEffect(() => {
    if (file?.resolvedPath !== prevPathRef.current) {
      prevPathRef.current = file?.resolvedPath ?? "";
      setViewMode("preview");
      setHighlightedHtml("");
      setEditContent(file?.content ?? "");
      setDirty(false);
    }
  }, [file?.resolvedPath, file?.content]);

  useEffect(() => {
    if (!file || file.isBinary || !file.content) {
      setHighlightedHtml("");
      return;
    }
    if ((isMd && viewMode === "preview") || viewMode === "edit") {
      setHighlightedHtml("");
      return;
    }
    let cancelled = false;
    setHighlighting(true);
    const theme = document.documentElement.getAttribute("data-theme") === "dark"
      ? "github-dark" as const
      : "github-light" as const;
    highlightCode(file.content, file.lang ?? "plaintext", theme).then((html) => {
      if (!cancelled) { setHighlightedHtml(html); setHighlighting(false); }
    });
    return () => { cancelled = true; };
  }, [file, isMd, viewMode]);

  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && viewMode === "edit") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onClose, viewMode]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startPct.current = widthPct;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const parentWidth = containerRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const deltaPx = startX.current - ev.clientX;
      const deltaPct = (deltaPx / parentWidth) * 100;
      const next = Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, startPct.current + deltaPct));
      setWidthPct(next);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setWidthPct((v) => { persistWidth(v); return v; });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [widthPct, maximized]);

  const toggleMaximize = useCallback(() => setMaximized((v) => !v), []);

  const handleCopyPath = useCallback(() => {
    if (file) navigator.clipboard.writeText(file.resolvedPath).catch(() => {});
  }, [file]);

  const handleSave = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/write-file", {
        method: "PUT",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ path: file.resolvedPath, content: editContent }),
      });
      if (res.ok) {
        setDirty(false);
      } else {
        const data = await res.json().catch(() => ({}));
        console.warn("[write-file]", data.error || res.statusText);
      }
    } catch (err) {
      console.warn("[write-file]", err);
    } finally {
      setSaving(false);
    }
  }, [file, editContent, saving]);

  const switchToEdit = useCallback(() => {
    setEditContent(file?.content ?? "");
    setDirty(false);
    setViewMode("edit");
  }, [file?.content]);

  if (!file) return null;

  const effectiveWidth = maximized ? "100%" : `${widthPct}%`;

  return (
    <div
      ref={containerRef}
      className={`file-drawer${maximized ? " file-drawer--maximized" : ""}`}
      style={{ width: effectiveWidth }}
    >
      {!maximized && (
        <div className="file-drawer__resize-handle" onMouseDown={onResizeStart} />
      )}
      <div className="file-drawer__header">
        <div className="file-drawer__title-row">
          <span className="file-drawer__filename" title={file.resolvedPath}>
            {fileName}
            {dirty && <span className="file-drawer__dirty-dot" title="未保存修改">●</span>}
          </span>
          <span className="file-drawer__size">
            {file.size < 1024
              ? `${file.size} B`
              : file.size < 1024 * 1024
                ? `${(file.size / 1024).toFixed(1)} KB`
                : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
          </span>
        </div>
        <div className="file-drawer__actions">
          {isMd && !file.isBinary && viewMode !== "edit" && (
            <div className="file-drawer__mode-toggle">
              <button
                type="button"
                className={`file-drawer__mode-btn${viewMode === "preview" ? " file-drawer__mode-btn--active" : ""}`}
                onClick={() => setViewMode("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                className={`file-drawer__mode-btn${viewMode === "source" ? " file-drawer__mode-btn--active" : ""}`}
                onClick={() => setViewMode("source")}
              >
                Markdown
              </button>
            </div>
          )}
          {!file.isBinary && !file.truncated && viewMode !== "edit" && (
            <button
              type="button"
              className="file-drawer__icon-btn"
              title={locale === "zh" ? "编辑" : "Edit"}
              onClick={switchToEdit}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5Z" />
              </svg>
            </button>
          )}
          {viewMode === "edit" && (
            <>
              <button
                type="button"
                className="file-drawer__save-btn"
                disabled={saving || !dirty}
                onClick={handleSave}
              >
                {saving
                  ? (locale === "zh" ? "保存中..." : "Saving...")
                  : (locale === "zh" ? "保存" : "Save")}
              </button>
              <button
                type="button"
                className="file-drawer__mode-btn"
                onClick={() => setViewMode(isMd ? "preview" : "source")}
              >
                {locale === "zh" ? "取消编辑" : "Cancel"}
              </button>
            </>
          )}
          <button
            type="button"
            className="file-drawer__icon-btn"
            title={locale === "zh" ? "复制路径" : "Copy path"}
            onClick={handleCopyPath}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="9" height="9" rx="1.5" />
              <path d="M3 11V3a1.5 1.5 0 0 1 1.5-1.5H11" />
            </svg>
          </button>
          {onOpenInFinder && (
            <button
              type="button"
              className="file-drawer__icon-btn"
              title={locale === "zh" ? "在 Finder 中打开" : "Open in Finder"}
              onClick={() => onOpenInFinder(file.resolvedPath)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 2A1.5 1.5 0 0 1 3 .5h4.586a1.5 1.5 0 0 1 1.06.44l1.415 1.414A1.5 1.5 0 0 1 10.5 3.414V4H13A1.5 1.5 0 0 1 14.5 5.5v8A1.5 1.5 0 0 1 13 15H3A1.5 1.5 0 0 1 1.5 13.5V2Z" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="file-drawer__icon-btn"
            title={maximized
              ? (locale === "zh" ? "退出全屏" : "Exit fullscreen")
              : (locale === "zh" ? "全屏" : "Fullscreen")}
            onClick={toggleMaximize}
          >
            {maximized ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 1v3H1M12 1v3h3M4 15v-3H1M12 15v-3h3" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 5V1h4M11 1h4v4M1 11v4h4M15 11v4h-4" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="file-drawer__close"
            title={locale === "zh" ? "关闭" : "Close"}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
      <div className="file-drawer__path" title={file.resolvedPath}>
        {file.resolvedPath}
      </div>
      {file.truncated && (
        <div className="file-drawer__truncated-notice">
          {locale === "zh"
            ? `文件过大 (${(file.size / (1024 * 1024)).toFixed(1)} MB)，仅显示前 2 MB`
            : `File too large (${(file.size / (1024 * 1024)).toFixed(1)} MB), showing first 2 MB`}
        </div>
      )}
      <div className="file-drawer__body">
        {file.isBinary ? (
          <div className="file-drawer__binary-notice">
            {locale === "zh" ? "二进制文件，无法预览" : "Binary file, cannot preview"}
            {onOpenInFinder && (
              <button
                type="button"
                className="file-drawer__open-btn"
                onClick={() => onOpenInFinder(file.resolvedPath)}
              >
                {locale === "zh" ? "在 Finder 中打开" : "Open in Finder"}
              </button>
            )}
          </div>
        ) : viewMode === "edit" ? (
          <textarea
            className="file-drawer__editor"
            value={editContent}
            onChange={(e) => { setEditContent(e.target.value); setDirty(true); }}
            spellCheck={false}
          />
        ) : isMd && viewMode === "preview" ? (
          <div className="file-drawer__markdown markdown-body">
            <MarkdownContent source={file.content ?? ""} />
          </div>
        ) : highlighting ? (
          <div className="file-drawer__loading">
            {locale === "zh" ? "高亮加载中..." : "Loading highlight..."}
          </div>
        ) : highlightedHtml ? (
          <div
            className="file-drawer__code shiki-container"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="file-drawer__plain">
            <code>{file.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
