// === HTTP API ===

export interface AskRequest {
  title?: string;
  summary: string;
  question: string;
  chatSessionId?: string;
  options?: string[];
  /** 来源标识：cursor / vscode / codex / opencode / qwen / 自定义 */
  source?: string;
  /** Agent 所在工作区根路径 */
  workspaceRoot?: string;
  /** 幂等键：同一逻辑请求的所有重试共享同一 requestId，服务端据此去重 */
  requestId?: string;
}

/** 用户消息中的附件（上传后的元数据，供展示与 Agent 回调） */
export interface FileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
  size: number;
}

export interface AskResponse {
  chatSessionId: string;
  feedback: string;
  attachments?: FileAttachment[];
}

export interface HealthResponse {
  status: "ok";
  pid: number;
  uptime: number;
  activeSessions: number;
  pendingRequests: number;
}

export interface ErrorResponse {
  error: string;
  code:
    | "SESSION_NOT_FOUND"
    | "SERVER_SHUTTING_DOWN"
    | "INVALID_REQUEST"
    | "UNAUTHORIZED";
}

// === WebSocket Messages ===

export type WsServerMessage =
  | WsNewRequest
  | WsSessionUpdate
  | WsSync
  | WsSessionDeleted
  | WsPinUpdate
  | WsPinnedSessionOrderUpdate
  | WsTagUpdate
  | WsReplyResult;

export type WsClientMessage = WsReply | WsDeleteSession;

export interface WsNewRequest {
  type: "new_request";
  chatSessionId: string;
  title: string;
  summary: string;
  question: string;
  options?: string[];
  isNewSession: boolean;
  /** 来源 IDE / 客户端 */
  source?: string;
  /** Agent 所在工作区根路径 */
  workspaceRoot?: string;
}

export interface WsSessionUpdate {
  type: "session_update";
  chatSessionId: string;
  status: "pending" | "cancelled" | "replied" | "acked";
  /** 回复时附带用户的历史记录，供其他浏览器实时同步 */
  historyEntry?: HistoryEntry;
}

export interface WsSync {
  type: "sync";
  sessions: SessionInfo[];
  /** 会话列表 pin 顺序（跨端同步，服务端为准） */
  pinnedSessionIds?: string[];
}

export interface WsReply {
  type: "reply";
  chatSessionId: string;
  feedback: string;
  /** 客户端本地请求 ID，用于将发送结果回填给发起该次回复的页面 */
  clientRequestId?: string;
  /** 干净文本（不含预置消息后缀），用于历史存储和UI展示 */
  displayFeedback?: string;
  attachments?: FileAttachment[];
}

export interface WsReplyResult {
  type: "reply_result";
  chatSessionId: string;
  clientRequestId?: string;
  accepted: boolean;
  code?: "not_pending";
}

export interface WsDeleteSession {
  type: "delete_session";
  chatSessionId: string;
}

export interface WsSessionDeleted {
  type: "session_deleted";
  chatSessionId: string;
}

export interface WsPinUpdate {
  type: "pin_update";
  chatSessionId: string;
  pinnedIndices: number[];
}

export interface WsPinnedSessionOrderUpdate {
  type: "pinned_session_order_update";
  pinnedSessionIds: string[];
}

export interface WsTagUpdate {
  type: "tag_update";
  chatSessionId: string;
  tags: string[];
}

// === Session / History ===

export interface SessionInfo {
  chatSessionId: string;
  title: string;
  history: HistoryEntry[];
  hasPending: boolean;
  createdAt: number;
  lastActiveAt: number;
  /** 来源 IDE（由 Agent 上报） */
  source?: string;
  /** Agent 所在工作区根路径 */
  workspaceRoot?: string;
  /** 当前 HTTP 长连接对应的请求状态（供 UI 展示） */
  requestStatus?: "pending" | "replied" | "cancelled" | "acked";
  /** 用户 pin 的消息索引列表（history 中的 index） */
  pinnedIndices?: number[];
  /** 用户自定义标签 */
  tags?: string[];
}

export interface HistoryEntry {
  role: "agent" | "user";
  summary?: string;
  question?: string;
  feedback?: string;
  options?: string[];
  timestamp: number;
  attachments?: FileAttachment[];
  /** 幂等键：CLI 重试时服务端据此去重，避免同一请求产生多条 agent entry */
  requestId?: string;
}

// === Config ===

export interface SuperAskConfig {
  port: number;
  host: string;
  sessionTimeout: number;
  maxSessions: number;
}

export const DEFAULT_CONFIG: SuperAskConfig = {
  port: 19960,
  host: "127.0.0.1",
  sessionTimeout: 604_800_000, // 7 days
  maxSessions: 100,
};

// === PID File ===

export interface PidFileContent {
  pid: number;
  port: number;
  startedAt: number;
}

// === Deploy API ===

export type DeployPlatform = "cursor" | "vscode" | "codex" | "opencode" | "qwen";

/** 部署范围：用户全局或单个工作区 */
export type DeployScope = "user" | "workspace";

export interface DeployRequest {
  platforms: DeployPlatform[];
  workspacePath: string;
  /** 默认 workspace：工作区路径生效；user 时服务端忽略 workspacePath */
  scope?: DeployScope;
}

export interface DeployStep {
  id: string;
  name: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  detail?: string;
}

export interface DeployResponse {
  success: boolean;
  steps: DeployStep[];
}

export interface UndeployRequest {
  platforms: DeployPlatform[];
  workspacePath: string;
  cleanConfig?: boolean; // 是否清理 ~/.super-ask/
  /** 默认 workspace */
  scope?: DeployScope;
}

export interface UndeployResponse {
  success: boolean;
  steps: DeployStep[];
}

export interface DeployStatusResponse {
  deployed: {
    platform: DeployPlatform;
    workspacePath: string;
    rulesFiles: string[];
  }[];
}

export interface OpenPathRequest {
  path: string;
  workspaceRoot?: string;
}

export interface OpenPathResponse {
  success: boolean;
  resolvedPath: string;
  type: "file" | "directory";
}

export interface ReadFileResponse {
  content: string | null;
  resolvedPath: string;
  size: number;
  lang: string | null;
  isBinary: boolean;
  truncated: boolean;
}
