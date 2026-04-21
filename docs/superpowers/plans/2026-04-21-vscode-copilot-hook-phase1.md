# VS Code Copilot Hook Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the current VS Code Copilot integration from a manual `node cli/super-ask.js` instructions flow to a hook-driven `Stop -> existing super-ask server` flow, while keeping the existing server protocol and leaving the current VS Code extension LM Tool path untouched.

**Architecture:** Add a VS Code-specific hook adapter script that reads VS Code hook stdin JSON, extracts the latest assistant report from `transcript_path`, calls the existing `cli/super-ask.js` client against the existing server, and converts the returned feedback into VS Code `Stop` hook output (`decision: "block"`). Extend `deployManager` so VS Code deployment writes both instructions and hook config files, and rewrite the Copilot instructions so they constrain final-report format instead of telling the model to invoke the CLI manually.

**Tech Stack:** Node.js CommonJS CLI adapter, VS Code/Copilot hook JSON config files, existing `cli/super-ask.js` transport, `node:test` CLI tests, `server/deployManager-path-render.test.ts` deployment tests.

---

## File Structure

| File | Operation | Responsibility |
|------|------|------|
| `cli/super-ask-vscode-hook.js` | Create | VS Code/Copilot hook adapter for `Stop -> super-ask server` |
| `cli/super-ask-vscode-hook.test.cjs` | Create | Unit/integration tests for the hook adapter |
| `rules/super-ask-vscode-hooks.json` | Create | VS Code hook config template deployed into workspace/user hook locations |
| `rules/super-ask-copilot.md` | Modify | Convert Copilot instructions from manual CLI usage to hook-driven report-format guidance |
| `server/src/deployManager.ts` | Modify | Deploy/undeploy/status support for VS Code hook files |
| `server/deployManager-path-render.test.ts` | Modify | Path rendering and status tests for VS Code instructions + hook files |

## Scope Guardrails

- Do **not** modify `vscode/src/extension.ts`, `vscode/src/tools/superAskTool.ts`, or `vscode/src/webview/PanelManager.ts` in Phase 1.
- Do **not** change the existing `/super-ask` or `/api/ack` server protocol.
- Do **not** remove the VS Code extension LM Tool path yet; Phase 1 only adds the hook path.
- Do **not** change Cursor, Codex, OpenCode, or Qwen deployment logic.

---

### Task 1: Add the VS Code hook adapter script

**Files:**
- Create: `cli/super-ask-vscode-hook.js`
- Create: `cli/super-ask-vscode-hook.test.cjs`

- [ ] **Step 1: Write the failing hook adapter tests**

Create `cli/super-ask-vscode-hook.test.cjs` with tests that cover:

```js
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const hook = require("./super-ask-vscode-hook.js");

test("exports VS Code hook helpers", () => {
  assert.equal(typeof hook.extractVscodeQuestion, "function");
  assert.equal(typeof hook.extractLastAssistantTextFromTranscriptContent, "function");
  assert.equal(typeof hook.buildVscodeHookRequestPayload, "function");
});

test("buildVscodeHookRequestPayload maps sessionId and cwd to the super-ask request", () => {
  const payload = hook.buildVscodeHookRequestPayload({
    sessionId: "vscode-session-1",
    cwd: "/tmp/workspace",
  }, "## 工作汇报\n- 已完成 A");

  assert.deepEqual(payload, {
    summary: "## 工作汇报\n- 已完成 A",
    question: "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。",
    source: "copilot in vscode",
    options: ["继续", "需要修改", "我有问题"],
    chatSessionId: "vscode-session-1",
    workspaceRoot: "/tmp/workspace",
  });
});
```

- [ ] **Step 2: Run the new hook test to confirm it fails**

Run: `node --test cli/super-ask-vscode-hook.test.cjs`

Expected: FAIL because `cli/super-ask-vscode-hook.js` does not exist yet.

- [ ] **Step 3: Implement `cli/super-ask-vscode-hook.js`**

Create `cli/super-ask-vscode-hook.js` with these behaviors:

