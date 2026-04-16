import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionInfo } from "@shared/types";
import { ChatView } from "../src/components/ChatView";
import { I18nProvider } from "../src/i18n/I18nContext";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    chatSessionId: "session-1",
    title: "Session",
    history: [],
    hasPending: false,
    createdAt: 1,
    lastActiveAt: 1,
    requestStatus: "replied",
    ...overrides,
  };
}

function renderChatViewWithStoredLocale(storedLocale: string | null, session: SessionInfo) {
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
        <ChatView session={session} onSendReply={async () => {}} />
      </I18nProvider>,
    );
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
}

test("ChatView renders the add-tag button before the request status badge in the banner", () => {
  const html = renderChatViewWithStoredLocale(
    "en",
    makeSession({ source: "cursor", tags: ["alpha"] }),
  );

  const tagAddIndex = html.indexOf("chat-view__tag-add-btn");
  const requestStatusIndex = html.indexOf("session-tabs__request-status");

  assert.notEqual(tagAddIndex, -1);
  assert.notEqual(requestStatusIndex, -1);
  assert.ok(tagAddIndex < requestStatusIndex);
});
