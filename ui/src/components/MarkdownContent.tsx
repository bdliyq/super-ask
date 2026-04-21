import { Children, isValidElement, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidBlock } from "./MermaidBlock";

function nodeToText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return nodeToText(child.props.children);
      }
      return "";
    })
    .join("");
}

function extractMermaidSource(children: ReactNode): string | null {
  const items = Children.toArray(children);
  if (items.length !== 1) {
    return null;
  }

  const first = items[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(first)) {
    return null;
  }

  const className = typeof first.props.className === "string" ? first.props.className : "";
  if (!/\blanguage-mermaid\b/.test(className)) {
    return null;
  }

  return nodeToText(first.props.children).replace(/\n$/, "");
}

const URL_RE = /^https?:\/\/\S+$/;

const ABS_UNIX_RE = /^\/(?:[\w.@+-]+\/)*[\w.@+-]+(?:\.\w+)?$/;
const TILDE_RE = /^~\/(?:[\w.@+-]+\/)*[\w.@+-]+(?:\.\w+)?$/;
const EXPLICIT_REL_RE = /^\.\.?\/(?:[\w.@+-]+\/)*[\w.@+-]+(?:\.\w+)?$/;
const IMPLICIT_REL_RE = /^(?:[\w.@+-]+\/)+[\w.@+-]+\.\w+$/;
const BARE_FILE_RE = /^[\w@+-][\w.@+-]*\.\w+$/;
const FILE_LINE_SUFFIX_RE = /^(.*?)(:\d+(?::\d+)?)$/;

function isFilePath(text: string): boolean {
  return (
    ABS_UNIX_RE.test(text) ||
    TILDE_RE.test(text) ||
    EXPLICIT_REL_RE.test(text) ||
    IMPLICIT_REL_RE.test(text) ||
    BARE_FILE_RE.test(text)
  );
}

function normalizeFilePath(text: string): string | null {
  if (isFilePath(text)) {
    return text;
  }

  const lineMatch = text.match(FILE_LINE_SUFFIX_RE);
  if (!lineMatch) {
    return null;
  }

  const [, pathWithoutLine] = lineMatch;
  return isFilePath(pathWithoutLine) ? pathWithoutLine : null;
}

function decodePathText(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function extractFileLinkPath(href: string | undefined): string | null {
  if (!href || URL_RE.test(href)) {
    return null;
  }

  const normalizedHref = href.startsWith("file://") ? href.slice("file://".length) : href;
  const rawPath = normalizedHref.split(/[?#]/)[0] ?? "";
  if (!rawPath) {
    return null;
  }

  const decodedPath = decodePathText(rawPath);
  return normalizeFilePath(decodedPath) ?? normalizeFilePath(rawPath);
}

interface FileLineSuffix {
  line: number;
  col: number | null;
  raw: string;
}

function extractFileLineSuffix(href: string | undefined): FileLineSuffix | null {
  if (!href || URL_RE.test(href)) {
    return null;
  }
  const normalizedHref = href.startsWith("file://") ? href.slice("file://".length) : href;
  const rawPath = normalizedHref.split(/[?#]/)[0] ?? "";
  if (!rawPath) {
    return null;
  }
  const decodedPath = decodePathText(rawPath);
  const match = decodedPath.match(/:(\d+)(?::(\d+))?$/);
  if (!match) {
    return null;
  }
  const line = Number.parseInt(match[1], 10);
  const col = match[2] ? Number.parseInt(match[2], 10) : null;
  return { line, col, raw: match[0] };
}

function formatFileLineSuffix(suffix: FileLineSuffix): string {
  // 带列号时使用紧凑的 `:line:col` 形式；只有行号时使用更显眼的 `(Line N)` 形式
  if (suffix.col !== null) {
    return suffix.raw;
  }
  return ` (Line ${suffix.line})`;
}

function createMarkdownComponents(
  linkRel: string,
  onOpenPath?: (path: string) => void,
): Components {
  return {
    a({ node: _node, children, className, href, ...props }) {
      const filePath = onOpenPath ? extractFileLinkPath(typeof href === "string" ? href : undefined) : null;
      if (filePath && typeof href === "string") {
        const nextClassName = [className, "clickable-path", "clickable-path--link"].filter(Boolean).join(" ");
        const lineSuffix = extractFileLineSuffix(href);
        const labelText = nodeToText(children);
        // label 已经显式带上 `:line[:col]` 时不再追加，避免出现 `App.tsx:122 (Line 122)` 这种重复
        const shouldAppendSuffix =
          lineSuffix !== null && !labelText.endsWith(lineSuffix.raw);
        return (
          <>
            <a
              {...props}
              href={href}
              className={nextClassName}
              title={filePath}
              onClick={(event) => {
                event.preventDefault();
                onOpenPath(filePath);
              }}
              onKeyDown={(event: React.KeyboardEvent<HTMLAnchorElement>) => {
                if (event.key === " ") {
                  event.preventDefault();
                  onOpenPath(filePath);
                }
              }}
            >
              {children}
            </a>
            {shouldAppendSuffix ? (
              <span className="clickable-path__line-suffix">{formatFileLineSuffix(lineSuffix)}</span>
            ) : null}
          </>
        );
      }

      return <a {...props} href={href} target="_blank" rel={linkRel}>{children}</a>;
    },
    code({ children, className, node: _node, ...props }) {
      if (!className) {
        const text = nodeToText(children).trim();
        if (URL_RE.test(text)) {
          return (
            <code {...props}>
              <a href={text} target="_blank" rel={linkRel}>
                {children}
              </a>
            </code>
          );
        }
        if (onOpenPath) {
          const normalizedPath = normalizeFilePath(text);
          if (normalizedPath) {
            return (
              <code
                {...props}
                className="clickable-path"
                title={text}
                role="button"
                tabIndex={0}
                onClick={() => onOpenPath(normalizedPath)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") onOpenPath(normalizedPath);
                }}
              >
                {children}
              </code>
            );
          }
        }
      }
      return <code className={className} {...props}>{children}</code>;
    },
    pre({ children, ...props }) {
      const source = extractMermaidSource(children);
      if (source !== null) {
        return <MermaidBlock code={source} />;
      }
      return <pre {...props}>{children}</pre>;
    },
  };
}

export function MarkdownContent({
  source,
  linkRel = "noopener noreferrer",
  onOpenPath,
}: {
  source: string;
  linkRel?: string;
  onOpenPath?: (path: string) => void;
}) {
  const components = useMemo(
    () => createMarkdownComponents(linkRel, onOpenPath),
    [linkRel, onOpenPath],
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {source}
    </ReactMarkdown>
  );
}
