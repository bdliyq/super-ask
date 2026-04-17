import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadFileResponse } from "@shared/types";
import { highlightCode, isMarkdownFile } from "../utils/shikiHighlighter";
import { MarkdownContent } from "./MarkdownContent";
import { useI18n } from "../i18n";

interface FileDrawerProps {
  file: ReadFileResponse | null;
  onClose: () => void;
  onOpenInFinder?: (path: string) => void;
}

type ViewMode = "preview" | "source";

export function FileDrawer({ file, onClose, onOpenInFinder }: FileDrawerProps) {
  const { locale } = useI18n();
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [highlightedHtml, setHighlightedHtml] = useState<string>("");
  const [highlighting, setHighlighting] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const prevPathRef = useRef<string>("");

  const isMd = file ? isMarkdownFile(file.lang, file.resolvedPath) : false;
  const fileName = file?.resolvedPath.split("/").pop() ?? "";

  useEffect(() => {
    if (file?.resolvedPath !== prevPathRef.current) {
      prevPathRef.current = file?.resolvedPath ?? "";
      setViewMode("preview");
      setHighlightedHtml("");
    }
  }, [file?.resolvedPath]);

  useEffect(() => {
    if (!file || file.isBinary || !file.content) {
      setHighlightedHtml("");
      return;
    }
    if (isMd && viewMode === "preview") {
      setHighlightedHtml("");
      return;
    }

    let cancelled = false;
    setHighlighting(true);
    const theme = document.documentElement.getAttribute("data-theme") === "dark"
      ? "github-dark" as const
      : "github-light" as const;

    highlightCode(file.content, file.lang ?? "plaintext", theme).then((html) => {
      if (!cancelled) {
        setHighlightedHtml(html);
        setHighlighting(false);
      }
    });

    return () => { cancelled = true; };
  }, [file, isMd, viewMode]);

  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onClose]);

  const handleCopyPath = useCallback(() => {
    if (file) navigator.clipboard.writeText(file.resolvedPath).catch(() => {});
  }, [file]);

  if (!file) return null;

  return (
    <div ref={drawerRef} className="file-drawer">
      <div className="file-drawer__header">
        <div className="file-drawer__title-row">
          <span className="file-drawer__filename" title={file.resolvedPath}>
            {fileName}
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
          {isMd && !file.isBinary && (
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
