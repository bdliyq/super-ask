import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

test("about panel markdown is not capped with a fixed max-width", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.doesNotMatch(
    css,
    /\.about-panel__markdown\s*\{[\s\S]*?max-width\s*:/,
  );
});

test("about panel markdown headings do not render divider lines", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.about-panel__markdown\.markdown-body h1,\s*\.about-panel__markdown\.markdown-body h2\s*\{[\s\S]*?border-bottom:\s*none;/,
  );
});
