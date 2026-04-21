# Codex Subagent Transcript Enrichment 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 Codex 的 `Stop` hook 在发给 super-ask 的请求里，附带一段基于 transcript 提取出来的简短 subagent 活动摘要，同时不改变 server 协议和 hook 部署形态。

**架构：** 保持 Codex 继续走现有的 `Stop`-only hook 路径，但在 `transcript_path` 可用时对发出的 `summary` 做增强。把 transcript 解析提取到一个共享的 CLI helper 模块里，这样 Cursor 可以保持现有行为，而 Codex 只是在最小重复的前提下获得 subagent 感知能力，并且在解析失败时回退到现有行为。

**技术栈：** Node.js CommonJS CLI 脚本、`node:fs/promises` transcript 读取、`node:test` CLI/集成测试、现有 `server/poll-protocol.test.mjs` stub-server 测试框架。

> 本文件是英文计划 [2026-04-21-codex-subagent-transcript-enrichment.md](/Users/leoli/workspace/super-ask/docs/superpowers/plans/2026-04-21-codex-subagent-transcript-enrichment.md) 的中文版本。代码块保持原样，说明文字改为中文，结构与实施顺序保持一致。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `cli/transcript-utils.js` | 新建 | 共享 transcript 解析 helper，负责提取 assistant 文本与 Codex subagent 活动 |
| `cli/transcript-utils.test.cjs` | 新建 | transcript 解析与 subagent 活动归纳的单元测试 |
| `cli/super-ask-cursor.js` | 修改 | 复用共享 transcript helper，确保 Cursor 行为不变 |
| `cli/super-ask.js` | 修改 | 给 Codex 增加 transcript enrichment，并导出可测试 helper |
| `cli/super-ask-codex.test.cjs` | 新建 | Codex payload 生成与 fail-open 回退的单元测试 |
| `server/poll-protocol.test.mjs` | 修改 | 端到端验证 transcript 派生的 subagent 摘要会进入 `/super-ask` |
| `rules/super-ask-codex.md` | 修改 | 文档化 Codex Stop hook 可能会从 transcript 补充 subagent 活动摘要，但主 agent 汇报仍是权威来源 |

## 范围边界

- Phase 1 **不要**改 `server/src/deployManager.ts`，也不要改 `~/.codex/hooks.json` 的渲染逻辑。
- **不要**修改 server 请求 schema。server 继续只接收 `summary`、`question`、`source`、`options`、`chatSessionId`、`workspaceRoot`、`requestId`。
- Phase 1 **不要**把 `state_5.sqlite`、`archived_sessions`、`hooks/logs` 引入为运行时必需依赖。
- **不要**让 Codex 依赖新的 hook 事件名。整个路径仍然是 `Stop`-only。

---

### 任务 1：创建共享 transcript helper

**涉及文件：**
- 新建：`cli/transcript-utils.js`
- 新建：`cli/transcript-utils.test.cjs`

- [ ] **步骤 1：先写失败的 transcript helper 测试**

创建 `cli/transcript-utils.test.cjs`，内容如下：

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractLastAssistantTextFromTranscriptContent,
  extractSubagentActivityFromTranscriptContent,
  mergeSummaryWithSubagentActivity,
} = require("./transcript-utils.js");

test("extractLastAssistantTextFromTranscriptContent returns the last assistant text block", () => {
  const transcript = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第一轮汇报" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第二轮汇报\n请确认是否继续？" }],
      },
    }),
  ].join("\n");

  assert.equal(
    extractLastAssistantTextFromTranscriptContent(transcript),
    "第二轮汇报\n请确认是否继续？",
  );
});

test("extractSubagentActivityFromTranscriptContent summarizes current-turn subagent lifecycle", () => {
  const transcript = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "请继续" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        new_thread_id: "thread-1",
        new_agent_nickname: "Ada",
        new_agent_role: "explorer",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_waiting_end",
        agent_statuses: [
          {
            thread_id: "thread-1",
            agent_nickname: "Ada",
            agent_role: "explorer",
            status: { completed: "done" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "collab_close_end",
        receiver_thread_id: "thread-1",
        receiver_agent_nickname: "Ada",
        receiver_agent_role: "explorer",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<subagent_notification>\n{\"agent_path\":\"thread-1\",\"status\":{\"completed\":\"done\"}}\n</subagent_notification>",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 X" }],
      },
    }),
  ].join("\n");

  assert.deepEqual(
    extractSubagentActivityFromTranscriptContent(transcript, "## 工作汇报\n- 已完成 X"),
    {
      spawned: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
      completed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
      closed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    },
  );
});

