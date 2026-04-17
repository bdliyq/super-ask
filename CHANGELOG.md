# Changelog

## v1.1.5 (2026-04-17)

### Features

- **file drawer: richer preview & editing** — the document drawer now defaults to edit mode, supports undo/redo, inline Shiki-backed highlighting, copy-path feedback, fullscreen mode, and improved horizontal scrolling for wide content.
- **settings: shortcut help & predefined message editing** — settings now expose a dedicated hotkeys panel and let users edit predefined message entries in place.
- **deploy: Cursor stop hook support** — Cursor deployment now manages `hooks.json` stop hooks so the main agent is reminded to report via `super-ask` before finishing.

### Fixes

- **terminal: keep browser terminal state across drawer close/reopen** — `TerminalDrawerCore` no longer unmounts when the drawer is hidden, so the same session keeps its live xterm instance, visible history, and websocket connection instead of depending on scrollback replay to reconstruct the screen.
- **terminal: avoid broken xterm production bundle** — UI build output now ships with stronger safeguards against the `@xterm/xterm@6.0.0` `requestMode` minification bug that breaks `vim` and other TUI apps in browser terminals.
- **layout & metadata polish** — chat/session layout refinements, crash log capture on the server, and startup log rotation improve debugging and day-to-day operability.

### Docs

- **README: terminal notes refresh** — document the browser terminal behavior in both Chinese and English, including live session preservation across drawer toggles and safer bundled xterm output for interactive terminal apps.

## v1.1.3 (2026-04-16)

### Bug Fixes

- **rules: fix chatSessionId cross-session contamination** — 修复 AI agent 在多会话并行场景下错误使用其他 session 的 chatSessionId 的问题。删除所有 rules 文件中"从可用记录找回"的危险指令，新增 chatSessionId 唯一合法来源限制（只允许从 super-ask 直接输出中提取），丢失时直接新建会话而非搜索上下文。Cursor/Codex 平台增加 `export SUPER_ASK_SID` 环境变量备份机制。

### Features

- **session pinning** — 支持会话列表置顶（pin/unpin），置顶顺序跨端同步并持久化到 `pinned-sessions.json`
- **message pinning** — 支持对话内单条消息的 pin/unpin，便于标记关键信息
- **session tags** — 支持为会话添加/移除自定义标签
- **session grouping** — 会话侧栏按「今天 / 昨天 / 最近 7 天 / 更早」分组展示，支持折叠/展开与分页加载
- **file attachments** — 用户回复时支持附件上传（JSON+base64），服务端校验附件元数据安全性
- **markdown & mermaid rendering** — 新增 `MarkdownContent` 和 `MermaidBlock` 组件，摘要/问题/反馈/关于页均支持 Markdown 渲染与 Mermaid 图表
- **deploy: OpenCode & Qwen support** — 一键部署扩展至 OpenCode（`AGENTS.md` + `.opencode/tools/`）与 Qwen（`.qwen/settings.json`）平台
- **deploy: user scope** — 部署支持用户全局级别（`user`）与工作区级别（`workspace`）两种作用域
- **OpenCode native tool** — 新增 `super-ask-opencode-tool.ts`，OpenCode 可通过原生 plugin tool 调用 super-ask（无需 CLI）
- **CLI: retry & ack** — CLI 支持 `--retries` 参数（-1 无限重试）、成功后 best-effort 发送 ACK、结构化日志输出到 `~/.super-ask/logs/`
- **keyboard navigation** — 会话列表支持方向键/Home/End 键盘导航与 Delete 键删除
- **reply result feedback** — WebSocket 回复结果反馈（`reply_result`），支持 `clientRequestId` 关联

### Improvements

- **long connection stability** — 禁用 Node.js 默认的 requestTimeout/headersTimeout，HTTP 长连接增加周期性心跳写入防止超时断开
- **atomic session persistence** — 每个会话独立文件持久化（`sessions/` 目录），原子写入（tmp + rename），兼容旧 `sessions.json` 格式自动迁移
- **deploy panel i18n** — 部署步骤中文名到英文映射表扩展，覆盖所有平台与作用域
- **WebSocket sync** — 全量同步增加 `pinnedSessionIds`，新增 `pin_update` / `pinned_session_order_update` / `tag_update` 消息类型
- **about page refresh** — 中英文关于页内容更新
- **favicon & apple-touch-icon** — 更新网站图标
- **rules: retries default** — 所有平台 rules 的 `--retries` 默认值从 6 改为 -1（无限重试）
