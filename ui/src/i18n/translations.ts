export type Locale = "zh" | "en";

export interface Translations {
  // 通用
  unnamed: string;
  confirm: string;
  cancel: string;
  save: string;
  back: string;
  copy: string;

  // 会话面板
  sessions: string;
  sessionList: string;
  sessionsHint: string;
  noSessions: string;
  pendingReply: string;
  deleteSession: string;
  tooltipTitle: string;
  tooltipSource: string;
  tooltipWorkspace: string;
  tooltipStatus: string;
  tooltipSessionId: string;
  tooltipLastActive: string;
  sessionGroupToday: string;
  sessionGroupYesterday: string;
  sessionGroupRecent7: string;
  sessionGroupOlder: string;
  sessionGroupExpand: string;
  sessionGroupCollapse: string;
  sessionGroupShowMore: string;
  sessionGroupShowLess: string;
  toggleSidebar: string;

  // 会话来源
  sourceUnknown: string;

  // 请求状态
  statusPending: string;
  statusReplied: string;
  statusCancelled: string;
  statusAcked: string;
  statusAwaiting: string;

  // 聊天视图
  unnamedSession: string;
  selectSessionHint: string;
  question: string;
  yourFeedback: string;
  asked: string;
  replied: string;

  // 回复框
  replyPlaceholder: string;
  noRequestPlaceholder: string;
  send: string;
  addAttachment: string;
  fileTooLarge: string;
  imageFormatError: string;
  uploadFailed: string;
  replyRequestExpired: string;
  replySocketUnavailable: string;
  replyConfirmTimeout: string;

  // 斜杠命令
  slashHint: string;
  cmdConfirm: string;
  cmdConfirmDesc: string;
  cmdContinue: string;
  cmdContinueDesc: string;
  cmdReject: string;
  cmdRejectDesc: string;
  cmdCommit: string;
  cmdCommitDesc: string;

  // 状态栏
  connected: string;
  disconnected: string;
  activeSessions: string;
  pending: string;

  // 全局页眉
  appTitle: string;

  // 配置面板
  settings: string;
  deployManagement: string;
  systemSettings: string;
  about: string;
  hotKeys: string;
  shortcutTerminalToggle: string;
  shortcutSessionListToggle: string;
  shortcutDocsToggle: string;
  shortcutSendReply: string;
  aboutLoading: string;
  aboutLoadFailed: string;
  aboutEmpty: string;
  language: string;
  languageDesc: string;
  langZh: string;
  langEn: string;

  // 部署面板
  deployTitle: string;
  deployScope: string;
  scopeUser: string;
  scopeUserDesc: string;
  scopeWorkspace: string;
  scopeWorkspaceDesc: string;
  workspacePath: string;
  platforms: string;
  deploy: string;
  undeploy: string;
  cleanConfig: string;
  cleanConfigDesc: string;
  deploySteps: string;
  noSteps: string;
  currentStatus: string;

  // 系统设置：预定义消息
  predefinedMessages: string;
  predefinedMessagesDesc: string;
  predefinedMsgAdd: string;
  predefinedMsgPlaceholder: string;
  predefinedMsgEmpty: string;
  predefinedMsgRemove: string;
  predefinedMsgActive: string;

  // 系统设置：服务端
  serverAddress: string;
  serverAddressDesc: string;
  serverAddressPlaceholder: string;
  serverAddressAuto: string;
  restartServer: string;
  restartServerDesc: string;
  restartServerBtn: string;
  restartServerConfirm: string;
  restartServerSuccess: string;
  restartServerFailed: string;
  restartServerReconnecting: string;
  serverPid: string;
  serverUptime: string;
  serverPidLoading: string;

  // 系统设置：通知
  notification: string;
  notificationDesc: string;
  notificationEnabled: string;
  notificationDisabled: string;
  notificationPermissionDenied: string;
  notificationTest: string;
  /** 测试通知发送成功后按钮短暂展示的文案 */
  notificationTestSent: string;
  /** 环境不支持 Notification API 时的提示 */
  notificationTestUnsupported: string;

  quote: string;
  quoteAll: string;
  quoteSummary: string;
  quoteQuestion: string;
  quoteFeedback: string;
  summary: string;

  pin: string;
  unpin: string;

  // 自定义标签
  addTag: string;
  addTagPlaceholder: string;
  removeTag: string;
  tooltipTags: string;

  agentAcked: string;

  /** 部署请求过程中客户端展示的文案 */
  deployConnecting: string;
  deployParseFailed: string;
  /** 占位 `{status}` 为 HTTP 状态码 */
  deployInvalidJson: string;
  deployRequestFailed: string;
  deployNoServerSteps: string;
  deployNetworkOrCors: string;
  deployStateDeployed: string;
  deployStateNotDeployed: string;
  workspacePathPlaceholder: string;
}

