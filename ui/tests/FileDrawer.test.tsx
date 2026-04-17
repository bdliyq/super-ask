import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReadFileResponse } from "@shared/types";
import { FileDrawer } from "../src/components/FileDrawer";

function makeFile(overrides: Partial<ReadFileResponse> = {}): ReadFileResponse {
  return {
    content: 'const x = 42;\nexport default x;\n',
    resolvedPath: "/Users/leoli/workspace/project/src/index.ts",
    size: 35,
    lang: "typescript",
    isBinary: false,
    truncated: false,
    ...overrides,
  };
}

test("FileDrawer renders filename from resolvedPath", () => {
  const html = renderToStaticMarkup(
    <FileDrawer file={makeFile()} onClose={() => {}} />,
  );
  assert.match(html, /index\.ts/);
  assert.match(html, /file-drawer/);
});

test("FileDrawer shows binary notice for binary files", () => {
  const html = renderToStaticMarkup(
    <FileDrawer
      file={makeFile({ isBinary: true, content: null, lang: null })}
      onClose={() => {}}
    />,
  );
  assert.match(html, /file-drawer__binary-notice/);
});

test("FileDrawer shows Edit/Preview toggle for .md files", () => {
  const html = renderToStaticMarkup(
    <FileDrawer
      file={makeFile({
        content: "# Hello\n\nWorld",
        resolvedPath: "/path/to/readme.md",
        lang: "markdown",
      })}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Edit/);
  assert.match(html, /Preview/);
  assert.doesNotMatch(html, /Source/);
  assert.match(html, /file-drawer__mode-toggle/);
});

test("FileDrawer does not show mode toggle for non-markdown files", () => {
  const html = renderToStaticMarkup(
    <FileDrawer file={makeFile()} onClose={() => {}} />,
  );
  assert.doesNotMatch(html, /file-drawer__mode-toggle/);
});

test("FileDrawer shows truncated notice when file is truncated", () => {
  const html = renderToStaticMarkup(
    <FileDrawer
      file={makeFile({ truncated: true, size: 5 * 1024 * 1024 })}
      onClose={() => {}}
    />,
  );
  assert.match(html, /file-drawer__truncated-notice/);
});

test("FileDrawer renders empty state when no file provided", () => {
  const html = renderToStaticMarkup(
    <FileDrawer file={null} onClose={() => {}} />,
  );
  assert.match(html, /file-drawer/);
  assert.match(html, /Document Viewer/);
  assert.match(html, /file path/i);
});

test("FileDrawer shows file size", () => {
  const html = renderToStaticMarkup(
    <FileDrawer file={makeFile({ size: 2048 })} onClose={() => {}} />,
  );
  assert.match(html, /2\.0 KB/);
});

test("FileDrawer shows Open in Finder button when callback provided", () => {
  const html = renderToStaticMarkup(
    <FileDrawer
      file={makeFile()}
      onClose={() => {}}
      onOpenInFinder={() => {}}
    />,
  );
  assert.match(html, /Finder/i);
});
