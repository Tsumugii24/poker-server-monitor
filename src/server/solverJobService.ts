import { randomUUID } from "node:crypto";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  SOLVER_TOTAL_BOARD_COUNT,
  SOLVER_EXPORT_FORMATS,
  DEFAULT_SOLVER_SETTING_LIBRARY,
  SOLVER_UPLOAD_FORMATS,
  type ParallelServerSelectionScope,
  type ParallelFailurePoolEntry,
  type ParallelFailureReason,
  type ParallelFailurePoolPreviewRequest,
  type ParallelFailurePoolSubmitRequest,
  type ParallelSolverJobCreateRequest,
  type ParallelSolverJobPreview,
  type ParallelSolverJobPreviewRequest,
  type ParallelSolverRun,
  type ParallelSolverRunSummary,
  type ParallelSolverServerAllocation,
  type ParallelSolverRunStatus,
  type ParallelSolverSlice,
  type ParallelSolverSliceStatus,
  type SolverJob,
  type SolverJobCreateRequest,
  type SolverDatasetRepoEnsureRequest,
  type SolverDatasetRepoStatus,
  type SolverJobEvent,
  type SolverJobEventSummary,
  type SolverJobPreview,
  type SolverJobPreviewRequest,
  type SolverJobSettings,
  type SolverJobStatus,
  type SolverJobSummary,
  type SolverScenario,
  type SolverScenarioLibraryItem,
  type SolverSettingLibraryItem,
  type SolverUploadFormat
} from "../shared/solverJobs";
import type { AlertSettings } from "../shared/types";
import type { PipelineStatusSnapshot, ServerRow } from "../shared/types";
import type { SshTimeoutOptions } from "../shared/sshSettings";
import { linkedSolverSettingsForRangePath } from "../shared/solverSettings";
import {
  connectionDisplayStatus,
  serverIsJobReady,
  serverIsSshReady
} from "../shared/serverReadiness";
import {
  PREFLOP_HAND_CODES,
  PREFLOP_PLAYERS,
  parseRangeText,
  type PreflopPlayerKey,
  type PreflopRangeDocument
} from "../shared/preflopRange";
import {
  datasetNameFromRangePath,
  scenarioFromRangePath
} from "../shared/preflopDataset";
import {
  collectHistoricallyCompletedBoardIndices,
  collectRemoteCoveredBoardIndices,
  computeMissingSolveBoardIndices
} from "../shared/solverCoverage";
import type { ParallelSolverCoverageSummary } from "../shared/solverJobs";
import type {
  ServerOperation,
  ServerOperationEvent,
  ServerOperationResult,
  ServerOperationsResponse,
  ServerNetworkCheckRequest,
  ServerNetworkSyncRequest,
  ServerSyncRequest,
  ServerUploadCandidate,
  ServerUploadCandidateDeleteRequest,
  ServerUploadCandidateDeleteResponse,
  ServerUploadCandidatesBulkDeleteRequest,
  ServerUploadCandidatesBulkDeleteResponse,
  ServerUploadCandidatesResponse,
  ServerUploadItem,
  ServerUploadRequest
} from "../shared/serverOperations";
import type { MonitorDatabase, ParallelDispatchFailureRecord } from "./db";
import { collectServerPipelineStatus } from "./pipelineStatusCollector";
import { rangePathsForDatasetName, readPreflopRangeFile } from "./preflopRangeStore";
import type { SshCredentials, SshExecutor } from "./sshCollector";
import { Ssh2Executor } from "./sshCollector";
import { huggingFaceFetch } from "./huggingFaceHttp";

export { datasetNameFromRangePath, scenarioFromRangePath } from "../shared/preflopDataset";

type SolverJobServiceOptions = {
  db: MonitorDatabase;
  preflopRangesPath: string;
  credentials?: SshCredentials;
  executor?: SshExecutor;
  getSshTimeouts?: () => Partial<SshTimeoutOptions>;
  serverOperationHandshakeRetryDelayMs?: number;
  defaultPipelineStatusFilePath?: string;
  repoNamespace?: string;
  hfToken?: string | null;
  hfProxyUrl?: string | null;
  solverHfProxyUrl?: string | null;
  networkSubscriptionUrl?: string | null;
  giteeUsername?: string | null;
  giteeToken?: string | null;
  getHfProxySettings?: () => Pick<AlertSettings, "hfProxyEnabled" | "solverHfProxyEnabled">;
  getSettingLibrary?: () => SolverSettingLibraryItem[];
  /** @deprecated Use getSettingLibrary. */
  getScenarioLibrary?: () => SolverScenarioLibraryItem[];
};

type DispatchPreflightResult = {
  ready: boolean;
  reason: string | null;
  reasonCode: string | null;
};

const ACTIVE_JOB_STATUSES = new Set<SolverJobStatus>(["deploying", "running", "stopping"]);
const TERMINAL_PARALLEL_RUN_STATUSES = new Set<ParallelSolverRunStatus>([
  "completed",
  "completed_with_failures",
  "failed",
  "canceled"
]);
const DEFAULT_SOLVER_ROOT = "~/solver";
const DEFAULT_REMOTE_PROXY_URL = "http://127.0.0.1:7890";
const ACTIVE_SERVER_OPERATION_STATUSES = new Set(["queued", "deploying", "running"]);
const SERVER_OPERATION_SSH_CONCURRENCY = 2;
const SERVER_OPERATION_HANDSHAKE_RETRY_DELAY_MS = 2_000;
const AUTOMATIC_UPLOAD_RETRY_BASE_MS = 30_000;
const AUTOMATIC_UPLOAD_RETRY_MAX_MS = 15 * 60_000;
const ACTIVE_JOB_RECONCILE_GRACE_MS = 15_000;
const PARALLEL_DISPATCH_QUARANTINE_DURATIONS_MS = [30 * 60_000, 2 * 60 * 60_000, 24 * 60 * 60_000] as const;
const HUGGING_FACE_ORIGIN = "https://huggingface.co";
const HUGGING_FACE_TREE_PAGE_LIMIT = 1000;
const HUGGING_FACE_TREE_MAX_PAGES = 100;
const DATASET_REPO_CACHE_TTL_MS = 30_000;
const REMOTE_BOARD_KEYS_CACHE_TTL_MS = 30_000;
const SOLVER_CARDS_CACHE_TTL_MS = 5 * 60_000;

type TimedCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type ParallelDispatchQuarantine = {
  serverId: string;
  failureCount: number;
  blockedUntil: string;
  latestError: string;
};

type ParallelDispatchSafetyState = {
  activeQuarantines: Map<string, ParallelDispatchQuarantine>;
  failedServerIdsBySlice: Map<string, Set<string>>;
};

type AutomaticUploadFollowup = {
  serverId: string;
  sourceOperationId: string;
  phase: "scan" | "network_sync" | "upload";
  operationId: string | null;
  retryCount: number;
  retryAtMs: number;
  networkRecoveryAttempted: boolean;
};

type DisabledServerRecoverySummary = {
  serverId: string;
  failedJobCount: number;
  requeuedSliceCount: number;
  requeuedBoardCount: number;
};

export class SolverJobService {
  private readonly executor: SshExecutor;
  private readonly repoNamespace: string;
  private readonly defaultPipelineStatusFilePath: string;
  private readonly hfToken: string | null;
  private readonly hfProxyUrl: string | null;
  private readonly solverHfProxyUrl: string | null;
  private readonly networkSubscriptionUrl: string | null;
  private readonly giteeUsername: string;
  private readonly giteeToken: string | null;
  private readonly getHfProxySettings: () => Pick<AlertSettings, "hfProxyEnabled" | "solverHfProxyEnabled">;
  private readonly getSettingLibrary: () => SolverSettingLibraryItem[];
  private readonly serverOperationHandshakeRetryDelayMs: number;
  private readonly datasetRepoExistsCache = new Map<string, TimedCacheEntry<boolean>>();
  private readonly remoteBoardKeysCache = new Map<string, TimedCacheEntry<Set<string>>>();
  private readonly solverCardsCache = new Map<string, TimedCacheEntry<string[]>>();
  private queueReconciliationTask: Promise<void> | null = null;
  private serverOperationReconciliationTask: Promise<void> | null = null;
  private readonly serverOperationStartTasks = new Map<string, Promise<void>>();
  private automaticUploadMonitorInitialized = false;
  private readonly automaticUploadHandledOperationIds = new Set<string>();
  private readonly automaticUploadFollowups = new Map<string, AutomaticUploadFollowup>();

  constructor(private readonly options: SolverJobServiceOptions) {
    this.executor = options.executor ?? new Ssh2Executor(options.getSshTimeouts);
    this.repoNamespace = (options.repoNamespace ?? "Tsumugii").trim() || "Tsumugii";
    this.defaultPipelineStatusFilePath = options.defaultPipelineStatusFilePath ?? "~/run/solver_running_status.json";
    this.hfToken = options.hfToken?.trim() || null;
    this.hfProxyUrl = options.hfProxyUrl?.trim() || null;
    this.solverHfProxyUrl = options.solverHfProxyUrl?.trim() || null;
    this.networkSubscriptionUrl = options.networkSubscriptionUrl?.trim() || null;
    this.giteeUsername = options.giteeUsername?.trim() || "Tsumugii24";
    this.giteeToken = options.giteeToken?.trim() || null;
    this.getHfProxySettings = options.getHfProxySettings ?? (() => ({
      hfProxyEnabled: false,
      solverHfProxyEnabled: false
    }));
    this.getSettingLibrary = options.getSettingLibrary
      ?? options.getScenarioLibrary
      ?? (() => DEFAULT_SOLVER_SETTING_LIBRARY);
    this.serverOperationHandshakeRetryDelayMs = Math.max(
      0,
      Math.trunc(options.serverOperationHandshakeRetryDelayMs ?? SERVER_OPERATION_HANDSHAKE_RETRY_DELAY_MS)
    );
  }

  listJobs() {
    this.reconcileCompletedJobs();
    return {
      jobs: this.options.db.getSolverJobs(),
      events: this.options.db.getSolverJobEvents()
    };
  }

  listJobSummaries() {
    this.reconcileCompletedJobs();
    return this.readJobSummaries();
  }

  readJobSummaries() {
    const recentTerminalByServer = new Map<string, number>();
    const jobs = this.options.db.getSolverJobSummaries().filter((job) => {
      if (ACTIVE_JOB_STATUSES.has(job.status) || job.status === "queued") return true;
      const retained = recentTerminalByServer.get(job.serverId) ?? 0;
      if (retained >= 5) return false;
      recentTerminalByServer.set(job.serverId, retained + 1);
      return true;
    });
    const visibleJobIds = new Set(jobs.map((job) => job.id));
    return {
      jobs,
      events: this.options.db.getSolverJobEventSummaries()
        .filter((event) => visibleJobIds.has(event.jobId))
    };
  }

  getJob(id: string) {
    this.reconcileCompletedJobs();
    const job = this.requireJob(id);
    return {
      job,
      events: this.options.db.getSolverJobEvents(id)
    };
  }

  listParallelJobs() {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    return this.readParallelJobs();
  }

  readParallelJobs() {
    return {
      runs: this.options.db.getParallelSolverRuns().filter((run) => !run.reportCleared),
      failurePool: this.options.db.getParallelFailurePoolEntries(),
      reconciling: this.queueReconciliationTask !== null
    };
  }

  listParallelJobSummaries() {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    return this.readParallelJobSummaries();
  }

  readParallelJobSummaries() {
    return {
      runs: this.options.db.getParallelSolverRunSummaries()
        .filter((run) => !run.reportCleared),
      reconciling: this.queueReconciliationTask !== null
    };
  }

  readParallelFailurePool(rangePath: string, datasetName: string): ParallelFailurePoolEntry[] {
    return this.options.db.getParallelFailurePoolEntries(rangePath.trim(), datasetName.trim());
  }

  readParallelReports() {
    return {
      runs: this.options.db.getParallelSolverReportRuns()
        .filter((run) => !run.reportCleared),
      failurePool: this.options.db.getParallelFailurePoolDatasetSummaries()
    };
  }

  refreshParallelJobs() {
    void this.reconcileAndStartQueuedJobs().catch((error: unknown) => {
      console.error("Solver job queue reconciliation failed", error);
    });
    return this.readParallelJobs();
  }

  refreshParallelJobSummaries() {
    void this.reconcileAndStartQueuedJobs().catch((error: unknown) => {
      console.error("Solver job queue reconciliation failed", error);
    });
    return this.readParallelJobSummaries();
  }

  getParallelRun(id: string): ParallelSolverRun {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    const run = this.options.db.getParallelSolverRun(id);
    if (!run) throw new Error(`Parallel solver run ${id} not found`);
    return run;
  }

  async previewParallel(input: ParallelSolverJobPreviewRequest): Promise<ParallelSolverJobPreview> {
    return this.buildParallelPreview(input);
  }

  async createParallel(input: ParallelSolverJobCreateRequest): Promise<ParallelSolverRun> {
    const preview = await this.buildParallelPreview(input, { createRepoIfConfirmed: Boolean(input.confirmDatasetName) });
    this.ensureDatasetNameAvailable(preview);
    if (!preview.learned) {
      throw new Error("Range must be approved before submitting parallel solver jobs.");
    }
    if (!preview.repoExists) {
      throw new Error("Dataset repo is missing. Confirm the dataset name and create the repo before submitting this parallel job.");
    }
    return this.createParallelRunFromPreview(preview, "parallel", input.queueMode !== "queue_next");
  }

  reorderParallelQueue(runIds: string[]): ParallelSolverRun[] {
    const uniqueIds = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return this.options.db.getParallelSolverRuns();
    const runs = this.options.db.getParallelSolverRuns();
    const byId = new Map(runs.map((run) => [run.id, run]));
    const queueRuns = runs
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort(compareParallelRunQueue);
    const movableRuns = queueRuns.filter((run) => run.status === "queued" && !parallelRunLocked(run));
    const movableIds = new Set(movableRuns.map((run) => run.id));
    if (uniqueIds.length !== movableIds.size || uniqueIds.some((id) => !movableIds.has(id))) {
      throw new Error("Parallel queue reorder payload is stale. Refresh and try again.");
    }
    for (const id of uniqueIds) {
      const run = byId.get(id);
      if (!run) throw new Error(`Parallel solver run ${id} not found`);
      if (parallelRunLocked(run)) {
        throw new Error(`Parallel solver run ${run.datasetName} is locked because a server is running it.`);
      }
      if (run.status !== "queued") {
        throw new Error(`Only queued parallel runs can be reordered.`);
      }
    }
    let movableIndex = 0;
    const orderedIds = queueRuns.map((run) => {
      if (!movableIds.has(run.id)) return run.id;
      return uniqueIds[movableIndex++]!;
    });
    this.options.db.updateParallelSolverRunQueueOrders(orderedIds);
    return this.options.db.getParallelSolverRuns();
  }

  clearParallelReports(): { deletedCount: number; deletedRunIds: string[] } {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    const deletedRunIds = this.options.db.getParallelSolverRuns()
      .filter((run) => !run.reportCleared && TERMINAL_PARALLEL_RUN_STATUSES.has(run.status) && !parallelRunLocked(run))
      .map((run) => run.id);
    this.options.db.clearParallelSolverRunReports(deletedRunIds);
    return {
      deletedCount: deletedRunIds.length,
      deletedRunIds
    };
  }

  clearFailurePool(rangePath: string, datasetName: string): { deletedCount: number } {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    return {
      deletedCount: this.options.db.clearParallelFailurePoolEntries(rangePath, datasetName)
    };
  }

  async cancelParallelRun(id: string): Promise<ParallelSolverRun> {
    const run = this.getParallelRun(id);
    for (const slice of run.slices) {
      if (!slice.job || !ACTIVE_JOB_STATUSES.has(slice.job.status)) continue;
      this.ensureServerOnline(this.requireServer(slice.job.serverId));
    }
    let cancellationPending = false;
    for (const slice of run.slices) {
      if (slice.status === "completed" || slice.status === "failed" || slice.status === "canceled") continue;
      if (slice.job) {
        if (slice.job.status === "queued") {
          this.options.db.updateSolverJob(slice.job.id, {
            status: "canceled",
            finishedAt: new Date().toISOString()
          });
          this.recordEvent(slice.job.id, "canceled", "Parallel run canceled.", null);
        } else if (ACTIVE_JOB_STATUSES.has(slice.job.status)) {
          const stopped = await this.stop(slice.job.id);
          if (ACTIVE_JOB_STATUSES.has(stopped.status)) {
            cancellationPending = true;
            continue;
          }
        }
      }
      this.options.db.updateParallelSolverSlice(slice.id, {
        status: "canceled",
        finishedAt: new Date().toISOString(),
        lastError: "Parallel run canceled."
      });
      if (run.sourceType === "failure_pool") {
        this.restoreFailurePoolEntries(run.rangePath, run.datasetName, slice.assignedIndices);
      } else {
        this.recordCanceledSliceFailures(run, slice);
      }
    }
    if (cancellationPending) {
      this.reconcileCompletedJobs();
      this.reconcileParallelRuns();
      return this.getParallelRun(id);
    }
    this.options.db.updateParallelSolverRun(id, {
      status: "canceled",
      finishedAt: new Date().toISOString(),
      lastError: "Parallel run canceled."
    });
    return this.getParallelRun(id);
  }

  deleteParallelRun(id: string): {
    deletedRunId: string;
    deletedFailurePoolEntries: number;
  } {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    const run = this.getParallelRun(id);
    if (parallelRunLocked(run)) {
      throw new Error("Parallel runs with an active solver task cannot be deleted.");
    }
    if (run.status === "queued") {
      if (run.sourceType === "failure_pool") {
        this.restoreFailurePoolEntries(run.rangePath, run.datasetName, run.totalIndices);
      }
      this.options.db.deleteParallelSolverRuns([id]);
      return { deletedRunId: id, deletedFailurePoolEntries: 0 };
    }
    if (!TERMINAL_PARALLEL_RUN_STATUSES.has(run.status)) {
      throw new Error("Only queued or finished parallel runs can be deleted.");
    }
    const deleted = this.options.db.deleteParallelSolverRuns([id], { deleteLinkedFailurePool: true });
    return {
      deletedRunId: id,
      deletedFailurePoolEntries: deleted.deletedFailurePoolEntries
    };
  }

  async previewFailurePool(input: ParallelFailurePoolPreviewRequest): Promise<ParallelSolverJobPreview> {
    return this.buildFailurePoolPreview(input);
  }

  async submitFailurePool(input: ParallelFailurePoolSubmitRequest): Promise<ParallelSolverRun> {
    const entries = this.failurePoolEntries(input);
    if (entries.length === 0) {
      throw new Error("Failure pool has no pending boards for this range.");
    }
    const preview = await this.buildFailurePoolPreview(input, {
      createRepoIfConfirmed: Boolean(input.confirmDatasetName)
    });
    this.ensureDatasetNameAvailable(preview);
    if (preview.missingIndices.length === 0) {
      throw new Error("Failure pool has no pending boards for this range after coverage reconciliation.");
    }
    if (!preview.repoExists) {
      throw new Error("Dataset repo is missing. Confirm the dataset name and create the repo before submitting this failure pool.");
    }
    const autoStart = input.queueMode !== "queue_next";
    const run = await this.createParallelRunFromPreview(preview, "failure_pool", false);
    this.options.db.updateParallelFailurePoolEntries(preview.rangePath, preview.datasetName, preview.missingIndices, "queued");
    if (autoStart) await this.reconcileAndStartQueuedJobs();
    return this.getParallelRun(run.id);
  }

  preview(input: SolverJobPreviewRequest): SolverJobPreview {
    const preview = buildSolverJobPreview({
      input,
      server: this.requireServer(input.serverId),
      preflopRangesPath: this.options.preflopRangesPath,
      defaultPipelineStatusFilePath: this.defaultPipelineStatusFilePath,
      repoNamespace: this.repoNamespace,
      hfToken: this.hfToken,
      solverHfProxyUrl: this.effectiveSolverHfProxyUrl(),
      settingLibrary: this.getSettingLibrary()
    });
    return this.addHistoricalDatasetCollisions(preview);
  }

  async checkDatasetRepo(input: SolverJobPreviewRequest): Promise<SolverDatasetRepoStatus> {
    const preview = this.preview(input);
    const exists = await this.cachedDatasetRepoExists(preview.repoId);
    return {
      preview,
      datasetName: preview.datasetName,
      repoId: preview.repoId,
      url: huggingFaceDatasetUrl(preview.repoId),
      exists,
      created: false,
      requiresConfirmation: !exists,
      tokenConfigured: Boolean(this.hfToken),
      message: exists ? "Dataset repo exists." : "Dataset repo does not exist."
    };
  }

  async ensureDatasetRepo(input: SolverDatasetRepoEnsureRequest): Promise<SolverDatasetRepoStatus> {
    const status = await this.checkDatasetRepo(input);
    // Repo creation/use is a write boundary too.  Do the ownership check
    // immediately before a caller can bind this Range to the repo, rather than
    // relying only on the later solver-job submission check.
    this.ensureDatasetNameAvailable(status.preview);
    if (status.exists) return status;
    if (!input.confirmDatasetName) {
      return {
        ...status,
        requiresConfirmation: true,
        message: "Dataset repo is missing. Confirm the dataset name before creating it."
      };
    }
    if (!this.hfToken) {
      throw new Error("HF_TOKEN is required to create a missing Hugging Face dataset repo.");
    }
    await createHuggingFaceDatasetRepo(status.repoId, this.hfToken, this.effectiveHfProxyUrl());
    this.setCachedDatasetRepoExists(status.repoId, true);
    return {
      ...status,
      exists: true,
      created: true,
      requiresConfirmation: false,
      message: "Dataset repo created."
    };
  }

  async create(input: SolverJobCreateRequest): Promise<SolverJob> {
    const preview = this.preview(input);
    this.ensureServerOnline(preview.server);
    this.ensureDatasetNameAvailable(preview);
    if (!preview.learned) {
      throw new Error("Range must be approved before submitting to solver jobs.");
    }
    const datasetRepo = await this.ensureDatasetRepo(input);
    if (!datasetRepo.exists) {
      throw new Error("Dataset repo is missing. Confirm the dataset name and create the repo before submitting this job.");
    }

    const now = new Date().toISOString();
    const jobId = randomUUID();
    const solverRoot = effectiveSolverRoot(preview.server);
    const remoteRangePath = jobScopedRemoteRangePath(jobId, preview.datasetName, solverRoot);
    const remoteSettingPath = jobScopedRemoteSettingPath(jobId, solverRoot);
    const remoteResultPath = jobScopedRemoteResultPath(jobId, preview.datasetName, solverRoot);
    const command = buildRunPipelineCommand({
      solverRoot,
      repoId: preview.repoId,
      scenario: preview.scenario,
      setting: preview.setting,
      settingPath: remoteSettingPath,
      rangePath: remoteRangePath,
      resultPath: remoteResultPath,
      settings: preview.settings,
      statusFilePath: preview.pipelineStatusFilePath,
      hfToken: this.hfToken,
      hfProxyUrl: this.effectiveSolverHfProxyUrl(),
      redactSecrets: true
    });
    const job: SolverJob = {
      id: jobId,
      serverId: preview.server.id,
      rangePath: preview.rangePath,
      rangeName: preview.rangeName,
      datasetName: preview.datasetName,
      settingId: preview.settingId,
      setting: preview.setting,
      scenario: preview.scenario,
      repoId: preview.repoId,
      settings: preview.settings,
      command,
      solverRangeText: preview.solverRangeText,
      status: "queued",
      queueMode: input.queueMode ?? "manual",
      confirmUnstudied: Boolean(input.confirmUnstudied),
      tmuxSession: preview.tmuxSession,
      remoteRangePath,
      remoteResultPath,
      parallelRunId: null,
      parallelSliceId: null,
      assignedIndices: [],
      sourceType: "single",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      // A queued job has not produced a pipeline snapshot yet. Keeping the
      // server's previous snapshot here would pin unrelated pre-dispatch state.
      pipeline: null
    };

    if (job.queueMode === "queue_next") {
      this.options.db.cancelQueuedSolverJobsForServer(job.serverId);
    }
    this.options.db.insertSolverJob(job);
    this.recordEvent(job.id, "created", `Queued ${job.datasetName} for ${preview.server.name}.`, job.command);
    return this.requireJob(job.id);
  }

