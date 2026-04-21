import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { startBodyResizeSession } from "../src/utils/bodyResizeSession";

function withDom(fn: (dom: JSDOM) => void) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });

  // @ts-expect-error test shim
  globalThis.window = dom.window;
  // @ts-expect-error test shim
  globalThis.document = dom.window.document;

  try {
    fn(dom);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

test("startBodyResizeSession keeps moving while the drag button stays pressed", () => {
  withDom(() => {
    let moveCount = 0;
    let endCount = 0;

    startBodyResizeSession({
      onMove: () => {
        moveCount += 1;
      },
      onEnd: () => {
        endCount += 1;
      },
    });

    assert.equal(document.body.style.cursor, "col-resize");
    assert.equal(document.body.style.userSelect, "none");

    document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 120, buttons: 1 }));
    assert.equal(moveCount, 1);

    document.dispatchEvent(new window.MouseEvent("mouseup"));
    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
    assert.equal(endCount, 1);
  });
});

test("startBodyResizeSession cleans up if move events arrive after the drag button was released elsewhere", () => {
  withDom(() => {
    let moveCount = 0;
    let endCount = 0;

    startBodyResizeSession({
      onMove: () => {
        moveCount += 1;
      },
      onEnd: () => {
        endCount += 1;
      },
    });

    document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 120, buttons: 0 }));

    assert.equal(moveCount, 0);
    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
    assert.equal(endCount, 1);
  });
});

test("startBodyResizeSession cleans up a stale drag before the next mouse interaction", () => {
  withDom(() => {
    let endCount = 0;

    startBodyResizeSession({
      onMove: () => {},
      onEnd: () => {
        endCount += 1;
      },
    });

    document.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));

    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
    assert.equal(endCount, 1);
  });
});

test("startBodyResizeSession restores body styles on blur", () => {
  withDom(() => {
    let endCount = 0;

    startBodyResizeSession({
      onMove: () => {},
      onEnd: () => {
        endCount += 1;
      },
    });

    window.dispatchEvent(new window.Event("blur"));

    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
    assert.equal(endCount, 1);
  });
});

test("startBodyResizeSession restores body styles when document becomes hidden", () => {
  withDom(() => {
    let endCount = 0;
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });

    startBodyResizeSession({
      onMove: () => {},
      onEnd: () => {
        endCount += 1;
      },
    });

    document.dispatchEvent(new window.Event("visibilitychange"));

    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
    assert.equal(endCount, 1);

    if (originalHidden) {
      Object.defineProperty(document, "hidden", originalHidden);
    }
  });
});
