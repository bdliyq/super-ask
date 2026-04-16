import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";
import { MarkdownContent } from "./MarkdownContent";

const ABOUT_MARKDOWN_URLS: Record<Locale, string> = {
  zh: "/content/about.zh.md",
  en: "/content/about.en.md",
};

const aboutMarkdownCache: Partial<Record<Locale, string>> = {};

interface AboutPanelProps {
  initialMarkdown?: string;
}

type AboutLoadIssue = { kind: "empty" } | { kind: "failed"; detail: string };

export function AboutPanel({ initialMarkdown }: AboutPanelProps) {
  const { locale, t } = useI18n();
  const [markdown, setMarkdown] = useState<string>(() => {
    return initialMarkdown ?? aboutMarkdownCache[locale] ?? "";
  });
  const [loadIssue, setLoadIssue] = useState<AboutLoadIssue | null>(null);

  useEffect(() => {
    const cached = initialMarkdown ?? aboutMarkdownCache[locale] ?? "";
    setMarkdown(cached);
    setLoadIssue(null);
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
        if (!text.trim()) {
          if (!cancelled) {
            setMarkdown("");
            setLoadIssue({ kind: "empty" });
          }
          return;
        }
        aboutMarkdownCache[locale] = text;
        if (!cancelled) {
          setMarkdown(text);
          setLoadIssue(null);
        }
      })
      .catch((error) => {
        console.warn("[about-panel] load markdown failed:", error);
        if (!cancelled) {
          setMarkdown("");
          setLoadIssue({
            kind: "failed",
            detail: error instanceof Error ? error.message : String(error),
          });
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
          <MarkdownContent source={markdown} linkRel="noreferrer" />
        </div>
      ) : loadIssue ? (
        <div className="about-panel__error">
          <p className="system-settings__section-desc about-panel__loading">
            {loadIssue.kind === "empty" ? t.aboutEmpty : t.aboutLoadFailed}
          </p>
          {loadIssue.kind === "failed" ? (
            <pre className="about-panel__error-detail">{loadIssue.detail}</pre>
          ) : null}
        </div>
      ) : (
        <p className="system-settings__section-desc about-panel__loading">{t.aboutLoading}</p>
      )}
    </div>
  );
}