export const zh: Translations = {
  unnamed: "未命名",
  confirm: "确认",
  cancel: "取消",
  save: "保存",
  back: "返回",
  copy: "复制",

  sessions: "会话",
  sessionList: "会话列表",
  sessionsHint: "（↑↓ 切换）",
  noSessions: "暂无会话",
  pendingReply: "有待回复",
  deleteSession: "删除会话",
  tooltipTitle: "标题",
  tooltipSource: "来源",
  tooltipWorkspace: "工作区",
  tooltipStatus: "状态",
  tooltipSessionId: "会话ID",
  tooltipLastActive: "最近活动",
  sessionGroupToday: "今天",
  sessionGroupYesterday: "昨天",
  sessionGroupRecent7: "最近7天",
  sessionGroupOlder: "更早",
  sessionGroupExpand: "展开",
  sessionGroupCollapse: "折叠",
  sessionGroupShowMore: "查看更多",
  sessionGroupShowLess: "收起",
  toggleSidebar: "切换侧边栏",

  sourceUnknown: "未知",

  statusPending: "等待中",
  statusReplied: "已回复",
  statusCancelled: "已取消",
  statusAcked: "已送达",
  statusAwaiting: "等待中",

  unnamedSession: "未命名会话",
  selectSessionHint: "请选择左侧会话，或等待 Agent 发起新请求。",
  question: "QUESTION",
  yourFeedback: "YOUR FEEDBACK",
  asked: "提问",
  replied: "回复",

  replyPlaceholder: "输入回复…（⌘/Ctrl+Enter 发送；可粘贴或拖入文件）",
  noRequestPlaceholder: "当前无待处理请求",
  send: "发送",
  addAttachment: "添加附件",
  fileTooLarge: "超过 10MB",
  imageFormatError: "图片仅支持 JPEG/PNG/GIF/WebP",
  uploadFailed: "上传失败",
  replyRequestExpired: "当前请求已失效，请等待 Agent 发起下一轮后再回复",
  replySocketUnavailable: "当前连接已断开，请稍后重试",
  replyConfirmTimeout: "服务端确认超时，请稍后重试",

  slashHint: "输入 / 打开命令列表",
  cmdConfirm: "/confirm",
  cmdConfirmDesc: "确认并继续",
  cmdContinue: "/continue",
  cmdContinueDesc: "继续执行",
  cmdReject: "/reject",
  cmdRejectDesc: "需要修改",
  cmdCommit: "/commit",
  cmdCommitDesc: "确认并提交",

  connected: "已连接",
  disconnected: "已断开",
  activeSessions: "活跃会话",
  pending: "待处理",

  appTitle: "Super Ask",

  settings: "配置",
  deployManagement: "部署管理",
  systemSettings: "系统设置",
  about: "关于",
  hotKeys: "快捷键",
  shortcutTerminalToggle: "打开/关闭终端",
  shortcutSessionListToggle: "打开/关闭会话列表",
  shortcutDocsToggle: "打开/关闭文档",
  shortcutSendReply: "发送回复",
  aboutLoading: "正在加载关于页面内容…",
  aboutLoadFailed: "关于页面内容加载失败。",
  aboutEmpty: "关于页面内容为空（服务器返回了空文件）。",
  language: "语言",
  languageDesc: "选择界面显示语言",
  langZh: "中文",
  langEn: "English",

  deployTitle: "部署管理",
  deployScope: "部署范围",
  scopeUser: "用户全局",
  scopeUserDesc: "规则对当前用户所有项目生效，存放在用户目录下的对应平台配置位置。",
  scopeWorkspace: "工作区",
  scopeWorkspaceDesc: "规则仅对指定工作区生效，存放在工作区的对应平台规则/配置位置，例如 .cursor/rules/、.copilot/instructions/、AGENTS.md 或 .qwen/settings.json。",
  workspacePath: "工作区路径",
  platforms: "目标平台",
  deploy: "一键部署",
  undeploy: "一键卸载",
  cleanConfig: "同时清理 ~/.super-ask/ 配置目录",
  cleanConfigDesc: "卸载时可选清理全局配置",
  deploySteps: "执行步骤",
  noSteps: "点击「一键部署」或「一键卸载」开始操作",
  currentStatus: "当前部署状态",

  predefinedMessages: "预定义消息",
  predefinedMessagesDesc: "设置预定义消息，发送时自动追加勾选的消息到提交内容末尾。",
  predefinedMsgAdd: "添加",
  predefinedMsgPlaceholder: "输入预定义消息内容…",
  predefinedMsgEmpty: "暂无预定义消息",
  predefinedMsgRemove: "删除",
  predefinedMsgActive: "启用",

  serverAddress: "服务端地址",
  serverAddressDesc: "当前 super-ask 服务端地址（界面由服务端提供，不可修改）",
  serverAddressPlaceholder: "",
  serverAddressAuto: "",
  restartServer: "服务端管理",
  restartServerDesc: "重启 super-ask 服务端进程。",
  restartServerBtn: "重启服务",
  restartServerConfirm: "确定要重启服务端吗？所有连接将暂时中断。",
  restartServerSuccess: "服务端正在重启…",
  restartServerFailed: "重启请求失败",
  restartServerReconnecting: "正在等待服务端恢复…",
  serverPid: "进程号 (PID)",
  serverUptime: "运行时间",
  serverPidLoading: "加载中…",

  notification: "桌面通知",
  notificationDesc: "开启后，新消息到来时推送系统通知（需要浏览器授权）。",
  notificationEnabled: "开启桌面通知",
  notificationDisabled: "开启桌面通知",
  notificationPermissionDenied: "浏览器已拒绝通知权限，请在浏览器设置中手动允许。",
  notificationTest: "发送测试通知",
  notificationTestSent: "已发送 ✓",
  notificationTestUnsupported: "当前环境不支持桌面通知 API。",

  quote: "引用",
  quoteAll: "引用全部",
  quoteSummary: "引用摘要",
  quoteQuestion: "引用问题",
  quoteFeedback: "引用回复",
  summary: "SUMMARY",

  pin: "Pin",
  unpin: "取消 Pin",

  addTag: "添加标签",
  addTagPlaceholder: "输入标签名…",
  removeTag: "移除标签",
  tooltipTags: "标签",

  agentAcked: "已送达至 Agent",

  deployConnecting: "正在连接服务器并执行…",
  deployParseFailed: "解析响应失败",
  deployInvalidJson: "响应不是合法 JSON（HTTP {status}）",
  deployRequestFailed: "请求失败",
  deployNoServerSteps: "服务器未返回步骤详情",
  deployNetworkOrCors: "网络或跨域错误",
  deployStateDeployed: "已部署",
  deployStateNotDeployed: "未部署",
  workspacePathPlaceholder: "例如 /Users/you/project",
};