test("mergeSummaryWithSubagentActivity appends a compact section once", () => {
  const merged = mergeSummaryWithSubagentActivity("## 工作汇报\n- 已完成 X", {
    spawned: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    completed: [{ threadId: "thread-1", nickname: "Ada", role: "explorer" }],
    closed: [],
  });

  assert.match(merged, /## Subagent 活动/);
  assert.match(merged, /本轮启动 1 个：Ada/);
  assert.match(merged, /已完成 1 个：Ada/);
});

test("extractSubagentActivityFromTranscriptContent returns empty buckets when no subagent events exist", () => {
  const transcript = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "普通问题" }] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "普通汇报" }],
      },
    }),
  ].join("\n");

  assert.deepEqual(
    extractSubagentActivityFromTranscriptContent(transcript, "普通汇报"),
    { spawned: [], completed: [], closed: [] },
  );
});
```

- [ ] **步骤 2：运行 helper 测试，确认它先失败**

运行：

```bash
node --test cli/transcript-utils.test.cjs
```

期望：

```text
FAIL with `Cannot find module './transcript-utils.js'`
```

- [ ] **步骤 3：实现 `cli/transcript-utils.js`**

创建 `cli/transcript-utils.js`，内容如下：

```js
const { readFile } = require("node:fs/promises");

function extractTextBlocks(content) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      return [item.text];
    }
    if (item.type === "input_text" && typeof item.text === "string" && item.text.trim()) {
      return [item.text];
    }
    if (item.type === "output_text" && typeof item.text === "string" && item.text.trim()) {
      return [item.text];
    }
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

function getMessageRole(entry) {
  if (entry?.role) return entry.role;
  return entry?.payload?.role ?? null;
}

function getMessageContent(entry) {
  if (entry?.message?.content) return entry.message.content;
  return entry?.payload?.content ?? null;
}

function extractSubagentNotification(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("<subagent_notification>")) return null;
  const inner = raw
    .replace(/^<subagent_notification>\s*/, "")
    .replace(/\s*<\/subagent_notification>$/, "");
  try {
    const parsed = JSON.parse(inner);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractLastAssistantTextFromTranscriptContent(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  let lastAssistantText = "";
  for (const line of lines) {
    const entry = parseTranscriptLine(line.trim());
    if (!entry || getMessageRole(entry) !== "assistant") continue;
    const blocks = extractTextBlocks(getMessageContent(entry));
    if (blocks.length > 0) lastAssistantText = blocks.join("\n\n").trim();
  }
  return lastAssistantText || null;
}

async function extractLastAssistantTextFromTranscriptPath(transcriptPath, onReadError = async () => {}) {
  if (!transcriptPath) return null;
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return extractLastAssistantTextFromTranscriptContent(content);
  } catch (error) {
    await onReadError(error);
    return null;
  }
}

function findLastAssistantIndex(entries, summary) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || getMessageRole(entry) !== "assistant") continue;
    const blocks = extractTextBlocks(getMessageContent(entry));
    const text = blocks.join("\n\n").trim();
    if (text && text === String(summary ?? "").trim()) return i;
  }
  return -1;
}

function isRealUserPrompt(entry) {
  if (!entry || getMessageRole(entry) !== "user") return false;
  const text = extractTextBlocks(getMessageContent(entry)).join("\n\n").trim();
  return Boolean(text) && !text.startsWith("<subagent_notification>");
}

function sliceCurrentTurnEntries(entries, summary) {
  const assistantIndex = findLastAssistantIndex(entries, summary);
  if (assistantIndex < 0) return entries;
  let start = 0;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (isRealUserPrompt(entries[i])) {
      start = i;
      break;
    }
  }
  return entries.slice(start, assistantIndex + 1);
}

