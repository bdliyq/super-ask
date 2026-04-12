# Super Ask - VSCode Extension

[中文](#中文) | [English](#english)

---

## English

A Language Model Tool that enables AI to report progress and collect user feedback during task execution. Supports multi-round feedback loops within a single Agent Mode request.

### How It Works

1. User assigns a task to AI in VSCode Chat (Agent Mode)
2. AI calls the `super-ask` tool at key checkpoints during execution
3. A WebView panel opens, showing AI's progress report and question
4. User enters feedback and submits
5. AI continues working within the same request, calls again at the next checkpoint
6. The loop repeats until the user confirms completion

### Prerequisites

- VSCode >= 1.93.0
- GitHub Copilot (Agent Mode required). Other agents have not been tested
- Node.js >= 18

### Installation

**Option A: VSIX package**

```bash
cd vscode
bash build.sh
code --install-extension super-ask-vscode-<version>.vsix
```

**Option B: Debug mode**

1. Open the `vscode/` directory in VSCode
2. Press F5 to launch Extension Development Host
3. Use the extension in the new window

### Usage

Switch to Agent Mode in VSCode Chat and instruct the AI to use `#superAsk`:

```
Refactor the auth module, use #superAsk to check with me after each step
```

The AI will automatically call super-ask at key checkpoints, and the WebView panel will appear on the right side.

### WebView Panel

- **Tab bar**: Each concurrent task gets its own tab; a blue dot indicates a pending request
- **Progress report**: AI's markdown-formatted progress summary
- **Question**: The specific question AI needs you to answer
- **History**: Each tab keeps full interaction history (request time + feedback time)
- **Quick buttons**: "Confirm & Continue", "Confirm & Commit", "Needs Changes"
- **Shortcut**: Ctrl+Enter (Mac: Cmd+Enter) to submit

### Configure AI Rules (Recommended)

The extension ships with a rules file at `rules/super-ask.md` (inside the extension's install directory or this repo's `vscode/rules/` folder). To guide the AI on when and how to use super-ask:

1. Open your project in VSCode
2. Create the file `.vscode/rules/super-ask.md` (or `.cursor/rules/super-ask.md`) in your project root
3. Copy the contents of `rules/super-ask.md` into it

The rules file defines:

- When to call super-ask (before commits, after completing phases, etc.)
- Parameter usage (title, summary, question, chatSessionId)
- chatSessionId lifecycle rules

### Multi-session Isolation

The extension supports concurrent super-ask requests from multiple chats:

- **invocationId**: Unique per call, ensures feedback routes to the correct Promise
- **chatSessionId**: Shared within a chat, groups multiple calls into one tab
- Calls within the same chat are sequential; calls across chats can be parallel
- Multiple VSCode windows are naturally isolated (separate processes)

### Project Structure

```
vscode/
  package.json          # Extension manifest + Language Model Tool registration
  tsconfig.json         # TypeScript config
  esbuild.js            # Build script
  build.sh              # One-click build & package
  rules/
    super-ask.md        # AI rules file (copy to your project)
  src/
    extension.ts        # Entry: register tool + Output Channel
    tools/
      superAskTool.ts   # Tool implementation: dual-ID routing + invoke/prepareInvocation
    webview/
      PanelManager.ts   # WebView panel + message bridge + multi-tab routing + history
  .vscode/
    launch.json         # F5 debug config
    tasks.json          # Watch build task
```

### Known Limitations

- Only tested with VSCode + GitHub Copilot Agent Mode. Other agents have not been tested
- Not compatible with Cursor (Cursor does not implement `vscode.lm` API)
- chatSessionId relies on AI passing it back; it may occasionally be lost (degrades to creating a new tab)
- VSCode 1.109.0 has a `registerTool` bug; recommend using 1.108.x or waiting for a fix

---

## 中文

一个 Language Model Tool，让 AI 在任务执行过程中向用户汇报进度并获取反馈。支持在 Agent Mode 的同一个 request 中实现多轮反馈循环。

### 工作原理

1. 用户在 VSCode Chat 中安排 AI 任务（Agent Mode）
2. AI 执行任务过程中，在关键节点调用 `super-ask` 工具
3. WebView 面板弹出，展示 AI 的进度汇报和问题
4. 用户在面板中输入反馈并提交
5. AI 在同一 request 中继续工作，到下一个节点再次调用
6. 循环往复，直到用户确认完成

### 前置条件

- VSCode >= 1.93.0
- GitHub Copilot（需要 Agent Mode 支持），其他 agent 未做测试
- Node.js >= 18

### 安装

**方式一：VSIX 打包安装**

```bash
cd vscode
bash build.sh
code --install-extension super-ask-vscode-<version>.vsix
```

**方式二：调试模式运行**

1. 用 VSCode 打开 `vscode/` 目录
2. 按 F5 启动 Extension Development Host
3. 在新窗口中使用

### 使用方法

在 VSCode Chat 中切换到 Agent Mode，让 AI 工作时使用 `#superAsk` 工具：

```
帮我重构 auth 模块，每完成一步使用 #superAsk 让我确认
```

AI 会在关键节点自动调用 super-ask，WebView 面板会在右侧弹出。

### WebView 面板操作

- **Tab 栏**：多个并行任务各自一个 Tab，蓝色圆点表示有待反馈请求
- **进度汇报**：AI 的 markdown 格式进度报告
- **问题区域**：AI 需要你确认或决定的具体问题
- **历史记录**：每个 Tab 保留完整的交互历史（请求时间 + 反馈时间）
- **快捷按钮**：「Confirm & Continue」「Confirm & Commit」「Needs Changes」
- **快捷提交**：Ctrl+Enter（Mac: Cmd+Enter）提交反馈

### 配置 AI Rules（推荐）

插件自带 rules 文件，位于 `rules/super-ask.md`（插件安装目录或本仓库的 `vscode/rules/` 下）。配置步骤：

1. 在 VSCode 中打开你的项目
2. 在项目根目录创建 `.vscode/rules/super-ask.md`（或 `.cursor/rules/super-ask.md`）
3. 将 `rules/super-ask.md` 的内容复制进去

该 rules 文件定义了：

- 何时必须调用 super-ask（提交前、阶段性完成后等）
- 参数用法（title、summary、question、chatSessionId）
- chatSessionId 回传规则

### 多会话隔离

插件支持同时处理多个 chat 的 super-ask 请求：

- **invocationId**：每次调用的唯一 ID，保证反馈精确路由到对应 Promise
- **chatSessionId**：同一 chat 共享的 ID，保证多次调用归到同一 Tab
- 同一 chat 内的调用是串行的，跨 chat 的调用可以并行
- 多个 VSCode 窗口之间天然隔离（独立进程）

### 项目结构

```
vscode/
  package.json          # 插件清单 + Language Model Tool 注册
  tsconfig.json         # TypeScript 配置
  esbuild.js            # 构建脚本
  build.sh              # 一键编译部署
  rules/
    super-ask.md        # AI rules 文件（复制到你的项目中）
  src/
    extension.ts        # 入口：注册 tool + Output Channel
    tools/
      superAskTool.ts   # Tool 实现：双 ID 路由 + invoke/prepareInvocation
    webview/
      PanelManager.ts   # WebView 面板 + 消息桥接 + 多 Tab 路由 + 历史记录
  .vscode/
    launch.json         # F5 调试配置
    tasks.json          # Watch 构建任务
```

### 已知限制

- 仅测试了 VSCode + GitHub Copilot Agent Mode，其他 agent 未做测试
- 不支持 Cursor（Cursor 未实现 `vscode.lm` API）
- chatSessionId 依赖 AI 回传，偶尔可能丢失（降级为创建新 Tab）
- VSCode 1.109.0 存在 `registerTool` bug，建议使用 1.108.x 或等待修复
