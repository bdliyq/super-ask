import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import type { SessionInfo } from "@shared/types";
import { useSessions } from "../src/hooks/useSessions";

interface DomEnv {
  readonly dom: JSDOM;
  restore: () => void;
}

function installDom(): DomEnv {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1/",
    pretendToBeVisual: true,
  });

  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("HTMLElement", dom.window.HTMLElement);
  setGlobal("Event", dom.window.Event);
  setGlobal("MouseEvent", dom.window.MouseEvent);
  setGlobal("Node", dom.window.Node);
  setGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0),
  );
  setGlobal("cancelAnimationFrame", (id: number) => dom.window.clearTimeout(id));
  setGlobal("localStorage", dom.window.localStorage);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    dom,
    restore() {
      for (const [name, descriptor] of previousDescriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
      dom.window.close();
    },
  };
}

function baseSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    chatSessionId: "session-a",
    title: "Session A",
    history: [],
    hasPending: false,
    createdAt: 10,
    lastActiveAt: 20,
    requestStatus: "replied",
    ...overrides,
  };
}

async function withHarness(
  fn: (
    harness: { current: () => ReturnType<typeof useSessions> },
    env: DomEnv,
    root: Root,
  ) => Promise<void>,
): Promise<void> {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: ReturnType<typeof useSessions> | null = null;

  function Harness() {
    latest = useSessions();
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    assert.ok(latest);
    await fn(
      {
        current: () => {
          assert.ok(latest);
          return latest!;
        },
      },
      env,
      root,
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
}

test(
  "useSessions: new_request with existing same-requestId agent entry (resumed) does not duplicate history",
  async () => {
    await withHarness(async (hook) => {
      // 初始 sync：session-a 已有一条带 requestId 的 agent 历史项，
      // 模拟服务端在重启前已经把该请求落盘
      await act(async () => {
        hook.current().handleServerMessage({
          type: "sync",
          sessions: [
            baseSession({
              chatSessionId: "session-a",
              history: [
                {
                  role: "agent",
                  summary: "old summary",
                  question: "old?",
                  timestamp: 100,
                  requestId: "rid-resume",
                },
              ],
              hasPending: false,
              requestStatus: "cancelled",
            }),
          ],
          pinnedSessionIds: [],
        });
      });

      assert.equal(hook.current().sortedSessions[0]?.history.length, 1);
      assert.equal(hook.current().activeSession?.requestStatus, "cancelled");

      // 服务端 dedup 分支广播 new_request（同 requestId，带 resumed=true）
      await act(async () => {
        hook.current().handleServerMessage({
          type: "new_request",
          chatSessionId: "session-a",
          title: "Session A",
          summary: "old summary",
          question: "old?",
          isNewSession: false,
          requestId: "rid-resume",
          resumed: true,
        });
      });

      const s = hook.current().activeSession;
      assert.ok(s);
      // 历史项不能被重复追加
      assert.equal(s.history.length, 1, `expected 1 history entry after resume, got ${s.history.length}`);
      // 状态必须恢复为 pending，让 UI 重新显示"等待用户回复"
      assert.equal(s.hasPending, true);
      assert.equal(s.requestStatus, "pending");
    });
  },
);

test(
  "useSessions: new_request with new requestId still appends a fresh agent entry",
  async () => {
    await withHarness(async (hook) => {
      await act(async () => {
        hook.current().handleServerMessage({
          type: "sync",
          sessions: [
            baseSession({
              chatSessionId: "session-a",
              history: [
                {
                  role: "agent",
                  summary: "first",
                  question: "q1?",
                  timestamp: 100,
                  requestId: "rid-1",
                },
              ],
              hasPending: false,
              requestStatus: "replied",
            }),
          ],
          pinnedSessionIds: [],
        });
      });

      await act(async () => {
        hook.current().handleServerMessage({
          type: "new_request",
          chatSessionId: "session-a",
          title: "Session A",
          summary: "second",
          question: "q2?",
          isNewSession: false,
          requestId: "rid-2",
        });
      });

      const s = hook.current().activeSession;
      assert.ok(s);
      // 不同 requestId，必须追加新历史项
      assert.equal(s.history.length, 2);
      assert.equal(s.history[1]?.question, "q2?");
      assert.equal(s.history[1]?.requestId, "rid-2");
      assert.equal(s.hasPending, true);
      assert.equal(s.requestStatus, "pending");
    });
  },
);

test(
  "useSessions: resumed new_request only deduplicates against the tail agent entry, not before a user reply",
  async () => {
    await withHarness(async (hook) => {
      // 历史：agent(rid-X) → user reply → （新的 agent 用 rid-X 重发，少见但要稳定）
      // 此时"尾部 agent 有 rid-X"不成立——遇到 user 分支即 break，视为不同逻辑请求，
      // 应当追加新历史项，避免丢消息
      await act(async () => {
        hook.current().handleServerMessage({
          type: "sync",
          sessions: [
            baseSession({
              chatSessionId: "session-a",
              history: [
                {
                  role: "agent",
                  summary: "s1",
                  question: "q1?",
                  timestamp: 100,
                  requestId: "rid-X",
                },
                {
                  role: "user",
                  feedback: "ok",
                  timestamp: 110,
                },
              ],
              hasPending: false,
              requestStatus: "acked",
            }),
          ],
          pinnedSessionIds: [],
        });
      });

      await act(async () => {
        hook.current().handleServerMessage({
          type: "new_request",
          chatSessionId: "session-a",
          title: "Session A",
          summary: "s2",
          question: "q2?",
          isNewSession: false,
          requestId: "rid-X",
        });
      });

      const s = hook.current().activeSession;
      assert.ok(s);
      assert.equal(s.history.length, 3);
      assert.equal(s.history[2]?.role, "agent");
      assert.equal(s.history[2]?.question, "q2?");
    });
  },
);
