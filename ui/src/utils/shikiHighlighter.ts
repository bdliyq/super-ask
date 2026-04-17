import type { Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import("shiki");
      return createHighlighter({
        themes: ["one-dark-pro", "github-light"],
        langs: [],
      });
    })();
  }
  return highlighterPromise;
}

export async function highlightCode(
  code: string,
  lang: string,
  theme: "one-dark-pro" | "github-light" = "one-dark-pro",
): Promise<string> {
  const hl = await getHighlighter();
  if (lang && lang !== "plaintext" && !loadedLangs.has(lang)) {
    try {
      await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0]);
      loadedLangs.add(lang);
    } catch {
      return escapeHtml(code);
    }
  }
  if (!lang || lang === "plaintext" || !loadedLangs.has(lang)) {
    return escapeHtml(code);
  }
  return hl.codeToHtml(code, { lang, theme });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const MD_EXTENSIONS = new Set(["md", "mdx", "markdown", "mdc"]);

export function isMarkdownFile(lang: string | null, resolvedPath: string): boolean {
  if (lang && MD_EXTENSIONS.has(lang)) return true;
  const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
  return MD_EXTENSIONS.has(ext);
}