  async start(
    id: string,
    options: { deferOnDispatchFailure?: boolean; preflightChecked?: boolean } = {}
  ): Promise<SolverJob> {
    const job = this.requireJob(id);
    // A queued/paused job may have been created before collision checks were
    // introduced. Revalidate immediately before any remote deploy on resume or
    // normal queue dispatch.
    this.ensureDatasetNameAvailable(job);
    const server = this.requireServer(job.serverId);
    this.ensureServerOnline(server);
    this.ensureNoActiveJob(server.id, job.id);
    this.ensureCredentials();
    if (!options.preflightChecked && this.dispatchProxyUrl(job)) {
      const preflight = await this.runDispatchPreflight(job, server);
      if (!preflight.ready) {
        const message = `Server ${server.id} is not ready for dispatch${preflight.reason ? ` (${preflight.reason})` : ""}.`;
        if (options.deferOnDispatchFailure) {
          return this.markJobDispatchPending(job, `Dispatch pending: ${message}`);
        }
        throw new Error(message);
      }
    }
    const executionCommand = this.buildExecutionCommand(job, server);

    this.options.db.updateSolverJob(job.id, { status: "deploying", lastError: null });
    this.recordEvent(job.id, "deploying", `Submitting selected range and Setting inputs for ${job.datasetName}.`, null);
    try {
      await this.executor.run(server, this.options.credentials!, buildDeployRangeCommand(job));
      this.recordEvent(job.id, "deployed", "Selected range submitted.", null);
      await this.executor.run(server, this.options.credentials!, buildTmuxStartCommand(job, effectiveSolverRoot(server), executionCommand));
      const now = new Date().toISOString();
      this.recordEvent(job.id, "started", `Started tmux session ${job.tmuxSession}.`, job.command);
      return this.options.db.updateSolverJob(job.id, {
        status: "running",
        startedAt: job.startedAt ?? now,
        finishedAt: null,
        lastError: null,
        updatedAt: now
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.deferOnDispatchFailure) {
        if (job.queueMode === "parallel" && job.parallelSliceId) {
          return this.failAndRequeueParallelDispatch(
            job,
            `Parallel dispatch failed before solver ownership was confirmed on ${server.id}: ${message}`
          );
        }
        return this.markJobDispatchPending(job, `Dispatch failed before solver command was confirmed: ${message}`);
      }
      this.recordEvent(job.id, "failed", message, null);
      return this.options.db.updateSolverJob(job.id, {
        status: "failed",
        lastError: message,
        finishedAt: new Date().toISOString()
      });
    }
  }

  async stop(id: string): Promise<SolverJob> {
    const job = this.requireJob(id);
    const server = this.requireServer(job.serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();
    this.options.db.updateSolverJob(job.id, { status: "stopping" });
    this.recordEvent(job.id, "stopping", "Sending Ctrl-C to solver tmux session.", null);

    try {
      const output = await this.executor.run(server, this.options.credentials!, buildGracefulStopPipelineCommand(job));
      if (stopCommandReportsRunning(output)) {
        this.recordEvent(job.id, "stop_pending", "Ctrl-C sent, but the solver process is still running.", output);
        return this.options.db.updateSolverJob(job.id, {
          status: "stopping",
          lastError: null
        });
      }
      this.recordEvent(job.id, "interrupted", "Solver process stopped after Ctrl-C.", output);
      return this.options.db.updateSolverJob(job.id, {
        status: "interrupted",
        finishedAt: new Date().toISOString(),
        lastError: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordEvent(job.id, "stop_failed", message, null);
      return this.options.db.updateSolverJob(job.id, {
        status: "failed",
        lastError: message,
        finishedAt: new Date().toISOString()
      });
    }
  }

  async forceStop(id: string): Promise<SolverJob> {
    const job = this.requireJob(id);
    const server = this.requireServer(job.serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();
    this.options.db.updateSolverJob(job.id, { status: "stopping" });
    this.recordEvent(job.id, "force_stopping", "Force killing solver process and tmux session.", null);

    try {
      const output = await this.executor.run(server, this.options.credentials!, buildForceKillPipelineCommand(job));
      this.recordEvent(job.id, "force_stopped", "Force stop command completed.", output);
      return this.options.db.updateSolverJob(job.id, {
        status: "interrupted",
        finishedAt: new Date().toISOString(),
        lastError: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordEvent(job.id, "force_stop_failed", message, null);
      return this.options.db.updateSolverJob(job.id, {
        status: "failed",
        lastError: message,
        finishedAt: new Date().toISOString()
      });
    }
  }

  async resume(id: string): Promise<SolverJob> {
    const job = this.requireJob(id);
    this.ensureJobServerOnline(job);
    this.recordEvent(job.id, "resume_requested", "Resume requested for existing job command.", job.command);
    return this.start(job.id);
  }

  async listServerOperations(): Promise<ServerOperationsResponse> {
    return {
      operations: this.options.db.getServerOperationInventory(),
      events: this.options.db.getServerOperationEvents(),
      capabilities: {
        networkSyncConfigured: Boolean(this.networkSubscriptionUrl)
      }
    };
  }

  async refreshServerOperations(): Promise<ServerOperationsResponse> {
    void this.reconcileServerOperations().catch((error: unknown) => {
      console.error("Server operation reconciliation failed", error);
    });
    return this.listServerOperations();
  }

  async scanUploadCandidates(serverId: string): Promise<ServerUploadCandidatesResponse> {
    const server = this.requireServer(serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();
    const output = await this.runServerOperationSsh(
      server,
      buildScanUploadCandidatesCommand(effectiveSolverRoot(server), this.repoNamespace)
    );
    return {
      server,
      candidates: parseUploadCandidatesOutput(output, server.id, this.repoNamespace)
    };
  }

  async scanAllUploadCandidates(serverIds?: string[]): Promise<ServerUploadCandidatesResponse> {
    this.ensureCredentials();
    const servers = this.operationTargetServers(serverIds);
    const candidates: ServerUploadCandidate[] = [];
    const failedServers: Array<{ serverId: string; message: string }> = [];
    await forEachWithConcurrency(servers, SERVER_OPERATION_SSH_CONCURRENCY, async (server) => {
      try {
        const output = await this.runServerOperationSsh(
          server,
          buildScanUploadCandidatesCommand(effectiveSolverRoot(server), this.repoNamespace)
        );
        candidates.push(...parseUploadCandidatesOutput(output, server.id, this.repoNamespace));
      } catch (error) {
        failedServers.push({
          serverId: server.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
    return {
      scannedServers: servers,
      failedServers,
      candidates: candidates.sort(compareUploadCandidates)
    };
  }

  async deleteUploadCandidate(input: ServerUploadCandidateDeleteRequest): Promise<ServerUploadCandidateDeleteResponse> {
    const server = this.requireServer(input.serverId);
    this.ensureServerOnline(server);
    if (!server.enabled) throw new Error(`Server ${server.id} is offline or disabled.`);
    this.ensureCredentials();
    const activeUpload = this.options.db.getLatestServerOperation(server.id, "upload");
    if (activeUpload && ACTIVE_SERVER_OPERATION_STATUSES.has(activeUpload.status)) {
      throw new Error(`Active upload operation on server ${server.id} must be stopped before deleting retained results.`);
    }
    const activeJob = this.options.db.getActiveSolverJobForServer(server.id);
    const requestedJobId = remotePathBasename(input.resultsDir);
    if (activeJob && activeJob.id === requestedJobId) {
      throw new Error(`Active solver job ${activeJob.datasetName} must be stopped before deleting its results.`);
    }
    const output = await this.runServerOperationSsh(
      server,
      buildDeleteUploadCandidateCommand(effectiveSolverRoot(server), input.resultsDir)
    );
    return parseDeletedUploadCandidateOutput(output, server.id);
  }

  async deleteUploadCandidates(
    input: ServerUploadCandidatesBulkDeleteRequest
  ): Promise<ServerUploadCandidatesBulkDeleteResponse> {
    const uniqueItems = uniqueUploadCandidateDeleteRequests(input.items);
    const deleted: ServerUploadCandidateDeleteResponse[] = [];
    const failed: ServerUploadCandidatesBulkDeleteResponse["failed"] = [];
    const itemsByServer = new Map<string, ServerUploadCandidateDeleteRequest[]>();
    for (const item of uniqueItems) {
      const serverItems = itemsByServer.get(item.serverId) ?? [];
      serverItems.push(item);
      itemsByServer.set(item.serverId, serverItems);
    }

    await forEachWithConcurrency(
      [...itemsByServer.values()],
      SERVER_OPERATION_SSH_CONCURRENCY,
      async (serverItems) => {
        for (const item of serverItems) {
          try {
            deleted.push(await this.deleteUploadCandidate(item));
          } catch (error) {
            failed.push({
              ...item,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    );

    return {
      requested: uniqueItems.length,
      deleted,
      failed
    };
  }

  async startSyncOperations(input: ServerSyncRequest = {}): Promise<ServerOperationsResponse> {
    this.ensureCredentials();
    const servers = this.operationTargetServers(input.serverIds);
    if (servers.length === 0) {
      throw new Error("No online servers are available for sync.");
    }
    await forEachWithConcurrency(servers, SERVER_OPERATION_SSH_CONCURRENCY, async (server) => {
      const operation = this.prepareServerOperation(server, "sync", (id) => this.createSyncOperation(server, id));
      if (!operation) return;
      this.options.db.upsertServerOperation(operation);
      this.recordOperationEvent(operation.id, "created", `Created sync operation for ${server.id}.`, operation.command);
      await this.startServerOperation(operation, server);
    });
    return this.listServerOperations();
  }

  async startNetworkSyncOperations(input: ServerNetworkSyncRequest = {}): Promise<ServerOperationsResponse> {
    this.ensureCredentials();
    if (!this.networkSubscriptionUrl) {
      throw new Error("SUBSCRIPTION_URL is required for network sync operations.");
    }
    const servers = this.operationTargetServers(input.serverIds);
    if (servers.length === 0) {
      throw new Error("No online servers are available for network sync.");
    }
    await forEachWithConcurrency(servers, SERVER_OPERATION_SSH_CONCURRENCY, async (server) => {
      const operation = this.prepareServerOperation(server, "network_sync", (id) => this.createNetworkSyncOperation(server, id));
      if (!operation) return;
      const executionCommand = buildTrackedServerOperationCommand({
        id: operation.id,
        type: operation.type,
        statusFilePath: operation.statusFilePath,
        logFilePath: operation.logFilePath,
        bodyCommand: buildServerNetworkSyncCommand({
          subscriptionUrl: this.networkSubscriptionUrl,
          giteeUsername: this.giteeUsername,
          giteeToken: this.giteeToken,
          sudoPassword: this.options.credentials!.password,
          redactSecrets: false
        })
      });
      this.options.db.upsertServerOperation(operation);
      this.recordOperationEvent(operation.id, "created", `Created network sync operation for ${server.id}.`, operation.command);
      await this.startServerOperation(operation, server, executionCommand);
    });
    return this.listServerOperations();
  }

  async startNetworkCheckOperations(input: ServerNetworkCheckRequest = {}): Promise<ServerOperationsResponse> {
    this.ensureCredentials();
    const servers = this.operationTargetServers(input.serverIds);
    if (servers.length === 0) {
      throw new Error("No online servers are available for network checks.");
    }
    await forEachWithConcurrency(servers, SERVER_OPERATION_SSH_CONCURRENCY, async (server) => {
      const operation = this.prepareServerOperation(server, "network_check", (id) => this.createNetworkCheckOperation(server, id));
      if (!operation) return;
      this.options.db.upsertServerOperation(operation);
      this.recordOperationEvent(operation.id, "created", `Created network check for ${server.id}.`, operation.command);
      await this.startServerOperation(operation, server);
    });
    return this.listServerOperations();
  }

  async startUploadOperation(input: ServerUploadRequest = {}): Promise<ServerOperationsResponse> {
    this.ensureCredentials();
    if (!this.hfToken) {
      throw new Error("HF_TOKEN is required for upload operations.");
    }
    const explicitServer = input.serverId?.trim() ? this.requireServer(input.serverId) : null;
    if (explicitServer) this.ensureServerOnline(explicitServer);
    const targetServers = explicitServer ? [explicitServer] : this.operationTargetServers(input.serverIds);
    if (targetServers.length === 0) {
      throw new Error("No online servers are available for upload.");
    }

    let items = normalizeUploadItems(input.items);
    const scanFailedServerIds = new Set<string>();
    if (items.length === 0) {
      const scan = await this.scanAllUploadCandidates(targetServers.map((server) => server.id));
      items = normalizeUploadItems(scan.candidates.flatMap(serverUploadItemsFromCandidate));
      for (const failed of scan.failedServers ?? []) {
        scanFailedServerIds.add(failed.serverId);
        const server = targetServers.find((candidate) => candidate.id === failed.serverId);
        if (!server) continue;
        const operation = this.prepareServerOperation(
          server,
          "upload",
          (id) => this.createUploadOperation(server, [], {
          summary: {
            scanned: false,
            upload_success: 0,
            upload_failed: 0,
            no_files: 0,
            scan_failed: 1
          },
          details: [{ server_id: failed.serverId, error: failed.message }]
          }, id)
        );
        if (!operation) continue;
        this.options.db.upsertServerOperation(operation);
        this.options.db.updateServerOperation(operation.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          lastError: failed.message,
          result: operation.result
        });
        this.recordOperationEvent(operation.id, "scan_failed", `Upload scan failed for ${failed.serverId}: ${failed.message}`, null);
      }
    }

    this.ensureRetainedUploadItemsSafe(items);

    const itemsByServer = groupUploadItemsByServer(items, targetServers);
    const pendingStarts: Array<{ operation: ServerOperation; server: ServerRow }> = [];
    for (const server of targetServers) {
      if (scanFailedServerIds.has(server.id)) continue;
      const operationItems = itemsByServer.get(server.id) ?? [];
      const operation = this.prepareServerOperation(server, "upload", (id) => this.createUploadOperation(server, operationItems, null, id));
      if (!operation) continue;
      this.options.db.upsertServerOperation(operation);
      this.recordOperationEvent(
        operation.id,
        "created",
        operationItems.length > 0
          ? `Created upload operation for ${server.id} with ${operationItems.length} folder(s).`
          : `Created upload operation for ${server.id}; no retained result folders were found.`,
        operation.command
      );
      pendingStarts.push({ operation, server });
    }
    void forEachWithConcurrency(
      pendingStarts,
      SERVER_OPERATION_SSH_CONCURRENCY,
      async ({ operation, server }) => this.launchServerOperation(operation, server)
    ).catch((error: unknown) => {
      console.error("Server upload operation startup failed", error);
    });
    return this.listServerOperations();
  }

  async stopServerOperation(id: string): Promise<ServerOperationsResponse> {
    const operation = this.requireServerOperation(id);
    const server = this.requireServer(operation.serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();
    const output = await this.runServerOperationSsh(
      server,
      buildStopServerOperationCommand(operation.tmuxSession),
      operation
    );
    this.options.db.updateServerOperation(operation.id, {
      status: "canceled",
      finishedAt: new Date().toISOString(),
      lastError: null
    });
    this.recordOperationEvent(operation.id, "canceled", "Operation tmux session was stopped.", output);
    return this.listServerOperations();
  }

  async retryServerOperation(id: string): Promise<ServerOperationsResponse> {
    const previous = this.requireServerOperation(id);
    if (previous.status !== "failed" && previous.status !== "canceled") {
      throw new Error(`Only failed or canceled operations can be retried; ${previous.id} is ${previous.status}.`);
    }
    const server = this.requireServer(previous.serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();

    if (previous.type === "upload" && !this.hfToken) {
      throw new Error("HF_TOKEN is required for upload operations.");
    }
    if (previous.type === "network_sync" && !this.networkSubscriptionUrl) {
      throw new Error("SUBSCRIPTION_URL is required for network sync operations.");
    }

    const uploadItems = previous.type === "upload"
      ? normalizeUploadItems(previous.items.filter(isServerUploadOperationItem))
      : [];
    if (previous.type === "upload" && uploadItems.length === 0) {
      return this.startUploadOperation({ serverId: server.id });
    }
    if (previous.type === "upload") {
      this.ensureRetainedUploadItemsSafe(uploadItems);
    }

    const retryId = randomUUID();
    const operation = previous.type === "sync"
      ? this.createSyncOperation(server, retryId)
      : previous.type === "network_sync"
        ? this.createNetworkSyncOperation(server, retryId)
        : previous.type === "network_check"
          ? this.createNetworkCheckOperation(server, retryId)
          : this.createUploadOperation(server, uploadItems, null, retryId);
    const executionCommand = previous.type === "network_sync"
      ? buildTrackedServerOperationCommand({
          id: operation.id,
          type: operation.type,
          statusFilePath: operation.statusFilePath,
          logFilePath: operation.logFilePath,
          bodyCommand: buildServerNetworkSyncCommand({
            subscriptionUrl: this.networkSubscriptionUrl,
            giteeUsername: this.giteeUsername,
            giteeToken: this.giteeToken,
            sudoPassword: this.options.credentials!.password,
            redactSecrets: false
          })
        })
      : operation.command;

    this.options.db.upsertServerOperation(operation);
    this.recordOperationEvent(
      operation.id,
      "retried",
      `Retrying ${previous.type} operation ${previous.id} for ${server.id} as a new attempt.`,
      operation.command
    );
    await this.startServerOperation(operation, server, executionCommand);
    return this.listServerOperations();
  }

  clearServerOperationReports(): { cleared: number } {
    return { cleared: this.options.db.clearTerminalServerOperations() };
  }

  async switchTo(id: string): Promise<SolverJob> {
    const job = this.requireJob(id);
    this.ensureJobServerOnline(job);
    const active = this.options.db.getActiveSolverJobForServer(job.serverId, job.id);
    if (active) {
      this.recordEvent(job.id, "switch_waiting", `Stopping active job ${active.datasetName}.`, null);
      await this.stop(active.id);
    }
    this.recordEvent(job.id, "switch_starting", "Starting selected job after switch.", job.command);
    return this.start(job.id);
  }

  cancel(id: string): SolverJob {
    const job = this.requireJob(id);
    this.ensureJobServerOnline(job);
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      throw new Error("Active jobs must be stopped before cancellation.");
    }
    this.recordEvent(job.id, "canceled", "Job canceled.", null);
    return this.options.db.updateSolverJob(job.id, {
      status: "canceled",
      finishedAt: new Date().toISOString()
    });
  }

  deleteJob(id: string): { job: SolverJob; events: SolverJobEvent[] } {
    const job = this.requireJob(id);
    this.ensureJobServerOnline(job);
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      throw new Error("Active jobs must be stopped before deletion.");
    }
    if (job.status === "queued") {
      throw new Error("Queued jobs must be canceled before deletion.");
    }

    const events = this.options.db.getSolverJobEvents(job.id);
    this.options.db.deleteSolverJob(job.id);
    return { job, events };
  }

  async reconcileAndStartQueuedJobs(): Promise<void> {
    if (this.queueReconciliationTask) {
      return this.queueReconciliationTask;
    }
    const task = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        void this.runQueueReconciliation().then(resolve, reject);
      });
    });
    this.queueReconciliationTask = task;
    try {
      await task;
    } finally {
      if (this.queueReconciliationTask === task) {
        this.queueReconciliationTask = null;
      }
    }
  }

  async handleServerDisabled(serverId: string): Promise<DisabledServerRecoverySummary> {
    const server = this.options.db.getServerRows().find((candidate) => candidate.id === serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    if (server.enabled) {
      return { serverId, failedJobCount: 0, requeuedSliceCount: 0, requeuedBoardCount: 0 };
    }
    const summary = this.requeueJobsForDisabledServer(server);
    if (summary.failedJobCount > 0 || summary.requeuedSliceCount > 0) {
      await this.reconcileAndStartQueuedJobs();
    }
    return summary;
  }

  private async runQueueReconciliation(): Promise<void> {
    for (const server of this.options.db.getServerRows().filter((candidate) => !candidate.enabled)) {
      this.requeueJobsForDisabledServer(server);
    }
    await this.refreshUnconfirmedActiveJobPipelines();
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    await this.reconcileServerOperations();
    const servers = sortServersByNaturalId(this.options.db.getServerRows());
    const dispatchSafety = buildParallelDispatchSafetyState(
      this.options.db.getUnresolvedParallelDispatchFailures()
    );
    for (const server of servers) {
      const queued = this.options.db.getQueuedSolverJobForServer(server.id);
      if (queued && queued.queueMode !== "parallel") {
        await this.startQueuedJobIfDispatchReady(queued);
        continue;
      }
      await this.assignAndStartNextParallelSliceIfReady(server, dispatchSafety);
    }
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
  }

  private requeueJobsForDisabledServer(server: ServerRow): DisabledServerRecoverySummary {
    const summary: DisabledServerRecoverySummary = {
      serverId: server.id,
      failedJobCount: 0,
      requeuedSliceCount: 0,
      requeuedBoardCount: 0
    };
    const activeJobs = this.options.db.getSolverJobsByStatuses(
      [...ACTIVE_JOB_STATUSES],
      server.id
    );
    if (activeJobs.length === 0) return summary;
    const disabledServerIds = new Set(
      this.options.db.getServerRows()
        .filter((candidate) => !candidate.enabled)
        .map((candidate) => candidate.id)
    );

    this.options.db.runInPersistenceBatch(() => {
      for (const job of activeJobs) {
        const now = new Date().toISOString();
        const slice = job.queueMode === "parallel" && job.parallelSliceId
          ? this.options.db.getParallelSolverSlice(job.parallelSliceId)
          : null;
        const run = slice ? this.options.db.getParallelSolverRun(slice.runId) : null;
        if (!slice || !run) {
          const message = `Server ${server.id} was manually disabled while ${job.datasetName} was running; the job was marked failed and must be retried manually.`;
          this.options.db.updateSolverJob(job.id, {
            status: "failed",
            finishedAt: now,
            lastError: message
          });
          this.recordEvent(job.id, "server_disabled", message, null);
          summary.failedJobCount += 1;
          continue;
        }

        const assigned = [...slice.assignedIndices];
        const completed = new Set((job.pipeline?.completedIndices ?? []).filter((index) => assigned.includes(index)));
        const remaining = assigned.filter((index) => !completed.has(index));
        const message = `Server ${server.id} was manually disabled while ${job.datasetName} was running; ${remaining.length} board(s) were requeued with failure reason server_disabled.`;
        this.options.db.updateSolverJob(job.id, {
          status: "failed",
          finishedAt: now,
          lastError: message
        });
        this.recordEvent(job.id, "server_disabled_requeued", message, null);
        summary.failedJobCount += 1;

        for (const boardIndex of remaining) {
          const position = assigned.indexOf(boardIndex);
          const boardName = slice.assignedBoardNames[position] ?? String(boardIndex);
          this.options.db.upsertParallelFailurePoolEntry({
            id: randomUUID(),
            rangePath: run.rangePath,
            datasetName: run.datasetName,
            repoId: run.repoId,
            scenario: run.scenario,
            boardIndex,
            boardName,
            boardKey: boardKeyFromName(boardName),
            status: "failed",
            failureReason: "server_disabled",
            attemptCount: 1,
            lastRunId: run.id,
            lastSliceId: slice.id,
            lastServerId: server.id,
            lastError: message,
            createdAt: now,
            updatedAt: now
          });
        }

        if (remaining.length === 0) {
          this.options.db.updateParallelSolverSlice(slice.id, {
            status: "completed",
            completedCount: assigned.length,
            failedCount: 0,
            finishedAt: now,
            lastError: null
          });
          continue;
        }

        this.options.db.updateParallelSolverSlice(slice.id, {
          status: "canceled",
          completedCount: completed.size,
          failedCount: 0,
          finishedAt: now,
          lastError: message
        });
        const remainingBoardNames = remaining.map((boardIndex) => {
          const position = assigned.indexOf(boardIndex);
          return slice.assignedBoardNames[position] ?? String(boardIndex);
        });
        this.options.db.insertParallelSolverSlice({
          id: randomUUID(),
          runId: run.id,
          serverId: "",
          candidateServerIds: slice.candidateServerIds.filter((candidateId) => !disabledServerIds.has(candidateId)),
          jobId: null,
          rangeExpr: compressIndices(remaining),
          assignedIndices: remaining,
          assignedBoardNames: remainingBoardNames,
          status: "queued",
          completedCount: 0,
          failedCount: 0,
          startedAt: null,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
          lastError: message,
          job: null
        });
        summary.requeuedSliceCount += 1;
        summary.requeuedBoardCount += remaining.length;
      }
    });
    return summary;
  }

  private async buildParallelPreview(
    input: ParallelSolverJobPreviewRequest,
    options: { explicitIndices?: number[]; createRepoIfConfirmed?: boolean } = {}
  ): Promise<ParallelSolverJobPreview> {
    const servers = sortServersByNaturalId(this.options.db.getServerRows());
    const enabledServers = servers.filter((server) => server.enabled);
    const availableServers = enabledServers.filter((server) =>
      serverIsReadyForParallelSelection(server, this.options.db.getActiveSolverJobForServer(server.id))
    );
    const selectedServerIds = normalizeSelectedServerIds(input.serverIds, enabledServers);
    if (selectedServerIds.length === 0) {
      throw new Error("At least one enabled server is required for parallel solver jobs.");
    }
    const selectedServers = selectedServerIds.map((serverId) => {
      const server = enabledServers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error(`Server ${serverId} is not enabled or does not exist.`);
      return server;
    });

    const rawBasePreview = buildSolverJobPreview({
      input: {
        ...input,
        serverId: selectedServers[0]!.id
      },
      server: selectedServers[0]!,
      preflopRangesPath: this.options.preflopRangesPath,
      defaultPipelineStatusFilePath: this.defaultPipelineStatusFilePath,
      repoNamespace: this.repoNamespace,
      hfToken: this.hfToken,
      solverHfProxyUrl: this.effectiveSolverHfProxyUrl(),
      settingLibrary: this.getSettingLibrary()
    });
    const basePreview = this.addHistoricalDatasetCollisions(rawBasePreview);
    if (options.createRepoIfConfirmed) this.ensureDatasetNameAvailable(basePreview);

    let repoExists = await this.cachedDatasetRepoExists(basePreview.repoId);
    if (!repoExists && options.createRepoIfConfirmed) {
      if (!this.hfToken) throw new Error("HF_TOKEN is required to create a missing Hugging Face dataset repo.");
      await createHuggingFaceDatasetRepo(basePreview.repoId, this.hfToken, this.effectiveHfProxyUrl());
      this.setCachedDatasetRepoExists(basePreview.repoId, true);
      repoExists = true;
    }

    const allBoards = await this.readSolverCardsForServers(uniqueServersById([
      ...selectedServers,
      ...availableServers,
      ...enabledServers
    ]));
    let indices: number[] = [];
    let coverage: ParallelSolverCoverageSummary | null = null;
    if (options.explicitIndices) {
      indices = normalizeBoardIndices(options.explicitIndices, allBoards.length);
    } else if (repoExists) {
      const resolved = await this.resolveMissingSolveBoardIndices(
        basePreview.repoId,
        basePreview.rangePath,
        basePreview.datasetName,
        allBoards
      );
      indices = resolved.missingIndices;
      coverage = resolved.coverage;
    }
    const allocationServerCount = normalizedParallelChunkCount(input.chunkCount, enabledServers.length);
    const allocations = allocateRoundRobinChunks(indices, selectedServers, allocationServerCount).map((allocation) => {
      const settings = { ...basePreview.settings, rangeExpr: allocation.rangeExpr };
      const solverRoot = effectiveSolverRoot(allocation.server);
      const commandPreview = buildRunPipelineCommand({
        solverRoot,
        repoId: basePreview.repoId,
        scenario: basePreview.scenario,
        setting: basePreview.setting,
        settingPath: jobScopedRemoteSettingPath("<job-id>", solverRoot),
        rangePath: jobScopedRemoteRangePath("<job-id>", basePreview.datasetName, solverRoot),
        resultPath: jobScopedRemoteResultPath("<job-id>", basePreview.datasetName, solverRoot),
        settings,
        statusFilePath: allocation.server.pipelineStatusFilePath?.trim() || this.defaultPipelineStatusFilePath,
        hfToken: this.hfToken,
        hfProxyUrl: this.effectiveSolverHfProxyUrl(),
        redactSecrets: true
      });
      return {
        server: allocation.server,
        candidateServerIds: allocation.candidateServerIds,
        rangeExpr: allocation.rangeExpr,
        indices: allocation.indices,
        boardNames: allocation.indices.map((index) => allBoards[index - 1] ?? String(index)),
        commandPreview
      };
    });

    return {
      sourceType: "parallel",
      rangePath: basePreview.rangePath,
      rangeName: basePreview.rangeName,
      learned: basePreview.learned,
      datasetName: basePreview.datasetName,
      datasetCollisionPaths: basePreview.datasetCollisionPaths,
      repoId: basePreview.repoId,
      settingId: basePreview.settingId,
      setting: basePreview.setting,
      scenario: basePreview.scenario,
      solverRangeText: basePreview.solverRangeText,
      settings: basePreview.settings,
      selectedServerIds,
      autoIncludeNewServers: input.autoIncludeNewServers === true,
      serverScope: normalizeParallelServerScope(input),
      availableServers,
      totalBoards: allBoards.length,
      missingIndices: indices,
      missingBoardNames: indices.map((index) => allBoards[index - 1] ?? String(index)),
      allocations,
      coverage,
      repoExists,
      tokenConfigured: Boolean(this.hfToken),
      requiresConfirmation: !basePreview.learned || !repoExists,
      warnings: [
        ...basePreview.warnings,
        ...(!repoExists ? ["Dataset repo is missing. Confirm the dataset name before creating it."] : []),
        ...(coverage ? buildMissingSolveWarnings(coverage) : []),
        ...(indices.length === 0 && repoExists ? ["No missing boards remain for this dataset."] : [])
      ]
    };
  }

  private async resolveMissingSolveBoardIndices(
    repoId: string,
    rangePath: string,
    datasetName: string,
    allBoards: string[]
  ): Promise<{ missingIndices: number[]; coverage: ParallelSolverCoverageSummary }> {
    const remoteBoardKeys = await this.cachedRemoteBoardKeys(repoId);
    return computeMissingSolveBoardIndices({
      allBoards,
      remoteBoardKeys,
      runs: this.options.db.getParallelSolverRuns(),
      datasetName,
      rangePath,
      failurePoolEntries: this.options.db.getParallelFailurePoolEntries(rangePath, datasetName)
    });
  }

  private async buildFailurePoolPreview(
    input: ParallelFailurePoolPreviewRequest,
    options: { createRepoIfConfirmed?: boolean } = {}
  ): Promise<ParallelSolverJobPreview> {
    let entries = this.failurePoolEntries(input);
    const servers = sortServersByNaturalId(this.options.db.getServerRows());
    const enabledServers = servers.filter((server) => server.enabled);
    const availableServers = enabledServers.filter((server) =>
      serverIsReadyForParallelSelection(server, this.options.db.getActiveSolverJobForServer(server.id))
    );
    const selectedServerIds = normalizeSelectedServerIds(input.serverIds, enabledServers);
    const selectedServers = selectedServerIds.map((serverId) => {
      const server = enabledServers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error(`Server ${serverId} is not enabled or does not exist.`);
      return server;
    });
    const performanceServers = enabledServers.filter((server) => server.tier === "performance");
    const baseServer = selectedServers[0] ?? performanceServers[0];
    if (!baseServer) {
      throw new Error("Failure pool has no retryable boards for this range.");
    }

    const rawBasePreview = buildSolverJobPreview({
      input: {
        ...input,
        serverId: baseServer.id
      },
      server: baseServer,
      preflopRangesPath: this.options.preflopRangesPath,
      defaultPipelineStatusFilePath: this.defaultPipelineStatusFilePath,
      repoNamespace: this.repoNamespace,
      hfToken: this.hfToken,
      solverHfProxyUrl: this.effectiveSolverHfProxyUrl(),
      settingLibrary: this.getSettingLibrary()
    });
    const basePreview = this.addHistoricalDatasetCollisions(rawBasePreview);
    if (options.createRepoIfConfirmed) this.ensureDatasetNameAvailable(basePreview);

    let repoExists = await this.cachedDatasetRepoExists(basePreview.repoId);
    if (!repoExists && options.createRepoIfConfirmed) {
      if (!this.hfToken) throw new Error("HF_TOKEN is required to create a missing Hugging Face dataset repo.");
      await createHuggingFaceDatasetRepo(basePreview.repoId, this.hfToken, this.effectiveHfProxyUrl());
      this.setCachedDatasetRepoExists(basePreview.repoId, true);
      repoExists = true;
    }

    const allBoards = await this.readSolverCardsForServers(uniqueServersById([
      ...selectedServers,
      ...performanceServers,
      ...availableServers,
      ...enabledServers
    ]));
    let coverage: ParallelSolverCoverageSummary | null = null;
    if (repoExists) {
      coverage = await this.reconcileFailurePoolCoverage(
        basePreview.repoId,
        basePreview.rangePath,
        basePreview.datasetName,
        allBoards
      );
      entries = this.failurePoolEntries(input);
    }
    const skippedEntries = entries.filter((entry) => entry.failureReason === "skipped");
    const normalEntries = entries.filter((entry) => entry.failureReason !== "skipped");
    if (skippedEntries.length > 0 && performanceServers.length === 0) {
      throw new Error("At least one Performance Tier server is required to retry skipped failure-pool boards.");
    }
    if (normalEntries.length > 0 && selectedServers.length === 0) {
      throw new Error("At least one enabled server is required to retry abnormal failure-pool boards.");
    }
    const allocationServerCount = normalizedParallelChunkCount(
      input.chunkCount,
      selectedServers.length || performanceServers.length
    );
    const normalIndices = normalizeBoardIndices(normalEntries.map((entry) => entry.boardIndex), allBoards.length);
    const skippedIndices = normalizeBoardIndices(skippedEntries.map((entry) => entry.boardIndex), allBoards.length);
    const rawAllocations = allocateFailurePoolChunks({
      normalIndices,
      skippedIndices,
      normalServers: selectedServers,
      performanceServers,
      chunkCount: allocationServerCount
    });
    const allocations: ParallelSolverServerAllocation[] = rawAllocations.map((allocation) => {
      const settings = { ...basePreview.settings, rangeExpr: allocation.rangeExpr };
      const solverRoot = effectiveSolverRoot(allocation.server);
      const commandPreview = buildRunPipelineCommand({
        solverRoot,
        repoId: basePreview.repoId,
        scenario: basePreview.scenario,
        setting: basePreview.setting,
        settingPath: jobScopedRemoteSettingPath("<job-id>", solverRoot),
        rangePath: jobScopedRemoteRangePath("<job-id>", basePreview.datasetName, solverRoot),
        resultPath: jobScopedRemoteResultPath("<job-id>", basePreview.datasetName, solverRoot),
        settings,
        statusFilePath: allocation.server.pipelineStatusFilePath?.trim() || this.defaultPipelineStatusFilePath,
        hfToken: this.hfToken,
        hfProxyUrl: this.effectiveSolverHfProxyUrl(),
        redactSecrets: true
      });
      return {
        server: allocation.server,
        candidateServerIds: allocation.candidateServerIds,
        rangeExpr: allocation.rangeExpr,
        indices: allocation.indices,
        boardNames: allocation.indices.map((index) => allBoards[index - 1] ?? String(index)),
        commandPreview
      };
    });
    const indices = normalizeBoardIndices(entries.map((entry) => entry.boardIndex), allBoards.length);
    const selectedIds = uniqueStringList([
      ...selectedServerIds,
      ...(skippedIndices.length > 0 ? performanceServers.map((server) => server.id) : [])
    ]);

    return {
      sourceType: "failure_pool",
      rangePath: basePreview.rangePath,
      rangeName: basePreview.rangeName,
      learned: basePreview.learned,
      datasetName: basePreview.datasetName,
      datasetCollisionPaths: basePreview.datasetCollisionPaths,
      repoId: basePreview.repoId,
      settingId: basePreview.settingId,
      setting: basePreview.setting,
      scenario: basePreview.scenario,
      solverRangeText: basePreview.solverRangeText,
      settings: basePreview.settings,
      selectedServerIds: selectedIds,
      autoIncludeNewServers: false,
      serverScope: normalizeParallelServerScope(input),
      availableServers,
      totalBoards: allBoards.length,
      missingIndices: indices,
      missingBoardNames: indices.map((index) => allBoards[index - 1] ?? String(index)),
      allocations,
      coverage,
      repoExists,
      tokenConfigured: Boolean(this.hfToken),
      requiresConfirmation: !basePreview.learned || !repoExists,
      warnings: [
        ...basePreview.warnings,
        ...(!repoExists ? ["Dataset repo is missing. Confirm the dataset name before creating it."] : []),
        ...(entries.length === 0 ? ["Failure pool has no retryable boards for this range."] : [])
      ]
    };
  }

  private ensureDatasetNameAvailable(preview: {
    rangePath: string;
    datasetName: string;
    repoId?: string;
    datasetCollisionPaths?: string[];
  }): void {
    const rangePath = preview.rangePath.trim();
    const datasetName = preview.datasetName.trim();
    const repoId = preview.repoId?.trim() || `${this.repoNamespace}/${datasetName}`;
    const collisions = new Set(preview.datasetCollisionPaths ?? []);

    // A caller may explicitly provide a datasetName, bypassing the canonical
    // filename scan. Historical jobs/runs/failure-pool entries are the second
    // source of truth for repository ownership, so include them in the same
    // check before any repo/job mutation occurs.
    for (const owner of this.datasetOwners(datasetName, repoId)) {
      if (owner.rangePath && owner.rangePath !== rangePath) {
        collisions.add(`${owner.source} (${owner.rangePath})`);
      }
    }
    if (collisions.size === 0) return;
    throw new Error(
      `Dataset collision: ${repoId} is already associated with another Range: ` +
      `${[...collisions].join(", ")}. Choose a unique dataset name before submitting this job.`
    );
  }

  private addHistoricalDatasetCollisions<T extends {
    rangePath: string;
    datasetName: string;
    repoId: string;
    datasetCollisionPaths?: string[];
    warnings: string[];
  }>(preview: T): T {
    const collisions = new Set(preview.datasetCollisionPaths ?? []);
    for (const owner of this.datasetOwners(preview.datasetName, preview.repoId)) {
      if (owner.rangePath !== preview.rangePath) {
        collisions.add(`${owner.source} (${owner.rangePath})`);
      }
    }
    if (collisions.size === (preview.datasetCollisionPaths?.length ?? 0)) return preview;
    return {
      ...preview,
      datasetCollisionPaths: [...collisions],
      warnings: [
        ...preview.warnings,
        `Dataset name ${preview.datasetName} is already associated with another Range. ` +
        "Choose a unique dataset name before submitting."
      ]
    };
  }

  private datasetOwnersByRepo(
    requestedOwnerKeys: Set<string>
  ): Map<string, Array<{ source: string; rangePath: string }>> {
    const ownersByRepo = new Map<string, Array<{ source: string; rangePath: string }>>();
    if (requestedOwnerKeys.size === 0) return ownersByRepo;

    const addOwner = (datasetName: string, repoId: string, source: string, rangePath: string) => {
      const ownerKey = datasetRepoKey(datasetName, repoId);
      if (!requestedOwnerKeys.has(ownerKey)) return;
      const owners = ownersByRepo.get(ownerKey) ?? [];
      owners.push({ source, rangePath });
      ownersByRepo.set(ownerKey, owners);
    };

    for (const job of this.options.db.getSolverJobSummaries()) {
      addOwner(job.datasetName, job.repoId, `solver job ${job.id}`, job.rangePath);
    }
    for (const run of this.options.db.getParallelSolverRunSummaries()) {
      addOwner(run.datasetName, run.repoId, `parallel run ${run.id}`, run.rangePath);
    }
    for (const entry of this.options.db.getParallelFailurePoolEntries()) {
      addOwner(entry.datasetName, entry.repoId, `failure pool ${entry.id}`, entry.rangePath);
    }
    return ownersByRepo;
  }

  private datasetOwners(datasetName: string, repoId: string): Array<{ source: string; rangePath: string }> {
    const ownerKey = datasetRepoKey(datasetName, repoId);
    return this.datasetOwnersByRepo(new Set([ownerKey])).get(ownerKey) ?? [];
  }

  private ensureRetainedUploadItemsSafe(items: ServerUploadItem[]): void {
    const requestedOwnerKeys = new Set(
      items
        .filter((item) => item.datasetName.trim() && item.repoId.trim())
        .map((item) => datasetRepoKey(item.datasetName.trim(), item.repoId.trim()))
    );
    const ownersByRepo = this.datasetOwnersByRepo(requestedOwnerKeys);

    for (const item of items) {
      const datasetName = item.datasetName.trim();
      const repoId = item.repoId.trim();
      if (!datasetName || !repoId) continue;

      const knownJob = item.jobId ? this.options.db.getSolverJob(item.jobId) : null;
      if (knownJob && datasetRepoKey(knownJob.datasetName, knownJob.repoId) !== datasetRepoKey(datasetName, repoId)) {
        throw new Error(
          `Dataset collision: retained upload ${item.resultsDir} identifies job ${item.jobId}, ` +
          `but its recorded dataset is ${knownJob.repoId}.`
        );
      }

      const allowedRangePath = knownJob?.rangePath ?? null;
      const owners = (ownersByRepo.get(datasetRepoKey(datasetName, repoId)) ?? [])
        .filter((owner) => !allowedRangePath || owner.rangePath !== allowedRangePath);
      if (owners.length === 0) continue;
      const ownerSummary = [...new Set(owners.map((owner) => `${owner.source} (${owner.rangePath})`))].join(", ");
      throw new Error(
        `Dataset collision: retained upload ${item.resultsDir} would write ${repoId}, ` +
        `which is associated with another Range: ${ownerSummary}.`
      );
    }
  }

  private async createParallelRunFromPreview(
    preview: ParallelSolverJobPreview,
    sourceType: "parallel" | "failure_pool",
    autoStart: boolean
  ): Promise<ParallelSolverRun> {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: ParallelSolverRun = {
      id: runId,
      sourceType,
      rangePath: preview.rangePath,
      rangeName: preview.rangeName,
      datasetName: preview.datasetName,
      repoId: preview.repoId,
      settingId: preview.settingId,
      setting: preview.setting,
      scenario: preview.scenario,
      settings: preview.settings,
      solverRangeText: preview.solverRangeText,
      status: preview.missingIndices.length === 0 ? "completed" : "queued",
      reportCleared: false,
      queueOrder: this.options.db.getNextParallelSolverQueueOrder(),
      serverIds: preview.selectedServerIds,
      autoIncludeNewServers: sourceType === "parallel" && preview.autoIncludeNewServers,
      serverScope: preview.serverScope,
      totalIndices: preview.missingIndices,
      missingIndices: preview.missingIndices,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: preview.missingIndices.length === 0 ? now : null,
      lastError: null,
      slices: [],
      report: {
        totalBoards: preview.missingIndices.length,
        completedBoards: preview.missingIndices.length === 0 ? 0 : 0,
        failedBoards: 0,
        queuedBoards: preview.missingIndices.length,
        runningBoards: 0,
        successRate: preview.missingIndices.length === 0 ? 1 : 0,
        durationSeconds: null
      }
    };
    // sql.js persists by exporting the complete database. A 20-chunk run used
    // to export once for the run and once per slice, which made Queue Next grow
    // dramatically slower with database size. Persist the run and all of its
    // initial slices as one logical write instead.
    this.options.db.runInPersistenceBatch(() => {
      this.options.db.insertParallelSolverRun(run);
      for (const [allocationIndex, allocation] of preview.allocations.entries()) {
        if (allocation.indices.length === 0) continue;
        const allocationCreatedAt = new Date(Date.parse(now) + allocationIndex).toISOString();
        const sliceId = randomUUID();
        const slice: ParallelSolverSlice = {
          id: sliceId,
          runId,
          serverId: "",
          candidateServerIds: allocation.candidateServerIds,
          jobId: null,
          rangeExpr: allocation.rangeExpr,
          assignedIndices: allocation.indices,
          assignedBoardNames: allocation.boardNames,
          status: "queued",
          completedCount: 0,
          failedCount: 0,
          startedAt: null,
          finishedAt: null,
          createdAt: allocationCreatedAt,
          updatedAt: allocationCreatedAt,
          lastError: null,
          job: null
        };
        this.options.db.insertParallelSolverSlice(slice);
      }
    });

    if (autoStart) {
      await this.reconcileAndStartQueuedJobs();
    }
    // The create path already persisted a self-consistent queued run, and the
    // auto-start path finishes with a full reconciliation. Calling the public
    // getParallelRun() here used to run both global reconciliation passes two
    // more times before returning, which made Queue Next increasingly slow as
    // history grew.
    const created = this.options.db.getParallelSolverRun(runId);
    if (!created) throw new Error(`Parallel solver run ${runId} not found after creation.`);
    return created;
  }

  private reconcileParallelRuns(): void {
    this.options.db.runInPersistenceBatch(() => this.reconcileParallelRunsWithinBatch());
  }

  private reconcileParallelRunsWithinBatch(): void {
    const runs = this.options.db.getParallelSolverRunsByStatuses(["queued", "running"]);
    for (const run of runs) {
      for (const slice of run.slices) {
        if (parallelSliceHasInterruptedReassignment(slice)) {
          this.options.db.updateParallelSolverSlice(slice.id, {
            serverId: "",
            jobId: null,
            status: "queued",
            completedCount: 0,
            failedCount: 0,
            startedAt: null,
            finishedAt: null,
            lastError: null
          });
          continue;
        }
        if (slice.status === "completed" || slice.status === "failed" || slice.status === "canceled") continue;
        if (!slice.job) continue;
        const next = sliceStateFromJob(slice, slice.job);
        const becameRunning = slice.status !== "running" && next.status === "running";
        const becameCompleted = next.status === "completed";
        const becameFailed = next.status === "failed";
        if (
          next.status !== slice.status ||
          next.completedCount !== slice.completedCount ||
          next.failedCount !== slice.failedCount ||
          next.startedAt !== slice.startedAt ||
          next.finishedAt !== slice.finishedAt ||
          next.lastError !== slice.lastError
        ) {
          this.options.db.updateParallelSolverSlice(slice.id, next);
        }
        if (becameRunning) {
          this.options.db.updateParallelFailurePoolEntries(run.rangePath, run.datasetName, slice.assignedIndices, "running");
        }
        if (becameCompleted) {
          this.options.db.updateParallelFailurePoolEntries(run.rangePath, run.datasetName, slice.assignedIndices, "solved");
        }
        if (becameFailed) {
          const existingFailurePoolEntries = new Map(
            this.options.db
              .getParallelFailurePoolEntries(run.rangePath, run.datasetName)
              .map((entry) => [entry.boardIndex, entry])
          );
          for (const failure of failureEntriesForSlice(slice, slice.job, existingFailurePoolEntries)) {
            const index = failure.index;
            const assignedPosition = slice.assignedIndices.indexOf(index);
            const boardName = assignedPosition >= 0
              ? slice.assignedBoardNames[assignedPosition] ?? String(index)
              : String(index);
            this.options.db.upsertParallelFailurePoolEntry({
              id: randomUUID(),
              rangePath: run.rangePath,
              datasetName: run.datasetName,
              repoId: run.repoId,
              scenario: run.scenario,
              boardIndex: index,
              boardName,
              boardKey: boardKeyFromName(boardName),
              status: failure.failureReason === "best_server_skipped" ? "failed" : "pending",
              failureReason: failure.failureReason,
              attemptCount: 1,
              lastRunId: run.id,
              lastSliceId: slice.id,
              lastServerId: slice.serverId,
              lastError: next.lastError ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }
        }
      }
      const refreshed = this.options.db.getParallelSolverRun(run.id);
      if (!refreshed) continue;
      const nextRun = parallelRunState(refreshed);
      if (
        nextRun.status !== refreshed.status ||
        nextRun.startedAt !== refreshed.startedAt ||
        nextRun.finishedAt !== refreshed.finishedAt ||
        nextRun.lastError !== refreshed.lastError
      ) {
        this.options.db.updateParallelSolverRun(refreshed.id, nextRun);
      }
    }
  }

  private failurePoolEntries(input: ParallelFailurePoolPreviewRequest): ParallelFailurePoolEntry[] {
    const datasetName = input.datasetName?.trim()
      || datasetNameFromRangePath(input.rangePath);
    const entries = this.options.db.getParallelFailurePoolEntries(input.rangePath, datasetName)
      .filter((entry) =>
        (entry.status === "pending" || entry.status === "failed") &&
        failureReasonIsRetryable(entry.failureReason)
      );
    const selected = input.indices?.length
      ? new Set(normalizePositiveIndices(input.indices))
      : null;
    return entries
      .filter((entry) => selected == null || selected.has(entry.boardIndex));
  }

  private restoreFailurePoolEntries(rangePath: string, datasetName: string, indices: number[]): void {
    const selected = new Set(indices);
    const entries = this.options.db.getParallelFailurePoolEntries(rangePath, datasetName)
      .filter((entry) => selected.has(entry.boardIndex));
    this.options.db.updateParallelFailurePoolEntries(
      rangePath,
      datasetName,
      entries.filter((entry) => entry.failureReason !== "best_server_skipped").map((entry) => entry.boardIndex),
      "pending"
    );
    this.options.db.updateParallelFailurePoolEntries(
      rangePath,
      datasetName,
      entries.filter((entry) => entry.failureReason === "best_server_skipped").map((entry) => entry.boardIndex),
      "failed"
    );
  }

  private async reconcileFailurePoolCoverage(
    repoId: string,
    rangePath: string,
    datasetName: string,
    allBoards: string[]
  ): Promise<ParallelSolverCoverageSummary> {
    const runs = this.options.db.getParallelSolverRuns();
    const remoteBoardKeys = await this.cachedRemoteBoardKeys(repoId);
    const remoteCovered = new Set(collectRemoteCoveredBoardIndices(allBoards, remoteBoardKeys));
    const historicallyCompleted = new Set(collectHistoricallyCompletedBoardIndices(runs, datasetName, rangePath));
    const queued = new Set<number>();
    const running = new Set<number>();
    for (const run of runs) {
      if (run.datasetName !== datasetName || run.rangePath !== rangePath) continue;
      if (run.status !== "queued" && run.status !== "running") continue;
      for (const slice of run.slices) {
        if (slice.status !== "queued" && slice.status !== "running") continue;
        const target = slice.status === "running" ? running : queued;
        for (const index of slice.assignedIndices) target.add(index);
      }
    }

    const poolEntries = this.options.db.getParallelFailurePoolEntries(rangePath, datasetName);
    const solvedIndices = poolEntries
      .filter((entry) => remoteCovered.has(entry.boardIndex) || historicallyCompleted.has(entry.boardIndex))
      .map((entry) => entry.boardIndex);
    const solved = new Set(solvedIndices);
    const runningIndices = poolEntries
      .filter((entry) => !solved.has(entry.boardIndex) && running.has(entry.boardIndex))
      .map((entry) => entry.boardIndex);
    const queuedIndices = poolEntries
      .filter((entry) => !solved.has(entry.boardIndex) && !running.has(entry.boardIndex) && queued.has(entry.boardIndex))
      .map((entry) => entry.boardIndex);
    this.options.db.updateParallelFailurePoolEntries(rangePath, datasetName, solvedIndices, "solved");
    this.options.db.updateParallelFailurePoolEntries(rangePath, datasetName, runningIndices, "running");
    this.options.db.updateParallelFailurePoolEntries(rangePath, datasetName, queuedIndices, "queued");

    return computeMissingSolveBoardIndices({
      allBoards,
      remoteBoardKeys,
      runs,
      datasetName,
      rangePath,
      failurePoolEntries: this.options.db.getParallelFailurePoolEntries(rangePath, datasetName)
    }).coverage;
  }

  private recordCanceledSliceFailures(run: ParallelSolverRun, slice: ParallelSolverSlice): void {
    const completed = new Set(
      (slice.job?.pipeline?.completedIndices ?? []).filter((index) => slice.assignedIndices.includes(index))
    );
    const now = new Date().toISOString();
    slice.assignedIndices.forEach((index, position) => {
      if (completed.has(index)) return;
      const boardName = slice.assignedBoardNames[position] ?? String(index);
      this.options.db.upsertParallelFailurePoolEntry({
        id: randomUUID(),
        rangePath: run.rangePath,
        datasetName: run.datasetName,
        repoId: run.repoId,
        scenario: run.scenario,
        boardIndex: index,
        boardName,
        boardKey: boardKeyFromName(boardName),
        status: "pending",
        failureReason: "abnormal_end",
        attemptCount: 1,
        lastRunId: run.id,
        lastSliceId: slice.id,
        lastServerId: slice.serverId || null,
        lastError: "Parallel run canceled before this board completed.",
        createdAt: now,
        updatedAt: now
      });
    });
  }

  private reconcileCompletedJobs(): void {
    this.options.db.runInPersistenceBatch(() => {
      this.reconcileStartedJobsFromPipelines();
      for (const job of this.options.db.getSolverJobsByStatuses([...ACTIVE_JOB_STATUSES])) {
        if (!job.pipeline || !pipelineIsNewEnoughForJob(job.pipeline, job)) continue;
        if (isPipelineActive(job.pipeline) && pipelineBelongsToJob(job.pipeline, job)) continue;
        if (!pipelineCanSettleActiveJob(job.pipeline, job)) continue;
        const belongsToJob = pipelineBelongsToJob(job.pipeline, job);
        const nextStatus = belongsToJob ? completedStatusFromPipeline(job.pipeline) : "failed";
        const lastError = nextStatus === "failed" ? pipelineReconciliationError(job.pipeline, job) : null;
        const clearedDispatchFailures = belongsToJob && job.queueMode === "parallel"
          ? this.options.db.resolveParallelDispatchFailuresForServer(job.serverId)
          : 0;
        this.options.db.updateSolverJob(job.id, {
          status: nextStatus,
          finishedAt: belongsToJob
            ? job.pipeline?.finishedAt ?? new Date().toISOString()
            : new Date().toISOString(),
          lastError,
          pipeline: belongsToJob ? job.pipeline : null
        });
        this.recordEvent(job.id, nextStatus, `Server task reconciled job as ${nextStatus}.`, null);
        if (clearedDispatchFailures > 0) {
          this.recordEvent(
            job.id,
            "dispatch_quarantine_cleared",
            `Verified solver ownership on ${job.serverId}; cleared ${clearedDispatchFailures} dispatch quarantine record(s).`,
            null
          );
        }
        if (!belongsToJob && lastError) {
          this.requeueParallelSliceAfterUnownedLaunch(job, lastError);
        }
      }
    });
  }

  private requeueParallelSliceAfterUnownedLaunch(
    job: SolverJob,
    lastError: string,
    failureKind: ParallelDispatchFailureRecord["failureKind"] = "launch_unowned"
  ): void {
    if (job.queueMode !== "parallel" || !job.parallelSliceId) return;
    const slice = this.options.db.getParallelSolverSlice(job.parallelSliceId);
    if (!slice || slice.status === "completed" || slice.status === "failed" || slice.status === "canceled") return;
    const failedAt = new Date().toISOString();
    this.options.db.insertParallelDispatchFailure({
      id: randomUUID(),
      serverId: job.serverId,
      runId: slice.runId,
      sliceId: slice.id,
      jobId: job.id,
      failureKind,
      error: lastError,
      failedAt,
      resolvedAt: null
    });
    const quarantine = buildParallelDispatchSafetyState(
      this.options.db.getUnresolvedParallelDispatchFailures(),
      Date.parse(failedAt)
    ).activeQuarantines.get(job.serverId);
    const blockedUntil = quarantine?.blockedUntil ?? failedAt;
    this.options.db.updateParallelSolverSlice(slice.id, {
      serverId: "",
      jobId: null,
      status: "queued",
      completedCount: 0,
      failedCount: 0,
      startedAt: null,
      finishedAt: null,
      lastError: `Launch on ${job.serverId} did not take ownership. Chunk remains queued for another healthy server; ${job.serverId} is quarantined until ${blockedUntil}. ${lastError}`
    });
    this.recordEvent(
      job.id,
      "launch_server_quarantined",
      `Parallel chunk returned to the queue without being counted as a board failure. Server ${job.serverId} is quarantined until ${blockedUntil}; retry must use another healthy server.`,
      null
    );
  }

  private failAndRequeueParallelDispatch(
    job: SolverJob,
    lastError: string,
    failureKind: ParallelDispatchFailureRecord["failureKind"] = "dispatch_failed"
  ): SolverJob {
    return this.options.db.runInPersistenceBatch(() => {
      const failed = this.options.db.updateSolverJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        lastError,
        pipeline: null
      });
      this.recordEvent(job.id, "dispatch_failed", lastError, null);
      this.requeueParallelSliceAfterUnownedLaunch(failed, lastError, failureKind);
      return this.options.db.getSolverJob(job.id) ?? failed;
    });
  }

  private async refreshUnconfirmedActiveJobPipelines(): Promise<void> {
    if (!this.options.credentials) return;
    const now = Date.now();
    const servers = new Map(this.options.db.getServerRows().map((server) => [server.id, server]));
    const jobs = this.options.db.getSolverJobsByStatuses([...ACTIVE_JOB_STATUSES]).filter((job) => {
      const reference = Date.parse(job.startedAt ?? job.updatedAt ?? job.createdAt);
      if (!Number.isFinite(reference) || now - reference < ACTIVE_JOB_RECONCILE_GRACE_MS) return false;
      return !job.pipeline ||
        !pipelineIsNewEnoughForJob(job.pipeline, job) ||
        job.pipeline.displayStatus === "unavailable";
    });

    await Promise.all(jobs.map(async (job) => {
      const server = servers.get(job.serverId);
      if (!server?.enabled || !serverIsSshReady(server)) return;
      const statusFilePath = server.pipelineStatusFilePath?.trim() || this.defaultPipelineStatusFilePath;
      const snapshot = await collectServerPipelineStatus(
        server,
        this.options.credentials!,
        statusFilePath,
        this.executor
      );
      this.options.db.insertPipelineSnapshot(snapshot);
    }));
  }

  private reconcileStartedJobsFromPipelines(): void {
    for (const job of this.options.db.getSolverJobsByStatuses(["queued", "deploying"])) {
      if (!job.pipeline || !pipelineBelongsToJob(job.pipeline, job) || !isPipelineActive(job.pipeline)) continue;
      const startedAt = job.startedAt ?? job.pipeline.startedAt ?? job.pipeline.collectedAt ?? new Date().toISOString();
      const clearedDispatchFailures = job.queueMode === "parallel"
        ? this.options.db.resolveParallelDispatchFailuresForServer(job.serverId, startedAt)
        : 0;
      this.options.db.updateSolverJob(job.id, {
        status: "running",
        startedAt,
        finishedAt: null,
        lastError: null
      });
      this.recordEvent(
        job.id,
        "running_reconciled",
        `Server inventory reports ${job.datasetName} is running on ${job.serverId}.`,
        null
      );
      if (clearedDispatchFailures > 0) {
        this.recordEvent(
          job.id,
          "dispatch_quarantine_cleared",
          `Verified solver ownership on ${job.serverId}; cleared ${clearedDispatchFailures} dispatch quarantine record(s).`,
          null
        );
      }
    }
  }

  private requireServer(serverId: string): ServerRow {
    const server = this.options.db.getServerRows().find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    return server;
  }

  private requireJob(id: string): SolverJob {
    const job = this.options.db.getSolverJob(id);
    if (!job) {
      throw new Error(`Solver job ${id} not found`);
    }
    return job;
  }

  private requireServerOperation(id: string): ServerOperation {
    const operation = this.options.db.getServerOperation(id);
    if (!operation) {
      throw new Error(`Server operation ${id} not found`);
    }
    return operation;
  }

  private operationTargetServers(serverIds?: string[]): ServerRow[] {
    const servers = sortServersByNaturalId(this.options.db.getServerRows())
      .filter((server) => server.enabled && server.latest?.connectionStatus === "online");
    const requested = uniqueStringList(serverIds ?? []);
    if (requested.length === 0) return servers;
    const byId = new Map(servers.map((server) => [server.id, server]));
    return requested.map((id) => {
      const server = byId.get(id);
      if (!server) throw new Error(`Server ${id} is not online or enabled.`);
      return server;
    });
  }

  private prepareServerOperation(
    server: ServerRow,
    type: ServerOperation["type"],
    create: (id: string) => ServerOperation
  ): ServerOperation | null {
    const current = this.options.db.getLatestServerOperation(server.id, type);
    if (current && ACTIVE_SERVER_OPERATION_STATUSES.has(current.status)) return null;
    // Each execution owns a unique tmux session and status path. Reusing an
    // earlier operation ID lets its terminal status file masquerade as the
    // outcome of a new command that has not actually started yet.
    return create(randomUUID());
  }

  private createSyncOperation(server: ServerRow, id: string = randomUUID()): ServerOperation {
    const solverRoot = effectiveSolverRoot(server);
    const paths = serverOperationPaths(id);
    const body = buildServerSyncCommand({
      solverRoot,
      proxyUrl: this.effectiveRemoteOperationProxyUrl()
    });
    const command = buildTrackedServerOperationCommand({
      id,
      type: "sync",
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      bodyCommand: body
    });
    const now = new Date().toISOString();
    return {
      id,
      type: "sync",
      serverId: server.id,
      status: "queued",
      tmuxSession: `sync-${safeTmuxName(server.id)}-${id.slice(0, 8)}`,
      command,
      items: [{ serverId: server.id, solverRoot }],
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      result: null
    };
  }

  private createNetworkSyncOperation(server: ServerRow, id: string = randomUUID()): ServerOperation {
    const solverRoot = effectiveSolverRoot(server);
    const paths = serverOperationPaths(id);
    const body = buildServerNetworkSyncCommand({
      giteeUsername: this.giteeUsername,
      giteeToken: this.giteeToken,
      redactSecrets: true
    });
    const command = buildTrackedServerOperationCommand({
      id,
      type: "network_sync",
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      bodyCommand: body
    });
    const now = new Date().toISOString();
    return {
      id,
      type: "network_sync",
      serverId: server.id,
      status: "queued",
      tmuxSession: `network-sync-${safeTmuxName(server.id)}-${id.slice(0, 8)}`,
      command,
      items: [{ serverId: server.id, solverRoot }],
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      result: null
    };
  }

  private createNetworkCheckOperation(server: ServerRow, id: string = randomUUID()): ServerOperation {
    const solverRoot = effectiveSolverRoot(server);
    const paths = serverOperationPaths(id);
    const body = buildServerNetworkCheckCommand(this.effectiveRemoteOperationProxyUrl());
    const command = buildTrackedServerOperationCommand({
      id,
      type: "network_check",
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      bodyCommand: body
    });
    const now = new Date().toISOString();
    return {
      id,
      type: "network_check",
      serverId: server.id,
      status: "queued",
      tmuxSession: `network-check-${safeTmuxName(server.id)}-${id.slice(0, 8)}`,
      command,
      items: [{ serverId: server.id, solverRoot }],
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      result: null
    };
  }

  private createUploadOperation(
    server: ServerRow,
    items: ServerUploadItem[],
    initialResult: ServerOperationResult | null = null,
    id: string = randomUUID()
  ): ServerOperation {
    const solverRoot = effectiveSolverRoot(server);
    const paths = serverOperationPaths(id);
    const body = buildServerUploadCommand({
      solverRoot,
      hfToken: this.hfToken,
      proxyUrl: this.effectiveRemoteOperationProxyUrl(),
      redactSecrets: false
    });
    const command = buildTrackedServerOperationCommand({
      id,
      type: "upload",
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      bodyCommand: body
    });
    const now = new Date().toISOString();
    return {
      id,
      type: "upload",
      serverId: server.id,
      status: "queued",
      tmuxSession: `upload-${safeTmuxName(server.id)}-${id.slice(0, 8)}`,
      command,
      items,
      statusFilePath: paths.statusFilePath,
      logFilePath: paths.logFilePath,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      result: initialResult
    };
  }

  private async runServerOperationSsh(
    server: ServerRow,
    command: string,
    operation?: ServerOperation,
    credentials: SshCredentials = this.options.credentials!,
    stdin?: string
  ): Promise<string> {
    try {
      return await this.executor.run(server, credentials, command, stdin);
    } catch (error) {
      if (!isSshHandshakeTimeout(error)) throw error;
      const delayMs = this.serverOperationHandshakeRetryDelayMs === 0
        ? 0
        : this.serverOperationHandshakeRetryDelayMs + stableServerRetryJitter(server.id);
      if (operation) {
        this.recordOperationEvent(
          operation.id,
          "handshake_retry",
          `SSH handshake timed out before the command was sent; retrying once in ${delayMs} ms.`,
          null
        );
      }
      if (delayMs > 0) await waitFor(delayMs);
      return this.executor.run(server, credentials, command, stdin);
    }
  }

  private async startServerOperation(operation: ServerOperation, server: ServerRow, executionCommand = operation.command): Promise<void> {
    this.options.db.updateServerOperation(operation.id, { status: "deploying", lastError: null });
    this.recordOperationEvent(operation.id, "deploying", `Starting ${operation.type} tmux session ${operation.tmuxSession}.`, null);
    try {
      if (operation.type === "upload") {
        // Operations can survive a process restart and predate the current
        // collision policy.  Re-check immediately before staging any remote
        // command so retained uploads cannot silently reuse an ambiguous repo.
        this.ensureRetainedUploadItemsSafe(
          normalizeUploadItems(operation.items.filter(isServerUploadOperationItem))
        );
      }
      let commandFilePath: string | undefined;
      if (operation.type === "upload") {
        commandFilePath = serverOperationCommandPath(operation.id);
        const plan = buildServerUploadPlan(normalizeUploadItems(operation.items.filter(isServerUploadOperationItem)));
        await this.runServerOperationSsh(
          server,
          buildStageServerOperationFileCommand(serverOperationPlanPath(operation.id)),
          operation,
          this.options.credentials!,
          plan
        );
      }
      if (commandFilePath) {
        await this.runServerOperationSsh(
          server,
          buildStageServerOperationFileCommand(commandFilePath),
          operation,
          this.options.credentials!,
          executionCommand
        );
      }
      await this.runServerOperationSsh(
        server,
        buildServerOperationTmuxStartCommand(operation, effectiveSolverRoot(server), executionCommand, commandFilePath),
        operation
      );
      const now = new Date().toISOString();
      this.options.db.updateServerOperation(operation.id, {
        status: "running",
        startedAt: now,
        finishedAt: null,
        lastError: null,
        updatedAt: now
      });
      this.recordOperationEvent(operation.id, "started", `Started ${operation.tmuxSession}.`, operation.command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.db.updateServerOperation(operation.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        lastError: message
      });
      this.recordOperationEvent(operation.id, "failed", message, null);
    }
  }

  private launchServerOperation(
    operation: ServerOperation,
    server: ServerRow,
    executionCommand = operation.command
  ): Promise<void> {
    const current = this.serverOperationStartTasks.get(operation.id);
    if (current) return current;
    const task = this.startServerOperation(operation, server, executionCommand)
      .finally(() => {
        if (this.serverOperationStartTasks.get(operation.id) === task) {
          this.serverOperationStartTasks.delete(operation.id);
        }
      });
    this.serverOperationStartTasks.set(operation.id, task);
    return task;
  }

  private async reconcileServerOperations(): Promise<void> {
    if (this.serverOperationReconciliationTask) {
      return this.serverOperationReconciliationTask;
    }
    const task = this.runServerOperationReconciliation();
    this.serverOperationReconciliationTask = task;
    try {
      await task;
    } finally {
      if (this.serverOperationReconciliationTask === task) {
        this.serverOperationReconciliationTask = null;
      }
    }
  }

  private async runServerOperationReconciliation(): Promise<void> {
    this.initializeAutomaticUploadMonitor();
    const activeOperations = this.options.db.getServerOperations()
      .filter((operation) => ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status));
    const credentials = this.options.credentials;
    const servers = new Map(this.options.db.getServerRows().map((server) => [server.id, server]));
    if (credentials && activeOperations.length > 0) {
      await forEachWithConcurrency(activeOperations, SERVER_OPERATION_SSH_CONCURRENCY, async (operation) => {
      const server = servers.get(operation.serverId);
      if (!server || server.latest?.connectionStatus !== "online") return;
      if (operation.status === "queued") {
        try {
          const executionCommand = operation.type === "upload"
            ? this.buildUploadOperationExecutionCommand(operation, server)
            : operation.command;
          await this.launchServerOperation(operation, server, executionCommand);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.options.db.updateServerOperation(operation.id, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            lastError: message
          });
          this.recordOperationEvent(operation.id, "failed", message, null);
        }
        return;
      }
      try {
        const output = await this.runServerOperationSsh(
          server,
          buildReadServerOperationStatusCommand(operation.statusFilePath, operation.tmuxSession),
          operation,
          credentials
        );
        const probe = parseRemoteOperationProbe(output);
        const status = probe.status?.id === operation.id ? probe.status : null;
        if (status?.status === "completed" || status?.status === "failed") {
          this.options.db.updateServerOperation(operation.id, {
            status: status.status,
            startedAt: status.startedAt ?? operation.startedAt,
            finishedAt: status.finishedAt ?? new Date().toISOString(),
            lastError: status.status === "failed" ? status.error ?? `Exit code ${status.exitCode ?? "unknown"}` : null,
            result: status.result,
            updatedAt: status.updatedAt ?? new Date().toISOString()
          });
          this.recordOperationEvent(
            operation.id,
            status.status,
            status.status === "completed" ? "Remote operation completed." : "Remote operation failed.",
            output
          );
          if (status.status === "completed" && operation.type === "sync") {
            const cleared = this.options.db.resolveParallelDispatchFailuresForServer(
              operation.serverId,
              new Date().toISOString(),
              ["validation_failed"]
            );
            if (cleared > 0) {
              this.recordOperationEvent(
                operation.id,
                "dispatch_validation_cleared",
                `Successful Code Sync cleared ${cleared} incompatible-solver dispatch record(s).`,
                null
              );
            }
          }
          return;
        }
        if (!probe.tmuxAlive) {
          const operationAgeMs = Date.now() - Date.parse(operation.createdAt);
          if (!probe.statusFileExists && Number.isFinite(operationAgeMs) && operationAgeMs < 60_000) {
            return;
          }
          if (operation.type === "upload" && operation.status === "deploying" && !probe.statusFileExists) {
            await this.launchServerOperation(
              operation,
              server,
              this.buildUploadOperationExecutionCommand(operation, server)
            );
            return;
          }
          const message = probe.statusFileExists
            ? `Remote tmux session ${operation.tmuxSession} is no longer running; the server may have restarted.`
            : `Remote operation state and tmux session ${operation.tmuxSession} are missing; the server may have restarted.`;
          this.options.db.updateServerOperation(operation.id, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            lastError: message
          });
          this.recordOperationEvent(operation.id, "orphaned", message, null);
          return;
        }
        if (status?.status === "running") {
          const nextResult = status.result ?? operation.result;
          const shouldUpdate = operation.status !== "running" ||
            operation.startedAt !== (status.startedAt ?? operation.startedAt) ||
            serverOperationProgressFingerprint(nextResult) !== serverOperationProgressFingerprint(operation.result);
          if (shouldUpdate) {
            this.options.db.updateServerOperation(operation.id, {
              status: "running",
              startedAt: status.startedAt ?? operation.startedAt,
              lastError: null,
              result: nextResult,
              updatedAt: status.updatedAt ?? new Date().toISOString()
            });
          }
        }
      } catch {
        // A transient SSH failure must not erase an active operation.
      }
      });
    }
    await this.reconcileAutomaticUploadFollowups(servers);
  }

  private initializeAutomaticUploadMonitor(): void {
    if (this.automaticUploadMonitorInitialized) return;
    for (const operation of this.options.db.getServerOperations()) {
      if (operation.type === "upload" && !ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status)) {
        this.automaticUploadHandledOperationIds.add(operation.id);
      }
    }
    this.automaticUploadMonitorInitialized = true;
  }

  private async reconcileAutomaticUploadFollowups(servers: Map<string, ServerRow>): Promise<void> {
    if (!this.options.credentials || !this.hfToken) return;

    for (const operation of this.options.db.getServerOperations()) {
      if (
        operation.type !== "upload" ||
        (operation.status !== "completed" && operation.status !== "failed") ||
        this.automaticUploadHandledOperationIds.has(operation.id)
      ) {
        continue;
      }
      this.automaticUploadHandledOperationIds.add(operation.id);
      const existing = this.automaticUploadFollowups.get(operation.serverId);
      if (existing?.operationId && ACTIVE_SERVER_OPERATION_STATUSES.has(
        this.options.db.getServerOperation(existing.operationId)?.status ?? "failed"
      )) {
        continue;
      }
      this.automaticUploadFollowups.set(operation.serverId, {
        serverId: operation.serverId,
        sourceOperationId: operation.id,
        phase: "scan",
        operationId: null,
        retryCount: 0,
        retryAtMs: Date.now(),
        networkRecoveryAttempted: false
      });
      this.recordOperationEvent(
        operation.id,
        "auto_upload_followup_queued",
        `Upload ${operation.status}; queued an automatic retained-result scan for server ${operation.serverId}.`,
        null
      );
    }

    await forEachWithConcurrency(
      [...this.automaticUploadFollowups.values()],
      SERVER_OPERATION_SSH_CONCURRENCY,
      async (followup) => {
        if (followup.retryAtMs > Date.now()) return;
        const server = servers.get(followup.serverId);
        if (!server?.enabled || !serverIsOnline(server)) {
          this.deferAutomaticUploadFollowup(followup, `Server ${followup.serverId} is not SSH-ready.`);
          return;
        }
        if (followup.phase === "network_sync") {
          this.reconcileAutomaticNetworkSync(followup);
          return;
        }
        if (followup.phase === "upload") {
          this.reconcileAutomaticUploadOperation(followup);
          return;
        }
        await this.runAutomaticUploadScan(followup, server);
      }
    );
  }

  private reconcileAutomaticNetworkSync(followup: AutomaticUploadFollowup): void {
    const operation = followup.operationId ? this.options.db.getServerOperation(followup.operationId) : null;
    if (operation && ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status)) return;
    if (operation?.status === "completed") {
      followup.phase = "scan";
      followup.operationId = null;
      followup.retryCount = 0;
      followup.retryAtMs = Date.now();
      this.recordOperationEvent(
        followup.sourceOperationId,
        "auto_network_sync_completed",
        `Network Sync completed on server ${followup.serverId}; connectivity will be verified before upload.`,
        null
      );
      return;
    }
    this.deferAutomaticUploadFollowup(
      followup,
      operation?.lastError ?? `Network Sync did not complete on server ${followup.serverId}.`
    );
    followup.phase = "scan";
    followup.operationId = null;
  }

  private reconcileAutomaticUploadOperation(followup: AutomaticUploadFollowup): void {
    const operation = followup.operationId ? this.options.db.getServerOperation(followup.operationId) : null;
    if (operation && ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status)) return;
    if (operation?.status === "canceled") {
      this.automaticUploadFollowups.delete(followup.serverId);
      return;
    }
    followup.phase = "scan";
    followup.operationId = null;
    followup.retryAtMs = Date.now();
    if (operation?.status === "completed" || operation?.result?.summary.upload_success) {
      followup.retryCount = 0;
    } else {
      this.deferAutomaticUploadFollowup(
        followup,
        operation?.lastError ?? `Automatic upload did not complete on server ${followup.serverId}.`
      );
    }
  }

  private async runAutomaticUploadScan(followup: AutomaticUploadFollowup, server: ServerRow): Promise<void> {
    try {
      const latestUpload = this.options.db.getLatestServerOperation(server.id, "upload");
      if (latestUpload && ACTIVE_SERVER_OPERATION_STATUSES.has(latestUpload.status)) {
        followup.phase = "upload";
        followup.operationId = latestUpload.id;
        this.automaticUploadHandledOperationIds.add(latestUpload.id);
        return;
      }

      const scan = await this.scanUploadCandidates(server.id);
      const sourceOperation = this.options.db.getServerOperation(followup.sourceOperationId);
      const scannedItems = normalizeUploadItems(scan.candidates.flatMap(serverUploadItemsFromCandidate));
      const sourceItems = normalizeUploadItems(
        sourceOperation?.items.filter(isServerUploadOperationItem)
      );
      const items = sourceItems.length > 0
        ? retainUploadItemsFromSource(scannedItems, sourceItems)
        : scannedItems;
      if (items.length === 0) {
        this.recordOperationEvent(
          followup.sourceOperationId,
          "auto_upload_scan_empty",
          `Automatic scan found no retained result files on server ${server.id}.`,
          null
        );
        this.automaticUploadFollowups.delete(server.id);
        return;
      }

      const networkRecoveryRequired = sourceOperation?.result?.summary.network_recovery_required;
      if (
        !followup.networkRecoveryAttempted &&
        (networkRecoveryRequired === true || networkRecoveryRequired === 1)
      ) {
        followup.networkRecoveryAttempted = true;
        await this.startAutomaticNetworkSync(
          followup,
          server,
          "the upload watchdog detected a stalled or interrupted Hugging Face transfer"
        );
        return;
      }

      const connectivityOutput = await this.runServerOperationSsh(
        server,
        buildServerHfConnectivityProbeCommand(this.effectiveRemoteOperationProxyUrl())
      );
      const connectivity = parseServerHfConnectivityProbe(connectivityOutput);
      if (!connectivity.connected) {
        await this.startAutomaticNetworkSync(followup, server, connectivity.reason);
        return;
      }

      await this.startUploadOperation({ serverId: server.id, items });
      const operation = this.options.db.getLatestServerOperation(server.id, "upload");
      if (!operation || !ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status)) {
        throw new Error(`Automatic upload was not created for server ${server.id}.`);
      }
      this.automaticUploadHandledOperationIds.add(operation.id);
      followup.phase = "upload";
      followup.operationId = operation.id;
      followup.retryAtMs = Date.now();
      this.recordOperationEvent(
        followup.sourceOperationId,
        "auto_upload_started",
        `Automatic scan found ${items.length} upload item(s); started ${operation.id} on server ${server.id}.`,
        null
      );
    } catch (error) {
      this.deferAutomaticUploadFollowup(
        followup,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async startAutomaticNetworkSync(
    followup: AutomaticUploadFollowup,
    server: ServerRow,
    reason: string
  ): Promise<void> {
    const active = this.options.db.getLatestServerOperation(server.id, "network_sync");
    if (active && ACTIVE_SERVER_OPERATION_STATUSES.has(active.status)) {
      followup.phase = "network_sync";
      followup.operationId = active.id;
      return;
    }
    await this.startNetworkSyncOperations({ serverIds: [server.id] });
    const operation = this.options.db.getLatestServerOperation(server.id, "network_sync");
    if (!operation || !ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status)) {
      throw new Error(`Network Sync was not created for server ${server.id}.`);
    }
    followup.phase = "network_sync";
    followup.operationId = operation.id;
    followup.retryAtMs = Date.now();
    this.recordOperationEvent(
      followup.sourceOperationId,
      "auto_network_sync_started",
      `Hugging Face connectivity failed on server ${server.id} (${reason}); started Network Sync ${operation.id}.`,
      null
    );
  }

  private deferAutomaticUploadFollowup(followup: AutomaticUploadFollowup, reason: string): void {
    followup.retryCount += 1;
    const delayMs = Math.min(
      AUTOMATIC_UPLOAD_RETRY_MAX_MS,
      AUTOMATIC_UPLOAD_RETRY_BASE_MS * (2 ** Math.min(5, followup.retryCount - 1))
    );
    followup.retryAtMs = Date.now() + delayMs;
    this.recordOperationEvent(
      followup.sourceOperationId,
      "auto_upload_deferred",
      `Automatic upload follow-up for server ${followup.serverId} will retry in ${Math.round(delayMs / 1000)}s: ${reason}`,
      null
    );
  }

  private buildUploadOperationExecutionCommand(operation: ServerOperation, server: ServerRow): string {
    return buildTrackedServerOperationCommand({
      id: operation.id,
      type: operation.type,
      statusFilePath: operation.statusFilePath,
      logFilePath: operation.logFilePath,
      bodyCommand: buildServerUploadCommand({
        solverRoot: effectiveSolverRoot(server),
        hfToken: this.hfToken,
        proxyUrl: this.effectiveRemoteOperationProxyUrl(),
        redactSecrets: false
      })
    });
  }

  private ensureNoActiveJob(serverId: string, exceptJobId?: string): void {
    const active = this.options.db.getActiveSolverJobForServer(serverId, exceptJobId);
    if (active) {
      throw new Error(`Server already has active job ${active.datasetName}`);
    }
  }

  private ensureJobServerOnline(job: SolverJob): void {
    this.ensureServerOnline(this.requireServer(job.serverId));
  }

  private ensureServerOnline(server: ServerRow): void {
    if (!serverIsOnline(server)) {
      const status = connectionDisplayStatus(server.latest, server.pipeline);
      throw new Error(`Server ${server.id} is ${status}; job operations require an SSH-ready server.`);
    }
  }

  private ensureCredentials(): void {
    if (!this.options.credentials) {
      throw new Error("SSH credentials are required for solver job execution.");
    }
  }

  private buildExecutionCommand(job: SolverJob, server: ServerRow = this.requireServer(job.serverId)): string {
    return buildRunPipelineCommand({
      solverRoot: effectiveSolverRoot(server),
      repoId: job.repoId,
      scenario: job.scenario,
      setting: job.setting,
      settingPath: settingFilePathFromCommand(job.command) ?? undefined,
      rangePath: job.remoteRangePath,
      resultPath: job.remoteResultPath,
      settings: job.settings,
      statusFilePath: statusFileFromJob(job),
      hfToken: this.hfToken,
      hfProxyUrl: this.effectiveSolverHfProxyUrl()
    });
  }

  private async startQueuedJobIfDispatchReady(job: SolverJob): Promise<boolean> {
    if (job.status !== "queued") return false;
    try {
      this.ensureDatasetNameAvailable(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("Dataset collision:")) throw error;
      this.options.db.updateSolverJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        lastError: message
      });
      this.recordEvent(job.id, "dataset_collision", message, null);
      return false;
    }
    const server = this.requireServer(job.serverId);
    if (!server.enabled) {
      this.markJobDispatchPending(job, `Dispatch pending: server ${server.id} is disabled.`);
      return false;
    }
    if (!serverIsOnline(server)) {
      const status = connectionDisplayStatus(server.latest, server.pipeline);
      this.markJobDispatchPending(job, `Dispatch pending: server ${server.id} is ${status}.`);
      return false;
    }

    const active = this.options.db.getActiveSolverJobForServer(server.id, job.id);
    if (active) {
      this.markJobDispatchPending(job, `Dispatch pending: server ${server.id} is running ${active.datasetName}.`);
      return false;
    }

    this.ensureCredentials();
    let dispatchJob = job;
    try {
      let preflight = await this.runDispatchPreflight(dispatchJob, server);
      if (!preflight.ready && this.canFallbackToNoUpload(dispatchJob, preflight)) {
        dispatchJob = this.fallbackJobToNoUpload(dispatchJob, server, preflight);
        preflight = await this.runDispatchPreflight(dispatchJob, server);
      }
      if (!preflight.ready) {
        if (
          dispatchJob.queueMode === "parallel" &&
          dispatchJob.parallelSliceId &&
          (preflight.reasonCode === "setting_file_unsupported" ||
            preflight.reasonCode === "solver_python_unavailable")
        ) {
          const reason = preflight.reason ?? "remote solver runtime validation failed";
          this.failAndRequeueParallelDispatch(
            dispatchJob,
            `Parallel dispatch validation failed on ${server.id}: ${reason}`,
            "validation_failed"
          );
          return false;
        }
        this.markJobDispatchPending(
          dispatchJob,
          `Dispatch pending: server ${server.id} is not ready${preflight.reason ? ` (${preflight.reason})` : ""}.`
        );
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markJobDispatchPending(dispatchJob, `Dispatch pending: SSH preflight failed for ${server.id}: ${message}`);
      return false;
    }

    try {
      const started = await this.start(dispatchJob.id, { deferOnDispatchFailure: true, preflightChecked: true });
      return started.status === "running";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Dataset collision:")) {
        const failed = this.options.db.updateSolverJob(dispatchJob.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          lastError: message
        });
        this.recordEvent(failed.id, "dataset_collision", message, null);
        return false;
      }
      this.markJobDispatchPending(dispatchJob, `Dispatch pending: ${message}`);
      return false;
    }
  }

  private async runDispatchPreflight(job: SolverJob, server: ServerRow): Promise<DispatchPreflightResult> {
    const proxyUrl = this.dispatchProxyUrl(job);
    const output = await this.executor.run(
      server,
      this.options.credentials!,
      buildDispatchPreflightCommand(statusFileFromJob(job), proxyUrl, {
        solverRoot: effectiveSolverRoot(server),
        requireSettingFile: Boolean(settingFilePathFromCommand(job.command))
      })
    );
    return parseDispatchPreflightOutput(output);
  }

  private dispatchProxyUrl(job: SolverJob): string | null {
    return job.settings.uploadEnabled ? this.effectiveSolverHfProxyUrl() : null;
  }

  private canFallbackToNoUpload(job: SolverJob, preflight: DispatchPreflightResult): boolean {
    if (job.queueMode !== "parallel" || !job.settings.uploadEnabled) return false;
    if (preflight.reasonCode === "mihomo_missing" ||
        preflight.reasonCode === "curl_missing" ||
        preflight.reasonCode === "hugging_face_unreachable") {
      return true;
    }
    return /mihomo|hugging face|proxy|curl/i.test(preflight.reason ?? "");
  }

  private fallbackJobToNoUpload(
    job: SolverJob,
    server: ServerRow,
    preflight: DispatchPreflightResult
  ): SolverJob {
    const settings: SolverJobSettings = { ...job.settings, uploadEnabled: false };
    const command = buildRunPipelineCommand({
      solverRoot: effectiveSolverRoot(server),
      repoId: job.repoId,
      scenario: job.scenario,
      setting: job.setting,
      settingPath: settingFilePathFromCommand(job.command) ?? undefined,
      rangePath: job.remoteRangePath,
      resultPath: job.remoteResultPath,
      settings,
      statusFilePath: statusFileFromJob(job),
      hfToken: this.hfToken,
      hfProxyUrl: this.effectiveSolverHfProxyUrl(),
      redactSecrets: true
    });
    const reason = preflight.reason ?? preflight.reasonCode ?? "upload network preflight failed";
    const message = `Upload unavailable on ${server.id} (${reason}); dispatching solver with --no-upload.`;
    const updated = this.options.db.updateSolverJob(job.id, {
      settings,
      command,
      lastError: null
    });
    this.recordEvent(job.id, "upload_fallback", message, command);
    return updated;
  }

  private markJobDispatchPending(job: SolverJob, message: string): SolverJob {
    const current = this.options.db.getSolverJob(job.id) ?? job;
    if (current.lastError !== message || current.status !== "queued") {
      this.recordEvent(job.id, "dispatch_pending", message, null);
    }
    return this.options.db.updateSolverJob(job.id, {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      lastError: message
    });
  }

  private async assignAndStartNextParallelSliceIfReady(
    server: ServerRow,
    dispatchSafety: ParallelDispatchSafetyState
  ): Promise<boolean> {
    if (!server.enabled || !serverIsOnline(server)) return false;
    if (dispatchSafety.activeQuarantines.has(server.id)) return false;
    if (this.options.db.getActiveSolverJobForServer(server.id)) return false;
    if (isPipelineActive(server.pipeline)) return false;
    let candidate = this.nextQueuedParallelSliceForServer(server.id, dispatchSafety);
    while (candidate && parallelRunCanRefreshCoverageBeforeDispatch(candidate.run)) {
      const runId = candidate.run.id;
      const changed = await this.refreshQueuedParallelRunCoverageBeforeDispatch(candidate.run);
      if (!changed) break;
      candidate = this.nextQueuedParallelSliceForServer(server.id, dispatchSafety);
      if (candidate?.run.id === runId) break;
    }
    if (!candidate) return false;
    try {
      // Parallel runs are persisted before dispatch. Re-check their ownership
      // here as well, including runs created by an older server version.
      this.ensureDatasetNameAvailable(candidate.run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("Dataset collision:")) throw error;
      this.options.db.updateParallelSolverRun(candidate.run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        lastError: message
      });
      this.options.db.updateParallelSolverSlice(candidate.slice.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        lastError: message
      });
      if (candidate.job) {
        this.options.db.updateSolverJob(candidate.job.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          lastError: message
        });
        this.recordEvent(candidate.job.id, "dataset_collision", message, null);
      }
      return false;
    }
    const cardsCheck = await this.validateServerCardsForSlice(server, candidate.slice);
    if (!cardsCheck.ready) {
      const now = new Date().toISOString();
      this.options.db.updateParallelSolverSlice(candidate.slice.id, {
        lastError: cardsCheck.reason,
        updatedAt: now
      });
      if (candidate.job) {
        this.options.db.updateSolverJob(candidate.job.id, {
          lastError: cardsCheck.reason,
          updatedAt: now
        });
      }
      return false;
    }
    if (candidate.job && candidate.job.serverId === server.id) {
      return this.startQueuedJobIfDispatchReady(candidate.job);
    }
    const job = this.createJobForParallelSlice(candidate.run, candidate.slice, server);
    return this.startQueuedJobIfDispatchReady(job);
  }

  private async refreshQueuedParallelRunCoverageBeforeDispatch(run: ParallelSolverRun): Promise<boolean> {
    const current = this.options.db.getParallelSolverRun(run.id);
    if (!current || !parallelRunCanRefreshCoverageBeforeDispatch(current)) return false;

    let remoteBoardKeys: Set<string>;
    try {
      remoteBoardKeys = await fetchHuggingFaceDatasetBoardKeys(
        current.repoId,
        this.hfToken,
        this.effectiveHfProxyUrl()
      );
    } catch (error) {
      console.warn(
        `Unable to refresh coverage before dispatching parallel run ${current.id}; keeping its saved queue unchanged.`,
        error
      );
      return false;
    }

    const historicallyCompleted = new Set(collectHistoricallyCompletedBoardIndices(
      this.options.db.getParallelSolverRuns().filter((candidate) => candidate.id !== current.id),
      current.datasetName,
      current.rangePath
    ));
    const isCovered = (boardIndex: number, boardName: string) =>
      historicallyCompleted.has(boardIndex) || remoteBoardKeys.has(boardKeyFromName(boardName));
    const coveredIndices = new Set<number>();
    for (const slice of current.slices) {
      slice.assignedIndices.forEach((boardIndex, position) => {
        if (isCovered(boardIndex, slice.assignedBoardNames[position] ?? String(boardIndex))) {
          coveredIndices.add(boardIndex);
        }
      });
    }
    if (coveredIndices.size === 0) return false;

    const now = new Date().toISOString();
    const remainingIndices: number[] = [];
    this.options.db.runInPersistenceBatch(() => {
      for (const slice of current.slices) {
        const assignedBoardNames: string[] = [];
        const assignedIndices = slice.assignedIndices.filter((boardIndex, position) => {
          if (coveredIndices.has(boardIndex)) return false;
          remainingIndices.push(boardIndex);
          assignedBoardNames.push(slice.assignedBoardNames[position] ?? String(boardIndex));
          return true;
        });
        if (assignedIndices.length === 0) {
          this.options.db.deleteParallelSolverSlice(slice.id);
          continue;
        }
        this.options.db.updateParallelSolverSlice(slice.id, {
          rangeExpr: compressIndices(assignedIndices),
          assignedIndices,
          assignedBoardNames,
          updatedAt: now
        });
      }
      remainingIndices.sort((left, right) => left - right);
      this.options.db.updateParallelSolverRun(current.id, {
        totalIndices: remainingIndices,
        missingIndices: remainingIndices,
        status: remainingIndices.length === 0 ? "completed" : "queued",
        finishedAt: remainingIndices.length === 0 ? now : null,
        lastError: null,
        updatedAt: now
      });
    });
    return true;
  }

  private nextQueuedParallelSliceForServer(
    serverId: string,
    dispatchSafety: ParallelDispatchSafetyState
  ): { run: ParallelSolverRun; slice: ParallelSolverSlice; job: SolverJob | null } | null {
    const runs = this.options.db.getParallelSolverRuns()
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort(compareParallelRunQueue);
    for (const run of runs) {
      const slices = [...run.slices].sort(compareParallelSliceQueue);
      for (const slice of slices) {
        if (slice.status !== "queued") continue;
        if (!slice.candidateServerIds.includes(serverId) && !run.autoIncludeNewServers) continue;
        if (dispatchSafety.failedServerIdsBySlice.get(slice.id)?.has(serverId)) continue;
        if (!slice.job) return { run, slice, job: null };
        if (parallelSliceJobCanBeReassigned(slice)) return { run, slice, job: slice.job };
      }
    }
    return null;
  }

  private createJobForParallelSlice(run: ParallelSolverRun, slice: ParallelSolverSlice, server: ServerRow): SolverJob {
    return this.options.db.runInPersistenceBatch(() =>
      this.createJobForParallelSliceWithinPersistenceBatch(run, slice, server)
    );
  }

  private createJobForParallelSliceWithinPersistenceBatch(
    run: ParallelSolverRun,
    slice: ParallelSolverSlice,
    server: ServerRow
  ): SolverJob {
    const now = new Date().toISOString();
    if (parallelSliceJobCanBeReassigned(slice) && slice.job) {
      this.options.db.updateSolverJob(slice.job.id, {
        status: "canceled",
        finishedAt: now,
        lastError: `Parallel chunk reassigned to ${server.id} before dispatch.`
      });
      this.recordEvent(slice.job.id, "reassigned", `Parallel chunk reassigned to ${server.id} before dispatch.`, null);
    }
    const jobId = randomUUID();
    const settings = { ...run.settings, rangeExpr: slice.rangeExpr };
    const solverRoot = effectiveSolverRoot(server);
    const remoteRangePath = jobScopedRemoteRangePath(jobId, run.datasetName, solverRoot);
    const remoteSettingPath = jobScopedRemoteSettingPath(jobId, solverRoot);
    const remoteResultPath = jobScopedRemoteResultPath(jobId, run.datasetName, solverRoot);
    const statusFilePath = server.pipelineStatusFilePath?.trim() || this.defaultPipelineStatusFilePath;
    const command = buildRunPipelineCommand({
      solverRoot,
      repoId: run.repoId,
      scenario: run.scenario,
      setting: run.setting,
      settingPath: remoteSettingPath,
      rangePath: remoteRangePath,
      resultPath: remoteResultPath,
      settings,
      statusFilePath,
      hfToken: this.hfToken,
      hfProxyUrl: this.effectiveSolverHfProxyUrl(),
      redactSecrets: true
    });
    const job: SolverJob = {
      id: jobId,
      serverId: server.id,
      rangePath: run.rangePath,
      rangeName: run.rangeName,
      datasetName: run.datasetName,
      settingId: run.settingId,
      setting: run.setting,
      scenario: run.scenario,
      repoId: run.repoId,
      settings,
      command,
      solverRangeText: run.solverRangeText,
      status: "queued",
      queueMode: "parallel",
      confirmUnstudied: false,
      tmuxSession: server.tmuxSession?.trim() || "solver",
      remoteRangePath,
      remoteResultPath,
      parallelRunId: run.id,
      parallelSliceId: slice.id,
      assignedIndices: slice.assignedIndices,
      sourceType: run.sourceType,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      // The current server snapshot predates this job. Active jobs resolve their
      // pipeline dynamically from snapshots collected after dispatch.
      pipeline: null
    };
    this.options.db.insertSolverJob(job);
    this.options.db.updateParallelSolverSlice(slice.id, {
      serverId: server.id,
      jobId,
      status: "queued",
      lastError: null,
      updatedAt: now
    });
    this.recordEvent(job.id, "parallel_assigned", `Assigned parallel chunk ${slice.rangeExpr} to ${server.id}.`, job.command);
    return this.requireJob(job.id);
  }

  private effectiveHfProxyUrl(): string | null {
    return this.getHfProxySettings().hfProxyEnabled ? this.hfProxyUrl : null;
  }

  private async cachedDatasetRepoExists(repoId: string): Promise<boolean> {
    const proxyUrl = this.effectiveHfProxyUrl();
    const key = `${proxyUrl ?? "direct"}:${repoId}`;
    const cached = this.datasetRepoExistsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const exists = await huggingFaceDatasetRepoExists(repoId, this.hfToken, proxyUrl);
    this.datasetRepoExistsCache.set(key, {
      value: exists,
      expiresAt: Date.now() + DATASET_REPO_CACHE_TTL_MS
    });
    return exists;
  }

  private setCachedDatasetRepoExists(repoId: string, exists: boolean): void {
    const proxyUrl = this.effectiveHfProxyUrl();
    this.datasetRepoExistsCache.set(`${proxyUrl ?? "direct"}:${repoId}`, {
      value: exists,
      expiresAt: Date.now() + DATASET_REPO_CACHE_TTL_MS
    });
  }

  private async cachedRemoteBoardKeys(repoId: string): Promise<Set<string>> {
    const proxyUrl = this.effectiveHfProxyUrl();
    const key = `${proxyUrl ?? "direct"}:${repoId}`;
    const cached = this.remoteBoardKeysCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return new Set(cached.value);
    const keys = await fetchHuggingFaceDatasetBoardKeys(repoId, this.hfToken, proxyUrl);
    this.remoteBoardKeysCache.set(key, {
      value: new Set(keys),
      expiresAt: Date.now() + REMOTE_BOARD_KEYS_CACHE_TTL_MS
    });
    return keys;
  }

  private effectiveSolverHfProxyUrl(): string | null {
    return this.getHfProxySettings().solverHfProxyEnabled ? this.solverHfProxyUrl : null;
  }

  private effectiveRemoteOperationProxyUrl(): string {
    return this.effectiveSolverHfProxyUrl() ?? DEFAULT_REMOTE_PROXY_URL;
  }

  private async readSolverCardsForServers(servers: ServerRow[]): Promise<string[]> {
    if (!this.options.credentials) {
      throw new Error("SSH credentials are required to read remote solver cards for parallel allocation.");
    }
    const onlineServers = servers.filter(serverIsOnline);
    const targets = onlineServers.length > 0 ? onlineServers : servers;
    const cacheKey = targets
      .map((server) => [server.id, server.host, server.port, effectiveSolverRoot(server)].join("@"))
      .sort()
      .join("|");
    const cached = this.solverCardsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return [...cached.value];
    const reads = await Promise.all(targets.map(async (server) => {
      const solverRoot = effectiveSolverRoot(server);
      try {
        const cards = parseSolverCards(await this.executor.run(
          server,
          this.options.credentials!,
          buildReadSolverCardsCommand(solverRoot)
        ));
        return { ok: true as const, server, cards };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          server,
          error: `${server.id} (${joinRemotePath(solverRoot, "cards", "cards.txt")}): ${message}`
        };
      }
    }));
    const successfulReads = reads.filter((read) => read.ok);
    if (successfulReads.length === 0) {
      const remoteErrors = reads.filter((read) => !read.ok).map((read) => read.error);
      throw new Error(
        "Unable to read remote solver cards.txt for parallel allocation. " +
        "Parallel allocation reads cards/cards.txt from the selected server solverRoot over SSH. " +
        `Remote errors: ${remoteErrors.join("; ") || "none"}.`
      );
    }

    const baseline = successfulReads[0]!;
    const mismatches = successfulReads.slice(1).flatMap((read) => {
      const mismatchIndex = firstSolverCardMismatchIndex(baseline.cards, read.cards);
      return mismatchIndex < 0
        ? []
        : [`${read.server.id}=${read.cards.length} boards (first mismatch at index ${mismatchIndex + 1})`];
    });
    if (mismatches.length > 0) {
      throw new Error(
        `Remote solver cards.txt is inconsistent. ${baseline.server.id}=${baseline.cards.length} boards; ` +
        `${mismatches.join("; ")}. Synchronize solver data before creating a parallel queue.`
      );
    }
    if (baseline.cards.length !== SOLVER_TOTAL_BOARD_COUNT) {
      throw new Error(
        `Remote solver cards.txt must contain ${SOLVER_TOTAL_BOARD_COUNT} boards, but ` +
        `${baseline.server.id} contains ${baseline.cards.length}. Synchronize solver data before creating a parallel queue.`
      );
    }
    this.solverCardsCache.set(cacheKey, {
      value: [...baseline.cards],
      expiresAt: Date.now() + SOLVER_CARDS_CACHE_TTL_MS
    });
    return baseline.cards;
  }

  private async validateServerCardsForSlice(
    server: ServerRow,
    slice: ParallelSolverSlice
  ): Promise<{ ready: boolean; reason: string | null }> {
    if (!this.options.credentials) {
      return { ready: false, reason: "Dispatch pending: SSH credentials are required to validate solver cards.txt." };
    }
    try {
      const cards = parseSolverCards(await this.executor.run(
        server,
        this.options.credentials,
        buildReadSolverCardsCommand(effectiveSolverRoot(server))
      ));
      if (cards.length !== SOLVER_TOTAL_BOARD_COUNT) {
        return {
          ready: false,
          reason: `Dispatch pending: solver cards.txt on ${server.id} must contain ${SOLVER_TOTAL_BOARD_COUNT} boards, ` +
            `but contains ${cards.length}. Synchronize solver data before retrying.`
        };
      }
      const mismatchPosition = slice.assignedIndices.findIndex((boardIndex, position) =>
        cards[boardIndex - 1] !== slice.assignedBoardNames[position]
      );
      if (mismatchPosition >= 0) {
        const boardIndex = slice.assignedIndices[mismatchPosition]!;
        const expected = slice.assignedBoardNames[mismatchPosition] ?? "<missing>";
        const actual = cards[boardIndex - 1] ?? "<missing>";
        return {
          ready: false,
          reason: `Dispatch pending: solver cards.txt mismatch on ${server.id} at index ${boardIndex} ` +
            `(expected ${expected}, found ${actual}). Synchronize solver data before retrying.`
        };
      }
      return { ready: true, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        reason: `Dispatch pending: unable to validate solver cards.txt on ${server.id}: ${message}`
      };
    }
  }

  private recordEvent(jobId: string, type: string, message: string, commandPreview: string | null): void {
    this.options.db.insertSolverJobEvent({
      id: randomUUID(),
      jobId,
      type,
      message,
      commandPreview,
      createdAt: new Date().toISOString()
    });
  }

  private recordOperationEvent(operationId: string, type: string, message: string, commandPreview: string | null): void {
    this.options.db.insertServerOperationEvent({
      id: randomUUID(),
      operationId,
      type,
      message,
      commandPreview,
      createdAt: new Date().toISOString()
    });
  }

}

export function buildSolverJobPreview({
  input,
  server,
  preflopRangesPath,
  defaultPipelineStatusFilePath,
  repoNamespace,
  hfToken,
  solverHfProxyUrl,
  settingLibrary,
  scenarioLibrary
}: {
  input: SolverJobPreviewRequest;
  server: ServerRow;
  preflopRangesPath: string;
  defaultPipelineStatusFilePath: string;
  repoNamespace: string;
  hfToken?: string | null;
  solverHfProxyUrl?: string | null;
  settingLibrary?: SolverSettingLibraryItem[];
  /** @deprecated Use settingLibrary. */
  scenarioLibrary?: SolverScenarioLibraryItem[];
}): SolverJobPreview {
  const solverRoot = effectiveSolverRoot(server);

  const file = readPreflopRangeFile(preflopRangesPath, input.rangePath);
  const library = settingLibrary ?? scenarioLibrary ?? DEFAULT_SOLVER_SETTING_LIBRARY;
  const setting = settingFromPreviewInput(input, library);
  const settings = {
    ...normalizeSolverJobSettings(input.settings),
    maxIteration: setting.parameters.maxIteration,
    useIsomorphism: setting.parameters.useIsomorphism ? 1 as const : 0 as const
  };
  const scenario = setting.id;
  const datasetName = normalizeDatasetName(input.datasetName) ?? datasetNameFromRangePath(input.rangePath);
  const datasetCollisionPaths = rangePathsForDatasetName(preflopRangesPath, datasetName)
    .filter((rangePath) => rangePath !== input.rangePath && !rangePathsAreIdenticalAliases(
      preflopRangesPath, input.rangePath, rangePath, datasetName, library, setting.id
    ));
  const repoId = `${repoNamespace}/${datasetName}`;
  const solverRangeText = solverRangeTextFromDocument(file.summary.data);
  const tmuxSession = server.tmuxSession?.trim() || "solver";
  const pipelineStatusFilePath = server.pipelineStatusFilePath?.trim() || defaultPipelineStatusFilePath;
  const remoteRangePath = jobScopedRemoteRangePath("<job-id>", datasetName, solverRoot);
  const remoteSettingPath = jobScopedRemoteSettingPath("<job-id>", solverRoot);
  const remoteResultPath = jobScopedRemoteResultPath("<job-id>", datasetName, solverRoot);
  const commandPreview = buildRunPipelineCommand({
    solverRoot,
    repoId,
    scenario,
    setting,
    settingPath: remoteSettingPath,
    rangePath: remoteRangePath,
    resultPath: remoteResultPath,
    settings,
    statusFilePath: pipelineStatusFilePath,
    hfToken,
    hfProxyUrl: solverHfProxyUrl,
    redactSecrets: true
  });
  const warnings: string[] = [];
  const learned = file.summary.data.learned;
  if (!learned) {
    warnings.push("Range must be approved before solver job submission.");
  }
  if (datasetCollisionPaths.length > 0) {
    warnings.push(
      `Dataset name ${datasetName} is also used by: ${datasetCollisionPaths.join(", ")}. ` +
      "Choose a unique dataset name before submitting."
    );
  }

  return {
    server,
    rangePath: file.path,
    rangeName: file.path.split("/").at(-1) ?? file.path,
    learned,
    datasetName,
    repoId,
    settingId: setting.id,
    setting,
    scenario,
    solverRangeText,
    remoteRangePath,
    remoteResultPath,
    commandPreview,
    tmuxSession,
    pipelineStatusFilePath,
    settings,
    datasetCollisionPaths,
    warnings,
    requiresConfirmation: !learned
  };
}

export function normalizeSolverJobSettings(input: Partial<SolverJobSettings> | undefined): SolverJobSettings {
  const merged = { ...DEFAULT_SOLVER_JOB_SETTINGS, ...(input ?? {}) };
  const settings: SolverJobSettings = {
    rangeExpr: typeof merged.rangeExpr === "string" && merged.rangeExpr.trim() ? merged.rangeExpr.trim() : "all",
    batchSize: positiveInteger(merged.batchSize, DEFAULT_SOLVER_JOB_SETTINGS.batchSize),
    threadNum: integerOrDefault(merged.threadNum, DEFAULT_SOLVER_JOB_SETTINGS.threadNum),
    useIsomorphism: merged.useIsomorphism === 0 ? 0 : 1,
    maxIteration: positiveInteger(merged.maxIteration, DEFAULT_SOLVER_JOB_SETTINGS.maxIteration),
    estimateMemory: false,
    stallTimeoutSeconds: nullablePositiveInteger(merged.stallTimeoutSeconds),
    noOutputTimeoutSeconds: nullablePositiveInteger(merged.noOutputTimeoutSeconds),
    exportFormat: SOLVER_EXPORT_FORMATS.includes(merged.exportFormat) ? merged.exportFormat : "parquet",
    uploadFormat: SOLVER_UPLOAD_FORMATS.includes(merged.uploadFormat) ? merged.uploadFormat : "parquet",
    uploadEnabled: Boolean(merged.uploadEnabled),
    uploadAttemptTimeoutSeconds: positiveInteger(
      merged.uploadAttemptTimeoutSeconds,
      DEFAULT_SOLVER_JOB_SETTINGS.uploadAttemptTimeoutSeconds
    )
  };
  if (settings.uploadEnabled && settings.uploadFormat === "json" && settings.exportFormat !== "json") {
    settings.exportFormat = "json";
  }
  return settings;
}

export function solverRangeTextFromDocument(document: PreflopRangeDocument): string {
  const oopPlayer = playerForPosition(document, "OOP");
  const ipPlayer = playerForPosition(document, "IP");
  if (!oopPlayer || !ipPlayer || oopPlayer === ipPlayer) {
    throw new Error("Range must have one OOP player and one IP player before solver submission.");
  }
  return [
    `OOP_RANGE = "${formatCombinedPlayerRange(document, oopPlayer)}"`,
    `IP_RANGE = "${formatCombinedPlayerRange(document, ipPlayer)}"`,
    ""
  ].join("\n");
}

/** Ignore duplicate library copies only when both ranges and their Setting match. */
export function rangePathsAreIdenticalAliases(
  root: string,
  firstPath: string,
  secondPath: string,
  datasetName: string,
  library: SolverSettingLibraryItem[],
  selectedSettingId: SolverSettingLibraryItem["id"]
): boolean {
  if (datasetNameFromRangePath(firstPath) !== datasetName ||
      datasetNameFromRangePath(secondPath) !== datasetName) return false;
  const firstSettings = linkedSolverSettingsForRangePath(library, firstPath);
  const secondSettings = linkedSolverSettingsForRangePath(library, secondPath);
  if (firstSettings.length !== 1 || secondSettings.length !== 1 ||
      firstSettings[0]!.id !== selectedSettingId ||
      secondSettings[0]!.id !== selectedSettingId) return false;
  try {
    const first = readPreflopRangeFile(root, firstPath).summary.data;
    const second = readPreflopRangeFile(root, secondPath).summary.data;
    return solverRangeTextFromDocument(first) === solverRangeTextFromDocument(second);
  } catch {
    return false;
  }
}

function settingFromPreviewInput(
  input: SolverJobPreviewRequest,
  settingLibrary: SolverSettingLibraryItem[]
): SolverSettingLibraryItem {
  const settingId = input.settingId ?? input.scenario;
  if (settingId == null) {
    const linked = linkedSolverSettingsForRangePath(settingLibrary, input.rangePath);
    if (linked.length === 1) return linked[0]!;
    if (linked.length > 1) {
      throw new Error(`Range path ${input.rangePath} has ambiguous Setting links: ${linked.map((setting) => setting.id).join(", ")}.`);
    }
    throw new Error(`Range path ${input.rangePath} is not linked to a Setting. Select one manually.`);
  }
  const setting = settingLibrary.find((candidate) => candidate.id === settingId);
  if (setting) return setting;
  throw new Error(`Unsupported solver setting: ${settingId}`);
}

function normalizeDatasetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    normalized.length > 96 ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.startsWith("-") ||
    normalized.endsWith("-") ||
    normalized.includes("..") ||
    normalized.includes("--") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
  ) {
    throw new Error("Dataset name must use letters, numbers, '.', '_' or '-' and cannot start/end with '.' or '-'.");
  }
  return normalized;
}

