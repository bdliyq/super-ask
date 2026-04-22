import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { QuotedRef } from "../src/components/InteractionCard";
import { ReplyBox } from "../src/components/ReplyBox";
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

test("ReplyBox keeps forwarded quotes in quote style and includes source session in sent markdown", async () => {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSendCalls: Array<{ text: string }> = [];
  const quotedRefs: QuotedRef[] = [
    {
      type: "summary",
      text: "Forwarded summary",
      index: 0,
      sourceSessionId: "session-1",
      sourceSessionTitle: "Source Session",
    } as QuotedRef,
  ];

  try {
    localStorage.setItem("super-ask-draft-session-2", "Additional context");

    await act(async () => {
      root.render(
        <I18nProvider>
          <ReplyBox
            hasPending
            chatSessionId="session-2"
            quotedRefs={quotedRefs}
            onSend={async (text) => {
              onSendCalls.push({ text });
            }}
          />
        </I18nProvider>,
      );
    });

    const quotedRefLabel = container.querySelector(".reply-box__quoted-ref-label");
    assert.ok(quotedRefLabel);
    assert.match(quotedRefLabel.textContent ?? "", /Source Session/);

    const textarea = container.querySelector("textarea");
    assert.ok(textarea instanceof HTMLTextAreaElement);
    assert.equal(textarea.value, "Additional context");

    const sendButton = container.querySelector(".reply-box__send");
    assert.ok(sendButton instanceof HTMLButtonElement);
    assert.equal(sendButton.disabled, false);

    await act(async () => {
      sendButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
    });

    assert.deepEqual(onSendCalls, [
      {
        text: "> **[#1 · Summary · Forwarded from Source Session]**\n> Forwarded summary\n\nAdditional context",
      },
    ]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
});
