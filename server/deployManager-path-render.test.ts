import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const CURSOR_TEMPLATE = [
  "CLI={{SUPER_ASK_CLI}}",
  "CURSOR_CLI={{SUPER_ASK_CURSOR_CLI}}",
  "INSTALL={{SUPER_ASK_INSTALL_SH}}",
  "ROOT={{SUPER_ASK_ROOT}}",
].join("\n");
const VSCODE_HOOK_TEMPLATE = JSON.stringify({
  hooks: {
    Stop: [
      {
        type: "command",
        command: "{{SUPER_ASK_VSCODE_HOOK_CLI}}",
        timeout: 86400,
      },
    ],
  },
}, null, 2);
const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_PROJECT_ROOT = join(HERE, "..");

async function makeProjectRoot() {
  const root = await mkdtemp(join(tmpdir(), "super-ask-project-"));
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", "super-ask-cursor.mdc"), CURSOR_TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-copilot.md"), TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-vscode-hooks.json"), VSCODE_HOOK_TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-codex.md"), TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-opencode.md"), TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-opencode-tool.ts"), TEMPLATE, "utf-8");
  await writeFile(join(root, "rules", "super-ask-qwen.md"), TEMPLATE, "utf-8");
  return root;
}

async function makeWorkspace() {
  return mkdtemp(join(tmpdir(), "super-ask-workspace-"));
}

function expectedRendered(projectRoot: string, cliFile = "super-ask.js") {
  return [
    `CLI=${join(projectRoot, "cli", cliFile)}`,
    `INSTALL=${join(projectRoot, "install.sh")}`,
    `ROOT=${projectRoot}`,
  ].join("\n");
}

function expectedCursorRendered(projectRoot: string) {
  return [
    `CLI=${join(projectRoot, "cli", "super-ask.js")}`,
    `CURSOR_CLI=${join(projectRoot, "cli", "super-ask-cursor.js")}`,
    `INSTALL=${join(projectRoot, "install.sh")}`,
    `ROOT=${projectRoot}`,
  ].join("\n");
}

function expectedVscodeHookCommand(projectRoot: string) {
  return join(projectRoot, "cli", "super-ask-vscode-hook.js");
}

function assertCursorHookEvents(renderedHooks: string, projectRoot: string) {
  const parsed = JSON.parse(renderedHooks) as { hooks?: Record<string, Array<Record<string, unknown>>> };
  const expectedEvents = [
    "sessionStart",
    "sessionEnd",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "subagentStart",
    "subagentStop",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "beforeReadFile",
    "afterFileEdit",
    "beforeSubmitPrompt",
    "preCompact",
    "stop",
    "afterAgentResponse",
    "afterAgentThought",
    "beforeTabFileRead",
    "afterTabFileEdit",
  ];

  for (const eventName of expectedEvents) {
    const hooks = parsed.hooks?.[eventName];
    assert.ok(Array.isArray(hooks) && hooks.length > 0, `missing hook for ${eventName}`);
    const found = hooks.some((hook) =>
      hook._id === "super-ask-cursor-hook"
      && hook.type === "command"
      && hook.timeout === 86400
      && hook.command === `node "${join(projectRoot, "cli", "super-ask-cursor.js")}" --cursor-hook`,
    );
    assert.ok(found, `missing super-ask Cursor hook for ${eventName}`);
  }

  const stopHooks = parsed.hooks?.stop;
  assert.ok(
    stopHooks?.some((hook) => hook.loop_limit === 3 && hook.timeout === 86400 && hook.failClosed === true),
    "stop hook should be fail-closed and blocking",
  );
}

function assertCodexHookEvents(renderedHooks: string, projectRoot: string) {
  const parsed = JSON.parse(renderedHooks) as { hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>> };
  const expectedEvents = ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];
  for (const eventName of expectedEvents) {
    const groups = parsed.hooks?.[eventName];
    assert.ok(Array.isArray(groups) && groups.length > 0, `missing hook group for ${eventName}`);
    const found = groups.some((group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => hook._id === "super-ask-codex-hook" && hook.command === `node "${join(projectRoot, "cli", "super-ask-codex.js")}" --codex-hook`),
    );
    assert.ok(found, `missing super-ask Codex hook for ${eventName}`);
  }

  const sessionStartGroups = parsed.hooks?.SessionStart as Array<Record<string, unknown>> | undefined;
  assert.ok(
    sessionStartGroups?.some((group) => group.matcher === "startup|resume"),
    "SessionStart hook should use startup|resume matcher",
  );

  const preToolUseGroups = parsed.hooks?.PreToolUse as Array<Record<string, unknown>> | undefined;
  assert.ok(
    preToolUseGroups?.some((group) => group.matcher === "Bash"),
    "PreToolUse hook should use Bash matcher",
  );

  const postToolUseGroups = parsed.hooks?.PostToolUse as Array<Record<string, unknown>> | undefined;
  assert.ok(
    postToolUseGroups?.some((group) => group.matcher === "Bash"),
    "PostToolUse hook should use Bash matcher",
  );
}

