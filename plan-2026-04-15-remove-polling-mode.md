# 移除轮询模式方案

日期：2026-04-15

## 目标

删除 `--no-wait` / `--poll` 这套轮询能力，只保留单次阻塞式 `super-ask` 调用链。

目标效果：

- CLI 只保留“一次提交、阻塞等待用户回复”的使用方式
- 服务端不再维护 `pollReplies` 这类轮询专用状态
- 文档、规则、部署模板、测试全部与阻塞模式保持一致
- 对旧调用方式给出明确失败，而不是静默兼容或行为不确定

## 证据基础

这份方案基于以下已确认事实，不是猜测：

- `server/src/server.ts` 当前会根据 `noWait` 分流到 `handleNoWaitRequest()`，并暴露 `GET /api/poll`
- `server/src/sessionManager.ts` 当前通过 `pollReplies` 保存“无 pending HTTP 时的用户回复”
- `cli/super-ask.py` 当前暴露 `--no-wait`、`--poll`、`--poll-interval`、`--poll-timeout`
- `rules/super-ask-codex.md` 当前强制使用两步式轮询，和其他平台规则不一致
- `server/deployManager-path-render.test.ts` 当前断言 Codex 模板里必须出现 `--no-wait` / `--poll`
- 我额外做了一次性运行时验证：同一会话里，旧回复确实会被后续 `noWait` 请求覆盖掉；不过这份验证目前还不是仓库里的正式自动化测试

## 可选方案

### 方案 A：一次性硬删除轮询链路

做法：

- 直接删除服务端 `noWait` 分支、`/api/poll` 路由、`pollReplies` 状态
- 直接删除 CLI 所有轮询参数
- 直接更新规则、README、部署模板、测试

优点：

- 收敛最彻底，后续维护成本最低
- 不会留下“双协议长期并存”的歧义

缺点：

- 对旧脚本和已部署的 Codex `AGENTS.md` 是破坏性变更
- 用户如果没更新规则或脚本，会立刻失败

### 方案 B：实现层硬收敛，兼容层显式报错

做法：

- 服务端内部先删除 `pollReplies` / `handleNoWaitRequest()` 的真实能力
- 但短期保留 `POST /super-ask` 对 `noWait: true` 的显式拒绝
- 短期保留 `GET /api/poll`，统一返回 `410 Gone` 或明确 JSON 错误，提示“轮询模式已移除”
- CLI 同步删除轮询参数
- 文档、规则、测试全部切到阻塞模式

优点：

- 仍然只保留一套真实实现
- 对旧客户端的失败更可诊断，迁移成本更低

缺点：

- 服务端会短期保留一层“废弃入口”
- 代码比方案 A 多一层过渡逻辑

### 方案 C：只改 CLI/文档，服务端先不动

做法：

- 用户入口全部改成阻塞模式
- 服务端继续保留 `noWait` / `poll`

优点：

- 实施最快

缺点：

- 文档与实现不一致
- 轮询 bug 仍然存在
- 未来别人直接调 HTTP 时仍会走旧协议

不建议采用。

## 推荐方案

推荐 **方案 B**。

原因：

1. 它满足“只保留阻塞方案”的核心要求，因为真实业务链路已经只剩阻塞模式。
2. 它不会像方案 C 那样留下实现债务。
3. 它比方案 A 更适合当前仓库，因为 Codex 规则、部署模板和现有脚本入口都明确绑定了轮询模式，完全硬删除会让迁移期排障成本偏高。

如果你希望这次改动必须“当场彻底砍掉所有旧入口”，那就改走方案 A；否则建议先做方案 B，再在后续版本删掉废弃入口。

## 推荐修改计划

### 阶段 1：先收敛服务端真实实现

目标：

- 服务端内部只保留阻塞式请求-回复模型

涉及文件：

- `server/src/sessionManager.ts`
- `server/src/server.ts`
- `shared/types.ts`

具体动作：

1. 删除 `SessionManager` 中的 `pollReplies`
2. 删除 `handleNoWaitRequest()`
3. 删除 `pollReply()`
4. 修改 `handleReply()`：只允许把回复写回已有 `pending` HTTP 请求；不再有 “else -> 写入 pollReplies” 分支
5. 修改 `POST /super-ask`：不再分流到 `handleNoWaitRequest()`，统一走 `handleAskRequest()`
6. 处理旧请求体中的 `noWait`
   - 方案 B：显式返回错误，例如 `400` + 明确错误信息
   - 方案 A：直接忽略旧字段并删除相关代码入口，或返回 400
7. 处理旧 `/api/poll`
   - 方案 B：保留路由但返回废弃错误
   - 方案 A：直接删除路由
8. 统一 `AskRequest` 契约，不再让服务端从 `Record<string, unknown>` 偷读 `noWait`

关键注意点：

- `wsHub.reply_result` 不能跟着删，它解决的是 WebSocket 发送确认，不是轮询能力
- `pending` Map、`handleAskRequest()`、`ackReply()`、客户端断开 `499`、同会话 409 顶替逻辑都要保留
- 这里必须额外收紧一个不变量：删除轮询后，`handleReply()` 在 `!pending` 时必须先拒绝，不能继续写 history / 改 `requestStatus` / 广播，否则会出现“UI 已记录回复，但没有任何阻塞请求真正收到反馈”的半成功状态