function pushUnique(target, item) {
  if (!item.threadId) return;
  if (target.some((existing) => existing.threadId === item.threadId)) return;
  target.push(item);
}

function extractSubagentActivityFromTranscriptContent(content, summary) {
  const entries = String(content ?? "")
    .split(/\r?\n/)
    .map((line) => parseTranscriptLine(line.trim()))
    .filter(Boolean);
  const currentTurn = sliceCurrentTurnEntries(entries, summary);
  const activity = { spawned: [], completed: [], closed: [] };

  for (const entry of currentTurn) {
    if (entry.type === "event_msg" && entry.payload?.type === "collab_agent_spawn_end") {
      pushUnique(activity.spawned, {
        threadId: String(entry.payload.new_thread_id ?? ""),
        nickname: String(entry.payload.new_agent_nickname ?? ""),
        role: String(entry.payload.new_agent_role ?? ""),
      });
      continue;
    }

    if (entry.type === "event_msg" && entry.payload?.type === "collab_waiting_end") {
      for (const status of entry.payload.agent_statuses ?? []) {
        if (status?.status?.completed) {
          pushUnique(activity.completed, {
            threadId: String(status.thread_id ?? ""),
            nickname: String(status.agent_nickname ?? ""),
            role: String(status.agent_role ?? ""),
          });
        }
      }
      continue;
    }

    if (entry.type === "event_msg" && entry.payload?.type === "collab_close_end") {
      pushUnique(activity.closed, {
        threadId: String(entry.payload.receiver_thread_id ?? ""),
        nickname: String(entry.payload.receiver_agent_nickname ?? ""),
        role: String(entry.payload.receiver_agent_role ?? ""),
      });
      continue;
    }

    if (getMessageRole(entry) === "user") {
      const joined = extractTextBlocks(getMessageContent(entry)).join("\n\n").trim();
      const notification = extractSubagentNotification(joined);
      if (notification?.status?.completed) {
        pushUnique(activity.completed, {
          threadId: String(notification.agent_path ?? ""),
          nickname: "",
          role: "",
        });
      }
    }
  }

  return activity;
}

async function extractSubagentActivityFromTranscriptPath(transcriptPath, summary, onReadError = async () => {}) {
  if (!transcriptPath) return { spawned: [], completed: [], closed: [] };
  try {
    const content = await readFile(transcriptPath, "utf-8");
    return extractSubagentActivityFromTranscriptContent(content, summary);
  } catch (error) {
    await onReadError(error);
    return { spawned: [], completed: [], closed: [] };
  }
}

function formatNames(items) {
  return items.map((item) => item.nickname || item.threadId).join("、");
}

function mergeSummaryWithSubagentActivity(summary, activity) {
  const base = String(summary ?? "").trim();
  if (!base) return base;
  if (base.includes("## Subagent 活动")) return base;
  const lines = [];
  if (activity.spawned.length > 0) lines.push(`- 本轮启动 ${activity.spawned.length} 个：${formatNames(activity.spawned)}`);
  if (activity.completed.length > 0) lines.push(`- 已完成 ${activity.completed.length} 个：${formatNames(activity.completed)}`);
  if (activity.closed.length > 0) lines.push(`- 已关闭 ${activity.closed.length} 个：${formatNames(activity.closed)}`);
  if (lines.length === 0) return base;
  return `${base}\n\n## Subagent 活动\n${lines.join("\n")}`;
}

