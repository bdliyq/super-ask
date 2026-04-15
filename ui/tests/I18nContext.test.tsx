import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  I18nProvider,
  resolveInitialLocale,
  useI18n,
} from "../src/i18n/I18nContext";

test("resolveInitialLocale defaults to English when storage is empty or invalid", () => {
  assert.equal(resolveInitialLocale(null), "en");
  assert.equal(resolveInitialLocale("unexpected"), "en");
  assert.equal(resolveInitialLocale("en"), "en");
  assert.equal(resolveInitialLocale("zh"), "zh");
});

test("I18nProvider ignores legacy locale storage key and still defaults to English", () => {
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key: string) {
      if (key === "super-ask-locale") return "zh";
      return null;
    },
    setItem() {},
    removeItem() {},
    clear() {},
    key() { return null; },
    length: 0,
  } as Storage;

  function LocaleProbe() {
    const { locale } = useI18n();
    return <span>{locale}</span>;
  }

  try {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    assert.match(html, />en</);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});
