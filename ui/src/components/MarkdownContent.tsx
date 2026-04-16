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

function createMarkdownComponents(linkRel: string): Components {
  return {
    a({ node: _node, ...props }) {
      return <a {...props} target="_blank" rel={linkRel} />;
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
}: {
  source: string;
  linkRel?: string;
}) {
  const components = useMemo(() => createMarkdownComponents(linkRel), [linkRel]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {source}
    </ReactMarkdown>
  );
}
