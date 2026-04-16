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

test("session list panel uses the same base background token as chat view", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.session-tabs\s*\{[^}]*background:\s*var\(--bg-app\);/,
  );
  assert.match(
    css,
    /\.chat-view\s*\{[^}]*background:\s*var\(--bg-app\);/,
  );
});

test("session list tooltip uses the same base background token as the list panel", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.session-tabs__tooltip\s*\{[^}]*background:\s*var\(--bg-app\);/,
  );
});

test("chat banner keeps a fixed height even when the available width shrinks", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const match = css.match(/\.chat-view__banner\s*\{[\s\S]*?\}/);

  assert.ok(match, "expected .chat-view__banner rule to exist");
  const block = match[0];
  assert.match(block, /height:\s*var\(--panel-banner-min-height\)/);
  assert.match(block, /box-sizing:\s*border-box/);
  assert.match(block, /overflow:\s*hidden/);
});

test("chat banner keeps the title compact so the tag button and status badge stay left-aligned", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const match = css.match(/\.chat-view__banner-title\s*\{[\s\S]*?\}/);

  assert.ok(match, "expected .chat-view__banner-title rule to exist");
  const block = match[0];
  assert.match(block, /flex:\s*0 1 auto/);
  assert.match(block, /overflow:\s*hidden/);
  assert.match(block, /text-overflow:\s*ellipsis/);
  assert.match(block, /white-space:\s*nowrap/);
  assert.doesNotMatch(block, /overflow-wrap\s*:\s*anywhere/);
});
