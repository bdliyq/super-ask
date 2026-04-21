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

test("FileDrawer mounts CodeMirror container in edit mode", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "typescript",
      resolvedPath: "/Users/leoli/workspace/super-ask/ui/src/example.ts",
    }),
  );

  try {
    // 编辑模式下挂载 CodeMirror 容器；具体的 CM 内部行为由 CM 自带测试覆盖，
    // 这里只验证容器存在 + 不再渲染老的双层 textarea/highlight 结构。
    const cm = rendered.container.querySelector(".file-drawer__cm");
    assert.ok(cm instanceof HTMLElement, "should mount CodeMirror container");
    assert.equal(rendered.container.querySelector(".file-drawer__editor"), null, "old textarea must be removed");
    assert.equal(rendered.container.querySelector(".file-drawer__editor-highlight"), null, "old highlight layer must be removed");
    assert.equal(rendered.container.querySelector(".file-drawer__editor-wrapper"), null, "old wrapper must be removed");
  } finally {
    await rendered.cleanup();
  }
});

test("FileDrawer shows line numbers by default in edit mode", async () => {
  const rendered = await renderFileDrawer(
    makeFile({
      lang: "typescript",
      resolvedPath: "/Users/leoli/workspace/super-ask/ui/src/example.ts",
      content: "first line\nsecond line\n",
      size: "first line\nsecond line\n".length,
    }),
  );

  try {
    const gutters = rendered.container.querySelector(".cm-gutters");
    const lineNumbers = rendered.container.querySelector(".cm-lineNumbers");

    assert.ok(gutters instanceof HTMLElement, "should render CodeMirror gutters in edit mode");
    assert.ok(lineNumbers instanceof HTMLElement, "should render line numbers in edit mode");
  } finally {
    await rendered.cleanup();
  }
});
