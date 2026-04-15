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
  await writeFile(join(root, "rules", "super-ask-qwen.md"), TEMPLATE, "utf-8");
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

test("deployQwen writes rendered rules to workspace root and updates qwen settings", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    await mkdir(join(workspace, ".qwen"), { recursive: true });
    await writeFile(
      join(workspace, ".qwen", "settings.json"),
      JSON.stringify(
        {
          model: { name: "qwen3-coder-plus" },
          context: {
            fileName: ["QWEN.md"],
            includeDirectories: ["src"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const manager = new DeployManager(projectRoot);
    await manager.deployQwen(workspace);

    const rendered = await readFile(join(workspace, "super-ask-qwen.md"), "utf-8");
    assert.equal(rendered.trim(), expectedRendered(projectRoot));

    const settings = JSON.parse(
      await readFile(join(workspace, ".qwen", "settings.json"), "utf-8"),
    ) as {
      model?: { name?: string };
      context?: { fileName?: string | string[]; includeDirectories?: string[] };
    };

    assert.equal(settings.model?.name, "qwen3-coder-plus");
    assert.deepEqual(settings.context?.includeDirectories, ["src"]);
    assert.deepEqual(settings.context?.fileName, ["super-ask-qwen.md", "QWEN.md"]);

    const status = await manager.checkStatus(workspace, "workspace");
    assert.deepEqual(status.deployed, [
      {
        platform: "qwen",
        workspacePath: workspace,
        rulesFiles: ["super-ask-qwen.md", ".qwen/settings.json"],
      },
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployQwen renders production template without placeholder leaks", async () => {
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployQwen(workspace);

    const rendered = await readFile(join(workspace, "super-ask-qwen.md"), "utf-8");
    const settings = JSON.parse(
      await readFile(join(workspace, ".qwen", "settings.json"), "utf-8"),
    ) as { context?: { fileName?: string | string[] } };

    assert.doesNotMatch(rendered, /\{\{SUPER_ASK_/);
    assert.match(rendered, /--source qwen/);
    assert.deepEqual(settings.context?.fileName, "super-ask-qwen.md");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("undeployQwen removes deployed file and restores prior context.fileName", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    await mkdir(join(workspace, ".qwen"), { recursive: true });
    await writeFile(
      join(workspace, ".qwen", "settings.json"),
      JSON.stringify(
        {
          context: {
            fileName: ["QWEN.md"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const manager = new DeployManager(projectRoot);
    await manager.deployQwen(workspace);
    await manager.undeployQwen(workspace);

    await assert.rejects(
      readFile(join(workspace, "super-ask-qwen.md"), "utf-8"),
      { code: "ENOENT" },
    );

    const settings = JSON.parse(
      await readFile(join(workspace, ".qwen", "settings.json"), "utf-8"),
    ) as { context?: { fileName?: string | string[] } };
    assert.deepEqual(settings.context?.fileName, "QWEN.md");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployQwenUser writes to ~/.qwen and undeployQwenUser restores prior settings", async () => {
  const projectRoot = await makeProjectRoot();
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-qwen-home-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".qwen"), { recursive: true });
    await writeFile(
      join(fakeHome, ".qwen", "settings.json"),
      JSON.stringify(
        {
          context: {
            fileName: "QWEN.md",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const manager = new DeployManager(projectRoot);
    await manager.deployQwenUser();

    const status = await manager.checkStatus("", "user");
    assert.deepEqual(status.deployed, [
      {
        platform: "qwen",
        workspacePath: join(fakeHome, ".qwen"),
        rulesFiles: ["super-ask-qwen.md", "settings.json"],
      },
    ]);

    await manager.undeployQwenUser();

    await assert.rejects(
      readFile(join(fakeHome, ".qwen", "super-ask-qwen.md"), "utf-8"),
      { code: "ENOENT" },
    );

    const settings = JSON.parse(
      await readFile(join(fakeHome, ".qwen", "settings.json"), "utf-8"),
    ) as { context?: { fileName?: string | string[] } };
    assert.deepEqual(settings.context?.fileName, "QWEN.md");
  } finally {
    process.env.HOME = originalHome;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
