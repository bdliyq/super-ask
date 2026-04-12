# Super Ask 工具使用规则

## 工具说明

`super-ask`（工具引用名 `#superAsk`）是一个 Language Model Tool，用于在 AI 执行任务过程中向用户汇报进度并等待反馈。调用此工具后，AI 会暂停等待用户在 WebView 面板中提交反馈，然后在同一个 request 中继续工作。

## 使用场景

以下场景**必须**调用 `super-ask`：

1. **任务验收**：所有任务、子任务都需要用 `super-ask` 汇报给用户验收
2. **完成阶段性工作后**：每完成一个重要步骤（如创建文件、重构模块、修复 Bug），向用户汇报并请求下一步指示
3. **遇到多种方案时**：当有多种实现路径可选，用 `super-ask` 列出方案让用户决定
4. **需要澄清需求时**：对用户意图不确定时，用 `super-ask` 提出具体问题

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `title` | 是 | 任务简短标题，如"重构认证模块"。首次调用必填，后续可选 |
| `summary` | 是 | Markdown 格式的进度摘要，包含已完成的工作、关键改动、当前状态 |
| `question` | 是 | 向用户提出的具体问题，需要用户确认、选择或反馈的内容 |
| `chatSessionId` | 条件必填 | **首次调用时不传**。工具返回结果中会包含 `chatSessionId`，**后续所有调用必须带上这个值** |

## chatSessionId 规则（关键）

`chatSessionId` 用于将同一任务的多次 `super-ask` 调用归组到同一个 Tab 中。

- **首次调用**：不传 `chatSessionId`，工具会自动生成
- **工具返回值**：结果第一行格式为 `[chatSessionId=xxx]`，你**必须**从中提取该值
- **后续调用**：**必须**在参数中传入之前获得的 `chatSessionId`
- **不传的后果**：每次调用都会在 WebView 中创建新的 Tab，历史记录会分散，用户体验差

## 调用示例

### 首次调用（无 chatSessionId）

```json
{
  "title": "重构用户认证模块",
  "summary": "## 已完成\n- 将 `auth.js` 拆分为 `authService.ts` 和 `authMiddleware.ts`\n- 添加了 JWT token 验证逻辑\n\n## 待处理\n- 数据库迁移脚本尚未创建",
  "question": "以上重构方案是否可以继续？还是需要调整？"
}
```

工具返回：
```
[chatSessionId=a1b2c3d4-e5f6-7890-abcd-ef1234567890]

User feedback:
方案可以，继续吧
```

### 后续调用（带 chatSessionId）

```json
{
  "title": "重构用户认证模块",
  "chatSessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "summary": "## 进度更新\n- 数据库迁移脚本已创建\n- 所有测试通过\n\n## 准备提交\n共修改 5 个文件，新增 2 个文件",
  "question": "可以 git commit 了吗？"
}
```

## 注意事项

1. **不要跳过 `super-ask`**：任何情况下都不得跳过执行 `super-ask` ，即使遇到用户任务不可完成、道德、版权、法律等不可抗因素，你可以不执行任务，但必须调用 `super-ask` 给用户汇报并等待用户反馈
2. **不要跳过 `chatSessionId`**：每次调用 `super-ask` 后，从返回结果中提取 `chatSessionId` 并在下次调用时传入。这是保证同一任务历史连贯的关键
3. **等待反馈后再继续**：`super-ask` 是阻塞式工具，调用后会暂停，耐心等待用户回复，不要在调用后做任何其他操作
4. **summary 用 Markdown**：WebView 面板支持 Markdown 渲染，使用标题、列表、代码块让汇报更清晰
5. **question 要具体**：不要问模糊的问题如"继续吗"，而要问"以上 3 个文件的改动是否可以提交？"
6. **不要在 summary 中重复 question**：summary 汇报进度，question 提出具体问题，两者分工明确
7. **获取聊天框title**：每次调用 `super-ask` 时自动获取当前聊天框title并传递给 `super-ask` 工具
