import type { PipelineStatusSnapshot, ServerRow } from "./types";

export const SOLVER_JOB_STATUSES = [
  "draft",
  "queued",
  "deploying",
  "running",
  "stopping",
  "interrupted",
  "completed",
  "failed",
  "canceled"
] as const;
export type SolverJobStatus = (typeof SOLVER_JOB_STATUSES)[number];

export const SOLVER_JOB_QUEUE_MODES = ["manual", "queue_next"] as const;
export type SolverJobQueueMode = (typeof SOLVER_JOB_QUEUE_MODES)[number];

export const SOLVER_SCENARIOS = [
  "sia-sod",
  "sia-sod-open2",
  "sia-sod-open2.5",
  "sia-sod-open3",
  "soa-sid",
  "3ia-3od"
] as const;
export type SolverScenario = (typeof SOLVER_SCENARIOS)[number];

export const SOLVER_EXPORT_FORMATS = ["json", "parquet", "parquet_native"] as const;
export type SolverExportFormat = (typeof SOLVER_EXPORT_FORMATS)[number];

export const SOLVER_UPLOAD_FORMATS = ["json", "parquet"] as const;
export type SolverUploadFormat = (typeof SOLVER_UPLOAD_FORMATS)[number];

export type SolverJobSettings = {
  rangeExpr: string;
  batchSize: number;
  threadNum: number;
  useIsomorphism: 0 | 1;
  maxIteration: number;
  estimateMemory: boolean;
  stallTimeoutSeconds: number | null;
  noOutputTimeoutSeconds: number | null;
  exportFormat: SolverExportFormat;
  uploadFormat: SolverUploadFormat;
  uploadEnabled: boolean;
  uploadAttemptTimeoutSeconds: number;
};

export const DEFAULT_SOLVER_JOB_SETTINGS: SolverJobSettings = {
  rangeExpr: "all",
  batchSize: 5,
  threadNum: -1,
  useIsomorphism: 1,
  maxIteration: 300,
  estimateMemory: false,
  stallTimeoutSeconds: null,
  noOutputTimeoutSeconds: null,
  exportFormat: "parquet",
  uploadFormat: "parquet",
  uploadEnabled: true,
  uploadAttemptTimeoutSeconds: 120
};

export type SolverJobPreviewRequest = {
  serverId: string;
  rangePath: string;
  scenario?: SolverScenario;
  settings?: Partial<SolverJobSettings>;
  confirmUnstudied?: boolean;
};

export type SolverJobCreateRequest = SolverJobPreviewRequest & {
  queueMode?: SolverJobQueueMode;
};

export type SolverJobPreview = {
  server: ServerRow;
  rangePath: string;
  rangeName: string;
  learned: boolean;
  datasetName: string;
  repoId: string;
  scenario: SolverScenario;
  solverRangeText: string;
  remoteRangePath: string;
  commandPreview: string;
  tmuxSession: string;
  pipelineStatusFilePath: string;
  settings: SolverJobSettings;
  warnings: string[];
  requiresConfirmation: boolean;
};

export type SolverJob = {
  id: string;
  serverId: string;
  rangePath: string;
  rangeName: string;
  datasetName: string;
  scenario: SolverScenario;
  repoId: string;
  settings: SolverJobSettings;
  command: string;
  solverRangeText: string;
  status: SolverJobStatus;
  queueMode: SolverJobQueueMode;
  confirmUnstudied: boolean;
  tmuxSession: string;
  remoteRangePath: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  pipeline: PipelineStatusSnapshot | null;
};

export type SolverJobEvent = {
  id: string;
  jobId: string;
  type: string;
  message: string;
  commandPreview: string | null;
  createdAt: string;
};

export type SolverJobsResponse = {
  jobs: SolverJob[];
  events: SolverJobEvent[];
};
