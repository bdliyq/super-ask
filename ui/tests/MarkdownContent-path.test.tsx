import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/components/MarkdownContent";

test("renders absolute Unix path as clickable element", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="修改了 `/Users/leoli/workspace/super-ask/cli/super-ask.py`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /\/Users\/leoli\/workspace\/super-ask\/cli\/super-ask\.py/);
  assert.match(html, /role="button"/);
});

test("renders ~ path as clickable element", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="查看 `~/Documents/project/file.txt`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /~\/Documents\/project\/file\.txt/);
});

test("renders ./ relative path as clickable element", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="修改了 `./src/App.tsx`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /\.\/src\/App\.tsx/);
});

test("renders ../ relative path as clickable element", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="参考 `../parent/file.txt`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /\.\.\/parent\/file\.txt/);
});

test("renders implicit relative path as clickable element", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="修改了 `src/components/App.tsx`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /src\/components\/App\.tsx/);
});

test("does not render plain code as clickable path", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="执行 `npm install`"
      onOpenPath={() => {}}
    />,
  );
  assert.doesNotMatch(html, /clickable-path/);
});

test("URL still renders as link, not path", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="访问 `http://localhost:3000/api`"
      onOpenPath={() => {}}
    />,
  );
  assert.doesNotMatch(html, /clickable-path/);
  assert.match(html, /href="http:\/\/localhost:3000\/api"/);
});

test("path is not clickable without onOpenPath", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent source="修改了 `/Users/leoli/file.ts`" />,
  );
  assert.doesNotMatch(html, /clickable-path/);
});

test("single-segment filename without slash is not treated as path", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="查看 `package.json`"
      onOpenPath={() => {}}
    />,
  );
  assert.doesNotMatch(html, /clickable-path/);
});