module.exports = {
  extractTextBlocks,
  parseTranscriptLine,
  extractLastAssistantTextFromTranscriptContent,
  extractLastAssistantTextFromTranscriptPath,
  extractSubagentActivityFromTranscriptContent,
  extractSubagentActivityFromTranscriptPath,
  mergeSummaryWithSubagentActivity,
};
```

- [ ] **步骤 4：重新运行 helper 测试，确认通过**

运行：

```bash
node --test cli/transcript-utils.test.cjs
```

期望：

```text
PASS with 4 passing tests
```

- [ ] **步骤 5：提交**

```bash
git add cli/transcript-utils.js cli/transcript-utils.test.cjs
git commit -m "feat(cli): add shared transcript parsing helpers"
```

---

### 任务 2：让 Cursor 改为使用共享 helper

**涉及文件：**
- 修改：`cli/super-ask-cursor.js`
- 修改：`cli/super-ask-cursor.test.cjs`

- [ ] **步骤 1：先更新 Cursor 测试，再做重构**

在 `cli/super-ask-cursor.test.cjs` 中，把导入改成：

```js
const {
  extractCursorQuestion,
  buildCursorStopHookPayload,
  pickWorkspaceRoot,
} = require("./super-ask-cursor.js");
```

然后在现有 `buildCursorStopHookPayload reads transcript text` 用例后面，新增一个回归测试：

```js
test("buildCursorStopHookPayload still prefers inline summary over transcript text", async () => {
  const payload = await buildCursorStopHookPayload({
    last_assistant_message: "内联汇报\n请确认是否继续？",
    transcript_path: "/tmp/does-not-matter.jsonl",
    session_id: "cursor-session-1",
    generation_id: "generation-43",
    workspace_roots: ["/Users/leoli/workspace/super-ask"],
  });

  assert.deepEqual(payload, {
    summary: "内联汇报\n请确认是否继续？",
    question: "请确认是否继续？",
    source: "cursor",
    options: ["继续", "需要修改", "我有问题"],
    requestId: "cursor-stop:cursor-session-1:generation-43",
    chatSessionId: "cursor-session-1",
    workspaceRoot: "/Users/leoli/workspace/super-ask",
  });
});
```

- [ ] **步骤 2：先运行 Cursor 测试，确认重构前仍然通过**

运行：

```bash
node --test cli/super-ask-cursor.test.cjs
```

期望：

```text
PASS
```

- [ ] **步骤 3：重构 `cli/super-ask-cursor.js`，改用共享 helper**

在 `cli/super-ask-cursor.js` 顶部添加：

```js
const {
  extractLastAssistantTextFromTranscriptContent,
  extractLastAssistantTextFromTranscriptPath,
} = require("./transcript-utils.js");
```

然后删除文件里本地实现的这些函数：

```js
function extractTextBlocks(content) { ... }
function parseTranscriptLine(line) { ... }
function extractLastAssistantTextFromTranscriptContent(content) { ... }
async function extractLastAssistantTextFromTranscriptPath(transcriptPath) { ... }
```

把 `buildCursorStopHookPayload` 里原来的 transcript 读取调用替换成：

```js
  const summary = inlineSummary || await extractLastAssistantTextFromTranscriptPath(
    String(payload.transcript_path ?? payload.transcriptPath ?? "").trim(),
    async (error) => {
      await logEvent("cursor_hook.transcript.read_error", {
        transcriptPath: String(payload.transcript_path ?? payload.transcriptPath ?? "").trim(),
        error: String(error),
      });
    },
  );
```

保留现有导出面不变：

```js
module.exports = {
  extractCursorQuestion,
  extractLastAssistantTextFromTranscriptContent,
  buildCursorStopHookPayload,
  pickWorkspaceRoot,
};
```

- [ ] **步骤 4：重新运行 Cursor 与共享 helper 测试**

运行：

```bash
node --test cli/transcript-utils.test.cjs cli/super-ask-cursor.test.cjs
```

期望：

```text
PASS with all CLI helper tests green
```

- [ ] **步骤 5：提交**

```bash
git add cli/super-ask-cursor.js cli/super-ask-cursor.test.cjs
git commit -m "refactor(cli): share transcript parsing with cursor hook"
```

---

### 任务 3：给 Codex 增加 transcript enrichment

**涉及文件：**
- 修改：`cli/super-ask.js`
- 新建：`cli/super-ask-codex.test.cjs`
- 保持不变：`cli/super-ask-codex.js`

- [ ] **步骤 1：先写失败的 Codex 单元测试**

创建 `cli/super-ask-codex.test.cjs`：

```js
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  extractCodexQuestion,
  buildCodexStopHookPayload,
} = require("./super-ask.js");

test("extractCodexQuestion reuses the last question line", () => {
  assert.equal(
    extractCodexQuestion("## 工作汇报\n- 已完成 X\n需要你确认：\n- 是否继续？"),
    "- 是否继续？",
  );
});

