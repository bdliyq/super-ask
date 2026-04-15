import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";

const ABOUT_MARKDOWN_URLS: Record<Locale, string> = {
  zh: "/content/about.zh.md",
  en: "/content/about.en.md",
};

const aboutMarkdownCache: Partial<Record<Locale, string>> = {};

interface AboutPanelProps {
  initialMarkdown?: string;
}

export function AboutPanel({ initialMarkdown }: AboutPanelProps) {
  const { locale, t } = useI18n();
  const [markdown, setMarkdown] = useState<string>(() => {
    return initialMarkdown ?? aboutMarkdownCache[locale] ?? "";
  });

  useEffect(() => {
    const cached = initialMarkdown ?? aboutMarkdownCache[locale] ?? "";
    setMarkdown(cached);
    if (cached) return;

    let cancelled = false;

    void fetch(ABOUT_MARKDOWN_URLS[locale])
      .then(async (resp) => {
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        return resp.text();
      })
      .then((text) => {
        aboutMarkdownCache[locale] = text;
        if (!cancelled) {
          setMarkdown(text);
        }
      })
      .catch((error) => {
        console.warn("[about-panel] load markdown failed:", error);
        if (!cancelled) {
          setMarkdown("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialMarkdown, locale]);

  return (
    <div className="about-panel">
      {markdown ? (
        <div className="about-panel__markdown markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
            }}
          >
            {markdown}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="system-settings__section-desc about-panel__loading">{t.aboutLoading}</p>
      )}
    </div>
  );
}
