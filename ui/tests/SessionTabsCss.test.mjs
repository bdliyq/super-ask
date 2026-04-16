import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

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
