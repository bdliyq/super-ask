# Codex Subagent Transcript Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Codex `Stop` hook include a compact, transcript-derived subagent activity summary in the payload sent to super-ask, without changing server protocol or hook deployment shape.

**Architecture:** Keep Codex on the existing `Stop`-only hook path, but enrich the outgoing `summary` by parsing `transcript_path` when available. Extract transcript parsing into a shared CLI helper module so Cursor keeps its current behavior while Codex gains subagent-aware enrichment with minimal duplication and a fail-open fallback.

**Tech Stack:** Node.js CommonJS CLI scripts, `node:fs/promises` transcript reads, `node:test` CLI/integration tests, existing `server/poll-protocol.test.mjs` stub-server harness.

---

## File Structure

| File | Operation | Responsibility |
|------|------|------|
| `cli/transcript-utils.js` | Create | Shared transcript parsing helpers for assistant text extraction and Codex subagent activity extraction |
| `cli/transcript-utils.test.cjs` | Create | Unit tests for transcript parsing and subagent activity summarization |
| `cli/super-ask-cursor.js` | Modify | Reuse shared transcript helpers without changing Cursor behavior |
| `cli/super-ask.js` | Modify | Add Codex transcript enrichment and export testable helpers |
| `cli/super-ask-codex.test.cjs` | Create | Codex-specific unit tests for payload generation and fail-open fallback |
| `server/poll-protocol.test.mjs` | Modify | End-to-end Codex hook test that proves transcript-derived subagent summary reaches `/super-ask` |
| `rules/super-ask-codex.md` | Modify | Document that Codex Stop hook may enrich the summary from transcript activity while the main agent report remains authoritative |

## Scope Guardrails

- Do **not** change `server/src/deployManager.ts` or `~/.codex/hooks.json` rendering in Phase 1.
- Do **not** change the server request schema. The server should still receive `summary`, `question`, `source`, `options`, `chatSessionId`, `workspaceRoot`, and `requestId`.
- Do **not** introduce `state_5.sqlite`, `archived_sessions`, or `hooks/logs` as required runtime dependencies in Phase 1.
- Do **not** make Codex depend on new hook event names. The path stays `Stop`-only.

---

### Task 1: Create Shared Transcript Helpers

**Files:**
- Create: `cli/transcript-utils.js`
- Create: `cli/transcript-utils.test.cjs`

- [ ] **Step 1: Write the failing transcript-helper tests**

Create `cli/transcript-utils.test.cjs` with these tests:

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

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `node --test cli/transcript-utils.test.cjs`

Expected: FAIL with `Cannot find module './transcript-utils.js'`

- [ ] **Step 3: Implement `cli/transcript-utils.js`**

Create `cli/transcript-utils.js` with this implementation:

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

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `node --test cli/transcript-utils.test.cjs`

Expected: PASS with 4 passing tests

- [ ] **Step 5: Commit**

```bash
git add cli/transcript-utils.js cli/transcript-utils.test.cjs
git commit -m "feat(cli): add shared transcript parsing helpers"
```

---

### Task 2: Refactor Cursor to Use the Shared Helper

**Files:**
- Modify: `cli/super-ask-cursor.js`
- Modify: `cli/super-ask-cursor.test.cjs`

- [ ] **Step 1: Update the Cursor tests before refactoring**

In `cli/super-ask-cursor.test.cjs`, replace the direct import list with:

```js
const {
  extractCursorQuestion,
  buildCursorStopHookPayload,
  pickWorkspaceRoot,
} = require("./super-ask-cursor.js");
```

Then add one regression test below the existing `buildCursorStopHookPayload reads transcript text` case:

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

- [ ] **Step 2: Run the Cursor tests to verify they still pass before refactor**

Run: `node --test cli/super-ask-cursor.test.cjs`

Expected: PASS

- [ ] **Step 3: Refactor `cli/super-ask-cursor.js` to consume the helper**

At the top of `cli/super-ask-cursor.js`, add:

```js
const {
  extractLastAssistantTextFromTranscriptContent,
  extractLastAssistantTextFromTranscriptPath,
} = require("./transcript-utils.js");
```

Then delete the local implementations of:

```js
function extractTextBlocks(content) { ... }
function parseTranscriptLine(line) { ... }
function extractLastAssistantTextFromTranscriptContent(content) { ... }
async function extractLastAssistantTextFromTranscriptPath(transcriptPath) { ... }
```

Replace the old `extractLastAssistantTextFromTranscriptPath` call site inside `buildCursorStopHookPayload` with:

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

Keep the existing exported surface:

```js
module.exports = {
  extractCursorQuestion,
  extractLastAssistantTextFromTranscriptContent,
  buildCursorStopHookPayload,
  pickWorkspaceRoot,
};
```

- [ ] **Step 4: Re-run the Cursor and shared-helper tests**

Run: `node --test cli/transcript-utils.test.cjs cli/super-ask-cursor.test.cjs`

Expected: PASS with all CLI helper tests green

- [ ] **Step 5: Commit**