function datasetRepoKey(datasetName: string, repoId: string): string {
  // Hugging Face repository ids are effectively case-insensitive for the
  // ownership purpose here. Lower-casing prevents `MyRange` and `myrange`
  // from becoming two apparent owners of the same remote dataset.
  return `${repoId.trim() || datasetName.trim()}`.toLowerCase();
}

async function huggingFaceDatasetRepoExists(
  repoId: string,
  hfToken: string | null,
  hfProxyUrl: string | null
): Promise<boolean> {
  const response = await huggingFaceFetch(`${HUGGING_FACE_ORIGIN}/api/datasets/${repoIdPath(repoId)}`, {
    headers: huggingFaceHeaders(hfToken),
    proxyUrl: hfProxyUrl,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 404 || isRedirectStatus(response.status)) return false;
  if (response.ok) {
    const data = await response.json() as unknown;
    return isRecord(data) && data.id === repoId;
  }
  throw new Error(`Hugging Face dataset repo check failed for ${repoId}: ${await huggingFaceErrorMessage(response)}`);
}

async function createHuggingFaceDatasetRepo(
  repoId: string,
  hfToken: string,
  hfProxyUrl: string | null
): Promise<void> {
  const { namespace, name } = splitRepoId(repoId);
  const response = await huggingFaceFetch(`${HUGGING_FACE_ORIGIN}/api/repos/create`, {
    method: "POST",
    headers: {
      ...huggingFaceHeaders(hfToken),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      organization: namespace,
      type: "dataset",
      private: false
    }),
    proxyUrl: hfProxyUrl,
    signal: AbortSignal.timeout(15_000)
  });
  if (response.ok) return;
  if (
    (response.status === 400 || response.status === 409) &&
    await huggingFaceDatasetRepoExists(repoId, hfToken, hfProxyUrl)
  ) return;
  throw new Error(`Hugging Face dataset repo creation failed for ${repoId}: ${await huggingFaceErrorMessage(response)}`);
}

