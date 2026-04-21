import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import type { ReadFileResponse } from "@shared/types";
import { withAuthHeaders } from "../auth";
import { highlightCode, isMarkdownFile } from "../utils/shikiHighlighter";
import { startBodyResizeSession } from "../utils/bodyResizeSession";
import { getCodeEditorLanguage } from "../utils/codeEditorLanguages";
import { CodeEditor, type CodeEditorRef } from "./CodeEditor";
import { MarkdownContent } from "./MarkdownContent";
import { useI18n } from "../i18n";

interface TocItem {
  level: number;
  text: string;
  slug: string;
}

function extractToc(markdown: string): TocItem[] {
  const items: TocItem[] = [];
  const lines = markdown.split("\n");
  let inCodeBlock = false;
  for (const line of lines) {
    if (/^```/.test(line.trimStart())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      const text = match[2].replace(/[*_`~\[\]]/g, "").trim();
      const slug = text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\s-]/g, "")
        .replace(/\s+/g, "-");
      items.push({ level, text, slug });
    }
  }
  return items;
}

const WIDTH_KEY = "super-ask-file-drawer-width";
const DEFAULT_WIDTH_PCT = 50;
const MIN_WIDTH_PCT = 20;
const MAX_WIDTH_PCT = 90;
const WHEEL_LINE_PX = 16;

function isHTMLElement(value: EventTarget | null): value is HTMLElement {
  return value instanceof HTMLElement;
}

function canScrollHorizontally(el: HTMLElement | null): boolean {
  return !!el && el.scrollWidth > el.clientWidth;
}

