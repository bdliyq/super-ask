import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, "../src/components/CodeEditor.tsx");
const source = fs.readFileSync(sourcePath, "utf8");

test("CodeEditor pins gutter line-height to match content line-height", () => {
  assert.match(
    source,
    /"\.cm-gutters":\s*\{[\s\S]*?lineHeight:\s*"1\.6"/,
  );
});

test("CodeEditor does not add extra vertical padding to the gutter container", () => {
  assert.doesNotMatch(
    source,
    /"\.cm-gutters":\s*\{[\s\S]*?paddingBlock:/,
  );
});

test("CodeEditor pins line-number gutter typography to match content metrics", () => {
  assert.match(
    source,
    /"\.cm-lineNumbers \.cm-gutterElement":\s*\{[\s\S]*?fontFamily:\s*"var\(--font-mono\)"[\s\S]*?fontSize:\s*"13px"[\s\S]*?lineHeight:\s*"1\.6"[\s\S]*?letterSpacing:\s*"normal"[\s\S]*?fontFeatureSettings:\s*"normal"[\s\S]*?fontVariantLigatures:\s*"none"/,
  );
});
