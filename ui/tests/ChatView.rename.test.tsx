import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import type { SessionInfo } from "@shared/types";
import { ChatView } from "../src/components/ChatView";
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
  setGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  setGlobal("Event", dom.window.Event);
  setGlobal("KeyboardEvent", dom.window.KeyboardEvent);
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

test("ChatView lets the user enter title-edit mode and submit a renamed title", async () => {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSetTitleCalls: Array<{ chatSessionId: string; title: string }> = [];

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          {React.createElement(ChatView as any, {
            session: makeSession({ title: "Original Title" }),
            onSendReply: async () => {},
            onSetTitle: async (chatSessionId: string, title: string) => {
              onSetTitleCalls.push({ chatSessionId, title });
            },
          })}
        </I18nProvider>,
      );
    });

    const editButton = container.querySelector(".chat-view__title-edit");
    assert.ok(editButton instanceof HTMLButtonElement);

    await act(async () => {
      editButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
    });

    const input = container.querySelector(".chat-view__title-input");
    assert.ok(input instanceof HTMLInputElement);
    assert.equal(input.value, "Original Title");

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "Renamed Session");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });

    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });

    assert.deepEqual(onSetTitleCalls, [
      { chatSessionId: "session-1", title: "Renamed Session" },
    ]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
});

test("ChatView keeps title edit mode open when the rename request is rejected", async () => {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          {React.createElement(ChatView as any, {
            session: makeSession({ title: "Original Title" }),
            onSendReply: async () => {},
            onSetTitle: async () => false,
          })}
        </I18nProvider>,
      );
    });

    const editButton = container.querySelector(".chat-view__title-edit");
    assert.ok(editButton instanceof HTMLButtonElement);

    await act(async () => {
      editButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
    });

    const input = container.querySelector(".chat-view__title-input");
    assert.ok(input instanceof HTMLInputElement);

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "Still Editing");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });

    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });

    const stillOpenInput = container.querySelector(".chat-view__title-input");
    assert.ok(stillOpenInput instanceof HTMLInputElement);
    assert.equal(stillOpenInput.value, "Still Editing");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
});
