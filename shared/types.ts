// === HTTP API ===

export interface AskRequest {
  title?: string;
  summary: string;
  question: string;
  chatSessionId?: string;
  options?: string[];
  /** 来源标识：cursor / vscode / codex / 自定义 */
  source?: string;
  /** Agent 所在工作区根路径 */
  workspaceRoot?: string;
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

export type WsServerMessage = WsNewRequest | WsSessionUpdate | WsSync | WsSessionDeleted | WsPinUpdate | WsTagUpdate;

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
  status: "pending" | "cancelled" | "replied";
  /** 回复时附带用户的历史记录，供其他浏览器实时同步 */
  historyEntry?: HistoryEntry;
}

export interface WsSync {
  type: "sync";
  sessions: SessionInfo[];
}

export interface WsReply {
  type: "reply";
  chatSessionId: string;
  feedback: string;
  /** 干净文本（不含预置消息后缀），用于历史存储和UI展示 */
  displayFeedback?: string;
  attachments?: FileAttachment[];
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
  requestStatus?: "pending" | "replied" | "cancelled";
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
  sessionTimeout: 86400000, // 24h
  maxSessions: 100,
};

// === PID File ===

export interface PidFileContent {
  pid: number;
  port: number;
  startedAt: number;
}

// === Deploy API ===

export type DeployPlatform = "cursor" | "vscode" | "codex";

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
