import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { expect, it } from "vitest";
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
  setGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  setGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  setGlobal("Event", dom.window.Event);
  setGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  setGlobal("MouseEvent", dom.window.MouseEvent);
  setGlobal("Node", dom.window.Node);
  setGlobal("Element", dom.window.Element);
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

it("ChatView can transition from empty state to a real session without hook order errors", async () => {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  let thrown: unknown = null;
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatView session={undefined} onSendReply={async () => {}} />
        </I18nProvider>,
      );
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatView session={makeSession()} onSendReply={async () => {}} />
        </I18nProvider>,
      );
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalConsoleError;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }

  expect(thrown).toBeNull();
  expect(consoleErrors).toHaveLength(0);
});
