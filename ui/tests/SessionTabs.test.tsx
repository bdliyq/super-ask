import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionInfo } from "@shared/types";
import * as sessionTabsModule from "../src/components/SessionTabs";
import { SessionTabs } from "../src/components/SessionTabs";
import { I18nProvider } from "../src/i18n/I18nContext";

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
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

function renderSessionTabsWithStoredLocale(storedLocale: string | null, props: Record<string, unknown> = {}) {
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
        {React.createElement(SessionTabs as any, {
          sessions: [],
          activeSessionId: null,
          onSelect: () => {},
          onDelete: () => {},
          ...props,
        })}
      </I18nProvider>,
    );
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
}

test("SessionTabs shows Chinese banner title when locale is zh", () => {
  const html = renderSessionTabsWithStoredLocale("zh");

  assert.match(html, /session-tabs__banner/);
  assert.match(html, /会话/);
  assert.doesNotMatch(html, /会话\/sessions/);
  assert.doesNotMatch(html, /session-tabs__header/);
});

test("SessionTabs shows English banner title when locale is en", () => {
  const html = renderSessionTabsWithStoredLocale("en");

  assert.match(html, /session-tabs__banner/);
  assert.match(html, /Session List/);
  assert.doesNotMatch(html, /会话\/sessions/);
  assert.doesNotMatch(html, /session-tabs__header/);
});

test("SessionTabs marks pinned rows and renders pin controls for hover actions", () => {
  const html = renderSessionTabsWithStoredLocale("en", {
    sessions: [
      makeSession({ chatSessionId: "session-pinned", title: "Pinned Session", source: "cursor" }),
      makeSession({ chatSessionId: "session-plain", title: "Plain Session", lastActiveAt: 2, source: "codex" }),
    ],
    activeSessionId: "session-plain",
    pinnedSessionIds: ["session-pinned"],
    onTogglePin: () => {},
  });

  assert.match(html, /session-tabs__item--pinned/);
  assert.match(html, /session-tabs__pin/);
  assert.match(
    html,
    /session-tabs__item[^"]*session-tabs__item--pinned[\s\S]*session-tabs__pin[\s\S]*session-tabs__source[\s\S]*Pinned Session/,
  );
  assert.match(html, /aria-label="Unpin Pinned Session"/);
  assert.match(html, /aria-label="Pin Plain Session"/);
  assert.match(html, /session-tabs__delete-icon/);
  assert.doesNotMatch(html, />✕</);
});

test("SessionTabs shows custom tags for pinned sessions in the pinned group", () => {
  const html = renderSessionTabsWithStoredLocale("en", {
    sessions: [
      makeSession({
        chatSessionId: "session-pinned",
        title: "Pinned Session",
        source: "cursor",
        tags: ["alpha", "beta"],
      }),
    ],
    activeSessionId: "session-pinned",
    pinnedSessionIds: ["session-pinned"],
    onTogglePin: () => {},
  });

  assert.match(
    html,
    /session-tabs__group--pinned[\s\S]*session-tabs__item-title[^>]*>Pinned Session<\/span>[\s\S]*session-tabs__tags[\s\S]*session-tabs__tag[^>]*>alpha<\/span>[\s\S]*session-tabs__tag[^>]*>beta<\/span>/,
  );
});

test("buildSessionGroups splits sessions into today yesterday recent7 and older buckets", () => {
  const buildSessionGroups = (sessionTabsModule as {
    buildSessionGroups?: (sessions: SessionInfo[], now?: number) => Array<{ key: string; sessions: SessionInfo[] }>;
  }).buildSessionGroups;

  assert.equal(typeof buildSessionGroups, "function");

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const at = (dayOffset: number, hour: number) => {
    const d = new Date(todayStart);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };

  const groups = buildSessionGroups!(
    [
      makeSession({ chatSessionId: "today-1", title: "Today 1", lastActiveAt: at(0, 9) }),
      makeSession({ chatSessionId: "yesterday-1", title: "Yesterday 1", lastActiveAt: at(-1, 18) }),
      makeSession({ chatSessionId: "recent-1", title: "Recent 1", lastActiveAt: at(-3, 14) }),
      makeSession({ chatSessionId: "older-1", title: "Older 1", lastActiveAt: at(-12, 10) }),
    ],
    at(0, 12),
  );

  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions.map((session) => session.chatSessionId)]),
    [
      ["today", ["today-1"]],
      ["yesterday", ["yesterday-1"]],
      ["recent7", ["recent-1"]],
      ["older", ["older-1"]],
    ],
  );
});

test("getNextVisibleCountForGroup increases visible rows by ten and caps at the group size", () => {
  const getNextVisibleCountForGroup = (sessionTabsModule as {
    getNextVisibleCountForGroup?: (currentVisibleCount: number, totalSessions: number) => number;
  }).getNextVisibleCountForGroup;

  assert.equal(typeof getNextVisibleCountForGroup, "function");
  assert.equal(getNextVisibleCountForGroup!(10, 25), 20);
  assert.equal(getNextVisibleCountForGroup!(20, 25), 25);
  assert.equal(getNextVisibleCountForGroup!(25, 25), 25);
});

test("getVisibleCountForGroup defaults each group to ten sessions", () => {
  const getVisibleCountForGroup = (sessionTabsModule as {
    getVisibleCountForGroup?: (sessions: SessionInfo[], visibleLimit?: number) => number;
  }).getVisibleCountForGroup;

  assert.equal(typeof getVisibleCountForGroup, "function");

  const sessions = Array.from({ length: 11 }, (_, index) =>
    makeSession({
      chatSessionId: `today-${index + 1}`,
      title: `Today ${index + 1}`,
      lastActiveAt: index + 1,
    }),
  );

  assert.equal(getVisibleCountForGroup!(sessions), 10);
});

test("getVisibleCountForGroup respects the revealed limit and never exceeds the group size", () => {
  const getVisibleCountForGroup = (sessionTabsModule as {
    getVisibleCountForGroup?: (sessions: SessionInfo[], visibleLimit?: number) => number;
  }).getVisibleCountForGroup;

  assert.equal(typeof getVisibleCountForGroup, "function");

  const sessions = Array.from({ length: 25 }, (_, index) =>
    makeSession({
      chatSessionId: `today-${index + 1}`,
      title: `Today ${index + 1}`,
      lastActiveAt: index + 1,
    }),
  );

  assert.equal(getVisibleCountForGroup!(sessions, 20), 20);
  assert.equal(getVisibleCountForGroup!(sessions, 30), 25);
});

test("SessionTabs initially renders ten rows and keeps show more with the remaining count", () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sessions = Array.from({ length: 11 }, (_, index) => {
    const d = new Date(todayStart);
    d.setHours(20 - index, 0, 0, 0);
    return makeSession({
      chatSessionId: `today-${index + 1}`,
      title: `Today ${index + 1}`,
      lastActiveAt: d.getTime(),
    });
  });

  const html = renderSessionTabsWithStoredLocale("en", {
    sessions,
    activeSessionId: "today-1",
  });

  assert.match(html, /Today/);
  assert.match(html, /Show more \(1\)/);
  assert.match(html, />Today 10</);
  assert.doesNotMatch(html, />Today 11</);
});

test("SessionTabs does not expose grouped sessions as a tablist", () => {
  const html = renderSessionTabsWithStoredLocale("en", {
    sessions: [makeSession({ chatSessionId: "session-a", title: "Session A", lastActiveAt: Date.now() })],
    activeSessionId: "session-a",
  });

  assert.doesNotMatch(html, /role="tablist"/);
  assert.match(html, /role="button"/);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(html, /role="tab"/);
});
