import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "@shared/types";
import * as useSessionsModule from "../src/hooks/useSessions";

function makeSession(chatSessionId: string, lastActiveAt: number): SessionInfo {
  return {
    chatSessionId,
    title: chatSessionId,
    history: [],
    hasPending: false,
    createdAt: lastActiveAt - 1000,
    lastActiveAt,
    requestStatus: "replied",
  };
}

test("sortSessionsForSidebar keeps pinned sessions at the top in pin order", () => {
  const sortSessionsForSidebar = (useSessionsModule as {
    sortSessionsForSidebar?: (sessions: SessionInfo[], pinnedSessionIds: string[]) => SessionInfo[];
  }).sortSessionsForSidebar;

  assert.equal(typeof sortSessionsForSidebar, "function");

  const ordered = sortSessionsForSidebar!(
    [
      makeSession("session-a", 100),
      makeSession("session-b", 300),
      makeSession("session-c", 200),
    ],
    ["session-c", "session-a", "session-missing"],
  );

  assert.deepEqual(
    ordered.map((session) => session.chatSessionId),
    ["session-c", "session-a", "session-b"],
  );
});

test("togglePinnedSessionOrder pins new sessions to the top and unpins existing ones", () => {
  const togglePinnedSessionOrder = (useSessionsModule as {
    togglePinnedSessionOrder?: (pinnedSessionIds: string[], chatSessionId: string) => string[];
  }).togglePinnedSessionOrder;

  assert.equal(typeof togglePinnedSessionOrder, "function");
  assert.deepEqual(togglePinnedSessionOrder!([], "session-a"), ["session-a"]);
  assert.deepEqual(togglePinnedSessionOrder!(["session-a", "session-c"], "session-b"), [
    "session-b",
    "session-a",
    "session-c",
  ]);
  assert.deepEqual(togglePinnedSessionOrder!(["session-b", "session-a", "session-c"], "session-a"), [
    "session-b",
    "session-c",
  ]);
});

test("resolvePinnedSessionOrderFromSync prefers server order and prunes invalid ids", () => {
  const resolvePinnedSessionOrderFromSync = (useSessionsModule as {
    resolvePinnedSessionOrderFromSync?: (
      serverPinnedSessionIds: string[] | undefined,
      localPinnedSessionIds: string[],
      sessionIds: Iterable<string>,
    ) => string[];
  }).resolvePinnedSessionOrderFromSync;

  assert.equal(typeof resolvePinnedSessionOrderFromSync, "function");
  assert.deepEqual(
    resolvePinnedSessionOrderFromSync!(
      ["session-b", "session-a", "session-b", "session-missing", " "],
      ["session-a"],
      ["session-a", "session-b", "session-c"],
    ),
    ["session-b", "session-a"],
  );
});

test("resolvePinnedSessionOrderFromSync falls back to local cache for older sync payloads", () => {
  const resolvePinnedSessionOrderFromSync = (useSessionsModule as {
    resolvePinnedSessionOrderFromSync?: (
      serverPinnedSessionIds: string[] | undefined,
      localPinnedSessionIds: string[],
      sessionIds: Iterable<string>,
    ) => string[];
  }).resolvePinnedSessionOrderFromSync;

  assert.equal(typeof resolvePinnedSessionOrderFromSync, "function");
  assert.deepEqual(
    resolvePinnedSessionOrderFromSync!(
      undefined,
      ["session-c", "session-missing", "session-a"],
      ["session-a", "session-b", "session-c"],
    ),
    ["session-c", "session-a"],
  );
});