### 阶段 2：收敛 CLI 和外部调用入口

目标：

- 用户再也看不到轮询参数，也无法继续走两步式流程

涉及文件：

- `cli/super-ask.py`
- `README.md`

具体动作：

1. 删除 CLI 参数：
   - `--no-wait`
   - `--poll`
   - `--poll-interval`
   - `--poll-timeout`
2. 删除 CLI 的 `/api/poll` 调用逻辑
3. 保留并强化阻塞路径：
   - 单次 POST `/super-ask`
   - 阻塞返回 `{ chatSessionId, feedback }`
   - 成功后继续调用 `/api/ack`
4. 更新 README 中英文参数表和示例
5. 明确写出“轮询模式已移除，只支持阻塞模式”

关键注意点：

- 现在 `README.md` 里的常规示例本身已经偏阻塞式，主要问题是参数表和 Codex 规则仍然保留旧入口
- 方案 B 里保留 `410` / 废弃错误的主要价值在“直接调 HTTP 的集成方”；如果 CLI 参数已经删除，旧 CLI 调用很多时候会先在本地参数层失败，不一定能走到服务端废弃响应

### 阶段 3：统一规则与部署模板

目标：

- 所有平台都只有一种调用心智模型

涉及文件：

- `rules/super-ask-codex.md`
- `rules/super-ask.md`
- `server/src/deployManager.ts`
- `server/deployManager-path-render.test.ts`

具体动作：

1. 重写 `rules/super-ask-codex.md`
   - 删除“必须两步调用”
   - 删除“不要使用阻塞模式”
   - 改成与 Cursor / Copilot / Qwen 相同的阻塞流程
2. 检查 `deployManager` 渲染模板是否仍然引用旧文案
3. 更新渲染结果测试，不再断言 `--no-wait` / `--poll`
4. 补充迁移说明：已部署旧 `AGENTS.md` 的用户需要重新部署规则

关键注意点：

- 如果只改源码不改规则，Codex 用户仍会继续按旧流程调用，等于把旧 bug 留在生产入口里
- `deployManager.ts` 本身主要是“读取并渲染规则文件”，真正强绑定轮询的是 `rules/super-ask-codex.md`；执行时要优先改规则源文件，不要只在 `deployManager.ts` 里搜字面量

### 阶段 4：替换和补齐测试

目标：

- 用阻塞模式的测试替掉轮询模式测试

涉及文件：

- `server/poll-protocol.test.mjs`
- `server/wsHub.reply-result.test.ts`
- 新增或修改 `server` 侧 `SessionManager` 测试
- `ui/tests/SessionMetaBadges.test.tsx`（只需回归跑，不一定要改）

具体动作：

1. 删除或改写 `server/poll-protocol.test.mjs`
   - 新目标不应再测试 `--poll`
   - 建议改成阻塞式 CLI / HTTP 集成测试
   - 新测试最好自己启动/关闭测试服务，避免继续依赖“本机已经有一个 19960 端口服务在运行”的隐式前提
2. 新增 `SessionManager` 阻塞路径测试，至少覆盖：
   - `handleAskRequest()` + `handleReply()` 正常闭环
   - 客户端断开 -> `499` + `cancelled`
   - 同一会话第二个阻塞请求顶替第一个 -> `409`
3. 保留 `server/wsHub.reply-result.test.ts`
4. 更新部署模板测试
5. 全量回归 TypeScript 检查、UI 构建、现有相关测试

## 最小验证清单

实现后至少要验证这些点：

1. `POST /super-ask` 在默认路径下仍能阻塞直到收到用户回复
2. 用户回复后，CLI 能拿到 `chatSessionId + feedback`
3. CLI 成功后仍会触发 `/api/ack`
4. 再传 `noWait: true` 时，不会悄悄走旧逻辑，而是得到明确错误
5. 再访问 `/api/poll` 时，不会返回旧语义数据
6. Codex 部署出的规则文本里不再出现 `--no-wait` / `--poll`
7. README 中英文都不再提轮询参数

## 风险与迁移提醒

### 1. 旧 Codex 规则会失效

当前 Codex 模板明确要求两步调用。改完后，如果用户不重新部署规则，旧 `AGENTS.md` 仍会指导错误用法。

### 2. 旧 CLI / 自动化脚本会失效

如果有人已经把 `--poll` 用在脚本里，改动后会直接失败。方案 B 的价值就在于让它“明确失败”，而不是“静默行为变化”。

### 3. 阻塞模式对执行环境要求更高

轮询模式原本把等待拆成多次短调用；阻塞模式要求调用端能稳定持有长时间前台进程。当前 Cursor / 通用规则已经是这么做的，但 Codex 侧要确认你是否接受这类行为统一。

## 建议执行顺序

1. 先改 `server/src/sessionManager.ts` 和 `server/src/server.ts`
2. 再改 `cli/super-ask.py`
3. 然后改 `rules/super-ask-codex.md`、`README.md`、部署模板测试
4. 最后补阻塞路径测试并做全量回归

## 我建议你先确认的唯一决策

只需要确认一件事：

- 你要 **方案 A（一次性硬删除旧入口）**
- 还是 **方案 B（真实实现删掉，但旧入口短期显式报错）**

如果你没有特别要求，我建议走 **方案 B**。