```js
#!/usr/bin/env node

const { readFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const process = require("node:process");

const DEFAULT_PORT = 19960;
const DEFAULT_RETRIES = -1;

function extractTextBlocks(content) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (typeof item.text === "string" && item.text.trim()) return [item.text];
    return [];
  });
}

function parseTranscriptLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getRole(entry) {
  return entry?.role ?? entry?.payload?.role ?? null;
}

function getContent(entry) {
  return entry?.message?.content ?? entry?.payload?.content ?? null;
}

function extractLastAssistantTextFromTranscriptContent(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  let lastAssistant = "";
  for (const line of lines) {
    const entry = parseTranscriptLine(line.trim());
    if (!entry || getRole(entry) !== "assistant") continue;
    const text = extractTextBlocks(getContent(entry)).join("\n\n").trim();
    if (text) lastAssistant = text;
  }
  return lastAssistant || null;
}

async function extractLastAssistantTextFromTranscriptPath(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return extractLastAssistantTextFromTranscriptContent(content);
  } catch {
    return null;
  }
}

function extractVscodeQuestion(summary) {
  const lines = String(summary ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (last.endsWith("?") || last.endsWith("？")) return last;
  return "请根据以上工作汇报回复下一步要求，或直接说明需要修改的地方。";
}

function buildVscodeHookRequestPayload(input, summary) {
  const body = {
    summary,
    question: extractVscodeQuestion(summary),
    source: "copilot in vscode",
    options: ["继续", "需要修改", "我有问题"],
  };
  const sessionId = String(input.sessionId ?? "").trim();
  if (sessionId) body.chatSessionId = sessionId;
  const cwd = String(input.cwd ?? "").trim();
  if (cwd) body.workspaceRoot = cwd;
  return body;
}

function buildStopHookOutput(feedback) {
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      decision: "block",
      reason: feedback,
    },
  };
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, retries: DEFAULT_RETRIES };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") args.port = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--retries") args.retries = Number.parseInt(argv[++i], 10);
  }
  return args;
}

function runSuperAskCli(args, requestPayload) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(__dirname, "super-ask.js");
    const child = spawn(process.execPath, [
      cliPath,
      "--summary", requestPayload.summary,
      "--question", requestPayload.question,
      "--source", requestPayload.source,
      "--workspace-root", requestPayload.workspaceRoot ?? "",
      "--session-id", requestPayload.chatSessionId ?? "",
      "--port", String(args.port),
      "--retries", String(args.retries),
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = raw.trim() ? JSON.parse(raw) : {};
  if (input.hookEventName !== "Stop") return;
  const summary = await extractLastAssistantTextFromTranscriptPath(input.transcript_path)
    || `## 工作汇报\n- 当前 VS Code Copilot 会话已到达停止点\n- 工作区：${input.cwd ?? "(unknown)"}`;
  const result = await runSuperAskCli(args, buildVscodeHookRequestPayload(input, summary));
  if (result.code !== 0) {
    process.stdout.write(JSON.stringify({
      continue: true,
      systemMessage: result.stderr.trim() || "super-ask hook failed; continuing without feedback loop",
    }));
    return;
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed.feedback === "string" && parsed.feedback.trim()) {
    process.stdout.write(JSON.stringify(buildStopHookOutput(parsed.feedback.trim())));
  }
}