function huggingFaceDatasetUrl(repoId: string): string {
  return `${HUGGING_FACE_ORIGIN}/datasets/${repoId}`;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function splitRepoId(repoId: string): { namespace: string; name: string } {
  const [namespace, ...rest] = repoId.split("/");
  const name = rest.join("/");
  if (!namespace || !name || name.includes("/")) {
    throw new Error(`Invalid Hugging Face repo id: ${repoId}`);
  }
  return { namespace, name };
}

function repoIdPath(repoId: string): string {
  return repoId.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function huggingFaceHeaders(hfToken: string | null): Record<string, string> {
  const token = hfToken?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function huggingFaceErrorMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const error = (parsed as { error?: unknown }).error;
        if (typeof error === "string") return `${fallback} - ${error}`;
      }
    } catch {
      // Use raw text below.
    }
    return `${fallback} - ${text.slice(0, 300)}`;
  } catch {
    return fallback;
  }
}

export function buildRunPipelineCommand({
  solverRoot,
  repoId,
  scenario,
  setting,
  settingPath,
  rangePath,
  rangeFileName,
  oopRange,
  ipRange,
  resultPath,
  settings,
  statusFilePath,
  hfToken,
  hfProxyUrl,
  redactSecrets = false
}: {
  solverRoot: string;
  repoId: string;
  scenario: SolverScenario;
  setting?: SolverSettingLibraryItem;
  settingPath?: string;
  rangePath?: string;
  rangeFileName?: string;
  oopRange?: string;
  ipRange?: string;
  resultPath?: string;
  settings: SolverJobSettings;
  statusFilePath: string;
  hfToken?: string | null;
  hfProxyUrl?: string | null;
  redactSecrets?: boolean;
}): string {
  const effectiveScenario = setting?.id ?? scenario;
  const args = [
    "python",
    "run_pipeline.py",
    settings.rangeExpr,
    "--batch-size",
    String(settings.batchSize),
    "--thread-num",
    String(settings.threadNum),
    "--use-isomorphism",
    String(settings.useIsomorphism),
    "--max-iteration",
    String(settings.maxIteration),
    "--export-format",
    settings.exportFormat,
    "--status-file",
    statusFilePath,
    "--scenario",
    effectiveScenario
  ];
  if (setting && settingPath) {
    args.push("--setting-file", settingPath);
  } else if (setting && solverSettingRequiresRuntimeInjection(setting)) {
    // Backward compatibility for jobs created before job-scoped Setting files.
    args.push("--setting-snapshot", encodeSolverSettingSnapshot(setting));
  }
  if (resultPath) {
    args.push("--result-path", resultPath);
  }
  if (rangePath) {
    args.push("--range-path", rangePath);
  } else if (oopRange && ipRange) {
    args.push("--oop-range", oopRange, "--ip-range", ipRange);
  } else if (rangeFileName) {
    args.push("--range-file", rangeFileName);
  } else {
    throw new Error("A range path, inline ranges, or range file name is required.");
  }
  const environmentExports: string[] = [];
  if (settings.uploadEnabled) {
    const normalizedHfToken = hfToken?.trim();
    if (!normalizedHfToken) {
      throw new Error("HF_TOKEN is required when Upload is enabled.");
    }
    const normalizedHfProxyUrl = hfProxyUrl?.trim();
    if (normalizedHfProxyUrl) {
      environmentExports.push(
        `export http_proxy=${shellQuote(normalizedHfProxyUrl)}`,
        `export https_proxy=${shellQuote(normalizedHfProxyUrl)}`
      );
    }
    environmentExports.push(
      redactSecrets ? "export HF_TOKEN=$HF_TOKEN" : `export HF_TOKEN=${shellQuote(normalizedHfToken)}`
    );
    args.push(
      "--repo-id",
      repoId,
      "--upload-format",
      settings.uploadFormat,
      "--upload-attempt-timeout",
      String(settings.uploadAttemptTimeoutSeconds)
    );
  } else {
    args.push("--no-upload");
  }
  if (settings.stallTimeoutSeconds != null) args.push("--stall-timeout", String(settings.stallTimeoutSeconds));
  if (settings.noOutputTimeoutSeconds != null) args.push("--no-output-timeout", String(settings.noOutputTimeoutSeconds));
  return [
    `cd ${shellQuoteRemotePath(solverRoot)}`,
    ...environmentExports,
    `PIPELINE_STATUS_FILE=${shellQuote(statusFilePath)} ${args.map(shellQuote).join(" ")}`
  ].join(" && ");
}

