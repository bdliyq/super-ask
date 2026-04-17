import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
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
  setGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  setGlobal("Event", dom.window.Event);
  setGlobal("MouseEvent", dom.window.MouseEvent);
  setGlobal("WheelEvent", dom.window.WheelEvent);
  setGlobal("Node", dom.window.Node);
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
    content: `${LONG_LINE}\n`,
    resolvedPath: "/Users/leoli/workspace/super-ask/ui/src/example.ts",
    size: LONG_LINE.length + 1,
    lang: "typescript",
    isBinary: false,
    truncated: false,
    ...overrides,
  };
}

async function renderFileDrawer(file: ReadFileResponse) {
  const env = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <I18nProvider>
        <FileDrawer file={file} onClose={() => {}} />
      </I18nProvider>,
    );
  });

  return {
    env,
    container,
    cleanup: async () => {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      container.remove();
      env.restore();
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function setHorizontalMetrics(el: HTMLElement, clientWidth: number, scrollWidth: number) {
  let scrollLeft = 0;
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    get: () => clientWidth,
  });
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      const maxLeft = Math.max(0, scrollWidth - clientWidth);
      scrollLeft = Math.max(0, Math.min(maxLeft, Number(value)));
    },
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
  assert.ok(reactPropsKey);
  const reactProps = (textarea as unknown as Record<string, { onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void }>)[reactPropsKey];
  assert.equal(typeof reactProps?.onChange, "function");
  reactProps.onChange?.({
    target: { value },
  } as React.ChangeEvent<HTMLTextAreaElement>);
}

test("FileDrawer forwards horizontal wheel on the edit surface to the textarea", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "plaintext",
      resolvedPath: "/Users/leoli/workspace/super-ask/docs/example.txt",
    }),
  );

  try {
    const body = rendered.container.querySelector(".file-drawer__body");
    const wrapper = rendered.container.querySelector(".file-drawer__editor-wrapper");
    const textarea = rendered.container.querySelector(".file-drawer__editor");

    assert.ok(body instanceof HTMLElement);
    assert.ok(wrapper instanceof HTMLElement);
    assert.ok(textarea instanceof HTMLTextAreaElement);

    setHorizontalMetrics(body, 320, 320);
    setHorizontalMetrics(textarea, 320, 1200);

    await act(async () => {
      wrapper.dispatchEvent(new window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 120,
      }));
    });

    assert.equal(body.scrollLeft, 0);
    assert.equal(textarea.scrollLeft, 120);
  } finally {
    await rendered.cleanup();
  }
});

test("FileDrawer ignores diagonal wheel gestures on the edit surface when vertical movement is also present", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "plaintext",
      resolvedPath: "/Users/leoli/workspace/super-ask/docs/example.txt",
    }),
  );

  try {
    const wrapper = rendered.container.querySelector(".file-drawer__editor-wrapper");
    const textarea = rendered.container.querySelector(".file-drawer__editor");

    assert.ok(wrapper instanceof HTMLElement);
    assert.ok(textarea instanceof HTMLTextAreaElement);

    setHorizontalMetrics(textarea, 320, 1200);

    await act(async () => {
      wrapper.dispatchEvent(new window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 120,
        deltaY: 60,
      }));
    });

    assert.equal(textarea.scrollLeft, 0);
  } finally {
    await rendered.cleanup();
  }
});

test("FileDrawer forwards horizontal wheel on markdown preview body to a single code block", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "markdown",
      resolvedPath: "/Users/leoli/workspace/super-ask/docs/example.md",
      content: `# Example\n\n\`\`\`ts\n${LONG_LINE}\n\`\`\`\n`,
      size: LONG_LINE.length + 22,
    }),
  );

  try {
    const previewButton = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Preview",
    );

    assert.ok(previewButton instanceof HTMLElement);

    await act(async () => {
      previewButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
    });

    const body = rendered.container.querySelector(".file-drawer__body");
    const pre = rendered.container.querySelector(".file-drawer__markdown pre");

    assert.ok(body instanceof HTMLElement);
    assert.ok(pre instanceof HTMLElement);

    setHorizontalMetrics(body, 320, 320);
    setHorizontalMetrics(pre, 320, 1200);

    await act(async () => {
      body.dispatchEvent(new window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 120,
      }));
    });

    assert.equal(body.scrollLeft, 0);
    assert.equal(pre.scrollLeft, 120);
  } finally {
    await rendered.cleanup();
  }
});

test("FileDrawer renders the edit highlight layer as a div so Shiki pre is not nested inside another pre", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "typescript",
      resolvedPath: "/Users/leoli/workspace/super-ask/ui/src/example.ts",
    }),
  );

  try {
    await waitFor(() => rendered.container.querySelector(".file-drawer__editor-highlight .shiki") !== null);

    const highlightLayer = rendered.container.querySelector(".file-drawer__editor-highlight");
    const shikiPre = rendered.container.querySelector(".file-drawer__editor-highlight .shiki");

    assert.ok(highlightLayer instanceof HTMLElement);
    assert.ok(shikiPre instanceof HTMLElement);
    assert.equal(highlightLayer.tagName, "DIV");
    assert.equal(shikiPre.tagName, "PRE");
  } finally {
    await rendered.cleanup();
  }
});

test("FileDrawer clears the dirty indicator and disables save after undo returns to the original content", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "plaintext",
      resolvedPath: "/Users/leoli/workspace/super-ask/docs/example.txt",
      content: "hello",
      size: 5,
    }),
  );

  try {
    const textarea = rendered.container.querySelector(".file-drawer__editor");
    const saveButton = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.getAttribute("title") === "Save (⌘S)",
    );
    const undoButton = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.getAttribute("title") === "Undo (⌘Z)",
    );

    assert.ok(textarea instanceof HTMLTextAreaElement);
    assert.ok(saveButton instanceof HTMLElement);
    assert.ok(undoButton instanceof HTMLElement);
    assert.equal(rendered.container.querySelector(".file-drawer__dirty-dot"), null);
    assert.equal((saveButton as HTMLButtonElement).disabled, true);

    await act(async () => {
      setTextareaValue(textarea, "hello!");
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    assert.ok(rendered.container.querySelector(".file-drawer__dirty-dot"));
    assert.equal((saveButton as HTMLButtonElement).disabled, false);
    assert.equal((undoButton as HTMLButtonElement).disabled, false);

    await act(async () => {
      undoButton.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(textarea.value, "hello");
    assert.equal(rendered.container.querySelector(".file-drawer__dirty-dot"), null);
    assert.equal((saveButton as HTMLButtonElement).disabled, true);
  } finally {
    await rendered.cleanup();
  }
});