function extractBackupPath(detail: string | undefined): string | null {
  if (!detail) return null;
  const match = detail.match(/(?:^|\n)backup: (.+)$/m);
  return match ? match[1] : null;
}

test("deployCursor renders rules, installs all hook events, and undeploy removes only super-ask hooks", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    await mkdir(join(workspace, ".cursor"), { recursive: true });
    await writeFile(
      join(workspace, ".cursor", "hooks.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            stop: [
              {
                _id: "keep-existing-hook",
                type: "command",
                command: "echo keep-me",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const manager = new DeployManager(projectRoot);
    await manager.deployCursor(workspace);

    const rendered = await readFile(
      join(workspace, ".cursor", "rules", "super-ask.mdc"),
      "utf-8",
    );
    const renderedHooks = await readFile(join(workspace, ".cursor", "hooks.json"), "utf-8");

    assert.equal(rendered.trim(), expectedCursorRendered(projectRoot));
    assertCursorHookEvents(renderedHooks, projectRoot);

    const status = await manager.checkStatus(workspace, "workspace");
    assert.deepEqual(status.deployed, [
      {
        platform: "cursor",
        workspacePath: workspace,
        rulesFiles: ["super-ask.mdc", "hooks.json"],
      },
    ]);

    await manager.undeployCursor(workspace);

    await assert.rejects(
      readFile(join(workspace, ".cursor", "rules", "super-ask.mdc"), "utf-8"),
      { code: "ENOENT" },
    );

    const cleanedHooks = JSON.parse(
      await readFile(join(workspace, ".cursor", "hooks.json"), "utf-8"),
    ) as { hooks?: Record<string, Array<{ _id?: string }>> };
    assert.deepEqual(cleanedHooks.hooks?.stop, [{ _id: "keep-existing-hook", type: "command", command: "echo keep-me" }]);
    for (const [eventName, hooks] of Object.entries(cleanedHooks.hooks ?? {})) {
      if (eventName === "stop") continue;
      assert.equal(hooks.length, 0, `${eventName} should be removed when only super-ask hook existed`);
    }
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
    const renderedHooks = JSON.parse(
      await readFile(join(workspace, ".github", "hooks", "super-ask-vscode.json"), "utf-8"),
    ) as { hooks?: { Stop?: Array<{ command?: string; timeout?: number }> } };

    assert.equal(rendered.trim(), expectedRendered(projectRoot));
    assert.equal(renderedHooks.hooks?.Stop?.[0]?.command, expectedVscodeHookCommand(projectRoot));
    assert.equal(renderedHooks.hooks?.Stop?.[0]?.timeout, 86400);

    const status = await manager.checkStatus(workspace, "workspace");
    assert.deepEqual(status.deployed, [
      {
        platform: "vscode",
        workspacePath: join(workspace, ".copilot", "instructions"),
        rulesFiles: ["super-ask.instructions.md", ".github/hooks/super-ask-vscode.json"],
      },
    ]);

    await manager.undeployVscode(workspace);

    await assert.rejects(
      readFile(join(workspace, ".copilot", "instructions", "super-ask.instructions.md"), "utf-8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(join(workspace, ".github", "hooks", "super-ask-vscode.json"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployCodex injects rendered AGENTS rules without kit artifacts", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-codex-home-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Existing\n", "utf-8");

    const manager = new DeployManager(projectRoot);
    await manager.deployCodex(workspace);

    const rendered = await readFile(join(workspace, "AGENTS.md"), "utf-8");
    const renderedConfig = await readFile(join(fakeHome, ".codex", "config.toml"), "utf-8");
    const renderedHooks = await readFile(join(fakeHome, ".codex", "hooks.json"), "utf-8");

    assert.match(rendered, /<!-- SUPER-ASK-BEGIN -->/);
    assert.match(rendered, new RegExp(expectedRendered(projectRoot, "super-ask-codex.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await assert.rejects(stat(join(workspace, ".codex", "hooks.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(workspace, "scripts", "codex-stop-guard.sh")), { code: "ENOENT" });
    assert.match(renderedConfig, /\[features\][\s\S]*codex_hooks\s*=\s*true/);
    assert.doesNotMatch(renderedConfig, /background_terminal_timeout\s*=/);
    assertCodexHookEvents(renderedHooks, projectRoot);

    const status = await manager.checkStatus(workspace, "workspace");
    assert.deepEqual(status.deployed, [
      {
        platform: "codex",
        workspacePath: workspace,
        rulesFiles: ["AGENTS.md", "~/.codex/hooks.json"],
      },
    ]);

    await manager.undeployCodex(workspace);

    const cleaned = await readFile(join(workspace, "AGENTS.md"), "utf-8");
    assert.doesNotMatch(cleaned, /<!-- SUPER-ASK-BEGIN -->/);
    await assert.rejects(stat(join(workspace, ".codex", "hooks.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(workspace, "scripts", "codex-stop-guard.sh")), { code: "ENOENT" });
  } finally {
    process.env.HOME = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployOpenCode writes rendered AGENTS block and tool file, and undeploy removes both", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    await writeFile(join(workspace, "AGENTS.md"), "# Existing\n", "utf-8");

    const manager = new DeployManager(projectRoot);
    await manager.deployOpencode(workspace);

    const renderedAgents = await readFile(join(workspace, "AGENTS.md"), "utf-8");
    const renderedTool = await readFile(
      join(workspace, ".opencode", "tools", "super-ask.ts"),
      "utf-8",
    );

    assert.match(renderedAgents, /<!-- SUPER-ASK-OPENCODE-BEGIN -->/);
    assert.match(
      renderedAgents,
      new RegExp(expectedRendered(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(renderedTool.trim(), expectedRendered(projectRoot));

    const status = await manager.checkStatus(workspace, "workspace");
    assert.deepEqual(status.deployed, [
      {
        platform: "opencode",
        workspacePath: workspace,
        rulesFiles: ["AGENTS.md", ".opencode/tools/super-ask.ts"],
      },
    ]);

    await manager.undeployOpencode(workspace);

    const cleanedAgents = await readFile(join(workspace, "AGENTS.md"), "utf-8");
    assert.doesNotMatch(cleanedAgents, /<!-- SUPER-ASK-OPENCODE-BEGIN -->/);
    await assert.rejects(
      readFile(join(workspace, ".opencode", "tools", "super-ask.ts"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deploy inserts platform title steps for the first and later platform groups", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(projectRoot);
    const result = await manager.deploy({
      platforms: ["cursor", "vscode"],
      workspacePath: workspace,
      scope: "workspace",
    });

    assert.equal(result.steps[0]?.id, "group:deploy:cursor");
    assert.equal(result.steps[0]?.name, "Cursor");
    assert.equal(result.steps[0]?.status, "success");

    const dividerIndex = result.steps.findIndex((step) => step.id === "group:deploy:vscode");
    assert.notEqual(dividerIndex, -1);
    assert.equal(result.steps[dividerIndex]?.name, "Copilot");
    assert.equal(result.steps[dividerIndex]?.status, "success");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("undeploy inserts platform title steps for the first and later platform groups", async () => {
  const projectRoot = await makeProjectRoot();
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(projectRoot);
    const result = await manager.undeploy({
      platforms: ["cursor", "vscode"],
      workspacePath: workspace,
      scope: "workspace",
    });

    assert.equal(result.steps[0]?.id, "group:undeploy:cursor");
    assert.equal(result.steps[0]?.name, "Cursor");
    assert.equal(result.steps[0]?.status, "success");

    const dividerIndex = result.steps.findIndex((step) => step.id === "group:undeploy:vscode");
    assert.notEqual(dividerIndex, -1);
    assert.equal(result.steps[dividerIndex]?.name, "Copilot");
    assert.equal(result.steps[dividerIndex]?.status, "success");
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
    const renderedHooks = await readFile(
      join(workspace, ".github", "hooks", "super-ask-vscode.json"),
      "utf-8",
    );

    assert.doesNotMatch(rendered, /\{\{SUPER_ASK_/);
    assert.doesNotMatch(renderedHooks, /\{\{SUPER_ASK_/);
    assert.match(rendered, /hook 自动驱动|hook 驱动/);
    assert.doesNotMatch(rendered, /block_until_ms/);
    assert.doesNotMatch(rendered, /node "\{\{SUPER_ASK_CLI\}\}"/);
    assert.doesNotMatch(rendered, /--retries -1[\s\S]*--session-id/);
    assert.match(renderedHooks, /super-ask-vscode-hook\.js/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployCursor renders production template without placeholder leaks", async () => {
  const workspace = await makeWorkspace();

  try {
    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployCursor(workspace);

    const renderedRules = await readFile(
      join(workspace, ".cursor", "rules", "super-ask.mdc"),
      "utf-8",
    );
    const renderedHooks = await readFile(join(workspace, ".cursor", "hooks.json"), "utf-8");

    assert.doesNotMatch(renderedRules, /\{\{SUPER_ASK_/);
    assert.match(renderedRules, /hook 自动驱动|hook 模式|stop hook/);
    assert.doesNotMatch(renderedRules, /SUPER_ASK_SID/);
    assert.match(renderedHooks, /super-ask-cursor-hook/);
    assert.match(renderedHooks, /super-ask-cursor\.js/);
    assert.doesNotMatch(renderedHooks, /"type": "prompt"/);
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
    assert.match(rendered, /Codex hooks 自动驱动|订阅全部 Codex hook 事件/);
    assert.doesNotMatch(rendered, /SUPER_ASK_SID/);
    assert.doesNotMatch(rendered, /--session-id "\$SUPER_ASK_SID"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployOpenCode renders production template without placeholder leaks", async () => {
  const workspace = await makeWorkspace();

  try {
    await writeFile(join(workspace, "AGENTS.md"), "# Existing\n", "utf-8");

    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployOpencode(workspace);

    const renderedAgents = await readFile(join(workspace, "AGENTS.md"), "utf-8");
    const renderedTool = await readFile(
      join(workspace, ".opencode", "tools", "super-ask.ts"),
      "utf-8",
    );

    assert.doesNotMatch(renderedAgents, /\{\{SUPER_ASK_/);
    assert.doesNotMatch(renderedTool, /\{\{SUPER_ASK_/);
    assert.match(renderedAgents, /chatSessionId/);
    assert.match(renderedTool, /source:\s*"opencode"/);
    assert.match(renderedTool, /\/super-ask/);
    assert.match(renderedTool, /stableChatSessionId/);
    assert.match(renderedTool, /buildPayload/);
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

test("deployCodexUser installs hook-driven Codex integration", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-codex-home-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(join(fakeHome, ".codex", "AGENTS.md"), "# Existing\n", "utf-8");
    await writeFile(
      join(fakeHome, ".codex", "config.toml"),
      'background_terminal_max_timeout = 123\n\n[projects."/tmp/demo"]\ntrust_level = "trusted"\n',
      "utf-8",
    );

    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployCodexUser();

    const renderedAgents = await readFile(join(fakeHome, ".codex", "AGENTS.md"), "utf-8");
    const renderedConfig = await readFile(join(fakeHome, ".codex", "config.toml"), "utf-8");
    const renderedHooks = await readFile(join(fakeHome, ".codex", "hooks.json"), "utf-8");

    assert.match(renderedAgents, /<!-- SUPER-ASK-BEGIN -->/);
    assert.match(renderedAgents, /Codex hooks 自动驱动|订阅全部 Codex hook 事件/);
    assert.doesNotMatch(renderedAgents, /SUPER_ASK_SID/);
    assert.doesNotMatch(renderedAgents, /--session-id "\$SUPER_ASK_SID"/);
    assert.match(renderedConfig, /background_terminal_max_timeout\s*=\s*86400000/);
    assert.match(renderedConfig, /background_terminal_timeout\s*=\s*86400000/);
    assert.match(renderedConfig, /\[features\][\s\S]*codex_hooks\s*=\s*true/);
    assert.match(renderedConfig, /\[projects\."\/tmp\/demo"\]/);
    assertCodexHookEvents(renderedHooks, REAL_PROJECT_ROOT);

    const status = await manager.checkStatus("", "user");
    assert.deepEqual(status.deployed, [
      {
        platform: "codex",
        workspacePath: join(fakeHome, ".codex"),
        rulesFiles: ["AGENTS.md", "hooks.json"],
      },
    ]);

    await manager.undeployCodexUser();

    const cleanedAgents = await readFile(join(fakeHome, ".codex", "AGENTS.md"), "utf-8");
    assert.doesNotMatch(cleanedAgents, /<!-- SUPER-ASK-BEGIN -->/);
    await assert.rejects(
      readFile(join(fakeHome, ".codex", "hooks.json"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    process.env.HOME = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("deployCodexUser preserves existing OMX Codex hooks/config and appends super-ask hooks after them", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-codex-home-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(
      join(fakeHome, ".codex", "AGENTS.md"),
      "<!-- omx:generated:agents-md -->\n# OMX\n",
      "utf-8",
    );
    await writeFile(
      join(fakeHome, ".codex", "config.toml"),
      [
        'notify = ["node", "/tmp/omx/dist/scripts/notify-hook.js"]',
        'model_reasoning_effort = "high"',
        "",
        '[features]',
        "codex_hooks = true",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(fakeHome, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [
                {
                  type: "command",
                  command: 'node "/tmp/omx/dist/scripts/codex-native-hook.js"',
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: 'node "/tmp/omx/dist/scripts/codex-native-hook.js"',
                  statusMessage: "Running OMX Bash preflight",
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "/tmp/omx/dist/scripts/codex-native-hook.js"',
                  statusMessage: "Running OMX tool review",
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "/tmp/omx/dist/scripts/codex-native-hook.js"',
                  statusMessage: "Applying OMX prompt routing",
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "/tmp/omx/dist/scripts/codex-native-hook.js"',
                  timeout: 30,
                },
              ],
            },
          ],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const manager = new DeployManager(REAL_PROJECT_ROOT);
    await manager.deployCodexUser();

    const renderedAgents = await readFile(join(fakeHome, ".codex", "AGENTS.md"), "utf-8");
    const renderedConfig = await readFile(join(fakeHome, ".codex", "config.toml"), "utf-8");
    const renderedHooks = await readFile(join(fakeHome, ".codex", "hooks.json"), "utf-8");
    const parsedHooks = JSON.parse(renderedHooks) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>>;
    };

    assert.match(renderedAgents, /<!-- omx:generated:agents-md -->/);
    assert.match(renderedAgents, /<!-- SUPER-ASK-BEGIN -->/);
    assert.match(renderedConfig, /notify = \["node", "\/tmp\/omx\/dist\/scripts\/notify-hook\.js"\]/);
    assert.match(renderedConfig, /model_reasoning_effort = "high"/);

    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] as const) {
      const groups = parsedHooks.hooks?.[eventName];
      assert.ok(Array.isArray(groups) && groups.length >= 2, `${eventName} should preserve OMX group and append super-ask group`);
      const firstHook = groups[0]?.hooks?.[0];
      const lastHook = groups[groups.length - 1]?.hooks?.[0];
      assert.equal(firstHook?.command, 'node "/tmp/omx/dist/scripts/codex-native-hook.js"', `${eventName} should keep OMX hook first`);
      assert.equal(
        lastHook?._id,
        "super-ask-codex-hook",
        `${eventName} should append super-ask hook group after existing hooks`,
      );
    }
  } finally {
    process.env.HOME = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("deployCodexUser backs up modified Codex config files and reports backup paths in step detail", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-codex-home-"));
  const originalHome = process.env.HOME;
  const originalAgents = "# Existing\n";
  const originalConfig = 'background_terminal_max_timeout = 123\n\n[projects."/tmp/demo"]\ntrust_level = "trusted"\n';
  const originalHooks = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              _id: "keep-existing-hook",
              type: "command",
              command: "echo keep-me",
            },
          ],
        },
      ],
    },
  }, null, 2) + "\n";

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(join(fakeHome, ".codex", "AGENTS.md"), originalAgents, "utf-8");
    await writeFile(join(fakeHome, ".codex", "config.toml"), originalConfig, "utf-8");
    await writeFile(join(fakeHome, ".codex", "hooks.json"), originalHooks, "utf-8");

    const manager = new DeployManager(REAL_PROJECT_ROOT);
    const steps = await manager.deployCodexUser();

    const injectStep = steps.find((step) => step.id === "inject_codex_rules");
    const configStep = steps.find((step) => step.id === "set_background_timeout");
    const hooksStep = steps.find((step) => step.id === "deploy_codex_hooks");

    const agentsBackup = extractBackupPath(injectStep?.detail);
    const configBackup = extractBackupPath(configStep?.detail);
    const hooksBackup = extractBackupPath(hooksStep?.detail);

    assert.match(agentsBackup ?? "", /AGENTS\.md\.backup-\d{8}-\d{6}(?:-\d+)?$/);
    assert.match(configBackup ?? "", /config\.toml\.backup-\d{8}-\d{6}(?:-\d+)?$/);
    assert.match(hooksBackup ?? "", /hooks\.json\.backup-\d{8}-\d{6}(?:-\d+)?$/);

    assert.equal(await readFile(agentsBackup!, "utf-8"), originalAgents);
    assert.equal(await readFile(configBackup!, "utf-8"), originalConfig);
    assert.equal(await readFile(hooksBackup!, "utf-8"), originalHooks);
  } finally {
    process.env.HOME = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("undeployCodexUser backs up Codex files before removing super-ask changes", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-codex-home-"));
  const originalHome = process.env.HOME;
  const originalAgents = [
    "# Existing",
    "<!-- SUPER-ASK-BEGIN -->",
    "super-ask rules",
    "<!-- SUPER-ASK-END -->",
    "# tail",
    "",
  ].join("\n");
  const originalHooks = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: 'node "/tmp/omx/dist/scripts/codex-native-hook.js"',
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            {
              _id: "super-ask-codex-hook",
              type: "command",
              command: 'node "/tmp/super-ask-codex.js" --codex-hook',
              timeout: 86400,
            },
          ],
        },
      ],
    },
  }, null, 2) + "\n";

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(join(fakeHome, ".codex", "AGENTS.md"), originalAgents, "utf-8");
    await writeFile(join(fakeHome, ".codex", "hooks.json"), originalHooks, "utf-8");

    const manager = new DeployManager(REAL_PROJECT_ROOT);
    const steps = await manager.undeployCodexUser();

    const removeAgentsStep = steps.find((step) => step.id === "remove_codex_block_user");
    const removeHooksStep = steps.find((step) => step.id === "remove_codex_hooks_user");

    const agentsBackup = extractBackupPath(removeAgentsStep?.detail);
    const hooksBackup = extractBackupPath(removeHooksStep?.detail);

    assert.match(agentsBackup ?? "", /AGENTS\.md\.backup-\d{8}-\d{6}(?:-\d+)?$/);
    assert.match(hooksBackup ?? "", /hooks\.json\.backup-\d{8}-\d{6}(?:-\d+)?$/);

    assert.equal(await readFile(agentsBackup!, "utf-8"), originalAgents);
    assert.equal(await readFile(hooksBackup!, "utf-8"), originalHooks);
  } finally {
    process.env.HOME = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("deployOpenCodeUser writes to ~/.config/opencode and undeployOpenCodeUser removes tool while restoring AGENTS", async () => {
  const projectRoot = await makeProjectRoot();
  const fakeHome = await mkdtemp(join(tmpdir(), "super-ask-opencode-home-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".config", "opencode"), { recursive: true });
    await writeFile(join(fakeHome, ".config", "opencode", "AGENTS.md"), "# Existing\n", "utf-8");

    const manager = new DeployManager(projectRoot);
    await manager.deployOpencodeUser();

    const renderedAgents = await readFile(
      join(fakeHome, ".config", "opencode", "AGENTS.md"),
      "utf-8",
    );
    const renderedTool = await readFile(
      join(fakeHome, ".config", "opencode", "tools", "super-ask.ts"),
      "utf-8",
    );

    assert.match(renderedAgents, /<!-- SUPER-ASK-OPENCODE-BEGIN -->/);
    assert.equal(renderedTool.trim(), expectedRendered(projectRoot));

    const status = await manager.checkStatus("", "user");
    assert.deepEqual(status.deployed, [
      {
        platform: "opencode",
        workspacePath: join(fakeHome, ".config", "opencode"),
        rulesFiles: ["AGENTS.md", "tools/super-ask.ts"],
      },
    ]);

    await manager.undeployOpencodeUser();

    const cleanedAgents = await readFile(
      join(fakeHome, ".config", "opencode", "AGENTS.md"),
      "utf-8",
    );
    assert.doesNotMatch(cleanedAgents, /<!-- SUPER-ASK-OPENCODE-BEGIN -->/);
    await assert.rejects(
      readFile(join(fakeHome, ".config", "opencode", "tools", "super-ask.ts"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    process.env.HOME = originalHome;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