function encodeSolverSettingSnapshot(setting: SolverSettingLibraryItem): string {
  return Buffer.from(JSON.stringify(setting), "utf8").toString("base64");
}

function solverSettingRuntimePayload(setting: SolverSettingLibraryItem) {
  return {
    id: setting.id,
    configTemplate: setting.configTemplate,
    pot: setting.pot,
    effectiveStack: setting.effectiveStack
  };
}

function solverSettingRequiresRuntimeInjection(setting: SolverSettingLibraryItem): boolean {
  const builtIn = DEFAULT_SOLVER_SETTING_LIBRARY.find((candidate) => candidate.id === setting.id);
  return !builtIn ||
    builtIn.configTemplate !== setting.configTemplate ||
    builtIn.pot !== setting.pot ||
    builtIn.effectiveStack !== setting.effectiveStack;
}

export function buildDeployRangeCommand(job: SolverJob): string {
  const tmpPath = `${job.remoteRangePath}.tmp`;
  const commands = [
    "set -e",
    `RANGE_PATH=${shellQuoteRemotePath(job.remoteRangePath)}`,
    `TMP_PATH=${shellQuoteRemotePath(tmpPath)}`,
    `mkdir -p ${shellQuoteRemotePath(dirnameRemote(job.remoteRangePath))}`,
    `cat > "$TMP_PATH" <<'SOLVER_RANGE_EOF'`,
    job.solverRangeText.trimEnd(),
    "SOLVER_RANGE_EOF",
    `mv "$TMP_PATH" "$RANGE_PATH"`
  ];
  const settingPath = settingFilePathFromCommand(job.command);
  if (settingPath) {
    commands.push(
      `SETTING_PATH=${shellQuoteRemotePath(settingPath)}`,
      `SETTING_TMP_PATH=${shellQuoteRemotePath(`${settingPath}.tmp`)}`,
      `mkdir -p ${shellQuoteRemotePath(dirnameRemote(settingPath))}`,
      `cat > "$SETTING_TMP_PATH" <<'SOLVER_SETTING_EOF'`,
      JSON.stringify(solverSettingRuntimePayload(job.setting)),
      "SOLVER_SETTING_EOF",
      `mv "$SETTING_TMP_PATH" "$SETTING_PATH"`
    );
  }
  return commands.join("\n");
}

export function buildTmuxStartCommand(job: SolverJob, solverRoot: string, command = job.command): string {
  const settingFileCheck = settingFilePathFromCommand(command)
    ? [
        `RUN_PIPELINE=${shellQuoteRemotePath(joinRemotePath(solverRoot, "run_pipeline.py"))}`,
        `if [ ! -f "$RUN_PIPELINE" ] || ! grep -q -- '--setting-file' "$RUN_PIPELINE"; then echo "Remote solver does not support --setting-file; run Code Sync first." >&2; exit 1; fi`
      ]
    : [];
  // Always execute the solver through a fresh interactive Bash. Remote hosts
  // activate Conda from ~/.bashrc, while a long-lived tmux shell may predate
  // that setup or may have had its first startup interrupted. Keeping this
  // bootstrap outside the persisted job command also keeps command previews
  // concise and makes old queued commands use the repaired runtime at launch.
  const interactiveCommand = `bash -ic ${shellQuote(command)}`;
  return [
    "set -e",
    `STATUS_FILE=${shellQuoteRemotePath(statusFileFromJob(job))}`,
    `JOB_ID=${shellQuote(job.id)}`,
    `SESSION=${shellQuote(job.tmuxSession)}`,
    ...settingFileCheck,
    // Remove the previous task's terminal status immediately before dispatch.
    // If the new command exits before writing its own status, inventory reports
    // IDLE instead of indefinitely presenting an unrelated completed task.
    `rm -f "$STATUS_FILE"`,
    "SESSION_CREATED=0",
    "if tmux has-session -t \"$SESSION\" 2>/dev/null; then",
    "  SESSION_CREATED=0",
    "else",
    `  tmux new-session -d -s "$SESSION" -c ${shellQuoteRemotePath(solverRoot)}`,
    "  SESSION_CREATED=1",
    "fi",
    `PANE_COMMAND=$(tmux display-message -p -t "$SESSION" '#{pane_current_command}')`,
    `case "$PANE_COMMAND" in bash|sh|dash|zsh|fish) ;; *) echo "Solver tmux pane is busy with $PANE_COMMAND; refusing to replace it." >&2; exit 1 ;; esac`,
    // A reused pane can be sitting at Bash's PS2 (`>`) continuation prompt, so
    // clear pending input there. Never send Ctrl-C to a newly-created session:
    // doing so can interrupt ~/.bashrc while it is activating Conda.
    "if [ \"$SESSION_CREATED\" -eq 0 ]; then",
    `  tmux send-keys -t "$SESSION" C-c`,
    "  sleep 0.2",
    "fi",
    `tmux send-keys -t "$SESSION" ${shellQuote(interactiveCommand)} C-m`,
    "LAUNCH_CONFIRMED=0",
    "LAUNCH_CHECK=0",
    "while [ \"$LAUNCH_CHECK\" -lt 20 ]; do",
    "  if [ -s \"$STATUS_FILE\" ] && grep -Fq -- \"$JOB_ID\" \"$STATUS_FILE\"; then LAUNCH_CONFIRMED=1; break; fi",
    "  LAUNCH_CHECK=$((LAUNCH_CHECK + 1))",
    "  sleep 0.5",
    "done",
    "if [ \"$LAUNCH_CONFIRMED\" -ne 1 ]; then",
    `  PANE_COMMAND=$(tmux display-message -p -t "$SESSION" '#{pane_current_command}' 2>/dev/null || echo missing)`,
    "  echo \"Solver launch was not acknowledged for job $JOB_ID within 10 seconds (pane=$PANE_COMMAND).\" >&2",
    "  exit 42",
    "fi"
  ].join("\n");
}

