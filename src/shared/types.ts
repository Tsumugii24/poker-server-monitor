/** Connectivity dimension — is the server reachable? */
import type { WeChatDeliveryInfo, WeChatTargetActivity } from "./wechatDelivery";

export type {
  WeChatDeliveryInfo,
  WeChatDeliveryPhase,
  WeChatDeliverySeverity,
  WeChatTargetActivity
} from "./wechatDelivery";

export const CONNECTION_STATUSES = ["online", "offline", "unknown"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Health dimension — resource utilisation level (only meaningful when online). */
export const HEALTH_LEVELS = ["healthy", "warning", "dangerous"] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export type RefreshTrigger = "manual" | "scheduled" | "startup";

export type RefreshRunStatus = "running" | "completed" | "failed";

export type ServerConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  group?: string;
  enabled: boolean;
  note: string;
  solverRoot?: string;
  tmuxSession?: string;
  pipelineStatusFilePath?: string;
};

/** A single WeChat notification recipient. */
export type WeChatRecipient = {
  /** Unique identifier (UUID). */
  id: string;
  /** WeChat user or chatroom ID (e.g. "12345@chatroom"). */
  contactId: string;
  /** User-friendly display label. */
  label: string;
  /** Whether this recipient is active for alert delivery. */
  enabled: boolean;
  /** ISO timestamp when this recipient was added. */
  addedAt: string;
};

/** A logged-in WeChat ClawBot account that can receive alert pushes. */
export type WeChatAccount = {
  /** Stable local account identifier. */
  id: string;
  /** User-friendly display label. */
  label: string;
  /** Whether this account is active for alert delivery. */
  enabled: boolean;
  /** ISO timestamp when this account entry was created. */
  addedAt: string;
  /** WeChat account id returned by the login credentials, if known. */
  botUserId: string | null;
  /** User id that has produced a valid context token for proactive alert pushes. */
  alertTargetUserId: string | null;
};

export type AlertSettings = {
  enabled: boolean;
  /** Legacy single target — derived from the first enabled recipient. */
  wechatRoomId: string;
  /** All configured notification recipients. */
  wechatRecipients: WeChatRecipient[];
  /** Logged-in personal WeChat accounts used as alert recipients. */
  wechatAccounts: WeChatAccount[];
  cooldownMinutes: number;
  language: "en" | "zh";
  /** SSH command execution timeout in seconds. */
  sshCommandTimeoutSeconds: number;
  /** SSH connection handshake timeout in seconds. */
  sshConnectTimeoutSeconds: number;
};

export type AlertStatus = {
  enabled: boolean;
  configured: boolean;
};

export type WeChatChatCandidate = {
  userId: string;
  text: string;
  receivedAt: string;
};

export type WeChatStoredSession = {
  available: boolean;
  botUserId: string | null;
  savedAt: string | null;
  contextUserIds: string[];
  verifiedForTarget: boolean;
};

export type WeChatConnectorStatus = {
  started: boolean;
  loggedIn: boolean;
  polling: boolean;
  /** True after the first poll:start event (context store loaded). */
  ready: boolean;
  qrUrl: string | null;
  /** True while the server is waiting for a QR scan (including before qrUrl is ready). */
  awaitingQr: boolean;
  /** WeChat user id of the logged-in bot account, if available. */
  botUserId: string | null;
  /** Persisted session snapshot from local WeChat bot storage. */
  storedSession: WeChatStoredSession;
  lastError: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  recentChats: WeChatChatCandidate[];
  delivery: WeChatDeliveryInfo;
  target: WeChatTargetActivity | null;
};

export type WeChatAccountConnectorStatus = WeChatAccount & {
  storageDir: string;
  verified: boolean;
  connector: WeChatConnectorStatus;
};

export type WeChatAccountsStatus = {
  accounts: WeChatAccountConnectorStatus[];
  activeLoginAccountId: string | null;
  enabledCount: number;
  verifiedCount: number;
};

export const PIPELINE_FILE_STATUSES = [
  "running",
  "completed",
  "completed_with_upload_failures",
  "failed",
  "exited"
] as const;
export type PipelineFileStatus = (typeof PIPELINE_FILE_STATUSES)[number];

export const PIPELINE_PHASES = ["solving", "uploading", "cleanup"] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export const PIPELINE_DISPLAY_STATUSES = [
  "idle",
  "running",
  "solving",
  "uploading",
  "cleanup",
  "stale",
  "completed",
  "completed_with_upload_failures",
  "failed",
  "exited",
  "unavailable"
] as const;
export type PipelineDisplayStatus = (typeof PIPELINE_DISPLAY_STATUSES)[number];

export type PipelineStatusSnapshot = {
  id: string;
  serverId: string;
  collectedAt: string;
  available: boolean;
  processAlive: boolean | null;
  fileStatus: PipelineFileStatus | null;
  displayStatus: PipelineDisplayStatus;
  phase: PipelinePhase | null;
  repoId: string | null;
  datasetName: string | null;
  scenario: string | null;
  currentBatch: number | null;
  totalBatches: number | null;
  totalTasks: number | null;
  batchExpr: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  command: string | null;
  error: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type MetricSnapshot = {
  id: string;
  serverId: string;
  collectedAt: string;
  connectionStatus: ConnectionStatus;
  healthLevel: HealthLevel | null; // null when offline or unknown
  cpuUsedPercent: number | null;
  memoryUsedPercent: number | null;
  diskUsedPercent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  uptimeSeconds: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  cpuModel: string | null;
  cpuVcores: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
};

export type ServerRow = ServerConfig & {
  latest: MetricSnapshot | null;
  pipeline: PipelineStatusSnapshot | null;
  lastDatasetName: string | null;
};

export type RefreshRun = {
  id: string;
  trigger: RefreshTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: RefreshRunStatus;
  successCount: number;
  warningCount: number;
  failureCount: number;
};

export type RefreshState = {
  active: boolean;
  nextRefreshAt: string | null;
  lastRun: RefreshRun | null;
};

export type OverviewSummary = {
  total: number;
  // Connectivity counts
  online: number;
  offline: number;
  unknown: number;
  // Health counts (among online servers only)
  healthy: number;
  warning: number;
  dangerous: number;
  // Averages (among online servers only)
  averageCpu: number | null;
  averageMemory: number | null;
  averageDisk: number | null;
  // Pipeline counts (among online servers only)
  pipelineRunning: number;
  pipelineIdle: number;
  pipelineStale: number;
};

export type OverallHistoryPoint = {
  collectedAt: string;
  averageCpu: number | null;
  averageMemory: number | null;
  averageDisk: number | null;
};

export type OverviewResponse = {
  generatedAt: string;
  refresh: RefreshState;
  summary: OverviewSummary;
  description: string;
  servers: ServerRow[];
  overallHistory: OverallHistoryPoint[];
};

export type ServerDetailResponse = {
  server: ServerConfig;
  latest: MetricSnapshot | null;
  pipeline: PipelineStatusSnapshot | null;
  pipelineHistory: PipelineStatusSnapshot[];
  history: MetricSnapshot[];
};

export type RefreshResponse =
  | {
      accepted: true;
      state: RefreshState;
    }
  | {
      accepted: false;
      code: "refresh_in_progress";
      message: string;
      state: RefreshState;
    };
