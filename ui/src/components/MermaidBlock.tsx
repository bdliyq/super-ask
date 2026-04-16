import { useEffect, useId, useMemo, useRef, useState } from "react";

type MermaidTheme = "default" | "dark";

function readTheme(): MermaidTheme {
  if (typeof document === "undefined") {
    return "default";
  }
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
}

export function MermaidBlock({ code }: { code: string }) {
  const diagramId = useId().replace(/:/g, "-");
  const [theme, setTheme] = useState<MermaidTheme>(() => readTheme());
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const source = useMemo(() => code.replace(/\n$/, ""), [code]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }

    const root = document.documentElement;
    const updateTheme = () => setTheme(readTheme());
    updateTheme();

    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === "data-theme")) {
        updateTheme();
      }
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
        });

        const rendered = await mermaid.render(`mermaid-${diagramId}`, source);
        if (cancelled) {
          return;
        }

        bindFunctionsRef.current = rendered.bindFunctions;
        setSvg(rendered.svg);
        setError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        bindFunctionsRef.current = undefined;
        setSvg(null);
        setError(err instanceof Error ? err.message : "Mermaid render failed");
      }
    }

    setSvg(null);
    setError(null);
    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [diagramId, source, theme]);

  useEffect(() => {
    if (!svg || !bindFunctionsRef.current || !containerRef.current) {
      return;
    }
    bindFunctionsRef.current(containerRef.current);
  }, [svg]);

  return (
    <div className="markdown-mermaid" data-mermaid-source={source}>
      {svg ? (
        <div
          ref={containerRef}
          className="markdown-mermaid__diagram"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : error ? (
        <div className="markdown-mermaid__error">
          <div className="markdown-mermaid__error-label">Mermaid render failed</div>
          <div className="markdown-mermaid__error-message">{error}</div>
          <pre className="markdown-mermaid__fallback">
            <code>{source}</code>
          </pre>
        </div>
      ) : (
        <pre className="markdown-mermaid__fallback">
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
