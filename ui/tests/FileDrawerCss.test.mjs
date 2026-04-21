import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

test("file drawer reserves layout space for TOC so markdown text is not covered by the TOC overlay", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.file-drawer__body--with-toc\s*\{[\s\S]*?padding-right:\s*220px;/,
  );
  assert.match(
    css,
    /\.file-drawer__body\s*\{[\s\S]*?position:\s*relative;/,
  );
});

test("file drawer filename and path stay text-selectable", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.file-drawer\s*\{[\s\S]*?user-select:\s*text;/,
  );
  assert.match(
    css,
    /\.file-drawer__filename\s*\{[\s\S]*?user-select:\s*text;/,
  );
  assert.match(
    css,
    /\.file-drawer__path\s*\{[\s\S]*?user-select:\s*text;/,
  );
});

test("file drawer content areas stay text-selectable", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.file-drawer__markdown\s*\{[\s\S]*?user-select:\s*text;/,
  );
  assert.match(
    css,
    /\.file-drawer__code\s*\{[\s\S]*?user-select:\s*text;/,
  );
  assert.match(
    css,
    /\.file-drawer__plain\s*\{[\s\S]*?user-select:\s*text;/,
  );
  assert.match(
    css,
    /\.file-drawer__toc-link\s*\{[\s\S]*?user-select:\s*text;/,
  );
});

test("file drawer uses CodeMirror container for edit mode", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  // 新的编辑器容器：占满 body 剩余空间 + 文本可选中
  assert.match(
    css,
    /\.file-drawer__cm\s*\{[\s\S]*?flex:\s*1;[\s\S]*?user-select:\s*text;/,
  );

  // 旧的双层结构必须已被移除
  assert.doesNotMatch(css, /\.file-drawer__editor-wrapper\s*\{/);
  assert.doesNotMatch(css, /\.file-drawer__editor-highlight\s*\{/);
  assert.doesNotMatch(css, /\.file-drawer__editor\s*\{/);
  assert.doesNotMatch(css, /\.file-drawer__editor--transparent/);
});