export const en: Translations = {
  unnamed: "Unnamed",
  confirm: "Confirm",
  cancel: "Cancel",
  save: "Save",
  back: "Back",
  copy: "Copy",

  sessions: "Sessions",
  sessionList: "Session List",
  sessionsHint: "(↑↓ switch)",
  noSessions: "No sessions",
  pendingReply: "Pending reply",
  deleteSession: "Delete session",
  tooltipTitle: "Title",
  tooltipSource: "Source",
  tooltipWorkspace: "Workspace",
  tooltipStatus: "Status",
  tooltipSessionId: "Session ID",
  tooltipLastActive: "Last Active",
  sessionGroupToday: "Today",
  sessionGroupYesterday: "Yesterday",
  sessionGroupRecent7: "Recent 7 Days",
  sessionGroupOlder: "Earlier",
  sessionGroupExpand: "Expand",
  sessionGroupCollapse: "Collapse",
  sessionGroupShowMore: "Show more",
  sessionGroupShowLess: "Show less",
  toggleSidebar: "Toggle sidebar",

  sourceUnknown: "Unknown",

  statusPending: "Awaiting",
  statusReplied: "Replied",
  statusCancelled: "Cancelled",
  statusAcked: "Delivered",
  statusAwaiting: "Awaiting",

  unnamedSession: "Unnamed session",
  selectSessionHint: "Select a session or wait for an Agent request.",
  question: "QUESTION",
  yourFeedback: "YOUR FEEDBACK",
  asked: "Asked",
  replied: "Replied",

  replyPlaceholder: "Type reply… (⌘/Ctrl+Enter to send; paste or drop files)",
  noRequestPlaceholder: "No pending requests",
  send: "Send",
  addAttachment: "Add attachment",
  fileTooLarge: "Exceeds 10MB",
  imageFormatError: "Only JPEG/PNG/GIF/WebP images allowed",
  uploadFailed: "Upload failed",
  replyRequestExpired: "This request has expired. Wait for the agent to ask again before replying.",
  replySocketUnavailable: "Connection is unavailable. Please try again shortly.",
  replyConfirmTimeout: "Server confirmation timed out. Please try again shortly.",

  slashHint: "Type / to open commands",
  cmdConfirm: "/confirm",
  cmdConfirmDesc: "Confirm and continue",
  cmdContinue: "/continue",
  cmdContinueDesc: "Continue execution",
  cmdReject: "/reject",
  cmdRejectDesc: "Request changes",
  cmdCommit: "/commit",
  cmdCommitDesc: "Confirm and commit",

  connected: "Connected",
  disconnected: "Disconnected",
  activeSessions: "Active sessions",
  pending: "Pending",

  appTitle: "Super Ask",

  settings: "Settings",
  deployManagement: "Deploy Management",
  systemSettings: "System Settings",
  about: "About",
  hotKeys: "Hot Keys",
  shortcutTerminalToggle: "Toggle terminal",
  shortcutSessionListToggle: "Toggle session list",
  shortcutDocsToggle: "Toggle docs",
  shortcutSendReply: "Send reply",
  aboutLoading: "Loading about page content…",
  aboutLoadFailed: "Failed to load about page content.",
  aboutEmpty: "About page content is empty (the server returned an empty file).",
  language: "Language",
  languageDesc: "Choose the display language",
  langZh: "中文",
  langEn: "English",

  deployTitle: "Deploy Management",
  deployScope: "Scope",
  scopeUser: "User (global)",
  scopeUserDesc: "Rules apply globally for the current user and are stored in each platform's home-level config location.",
  scopeWorkspace: "Workspace",
  scopeWorkspaceDesc: "Rules apply only to the specified workspace and are stored in each platform's workspace-level rule/config location, such as .cursor/rules/, .copilot/instructions/, AGENTS.md, or .qwen/settings.json.",
  workspacePath: "Workspace path",
  platforms: "Platforms",
  deploy: "Deploy",
  undeploy: "Undeploy",
  cleanConfig: "Also clean ~/.super-ask/ config directory",
  cleanConfigDesc: "Optionally clean global config on uninstall",
  deploySteps: "Steps",
  noSteps: 'Click "Deploy" or "Undeploy" to start',
  currentStatus: "Current Status",

  predefinedMessages: "Predefined Messages",
  predefinedMessagesDesc: "Set predefined messages that are auto-appended to your replies when enabled.",
  predefinedMsgAdd: "Add",
  predefinedMsgPlaceholder: "Enter predefined message…",
  predefinedMsgEmpty: "No predefined messages",
  predefinedMsgRemove: "Remove",
  predefinedMsgActive: "Active",

  serverAddress: "Server Address",
  serverAddressDesc: "Current super-ask server address (served by the server, not editable)",
  serverAddressPlaceholder: "",
  serverAddressAuto: "",
  restartServer: "Server Management",
  restartServerDesc: "Restart the super-ask server process.",
  restartServerBtn: "Restart Server",
  restartServerConfirm: "Are you sure you want to restart the server? All connections will be briefly interrupted.",
  restartServerSuccess: "Server is restarting…",
  restartServerFailed: "Restart request failed",
  restartServerReconnecting: "Waiting for server to recover…",
  serverPid: "PID",
  serverUptime: "Uptime",
  serverPidLoading: "Loading…",

  notification: "Desktop Notifications",
  notificationDesc: "When enabled, push system notifications on new messages (requires browser permission).",
  notificationEnabled: "Enable desktop notifications",
  notificationDisabled: "Enable desktop notifications",
  notificationPermissionDenied: "Browser denied notification permission. Please allow it in browser settings.",
  notificationTest: "Send test notification",
  notificationTestSent: "Sent ✓",
  notificationTestUnsupported: "This environment does not support the Notifications API.",

  quote: "Quote",
  quoteAll: "Quote all",
  quoteSummary: "Quote summary",
  quoteQuestion: "Quote question",
  quoteFeedback: "Quote feedback",
  summary: "SUMMARY",

  pin: "Pin",
  unpin: "Unpin",

  addTag: "Add tag",
  addTagPlaceholder: "Enter tag name…",
  removeTag: "Remove tag",
  tooltipTags: "Tags",

  agentAcked: "Delivered to agent",

  deployConnecting: "Connecting to server…",
  deployParseFailed: "Failed to parse response",
  deployInvalidJson: "Response is not valid JSON (HTTP {status})",
  deployRequestFailed: "Request failed",
  deployNoServerSteps: "Server returned no step details",
  deployNetworkOrCors: "Network or CORS error",
  deployStateDeployed: "Deployed",
  deployStateNotDeployed: "Not deployed",
  workspacePathPlaceholder: "e.g. /Users/you/project",
};

export const translations: Record<Locale, Translations> = { zh, en };
