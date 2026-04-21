import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/components/MarkdownContent";

test("renders absolute Unix path as clickable element", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="修改了 `/Users/leoli/workspace/super-ask/cli/super-ask.js`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /\/Users\/leoli\/workspace\/super-ask\/cli\/super-ask\.js/);
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

test("markdown file links open through the docs drawer instead of a new tab", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="查看 [App](./src/App.tsx)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /href="\.\/src\/App\.tsx"/);
  assert.match(html, /clickable-path--link/);
  assert.match(html, />App<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("markdown file links with a line suffix still show the label and open through the docs drawer", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="查看 [App](./src/App.tsx:12)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /href="\.\/src\/App\.tsx:12"/);
  assert.match(html, /clickable-path--link/);
  assert.match(html, />App<\/a>\s*<span[^>]*>\s*\(Line 12\)\s*<\/span>/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("markdown file links stay regular links without onOpenPath", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent source="查看 [App](./src/App.tsx)" />,
  );
  assert.match(html, /href="\.\/src\/App\.tsx"/);
  assert.match(html, />App<\/a>/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(html, /clickable-path--link/);
});

test("regular markdown links preserve their label text", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent source="访问 [OpenAI](https://openai.com)" />,
  );
  assert.match(html, /href="https:\/\/openai\.com"/);
  assert.match(html, />OpenAI<\/a>/);
});

test("markdown file links add visible line info when the target includes a line suffix", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="[MarkdownContent-path.test.tsx](./tests/MarkdownContent-path.test.tsx:97)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /href="\.\/tests\/MarkdownContent-path\.test\.tsx:97"/);
  assert.match(html, />MarkdownContent-path\.test\.tsx<\/a>\s*<span[^>]*>\s*\(Line 97\)\s*<\/span>/);
});

test("markdown file links do not duplicate visible line info when the label already includes it", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="[MarkdownContent-path.test.tsx:107](./tests/MarkdownContent-path.test.tsx:107)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /href="\.\/tests\/MarkdownContent-path\.test\.tsx:107"/);
  assert.match(html, />MarkdownContent-path\.test\.tsx:107<\/a>/);
  assert.doesNotMatch(html, /\(line 107\).*?\(line 107\)/);
});

test("path is not clickable without onOpenPath", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent source="修改了 `/Users/leoli/file.ts`" />,
  );
  assert.doesNotMatch(html, /clickable-path/);
});

test("single-segment filename without slash still opens as a file path", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="查看 `package.json`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /package\.json/);
});

test("inline code with line suffix preserves the line number label", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="修改了 `src/App.tsx:12`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /src\/App\.tsx:12/);
  assert.match(html, /title="src\/App\.tsx:12"/);
});

test("inline code with line:column suffix preserves the full label", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="跳转到 `/Users/leoli/workspace/super-ask/cli/super-ask.js:42:10`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /\/Users\/leoli\/workspace\/super-ask\/cli\/super-ask\.js:42:10/);
});

test("inline code with bare filename and line suffix is clickable", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="详见 `package.json:5`"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path/);
  assert.match(html, /package\.json:5/);
});

test("markdown link with line suffix appends '(Line N)' when label lacks it", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="见 [MarkdownContent.tsx](/Users/leoli/workspace/super-ask/ui/src/components/MarkdownContent.tsx:122)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path--link/);
  assert.match(html, />MarkdownContent\.tsx<\/a>\s*<span[^>]*>\s*\(Line 122\)\s*<\/span>/);
});

test("markdown link with line+col suffix appends raw ':line:col' when label lacks it", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="见 [MarkdownContent.tsx](/Users/leoli/workspace/super-ask/ui/src/components/MarkdownContent.tsx:122:8)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path--link/);
  assert.match(html, />MarkdownContent\.tsx<\/a>\s*<span[^>]*>:122:8<\/span>/);
});

test("markdown link does not append line suffix when label already contains it", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="见 [MarkdownContent.tsx:122](/Users/leoli/workspace/super-ask/ui/src/components/MarkdownContent.tsx:122)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path--link/);
  assert.match(html, />MarkdownContent\.tsx:122<\/a>/);
  assert.doesNotMatch(html, /\(Line 122\)/);
});

test("markdown link without line suffix renders unchanged label", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      source="见 [App](./src/App.tsx)"
      onOpenPath={() => {}}
    />,
  );
  assert.match(html, /clickable-path--link/);
  assert.match(html, />App<\/a>/);
  assert.doesNotMatch(html, /\(Line/);
});
