# 文件路径点击打开系统文件管理器 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息列表中的文件/目录路径可点击，点击后调用本机系统文件管理器打开对应位置。

**Architecture:** UI 在 `MarkdownContent` 的 `code` 组件中检测路径模式 → 渲染为可点击元素 → 点击时 POST `/api/open-path` 到本机 server → server 用 `execFile` 调用系统命令（macOS `open`、Windows `explorer`、Linux `xdg-open`）打开。

**Tech Stack:** React + react-markdown（UI 侧），Node.js raw HTTP + `child_process.execFile` + `fs.stat`（server 侧）

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `server/src/server.ts` | 修改 | 新增 `POST /api/open-path` 端点 |
| `ui/src/components/MarkdownContent.tsx` | 修改 | `code` 组件扩展：检测路径模式，渲染为可点击 |
| `ui/src/components/InteractionCard.tsx` | 修改 | 新增 `workspaceRoot` prop，传递给 `MarkdownContent` |
| `ui/src/components/ChatView.tsx` | 修改 | 将 `session.workspaceRoot` 传递给 `InteractionCard` |
| `ui/src/styles/global.css` | 修改 | 新增 `.clickable-path` 样式 |
| `shared/types.ts` | 修改 | 新增 `OpenPathRequest` / `OpenPathResponse` 类型 |
| `server/open-path.test.ts` | 新建 | 服务端 `/api/open-path` 测试 |
| `ui/tests/MarkdownContent-path.test.tsx` | 新建 | UI 路径检测渲染测试 |

---

### Task 1: 定义共享类型

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: 在 `shared/types.ts` 末尾添加类型定义**

在文件末尾（最后一个 export 之后）添加：

```typescript
export interface OpenPathRequest {
  /** 要打开的路径（绝对、~/、./ 或隐式相对） */
  path: string;
  /** Agent 工作区根路径，用于解析相对路径 */
  workspaceRoot?: string;
}

export interface OpenPathResponse {
  success: boolean;
  resolvedPath: string;
  type: "file" | "directory";
}
```

- [ ] **Step 2: 运行类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 无新增错误（可能有已存在的）

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add OpenPathRequest/OpenPathResponse for open-path API"
```

---

### Task 2: 实现服务端 `POST /api/open-path` 端点

**Files:**
- Modify: `server/src/server.ts:1-7` (imports)
- Modify: `server/src/server.ts` (在 `POST /api/pinned-sessions` 之后添加新端点)

**关键背景：**
- server.ts 使用 raw Node.js HTTP，无 Express
- 路由是 `if (method === "..." && pathname === "...")` 链式分支
- 认证使用 `requireAuth(req, res)` 函数，返回 false 则已写 401
- 请求体解析使用 `readJsonBody(req, limit)`
- 已导入：`spawn`（来自 `node:child_process`）、`stat`（来自 `node:fs/promises`）、`resolve`（来自 `node:path`）
- 需要新增导入：`execFile`（来自 `node:child_process`）、`homedir`（来自 `node:os`）

- [ ] **Step 1: 添加 import**

在 `server/src/server.ts` 第 7 行 `import { spawn } from "node:child_process";` 改为：

```typescript
import { execFile, spawn } from "node:child_process";
```

在现有 import 块末尾添加：

```typescript
import { homedir } from "node:os";
```

在现有 types import 中添加 `OpenPathRequest`：

找到 `import type { ... } from "../../shared/types.js";` 行，在导入列表中添加 `OpenPathRequest`。

- [ ] **Step 2: 添加 `openInFileManager` 辅助函数**

在 `startSuperAsk` 函数内部、`requireAuth` 函数定义之后，添加：

```typescript
  async function openInFileManager(targetPath: string): Promise<{ type: "file" | "directory" }> {
    const st = await stat(targetPath);
    const isDir = st.isDirectory();
    const platform = process.platform;

    let cmd: string;
    let args: string[];

    if (platform === "darwin") {
      cmd = "open";
      args = isDir ? [targetPath] : ["-R", targetPath];
    } else if (platform === "win32") {
      cmd = "explorer";
      args = isDir ? [targetPath] : ["/select,", targetPath];
    } else {
      cmd = "xdg-open";
      args = isDir ? [targetPath] : [dirname(targetPath)];
    }

    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 5000 }, (err) => {
        if (err && platform !== "win32") {
          reject(err);
        } else {
          resolve({ type: isDir ? "directory" : "file" });
        }
      });
    });
  }
