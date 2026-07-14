import type { ServerRow } from "./types";
import type { SolverUploadFormat } from "./solverJobs";

export const SERVER_OPERATION_TYPES = ["sync", "network_sync", "upload"] as const;
export type ServerOperationType = (typeof SERVER_OPERATION_TYPES)[number];

export const SERVER_OPERATION_STATUSES = [
  "queued",
  "deploying",
  "running",
  "completed",
  "failed",
  "canceled"
] as const;
export type ServerOperationStatus = (typeof SERVER_OPERATION_STATUSES)[number];

export type ServerUploadCandidate = {
  id: string;
  serverId: string;
  datasetName: string;
  repoId: string;
  jobId: string;
  resultsDir: string;
  parquetCount: number;
  jsonCount: number;
  fileFormat: SolverUploadFormat;
  fileCount: number;
};

export type ServerUploadItem = {
  serverId?: string;
  datasetName: string;
  repoId: string;
  jobId?: string;
  resultsDir: string;
  fileFormat: SolverUploadFormat;
  fileCount?: number;
};

export type ServerOperationItem = ServerUploadItem | {
  serverId: string;
  solverRoot: string;
};

export type ServerOperationResult = {
  summary: Record<string, number | string | boolean | null>;
  details: Array<Record<string, number | string | boolean | null>>;
  raw?: string | null;
};

export type ServerOperation = {
  id: string;
  type: ServerOperationType;
  serverId: string;
  status: ServerOperationStatus;
  tmuxSession: string;
  command: string;
  items: ServerOperationItem[];
  statusFilePath: string;
  logFilePath: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  result: ServerOperationResult | null;
};

export type ServerOperationEvent = {
  id: string;
  operationId: string;
  type: string;
  message: string;
  commandPreview: string | null;
  createdAt: string;
};

export type ServerOperationsResponse = {
  operations: ServerOperation[];
  events: ServerOperationEvent[];
  capabilities?: {
    networkSyncConfigured: boolean;
  };
};

export type ServerUploadCandidatesResponse = {
  server?: ServerRow;
  candidates: ServerUploadCandidate[];
  scannedServers?: ServerRow[];
  failedServers?: Array<{ serverId: string; message: string }>;
};

export type ServerSyncRequest = {
  serverIds?: string[];
};

export type ServerNetworkSyncRequest = {
  serverIds?: string[];
};

export type ServerUploadRequest = {
  serverId?: string;
  items?: ServerUploadItem[];
  serverIds?: string[];
};
