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

test("session delete button stays hover-only even for the active session item", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const baseDeleteBlock = getCssBlock(css, ".session-tabs__delete");
  const hoverDeleteBlock = getCssBlock(css, ".session-tabs__item:hover .session-tabs__delete");
  const activeDeleteBlock = getCssBlock(css, ".session-tabs__item--active .session-tabs__delete");

  assert.match(baseDeleteBlock, /display:\s*none/);
  assert.match(hoverDeleteBlock, /display:\s*inline-flex/);
  assert.doesNotMatch(activeDeleteBlock, /display:\s*inline-flex/);
});

test("active session rows give the pending dot a high-contrast override", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.session-tabs__item--active\s+\.session-tabs__dot\s*\{[\s\S]*?background:\s*#fff;/,
  );
});

test("session row pin control is hover-only unless the session is already pinned", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.session-tabs__pin\s*\{[^}]*display:\s*none;/,
  );
  assert.match(
    css,
    /\.session-tabs__item:hover\s+\.session-tabs__pin,\s*\.session-tabs__item--pinned\s+\.session-tabs__pin\s*\{[\s\S]*?display:\s*inline-flex;/,
  );
});

test("show more button aligns with session rows without extra left margin", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.session-tabs__show-more\s*\{[\s\S]*?padding:\s*4px 12px;/,
  );
  assert.doesNotMatch(
    css,
    /\.session-tabs__show-more\s*\{[^}]*margin-left\s*:/,
  );
});
