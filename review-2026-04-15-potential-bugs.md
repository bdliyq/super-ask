# 潜在 Bug 扫描报告

日期：2026-04-15

## 扫描范围

本次扫描优先覆盖当前活跃改动及其调用链，未修改任何业务代码。

- 后端：`server/src/wsHub.ts`、`server/src/sessionManager.ts`、`server/wsHub.reply-result.test.ts`
- 共享类型：`shared/types.ts`
- 前端：`ui/src/App.tsx`、`ui/src/hooks/useWebSocket.ts`、`ui/src/hooks/useSessions.ts`、`ui/src/components/ReplyBox.tsx`、`ui/src/components/ChatView.tsx`、`ui/src/components/InteractionCard.tsx`、`ui/src/components/SessionMetaBadges.tsx`
- 测试与构建：`ui/tests/SessionMetaBadges.test.tsx`

## 结论摘要

- 高风险：2 项
- 中风险：3 项
- 低风险/待确认：1 项
- 最值得优先修复的是：
  - `ReplyBox` 在附件全部上传失败时仍可能发送空回复
  - `--no-wait` + `--poll` 链路里，旧回复会被下一次提问覆盖

## 具体问题

### 1. [高] 附件全部上传失败时，仍可能发送空回复

- 位置：`ui/src/components/ReplyBox.tsx`
- 证据：
  - `submit()` 开头只拦截“初始时既没有文本也没有附件”的情况。
  - 上传循环结束后，无论 `failMsgs` / `uploaded` 结果如何，都会继续执行 `onSend(fullText, uploaded.length > 0 ? uploaded : undefined)`。
  - 当用户“只选附件、不输入正文”，且附件全部上传失败时，`trimmed === ""` 且 `uploaded.length === 0`，最终仍会发送空字符串。
- 风险：
  - 用户会看到上传失败提示，但服务端仍可能把这次提交当成有效回复处理。
  - 会话状态可能被推进到 `replied`，导致真正待回复的问题被提前关闭。
- 修复建议：
  - 在上传循环后增加二次 guard：如果 `trimmed === "" && uploaded.length === 0`，直接返回，不调用 `onSend`。
  - 保留失败附件列表，允许用户重试，不要清空当前草稿状态。
  - 如果允许“部分成功部分失败仍发送”，也建议把规则明确显示在 UI 上。
- 建议补测：
  - “只有附件、无正文、全部上传失败”。
  - “部分附件失败、部分成功”的发送语义。

### 2. [高] `--no-wait` / `/api/poll` 模式下，未轮询的回复会被下一次提问覆盖

- 位置：`server/src/sessionManager.ts`
- 证据：
  - `handleReply()` 在没有 pending HTTP 请求时，会把用户回复写入 `pollReplies`。
  - `handleNoWaitRequest()` 在新请求开始前会无条件执行 `this.pollReplies.delete(chatSessionId)`。
  - 我额外跑了一个一次性脚本做运行时验证：同一会话先 `handleReply()` 产生可轮询回复，再次调用 `handleNoWaitRequest()` 后，`pollReply()` 返回值从 `replied` 变成了 `pending`，之前的回复被覆盖掉。
- 风险：
  - 使用 `--no-wait` + `--poll` 的客户端可能永久丢失用户上一轮反馈。
  - 这不是纯展示问题，而是实际数据丢失。
- 修复建议：
  - 不要在新请求开始前直接清空 `pollReplies`。
  - 可选方案：
    - 保留旧回复直到客户端显式 poll 消费；
    - 如果存在“未消费回复”，拒绝同会话新请求；
    - 给 `pollReplies` 增加 request id / version，避免不同轮次互相覆盖。
- 建议补测：
  - `noWait -> reply -> new noWait -> poll` 的回归测试。
  - 同一会话多轮 noWait 的版本覆盖测试。

### 3. [中] 删除当前会话后，UI 不会自动切到剩余会话

- 位置：`ui/src/hooks/useSessions.ts`
- 证据：
  - `session_deleted` 分支里，如果删除的是当前选中会话，`activeSessionId` 被直接设为 `null`。
  - 但 `sync` 分支在类似场景下会回退到最近活跃的会话，两个路径行为不一致。
- 风险：
  - 用户删除当前会话后，即使还有别的会话存在，主面板也会进入空状态。
  - 键盘切换和“继续处理最近会话”的操作链会被打断。
- 修复建议：
  - 删除当前会话后，自动选择剩余会话中 `lastActiveAt` 最大的一条。
  - 同时检查是否需要顺手清理该会话在本地的队列缓存。
