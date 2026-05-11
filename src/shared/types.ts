export const SERVER_STATUSES = ["online", "warning", "offline", "unknown"] as const;

export type ServerStatus = (typeof SERVER_STATUSES)[number];

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
  status: ServerStatus;
  cpuUsedPercent: number | null;
  memoryUsedPercent: number | null;
  diskUsedPercent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  uptimeSeconds: number | null;
  errorCode: string | null;
  errorMessage: string | null;
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
  online: number;
  warning: number;
  offline: number;
  unknown: number;
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