module.exports = {
  extractLastAssistantTextFromTranscriptContent,
  extractVscodeQuestion,
  buildVscodeHookRequestPayload,
  buildStopHookOutput,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Extend the hook tests with process-level behavior**

Add a stub-server integration case to `cli/super-ask-vscode-hook.test.cjs`:

```js
test("Stop hook calls the existing super-ask CLI and returns a blocking VS Code hook output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-ask-vscode-hook-"));
  const transcriptPath = path.join(tempDir, "transcript.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 A\n请确认是否继续？" }],
        },
      }),
    ].join("\n"),
    "utf-8",
  );

  let askBody = null;
  let ackCount = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/super-ask") {
      askBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ chatSessionId: "vscode-session-1", feedback: "继续执行下一步" }));
      return;
    }
    if (req.url === "/api/ack") {
      ackCount += 1;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(__dirname, "super-ask-vscode-hook.js"),
        "--port", String(port),
      ], { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({
        hookEventName: "Stop",
        sessionId: "vscode-session-1",
        cwd: "/tmp/workspace",
        transcript_path: transcriptPath,
        stop_hook_active: false,
      }));
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(askBody.chatSessionId, "vscode-session-1");
    assert.equal(askBody.workspaceRoot, "/tmp/workspace");
    const hookOutput = JSON.parse(result.stdout);
    assert.deepEqual(hookOutput, {
      hookSpecificOutput: {
        hookEventName: "Stop",
        decision: "block",
        reason: "继续执行下一步",
      },
    });
    assert.equal(ackCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run the VS Code hook tests**

Run: `node --test cli/super-ask-vscode-hook.test.cjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cli/super-ask-vscode-hook.js cli/super-ask-vscode-hook.test.cjs
git commit -m "feat(vscode): add stop-hook adapter for super-ask server"
```

---

### Task 2: Add a VS Code hook config template

**Files:**
- Create: `rules/super-ask-vscode-hooks.json`

- [ ] **Step 1: Add the template file**

Create `rules/super-ask-vscode-hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "node \"{{SUPER_ASK_VSCODE_HOOK_CLI}}\" --port 19960 --retries -1",
        "timeout": 86400
      }
    ]
  }
}
```

- [ ] **Step 2: Quick placeholder check**

Run: `cat rules/super-ask-vscode-hooks.json`

Expected: contains `{{SUPER_ASK_VSCODE_HOOK_CLI}}` and no syntax errors

- [ ] **Step 3: Commit**

```bash
git add rules/super-ask-vscode-hooks.json
git commit -m "feat(vscode): add hook config template"
```

---

### Task 3: Extend deployManager for VS Code hook files

**Files:**
- Modify: `server/src/deployManager.ts`
- Modify: `server/deployManager-path-render.test.ts`

- [ ] **Step 1: Add a VS Code hook CLI placeholder**

In `server/src/deployManager.ts`, extend `renderRuleTemplate()` replacements:

```ts
      ["{{SUPER_ASK_VSCODE_HOOK_CLI}}", this.cliPath("super-ask-vscode-hook.js")],
```

- [ ] **Step 2: Update `deployVscode()`**

Modify `deployVscode()` so it writes:
- `.copilot/instructions/super-ask.instructions.md`
- `.github/hooks/super-ask-vscode.json`

Implementation shape:

```ts
    const githubHooksDir = join(root, ".github", "hooks");
    const hooksFile = join(githubHooksDir, "super-ask-vscode.json");

    await this.runStep(steps, "create_github_hooks_dir", "创建 .github/hooks 目录", async () => {
      await mkdir(githubHooksDir, { recursive: true });
    }, githubHooksDir);

    await this.runStep(steps, "deploy_vscode_hooks", "部署 VS Code Copilot hooks.json", async (step) => {
      const renderedHooks = await this.readRenderedRule("super-ask-vscode-hooks.json");
      await this.writeFileWithBackup(step, hooksFile, ensureTrailingNewline(renderedHooks.trimEnd()));
    }, hooksFile);
```

Update verify step to check both files exist.

- [ ] **Step 3: Update `deployVscodeUser()`**

Modify `deployVscodeUser()` so it writes:
- `~/.copilot/instructions/super-ask.instructions.md`
- `~/.copilot/hooks/super-ask-vscode.json`

Pattern is the same as workspace deploy, but target directory is `join(homedir(), ".copilot", "hooks")`.

- [ ] **Step 4: Update `undeployVscode()` and `undeployVscodeUser()`**

Make both remove the corresponding hook file in addition to the instructions file.

- [ ] **Step 5: Update `checkStatus()`**

In both user and workspace branches, include the new hook file in `rulesFiles` when present:

```ts
const hooksFile = join(root, ".github", "hooks", "super-ask-vscode.json");
...
if (st.isFile()) vscodeFiles.push(".github/hooks/super-ask-vscode.json");
```

and for user scope:

```ts
const hooksFile = join(home, ".copilot", "hooks", "super-ask-vscode.json");
...
if (st.isFile()) vscodeFiles.push("super-ask-vscode.json");
```

- [ ] **Step 6: Extend deployment tests**

Update `server/deployManager-path-render.test.ts`:

1. In `makeProjectRoot()`, add:

```ts
  await writeFile(join(root, "rules", "super-ask-vscode-hooks.json"), TEMPLATE, "utf-8");
```

2. In `deployVscode renders path placeholders before writing instructions`, assert the new hook file exists:

```ts
    const renderedHooks = await readFile(
      join(workspace, ".github", "hooks", "super-ask-vscode.json"),
      "utf-8",
    );
    assert.match(renderedHooks, /super-ask-vscode-hook\.js/);