```

注意：Windows 上 `explorer` 对于 `/select,` 会返回非零退出码，这是正常行为，所以 win32 忽略错误。

- [ ] **Step 3: 添加路径解析和安全校验函数**

紧接 `openInFileManager` 之后添加：

```typescript
  function resolveOpenPath(rawPath: string, workspaceRoot?: string): string {
    let resolved: string;
    if (rawPath.startsWith("~/") || rawPath === "~") {
      resolved = resolve(homedir(), rawPath.slice(2));
    } else if (rawPath.startsWith("/") || /^[A-Za-z]:\\/.test(rawPath)) {
      resolved = resolve(rawPath);
    } else {
      if (!workspaceRoot) {
        throw new Error("MISSING_WORKSPACE_ROOT");
      }
      resolved = resolve(workspaceRoot, rawPath);
    }
    if (resolved.includes("\0")) {
      throw new Error("INVALID_PATH");
    }
    return resolved;
  }
```

- [ ] **Step 4: 添加 `POST /api/open-path` 路由分支**

找到 `POST /api/pinned-sessions` 分支的结尾 `return;`，在其后添加新分支：

```typescript
    if (method === "POST" && pathname === "/api/open-path") {
      if (!requireAuth(req, res)) return;
      let body: unknown;
      try {
        body = await readJsonBody(req, 4096);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "无效请求体" }));
        return;
      }
      const { path: rawPath, workspaceRoot } = (body ?? {}) as Partial<OpenPathRequest>;
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "path 字段必填" }));
        return;
      }

      let resolved: string;
      try {
        resolved = resolveOpenPath(rawPath.trim(), typeof workspaceRoot === "string" ? workspaceRoot.trim() : undefined);
      } catch (e: unknown) {
        const code = e instanceof Error ? e.message : "INVALID_PATH";
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: code === "MISSING_WORKSPACE_ROOT" ? "相对路径需要 workspaceRoot" : "无效路径" }));
        return;
      }

      try {
        const result = await openInFileManager(resolved);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true, resolvedPath: resolved, type: result.type }));
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "路径不存在或无法打开" }));
      }
      return;
    }
```

- [ ] **Step 5: 运行类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): add POST /api/open-path endpoint"
```

---

### Task 3: 添加 CSS 样式

**Files:**
- Modify: `ui/src/styles/global.css`

- [ ] **Step 1: 添加 `.clickable-path` 样式**

在 `.markdown-body code a` 样式块之后添加：

```css
.markdown-body code.clickable-path {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
  transition: background 0.15s, color 0.15s;
}

.markdown-body code.clickable-path:hover {
  background: var(--accent);
  color: #fff;
  text-decoration-style: solid;
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/styles/global.css
git commit -m "feat(ui): add clickable-path styles for file path links"
```

---

### Task 4: 扩展 `MarkdownContent` 支持路径检测和点击

**Files:**
- Modify: `ui/src/components/MarkdownContent.tsx`

**关键背景：**
- 当前 `MarkdownContent` 接受 `source` 和 `linkRel` 两个 props
- `createMarkdownComponents` 已有 `code` 覆盖：当 `className` 为空且内容匹配 `URL_RE` 时，将内容包裹为 `<a>` 链接
- 需要在 URL 检测之后、默认渲染之前，增加路径检测分支

- [ ] **Step 1: 添加路径检测正则**

在 `URL_RE` 定义之后添加：

```typescript
const ABS_UNIX_RE = /^\/(?:[\w.@-]+\/)*[\w.@-]+(?:\.\w+)?$/;
const ABS_WIN_RE = /^[A-Za-z]:\\(?:[\w.@-]+\\)*[\w.@-]+(?:\.\w+)?$/;
const TILDE_RE = /^~\/(?:[\w.@-]+\/)*[\w.@-]+(?:\.\w+)?$/;
const EXPLICIT_REL_RE = /^\.\.?\/(?:[\w.@-]+\/)*[\w.@-]+(?:\.\w+)?$/;

function isFilePath(text: string): boolean {
  return ABS_UNIX_RE.test(text) || ABS_WIN_RE.test(text) || TILDE_RE.test(text) || EXPLICIT_REL_RE.test(text);
}
```

