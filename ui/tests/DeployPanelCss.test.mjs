import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../src/styles/global.css");

test("deploy panel body does not add extra inner padding inside settings content", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.deploy-panel__body\s*\{[^}]*padding:\s*0;/,
  );
});

test("deploy panel platform group titles do not render divider lines", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(
    css,
    /\.deploy-step__separator\s*\{[\s\S]*?border-top:\s*none;/,
  );
});