```bash
git add cli/super-ask-cursor.js cli/super-ask-cursor.test.cjs
git commit -m "refactor(cli): share transcript parsing with cursor hook"
```

---

### Task 3: Add Codex Transcript Enrichment

**Files:**
- Modify: `cli/super-ask.js`
- Create: `cli/super-ask-codex.test.cjs`
- Keep unchanged: `cli/super-ask-codex.js`

- [ ] **Step 1: Write the failing Codex unit tests**

Create `cli/super-ask-codex.test.cjs`:

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

- [ ] **Step 2: Run the Codex unit tests to verify they fail**

Run: `node --test cli/super-ask-codex.test.cjs`

Expected: FAIL because `super-ask.js` does not export `buildCodexStopHookPayload`

- [ ] **Step 3: Implement transcript enrichment in `cli/super-ask.js`**

At the top of `cli/super-ask.js`, add:

```js
const {
  extractSubagentActivityFromTranscriptPath,
  mergeSummaryWithSubagentActivity,
} = require("./transcript-utils.js");
```

Change `buildCodexStopHookPayload` to async and replace the current function body with:

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

Inside `runCodexHook`, keep the existing `Stop`-only behavior but ensure the call remains awaited:

```js
  const requestPayload = await buildCodexStopHookPayload(payload);
```

At the bottom of the file, add exports before `main()`:

```js
module.exports = {
  extractCodexQuestion,
  buildCodexStopHookPayload,
};
```

Do **not** change `cli/super-ask-codex.js`; its stable wrapper should stay:

```js
#!/usr/bin/env node
require("./super-ask.js");
```

- [ ] **Step 4: Run the Codex and shared CLI tests**

Run: `node --test cli/transcript-utils.test.cjs cli/super-ask-cursor.test.cjs cli/super-ask-codex.test.cjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/super-ask.js cli/super-ask-codex.test.cjs
git commit -m "feat(cli): enrich codex stop summaries with subagent activity"
```

---

### Task 4: Prove the End-to-End Stop Hook Behavior and Update Docs

**Files:**
- Modify: `server/poll-protocol.test.mjs`
- Modify: `rules/super-ask-codex.md`

- [ ] **Step 1: Extend the end-to-end Codex hook test**

In `server/poll-protocol.test.mjs`, inside the existing test named `CLI codex stop hook mode reuses Codex session_id and turns feedback into a stop block`, replace the input payload construction with a temp transcript-backed flow:

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

Then add one assertion after the existing `askBody.summary` assertion:

```js
      assert.match(askBody.summary, /## Subagent 活动/);
      assert.match(askBody.summary, /Ada/);
```

- [ ] **Step 2: Document the enrichment behavior**

In `rules/super-ask-codex.md`, append this note under the existing explanation block:

```md
- Codex `Stop` hook 可能会结合 `transcript_path` 补充一小段 subagent 活动摘要，但主 agent 的最后一条 assistant 消息仍然是面向用户汇报的权威来源
```

- [ ] **Step 3: Run the end-to-end test**

Run: `node --test server/poll-protocol.test.mjs`

Expected: PASS, including the Codex stop-hook case

- [ ] **Step 4: Run the full Phase 1 test set**

Run:

```bash
node --test cli/transcript-utils.test.cjs cli/super-ask-cursor.test.cjs cli/super-ask-codex.test.cjs server/poll-protocol.test.mjs
```

Expected: PASS with all targeted Phase 1 tests green

- [ ] **Step 5: Manual verification and rollback note**

Manual verification:

```bash
jq '.payload | {hook_event_name, transcript_path, session_id, turn_id}' "$HOME/.codex/hooks/logs/latest-stop.json"
```

Expected:
- `hook_event_name` is `Stop`
- `transcript_path` is non-empty on a real Codex stop event

Rollback if the new enrichment misbehaves:

```bash
git revert HEAD
```

Expected:
- Codex returns to the old `last_assistant_message`-only behavior
- No deploy or config rollback is needed because Phase 1 does not change `server/src/deployManager.ts` or hook templates

- [ ] **Step 6: Commit**

```bash
git add server/poll-protocol.test.mjs rules/super-ask-codex.md
git commit -m "test(codex): cover transcript-enriched stop hook summaries"
```

---

## Coverage Check

- Shared transcript parsing is covered by Task 1.
- Cursor regression safety is covered by Task 2.
- Codex transcript enrichment and fail-open fallback are covered by Task 3.
- End-to-end hook behavior and user-facing rule text are covered by Task 4.
- No deploy-template work is needed in Phase 1 because the runtime already provides `transcript_path` on real Stop payloads.

## Risks To Watch During Execution

- Transcript structure may vary between historical files and live Stop-hook files. Treat unknown lines as ignorable, not fatal.
- Codex transcript parsing must stay bounded to the current turn slice; do not scan the whole session and summarize stale subagent events.
- Do not let transcript read failures change exit code or block the Stop hook.
- Keep `cli/super-ask-codex.js` unchanged so deployed hook command paths remain stable.
