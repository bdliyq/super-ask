import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

function getCssBlock(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `Expected CSS block for ${selector}`);
  return match[1];
}

test("desktop app layout does not reserve a visible spacer column between session list and chat view", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const block = getCssBlock(css, ".app");

  assert.match(block, /grid-template-columns:\s*var\(--tab-width\)\s+0\s+1fr\s+44px/);
});

test("resize handle uses an overlap hit area instead of consuming layout width", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const handleBlock = getCssBlock(css, ".app__resize-handle");
  const handleAfterBlock = getCssBlock(css, ".app__resize-handle::after");

  assert.match(handleBlock, /width:\s*0/);
  assert.match(handleAfterBlock, /inset:\s*0\s+-3px/);
});
