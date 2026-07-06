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

export const SOLVER_JOB_QUEUE_MODES = ["manual", "queue_next", "parallel"] as const;
export type SolverJobQueueMode = (typeof SOLVER_JOB_QUEUE_MODES)[number];

export const PARALLEL_SOLVER_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "completed_with_failures",
  "failed",
  "canceled"
] as const;
export type ParallelSolverRunStatus = (typeof PARALLEL_SOLVER_RUN_STATUSES)[number];

export const PARALLEL_SOLVER_SLICE_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled"
] as const;
export type ParallelSolverSliceStatus = (typeof PARALLEL_SOLVER_SLICE_STATUSES)[number];

export const PARALLEL_FAILURE_POOL_STATUSES = ["pending", "queued", "running", "solved", "failed"] as const;
export type ParallelFailurePoolStatus = (typeof PARALLEL_FAILURE_POOL_STATUSES)[number];

export const PARALLEL_FAILURE_REASONS = ["abnormal_end", "skipped", "best_server_skipped", "unclassified"] as const;
export type ParallelFailureReason = (typeof PARALLEL_FAILURE_REASONS)[number];

export const SOLVER_SCENARIOS = [
  "sia-sod",
  "sia-sod-open2",
  "sia-sod-open2.5",
  "sia-sod-open3",
  "soa-sid",
  "3ia-3od"
] as const;
export type SolverScenario = string;

export type SolverScenarioLibraryItem = {
  id: SolverScenario;
  label: string;
  rangeSubdir: string;
  configTemplate: string;
  pot: number;
  effectiveStack: number;
  description?: string;
};

export type SolverScenarioLibraryResponse = {
  scenarios: SolverScenarioLibraryItem[];
  updatedAt: string | null;
};

export const DEFAULT_SOLVER_SCENARIO_LIBRARY: SolverScenarioLibraryItem[] = [
  {
    id: "sia-sod",
    label: "SIA vs SOD",
    rangeSubdir: "sia-sod",
    configTemplate: "SIA_SOD_CONFIG",
    pot: 5,
    effectiveStack: 98,
    description: "Default single-raised SIA/SOD scenario."
  },
  {
    id: "sia-sod-open2",
    label: "SIA vs SOD Open 2",
    rangeSubdir: "sia-sod-open2",
    configTemplate: "SIA_SOD_CONFIG",
    pot: 4,
    effectiveStack: 98,
    description: "SIA/SOD open-size scenario using open2 defaults."
  },
  {
    id: "sia-sod-open2.5",
    label: "SIA vs SOD Open 2.5",
    rangeSubdir: "sia-sod-open2.5",
    configTemplate: "SIA_SOD_CONFIG",
    pot: 5,
    effectiveStack: 98,
    description: "SIA/SOD open-size scenario using open2.5 defaults."
  },
  {
    id: "sia-sod-open3",
    label: "SIA vs SOD Open 3",
    rangeSubdir: "sia-sod-open3",
    configTemplate: "SIA_SOD_CONFIG",
    pot: 6,
    effectiveStack: 97,
    description: "SIA/SOD open-size scenario using open3 defaults."
  },
  {
    id: "soa-sid",
    label: "SOA vs SID",
    rangeSubdir: "soa-sid",
    configTemplate: "SOA_SID_CONFIG",
    pot: 5,
    effectiveStack: 98,
    description: "SOA/SID scenario."
  },
  {
    id: "3ia-3od",
    label: "3IA vs 3OD",
    rangeSubdir: "3ia-3od",
    configTemplate: "TOA_TID_CONFIG",
    pot: 16,
    effectiveStack: 92,
    description: "3-bet 3IA/3OD scenario."
  }
];

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
  datasetName?: string;
  settings?: Partial<SolverJobSettings>;
  confirmUnstudied?: boolean;
};