- [ ] **Step 2: 修改组件签名，接受 `workspaceRoot` 和 `onOpenPath`**

将 `MarkdownContent` 组件签名和 `createMarkdownComponents` 改为：

```typescript
function createMarkdownComponents(
  linkRel: string,
  onOpenPath?: (path: string) => void,
): Components {
  return {
    a({ node: _node, ...props }) {
      return <a {...props} target="_blank" rel={linkRel} />;
    },
    code({ children, className, node: _node, ...props }) {
      if (!className) {
        const text = nodeToText(children).trim();
        if (URL_RE.test(text)) {
          return (
            <code {...props}>
              <a href={text} target="_blank" rel={linkRel}>
                {children}
              </a>
            </code>
          );
        }
        if (onOpenPath && isFilePath(text)) {
          return (
            <code
              {...props}
              className="clickable-path"
              title={text}
              role="button"
              tabIndex={0}
              onClick={() => onOpenPath(text)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onOpenPath(text);
              }}
            >
              {children}
            </code>
          );
        }
      }
      return <code className={className} {...props}>{children}</code>;
    },
    pre({ children, ...props }) {
      const source = extractMermaidSource(children);
      if (source !== null) {
        return <MermaidBlock code={source} />;
      }
      return <pre {...props}>{children}</pre>;
    },
  };
}

export function MarkdownContent({
  source,
  linkRel = "noopener noreferrer",
  onOpenPath,
}: {
  source: string;
  linkRel?: string;
  onOpenPath?: (path: string) => void;
}) {
  const components = useMemo(
    () => createMarkdownComponents(linkRel, onOpenPath),
    [linkRel, onOpenPath],
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {source}
    </ReactMarkdown>
  );
}
```

- [ ] **Step 3: 运行类型检查**

Run: `cd ui && npx tsc --noEmit`
Expected: 无新增错误（现有调用点传入 `onOpenPath` 是可选的，不影响）

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/MarkdownContent.tsx
git commit -m "feat(ui): add file path detection and click handler to MarkdownContent"
```

---

### Task 5: 串联 `ChatView` → `InteractionCard` → `MarkdownContent` 数据流

**Files:**
- Modify: `ui/src/components/InteractionCard.tsx`
- Modify: `ui/src/components/ChatView.tsx`

**关键背景：**
- `InteractionCard` 当前 props 是 `InteractionCardProps`（含 `index`, `agentEntry`, `userEntry`, `onQuote`, `isPinned`, `onTogglePin`, `isAcked`），无 `workspaceRoot`
- `MarkdownContent` 在 `InteractionCard` 中被调用 3 次（summary、question、feedback）
- `ChatView` 拥有 `session.workspaceRoot`
- 需要在 `ChatView` 中构建 `onOpenPath` 回调并传递到 `InteractionCard`

- [ ] **Step 1: 修改 `InteractionCard` 添加 `onOpenPath` prop**

在 `InteractionCardProps` 接口中添加：

```typescript
export interface InteractionCardProps {
  index: number;
  agentEntry: HistoryEntry;
  userEntry?: HistoryEntry;
  onQuote?: (ref: QuotedRef) => void;
  isPinned?: boolean;
  onTogglePin?: (index: number) => void;
  isAcked?: boolean;
  onOpenPath?: (path: string) => void;
}
```

在组件解构中提取 `onOpenPath`，并传递给三处 `MarkdownContent` 调用：

```typescript
<MarkdownContent source={agentEntry.summary} onOpenPath={onOpenPath} />
```

```typescript
<MarkdownContent source={agentEntry.question} onOpenPath={onOpenPath} />
```

```typescript
<MarkdownContent source={formatFeedbackMarkdown(userEntry.feedback ?? "")} onOpenPath={onOpenPath} />
```

- [ ] **Step 2: 在 `ChatView` 中创建 `handleOpenPath` 并传递**

在 `ChatView` 组件内部（其他 handler 附近）添加：

```typescript
  const handleOpenPath = useCallback(
    async (rawPath: string) => {
      try {
        const res = await fetch("/api/open-path", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            path: rawPath,
            workspaceRoot: session?.workspaceRoot,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.warn("[open-path] 失败:", data.error || res.statusText);
        }
      } catch (err) {
        console.warn("[open-path] 请求错误:", err);
      }
    },
    [session?.workspaceRoot, authToken],
  );