test("buildCodexStopHookPayload enriches summary with transcript-derived subagent activity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-ask-codex-hook-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "collab_agent_spawn_end",
            new_thread_id: "thread-1",
            new_agent_nickname: "Ada",
            new_agent_role: "explorer",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "collab_waiting_end",
            agent_statuses: [
              {
                thread_id: "thread-1",
                agent_nickname: "Ada",
                agent_role: "explorer",
                status: { completed: "done" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 X" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const payload = await buildCodexStopHookPayload({
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      cwd: "/Users/leoli/workspace/super-ask",
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
      last_assistant_message: "## 工作汇报\n- 已完成 X",
    });

    assert.equal(payload.chatSessionId, "codex-session-1");
    assert.equal(payload.requestId, "codex-turn-1");
    assert.match(payload.summary, /## Subagent 活动/);
    assert.match(payload.summary, /Ada/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildCodexStopHookPayload falls back to the original summary when transcript reading fails", async () => {
  const payload = await buildCodexStopHookPayload({
    session_id: "codex-session-1",
    turn_id: "codex-turn-2",
    cwd: "/Users/leoli/workspace/super-ask",
    hook_event_name: "Stop",
    transcript_path: "/tmp/does-not-exist.jsonl",
    last_assistant_message: "## 工作汇报\n- 已完成 X",
  });

  assert.equal(payload.summary, "## 工作汇报\n- 已完成 X");
});
```

- [ ] **步骤 2：运行 Codex 单元测试，确认它先失败**

运行：

```bash
node --test cli/super-ask-codex.test.cjs
```

期望：

```text
FAIL because `super-ask.js` does not export `buildCodexStopHookPayload`
```

- [ ] **步骤 3：在 `cli/super-ask.js` 中实现 transcript enrichment**

在 `cli/super-ask.js` 顶部添加：

```js
const {
  extractSubagentActivityFromTranscriptPath,
  mergeSummaryWithSubagentActivity,
} = require("./transcript-utils.js");
```

把 `buildCodexStopHookPayload` 改成异步函数，并替换成下面这个实现：

```js
async function buildCodexStopHookPayload(payload) {
  const summary = String(payload.last_assistant_message ?? payload.lastAssistantMessage ?? "").trim();
  if (!summary) return null;

  const transcriptPath = String(payload.transcript_path ?? payload.transcriptPath ?? "").trim();
  const activity = await extractSubagentActivityFromTranscriptPath(
    transcriptPath,
    summary,
    async (error) => {
      await logEvent("codex_hook.transcript.read_error", {
        transcriptPath,
        error: String(error),
      });
    },
  );

  const enrichedSummary = mergeSummaryWithSubagentActivity(summary, activity);

  const body = {
    summary: enrichedSummary,
    question: extractCodexQuestion(enrichedSummary),
    source: "codex",
    options: ["继续", "需要修改", "我有问题"],
  };

  const chatSessionId = String(payload.session_id ?? payload.sessionId ?? "").trim();
  if (chatSessionId) body.chatSessionId = chatSessionId;

  const workspaceRoot = String(payload.cwd ?? "").trim();
  if (workspaceRoot) body.workspaceRoot = workspaceRoot;

  const requestId = String(payload.turn_id ?? payload.turnId ?? "").trim();
  body.requestId = requestId || randomUUID();
  return body;
}
```

在 `runCodexHook` 里保持现有 `Stop`-only 行为，但确保这里仍然是 awaited：

```js
  const requestPayload = await buildCodexStopHookPayload(payload);
```

在文件底部、`main()` 前面，新增导出：

```js
module.exports = {
  extractCodexQuestion,
  buildCodexStopHookPayload,
};
```

**不要**改 `cli/super-ask-codex.js`，它应继续保持稳定 wrapper：

```js
#!/usr/bin/env node
require("./super-ask.js");
```

- [ ] **步骤 4：运行 Codex 与共享 CLI 测试**

运行：

```bash
node --test cli/transcript-utils.test.cjs cli/super-ask-cursor.test.cjs cli/super-ask-codex.test.cjs
```

期望：

```text
PASS
```

- [ ] **步骤 5：提交**

```bash
git add cli/super-ask.js cli/super-ask-codex.test.cjs
git commit -m "feat(cli): enrich codex stop summaries with subagent activity"
```

---

### 任务 4：证明端到端 Stop hook 行为，并更新文档

**涉及文件：**
- 修改：`server/poll-protocol.test.mjs`
- 修改：`rules/super-ask-codex.md`

- [ ] **步骤 1：扩展端到端 Codex hook 测试**

在 `server/poll-protocol.test.mjs` 里，找到现有测试 `CLI codex stop hook mode reuses Codex session_id and turns feedback into a stop block`，把输入 payload 构造替换成带临时 transcript 的版本：

```js
      const transcriptDir = await mkdtemp(join(tmpdir(), "super-ask-codex-transcript-"));
      const transcriptPath = join(transcriptDir, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "collab_agent_spawn_end",
              new_thread_id: "thread-1",
              new_agent_nickname: "Ada",
              new_agent_role: "explorer",
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "## 工作汇报\n- 已完成 A\n- 待处理 B" }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const result = await runCliWithStdin(
        ["--codex-hook", "--port", String(port)],
        JSON.stringify({
          session_id: "codex-session-123",
          turn_id: "codex-turn-456",
          cwd: "/tmp/workspace",
          hook_event_name: "Stop",
          transcript_path: transcriptPath,
          last_assistant_message: "## 工作汇报\n- 已完成 A\n- 待处理 B",
        }),
        { HOME: home },
        CODEX_CLI,
      );
```

然后在现有 `askBody.summary` 断言后面，新增两个断言：

```js
      assert.match(askBody.summary, /## Subagent 活动/);
      assert.match(askBody.summary, /Ada/);
```

- [ ] **步骤 2：补充 enrichment 行为说明**

在 `rules/super-ask-codex.md` 现有说明块下，追加这行：

```md
- Codex `Stop` hook 可能会结合 `transcript_path` 补充一小段 subagent 活动摘要，但主 agent 的最后一条 assistant 消息仍然是面向用户汇报的权威来源
```

- [ ] **步骤 3：运行端到端测试**

运行：

```bash
node --test server/poll-protocol.test.mjs
```

期望：

```text
PASS, including the Codex stop-hook case
```

- [ ] **步骤 4：运行 Phase 1 全套目标测试**

运行：

```bash
node --test cli/transcript-utils.test.cjs cli/super-ask-cursor.test.cjs cli/super-ask-codex.test.cjs server/poll-protocol.test.mjs
```

期望：

```text
PASS with all targeted Phase 1 tests green
```

- [ ] **步骤 5：手工验证与回滚说明**

手工验证：

```bash
jq '.payload | {hook_event_name, transcript_path, session_id, turn_id}' "$HOME/.codex/hooks/logs/latest-stop.json"
```

期望：
- `hook_event_name` 为 `Stop`
- 真实 Codex Stop 事件里 `transcript_path` 非空

如果新 enrichment 行为异常，回滚方式：

```bash
git revert HEAD
```

期望：
- Codex 回到旧的 `last_assistant_message`-only 行为
- 因为 Phase 1 不改 `server/src/deployManager.ts` 和 hook 模板，所以不需要额外做 deploy/config 回滚

- [ ] **步骤 6：提交**

```bash
git add server/poll-protocol.test.mjs rules/super-ask-codex.md
git commit -m "test(codex): cover transcript-enriched stop hook summaries"
```

---

## 覆盖检查

- 共享 transcript 解析：由任务 1 覆盖。
- Cursor 回归安全：由任务 2 覆盖。
- Codex transcript enrichment 与 fail-open 回退：由任务 3 覆盖。
- 端到端 hook 行为与用户可见规则说明：由任务 4 覆盖。
- Phase 1 不需要修改 deploy template，因为运行时已经能在真实 Stop payload 里拿到 `transcript_path`。

## 执行时重点关注的风险

- transcript 结构在历史文件和实时 Stop-hook 文件之间可能有差异。未知行必须忽略，不能让解析失败。
- Codex transcript 解析必须限定在“当前 turn”片段内，不能把旧 turn 的 subagent 事件误汇总进来。
- transcript 读取失败不能改变 exit code，也不能阻断 Stop hook。
- `cli/super-ask-codex.js` 必须保持不变，确保已部署的 hook 命令路径稳定。
