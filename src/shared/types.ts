/** Connectivity dimension — is the server reachable? */
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