function getHorizontalWheelDelta(event: ReactWheelEvent<HTMLDivElement>, pageWidth: number): number {
  const rawDelta = Math.abs(event.deltaX) > 0 && Math.abs(event.deltaY) < 1
    ? event.deltaX
    : event.shiftKey && Math.abs(event.deltaY) > 0
      ? event.deltaY
      : 0;

  if (rawDelta === 0) return 0;

  const scale = event.deltaMode === 1
    ? WHEEL_LINE_PX
    : event.deltaMode === 2
      ? Math.max(pageWidth, 1)
      : 1;

  return rawDelta * scale;
}

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
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [highlightedHtml, setHighlightedHtml] = useState("");
  const [highlighting, setHighlighting] = useState(false);
  const [widthPct, setWidthPct] = useState(loadWidth);
  const [maximized, setMaximized] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [editorTheme, setEditorTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const codeEditorRef = useRef<CodeEditorRef>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startPct = useRef(0);
  const widthPctRef = useRef(widthPct);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const prevPathRef = useRef("");
  const savedContentRef = useRef("");

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    widthPctRef.current = widthPct;
  }, [widthPct]);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
  }, []);

  // 跟随 data-theme 变化（深浅色切换）。CodeEditor 通过 props.theme reconfigure 自身主题。
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const apply = () => {
      setEditorTheme(el.getAttribute("data-theme") === "dark" ? "dark" : "light");
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const isMd = file ? isMarkdownFile(file.lang, file.resolvedPath) : false;
  const fileName = file?.resolvedPath.split("/").pop() ?? "";

  const editorLanguage = useMemo(
    () => getCodeEditorLanguage(file?.lang ?? null),
    [file?.lang],
  );

  useEffect(() => {
    if (isMd && file?.content) {
      setTocItems(extractToc(file.content));
    } else {
      setTocItems([]);
      setShowToc(false);
    }
  }, [isMd, file?.content]);

  useEffect(() => {
    if (!showToc) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (tocPanelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".file-drawer__icon-btn")) return;
      setShowToc(false);
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [showToc]);

  useEffect(() => {
    if (file?.resolvedPath !== prevPathRef.current) {
      prevPathRef.current = file?.resolvedPath ?? "";
      savedContentRef.current = file?.content ?? "";
      const nextIsMd = file ? isMarkdownFile(file.lang, file.resolvedPath) : false;
      setViewMode(nextIsMd ? "preview" : "edit");
      setHighlightedHtml("");
      setEditContent(file?.content ?? "");
      setDirty(false);
      setCanUndo(false);
      setCanRedo(false);
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
      ? "one-dark-pro" as const
      : "github-light" as const;
    highlightCode(file.content, file.lang ?? "plaintext", theme).then((html) => {
      if (!cancelled) { setHighlightedHtml(html); setHighlighting(false); }
    });
    return () => { cancelled = true; };
  }, [file, isMd, viewMode]);

  const handleContentChange = useCallback((next: string) => {
    setEditContent(next);
    setDirty(next !== savedContentRef.current);
  }, []);

  const handleUndo = useCallback(() => {
    codeEditorRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    codeEditorRef.current?.redo();
  }, []);

  const resolveHorizontalScrollOwner = useCallback((target: EventTarget | null): HTMLElement | null => {
    const body = bodyRef.current;
    if (!body) return null;

    // edit 模式下 CodeMirror 自管横向滚动 + wheel；这里返回 null 让事件由 CM 处理。
    if (viewMode === "edit") {
      return null;
    }

    let node: HTMLElement | null = isHTMLElement(target) ? target : null;
    while (node) {
      if (canScrollHorizontally(node)) {
        return node;
      }
      if (node === body) {
        break;
      }
      node = node.parentElement;
    }

    const selectors = isMd && viewMode === "preview"
      ? [".file-drawer__markdown pre", ".file-drawer__markdown .markdown-mermaid"]
      : [".file-drawer__code pre", ".file-drawer__plain"];

    const candidates: HTMLElement[] = [];
    for (const selector of selectors) {
      candidates.push(...Array.from(body.querySelectorAll<HTMLElement>(selector)));
    }
    const scrollableCandidates = Array.from(new Set(candidates)).filter((el) => canScrollHorizontally(el));

    return scrollableCandidates.length === 1 ? scrollableCandidates[0] : null;
  }, [isMd, viewMode]);

  const handleBodyWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const delta = getHorizontalWheelDelta(event, bodyRef.current?.clientWidth ?? 0);
    if (delta === 0) return;

    const owner = resolveHorizontalScrollOwner(event.target);
    if (!owner) return;

    const prevLeft = owner.scrollLeft;
    owner.scrollLeft = prevLeft + delta;

    if (owner.scrollLeft !== prevLeft) {
      event.preventDefault();
    }
  }, [resolveHorizontalScrollOwner]);

  const handleHistoryChange = useCallback((state: { canUndo: boolean; canRedo: boolean }) => {
    setCanUndo(state.canUndo);
    setCanRedo(state.canRedo);
  }, []);

  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // CodeMirror 内置了 Mod-s（已绑到 onSave）以及 Mod-z / Mod-Shift-z。
      // 这里只兜底当焦点不在 CM（如点了路径或工具栏）时仍能保存。
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && viewMode === "edit") {
        const target = e.target as HTMLElement | null;
        if (!target || !target.closest(".file-drawer__cm")) {
          e.preventDefault();
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onClose, viewMode]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    resizeCleanupRef.current?.();
    dragging.current = true;
    startX.current = e.clientX;
    startPct.current = widthPct;
    widthPctRef.current = widthPct;
    const parentWidth = containerRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const deltaPx = startX.current - ev.clientX;
      const deltaPct = (deltaPx / parentWidth) * 100;
      const next = Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, startPct.current + deltaPct));
      widthPctRef.current = next;
      setWidthPct(next);
    };
    resizeCleanupRef.current = startBodyResizeSession({
      onMove,
      onEnd: () => {
        dragging.current = false;
        persistWidth(widthPctRef.current);
        resizeCleanupRef.current = null;
      },
    });
  }, [widthPct, maximized]);

  const toggleMaximize = useCallback(() => setMaximized((v) => !v), []);

  const handleCopyPath = useCallback(() => {
    if (!file) return;
    navigator.clipboard.writeText(file.resolvedPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
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
        savedContentRef.current = editContent;
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

  const effectiveWidth = maximized ? "100%" : `${widthPct}%`;

  if (!file) {
    return (
      <div ref={containerRef} className={`file-drawer${maximized ? " file-drawer--maximized" : ""}`} style={{ width: effectiveWidth }}>
        {!maximized && <div className="file-drawer__resize-handle" onMouseDown={onResizeStart} />}
        <div className="file-drawer__header">
          <div className="file-drawer__title-row">
            <span className="file-drawer__filename">{locale === "zh" ? "文档查看器" : "Document Viewer"}</span>
          </div>
          <div className="file-drawer__actions">
          </div>
        </div>
        <div ref={bodyRef} className="file-drawer__body" onWheelCapture={handleBodyWheel}>
          <div className="file-drawer__binary-notice">
            {locale === "zh" ? "点击消息中的文件路径打开文件" : "Click a file path in messages to open a file"}
          </div>
        </div>
      </div>
    );
  }

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
          {isMd && !file.isBinary && (
            <div className="file-drawer__mode-toggle">
              <button
                type="button"
                className={`file-drawer__mode-btn${viewMode === "edit" ? " file-drawer__mode-btn--active" : ""}`}
                onClick={() => setViewMode("edit")}
              >
                {locale === "zh" ? "编辑" : "Edit"}
              </button>
              <button
                type="button"
                className={`file-drawer__mode-btn${viewMode === "preview" ? " file-drawer__mode-btn--active" : ""}`}
                onClick={() => setViewMode("preview")}
              >
                Preview
              </button>
            </div>
          )}
          {isMd && tocItems.length > 0 && (
            <button
              type="button"
              className={`file-drawer__icon-btn${showToc ? " file-drawer__icon-btn--active" : ""}`}
              title={locale === "zh" ? "目录" : "TOC"}
              onClick={() => setShowToc((v) => !v)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="3" x2="13" y2="3" />
                <line x1="3" y1="6.5" x2="10" y2="6.5" />
                <line x1="3" y1="10" x2="11" y2="10" />
                <line x1="3" y1="13" x2="9" y2="13" />
              </svg>
            </button>
          )}
          {!file.isBinary && !file.truncated && viewMode === "edit" && (
            <>
              <button
                type="button"
                className="file-drawer__icon-btn"
                disabled={!canUndo}
                onClick={handleUndo}
                title={locale === "zh" ? "撤销 (⌘Z)" : "Undo (⌘Z)"}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7h7a3.5 3.5 0 0 1 0 7H8" />
                  <path d="M6 4 3 7l3 3" />
                </svg>
              </button>
              <button
                type="button"
                className="file-drawer__icon-btn"
                disabled={!canRedo}
                onClick={handleRedo}
                title={locale === "zh" ? "重做 (⌘⇧Z)" : "Redo (⌘⇧Z)"}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 7H6a3.5 3.5 0 0 0 0 7h2" />
                  <path d="M10 4l3 3-3 3" />
                </svg>
              </button>
            </>
          )}
          {!file.isBinary && !file.truncated && (
            <button
              type="button"
              className="file-drawer__icon-btn"
              disabled={saving || !dirty}
              onClick={handleSave}
              title={saving
                ? (locale === "zh" ? "保存中..." : "Saving...")
                : (locale === "zh" ? "保存 (⌘S)" : "Save (⌘S)")}
            >
              {saving ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
                  <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={dirty ? "var(--accent)" : "currentColor"} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 1.5h8.586a1 1 0 0 1 .707.293l2.414 2.414a1 1 0 0 1 .293.707V13a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5Z" />
                  <path d="M5 1.5v3.5h6V1.5" />
                  <rect x="4" y="8.5" width="8" height="4.5" rx="0.5" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            className="file-drawer__icon-btn"
            title={locale === "zh" ? "复制路径" : "Copy path"}
            onClick={handleCopyPath}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#4caf50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 8 6.5 11.5 13 5" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M3 11V3a1.5 1.5 0 0 1 1.5-1.5H11" />
              </svg>
            )}
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
      <div
        ref={bodyRef}
        className={`file-drawer__body${showToc && isMd && tocItems.length > 0 ? " file-drawer__body--with-toc" : ""}`}
        onWheelCapture={handleBodyWheel}
      >
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
          <CodeEditor
            // 切换到不同文件时强制 remount，重置 CodeMirror 内部 history。
            key={file.resolvedPath}
            ref={codeEditorRef}
            className="file-drawer__cm"
            value={editContent}
            onChange={handleContentChange}
            onSave={handleSave}
            onHistoryChange={handleHistoryChange}
            language={editorLanguage}
            theme={editorTheme}
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
        {showToc && isMd && tocItems.length > 0 && (
          <aside className="file-drawer__toc" ref={tocPanelRef}>
            <div className="file-drawer__toc-title">
              {locale === "zh" ? "目录" : "TOC"}
            </div>
            <nav className="file-drawer__toc-nav">
              {tocItems.map((item, i) => (
                <a
                  key={i}
                  className="file-drawer__toc-link"
                  style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                  href={`#${item.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const container = bodyRef.current;
                    if (!container) return;
                    const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
                    for (const el of headings) {
                      const elText = (el.textContent || "").replace(/[^\w\u4e00-\u9fff\s-]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
                      if (elText === item.slug || el.id === item.slug) {
                        el.scrollIntoView({ behavior: "smooth", block: "start" });
                        return;
                      }
                    }
                    if (headings[i]) {
                      headings[i].scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                  }}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
}