- 建议补测：
  - “有多个会话时删除当前会话”的选中态回退。
  - “删除最后一个会话”仍应进入空态。

### 4. [中] Pin 索引的语义在前后端不一致

- 位置：
  - `ui/src/components/ChatView.tsx`
  - `ui/src/components/InteractionCard.tsx`
  - `server/src/sessionManager.ts`
  - `shared/types.ts`
- 证据：
  - 前端在 `groupInteractions(session.history)` 之后，把“交互组下标”传给 `InteractionCard`、`handleTogglePin()`、`scrollToCard()`。
  - 服务端 `pinMessage()` / `unpinMessage()` 的校验和存储语义是“`session.history` 的 index”。
  - `shared/types.ts` 里 `pinnedIndices` 的注释也明确写的是“history 中的 index”。
- 风险：
  - 当前 UI 因为也按组下标去消费 `pinnedIndices`，所以问题被部分掩盖，但协议语义已经不一致。
  - 一旦有别的客户端、持久化分析逻辑、导出功能或未来新组件按“history index”理解该字段，就会引用到错误条目。
- 修复建议：
  - 在 `groupInteractions()` 阶段把真实 `historyIndex` 一起保留下来。
  - Pin/Unpin、Pin 列表、滚动定位统一使用真实 `historyIndex`。
  - 如果产品上只想 pin“交互组”，那就应该把共享类型和服务端接口一并改成“组索引”，不要继续声明成 `history` 索引。
- 建议补测：
  - 至少覆盖“两轮以上 agent/user 交互后 pin 第二轮”的场景。
  - 校验 `pinnedIndices` 持久化后的语义与 UI 展示一致。

### 5. [中] WebSocket `reply` 校验失败时，客户端只能等超时，拿不到明确错误

- 位置：
  - `server/src/wsHub.ts`
  - `ui/src/hooks/useWebSocket.ts`
- 证据：
  - `wsHub.onClientMessage()` 在 JSON 解析失败、`type` 缺失、`chatSessionId` 不合法等场景下直接 `return`，不会回任何错误帧。
  - 前端 `sendReply()` 只会在收到 `reply_result` 时 resolve；否则 5 秒后统一报 `timeout`。
- 风险：
  - UI 侧只能看到“确认超时”，无法分辨是 payload 非法、服务端拒绝还是链路异常。
  - 第三方客户端更难排查问题，协议也缺少明确失败语义。
- 修复建议：
  - 对“可识别为 reply 但字段非法”的请求，仍返回 `reply_result`，例如 `accepted: false, code: "invalid_payload"`。
  - 或新增统一错误消息类型，再在前端映射到更准确的文案。
  - 同步扩展 `WsReplyResult.code` 联合类型与 UI 错误提示。
- 建议补测：
  - 缺失 `chatSessionId`
  - `chatSessionId` 类型错误
  - `feedback` 非字符串

### 6. [低 / 待确认] 快捷选项发送路径不会带上引用块，也不会在成功后清理引用/附件状态

- 位置：`ui/src/components/ReplyBox.tsx`
- 证据：
  - `submit()` 会拼装 `quotedRefs`、清理附件、清空文本和引用。
  - `pickOption()` 只执行 `await onSend(opt)`，没有复用 `submit()` 的拼装和清理逻辑。
- 风险：
  - 用户如果先引用内容、再点击快捷选项，实际发出去的文本不包含引用块，但界面上引用状态还留着。
  - 如果当时已选附件，快捷选项也不会带上附件。
- 修复建议：
  - 如果产品希望“快捷选项也是一种正式发送”，应复用 `submit()` 的正文组装与清理逻辑。
  - 如果产品明确不希望快捷选项携带引用/附件，则建议在 UI 上禁用该组合，或明确提示其行为。

## 测试与验证

已执行：

- `server` TypeScript 检查：通过
- `ui` TypeScript 检查：通过
- `shared` TypeScript 检查：通过
- `ui` 生产构建：通过
- `server/wsHub.reply-result.test.ts`：通过
- `ui/tests/SessionMetaBadges.test.tsx`：在显式指定 `ui/tsconfig.json` 的情况下通过

当前主要缺口：

- 没有覆盖 `ReplyBox` 上传失败分支的自动化测试
- 没有覆盖 `session_deleted` 后选中态回退的测试
- 没有覆盖 `pin` 索引语义的一致性测试
- 没有覆盖 `noWait + poll` 数据不丢失的回归测试

## 建议修复顺序

1. 先修 `ReplyBox` 空回复问题
2. 再修 `noWait + poll` 的回复覆盖问题
3. 然后统一 pin 索引语义
4. 最后补 UI 状态与协议错误码相关测试
