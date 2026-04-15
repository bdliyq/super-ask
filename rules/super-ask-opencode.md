# super-ask 工具（OpenCode 强制使用）

**适用范围**：仅当前执行用户任务的主 agent。

**核心规则：你与用户的所有交互都必须通过 `super-ask` 自定义工具完成。** 不要直接输出文本向用户提问、确认或汇报；也不要自己用 `bash`、`curl`、`wget` 或手写 HTTP 请求去调用 super-ask API。

## 强制行为

1. 每次完成任务后，必须调用 `super-ask` 工具向用户汇报结果并等待反馈
2. 收到用户反馈后，根据反馈继续工作，完成后再次调用 `super-ask`
3. 遇到需要用户决策的问题时，必须调用 `super-ask`
4. 绝对不要在不调用 `super-ask` 的情况下结束当前回合
5. 每次调用都应传入 `workspaceRoot`；通常传当前工作区根路径

## chatSessionId 管理（极其重要）

你必须在整个对话过程中维护 `chatSessionId`：

1. 第一次调用：不要传 `chatSessionId`
2. 后续调用：必须复用上一次 `super-ask` 返回结果中的 `chatSessionId`
3. 如果丢失 `chatSessionId`，不得绕过 `super-ask` 直接回复；先从上一次响应或可用记录找回。若找不到，继续调用 `super-ask` 新建会话，并明确说明“本次已新建会话，原会话可能不连续”。

## 调用方式

使用 OpenCode 自定义工具 `super-ask`，参数示例：

```json
{
  "summary": "## 工作汇报\n- 已完成 xxx\n- 结果：xxx",
  "question": "请确认是否继续？",
  "title": "任务标题",
  "chatSessionId": "abc123",
  "workspaceRoot": "/path/to/workspace",
  "options": ["验收通过", "需要修改"]
}
```

## 返回值解析

`super-ask` 返回一段 JSON 字符串，格式如下：

```json
{"chatSessionId":"abc-123-...","feedback":"用户的回复文本"}
```

你必须：

1. 提取 `feedback`
2. 提取 `chatSessionId`
3. 根据 `feedback` 继续工作
4. 下一轮继续复用同一个 `chatSessionId`

## 注意事项

- `super-ask` 工具内部会自动使用 `source: "opencode"`
- `super-ask` 工具内部会自动读取本机 super-ask 配置和鉴权 token
- 若工具报错提示无法连接 super-ask server，先启动服务：`bash "{{SUPER_ASK_INSTALL_SH}}"`
- `summary` 建议使用 Markdown
- `options` 可选，适合提供快捷回复