```

3. In `deployVscode renders production template without placeholder leaks`, add:

```ts
    const renderedHooks = await readFile(
      join(workspace, ".github", "hooks", "super-ask-vscode.json"),
      "utf-8",
    );
    assert.doesNotMatch(renderedHooks, /\{\{SUPER_ASK_/);
    assert.match(renderedHooks, /super-ask-vscode-hook\.js/);
```

4. Add one new status assertion:

```ts
    const status = await manager.checkStatus(workspace, "workspace");
    assert.deepEqual(status.deployed, [
      {
        platform: "vscode",
        workspacePath: workspace,
        rulesFiles: ["super-ask.instructions.md", ".github/hooks/super-ask-vscode.json"],
      },
    ]);
```

- [ ] **Step 7: Run deployment tests**

Run: `cd server && node --test deployManager-path-render.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/deployManager.ts server/deployManager-path-render.test.ts
git commit -m "feat(vscode): deploy copilot hook files"
```

---

### Task 4: Rewrite Copilot instructions for hook-driven operation

**Files:**
- Modify: `rules/super-ask-copilot.md`

- [ ] **Step 1: Replace manual CLI instructions with hook-driven guidance**

Rewrite `rules/super-ask-copilot.md` so it mirrors the Codex hook-driven style:

```md
---
applyTo: "**"
---
# super-ask 工具（VS Code Copilot hook 驱动）

**适用范围**：仅当前执行用户任务的主 agent。

## 核心规则

当 Super Ask 的 VS Code Copilot hooks 集成已部署时，用户反馈回路由 Copilot hooks 自动驱动。你不需要手动执行 `node .../cli/super-ask.js`。

这意味着：
1. 不要手动管理 super-ask 会话变量
2. 不要在普通收尾时手动调用 CLI
3. 每轮工作结束前，最后一条 assistant 消息必须写成真正给用户看的汇报
4. 如果需要用户决策，直接把问题写在最后一条 assistant 消息里

## 你需要做什么

你的最后一条 assistant 消息必须：
- 清楚说明已经做了什么
- 明确指出当前状态
- 如果需要用户决定，直接把问题写出来

推荐结构：

```md
## 工作汇报
- 已完成 xxx
- 发现 xxx
- 当前状态：xxx

需要你确认：
- 是否按 A 方案继续？
```

## 说明

- workspaceRoot、source、会话归并由 hook 自动提供
- Stop hook 会读取最后一条 assistant 消息，并自动调用 super-ask
- subagent 不应单独负责用户汇报；面向用户的总结应由主 agent 最终输出
```

- [ ] **Step 2: Check that no manual CLI command remains**

Run: `rg -n "node .*super-ask|--session-id|block_until_ms|chatSessionId" rules/super-ask-copilot.md`

Expected:
- no remaining manual `node .../cli/super-ask.js` invocation instructions
- no remaining `block_until_ms` guidance
- only hook-driven wording remains

- [ ] **Step 3: Commit**

```bash
git add rules/super-ask-copilot.md
git commit -m "docs(vscode): switch copilot guidance to hook-driven flow"
```

---

### Task 5: Run focused verification

**Files:**
- Verify only

- [ ] **Step 1: Run the hook adapter test**

Run: `node --test cli/super-ask-vscode-hook.test.cjs`

Expected: PASS

- [ ] **Step 2: Run the deployment test**

Run: `cd server && node --test deployManager-path-render.test.ts`

Expected: PASS

- [ ] **Step 3: Verify the rewritten rules file**

Run: `rg -n "手动调用|super-ask.js|chatSessionId|block_until_ms" rules/super-ask-copilot.md`

Expected: no manual CLI workflow remnants

- [ ] **Step 4: Manual smoke check of rendered workspace output**

Run:

```bash
TMPDIR=$(mktemp -d)
node - <<'NODE'
const { DeployManager } = await import('./server/src/deployManager.ts');
const manager = new DeployManager(process.cwd());
await manager.deployVscode(process.env.TMPDIR);
NODE
find "$TMPDIR/.copilot" "$TMPDIR/.github/hooks" -maxdepth 2 -type f | sort
```

Expected:
- `$TMPDIR/.copilot/instructions/super-ask.instructions.md`
- `$TMPDIR/.github/hooks/super-ask-vscode.json`

- [ ] **Step 5: Commit or report blockers**

If everything passes:

```bash
git status --short
```

Expected: only the intended VS Code/Copilot hook files remain modified

If blocked, stop and report exact failing command and file.
