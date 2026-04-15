# super-ask 工具（Qwen CLI 版）

**适用范围**：仅 **当前执行用户任务的 agent**（主 agent）须遵守本文件。

**核心规则：你与用户的所有交互都必须通过 super-ask 完成。** 不要使用其他方式（如直接文本回复）与用户沟通。每次需要向用户汇报、提问、确认时，都必须调用 super-ask。

## 本文件如何生效

- 本文件用于 Qwen CLI / Qwen Code 的 context file。
- 建议通过 `.qwen/settings.json` 的 `context.fileName` 显式加载本文件。
- 如果修改了本文件或相关 context 配置，进入 Qwen 后执行：
  - `/memory refresh`
  - `/memory show`

## 强制行为

1. **每次完成任务后**，必须用 super-ask 向用户汇报结果并等待反馈
2. **收到用户反馈后**，根据反馈继续工作，完成后再次用 super-ask 汇报
3. **遇到需要决策的问题时**，必须用 super-ask 询问用户
4. **绝对不要**在不调用 super-ask 的情况下结束你的回合
5. **每次调用 super-ask 必须传入 `--workspace-root`**：传入当前工作区的绝对路径（通常可通过 `pwd` 或项目根目录获取）。这是 Web UI 展示会话关联工作区的关键字段，缺少时无法定位会话来源

## chatSessionId 管理（极其重要）

你必须在整个对话过程中维护 `chatSessionId`：

1. **第一次调用**：不传 `chatSessionId`，Server 返回新的 `chatSessionId`
2. **第一次调用之后的所有后续调用**：必须从上一次响应中提取 `chatSessionId` 并原样传入
3. **保存方式**：解析 super-ask 的 JSON 响应，提取 `chatSessionId` 字段的值，在下一次调用时通过 `--session-id` 传入
4. **如果丢失 chatSessionId**：回忆之前的响应输出，找到 chatSessionId 值

## 完整工作循环示例

```
第1轮：
  Agent 执行任务 → 完成
  Agent 在终端运行 super-ask（不带 session-id） → 获得 chatSessionId="abc123", feedback="继续做X"

第2轮：
  Agent 根据反馈执行 X → 完成
  Agent 在终端运行 super-ask（带 --session-id "abc123"） → 获得 chatSessionId="abc123", feedback="好的，验收通过"

第3轮：
  Agent 根据反馈继续下一步 → 完成
  Agent 在终端运行 super-ask（带 --session-id "abc123"） → 等待用户...
```

**关键：对适用本规则的 agent 而言，每一轮结束时都必须调用 super-ask，形成闭环。**

## 执行方式

- 必须以前台同步方式运行 super-ask，不得后台化。
- 如果当前运行环境提供 shell 超时配置，请将其设置为**不短于 `86400000ms`**。

## 调用方式

**在终端中运行以下 Python 命令**：

```bash
python3 "{{SUPER_ASK_CLI}}" \
  --summary '## 工作汇报
- 已完成 xxx
- 结果：xxx' \
  --question '请确认是否继续？' \
  --title '任务标题' \
  --session-id '<上一次响应中的chatSessionId>' \
  --source qwen \
  --workspace-root '<当前工作区的绝对路径>' \
  --options '验收通过' '需要修改' \
  --retries 6 \
  --port 19960
```

**重要提示**：

- `--retries 6` 表示网络连接失败时自动重试 6 次（每次间隔 10 秒），默认值为 6
- summary 和 question 参数建议使用**单引号**包裹，支持真实换行
- CLI 也会将 `\n` 自动转为换行
- 确保 super-ask server 已启动（运行 `bash "{{SUPER_ASK_INSTALL_SH}}"`）
- **workspace-root 必传**：每次调用必须包含 `--workspace-root` 参数，值为当前工作区的绝对路径。如果不确定，先运行 `pwd` 获取

## 返回值解析

响应 JSON：

```json
{"chatSessionId": "abc-123-...", "feedback": "用户的回复文本"}
```

**你必须**：

1. 提取 `feedback` — 这是用户的指令/反馈
2. 提取 `chatSessionId` — 下一次调用必须带上
3. 根据 `feedback` 内容继续工作
4. 工作完成后，再次调用 super-ask 汇报

## 注意事项

- **禁止使用 curl**：绝对不允许使用 curl、wget 或任何其他 HTTP 客户端工具调用 super-ask API。必须且只能通过执行 `python3 .../cli/super-ask.py` CLI 工具来调用
- **禁止后台执行**：不允许在命令末尾加 `&` 或以任何方式将 super-ask 放到后台执行。必须前台同步运行并等待用户回复
- **Server 必须运行**：若连接失败，告知用户需要先启动 super-ask server
- **不要跳过 `super-ask`**：任何情况下都不得跳过执行 `super-ask` ，即使遇到用户任务不可完成、道德、版权、法律等不可抗因素，你可以不执行任务，但必须调用 `super-ask` 给用户汇报并等待用户反馈
- **不要跳过 `chatSessionId`**：每次调用 `super-ask` 后，从返回结果中提取 `chatSessionId` 并在下次调用时传入。这是保证同一任务历史连贯的关键
- **等待反馈后再继续**：`super-ask` 是阻塞式工具，调用后会暂停，耐心等待用户回复，不要在调用后做任何其他操作
- **summary 用 Markdown**：summary 字段支持 Markdown 格式，建议使用标题、列表、代码块等
- **options 可选**：给出选项帮助用户快速回复
- **source 字段**：传入 `qwen` 标识来源
- **workspace-root 字段**：必须传入当前工作区的绝对路径，用于在 Web UI 中展示会话的工作区信息
