import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "super-ask.py");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [CLI, ...args], {
      cwd: join(HERE, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("CLI rejects removed --poll flag", async () => {
  const result = await runCli(["--poll", "--session-id", "sid"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unrecognized arguments: --poll/);
  assert.equal(result.stdout.trim(), "");
});

test("CLI rejects removed --no-wait flag", async () => {
  const result = await runCli([
    "--no-wait",
    "--summary",
    "summary",
    "--question",
    "question",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unrecognized arguments: --no-wait/);
  assert.equal(result.stdout.trim(), "");
});