export function buildServerOperationTmuxStartCommand(
  operation: ServerOperation,
  solverRoot: string,
  command = operation.command,
  commandFilePath?: string
): string {
  const paneCommand = commandFilePath
    ? `bash ${shellQuoteRemotePath(commandFilePath)}; OP_COMMAND_CODE=\$?; rm -f -- ${shellQuoteRemotePath(commandFilePath)}; unset OP_COMMAND_CODE`
    : command;
  return [
    "set -e",
    `tmux has-session -t ${shellQuote(operation.tmuxSession)} 2>/dev/null || tmux new-session -d -s ${shellQuote(operation.tmuxSession)} -c ${shellQuoteRemotePath(solverRoot)}`,
    `tmux send-keys -t ${shellQuote(operation.tmuxSession)} ${shellQuote(paneCommand)} C-m`
  ].join("\n");
}

export function buildServerSyncCommand({
  solverRoot,
  proxyUrl = DEFAULT_REMOTE_PROXY_URL
}: {
  solverRoot: string;
  proxyUrl?: string;
}): string {
  return String.raw`set +e
cd ${shellQuoteRemotePath(solverRoot)}
export http_proxy=${shellQuote(proxyUrl)}
export https_proxy=${shellQuote(proxyUrl)}
SYNC_STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STASH_OUTPUT=$(git stash 2>&1)
STASH_CODE=$?
PULL_OUTPUT=$(git pull --rebase 2>&1)
PULL_CODE=$?
HEAD_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || true)
if [ -f run_pipeline.py ] && grep -q -- '--setting-file' run_pipeline.py; then
  SETTING_FILE_SUPPORTED=1
else
  SETTING_FILE_SUPPORTED=0
fi
SYNC_FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ "$STASH_CODE" -eq 0 ] && [ "$PULL_CODE" -eq 0 ] && [ "$SETTING_FILE_SUPPORTED" -eq 1 ]; then
  if printf '%s\n' "$PULL_OUTPUT" | grep -qi "Already up to date"; then SYNC_KIND=latest; else SYNC_KIND=synced; fi
else
  SYNC_KIND=failed
fi
export STASH_OUTPUT PULL_OUTPUT
python - "$OP_RESULT_FILE" "$SYNC_KIND" "$STASH_CODE" "$PULL_CODE" "$SETTING_FILE_SUPPORTED" "$HEAD_COMMIT" "$SYNC_STARTED_AT" "$SYNC_FINISHED_AT" <<'PY'
import json
import os
import sys

path, kind, stash_code, pull_code, setting_file_supported, head_commit, started_at, finished_at = sys.argv[1:9]
stash_output = os.environ.get("STASH_OUTPUT", "")
pull_output = os.environ.get("PULL_OUTPUT", "")
result = {
    "summary": {
        "latest": 1 if kind == "latest" else 0,
        "synced": 1 if kind == "synced" else 0,
        "failed": 1 if kind == "failed" else 0,
        "stash_code": int(stash_code),
        "pull_code": int(pull_code),
        "setting_file_supported": int(setting_file_supported),
    },
    "details": [{
        "kind": kind,
        "head_commit": head_commit,
        "setting_file_supported": int(setting_file_supported),
        "started_at": started_at,
        "finished_at": finished_at,
        "stash_output": stash_output[-800:],
        "pull_output": pull_output[-1200:],
    }],
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=True)
PY
printf '%s\n' "$STASH_OUTPUT"
printf '%s\n' "$PULL_OUTPUT"
if [ "$SETTING_FILE_SUPPORTED" -ne 1 ]; then printf '%s\n' "run_pipeline.py does not support --setting-file"; fi
if [ "$STASH_CODE" -ne 0 ] || [ "$PULL_CODE" -ne 0 ] || [ "$SETTING_FILE_SUPPORTED" -ne 1 ]; then exit 1; fi`;
}

export function buildServerNetworkSyncCommand({
  subscriptionUrl = null,
  giteeUsername = "Tsumugii24",
  giteeToken = null,
  sudoPassword = null,
  redactSecrets = false
}: {
  subscriptionUrl?: string | null;
  giteeUsername?: string | null;
  giteeToken?: string | null;
  sudoPassword?: string | null;
  redactSecrets?: boolean;
} = {}): string {
  const normalizedUrl = subscriptionUrl?.trim() || null;
  const normalizedGiteeUsername = giteeUsername?.trim() || "Tsumugii24";
  const normalizedGiteeToken = giteeToken?.trim() || null;
  const normalizedSudoPassword = sudoPassword ?? "";
  if (!redactSecrets && !normalizedUrl) {
    throw new Error("SUBSCRIPTION_URL is required for network sync operations.");
  }
  const subscriptionAssignment = redactSecrets
    ? "SUBSCRIPTION_URL=$SUBSCRIPTION_URL"
    : `SUBSCRIPTION_URL=${shellQuote(normalizedUrl!)}`;
  const giteeUsernameAssignment = redactSecrets
    ? "GITEE_USERNAME=$GITEE_USERNAME"
    : `GITEE_USERNAME=${shellQuote(normalizedGiteeUsername)}`;
  const giteeTokenAssignment = redactSecrets
    ? "GITEE_TOKEN=$GITEE_TOKEN"
    : `GITEE_TOKEN=${shellQuote(normalizedGiteeToken ?? "")}`;
  const sudoPasswordAssignment = redactSecrets
    ? "SUDO_PASSWORD=$SUDO_PASSWORD"
    : `SUDO_PASSWORD=${shellQuote(normalizedSudoPassword)}`;
  return String.raw`set +e
REPO_DIR="$HOME/mihomo-release"
REPO_URL="https://gitee.com/Tsumugii24/mihomo-release"
cd "$HOME"
NETWORK_STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
export GIT_TERMINAL_PROMPT=0
export SSH_ASKPASS=/bin/false
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
${subscriptionAssignment}
${giteeUsernameAssignment}
${giteeTokenAssignment}
${sudoPasswordAssignment}
GIT_ASKPASS_FILE=""
if [ -n "$GITEE_TOKEN" ]; then
  GIT_ASKPASS_FILE=$(mktemp)
  cat > "$GIT_ASKPASS_FILE" <<'SH'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "$GITEE_USERNAME" ;;
  *Password*) printf '%s\n' "$GITEE_TOKEN" ;;
  *) exit 1 ;;
esac
SH
  chmod 700 "$GIT_ASKPASS_FILE"
  export GITEE_USERNAME GITEE_TOKEN GIT_ASKPASS="$GIT_ASKPASS_FILE"
else
  export GIT_ASKPASS=/bin/false
fi
if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR"
  git stash >/dev/null 2>&1
  REMOTE_OUTPUT=$(git remote set-url origin "$REPO_URL" 2>&1)
  REMOTE_CODE=$?
  if [ "$REMOTE_CODE" -eq 0 ]; then
    GIT_OUTPUT=$(timeout 120 git -c credential.helper= pull --rebase "$REPO_URL" master 2>&1)
    GIT_CODE=$?
  else
    GIT_OUTPUT="$REMOTE_OUTPUT"
    GIT_CODE=$REMOTE_CODE
  fi
  INSTALL_KIND=updated
elif [ -e "$REPO_DIR" ]; then
  GIT_OUTPUT="mihomo-release exists but is not a git repository"
  GIT_CODE=1
  INSTALL_KIND=invalid
else
  GIT_OUTPUT=$(timeout 120 git -c credential.helper= clone --branch master --single-branch "$REPO_URL" "$REPO_DIR" 2>&1)
  GIT_CODE=$?
  INSTALL_KIND=cloned
fi
if [ -n "$GIT_ASKPASS_FILE" ]; then
  rm -f "$GIT_ASKPASS_FILE"
fi
unset GITEE_TOKEN GITEE_USERNAME GIT_ASKPASS
GIT_ATTEMPT_CODE=$GIT_CODE
if [ "$GIT_CODE" -ne 0 ] && { [ -x "$REPO_DIR/mihomo" ] || [ -f "$REPO_DIR/mihomo.gz" ]; }; then
  GIT_CODE=0
  INSTALL_KIND=cached
fi
if [ "$GIT_CODE" -eq 0 ]; then
  cd "$REPO_DIR"
  if [ -f "$REPO_DIR/mihomo.gz" ]; then
    gzip -dc "$REPO_DIR/mihomo.gz" > "$REPO_DIR/mihomo.next"
    BINARY_CODE=$?
    if [ "$BINARY_CODE" -eq 0 ]; then
      mv "$REPO_DIR/mihomo.next" "$REPO_DIR/mihomo"
      chmod +x "$REPO_DIR/mihomo"
    else
      rm -f "$REPO_DIR/mihomo.next"
    fi
  elif [ -x "$REPO_DIR/mihomo" ]; then
    BINARY_CODE=0
  else
    BINARY_CODE=1
  fi
else
  BINARY_CODE=1
fi
if [ "$BINARY_CODE" -eq 0 ]; then
  if [ -f config.yaml ]; then
    cp config.yaml config.yaml.previous
    BACKUP_CODE=$?
  else
    BACKUP_CODE=0
    rm -f config.yaml.previous
  fi
  if [ "$BACKUP_CODE" -eq 0 ]; then
    timeout 90 wget --timeout=30 --tries=2 -q -O config.yaml.next "$SUBSCRIPTION_URL"
    DOWNLOAD_CODE=$?
    DOWNLOAD_INITIAL_CODE=$DOWNLOAD_CODE
    DOWNLOAD_RETRY_CODE=-1
    DNS_RETRY_ATTEMPTED=0
    DNS_REPAIR_CODE=0
    if [ "$DOWNLOAD_INITIAL_CODE" -ne 0 ]; then
      DNS_RETRY_ATTEMPTED=1
      if [ "$(id -u)" -eq 0 ]; then
        bash -c 'echo "nameserver 223.5.5.5" > /etc/resolv.conf'
        DNS_PRIMARY_CODE=$?
        bash -c 'echo "nameserver 8.8.8.8" >> /etc/resolv.conf'
        DNS_SECONDARY_CODE=$?
      else
        printf '%s\n' "$SUDO_PASSWORD" | timeout 15 sudo -S -p '' bash -c 'echo "nameserver 223.5.5.5" > /etc/resolv.conf'
        DNS_PRIMARY_CODE=$?
        printf '%s\n' "$SUDO_PASSWORD" | timeout 15 sudo -S -p '' bash -c 'echo "nameserver 8.8.8.8" >> /etc/resolv.conf'
        DNS_SECONDARY_CODE=$?
      fi
      if [ "$DNS_PRIMARY_CODE" -ne 0 ]; then
        DNS_REPAIR_CODE=$DNS_PRIMARY_CODE
      elif [ "$DNS_SECONDARY_CODE" -ne 0 ]; then
        DNS_REPAIR_CODE=$DNS_SECONDARY_CODE
      fi
      rm -f config.yaml.next
      timeout 90 wget --timeout=30 --tries=2 -q -O config.yaml.next "$SUBSCRIPTION_URL"
      DOWNLOAD_CODE=$?
      DOWNLOAD_RETRY_CODE=$DOWNLOAD_CODE
    fi
    unset SUDO_PASSWORD
    if [ "$DOWNLOAD_CODE" -eq 0 ] && [ -s config.yaml.next ]; then
      mv config.yaml.next config.yaml
    else
      DOWNLOAD_CODE=1
      rm -f config.yaml.next
    fi
  else
    DOWNLOAD_CODE=1
    DOWNLOAD_INITIAL_CODE=1
    DOWNLOAD_RETRY_CODE=-1
    DNS_RETRY_ATTEMPTED=0
    DNS_REPAIR_CODE=0
    rm -f config.yaml.next
  fi
else
  DOWNLOAD_CODE=1
  DOWNLOAD_INITIAL_CODE=1
  DOWNLOAD_RETRY_CODE=-1
  DNS_RETRY_ATTEMPTED=0
  DNS_REPAIR_CODE=0
  BACKUP_CODE=1
fi
if [ "$DOWNLOAD_CODE" -eq 0 ]; then
  VALIDATE_OUTPUT=$(timeout 30 ./mihomo -t -d . 2>&1)
  VALIDATE_CODE=$?
else
  VALIDATE_OUTPUT=""
  VALIDATE_CODE=1
fi
if [ "$VALIDATE_CODE" -ne 0 ]; then
  if [ -f config.yaml.previous ]; then
    mv config.yaml.previous config.yaml
  else
    rm -f config.yaml
  fi
else
  rm -f config.yaml.previous
fi
if [ "$VALIDATE_CODE" -eq 0 ]; then
  tmux kill-session -t mihomo 2>/dev/null || true
  # Old tmux servers can leave detached mihomo children behind. They keep the
  # proxy port bound, so a newly-created session appears healthy while traffic
  # is still served by stale processes.
  pkill -TERM -x mihomo 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    if ! pgrep -x mihomo >/dev/null 2>&1; then break; fi
    sleep 1
  done
  pkill -KILL -x mihomo 2>/dev/null || true
  tmux new-session -d -s mihomo -c "$REPO_DIR" "exec ./mihomo -d ."
  START_CODE=$?
  sleep 1
  tmux has-session -t mihomo 2>/dev/null
  SESSION_CODE=$?
else
  START_CODE=1
  SESSION_CODE=1
fi
NETWORK_FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ "$GIT_CODE" -eq 0 ] && [ "$BINARY_CODE" -eq 0 ] && [ "$BACKUP_CODE" -eq 0 ] && [ "$DOWNLOAD_CODE" -eq 0 ] && [ "$VALIDATE_CODE" -eq 0 ] && [ "$START_CODE" -eq 0 ] && [ "$SESSION_CODE" -eq 0 ]; then
  NETWORK_KIND=ready
else
  NETWORK_KIND=failed
fi
export GIT_OUTPUT VALIDATE_OUTPUT
python - "$OP_RESULT_FILE" "$NETWORK_KIND" "$INSTALL_KIND" "$GIT_CODE" "$GIT_ATTEMPT_CODE" "$BINARY_CODE" "$BACKUP_CODE" "$DOWNLOAD_CODE" "$DOWNLOAD_INITIAL_CODE" "$DOWNLOAD_RETRY_CODE" "$DNS_RETRY_ATTEMPTED" "$DNS_REPAIR_CODE" "$VALIDATE_CODE" "$START_CODE" "$SESSION_CODE" "$NETWORK_STARTED_AT" "$NETWORK_FINISHED_AT" <<'PY'
import json
import os
import sys

(path, kind, install_kind, git_code, git_attempt_code, binary_code, backup_code,
 download_code, download_initial_code, download_retry_code, dns_retry_attempted,
 dns_repair_code, validate_code, start_code, session_code, started_at, finished_at) = sys.argv[1:18]
result = {
    "summary": {
        "network_ready": 1 if kind == "ready" else 0,
        "network_failed": 1 if kind == "failed" else 0,
        "config_refreshed": 1 if kind == "ready" else 0,
        "cloned": 1 if install_kind == "cloned" and kind == "ready" else 0,
        "updated": 1 if install_kind == "updated" and kind == "ready" else 0,
        "cached": 1 if install_kind == "cached" and kind == "ready" else 0,
        "dns_retry": int(dns_retry_attempted),
        "dns_retry_recovered": 1 if dns_retry_attempted == "1" and download_code == "0" else 0,
    },
    "details": [{
        "kind": kind,
        "install_kind": install_kind,
        "git_code": int(git_code),
        "git_attempt_code": int(git_attempt_code),
        "binary_code": int(binary_code),
        "backup_code": int(backup_code),
        "download_code": int(download_code),
        "download_initial_code": int(download_initial_code),
        "download_retry_code": int(download_retry_code),
        "dns_retry_attempted": int(dns_retry_attempted),
        "dns_repair_code": int(dns_repair_code),
        "validate_code": int(validate_code),
        "start_code": int(start_code),
        "session_code": int(session_code),
        "started_at": started_at,
        "finished_at": finished_at,
        "git_output": os.environ.get("GIT_OUTPUT", "")[-800:],
        "validate_output": os.environ.get("VALIDATE_OUTPUT", "")[-800:],
    }],
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=True)
PY
printf '%s\n' "$GIT_OUTPUT"
printf '%s\n' "$VALIDATE_OUTPUT"
if [ "$NETWORK_KIND" != "ready" ]; then exit 1; fi`;
}

export function buildServerNetworkCheckCommand(proxyUrl = DEFAULT_REMOTE_PROXY_URL): string {
  return String.raw`set +e
CHECK_STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROXY_URL=${shellQuote(proxyUrl)}
tmux has-session -t mihomo 2>/dev/null
SESSION_CODE=$?
CHECK_ERROR_FILE="/tmp/server-network-check-${"$"}${"$"}.err"
HTTP_CODE=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 10 --max-time 25 --proxy "$PROXY_URL" https://huggingface.co/ 2>"$CHECK_ERROR_FILE")
CURL_CODE=$?
CHECK_OUTPUT=$(cat "$CHECK_ERROR_FILE" 2>/dev/null)
rm -f "$CHECK_ERROR_FILE"
if [ "$CURL_CODE" -eq 0 ] && [ "$HTTP_CODE" != "000" ]; then
  CHECK_KIND=connected
  CHECK_REASON=connected
elif [ "$SESSION_CODE" -ne 0 ]; then
  CHECK_KIND=unreachable
  CHECK_REASON=tmux_missing
elif [ "$CURL_CODE" -eq 7 ]; then
  CHECK_KIND=unreachable
  CHECK_REASON=proxy_refused
elif [ "$CURL_CODE" -eq 28 ]; then
  CHECK_KIND=unreachable
  CHECK_REASON=timeout
else
  CHECK_KIND=unreachable
  CHECK_REASON=request_failed
fi
CHECK_FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
export CHECK_OUTPUT
python - "$OP_RESULT_FILE" "$CHECK_KIND" "$CHECK_REASON" "$SESSION_CODE" "$CURL_CODE" "$HTTP_CODE" "$PROXY_URL" "$CHECK_STARTED_AT" "$CHECK_FINISHED_AT" <<'PY'
import json
import os
import sys

path, kind, reason, session_code, curl_code, http_code, proxy_url, started_at, finished_at = sys.argv[1:10]
result = {
    "summary": {
        "connected": 1 if kind == "connected" else 0,
        "unreachable": 1 if kind == "unreachable" else 0,
    },
    "details": [{
        "kind": kind,
        "reason": reason,
        "session_code": int(session_code),
        "curl_code": int(curl_code),
        "http_code": http_code,
        "proxy_url": proxy_url,
        "started_at": started_at,
        "finished_at": finished_at,
        "output": os.environ.get("CHECK_OUTPUT", "")[-800:],
    }],
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=True)
PY
printf '%s\n' "$CHECK_OUTPUT"
if [ "$CHECK_KIND" != "connected" ]; then exit 1; fi`;
}

export function buildServerHfConnectivityProbeCommand(
  proxyUrl = DEFAULT_REMOTE_PROXY_URL
): string {
  return String.raw`set +e
PROXY_URL=${shellQuote(proxyUrl)}
PROBE_ERROR_FILE="/tmp/server-hf-probe-${"$"}${"$"}.err"
HTTP_CODE=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 10 --max-time 25 --proxy "$PROXY_URL" https://huggingface.co/ 2>"$PROBE_ERROR_FILE")
CURL_CODE=$?
PROBE_ERROR=$(tail -c 400 "$PROBE_ERROR_FILE" 2>/dev/null)
rm -f "$PROBE_ERROR_FILE"
if [ "$CURL_CODE" -eq 0 ] && [ "$HTTP_CODE" != "000" ]; then CONNECTED=1; else CONNECTED=0; fi
printf 'HF_PROXY_CONNECTED=%s\n' "$CONNECTED"
printf 'HF_PROXY_CURL_CODE=%s\n' "$CURL_CODE"
printf 'HF_PROXY_HTTP_CODE=%s\n' "$HTTP_CODE"
printf 'HF_PROXY_ERROR=%s\n' "$PROBE_ERROR"
exit 0`;
}

export function buildServerUploadCommand({
  solverRoot,
  hfToken,
  proxyUrl = DEFAULT_REMOTE_PROXY_URL,
  redactSecrets = false
}: {
  solverRoot: string;
  hfToken?: string | null;
  proxyUrl?: string;
  redactSecrets?: boolean;
}): string {
  const token = hfToken?.trim();
  if (!token) throw new Error("HF_TOKEN is required for upload operations.");
  return String.raw`set -e
cd ${shellQuoteRemotePath(solverRoot)}
export http_proxy=${shellQuote(proxyUrl)}
export https_proxy=${shellQuote(proxyUrl)}
${redactSecrets ? "export HF_TOKEN=$HF_TOKEN" : `export HF_TOKEN=${shellQuote(token)}`}
python - "$OP_UPLOAD_PLAN_FILE" "$OP_RESULT_FILE" <<'PY'
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

plan_path, result_path = sys.argv[1:3]
with open(plan_path, "r", encoding="utf-8") as handle:
    items = json.load(handle)

summary = {
    "folders": len(set(item.get("resultsDir") or "" for item in items)),
    "folders_completed": 0,
    "folders_remaining": len(set(item.get("resultsDir") or "" for item in items)),
    "upload_attempts": len(items),
    "attempts_completed": 0,
    "attempts_remaining": len(items),
    "upload_success": 0,
    "upload_failed": 0,
    "upload_timeouts": 0,
    "upload_retry_attempts": 0,
    "network_recovery_required": 0,
    "files_requested": sum(int(item.get("fileCount") or 0) for item in items),
    "files_found": 0,
    "files_uploaded": 0,
    "files_deleted": 0,
    "files_remaining": 0,
    "current_dataset": "",
    "current_results_dir": "",
    "current_file_format": "",
    "current_item_index": 0,
    "current_attempt": 0,
    "current_idle_timeout_seconds": 0,
    "current_hard_timeout_seconds": 0,
    "no_files": 1 if not items else 0,
    "duration_seconds": 0,
}
details = []
started = time.time()
states = []

for item in items:
    file_format = item.get("fileFormat") or "parquet"
    pattern = "*.parquet" if file_format == "parquet" else "*.json"
    result_dir = Path(item["resultsDir"]).expanduser()
    files_before = len(list(result_dir.glob(pattern))) if result_dir.is_dir() else 0
    states.append({
        "processed": False,
        "success": False,
        "remaining": files_before,
        "results_dir": item["resultsDir"],
    })
    summary["files_found"] += files_before
summary["files_remaining"] = summary["files_found"]

def write_progress():
    summary["attempts_completed"] = sum(1 for state in states if state["processed"])
    summary["attempts_remaining"] = max(0, summary["upload_attempts"] - summary["attempts_completed"])
    folder_paths = {state["results_dir"] for state in states}
    completed_folders = sum(
        1
        for folder in folder_paths
        if all(state["processed"] for state in states if state["results_dir"] == folder)
    )
    summary["folders_completed"] = completed_folders
    summary["folders_remaining"] = max(0, summary["folders"] - completed_folders)
    summary["files_remaining"] = sum(int(state["remaining"]) for state in states)
    summary["duration_seconds"] = max(0, round(time.time() - started))
    target = Path(result_path).expanduser()
    temporary = target.with_name(target.name + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"summary": summary, "details": details}, handle, ensure_ascii=True)
    temporary.replace(target)

def bounded_env_int(name, default, minimum, maximum):
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))

UPLOAD_IDLE_TIMEOUT_SECONDS = bounded_env_int("SERVER_UPLOAD_IDLE_TIMEOUT_SECONDS", 600, 1, 3600)
UPLOAD_HARD_BASE_SECONDS = bounded_env_int("SERVER_UPLOAD_HARD_BASE_SECONDS", 900, 1, 7200)
UPLOAD_HARD_PER_FILE_SECONDS = bounded_env_int("SERVER_UPLOAD_HARD_PER_FILE_SECONDS", 45, 1, 300)
UPLOAD_HARD_MAX_SECONDS = bounded_env_int("SERVER_UPLOAD_HARD_MAX_SECONDS", 7200, 1, 21600)
UPLOAD_TERMINATE_GRACE_SECONDS = bounded_env_int("SERVER_UPLOAD_TERMINATE_GRACE_SECONDS", 5, 1, 30)
UPLOAD_MAX_ATTEMPTS = bounded_env_int("SERVER_UPLOAD_MAX_ATTEMPTS", 3, 1, 5)

def descendant_pids(root_pid):
    children = {}
    try:
        proc_entries = list(Path("/proc").iterdir())
    except OSError:
        return []
    for entry in proc_entries:
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(encoding="utf-8")
            fields = stat.rsplit(")", 1)[1].split()
            parent_pid = int(fields[1])
            children.setdefault(parent_pid, []).append(int(entry.name))
        except (OSError, ValueError, IndexError):
            continue
    descendants = []
    pending = list(children.get(root_pid, []))
    while pending:
        pid = pending.pop()
        descendants.append(pid)
        pending.extend(children.get(pid, []))
    return descendants

def signal_pid(pid, sig):
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass

def terminate_process_tree(process):
    tracked_descendants = descendant_pids(process.pid)
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        signal_pid(process.pid, signal.SIGTERM)
    for pid in reversed(tracked_descendants):
        signal_pid(pid, signal.SIGTERM)
    try:
        process.wait(timeout=UPLOAD_TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            signal_pid(process.pid, signal.SIGKILL)
    for pid in reversed(tracked_descendants):
        signal_pid(pid, signal.SIGKILL)
    try:
        process.wait(timeout=UPLOAD_TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        signal_pid(process.pid, signal.SIGKILL)

def run_upload_attempt(command, idle_timeout, hard_timeout):
    environment = os.environ.copy()
    environment["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=environment,
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    selector.register(process.stdout, selectors.EVENT_READ)
    started_at = time.monotonic()
    last_output_at = started_at
    output_tail = ""
    timeout_reason = ""

    while process.poll() is None:
        for key, _ in selector.select(timeout=1):
            try:
                chunk = os.read(key.fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                last_output_at = time.monotonic()
                text = chunk.decode("utf-8", errors="replace")
                output_tail = (output_tail + text)[-32768:]
                print(text, end="", flush=True)
            else:
                try:
                    selector.unregister(key.fileobj)
                except (KeyError, ValueError):
                    pass

        now = time.monotonic()
        if now - last_output_at >= idle_timeout:
            timeout_reason = "idle_timeout"
        elif now - started_at >= hard_timeout:
            timeout_reason = "hard_timeout"
        if timeout_reason:
            message = (
                "[Upload] watchdog %s after %ss idle / %ss total; "
                "terminating the upload process group\n"
            ) % (timeout_reason, round(now - last_output_at), round(now - started_at))
            output_tail = (output_tail + message)[-32768:]
            print(message, end="", flush=True)
            terminate_process_tree(process)
            break

    if process.poll() is None:
        terminate_process_tree(process)
    try:
        remainder = process.stdout.read() if process.poll() is not None else b""
    except OSError:
        remainder = b""
    if remainder:
        text = remainder.decode("utf-8", errors="replace")
        output_tail = (output_tail + text)[-32768:]
        print(text, end="", flush=True)
    selector.close()
    return_code = process.returncode if process.returncode is not None else 137
    return (124 if timeout_reason else return_code, output_tail, timeout_reason)

def is_network_failure(output, timeout_reason):
    if timeout_reason:
        return True
    lowered = output.lower()
    return any(marker in lowered for marker in (
        "unexpected_eof_while_reading",
        "connecterror",
        "connection reset",
        "connection aborted",
        "network is unreachable",
        "timed out",
        "timeout",
        "502 bad gateway",
        "503 service unavailable",
        "504 gateway timeout",
    ))

write_progress()

for item_index, item in enumerate(items):
    file_count = int(item.get("fileCount") or 0)
    file_format = item.get("fileFormat") or "parquet"
    pattern = "*.parquet" if file_format == "parquet" else "*.json"
    result_dir = Path(item["resultsDir"]).expanduser()
    files_before = len(list(result_dir.glob(pattern))) if result_dir.is_dir() else 0
    summary["current_dataset"] = item.get("datasetName") or item.get("repoId") or ""
    summary["current_results_dir"] = item["resultsDir"]
    summary["current_file_format"] = file_format
    summary["current_item_index"] = item_index + 1
    states[item_index]["remaining"] = files_before
    write_progress()
    command = [
        "python",
        "upload.py",
        "--results-dir",
        item["resultsDir"],
        "--repo-id",
        item["repoId"],
        "--file-format",
        file_format,
    ]
    item_started = time.time()
    print("[Upload]", item["repoId"], "<-", item["resultsDir"], flush=True)
    # A single transient proxy/Hugging Face failure must not consume the whole
    # batch. Probe the configured proxy before each retry and retry the item in
    # place; the operation remains observable and progress continues updating.
    process_returncode = 1
    output_parts = []
    timeout_reason = ""
    network_failure_detected = False
    idle_timeout = UPLOAD_IDLE_TIMEOUT_SECONDS
    hard_timeout = min(
        UPLOAD_HARD_MAX_SECONDS,
        max(idle_timeout * 2, UPLOAD_HARD_BASE_SECONDS + files_before * UPLOAD_HARD_PER_FILE_SECONDS),
    )
    for attempt in range(1, UPLOAD_MAX_ATTEMPTS + 1):
        summary["current_attempt"] = attempt
        summary["current_idle_timeout_seconds"] = idle_timeout
        summary["current_hard_timeout_seconds"] = hard_timeout
        if attempt > 1:
            summary["upload_retry_attempts"] += 1
        write_progress()
        if attempt > 1:
            probe = subprocess.run(
                ["curl", "--silent", "--show-error", "--output", "/dev/null",
                 "--write-out", "%{http_code}", "--connect-timeout", "10",
                 "--max-time", "25", "--proxy", os.environ.get("https_proxy", ""),
                 "https://huggingface.co/"],
                text=True, capture_output=True,
            )
            print("[Upload] proxy check attempt", attempt, "code", probe.returncode,
                  "http", (probe.stdout or "").strip(), flush=True)
            if probe.returncode != 0:
                print("[Upload] proxy unavailable; ending this operation so automatic Network Sync can recover it", flush=True)
                network_failure_detected = True
                break
        print(
            "[Upload] attempt %d/%d (idle timeout %ss, hard timeout %ss)" %
            (attempt, UPLOAD_MAX_ATTEMPTS, idle_timeout, hard_timeout),
            flush=True,
        )
        process_returncode, attempt_output, timeout_reason = run_upload_attempt(
            command,
            idle_timeout,
            hard_timeout,
        )
        output_parts.append("[attempt %d]\n%s" % (attempt, attempt_output))
        if timeout_reason:
            summary["upload_timeouts"] += 1
        if is_network_failure(attempt_output, timeout_reason):
            network_failure_detected = True
        if process_returncode == 0:
            break
        print("[Upload] failed attempt", attempt, "for", item["repoId"], flush=True)
        if attempt < UPLOAD_MAX_ATTEMPTS:
            time.sleep(min(30, 5 * attempt))
    output = "\n".join(output_parts)
    duration = max(0, round(time.time() - item_started))
    success = process_returncode == 0
    if not success and network_failure_detected:
        summary["network_recovery_required"] = 1
    files_after = len(list(result_dir.glob(pattern))) if result_dir.is_dir() else 0
    files_deleted = max(0, files_before - files_after)
    files_uploaded = files_before if success else 0
    summary["files_uploaded"] += files_uploaded
    summary["files_deleted"] += files_deleted
    summary["files_remaining"] += files_after
    if success:
        summary["upload_success"] += 1
    else:
        summary["upload_failed"] += 1
    states[item_index]["processed"] = True
    states[item_index]["success"] = success
    states[item_index]["remaining"] = files_after
    details.append({
        "dataset_name": item.get("datasetName") or "",
        "repo_id": item["repoId"],
        "job_id": item.get("jobId") or "",
        "results_dir": item["resultsDir"],
        "file_format": file_format,
        "file_count": file_count,
        "files_found": files_before,
        "files_uploaded": files_uploaded,
        "files_deleted": files_deleted,
        "files_remaining": files_after,
        "exit_code": process_returncode,
        "success": success,
        "timed_out": bool(timeout_reason),
        "timeout_reason": timeout_reason or None,
        "duration_seconds": duration,
        "output_tail": output[-1600:],
    })
    summary["current_dataset"] = ""
    summary["current_results_dir"] = ""
    summary["current_file_format"] = ""
    summary["current_item_index"] = 0
    summary["current_attempt"] = 0
    summary["current_idle_timeout_seconds"] = 0
    summary["current_hard_timeout_seconds"] = 0
    write_progress()
    if not success:
        # Finish promptly so the backend can run its retained-result scan,
        # restart the proxy, verify Hugging Face, and launch a fresh upload.
        break

write_progress()
sys.exit(0 if summary["upload_failed"] == 0 else 1)
PY`;
}