```

注意：需确认 `authToken` 在 `ChatView` 中的来源。检查 `ChatView` 的 props 或 context 中是否已有 `authToken`。如果没有，需要从调用方传入或从 context 获取。

在渲染 `InteractionCard` 时传入：

```typescript
<InteractionCard
  index={i}
  agentEntry={g.agent}
  userEntry={g.user}
  onQuote={(ref) => setQuotedRefs((prev) => [...prev, ref])}
  isPinned={pinnedSet.has(i)}
  onTogglePin={handleTogglePin}
  isAcked={acked}
  onOpenPath={handleOpenPath}
/>
```

- [ ] **Step 3: 确认 `authToken` 获取方式**

在实现前需确认 `ChatView` 如何获取 auth token。检查：
1. `ChatView` 的 props 中是否已有 `authToken`
2. 是否有全局 auth context
3. 其他组件（如 `useSessions` hook）如何获取 token

如果 `ChatView` 没有 `authToken`，最简方案是在 `ChatView` props 中添加 `authToken?: string`，从 `App.tsx` 传入。

- [ ] **Step 4: 运行类型检查**

Run: `cd ui && npx tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/InteractionCard.tsx ui/src/components/ChatView.tsx
git commit -m "feat(ui): wire onOpenPath from ChatView through InteractionCard to MarkdownContent"
```

---

### Task 6: 编写服务端测试

**Files:**
- Create: `server/open-path.test.ts`

- [ ] **Step 1: 编写测试**

```typescript
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const PORT = 19977;
const TOKEN = "test-token";
let serverProcess: ReturnType<typeof import("node:child_process").fork>;

function postOpenPath(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/api/open-path",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode!, data: JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("POST /api/open-path", () => {
  it("returns 400 when path is missing", async () => {
    const { status, data } = await postOpenPath({});
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it("returns 400 for empty path string", async () => {
    const { status, data } = await postOpenPath({ path: "  " });
    assert.equal(status, 400);
  });

  it("returns 404 for non-existent absolute path", async () => {
    const { status, data } = await postOpenPath({ path: "/non/existent/path/abc123" });
    assert.equal(status, 404);
    assert.ok(data.error);
  });

  it("returns 400 for relative path without workspaceRoot", async () => {
    const { status, data } = await postOpenPath({ path: "./some/file.ts" });
    assert.equal(status, 400);
    assert.ok(data.error?.includes("workspaceRoot"));
  });

  it("returns 200 for existing directory", async () => {
    const { status, data } = await postOpenPath({ path: "/tmp" });
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.type, "directory");
    assert.equal(data.resolvedPath, "/tmp");
  });

  it("returns 401 without auth token", async () => {
    const { status } = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const payload = JSON.stringify({ path: "/tmp" });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: PORT,
          path: "/api/open-path",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(status, 401);
  });
});
```

注意：此测试需要一个运行中的 server 实例。在运行前需要先启动 server（`PORT=19977 AUTH_TOKEN=test-token node server/dist/index.js`），或参考现有测试的启动模式（检查 `server/requestId-dedup.test.ts` 等已有测试的 server 启动方式）。

- [ ] **Step 2: 运行测试**

Run: 参考已有测试的启动方式运行
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add server/open-path.test.ts
git commit -m "test(server): add tests for POST /api/open-path endpoint"
```

---

### Task 7: 编写 UI 路径检测测试

**Files:**
- Create: `ui/tests/MarkdownContent-path.test.tsx`

- [ ] **Step 1: 编写测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownContent } from "../src/components/MarkdownContent";

