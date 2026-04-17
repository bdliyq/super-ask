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

function isFilePath(text: string): boolean {
  return (
    ABS_UNIX_RE.test(text) ||
    TILDE_RE.test(text) ||
    EXPLICIT_REL_RE.test(text) ||
    IMPLICIT_REL_RE.test(text) ||
    BARE_FILE_RE.test(text)
  );
}

function createMarkdownComponents(
  linkRel: string,
  onOpenPath?: (path: string) => void,
): Components {
  return {
    a({ node: _node, ...props }) {
      return <a {...props} target="_blank" rel={linkRel} />;
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
        if (onOpenPath && isFilePath(text)) {
          return (
            <code
              {...props}
              className="clickable-path"
              title={text}
              role="button"
              tabIndex={0}
              onClick={() => onOpenPath(text)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") onOpenPath(text);
              }}
            >
              {children}
            </code>
          );
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
