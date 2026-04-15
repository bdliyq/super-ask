import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { I18nProvider } from "../src/i18n/I18nContext";

const aboutMarkdownByLocale = {
  zh: readFileSync(new URL("../public/content/about.zh.md", import.meta.url), "utf8"),
  en: readFileSync(new URL("../public/content/about.en.md", import.meta.url), "utf8"),
} as const;

function renderSettingsPanelWithLocale(
  storedLocale: string | null,
  initialTab: "system" | "deploy" | "about",
) {
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      return storedLocale;
    },
    setItem() {},
    removeItem() {},
    clear() {},
    key() {
      return null;
    },
    length: 0,
  } as Storage;

  try {
    return renderToStaticMarkup(
      <I18nProvider>
        <SettingsPanel initialTab={initialTab} aboutMarkdownByLocale={aboutMarkdownByLocale} />
      </I18nProvider>,
    );
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
}

test("SettingsPanel renders Chinese about page with bilingual product content and contacts", () => {
  const html = renderSettingsPanelWithLocale("zh", "about");

  assert.match(html, />关于</);
  assert.match(html, /markdown-body/);
  assert.match(html, /产品简介/);
  assert.match(html, /多轮人机交互中间件/);
  assert.match(html, /特色功能/);
  assert.match(html, /阻塞式交互/);
  assert.match(html, /高效消息管理/);
  assert.match(html, /联系方式/);
  assert.match(html, /mailto:support@aidb\.live/);
  assert.match(html, /https:\/\/github\.com\/bdliyq\/super-ask/);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 2);
  assert.equal((html.match(/rel="noreferrer"/g) ?? []).length, 2);
});

test("SettingsPanel renders English about page when locale is en", () => {
  const html = renderSettingsPanelWithLocale("en", "about");

  assert.match(html, />About</);
  assert.match(html, /markdown-body/);
  assert.match(html, /Product Introduction/);
  assert.match(html, /human-in-the-loop middleware/);
  assert.match(html, /Features/);
  assert.match(html, /Blocking interaction/);
  assert.match(html, /Efficient message handling/);
  assert.match(html, /Contact/);
  assert.match(html, /support@aidb\.live/);
  assert.match(html, /bdliyq\/super-ask/);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 2);
  assert.equal((html.match(/rel="noreferrer"/g) ?? []).length, 2);
});
