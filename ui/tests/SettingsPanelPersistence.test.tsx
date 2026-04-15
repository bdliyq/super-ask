import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPanel, resolveInitialSettingsTab } from "../src/components/SettingsPanel";
import { I18nProvider } from "../src/i18n/I18nContext";

const aboutMarkdownByLocale = {
  zh: readFileSync(new URL("../public/content/about.zh.md", import.meta.url), "utf8"),
  en: readFileSync(new URL("../public/content/about.en.md", import.meta.url), "utf8"),
} as const;

test("resolveInitialSettingsTab restores only known settings tabs", () => {
  assert.equal(resolveInitialSettingsTab("system"), "system");
  assert.equal(resolveInitialSettingsTab("deploy"), "deploy");
  assert.equal(resolveInitialSettingsTab("about"), "about");
  assert.equal(resolveInitialSettingsTab("unexpected"), null);
  assert.equal(resolveInitialSettingsTab(null), null);
});

test("SettingsPanel restores the previously active tab from storage on refresh", () => {
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key: string) {
      if (key === "super-ask-locale-v2") return "en";
      if (key === "super-ask-settings-tab") return "about";
      return null;
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
    const html = renderToStaticMarkup(
      <I18nProvider>
        <SettingsPanel initialTab="deploy" aboutMarkdownByLocale={aboutMarkdownByLocale} />
      </I18nProvider>,
    );

    assert.match(html, /settings-panel__nav-item settings-panel__nav-item--active">About</);
    assert.match(html, /Overview/);
    assert.doesNotMatch(html, /Deploy Management<\/button><\/nav><div class="settings-panel__content"><div class="deploy-panel">/);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});
