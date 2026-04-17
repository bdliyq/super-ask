import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

test("editor highlight layer keeps Shiki blocks non-scrollable so textarea stays the only edit scroll owner", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.file-drawer__editor-highlight \.shiki,\s*\.file-drawer__editor-highlight pre,\s*\.file-drawer__editor-highlight code\s*\{[\s\S]*?overflow:\s*visible;/,
  );
});