export function buildServerUploadPlan(items: ServerUploadItem[]): string {
  return JSON.stringify(items.map((item) => ({
    datasetName: item.datasetName,
    repoId: item.repoId,
    jobId: item.jobId ?? "",
    resultsDir: item.resultsDir,
    fileFormat: item.fileFormat,
    fileCount: item.fileCount ?? 0
  })));
}

export function buildStageServerOperationFileCommand(remotePath: string): string {
  const target = shellQuoteRemotePath(remotePath);
  return String.raw`set -e
TARGET=${target}
mkdir -p "$(dirname "$TARGET")"
umask 077
TEMP="${"$"}{TARGET}.tmp.${"$"}${"$"}"
trap 'rm -f -- "$TEMP"' EXIT
cat > "$TEMP"
mv -f -- "$TEMP" "$TARGET"
trap - EXIT`;
}

export function buildDeleteUploadCandidateCommand(solverRoot: string, resultsDir: string): string {
  const resultsRoot = joinRemotePath(solverRoot, "results");
  return String.raw`set -e
RESULTS_ROOT=${shellQuoteRemotePath(resultsRoot)}
TARGET=${shellQuoteRemotePath(resultsDir)}
[ -d "$RESULTS_ROOT" ] || { echo "Results root does not exist" >&2; exit 2; }
[ -d "$TARGET" ] || { echo "Result folder does not exist" >&2; exit 3; }
ROOT_REAL=$(realpath -e "$RESULTS_ROOT")
TARGET_REAL=$(realpath -e "$TARGET")
case "$TARGET_REAL" in
  "$ROOT_REAL"/*/*) ;;
  *) echo "Refusing to delete a path outside results/<dataset>/<job-id>" >&2; exit 4 ;;
esac
RELATIVE=${"${TARGET_REAL#\"$ROOT_REAL\"/}"}
case "$RELATIVE" in
  */*/*|/*|*/|"") echo "Refusing to delete a non-job result folder" >&2; exit 5 ;;
esac
DATASET=${"${RELATIVE%%/*}"}
JOB_ID=${"${RELATIVE#*/}"}
PARQUET_COUNT=$(find "$TARGET_REAL" -maxdepth 1 -type f -name '*.parquet' | wc -l | tr -d ' ')
JSON_COUNT=$(find "$TARGET_REAL" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
rm -rf -- "$TARGET_REAL"
[ ! -e "$TARGET_REAL" ] || { echo "Result folder still exists after deletion" >&2; exit 6; }
printf 'DELETED\t%s\t%s\t%s\t%s\t%s\n' "$TARGET_REAL" "$DATASET" "$JOB_ID" "$PARQUET_COUNT" "$JSON_COUNT"`;
}

export function buildTrackedServerOperationCommand({
  id,
  type,
  statusFilePath,
  logFilePath,
  bodyCommand
}: {
  id: string;
  type: ServerOperation["type"];
  statusFilePath: string;
  logFilePath: string;
  bodyCommand: string;
}): string {
  return String.raw`set -u
OP_ID=${shellQuote(id)}
OP_TYPE=${shellQuote(type)}
STATUS_FILE=${shellQuoteRemotePath(statusFilePath)}
LOG_FILE=${shellQuoteRemotePath(logFilePath)}
OP_RESULT_FILE="${"$"}{STATUS_FILE}.result"
OP_UPLOAD_PLAN_FILE="${"$"}{STATUS_FILE}.upload-plan.json"
mkdir -p "$(dirname "$STATUS_FILE")" "$(dirname "$LOG_FILE")"
rm -f "$OP_RESULT_FILE"
OP_STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
printf '{"id":"%s","type":"%s","status":"running","started_at":"%s","updated_at":"%s","exit_code":null,"log_file":"%s","result":null}\n' "$OP_ID" "$OP_TYPE" "$OP_STARTED_AT" "$OP_STARTED_AT" "$LOG_FILE" > "$STATUS_FILE"
set +e
(
${bodyCommand}
) > "$LOG_FILE" 2>&1
OP_CODE=$?
OP_FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ "$OP_CODE" -eq 0 ]; then OP_STATUS=completed; else OP_STATUS=failed; fi
if [ -s "$OP_RESULT_FILE" ]; then OP_RESULT_JSON=$(cat "$OP_RESULT_FILE"); else OP_RESULT_JSON='{"summary":{},"details":[]}'; fi
printf '{"id":"%s","type":"%s","status":"%s","started_at":"%s","finished_at":"%s","updated_at":"%s","exit_code":%s,"log_file":"%s","result":%s}\n' "$OP_ID" "$OP_TYPE" "$OP_STATUS" "$OP_STARTED_AT" "$OP_FINISHED_AT" "$OP_FINISHED_AT" "$OP_CODE" "$LOG_FILE" "$OP_RESULT_JSON" > "$STATUS_FILE"
rm -f "$OP_UPLOAD_PLAN_FILE"
exit "$OP_CODE"`;
}

export function buildScanUploadCandidatesCommand(solverRoot: string, repoNamespace = "Tsumugii"): string {
  const resultsRoot = joinRemotePath(solverRoot, "results");
  return String.raw`set -e
RESULTS_ROOT=${shellQuoteRemotePath(resultsRoot)}
REPO_NAMESPACE=${shellQuote(repoNamespace)}
[ -d "$RESULTS_ROOT" ] || exit 0
find "$RESULTS_ROOT" -mindepth 2 -maxdepth 2 -type d -print | sort | while IFS= read -r DIR; do
  PARQUET_COUNT=$(find "$DIR" -maxdepth 1 -type f -name '*.parquet' | wc -l | tr -d ' ')
  JSON_COUNT=$(find "$DIR" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
  if [ "$PARQUET_COUNT" -gt 0 ] || [ "$JSON_COUNT" -gt 0 ]; then
    DATASET=$(basename "$(dirname "$DIR")")
    JOB_ID=$(basename "$DIR")
    printf 'CANDIDATE\t%s\t%s\t%s\t%s\t%s\t%s/%s\n' "$DATASET" "$JOB_ID" "$DIR" "$PARQUET_COUNT" "$JSON_COUNT" "$REPO_NAMESPACE" "$DATASET"
  fi
done`;
}

export function buildReadServerOperationStatusCommand(statusFilePath: string, tmuxSession = ""): string {
  return String.raw`set +e
STATUS_FILE=${shellQuoteRemotePath(statusFilePath)}
SESSION=${shellQuote(tmuxSession)}
RESULT_FILE="${"$"}{STATUS_FILE}.result"
PLAN_FILE="${"$"}{STATUS_FILE}.upload-plan.json"
if [ -f "$STATUS_FILE" ]; then
  echo "OP_STATUS_FILE=1"
else
  echo "OP_STATUS_FILE=0"
fi
if [ -n "$SESSION" ] && tmux has-session -t "$SESSION" 2>/dev/null; then
  TMUX_ALIVE=1
  echo "OP_TMUX_ALIVE=1"
else
  TMUX_ALIVE=0
  echo "OP_TMUX_ALIVE=0"
fi
if [ -f "$STATUS_FILE" ]; then
PYTHON_BIN=$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)
if [ -z "$PYTHON_BIN" ] && [ -x "$HOME/miniconda3/bin/python" ]; then
  PYTHON_BIN="$HOME/miniconda3/bin/python"
fi
if [ -n "$PYTHON_BIN" ]; then
"$PYTHON_BIN" - "$STATUS_FILE" "$RESULT_FILE" "$PLAN_FILE" "$TMUX_ALIVE" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

status_path, result_path, plan_path, tmux_alive = sys.argv[1:5]

def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None

status = read_json(status_path)
if not isinstance(status, dict):
    raise SystemExit(1)

result = read_json(result_path)
if isinstance(result, dict):
    status["result"] = result
elif status.get("type") == "upload" and status.get("status") == "running":
    plan = read_json(plan_path)
    if isinstance(plan, list):
        records = []
        for item in plan:
            if not isinstance(item, dict):
                continue
            file_format = item.get("fileFormat") or "parquet"
            pattern = "*.parquet" if file_format == "parquet" else "*.json"
            result_dir = Path(str(item.get("resultsDir") or "")).expanduser()
            remaining = len(list(result_dir.glob(pattern))) if result_dir.is_dir() else 0
            requested = int(item.get("fileCount") or 0)
            records.append((item, file_format, requested, remaining))
        folder_paths = {str(item.get("resultsDir") or "") for item, _, _, _ in records}
        completed_paths = {
            folder
            for folder in folder_paths
            if all(remaining == 0 for item, _, _, remaining in records if str(item.get("resultsDir") or "") == folder)
        }
        files_requested = sum(requested for _, _, requested, _ in records)
        files_remaining = sum(remaining for _, _, _, remaining in records)
        attempts_completed = sum(1 for _, _, _, remaining in records if remaining == 0)
        current_record = None
        log_path = status.get("log_file")
        if tmux_alive == "1" and isinstance(log_path, str):
            try:
                with open(Path(log_path).expanduser(), "rb") as handle:
                    handle.seek(0, 2)
                    size = handle.tell()
                    handle.seek(max(0, size - 131072))
                    tail_lines = handle.read().decode("utf-8", errors="replace").splitlines()
                upload_line = next((line for line in reversed(tail_lines) if line.startswith("[Upload] ") and " <- " in line), "")
                current_path = upload_line.rsplit(" <- ", 1)[1].strip() if upload_line else ""
                current_record = next(
                    (record for record in records if str(record[0].get("resultsDir") or "") == current_path and record[3] > 0),
                    None,
                )
            except OSError:
                pass
        started_at = status.get("started_at")
        duration = 0
        if isinstance(started_at, str):
            try:
                duration = max(0, round((datetime.now(timezone.utc) - datetime.fromisoformat(started_at.replace("Z", "+00:00"))).total_seconds()))
            except ValueError:
                pass
        details = []
        for item, file_format, requested, remaining in records:
            if remaining != 0:
                continue
            details.append({
                "dataset_name": item.get("datasetName") or "",
                "repo_id": item.get("repoId") or "",
                "job_id": item.get("jobId") or "",
                "results_dir": item.get("resultsDir") or "",
                "file_format": file_format,
                "file_count": requested,
                "files_found": requested,
                "files_uploaded": requested,
                "files_deleted": requested,
                "files_remaining": 0,
                "exit_code": 0,
                "success": True,
                "inferred": True,
                "duration_seconds": 0,
            })
        current_item = current_record[0] if current_record else {}
        status["result"] = {
            "summary": {
                "folders": len(folder_paths),
                "folders_completed": len(completed_paths),
                "folders_remaining": max(0, len(folder_paths) - len(completed_paths)),
                "upload_attempts": len(records),
                "attempts_completed": attempts_completed,
                "attempts_remaining": max(0, len(records) - attempts_completed),
                "upload_success": attempts_completed,
                "upload_failed": 0,
                "files_requested": files_requested,
                "files_found": files_requested,
                "files_uploaded": max(0, files_requested - files_remaining),
                "files_deleted": max(0, files_requested - files_remaining),
                "files_remaining": files_remaining,
                "current_dataset": current_item.get("datasetName") or current_item.get("repoId") or "",
                "current_results_dir": current_item.get("resultsDir") or "",
                "current_file_format": current_item.get("fileFormat") or "",
                "current_item_index": (records.index(current_record) + 1) if current_record else 0,
                "no_files": 1 if not records else 0,
                "duration_seconds": duration,
                "progress_inferred": True,
            },
            "details": details,
        }
        status["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

print(json.dumps(status, ensure_ascii=True, separators=(",", ":")))
PY
if [ "$?" -ne 0 ]; then cat "$STATUS_FILE"; fi
else
  cat "$STATUS_FILE"
fi
fi`;
}

export function buildStopServerOperationCommand(tmuxSession: string): string {
  return [
    "set -u",
    `SESSION=${shellQuote(tmuxSession)}`,
    `tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" || true`
  ].join("\n");
}

export function buildDispatchPreflightCommand(
  statusFilePath: string,
  proxyUrl: string | null = null,
  options: { solverRoot?: string; requireSettingFile?: boolean } = {}
): string {
  const settingFileCheck = options.requireSettingFile
    ? String.raw`RUN_PIPELINE=${shellQuoteRemotePath(joinRemotePath(options.solverRoot ?? DEFAULT_SOLVER_ROOT, "run_pipeline.py"))}
if [ ! -f "$RUN_PIPELINE" ] || ! grep -q -- '--setting-file' "$RUN_PIPELINE"; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON_CODE=setting_file_unsupported"
  echo "DISPATCH_REASON=solver does not support --setting-file; run Code Sync first"
  exit 0
fi
`
    : "";
  const networkCheck = proxyUrl
    ? String.raw`PROXY_URL=${shellQuote(proxyUrl)}
if ! tmux has-session -t mihomo 2>/dev/null; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON_CODE=mihomo_missing"
  echo "DISPATCH_REASON=mihomo tmux session is not running; run Sync Network first"
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON_CODE=curl_missing"
  echo "DISPATCH_REASON=curl is required for proxy verification"
  exit 0
fi
if ! curl --silent --show-error --fail --output /dev/null --max-time 8 --proxy "$PROXY_URL" https://huggingface.co/; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON_CODE=hugging_face_unreachable"
  echo "DISPATCH_REASON=Hugging Face is unreachable through $PROXY_URL; run Sync Network first"
  exit 0
fi
`
    : "";
  const solverRoot = options.solverRoot ?? DEFAULT_SOLVER_ROOT;
  const interactiveRuntimeProbe = [
    `cd ${shellQuoteRemotePath(solverRoot)}`,
    "test -n \"${CONDA_PREFIX:-}\"",
    "command -v python >/dev/null 2>&1",
    "python --version >/dev/null 2>&1"
  ].join(" && ");
  const pythonRuntimeCheck = String.raw`if ! bash -ic ${shellQuote(interactiveRuntimeProbe)} >/dev/null 2>&1; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON_CODE=solver_python_unavailable"
  echo "DISPATCH_REASON=interactive Conda Python is unavailable; repair Conda initialization on the server"
  exit 0
fi
`;
  return String.raw`set -e
${settingFileCheck}${pythonRuntimeCheck}STATUS_FILE=${shellQuoteRemotePath(statusFilePath)}
PID=""
if [ -f "$STATUS_FILE" ]; then
  PID=$(grep -Eo '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STATUS_FILE" | tail -1 | grep -Eo '[0-9]+$' || true)
fi
if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON_CODE=active_pid"
  echo "DISPATCH_REASON=active pid $PID"
else
  ${networkCheck}  echo "DISPATCH_READY=1"
fi`;
}

export function buildGracefulStopPipelineCommand(job: SolverJob): string {
  return String.raw`set -u
SESSION=${shellQuote(job.tmuxSession)}
STATUS_FILE=${shellQuote(statusFileFromJob(job))}
case "$STATUS_FILE" in
  "~/"*) STATUS_FILE="$HOME/${"$"}{STATUS_FILE#??}" ;;
esac
PID=""
if [ -f "$STATUS_FILE" ]; then
  PID=$(grep -Eo '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STATUS_FILE" | tail -1 | grep -Eo '[0-9]+$' || true)
fi
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux send-keys -t "$SESSION" C-c || true
  echo "TMUX_SIGNAL_SENT=1"
else
  echo "TMUX_SIGNAL_SENT=0"
fi
sleep 8
if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
  echo "PIPELINE_ALIVE=1"
else
  echo "PIPELINE_ALIVE=0"
fi`;
}

export function buildForceKillPipelineCommand(job: SolverJob): string {
  return String.raw`set -u
SESSION=${shellQuote(job.tmuxSession)}
STATUS_FILE=${shellQuote(statusFileFromJob(job))}
case "$STATUS_FILE" in
  "~/"*) STATUS_FILE="$HOME/${"$"}{STATUS_FILE#??}" ;;
esac
PID=""
PGID=""
if [ -f "$STATUS_FILE" ]; then
  PID=$(grep -Eo '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STATUS_FILE" | tail -1 | grep -Eo '[0-9]+$' || true)
fi
if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
  PGID=$(ps -o pgid= -p "$PID" | tr -d ' ' || true)
  if [ -n "$PGID" ]; then
    kill -TERM "-$PGID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
  else
    kill -TERM "$PID" 2>/dev/null || true
  fi
  echo "PIPELINE_TERM_SENT=1"
else
  echo "PIPELINE_TERM_SENT=0"
fi
sleep 3
tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" || true
echo "TMUX_SESSION_KILLED=1"
sleep 1
if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
  if [ -n "$PGID" ]; then
    kill -KILL "-$PGID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  else
    kill -KILL "$PID" 2>/dev/null || true
  fi
  echo "PIPELINE_KILL_SENT=1"
else
  echo "PIPELINE_KILL_SENT=0"
fi`;
}

