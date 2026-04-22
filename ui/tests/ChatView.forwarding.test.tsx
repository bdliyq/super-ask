import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useMemo, useState } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { SessionInfo } from "@shared/types";
import { ChatView } from "../src/components/ChatView";
import type { QuotedRef } from "../src/components/InteractionCard";
import { I18nProvider } from "../src/i18n/I18nContext";

interface DomEnv {
  readonly dom: JSDOM;
  restore: () => void;
}

function installDom(): DomEnv {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value() {},
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
  setGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  setGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  setGlobal("Event", dom.window.Event);
  setGlobal("MouseEvent", dom.window.MouseEvent);
  setGlobal("KeyboardEvent", dom.window.KeyboardEvent);
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

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    chatSessionId: "session-1",
    title: "Source Session",
    history: [],
    hasPending: false,
    createdAt: 1,
    lastActiveAt: 1,
    requestStatus: "replied",
    ...overrides,
  };
}

function buildForwardingSessions(): SessionInfo[] {
  return [
    makeSession({
      chatSessionId: "session-1",
      title: "Source Session",
      source: "cursor",
      history: [
        {
          role: "agent",
          summary: "Source summary",
          question: "Source question?",
          timestamp: 10,
        },
        {
          role: "user",
          feedback: "Source feedback",
          timestamp: 11,
        },
      ],
      lastActiveAt: 20,
    }),
    makeSession({
      chatSessionId: "session-2",
      title: "Target Session",
      source: "codex",
      history: [],
      createdAt: 2,
      lastActiveAt: 30,
      requestStatus: "pending",
      tags: ["alpha", "beta"],
    }),
  ];
}

test("ChatView forwards a selected message into the target session reply box", async () => {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const sessions = useMemo(() => buildForwardingSessions(), []);
    const [activeSessionId, setActiveSessionId] = useState("session-1");
    const [quotedRefsBySession, setQuotedRefsBySession] = useState<Record<string, QuotedRef[]>>({});
    const session = sessions.find((item) => item.chatSessionId === activeSessionId);
    assert.ok(session);

    return (
      <I18nProvider>
        {React.createElement(ChatView as any, {
          session,
          onSendReply: async () => {},
          quotedRefs: quotedRefsBySession[activeSessionId] ?? [],
          onAppendQuotedRef: (ref: QuotedRef) => {
            setQuotedRefsBySession((prev) => ({
              ...prev,
              [activeSessionId]: [...(prev[activeSessionId] ?? []), ref],
            }));
          },
          onRemoveQuotedRef: (index: number) => {
            setQuotedRefsBySession((prev) => ({
              ...prev,
              [activeSessionId]: (prev[activeSessionId] ?? []).filter((_, itemIndex) => itemIndex !== index),
            }));
          },
          onClearQuotedRefs: () => {
            setQuotedRefsBySession((prev) => ({
              ...prev,
              [activeSessionId]: [],
            }));
          },
          forwardSessions: sessions,
          onForwardQuotedRef: (targetSessionId: string, ref: QuotedRef) => {
            setQuotedRefsBySession((prev) => ({
              ...prev,
              [targetSessionId]: [...(prev[targetSessionId] ?? []), ref],
            }));
            setActiveSessionId(targetSessionId);
          },
        })}
      </I18nProvider>
    );
  }

  try {
    await act(async () => {
      root.render(<Harness />);
    });

    const forwardButtons = container.querySelectorAll('button[title^="Forward "]');
    assert.equal(forwardButtons.length, 3);

    const summaryForwardButton = container.querySelector('button[title="Forward summary"]');
    assert.ok(summaryForwardButton instanceof HTMLButtonElement);

    await act(async () => {
      summaryForwardButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
    });

    const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Target Session/);
    assert.match(dialog.textContent ?? "", /Codex/);
    assert.match(dialog.textContent ?? "", /Awaiting/);
    assert.match(dialog.textContent ?? "", /alpha/);
    assert.match(dialog.textContent ?? "", /beta/);

    const dialogTags = dialog.querySelectorAll(".session-tabs__tag");
    assert.equal(dialogTags.length, 2);
    const dialogSource = dialog.querySelector(".session-tabs__source--codex");
    assert.ok(dialogSource);
    const dialogStatus = dialog.querySelector(".session-tabs__request-status--pending");
    assert.ok(dialogStatus);

    const targetSessionButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Target Session"));
    assert.ok(targetSessionButton instanceof HTMLButtonElement);

    await act(async () => {
      targetSessionButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
    });

    const activeBannerTitle = container.querySelector(".chat-view__banner-title");
    assert.equal(activeBannerTitle?.textContent, "Target Session");

    const quotedRefLabel = container.querySelector(".reply-box__quoted-ref-label");
    assert.ok(quotedRefLabel);
    assert.match(quotedRefLabel.textContent ?? "", /Summary/);
    assert.match(quotedRefLabel.textContent ?? "", /Source Session/);

    const quotedRefText = container.querySelector(".reply-box__quoted-ref-text");
    assert.equal(quotedRefText?.textContent, "Source summary");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
});
