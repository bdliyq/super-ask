import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeployManager } from "./src/deployManager";

const TEMPLATE = [
  "CLI={{SUPER_ASK_CLI}}",
  "INSTALL={{SUPER_ASK_INSTALL_SH}}",
  "ROOT={{SUPER_ASK_ROOT}}",
].join("\n");
const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_PROJECT_ROOT = join(HERE, "..");

async function makeProjectRoot() {
  const root = await mkdtemp(join(tmpdir(), "super-ask-project-"));
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", "super-ask-cursor.mdc"), TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-copilot.md"), TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-codex.md"), TEMPLATE, "utf-8");
  return root;
}

async function makeWorkspace() {
  return mkdtemp(join(tmpdir(), "super-ask-workspace-"));
}

function expectedRendered(projectRoot: string) {
  return [
    `CLI=${join(projectRoot, "cli", "super-ask.py")}`,
    `INSTALL=${join(projectRoot, "install.sh")}`,
    `ROOT=${projectRoot}`,
  ].join("\n");
}

test("deployCursor renders path placeholders before writing rules", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(projectRoot);
    await manager.deployCursor(workspace);

    const rendered = await readFile(
      join(workspace, ".cursor", "rules", "super-ask.mdc"),
      "utf-8",
    );

    assert.equal(rendered.trim(), expectedRendered(projectRoot));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployVscode renders path placeholders before writing instructions", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(projectRoot);
    await manager.deployVscode(workspace);

    const rendered = await readFile(
      join(workspace, ".copilot", "instructions", "super-ask.instructions.md"),
      "utf-8",
    );

    assert.equal(rendered.trim(), expectedRendered(projectRoot));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployCodex injects rendered path placeholders into AGENTS", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    await writeFile(join(workspace, "AGENTS.md"), "# Existing\n", "utf-8");

    const manager = new DeployManager(projectRoot);
    await manager.deployCodex(workspace);

    const rendered = await readFile(join(workspace, "AGENTS.md"), "utf-8");

    assert.match(rendered, /<!-- SUPER-ASK-BEGIN -->/);
    assert.match(rendered, new RegExp(expectedRendered(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployVscode renders production template without placeholder leaks", async () => {
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployVscode(workspace);

    const rendered = await readFile(
      join(workspace, ".copilot", "instructions", "super-ask.instructions.md"),
      "utf-8",
    );

    assert.doesNotMatch(rendered, /\{\{SUPER_ASK_/);
    assert.match(rendered, /super-ask\.py/);
    assert.match(rendered, /install\.sh/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployCodex injects production template without placeholder leaks", async () => {
  const workspace = await makeWorkspace();

  try {
    await writeFile(join(workspace, "AGENTS.md"), "# Existing\n", "utf-8");

    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployCodex(workspace);

    const rendered = await readFile(join(workspace, "AGENTS.md"), "utf-8");

    assert.doesNotMatch(rendered, /\{\{SUPER_ASK_/);
    assert.match(rendered, /--no-wait/);
    assert.match(rendered, /--poll/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
