# super-ask 工具（Codex hook 驱动）

**适用范围**：仅 **当前执行用户任务的主 agent**。

## 核心规则

当 Super Ask 的 Codex hooks 集成已部署时，**用户反馈回路由 Codex hooks 自动驱动**。脚本会订阅全部 Codex hook 事件，但只有 `Stop` 事件会真正调用 super-ask；其他事件只记录日志，不做处理。

这意味着：

1. 你**不要**手动管理任何 super-ask 会话变量或 `chatSessionId`
2. 你**不要**在普通收尾时手动调用 `node .../cli/super-ask-codex.js`
3. 你在每轮工作结束前，必须把要给用户看的进展、结论、风险、待确认点，清楚地写在**最后一条 assistant 消息**里
4. Codex hooks 会把事件发给 super-ask CLI；其中 `Stop` hook 会读取这条最后消息，自动调用 `super-ask`，并把用户回复重新注入给你继续工作

## 你需要做什么

### 1. 把最后一条消息写成真正给用户看的汇报

你的最后一条 assistant 消息会被 `Stop` hook 当作本轮汇报摘要来源，所以它必须：

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

### 2. 如果你需要用户决定，就把问题直接写出来

`Stop` hook 会优先复用你最后消息里已经写出的提问语气。
不要只写“我停下了”或“Done”。

### 3. 不要自己维护 session

Codex hook 会直接使用 Codex 原生 `session_id` 作为 `chatSessionId`，这是本集成唯一可信来源。
你不需要也不应该再通过环境变量保存会话 ID。

## 禁止事项

- 不要手动导出任何 super-ask 会话环境变量
- 不要手动拼接 `--session-id`
- 不要把 `super-ask` 放到后台
- 不要在最终汇报里只写一句模糊的话，例如 “完成了” / “继续吗”

## 说明

- `workspace-root`、`source=codex`、`chatSessionId` 由 hook 自动传入
- 如果最后一条 assistant 消息为空或信息不足，hook 虽然仍可工作，但用户体验会明显变差
- Codex hook 的实际执行逻辑由 `cli/super-ask-codex.js` 独立承担；它不依赖 Cursor 脚本，也不要求与其他 hook 脚本共享实现
- Codex `Stop` hook 可能会结合 `transcript_path` 补充一小段 subagent 活动摘要，但主 agent 的最后一条 assistant 消息仍然是面向用户汇报的权威来源
- subagent 不应单独负责用户汇报；面向用户的总结应由主 agent 最终输出
