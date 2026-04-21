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
  setGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0));
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

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    chatSessionId: "session-a",
    title: "Original Title",
    history: [],
    hasPending: false,
    createdAt: 10,
    lastActiveAt: 20,
    requestStatus: "replied",
    ...overrides,
  };
}

test("useSessions applies session_title_update without changing session ordering timestamps", async () => {
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

    await act(async () => {
      latest!.handleServerMessage({
        type: "sync",
        sessions: [makeSession()],
        pinnedSessionIds: [],
      });
    });

    assert.equal(latest!.activeSession?.title, "Original Title");
    assert.equal(latest!.activeSession?.lastActiveAt, 20);

    await act(async () => {
      latest!.handleServerMessage({
        type: "session_title_update",
        chatSessionId: "session-a",
        title: "Renamed Title",
      });
    });

    assert.equal(latest!.activeSession?.title, "Renamed Title");
    assert.equal(latest!.sortedSessions[0]?.title, "Renamed Title");
    assert.equal(latest!.activeSession?.lastActiveAt, 20);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
});
