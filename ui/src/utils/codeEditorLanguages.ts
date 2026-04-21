import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { php } from "@codemirror/lang-php";

// 把 server 返回的 lang 字符串映射到 CodeMirror 6 LanguageSupport extension。
// 不在表里的 lang 走 null（即纯文本，不挂 parser，但仍可正常编辑/选中）。
export function getCodeEditorLanguage(lang: string | null): Extension | null {
  if (!lang) return null;
  switch (lang) {
    case "javascript":
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "python":
      return python();
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "html":
    case "vue":
    case "svelte":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "markdown":
    case "mdx":
      return markdown();
    case "rust":
      return rust();
    case "go":
      return go();
    case "java":
    case "kotlin":
      return java();
    case "cpp":
    case "c":
      return cpp();
    case "sql":
      return sql();
    case "xml":
    case "svg":
      return xml();
    case "php":
      return php();
    default:
      return null;
  }
}
