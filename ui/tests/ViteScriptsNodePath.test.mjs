import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, "../package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const expectedScripts = {
  dev: "\"$npm_node_execpath\" ./node_modules/vite/bin/vite.js",
  build: "\"$npm_node_execpath\" ./node_modules/vite/bin/vite.js build",
  preview: "\"$npm_node_execpath\" ./node_modules/vite/bin/vite.js preview",
};

for (const [scriptName, expectedCommand] of Object.entries(expectedScripts)) {
  test(`${scriptName} script runs Vite with npm_node_execpath`, () => {
    assert.equal(
      packageJson.scripts?.[scriptName],
      expectedCommand,
      `${scriptName} should use npm_node_execpath so npm PATH shadowing cannot downgrade Node`,
    );
  });
}
