# super-ask 工具（强制使用）

**适用范围**：仅 **当前执行用户任务的 agent**（主 agent）须遵守本文件。

**核心规则：你与用户的所有交互都必须通过 super-ask 完成。** 不要使用其他方式（如直接文本回复）与用户沟通。每次需要向用户汇报、提问、确认时，都必须调用 super-ask。

## 强制行为

1. **每次完成任务后**，必须用 super-ask 向用户汇报结果并等待反馈
2. **收到用户反馈后**，根据反馈继续工作，完成后再次用 super-ask 汇报
3. **遇到需要决策的问题时**，必须用 super-ask 询问用户
4. **绝对不要**在不调用 super-ask 的情况下结束你的回合
5. **每次调用 super-ask 必须传入 `--workspace-root`**：传入当前工作区的绝对路径（通常可通过 `pwd` 或项目根目录获取）。这是 Web UI 展示会话关联工作区的关键字段，缺少时无法定位会话来源
6. **必须使用两步调用方式**（--no-wait 提交 + --poll 轮询），不要使用阻塞模式

## chatSessionId 管理（极其重要）

你必须在整个对话过程中维护 `chatSessionId`：

1. **第一次调用**：不传 `chatSessionId`，Server 返回新的 `chatSessionId`
2. **第一次调用之后的所有后续调用**：必须从上一次响应中提取 `chatSessionId` 并原样传入
3. **保存方式**：解析 super-ask 的 JSON 响应，提取 `chatSessionId` 字段的值，在下一次调用时通过 `--session-id` 传入
4. **如果丢失 chatSessionId**：回忆之前的响应输出，找到 chatSessionId 值

## 调用方式（两步式）

super-ask 在 Codex 中必须分两步调用：先提交请求（--no-wait），再轮询等待回复（--poll）。

### 第一步：提交请求（立即返回）

```bash
python3 "{{SUPER_ASK_CLI}}" \
  --no-wait \
  --summary '## 工作汇报
- 已完成 xxx
- 结果：xxx' \
  --question '请确认是否继续？' \
  --title '任务标题' \
  --session-id '<上一次响应中的chatSessionId>' \
  --source codex \
  --workspace-root '<当前工作区的绝对路径>' \
  --options '验收通过' '需要修改' \
  --retries 6 \
  --port 19960
```

返回值示例：
```json
{"chatSessionId": "abc-123-...", "status": "pending"}
```

**提取 `chatSessionId` 备用。**

### 第二步：轮询等待回复

```bash
python3 "{{SUPER_ASK_CLI}}" \
  --poll \
  --session-id '<第一步返回的chatSessionId>' \
  --poll-interval 5 \
  --poll-timeout 86400 \
  --port 19960
```

返回值示例（用户已回复时）：
```json
{"chatSessionId": "abc-123-...", "status": "replied", "feedback": "用户的回复文本"}
```

返回值示例（会话不存在或已失效时）：
```json
{"chatSessionId": "abc-123-...", "status": "not_found"}
```

返回值示例（轮询主动超时时）：
```json
{"chatSessionId": "abc-123-...", "status": "timeout"}
```

## 完整工作循环示例

```
第1轮：
  Agent 执行任务 → 完成
  Agent 运行 super-ask --no-wait（不带 session-id）→ 获得 chatSessionId="abc123"
  Agent 运行 super-ask --poll --session-id "abc123" → 等待回复 → 获得 feedback="继续做X"

第2轮：
  Agent 根据反馈执行 X → 完成
  Agent 运行 super-ask --no-wait --session-id "abc123" → 确认提交
  Agent 运行 super-ask --poll --session-id "abc123" → 获得 feedback="好的，验收通过"

第3轮：
  Agent 根据反馈继续 → 完成
  Agent 运行 super-ask --no-wait --session-id "abc123" → 确认提交
  Agent 运行 super-ask --poll --session-id "abc123" → 等待用户回复...
```

**关键：每一轮都必须先 --no-wait 提交，再 --poll 轮询，形成闭环。**

## 返回值解析

### --no-wait 模式响应
```json
{"chatSessionId": "abc-123-...", "status": "pending"}
```
提取 `chatSessionId` 用于后续 --poll。

### --poll 模式响应
```json
{"chatSessionId": "abc-123-...", "status": "replied", "feedback": "用户的回复文本"}
```

其他可能状态：
```json
{"chatSessionId": "abc-123-...", "status": "not_found"}
{"chatSessionId": "abc-123-...", "status": "timeout"}
```

- `status = replied`：提取 `feedback` 继续工作
- `status = not_found`：说明该会话已失效，需要重新发起新的 `--no-wait`
- `status = timeout`：说明本次轮询主动结束，可以继续再次执行 `--poll`

**你必须**：
1. 提取 `feedback` — 这是用户的指令/反馈
2. 提取 `chatSessionId` — 下一次调用必须带上
3. 根据 `feedback` 内容继续工作
4. 工作完成后，再次调用 super-ask 汇报

## 重要提示

- **必须使用两步调用**：先 `--no-wait` 提交，再 `--poll` 轮询。不要使用不带 `--no-wait` 的阻塞模式
- `--poll-interval 5` 表示每 5 秒检查一次是否有回复
- `--poll-timeout 86400` 表示最多等待 24 小时；传 `0` 表示不超时
- `status = timeout` 时，CLI 会输出 JSON 并退出；你可以再次运行 `--poll` 继续等待
- `status = not_found` 时，CLI 会输出 JSON 并退出；说明旧会话已失效，应重新发起新的 `--no-wait`
- `status = not_found` 时，CLI 退出码为 `3`
- `status = timeout` 时，CLI 退出码为 `4`
- summary 和 question 参数建议使用**单引号**包裹，支持真实换行
- CLI 也会将 `\n` 自动转为换行
- 确保 super-ask server 已启动（运行 `bash "{{SUPER_ASK_INSTALL_SH}}"`）
- **workspace-root 必传**：每次调用必须包含 `--workspace-root` 参数

## 注意事项

- **Server 必须运行**：若连接失败，告知用户需要先启动 super-ask server
- **不要使用阻塞模式**：在 Codex 中只使用 --no-wait + --poll 两步调用
- **不要跳过 `super-ask`**：任何情况下都不得跳过执行 `super-ask`，即使遇到不可抗因素
- **不要跳过 `chatSessionId`**：每次调用后提取并在下次传入
- **summary 用 Markdown**：summary 字段支持 Markdown 格式
- **options 可选**：给出选项帮助用户快速回复
- **source 字段**：传入 `codex` 标识来源
- **workspace-root 字段**：必须传入当前工作区的绝对路径
