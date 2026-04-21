import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { expect, it } from "vitest";
import type { ReadFileResponse } from "@shared/types";
import { FileDrawer } from "../src/components/FileDrawer";
import { I18nProvider } from "../src/i18n/I18nContext";

const LONG_LINE = 'const marker = "RIGHT_EDGE_MARKER"; '.repeat(24);

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
  setGlobal("Node", dom.window.Node);
  setGlobal("Element", dom.window.Element);
  setGlobal("Event", dom.window.Event);
  setGlobal("MouseEvent", dom.window.MouseEvent);
  setGlobal("MutationObserver", dom.window.MutationObserver);
  setGlobal("DOMParser", dom.window.DOMParser);
  setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
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

function makeFile(overrides: Partial<ReadFileResponse> = {}): ReadFileResponse {
  return {
    content: `${LONG_LINE}\nsecond line\n`,
    resolvedPath: "/Users/leoli/workspace/super-ask/ui/src/example.ts",
    size: LONG_LINE.length + "second line\n".length + 1,
    lang: "typescript",
    isBinary: false,
    truncated: false,
    ...overrides,
  };
}

it("FileDrawer edit mode keeps one visual row per document line so gutter numbers stay aligned", async () => {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <FileDrawer file={makeFile()} onClose={() => {}} />
        </I18nProvider>,
      );
    });

    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(container.querySelector(".cm-lineWrapping")).toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    env.restore();
  }
});