function statusFileFromJob(job: SolverJob): string {
  const match = job.command.match(/(?:--status-file|'--status-file'|"--status-file")\s+('([^']|'\\'')*'|"[^"]+"|\S+)/);
  const raw = match?.[1] ?? "~/run/solver_running_status.json";
  return raw.replace(/^'|'$/g, "").replace(/'\\''/g, "'");
}

function settingFilePathFromCommand(command: string): string | null {
  const match = command.match(/(?:--setting-file|'--setting-file'|"--setting-file")\s+('([^']|'\\'')*'|"[^"]+"|\S+)/);
  if (!match?.[1]) return null;
  return match[1]
    .replace(/^'|'$/g, "")
    .replace(/^"|"$/g, "")
    .replace(/'\\''/g, "'");
}

function stopCommandReportsRunning(output: string): boolean {
  return /^PIPELINE_ALIVE=1$/m.test(output);
}

function formatCombinedPlayerRange(document: PreflopRangeDocument, player: PreflopPlayerKey): string {
  const raise = parseRangeText(document[player].raise);
  const call = parseRangeText(document[player].call);
  return PREFLOP_HAND_CODES
    .flatMap((hand) => {
      const value = Math.min(1, (raise[hand] ?? 0) + (call[hand] ?? 0));
      if (value <= 0) return [];
      if (Math.abs(value - 1) < 0.0005) return [hand];
      return [`${hand}:${value.toFixed(3)}`];
    })
    .join(",");
}

function playerForPosition(document: PreflopRangeDocument, position: "OOP" | "IP"): PreflopPlayerKey | null {
  const matches = PREFLOP_PLAYERS.filter((player) => document.player_positions[player] === position);
  return matches.length === 1 ? matches[0]! : null;
}

function completedStatusFromPipeline(pipeline: PipelineStatusSnapshot | null): SolverJobStatus {
  if (!pipeline) return "interrupted";
  if (pipeline.displayStatus === "completed" || pipeline.displayStatus === "completed_with_upload_failures") {
    if (pipelineBoardFailureCount(pipeline) > 0) return "failed";
    return "completed";
  }
  if (
    pipeline.displayStatus === "failed" ||
    pipeline.displayStatus === "exited" ||
    pipeline.displayStatus === "stale" ||
    pipeline.displayStatus === "idle" ||
    pipeline.displayStatus === "unavailable"
  ) {
    return "failed";
  }
  return "interrupted";
}

function pipelineBoardFailureCount(pipeline: PipelineStatusSnapshot): number {
  return pipeline.failedCount ?? pipeline.failedIndices.length;
}

function pipelineBelongsToJob(pipeline: PipelineStatusSnapshot, job: SolverJob): boolean {
  if (pipeline.resultPath?.includes(job.id) || pipeline.command?.includes(job.id)) return true;
  const identityMatches = pipeline.repoId === job.repoId || pipeline.datasetName === job.datasetName;
  if (!identityMatches) return false;
  const jobReference = Date.parse(job.startedAt ?? job.createdAt);
  const pipelineStartedAt = Date.parse(pipeline.startedAt ?? "");
  return Number.isFinite(jobReference) &&
    Number.isFinite(pipelineStartedAt) &&
    pipelineStartedAt >= jobReference - ACTIVE_JOB_RECONCILE_GRACE_MS;
}

function serverIsOnline(server: ServerRow): boolean {
  return serverIsJobReady(server);
}

function serverIsReadyForParallelSelection(server: ServerRow, activeJob: SolverJob | null): boolean {
  return server.enabled && serverIsOnline(server) && !activeJob && !isPipelineActive(server.pipeline);
}

function parseDispatchPreflightOutput(output: string): DispatchPreflightResult {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const readyLine = lines.find((line) => line.startsWith("DISPATCH_READY="));
  const reasonCodeLine = lines.find((line) => line.startsWith("DISPATCH_REASON_CODE="));
  const reasonLine = lines.find((line) => line.startsWith("DISPATCH_REASON="));
  return {
    ready: readyLine === "DISPATCH_READY=1",
    reason: reasonLine ? reasonLine.slice("DISPATCH_REASON=".length).trim() || null : null,
    reasonCode: reasonCodeLine
      ? reasonCodeLine.slice("DISPATCH_REASON_CODE=".length).trim() || null
      : null
  };
}

function pipelineIsNewEnoughForJob(pipeline: PipelineStatusSnapshot, job: SolverJob): boolean {
  const reference = Date.parse(job.startedAt ?? job.updatedAt ?? job.createdAt);
  const collected = Date.parse(pipeline.collectedAt);
  if (!Number.isFinite(reference) || !Number.isFinite(collected)) return false;
  return collected - reference >= ACTIVE_JOB_RECONCILE_GRACE_MS;
}

function pipelineCanSettleActiveJob(pipeline: PipelineStatusSnapshot, job: SolverJob): boolean {
  if (pipelineBelongsToJob(pipeline, job)) return !isPipelineActive(pipeline);
  if (isPipelineActive(pipeline)) return true;
  return (
    pipeline.displayStatus === "idle" ||
    pipeline.displayStatus === "stale" ||
    pipeline.displayStatus === "failed" ||
    pipeline.displayStatus === "exited" ||
    pipeline.displayStatus === "completed" ||
    pipeline.displayStatus === "completed_with_upload_failures"
  );
}

function pipelineReconciliationError(pipeline: PipelineStatusSnapshot, job: SolverJob): string {
  const failedBoards = pipelineBoardFailureCount(pipeline);
  if (failedBoards > 0) {
    const skippedBoards = pipeline.skippedCount ?? pipeline.skippedIndices.length;
    return `${failedBoards} board(s) failed or skipped in solver output (${skippedBoards} skipped).`;
  }
  if (pipeline.errorMessage) return pipeline.errorMessage;
  if (pipeline.error) return pipeline.error;
  if (!pipelineBelongsToJob(pipeline, job) && isPipelineActive(pipeline)) {
    const task = pipeline.datasetName ?? pipeline.repoId ?? pipeline.displayStatus;
    return `Server is running a different task (${task}).`;
  }
  if (pipeline.displayStatus === "idle") {
    return "Server reports task IDLE after job start; the pipeline command may have exited before solver status was written.";
  }
  if (pipeline.displayStatus === "stale") {
    return "Server reports a stale solver task; the recorded process is no longer running.";
  }
  if (pipeline.displayStatus === "exited") {
    return "Solver task exited before completing.";
  }
  if (!pipelineBelongsToJob(pipeline, job)) {
    const task = pipeline.datasetName ?? pipeline.repoId ?? pipeline.displayStatus;
    return `Server still reports a previous or different task (${task}) after job dispatch; the solver command did not take ownership.`;
  }
  return `Server task status is ${pipeline.displayStatus}.`;
}

function isPipelineActive(pipeline: PipelineStatusSnapshot | null): boolean {
  return Boolean(
    pipeline &&
      pipeline.processAlive !== false &&
      (pipeline.displayStatus === "running" ||
        pipeline.displayStatus === "solving" ||
        pipeline.displayStatus === "uploading" ||
        pipeline.displayStatus === "cleanup")
  );
}

function normalizeSelectedServerIds(
  serverIds: string[] | undefined,
  defaultServers: ServerRow[],
  allowedServers = defaultServers
): string[] {
  const defaultIds = defaultServers.map((server) => server.id);
  const allowedIds = allowedServers.map((server) => server.id);
  const requested = serverIds?.map((id) => id.trim()).filter(Boolean) ?? [];
  const selected = requested.length > 0 ? requested : defaultIds;
  const unique: string[] = [];
  for (const id of selected) {
    if (!allowedIds.includes(id)) {
      throw new Error(`Server ${id} is not enabled for parallel jobs.`);
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

function normalizeParallelServerScope(
  input: Pick<ParallelSolverJobPreviewRequest, "serverScope" | "autoIncludeNewServers">
): ParallelServerSelectionScope {
  return input.serverScope ?? (input.autoIncludeNewServers === true ? "all" : "standard");
}

function sortServersByNaturalId<T extends Pick<ServerRow, "id">>(servers: T[]): T[] {
  return [...servers].sort((left, right) => left.id.localeCompare(right.id, undefined, {
    numeric: true,
    sensitivity: "base"
  }));
}

function uniqueServersById(servers: ServerRow[]): ServerRow[] {
  const seen = new Set<string>();
  const result: ServerRow[] = [];
  for (const server of servers) {
    if (seen.has(server.id)) continue;
    seen.add(server.id);
    result.push(server);
  }
  return result;
}

function buildParallelDispatchSafetyState(
  failures: ParallelDispatchFailureRecord[],
  now = Date.now()
): ParallelDispatchSafetyState {
  const failedServerIdsBySlice = new Map<string, Set<string>>();
  const failuresByServer = new Map<string, ParallelDispatchFailureRecord[]>();
  for (const failure of failures) {
    const failedServerIds = failedServerIdsBySlice.get(failure.sliceId) ?? new Set<string>();
    failedServerIds.add(failure.serverId);
    failedServerIdsBySlice.set(failure.sliceId, failedServerIds);
    const serverFailures = failuresByServer.get(failure.serverId) ?? [];
    serverFailures.push(failure);
    failuresByServer.set(failure.serverId, serverFailures);
  }

  const activeQuarantines = new Map<string, ParallelDispatchQuarantine>();
  for (const [serverId, serverFailures] of failuresByServer) {
    const ordered = [...serverFailures].sort((left, right) => Date.parse(left.failedAt) - Date.parse(right.failedAt));
    const latest = ordered.at(-1)!;
    const latestAt = Date.parse(latest.failedAt);
    const durationIndex = Math.min(
      ordered.length - 1,
      PARALLEL_DISPATCH_QUARANTINE_DURATIONS_MS.length - 1
    );
    const blockedUntilTimestamp = (Number.isFinite(latestAt) ? latestAt : now) +
      PARALLEL_DISPATCH_QUARANTINE_DURATIONS_MS[durationIndex]!;
    if (blockedUntilTimestamp <= now) continue;
    activeQuarantines.set(serverId, {
      serverId,
      failureCount: ordered.length,
      blockedUntil: new Date(blockedUntilTimestamp).toISOString(),
      latestError: latest.error
    });
  }
  return { activeQuarantines, failedServerIdsBySlice };
}

export function summarizeParallelSolverRun(run: ParallelSolverRun): ParallelSolverRunSummary {
  const {
    setting,
    solverRangeText: _solverRangeText,
    totalIndices: _totalIndices,
    missingIndices: _missingIndices,
    slices,
    ...summary
  } = run;
  return {
    ...summary,
    setting: { id: setting.id, label: setting.label },
    slices: slices.map((slice) => {
      return {
        id: slice.id,
        serverId: slice.serverId,
        candidateServerIds: slice.candidateServerIds,
        status: slice.status,
        completedCount: slice.completedCount,
        failedCount: slice.failedCount,
        lastError: slice.lastError,
        assignedCount: slice.assignedIndices.length,
        jobStatus: slice.job?.status ?? null,
        jobLastError: slice.job?.lastError ?? null
      };
    })
  };
}

export function summarizeSolverJob(job: SolverJob): SolverJobSummary {
  const {
    setting: _setting,
    settings: _settings,
    command: _command,
    solverRangeText: _solverRangeText,
    confirmUnstudied: _confirmUnstudied,
    tmuxSession: _tmuxSession,
    remoteRangePath: _remoteRangePath,
    remoteResultPath: _remoteResultPath,
    assignedIndices: _assignedIndices,
    pipeline: _pipeline,
    ...summary
  } = job;
  return summary;
}

export function summarizeSolverJobEvent(event: SolverJobEvent): SolverJobEventSummary {
  const { commandPreview: _commandPreview, ...summary } = event;
  return summary;
}

function uniqueStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildReadSolverCardsCommand(solverRoot: string): string {
  return [
    "set -e",
    `cat ${shellQuoteRemotePath(joinRemotePath(solverRoot, "cards", "cards.txt"))}`
  ].join("\n");
}

function parseSolverCards(raw: string): string[] {
  const cards = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (cards.length === 0) {
    throw new Error("solver cards.txt is empty.");
  }
  return cards;
}

function firstSolverCardMismatchIndex(left: string[], right: string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : sharedLength;
}

export function parseUploadCandidatesOutput(output: string, serverId: string, repoNamespace = "Tsumugii"): ServerUploadCandidate[] {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const parts = line.split("\t");
      if (parts[0] !== "CANDIDATE" || parts.length < 6) return [];
      const datasetName = parts[1]?.trim() ?? "";
      const jobId = parts[2]?.trim() ?? "";
      const resultsDir = parts[3]?.trim() ?? "";
      const parquetCount = Number(parts[4] ?? 0);
      const jsonCount = Number(parts[5] ?? 0);
      const repoId = (parts[6]?.trim() || `${repoNamespace}/${datasetName}`).replace(/\/+/g, "/");
      if (!datasetName || !jobId || !resultsDir) return [];
      const fileFormat = parquetCount > 0 ? "parquet" : "json";
      return [{
        id: `${serverId}:${resultsDir}`,
        serverId,
        datasetName,
        repoId,
        jobId,
        resultsDir,
        parquetCount: Number.isFinite(parquetCount) ? parquetCount : 0,
        jsonCount: Number.isFinite(jsonCount) ? jsonCount : 0,
        fileFormat,
        fileCount: fileFormat === "parquet" ? parquetCount : jsonCount
      }];
    });
}

export function parseDeletedUploadCandidateOutput(
  output: string,
  serverId: string
): ServerUploadCandidateDeleteResponse {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("DELETED\t"));
  const parts = line?.split("\t") ?? [];
  if (parts.length < 6) {
    throw new Error(`Server ${serverId} returned an invalid result-folder deletion response.`);
  }
  const parquetDeleted = Number(parts[4]);
  const jsonDeleted = Number(parts[5]);
  return {
    serverId,
    resultsDir: parts[1]!,
    datasetName: parts[2]!,
    jobId: parts[3]!,
    parquetDeleted: Number.isFinite(parquetDeleted) ? Math.max(0, Math.trunc(parquetDeleted)) : 0,
    jsonDeleted: Number.isFinite(jsonDeleted) ? Math.max(0, Math.trunc(jsonDeleted)) : 0
  };
}

function normalizeUploadItems(items: ServerUploadItem[] | undefined): ServerUploadItem[] {
  if (!Array.isArray(items)) return [];
  const normalized: ServerUploadItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const resultsDir = typeof item.resultsDir === "string" ? item.resultsDir.trim() : "";
    const repoId = typeof item.repoId === "string" ? item.repoId.trim() : "";
    const datasetName = typeof item.datasetName === "string" && item.datasetName.trim()
      ? item.datasetName.trim()
      : repoId.split("/").pop() ?? "";
    const fileFormat = (SOLVER_UPLOAD_FORMATS as readonly string[]).includes(item.fileFormat) ? item.fileFormat : "parquet";
    if (!resultsDir || !repoId || !datasetName) continue;
    const key = `${resultsDir}:${repoId}:${fileFormat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      serverId: typeof item.serverId === "string" ? item.serverId.trim() || undefined : undefined,
      datasetName,
      repoId,
      jobId: typeof item.jobId === "string" ? item.jobId.trim() || undefined : undefined,
      resultsDir,
      fileFormat,
      fileCount: typeof item.fileCount === "number" && Number.isFinite(item.fileCount) ? Math.max(0, Math.trunc(item.fileCount)) : undefined
    });
  }
  return normalized;
}

function retainUploadItemsFromSource(
  scannedItems: ServerUploadItem[],
  sourceItems: ServerUploadItem[]
): ServerUploadItem[] {
  const sourceKeys = new Set(sourceItems.map((item) => `${item.resultsDir}\u0000${item.repoId}\u0000${item.fileFormat}`));
  return scannedItems.filter((item) => sourceKeys.has(`${item.resultsDir}\u0000${item.repoId}\u0000${item.fileFormat}`));
}

function uniqueUploadCandidateDeleteRequests(
  items: ServerUploadCandidateDeleteRequest[]
): ServerUploadCandidateDeleteRequest[] {
  const normalized: ServerUploadCandidateDeleteRequest[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const serverId = item.serverId.trim();
    const resultsDir = item.resultsDir.trim();
    const key = `${serverId}:${resultsDir}`;
    if (!serverId || !resultsDir || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ serverId, resultsDir });
  }
  return normalized;
}

function serverUploadItemsFromCandidate(candidate: ServerUploadCandidate): ServerUploadItem[] {
  const formats: Array<{ fileFormat: SolverUploadFormat; fileCount: number }> = [
    { fileFormat: "parquet", fileCount: candidate.parquetCount },
    { fileFormat: "json", fileCount: candidate.jsonCount }
  ];
  return formats
    .filter(({ fileCount }) => fileCount > 0)
    .map(({ fileFormat, fileCount }) => ({
      serverId: candidate.serverId,
      datasetName: candidate.datasetName,
      repoId: candidate.repoId,
      jobId: candidate.jobId,
      resultsDir: candidate.resultsDir,
      fileFormat,
      fileCount
    }));
}

function isServerUploadOperationItem(item: ServerOperation["items"][number]): item is ServerUploadItem {
  return (
    "datasetName" in item &&
    "repoId" in item &&
    "resultsDir" in item &&
    "fileFormat" in item
  );
}

function groupUploadItemsByServer(items: ServerUploadItem[], servers: ServerRow[]): Map<string, ServerUploadItem[]> {
  const byServer = new Map(servers.map((server) => [server.id, [] as ServerUploadItem[]]));
  if (servers.length === 1) {
    byServer.set(servers[0].id, items.map((item) => ({ ...item, serverId: servers[0].id })));
    return byServer;
  }
  for (const item of items) {
    const serverId = item.serverId?.trim();
    if (!serverId || !byServer.has(serverId)) continue;
    byServer.get(serverId)!.push(item);
  }
  return byServer;
}

function compareUploadCandidates(left: ServerUploadCandidate, right: ServerUploadCandidate): number {
  const serverDelta = left.serverId.localeCompare(right.serverId, undefined, { numeric: true, sensitivity: "base" });
  if (serverDelta !== 0) return serverDelta;
  const datasetDelta = left.datasetName.localeCompare(right.datasetName, undefined, { numeric: true, sensitivity: "base" });
  if (datasetDelta !== 0) return datasetDelta;
  return left.jobId.localeCompare(right.jobId, undefined, { numeric: true, sensitivity: "base" });
}

type RemoteOperationStatus = {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  exitCode: number | null;
  error: string | null;
  result: ServerOperationResult | null;
};

function parseRemoteOperationProbe(output: string): {
  statusFileExists: boolean;
  tmuxAlive: boolean;
  status: RemoteOperationStatus | null;
} {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = lines.find((line) => line.startsWith("{") && line.endsWith("}")) ?? "";
  return {
    statusFileExists: lines.includes("OP_STATUS_FILE=1"),
    tmuxAlive: lines.includes("OP_TMUX_ALIVE=1"),
    status: parseRemoteOperationStatus(jsonLine)
  };
}

function parseRemoteOperationStatus(output: string): RemoteOperationStatus | null {
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== "string") return null;
    if (parsed.status !== "running" && parsed.status !== "completed" && parsed.status !== "failed") return null;
    return {
      id: parsed.id,
      status: parsed.status,
      startedAt: typeof parsed.started_at === "string" ? parsed.started_at : null,
      finishedAt: typeof parsed.finished_at === "string" ? parsed.finished_at : null,
      updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
      exitCode: typeof parsed.exit_code === "number" && Number.isFinite(parsed.exit_code) ? Math.trunc(parsed.exit_code) : null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      result: parseServerOperationResult(parsed.result)
    };
  } catch {
    return null;
  }
}

export function parseServerHfConnectivityProbe(output: string): { connected: boolean; reason: string } {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const connected = values.get("HF_PROXY_CONNECTED") === "1";
  if (connected) {
    return { connected: true, reason: `HTTP ${values.get("HF_PROXY_HTTP_CODE") ?? "unknown"}` };
  }
  const curlCode = values.get("HF_PROXY_CURL_CODE") ?? "unknown";
  const httpCode = values.get("HF_PROXY_HTTP_CODE") ?? "000";
  const error = values.get("HF_PROXY_ERROR") ?? "proxy probe failed";
  return {
    connected: false,
    reason: `curl=${curlCode}, http=${httpCode}${error ? `, ${error}` : ""}`
  };
}

function isSshHandshakeTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out while waiting for handshake/i.test(message);
}

function stableServerRetryJitter(serverId: string): number {
  let hash = 0;
  for (const character of serverId) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return hash % 1_000;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]);
    }
  }));
}

function parseServerOperationResult(value: unknown): ServerOperationResult | null {
  if (!isRecord(value)) return null;
  const summary = isRecord(value.summary) ? normalizeOperationResultRecord(value.summary) : {};
  const details = Array.isArray(value.details)
    ? value.details.filter(isRecord).map(normalizeOperationResultRecord)
    : [];
  return {
    summary,
    details,
    raw: typeof value.raw === "string" ? value.raw : null
  };
}

function normalizeOperationResultRecord(value: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const result: Record<string, number | string | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      result[key] = raw;
    }
  }
  return result;
}

function serverOperationProgressFingerprint(result: ServerOperationResult | null): string {
  if (!result) return "";
  const summary = Object.fromEntries(
    Object.entries(result.summary).filter(([key]) => key !== "duration_seconds")
  );
  const details = result.details.map((detail) => Object.fromEntries(
    Object.entries(detail).filter(([key]) => key !== "duration_seconds" && key !== "output_tail")
  ));
  return JSON.stringify({ summary, details });
}

function serverOperationPaths(id: string): { statusFilePath: string; logFilePath: string } {
  return {
    statusFilePath: `~/run/server_operation_${id}.json`,
    logFilePath: `~/run/server_operation_${id}.log`
  };
}

function serverOperationPlanPath(id: string): string {
  return `~/run/server_operation_${id}.json.upload-plan.json`;
}

function serverOperationCommandPath(id: string): string {
  return `~/run/server_operation_${id}.json.command.sh`;
}

function safeTmuxName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

function buildMissingSolveWarnings(coverage: ParallelSolverCoverageSummary): string[] {
  const warnings: string[] = [];
  if (coverage.uploadPendingCount > 0) {
    warnings.push(
      `${coverage.uploadPendingCount} board(s) already completed in prior runs but are not on Hugging Face yet. Upload via Server Operations instead of re-solving.`
    );
  }
  if (coverage.inFlightCount > 0) {
    warnings.push(`${coverage.inFlightCount} board(s) are already assigned to an active parallel run.`);
  }
  if (coverage.failurePoolPendingCount > 0 && coverage.failurePoolPendingCount === coverage.missingCount) {
    warnings.push("Remaining missing boards match the retryable failure pool for this dataset.");
  } else if (coverage.failurePoolPendingCount > 0 && coverage.missingCount > coverage.failurePoolPendingCount) {
    warnings.push(
      `${coverage.failurePoolPendingCount} board(s) are in the failure pool; ${coverage.missingCount - coverage.failurePoolPendingCount} board(s) have never been attempted.`
    );
  }
  return warnings;
}

async function fetchHuggingFaceDatasetBoardKeys(
  repoId: string,
  hfToken: string | null,
  hfProxyUrl: string | null
): Promise<Set<string>> {
  const keys = new Set<string>();
  const treePath = `/api/datasets/${repoIdPath(repoId)}/tree/main`;
  let nextUrl: string | null = `${HUGGING_FACE_ORIGIN}${treePath}?recursive=1&limit=${HUGGING_FACE_TREE_PAGE_LIMIT}`;
  const visitedUrls = new Set<string>();

  for (let page = 1; nextUrl && page <= HUGGING_FACE_TREE_MAX_PAGES; page += 1) {
    if (visitedUrls.has(nextUrl)) {
      throw new Error(`Hugging Face dataset file listing returned a repeated pagination URL for ${repoId}.`);
    }
    visitedUrls.add(nextUrl);
    const response = await huggingFaceFetch(nextUrl, {
      headers: huggingFaceHeaders(hfToken),
      proxyUrl: hfProxyUrl,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000)
    });
    if (isRedirectStatus(response.status)) {
      throw new Error(
        `Hugging Face dataset ${repoId} redirects to a different repo. ` +
        "Create or select the exact dataset name before previewing distribution."
      );
    }
    if (!response.ok) {
      throw new Error(
        `Hugging Face dataset file listing failed for ${repoId} on page ${page}: ${await huggingFaceErrorMessage(response)}`
      );
    }
    const data = await response.json() as unknown;
    const items = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
    for (const item of items) {
      const rawPath = isRecord(item) && typeof item.path === "string"
        ? item.path
        : isRecord(item) && typeof item.rfilename === "string"
          ? item.rfilename
          : null;
      if (!rawPath || !/\.(parquet|json)$/i.test(rawPath)) continue;
      const stem = rawPath.split("/").pop()?.replace(/\.(parquet|json)$/i, "");
      if (stem) keys.add(boardKeyFromName(stem));
    }
    nextUrl = validatedHuggingFaceTreeNextUrl(response.headers.get("link"), treePath, repoId);
  }

  if (nextUrl) {
    throw new Error(
      `Hugging Face dataset file listing exceeded ${HUGGING_FACE_TREE_MAX_PAGES} pages for ${repoId}.`
    );
  }
  return keys;
}

function validatedHuggingFaceTreeNextUrl(linkHeader: string | null, treePath: string, repoId: string): string | null {
  const rawNextUrl = huggingFaceNextLink(linkHeader);
  if (!rawNextUrl) return null;
  const parsed = new URL(rawNextUrl, HUGGING_FACE_ORIGIN);
  if (parsed.origin !== HUGGING_FACE_ORIGIN || parsed.pathname !== treePath) {
    throw new Error(`Hugging Face dataset file listing returned an invalid pagination URL for ${repoId}.`);
  }
  return parsed.toString();
}

function huggingFaceNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    const url = part.match(/<([^>]+)>/)?.[1];
    const relation = part.match(/;\s*rel=(?:"([^"]+)"|([^;\s,]+))/i);
    const relations = (relation?.[1] ?? relation?.[2] ?? "").split(/\s+/);
    if (url && relations.includes("next")) return url;
  }
  return null;
}

function boardKeyFromName(board: string): string {
  return board.replace(/,/g, "").trim().toLowerCase();
}

function normalizeBoardIndices(indices: number[], total: number): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const value of indices) {
    const index = Math.trunc(Number(value));
    if (!Number.isFinite(index) || index < 1 || index > total || seen.has(index)) continue;
    seen.add(index);
    normalized.push(index);
  }
  return normalized.sort((a, b) => a - b);
}

function normalizePositiveIndices(indices: number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const value of indices) {
    const index = Math.trunc(Number(value));
    if (!Number.isFinite(index) || index < 1 || seen.has(index)) continue;
    seen.add(index);
    normalized.push(index);
  }
  return normalized.sort((a, b) => a - b);
}

function normalizedParallelChunkCount(chunkCount: number | undefined, defaultCount: number): number {
  const parsed = Math.trunc(Number(chunkCount ?? defaultCount));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, defaultCount);
}

function allocateRoundRobinChunks(
  indices: number[],
  servers: ServerRow[],
  denominatorServerCount: number
): Array<{ server: ServerRow; candidateServerIds: string[]; indices: number[]; rangeExpr: string }> {
  if (indices.length === 0 || servers.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const bucketCount = Math.min(sorted.length, Math.max(1, denominatorServerCount));
  const candidateServerIds = servers.map((server) => server.id);
  const buckets = Array.from({ length: bucketCount }, (_value, index) => ({
    server: servers[index % servers.length]!,
    candidateServerIds,
    indices: [] as number[]
  }));
  sorted.forEach((index, position) => {
    buckets[position % bucketCount]!.indices.push(index);
  });
  return buckets.map((bucket) => ({
    ...bucket,
    rangeExpr: compressIndices(bucket.indices)
  }));
}

function allocateFailurePoolChunks({
  normalIndices,
  skippedIndices,
  normalServers,
  performanceServers,
  chunkCount
}: {
  normalIndices: number[];
  skippedIndices: number[];
  normalServers: ServerRow[];
  performanceServers: ServerRow[];
  chunkCount: number;
}): Array<{ server: ServerRow; candidateServerIds: string[]; indices: number[]; rangeExpr: string }> {
  const totalBoards = normalIndices.length + skippedIndices.length;
  if (totalBoards === 0) return [];
  const totalChunkCount = Math.min(totalBoards, Math.max(1, chunkCount));

  if (normalIndices.length > 0 && skippedIndices.length > 0 && totalChunkCount === 1) {
    return allocateRoundRobinChunks([...normalIndices, ...skippedIndices], performanceServers, 1);
  }

  const [normalChunkCount, skippedChunkCount] = proportionalChunkBudget(
    [normalIndices.length, skippedIndices.length],
    totalChunkCount
  );
  return [
    ...allocateRoundRobinChunks(normalIndices, normalServers, normalChunkCount),
    ...allocateRoundRobinChunks(skippedIndices, performanceServers, skippedChunkCount)
  ];
}

function proportionalChunkBudget(groupSizes: number[], totalChunkCount: number): number[] {
  const budgets: number[] = groupSizes.map((size) => size > 0 ? 1 : 0);
  let remaining = Math.max(0, totalChunkCount - budgets.reduce((sum, value) => sum + value, 0));
  while (remaining > 0) {
    let selectedGroup = -1;
    let selectedScore = -1;
    for (let index = 0; index < groupSizes.length; index += 1) {
      const size = groupSizes[index] ?? 0;
      const budget = budgets[index] ?? 0;
      if (size <= budget) continue;
      const score = size / (budget + 1);
      if (score > selectedScore) {
        selectedGroup = index;
        selectedScore = score;
      }
    }
    if (selectedGroup < 0) break;
    budgets[selectedGroup] = (budgets[selectedGroup] ?? 0) + 1;
    remaining -= 1;
  }
  return budgets;
}

function compressIndices(indices: number[]): string {
  const sorted = [...indices].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (const index of sorted.slice(1)) {
    if (index === prev + 1) {
      prev = index;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = index;
    prev = index;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(",");
}

function sliceStateFromJob(
  slice: ParallelSolverSlice,
  job: SolverJob
): Partial<Pick<ParallelSolverSlice, "status" | "completedCount" | "failedCount" | "startedAt" | "finishedAt" | "lastError">> {
  const completedCount = job.pipeline?.completedCount ?? job.pipeline?.completedIndices.length ?? 0;
  const failedCount = job.pipeline?.failedCount ?? job.pipeline?.failedIndices.length ?? 0;
  if (job.status === "queued" || job.status === "draft") {
    return { status: "queued", completedCount, failedCount, startedAt: job.startedAt, finishedAt: job.finishedAt, lastError: job.lastError };
  }
  if (job.status === "deploying" || job.status === "running" || job.status === "stopping") {
    return { status: "running", completedCount, failedCount, startedAt: job.startedAt, finishedAt: null, lastError: job.lastError };
  }
  if (job.status === "completed") {
    return {
      status: "completed",
      completedCount: slice.assignedIndices.length,
      failedCount,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      lastError: null
    };
  }
  if (job.status === "canceled") {
    return { status: "canceled", completedCount, failedCount, startedAt: job.startedAt, finishedAt: job.finishedAt, lastError: job.lastError };
  }
  return {
    status: "failed",
    completedCount,
    failedCount: failedCount || Math.max(0, slice.assignedIndices.length - completedCount),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastError: job.lastError
  };
}

function failureEntriesForSlice(
  slice: ParallelSolverSlice,
  job: SolverJob,
  previousFailurePoolEntries: Map<number, ParallelFailurePoolEntry>
): Array<{ index: number; failureReason: ParallelFailureReason }> {
  const assigned = new Set(slice.assignedIndices);
  const completed = new Set((job.pipeline?.completedIndices ?? []).filter((index) => assigned.has(index)));
  const skipped = new Set((job.pipeline?.skippedIndices ?? []).filter((index) => assigned.has(index)));
  const failed = new Set((job.pipeline?.failedIndices ?? []).filter((index) => assigned.has(index)));
  const failures: Array<{ index: number; failureReason: ParallelFailureReason }> = [];
  for (const index of skipped) {
    const previousReason = previousFailurePoolEntries.get(index)?.failureReason;
    failures.push({
      index,
      failureReason: job.sourceType === "failure_pool" && previousReason === "skipped"
        ? "best_server_skipped"
        : "skipped"
    });
  }
  for (const index of failed) {
    if (skipped.has(index)) continue;
    failures.push({ index, failureReason: "abnormal_end" });
  }
  for (const index of slice.assignedIndices) {
    if (completed.has(index) || skipped.has(index) || failed.has(index)) continue;
    failures.push({ index, failureReason: "abnormal_end" });
  }
  if (failures.length === 0) {
    return slice.assignedIndices.map((index) => ({ index, failureReason: "abnormal_end" }));
  }
  return failures;
}

function failureReasonIsRetryable(reason: ParallelFailureReason): boolean {
  return reason !== "best_server_skipped";
}

function parallelRunState(
  run: ParallelSolverRun
): Partial<Pick<ParallelSolverRun, "status" | "startedAt" | "finishedAt" | "lastError">> {
  if (run.slices.length === 0) {
    return { status: "completed", startedAt: run.startedAt, finishedAt: run.finishedAt ?? new Date().toISOString(), lastError: null };
  }
  const statuses = run.slices.map((slice) => slice.status);
  const startedAt = run.startedAt ?? earliestDate(run.slices.map((slice) => slice.startedAt));
  if (statuses.some((status) => status === "running")) {
    return { status: "running", startedAt, finishedAt: null, lastError: null };
  }
  if (statuses.some((status) => status === "queued")) {
    return { status: startedAt ? "running" : "queued", startedAt, finishedAt: null, lastError: null };
  }
  const finishedAt = latestDate(run.slices.map((slice) => slice.finishedAt)) ?? new Date().toISOString();
  if (statuses.every((status) => status === "completed")) {
    return { status: "completed", startedAt, finishedAt, lastError: null };
  }
  if (statuses.some((status) => status === "canceled") && !statuses.some((status) => status === "failed")) {
    return { status: "canceled", startedAt, finishedAt, lastError: "Parallel run canceled before all slices completed." };
  }
  return { status: "completed_with_failures", startedAt, finishedAt, lastError: "One or more slices failed." };
}

function parallelRunLocked(run: ParallelSolverRun): boolean {
  return run.slices.some((slice) =>
    slice.status === "running" ||
    slice.job?.status === "deploying" ||
    slice.job?.status === "running" ||
    slice.job?.status === "stopping"
  );
}

function parallelRunCanRefreshCoverageBeforeDispatch(run: ParallelSolverRun): boolean {
  return run.sourceType === "parallel" &&
    run.status === "queued" &&
    !run.startedAt &&
    run.slices.length > 0 &&
    run.slices.every((slice) => slice.status === "queued" && !slice.jobId && !slice.job);
}

function parallelSliceJobCanBeReassigned(slice: ParallelSolverSlice): boolean {
  return Boolean(
    slice.job &&
      slice.status === "queued" &&
      slice.job.status === "queued" &&
      !slice.job.startedAt
  );
}

function parallelSliceHasInterruptedReassignment(slice: ParallelSolverSlice): boolean {
  return Boolean(
    slice.status === "canceled" &&
      slice.job?.status === "canceled" &&
      !slice.job.startedAt &&
      !slice.job.pipeline &&
      slice.job.lastError?.startsWith("Parallel chunk reassigned to ")
  );
}

function compareParallelRunQueue(left: ParallelSolverRun, right: ParallelSolverRun): number {
  const orderDelta = left.queueOrder - right.queueOrder;
  if (orderDelta !== 0) return orderDelta;
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function compareParallelSliceQueue(left: ParallelSolverSlice, right: ParallelSolverSlice): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function earliestDate(values: Array<string | null>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function latestDate(values: Array<string | null>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function integerOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return parsed;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function joinRemotePath(...parts: string[]): string {
  return parts
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function remotePathBasename(remotePath: string): string {
  return remotePath.replace(/\/+$/g, "").split("/").pop()?.trim() ?? "";
}

function effectiveSolverRoot(server?: Pick<ServerRow, "solverRoot"> | null): string {
  return server?.solverRoot?.trim() || DEFAULT_SOLVER_ROOT;
}

function jobScopedRemoteRangePath(jobId: string, datasetName: string, solverRoot = DEFAULT_SOLVER_ROOT): string {
  return joinRemotePath(solverRoot, "job-ranges", jobId, `${datasetName}.txt`);
}

function jobScopedRemoteSettingPath(jobId: string, solverRoot = DEFAULT_SOLVER_ROOT): string {
  return joinRemotePath(solverRoot, "job-settings", `${jobId}.json`);
}

function jobScopedRemoteResultPath(jobId: string, datasetName: string, solverRoot = DEFAULT_SOLVER_ROOT): string {
  return joinRemotePath(solverRoot, "results", datasetName, jobId);
}

function dirnameRemote(remotePath: string): string {
  const parts = remotePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellQuoteRemotePath(value: string): string {
  const pathValue = String(value);
  if (pathValue === "~") return "$HOME";
  if (pathValue.startsWith("~/")) {
    const suffix = pathValue.slice(2).replace(/(["\\$])/g, "\\$1").replace(/`/g, "\\`");
    return `"$HOME/${suffix}"`;
  }
  return shellQuote(pathValue);
}
