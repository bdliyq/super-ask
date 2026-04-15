import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

test("session and chat banners share the same min-height rule", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.session-tabs__banner,\s*\.chat-view__banner\s*\{[\s\S]*?min-height:\s*var\(--panel-banner-min-height\);/,
  );
});