describe("MarkdownContent 路径检测", () => {
  it("将绝对 Unix 路径渲染为可点击元素", () => {
    const onOpenPath = vi.fn();
    render(
      <MarkdownContent
        source="修改了 `/Users/leoli/workspace/super-ask/cli/super-ask.js`"
        onOpenPath={onOpenPath}
      />,
    );
    const pathEl = screen.getByText("/Users/leoli/workspace/super-ask/cli/super-ask.js");
    expect(pathEl).toHaveClass("clickable-path");
    fireEvent.click(pathEl);
    expect(onOpenPath).toHaveBeenCalledWith("/Users/leoli/workspace/super-ask/cli/super-ask.js");
  });

  it("将 ~ 路径渲染为可点击元素", () => {
    const onOpenPath = vi.fn();
    render(
      <MarkdownContent source="查看 `~/Documents/project/file.txt`" onOpenPath={onOpenPath} />,
    );
    const pathEl = screen.getByText("~/Documents/project/file.txt");
    expect(pathEl).toHaveClass("clickable-path");
  });

  it("将 ./ 相对路径渲染为可点击元素", () => {
    const onOpenPath = vi.fn();
    render(
      <MarkdownContent source="修改了 `./src/App.tsx`" onOpenPath={onOpenPath} />,
    );
    const pathEl = screen.getByText("./src/App.tsx");
    expect(pathEl).toHaveClass("clickable-path");
  });

  it("将 ../ 相对路径渲染为可点击元素", () => {
    const onOpenPath = vi.fn();
    render(
      <MarkdownContent source="参考 `../parent/file.txt`" onOpenPath={onOpenPath} />,
    );
    const pathEl = screen.getByText("../parent/file.txt");
    expect(pathEl).toHaveClass("clickable-path");
  });

  it("不将普通代码渲染为可点击路径", () => {
    const onOpenPath = vi.fn();
    render(
      <MarkdownContent source="执行 `npm install`" onOpenPath={onOpenPath} />,
    );
    const el = screen.getByText("npm install");
    expect(el).not.toHaveClass("clickable-path");
  });

  it("URL 仍然渲染为链接而非路径", () => {
    const onOpenPath = vi.fn();
    render(
      <MarkdownContent
        source="访问 `http://localhost:3000/api`"
        onOpenPath={onOpenPath}
      />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "http://localhost:3000/api");
  });

  it("不传 onOpenPath 时路径不可点击", () => {
    render(
      <MarkdownContent source="修改了 `/Users/leoli/file.ts`" />,
    );
    const el = screen.getByText("/Users/leoli/file.ts");
    expect(el).not.toHaveClass("clickable-path");
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `cd ui && npx vitest run tests/MarkdownContent-path.test.tsx`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add ui/tests/MarkdownContent-path.test.tsx
git commit -m "test(ui): add MarkdownContent file path detection tests"
```

---

### Task 8: 最终集成验证

- [ ] **Step 1: 运行全量类型检查**

Run: `cd server && npx tsc --noEmit`
Run: `cd ui && npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 2: 运行 UI 构建**

Run: `cd ui && npx vite build`
Expected: 构建成功（注意：Node.js 17 环境可能有已知的 `node:fs/promises` 问题，不影响功能正确性）

- [ ] **Step 3: 手动验证**

启动 server 和 UI，在消息中检查：
1. 绝对路径（如 `/Users/leoli/workspace/super-ask/cli/super-ask.js`）显示为带下划线的可点击样式
2. 点击后 Finder 打开并高亮对应文件
3. 目录路径（如 `/Users/leoli/workspace/super-ask/`）点击后 Finder 打开目录
4. `~/` 路径正常解析和打开
5. `./` 路径在有 workspaceRoot 时正常解析
6. URL 仍然正常渲染为链接（不受影响）
7. 普通代码块内容（如 `npm install`）不被误识别

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: file path click to open in system file manager"
```

---

## 后续扩展（当前不实施）

| 阶段 | 内容 | 说明 |
|------|------|------|
| P2 | 隐式相对路径 `src/components/App.tsx` | 需服务端 `fs.stat` 存在性验证，有延迟和误判风险 |
| P3 | 非 code 块中的路径检测 | 正则全文扫描，误判风险大，暂不考虑 |
| P4 | Windows 绝对路径 `C:\Users\...` | 正则已就绪，但暂无 Windows 测试环境 |