export type SolverJobCreateRequest = SolverJobPreviewRequest & {
  queueMode?: SolverJobQueueMode;
  confirmDatasetName?: boolean;
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
  remoteResultPath: string;
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
  remoteResultPath: string;
  parallelRunId: string | null;
  parallelSliceId: string | null;
  assignedIndices: number[];
  sourceType: "single" | "parallel" | "failure_pool";
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

export type SolverDatasetRepoStatus = {
  preview: SolverJobPreview;
  datasetName: string;
  repoId: string;
  url: string;
  exists: boolean;
  created: boolean;
  requiresConfirmation: boolean;
  tokenConfigured: boolean;
  message?: string;
};

export type SolverDatasetRepoEnsureRequest = SolverJobPreviewRequest & {
  confirmDatasetName?: boolean;
};

export type ParallelSolverServerAllocation = {
  server: ServerRow;
  candidateServerIds: string[];
  rangeExpr: string;
  indices: number[];
  boardNames: string[];
  commandPreview: string;
};

export type ParallelSolverJobPreviewRequest = {
  rangePath: string;
  scenario?: SolverScenario;
  datasetName?: string;
  serverIds?: string[];
  settings?: Partial<SolverJobSettings>;
  confirmUnstudied?: boolean;
};

export type ParallelSolverJobCreateRequest = ParallelSolverJobPreviewRequest & {
  confirmDatasetName?: boolean;
  queueMode?: "start_now" | "queue_next";
};

export type ParallelFailurePoolPreviewRequest = ParallelSolverJobPreviewRequest & {
  indices?: number[];
  bestServerId?: string;
};

export type ParallelFailurePoolSubmitRequest = ParallelFailurePoolPreviewRequest & {
  confirmDatasetName?: boolean;
  queueMode?: "start_now" | "queue_next";
};

export type ParallelSolverJobPreview = {
  rangePath: string;
  rangeName: string;
  learned: boolean;
  datasetName: string;
  repoId: string;
  scenario: SolverScenario;
  solverRangeText: string;
  settings: SolverJobSettings;
  selectedServerIds: string[];
  availableServers: ServerRow[];
  missingIndices: number[];
  missingBoardNames: string[];
  allocations: ParallelSolverServerAllocation[];
  repoExists: boolean;
  tokenConfigured: boolean;
  requiresConfirmation: boolean;
  warnings: string[];
};

export type ParallelSolverSlice = {
  id: string;
  runId: string;
  serverId: string;
  candidateServerIds: string[];
  jobId: string | null;
  rangeExpr: string;
  assignedIndices: number[];
  assignedBoardNames: string[];
  status: ParallelSolverSliceStatus;
  completedCount: number;
  failedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  job: SolverJob | null;
};

export type ParallelSolverRun = {
  id: string;
  sourceType: "parallel" | "failure_pool";
  rangePath: string;
  rangeName: string;
  datasetName: string;
  repoId: string;
  scenario: SolverScenario;
  settings: SolverJobSettings;
  solverRangeText: string;
  status: ParallelSolverRunStatus;
  queueOrder: number;
  serverIds: string[];
  totalIndices: number[];
  missingIndices: number[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  slices: ParallelSolverSlice[];
  report: {
    totalBoards: number;
    completedBoards: number;
    failedBoards: number;
    queuedBoards: number;
    runningBoards: number;
    successRate: number;
    durationSeconds: number | null;
  };
};

export type ParallelFailurePoolEntry = {
  id: string;
  rangePath: string;
  datasetName: string;
  repoId: string;
  scenario: SolverScenario;
  boardIndex: number;
  boardName: string;
  boardKey: string;
  status: ParallelFailurePoolStatus;
  failureReason: ParallelFailureReason;
  attemptCount: number;
  lastRunId: string | null;
  lastSliceId: string | null;
  lastServerId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ParallelSolverJobsResponse = {
  runs: ParallelSolverRun[];
  failurePool: ParallelFailurePoolEntry[];
};

export type ParallelSolverReportsClearResponse = ParallelSolverJobsResponse & {
  deletedCount: number;
  deletedRunIds: string[];
};

export type ParallelSolverQueueReorderRequest = {
  runIds: string[];
};
