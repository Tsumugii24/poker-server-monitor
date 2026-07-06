import { randomUUID } from "node:crypto";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  SOLVER_EXPORT_FORMATS,
  DEFAULT_SOLVER_SCENARIO_LIBRARY,
  SOLVER_UPLOAD_FORMATS,
  type ParallelFailurePoolEntry,
  type ParallelFailureReason,
  type ParallelFailurePoolPreviewRequest,
  type ParallelFailurePoolSubmitRequest,
  type ParallelSolverJobCreateRequest,
  type ParallelSolverJobPreview,
  type ParallelSolverJobPreviewRequest,
  type ParallelSolverRun,
  type ParallelSolverServerAllocation,
  type ParallelSolverRunStatus,
  type ParallelSolverSlice,
  type ParallelSolverSliceStatus,
  type SolverJob,
  type SolverJobCreateRequest,
  type SolverDatasetRepoEnsureRequest,
  type SolverDatasetRepoStatus,
  type SolverJobEvent,
  type SolverJobPreview,
  type SolverJobPreviewRequest,
  type SolverJobSettings,
  type SolverJobStatus,
  type SolverScenario,
  type SolverScenarioLibraryItem
} from "../shared/solverJobs";
import type { AlertSettings } from "../shared/types";
import type { PipelineStatusSnapshot, ServerRow } from "../shared/types";
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
import type {
  ServerOperation,
  ServerOperationEvent,
  ServerOperationResult,
  ServerOperationsResponse,
  ServerSyncRequest,
  ServerUploadCandidate,
  ServerUploadCandidatesResponse,
  ServerUploadItem,
  ServerUploadRequest
} from "../shared/serverOperations";
import type { MonitorDatabase } from "./db";
import { readPreflopRangeFile } from "./preflopRangeStore";
import type { SshCredentials, SshExecutor } from "./sshCollector";
import { Ssh2Executor } from "./sshCollector";
import { huggingFaceFetch } from "./huggingFaceHttp";

export { datasetNameFromRangePath, scenarioFromRangePath } from "../shared/preflopDataset";

type SolverJobServiceOptions = {
  db: MonitorDatabase;
  preflopRangesPath: string;
  credentials?: SshCredentials;
  executor?: SshExecutor;
  defaultPipelineStatusFilePath?: string;
  repoNamespace?: string;
  hfToken?: string | null;
  hfProxyUrl?: string | null;
  solverHfProxyUrl?: string | null;
  getHfProxySettings?: () => Pick<AlertSettings, "hfProxyEnabled" | "solverHfProxyEnabled">;
  getScenarioLibrary?: () => SolverScenarioLibraryItem[];
};

type DispatchPreflightResult = {
  ready: boolean;
  reason: string | null;
};

type ServerCodeReadyResult = {
  ready: boolean;
  reason: string | null;
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
const ACTIVE_JOB_RECONCILE_GRACE_MS = 15_000;
const HUGGING_FACE_ORIGIN = "https://huggingface.co";

export class SolverJobService {
  private readonly executor: SshExecutor;
  private readonly repoNamespace: string;
  private readonly defaultPipelineStatusFilePath: string;
  private readonly hfToken: string | null;
  private readonly hfProxyUrl: string | null;
  private readonly solverHfProxyUrl: string | null;
  private readonly getHfProxySettings: () => Pick<AlertSettings, "hfProxyEnabled" | "solverHfProxyEnabled">;
  private readonly getScenarioLibrary: () => SolverScenarioLibraryItem[];

  constructor(private readonly options: SolverJobServiceOptions) {
    this.executor = options.executor ?? new Ssh2Executor();
    this.repoNamespace = (options.repoNamespace ?? "Tsumugii").trim() || "Tsumugii";
    this.defaultPipelineStatusFilePath = options.defaultPipelineStatusFilePath ?? "~/run/solver_running_status.json";
    this.hfToken = options.hfToken?.trim() || null;
    this.hfProxyUrl = options.hfProxyUrl?.trim() || null;
    this.solverHfProxyUrl = options.solverHfProxyUrl?.trim() || null;
    this.getHfProxySettings = options.getHfProxySettings ?? (() => ({
      hfProxyEnabled: false,
      solverHfProxyEnabled: false
    }));
    this.getScenarioLibrary = options.getScenarioLibrary ?? (() => DEFAULT_SOLVER_SCENARIO_LIBRARY);
  }

  listJobs() {
    this.reconcileCompletedJobs();
    return {
      jobs: this.options.db.getSolverJobs(),
      events: this.options.db.getSolverJobEvents()
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
    return {
      runs: this.options.db.getParallelSolverRuns(),
      failurePool: this.options.db.getParallelFailurePoolEntries()
    };
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
    orderedIds.forEach((id, index) => {
      this.options.db.updateParallelSolverRunQueueOrder(id, index + 1);
    });
    return this.options.db.getParallelSolverRuns();
  }

  clearParallelReports(): { deletedCount: number; deletedRunIds: string[] } {
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    const deletedRunIds = this.options.db.getParallelSolverRuns()
      .filter((run) => TERMINAL_PARALLEL_RUN_STATUSES.has(run.status) && !parallelRunLocked(run))
      .map((run) => run.id);
    this.options.db.deleteParallelSolverRuns(deletedRunIds);
    return {
      deletedCount: deletedRunIds.length,
      deletedRunIds
    };
  }

  async cancelParallelRun(id: string): Promise<ParallelSolverRun> {
    const run = this.getParallelRun(id);
    for (const slice of run.slices) {
      if (slice.job) {
        if (slice.job.status === "queued") {
          this.options.db.updateSolverJob(slice.job.id, {
            status: "canceled",
            finishedAt: new Date().toISOString()
          });
          this.recordEvent(slice.job.id, "canceled", "Parallel run canceled.", null);
        } else if (ACTIVE_JOB_STATUSES.has(slice.job.status)) {
          await this.stop(slice.job.id);
        }
      }
      this.options.db.updateParallelSolverSlice(slice.id, {
        status: "canceled",
        finishedAt: new Date().toISOString(),
        lastError: "Parallel run canceled."
      });
    }
    this.options.db.updateParallelSolverRun(id, {
      status: "canceled",
      finishedAt: new Date().toISOString(),
      lastError: "Parallel run canceled."
    });
    return this.getParallelRun(id);
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
    if (!preview.repoExists) {
      throw new Error("Dataset repo is missing. Confirm the dataset name and create the repo before submitting this failure pool.");
    }
    const run = await this.createParallelRunFromPreview(preview, "failure_pool", input.queueMode !== "queue_next");
    this.options.db.updateParallelFailurePoolEntries(preview.rangePath, preview.datasetName, preview.missingIndices, "queued");
    return run;
  }

  preview(input: SolverJobPreviewRequest): SolverJobPreview {
    return buildSolverJobPreview({
      input,
      server: this.requireServer(input.serverId),
      preflopRangesPath: this.options.preflopRangesPath,
      defaultPipelineStatusFilePath: this.defaultPipelineStatusFilePath,
      repoNamespace: this.repoNamespace,
      hfToken: this.hfToken,
      solverHfProxyUrl: this.effectiveSolverHfProxyUrl(),
      scenarioLibrary: this.getScenarioLibrary()
    });
  }

  async checkDatasetRepo(input: SolverJobPreviewRequest): Promise<SolverDatasetRepoStatus> {
    const preview = this.preview(input);
    const exists = await huggingFaceDatasetRepoExists(preview.repoId, this.hfToken, this.effectiveHfProxyUrl());
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
    const remoteResultPath = jobScopedRemoteResultPath(jobId, preview.datasetName, solverRoot);
    const command = buildRunPipelineCommand({
      solverRoot,
      repoId: preview.repoId,
      scenario: preview.scenario,
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
      pipeline: preview.server.pipeline
    };

    if (job.queueMode === "queue_next") {
      this.options.db.cancelQueuedSolverJobsForServer(job.serverId);
    }
    this.options.db.insertSolverJob(job);
    this.recordEvent(job.id, "created", `Queued ${job.datasetName} for ${preview.server.name}.`, job.command);
    return this.requireJob(job.id);
  }

  async start(id: string, options: { deferOnDispatchFailure?: boolean; skipCodeReadyGate?: boolean } = {}): Promise<SolverJob> {
    const job = this.requireJob(id);
    const server = this.requireServer(job.serverId);
    this.ensureServerOnline(server);
    this.ensureNoActiveJob(server.id, job.id);
    this.ensureCredentials();
    if (!options.skipCodeReadyGate) {
      const codeReady = await this.ensureSolverCodeReadyForDispatch(server);
      if (!codeReady.ready) {
        return this.markJobDispatchPending(job, codeReady.reason ?? `Dispatch pending: solver code is not ready on ${server.id}.`);
      }
    }
    const executionCommand = this.buildExecutionCommand(job, server);

    this.options.db.updateSolverJob(job.id, { status: "deploying", lastError: null });
    this.recordEvent(job.id, "deploying", `Submitting selected range to ${job.remoteRangePath}.`, null);
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
    await this.reconcileServerOperations();
    return {
      operations: this.options.db.getServerOperations(),
      events: this.options.db.getServerOperationEvents()
    };
  }

  async scanUploadCandidates(serverId: string): Promise<ServerUploadCandidatesResponse> {
    const server = this.requireServer(serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();
    const output = await this.executor.run(
      server,
      this.options.credentials!,
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
    for (const server of servers) {
      try {
        const output = await this.executor.run(
          server,
          this.options.credentials!,
          buildScanUploadCandidatesCommand(effectiveSolverRoot(server), this.repoNamespace)
        );
        candidates.push(...parseUploadCandidatesOutput(output, server.id, this.repoNamespace));
      } catch (error) {
        failedServers.push({
          serverId: server.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return {
      scannedServers: servers,
      failedServers,
      candidates: candidates.sort(compareUploadCandidates)
    };
  }

  async startSyncOperations(input: ServerSyncRequest = {}): Promise<ServerOperationsResponse> {
    this.ensureCredentials();
    const servers = this.operationTargetServers(input.serverIds);
    if (servers.length === 0) {
      throw new Error("No online servers are available for sync.");
    }
    for (const server of servers) {
      const operation = this.createSyncOperation(server);
      this.options.db.insertServerOperation(operation);
      this.recordOperationEvent(operation.id, "created", `Created sync operation for ${server.id}.`, operation.command);
      await this.startServerOperation(operation, server);
    }
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
      items = normalizeUploadItems(scan.candidates.map((candidate) => ({
        serverId: candidate.serverId,
        datasetName: candidate.datasetName,
        repoId: candidate.repoId,
        jobId: candidate.jobId,
        resultsDir: candidate.resultsDir,
        fileFormat: candidate.fileFormat,
        fileCount: candidate.fileCount
      })));
      for (const failed of scan.failedServers ?? []) {
        scanFailedServerIds.add(failed.serverId);
        const server = targetServers.find((candidate) => candidate.id === failed.serverId);
        if (!server) continue;
        const operation = this.createUploadOperation(server, [], {
          summary: {
            scanned: false,
            upload_success: 0,
            upload_failed: 0,
            no_files: 0,
            scan_failed: 1
          },
          details: [{ server_id: failed.serverId, error: failed.message }]
        });
        this.options.db.insertServerOperation(operation);
        this.options.db.updateServerOperation(operation.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          lastError: failed.message,
          result: operation.result
        });
        this.recordOperationEvent(operation.id, "scan_failed", `Upload scan failed for ${failed.serverId}: ${failed.message}`, null);
      }
    }

    const itemsByServer = groupUploadItemsByServer(items, targetServers);
    for (const server of targetServers) {
      if (scanFailedServerIds.has(server.id)) continue;
      const operationItems = itemsByServer.get(server.id) ?? [];
      const operation = this.createUploadOperation(server, operationItems);
      this.options.db.insertServerOperation(operation);
      this.recordOperationEvent(
        operation.id,
        "created",
        operationItems.length > 0
          ? `Created upload operation for ${server.id} with ${operationItems.length} folder(s).`
          : `Created upload operation for ${server.id}; no retained result folders were found.`,
        operation.command
      );
      await this.startServerOperation(operation, server);
    }
    return this.listServerOperations();
  }

  async stopServerOperation(id: string): Promise<ServerOperationsResponse> {
    const operation = this.requireServerOperation(id);
    const server = this.requireServer(operation.serverId);
    this.ensureServerOnline(server);
    this.ensureCredentials();
    const output = await this.executor.run(
      server,
      this.options.credentials!,
      buildStopServerOperationCommand(operation.tmuxSession)
    );
    this.options.db.updateServerOperation(operation.id, {
      status: "canceled",
      finishedAt: new Date().toISOString(),
      lastError: null
    });
    this.recordOperationEvent(operation.id, "canceled", "Operation tmux session was stopped.", output);
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
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    await this.reconcileServerOperations();
    const servers = sortServersByNaturalId(this.options.db.getServerRows());
    for (const server of servers) {
      const queued = this.options.db.getQueuedSolverJobForServer(server.id);
      if (queued) {
        await this.startQueuedJobIfDispatchReady(queued);
        continue;
      }
      await this.assignAndStartNextParallelSliceIfReady(server);
    }
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
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
    const selectedServerIds = normalizeSelectedServerIds(input.serverIds, availableServers, enabledServers);
    if (selectedServerIds.length === 0) {
      throw new Error("At least one online idle enabled server is required for parallel solver jobs.");
    }
    const selectedServers = selectedServerIds.map((serverId) => {
      const server = enabledServers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error(`Server ${serverId} is not enabled or does not exist.`);
      return server;
    });

    const basePreview = buildSolverJobPreview({
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
      scenarioLibrary: this.getScenarioLibrary()
    });

    let repoExists = await huggingFaceDatasetRepoExists(basePreview.repoId, this.hfToken, this.effectiveHfProxyUrl());
    if (!repoExists && options.createRepoIfConfirmed) {
      if (!this.hfToken) throw new Error("HF_TOKEN is required to create a missing Hugging Face dataset repo.");
      await createHuggingFaceDatasetRepo(basePreview.repoId, this.hfToken, this.effectiveHfProxyUrl());
      repoExists = true;
    }

    const allBoards = await this.readSolverCardsForServers(uniqueServersById([
      ...selectedServers,
      ...availableServers,
      ...enabledServers
    ]));
    const indices = options.explicitIndices
      ? normalizeBoardIndices(options.explicitIndices, allBoards.length)
      : repoExists
        ? await fetchMissingBoardIndices(basePreview.repoId, allBoards, this.hfToken, this.effectiveHfProxyUrl())
        : [];
    const allocationServerCount = Math.max(1, enabledServers.length, selectedServers.length);
    const allocations = allocateRoundRobinChunks(indices, selectedServers, allocationServerCount).map((allocation) => {
      const settings = { ...basePreview.settings, rangeExpr: allocation.rangeExpr };
      const solverRoot = effectiveSolverRoot(allocation.server);
      const commandPreview = buildRunPipelineCommand({
        solverRoot,
        repoId: basePreview.repoId,
        scenario: basePreview.scenario,
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
      rangePath: basePreview.rangePath,
      rangeName: basePreview.rangeName,
      learned: basePreview.learned,
      datasetName: basePreview.datasetName,
      repoId: basePreview.repoId,
      scenario: basePreview.scenario,
      solverRangeText: basePreview.solverRangeText,
      settings: basePreview.settings,
      selectedServerIds,
      availableServers,
      missingIndices: indices,
      missingBoardNames: indices.map((index) => allBoards[index - 1] ?? String(index)),
      allocations,
      repoExists,
      tokenConfigured: Boolean(this.hfToken),
      requiresConfirmation: !basePreview.learned || !repoExists,
      warnings: [
        ...basePreview.warnings,
        ...(!repoExists ? ["Dataset repo is missing. Confirm the dataset name before creating it."] : []),
        ...(indices.length === 0 && repoExists ? ["No missing boards remain for this dataset."] : [])
      ]
    };
  }

  private async buildFailurePoolPreview(
    input: ParallelFailurePoolPreviewRequest,
    options: { createRepoIfConfirmed?: boolean } = {}
  ): Promise<ParallelSolverJobPreview> {
    const entries = this.failurePoolEntries(input);
    const servers = sortServersByNaturalId(this.options.db.getServerRows());
    const enabledServers = servers.filter((server) => server.enabled);
    const availableServers = enabledServers.filter((server) =>
      serverIsReadyForParallelSelection(server, this.options.db.getActiveSolverJobForServer(server.id))
    );
    const selectedServerIds = normalizeSelectedServerIds(input.serverIds, availableServers, enabledServers);
    const selectedServers = selectedServerIds.map((serverId) => {
      const server = enabledServers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error(`Server ${serverId} is not enabled or does not exist.`);
      return server;
    });
    const skippedEntries = entries.filter((entry) => entry.failureReason === "skipped");
    const normalEntries = entries.filter((entry) => entry.failureReason !== "skipped");
    const bestServerId = input.bestServerId?.trim();
    const bestServer = bestServerId
      ? enabledServers.find((server) => server.id === bestServerId)
      : null;
    if (skippedEntries.length > 0 && !bestServer) {
      throw new Error("Best Server ID is required to retry skipped failure-pool boards.");
    }
    if (normalEntries.length > 0 && selectedServers.length === 0) {
      throw new Error("At least one online idle enabled server is required to retry abnormal failure-pool boards.");
    }
    const baseServer = selectedServers[0] ?? bestServer;
    if (!baseServer) {
      throw new Error("Failure pool has no retryable boards for this range.");
    }

    const basePreview = buildSolverJobPreview({
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
      scenarioLibrary: this.getScenarioLibrary()
    });

    let repoExists = await huggingFaceDatasetRepoExists(basePreview.repoId, this.hfToken, this.effectiveHfProxyUrl());
    if (!repoExists && options.createRepoIfConfirmed) {
      if (!this.hfToken) throw new Error("HF_TOKEN is required to create a missing Hugging Face dataset repo.");
      await createHuggingFaceDatasetRepo(basePreview.repoId, this.hfToken, this.effectiveHfProxyUrl());
      repoExists = true;
    }

    const allBoards = await this.readSolverCardsForServers(uniqueServersById([
      ...selectedServers,
      ...(bestServer ? [bestServer] : []),
      ...availableServers,
      ...enabledServers
    ]));
    const allocationServerCount = Math.max(1, enabledServers.length, selectedServers.length, bestServer ? 1 : 0);
    const normalIndices = normalizeBoardIndices(normalEntries.map((entry) => entry.boardIndex), allBoards.length);
    const skippedIndices = normalizeBoardIndices(skippedEntries.map((entry) => entry.boardIndex), allBoards.length);
    const normalAllocations = allocateRoundRobinChunks(normalIndices, selectedServers, allocationServerCount);
    const skippedAllocations = bestServer && skippedIndices.length > 0
      ? allocateRoundRobinChunks(skippedIndices, [bestServer], 1)
      : [];
    const rawAllocations = [...normalAllocations, ...skippedAllocations];
    const allocations: ParallelSolverServerAllocation[] = rawAllocations.map((allocation) => {
      const settings = { ...basePreview.settings, rangeExpr: allocation.rangeExpr };
      const solverRoot = effectiveSolverRoot(allocation.server);
      const commandPreview = buildRunPipelineCommand({
        solverRoot,
        repoId: basePreview.repoId,
        scenario: basePreview.scenario,
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
      ...(bestServer && skippedIndices.length > 0 ? [bestServer.id] : [])
    ]);

    return {
      rangePath: basePreview.rangePath,
      rangeName: basePreview.rangeName,
      learned: basePreview.learned,
      datasetName: basePreview.datasetName,
      repoId: basePreview.repoId,
      scenario: basePreview.scenario,
      solverRangeText: basePreview.solverRangeText,
      settings: basePreview.settings,
      selectedServerIds: selectedIds,
      availableServers,
      missingIndices: indices,
      missingBoardNames: indices.map((index) => allBoards[index - 1] ?? String(index)),
      allocations,
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
      scenario: preview.scenario,
      settings: preview.settings,
      solverRangeText: preview.solverRangeText,
      status: preview.missingIndices.length === 0 ? "completed" : "queued",
      queueOrder: this.options.db.getNextParallelSolverQueueOrder(),
      serverIds: preview.selectedServerIds,
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

    if (autoStart) {
      await this.reconcileAndStartQueuedJobs();
    }
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    return this.getParallelRun(runId);
  }

  private reconcileParallelRuns(): void {
    const runs = this.options.db.getParallelSolverRuns();
    for (const run of runs) {
      for (const slice of run.slices) {
        if (!slice.job) continue;
        const next = sliceStateFromJob(slice, slice.job);
        const becameRunning = slice.status !== "running" && next.status === "running";
        const becameCompleted = slice.status !== "completed" && next.status === "completed";
        const becameFailed = slice.status !== "failed" && next.status === "failed";
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
      || datasetNameFromRangePath(input.rangePath, input.scenario ?? scenarioFromRangePath(input.rangePath));
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

  private reconcileCompletedJobs(): void {
    for (const job of this.options.db.getSolverJobs()) {
      if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
      if (!job.pipeline || !pipelineIsNewEnoughForJob(job.pipeline, job)) continue;
      if (isPipelineActive(job.pipeline) && pipelineBelongsToJob(job.pipeline, job)) continue;
      if (!pipelineCanSettleActiveJob(job.pipeline, job)) continue;
      const nextStatus = completedStatusFromPipeline(job.pipeline);
      const lastError = nextStatus === "failed" ? pipelineReconciliationError(job.pipeline, job) : null;
      this.options.db.updateSolverJob(job.id, {
        status: nextStatus,
        finishedAt: job.pipeline?.finishedAt ?? new Date().toISOString(),
        lastError
      });
      this.recordEvent(job.id, nextStatus, `Server task reconciled job as ${nextStatus}.`, null);
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

  private createSyncOperation(server: ServerRow): ServerOperation {
    const id = randomUUID();
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

  private createUploadOperation(server: ServerRow, items: ServerUploadItem[], initialResult: ServerOperationResult | null = null): ServerOperation {
    const id = randomUUID();
    const solverRoot = effectiveSolverRoot(server);
    const paths = serverOperationPaths(id);
    const body = buildServerUploadCommand({
      solverRoot,
      items,
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

  private async startServerOperation(operation: ServerOperation, server: ServerRow): Promise<void> {
    this.options.db.updateServerOperation(operation.id, { status: "deploying", lastError: null });
    this.recordOperationEvent(operation.id, "deploying", `Starting ${operation.type} tmux session ${operation.tmuxSession}.`, null);
    try {
      await this.executor.run(
        server,
        this.options.credentials!,
        buildServerOperationTmuxStartCommand(operation, effectiveSolverRoot(server), operation.command)
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

  private async reconcileServerOperations(): Promise<void> {
    const activeOperations = this.options.db.getServerOperations()
      .filter((operation) => ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status));
    if (activeOperations.length === 0 || !this.options.credentials) return;
    const servers = new Map(this.options.db.getServerRows().map((server) => [server.id, server]));
    for (const operation of activeOperations) {
      const server = servers.get(operation.serverId);
      if (!server || server.latest?.connectionStatus !== "online") continue;
      try {
        const output = await this.executor.run(
          server,
          this.options.credentials,
          buildReadServerOperationStatusCommand(operation.statusFilePath)
        );
        const status = parseRemoteOperationStatus(output);
        if (!status || status.id !== operation.id || status.status === operation.status) continue;
        if (status.status === "completed" || status.status === "failed") {
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
        } else if (status.status === "running" && operation.status !== "running") {
          this.options.db.updateServerOperation(operation.id, {
            status: "running",
            startedAt: status.startedAt ?? operation.startedAt,
            lastError: null,
            updatedAt: status.updatedAt ?? new Date().toISOString()
          });
        }
      } catch {
        // Status file may not exist yet while the tmux command is starting.
      }
    }
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
      const status = server.latest?.connectionStatus ?? "unknown";
      throw new Error(`Server ${server.id} is ${status}; job operations require an online server.`);
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
    const server = this.requireServer(job.serverId);
    if (!server.enabled) {
      this.markJobDispatchPending(job, `Dispatch pending: server ${server.id} is disabled.`);
      return false;
    }
    if (!serverIsOnline(server)) {
      const status = server.latest?.connectionStatus ?? "unknown";
      this.markJobDispatchPending(job, `Dispatch pending: server ${server.id} is ${status}.`);
      return false;
    }

    const active = this.options.db.getActiveSolverJobForServer(server.id, job.id);
    if (active) {
      this.markJobDispatchPending(job, `Dispatch pending: server ${server.id} is running ${active.datasetName}.`);
      return false;
    }

    this.ensureCredentials();
    try {
      const output = await this.executor.run(
        server,
        this.options.credentials!,
        buildDispatchPreflightCommand(statusFileFromJob(job))
      );
      const preflight = parseDispatchPreflightOutput(output);
      if (!preflight.ready) {
        this.markJobDispatchPending(
          job,
          `Dispatch pending: server ${server.id} is not idle${preflight.reason ? ` (${preflight.reason})` : ""}.`
        );
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markJobDispatchPending(job, `Dispatch pending: SSH preflight failed for ${server.id}: ${message}`);
      return false;
    }

    try {
      const started = await this.start(job.id, { deferOnDispatchFailure: true });
      return started.status === "running";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markJobDispatchPending(job, `Dispatch pending: ${message}`);
      return false;
    }
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

  private async ensureSolverCodeReadyForDispatch(server: ServerRow): Promise<ServerCodeReadyResult> {
    await this.reconcileServerOperations();
    const activeSync = this.activeServerSyncOperation(server.id);
    if (activeSync) {
      return {
        ready: false,
        reason: `Dispatch pending: solver code sync is already running on ${server.id} (${activeSync.tmuxSession}).`
      };
    }

    try {
      const output = await this.executor.run(
        server,
        this.options.credentials!,
        buildServerCodeReadyCommand({
          solverRoot: effectiveSolverRoot(server),
          proxyUrl: this.effectiveRemoteOperationProxyUrl()
        })
      );
      const status = parseServerCodeReadyOutput(output);
      if (status.ready) return status;

      const operation = this.createSyncOperation(server);
      this.options.db.insertServerOperation(operation);
      this.recordOperationEvent(
        operation.id,
        "created",
        `Created solver code sync before dispatch for ${server.id}: ${status.reason ?? "not ready"}.`,
        operation.command
      );
      await this.startServerOperation(operation, server);
      const updated = this.options.db.getServerOperation(operation.id) ?? operation;
      if (updated.status === "failed") {
        return {
          ready: false,
          reason: `Dispatch pending: solver code sync failed on ${server.id}: ${updated.lastError ?? "unknown error"}.`
        };
      }
      return {
        ready: false,
        reason: `Dispatch pending: solver code sync started on ${server.id} (${updated.tmuxSession}).`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        reason: `Dispatch pending: solver code readiness check failed on ${server.id}: ${message}`
      };
    }
  }

  private activeServerSyncOperation(serverId: string): ServerOperation | null {
    return this.options.db.getServerOperations().find((operation) =>
      operation.serverId === serverId &&
      operation.type === "sync" &&
      ACTIVE_SERVER_OPERATION_STATUSES.has(operation.status)
    ) ?? null;
  }

  private async assignAndStartNextParallelSliceIfReady(server: ServerRow): Promise<boolean> {
    if (!server.enabled || !serverIsOnline(server)) return false;
    if (this.options.db.getActiveSolverJobForServer(server.id)) return false;
    if (isPipelineActive(server.pipeline)) return false;
    const sliceWithRun = this.nextQueuedParallelSliceForServer(server.id);
    if (!sliceWithRun) return false;
    const job = this.createJobForParallelSlice(sliceWithRun.run, sliceWithRun.slice, server);
    return this.startQueuedJobIfDispatchReady(job);
  }

  private nextQueuedParallelSliceForServer(serverId: string): { run: ParallelSolverRun; slice: ParallelSolverSlice } | null {
    const runs = this.options.db.getParallelSolverRuns()
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort(compareParallelRunQueue);
    for (const run of runs) {
      const slices = [...run.slices].sort(compareParallelSliceQueue);
      for (const slice of slices) {
        if (slice.status !== "queued") continue;
        if (slice.jobId) continue;
        if (!slice.candidateServerIds.includes(serverId)) continue;
        return { run, slice };
      }
    }
    return null;
  }

  private createJobForParallelSlice(run: ParallelSolverRun, slice: ParallelSolverSlice, server: ServerRow): SolverJob {
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const settings = { ...run.settings, rangeExpr: slice.rangeExpr };
    const solverRoot = effectiveSolverRoot(server);
    const remoteRangePath = jobScopedRemoteRangePath(jobId, run.datasetName, solverRoot);
    const remoteResultPath = jobScopedRemoteResultPath(jobId, run.datasetName, solverRoot);
    const statusFilePath = server.pipelineStatusFilePath?.trim() || this.defaultPipelineStatusFilePath;
    const command = buildRunPipelineCommand({
      solverRoot,
      repoId: run.repoId,
      scenario: run.scenario,
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
      pipeline: server.pipeline
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
    const remoteErrors: string[] = [];
    for (const server of servers) {
      const solverRoot = effectiveSolverRoot(server);
      try {
        return parseSolverCards(await this.executor.run(
          server,
          this.options.credentials,
          buildReadSolverCardsCommand(solverRoot)
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        remoteErrors.push(`${server.id} (${joinRemotePath(solverRoot, "cards", "cards.txt")}): ${message}`);
      }
    }

    throw new Error(
      "Unable to read remote solver cards.txt for parallel allocation. " +
      "Parallel allocation reads cards/cards.txt from the selected server solverRoot over SSH. " +
      `Remote errors: ${remoteErrors.join("; ") || "none"}.`
    );
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
  scenarioLibrary = DEFAULT_SOLVER_SCENARIO_LIBRARY
}: {
  input: SolverJobPreviewRequest;
  server: ServerRow;
  preflopRangesPath: string;
  defaultPipelineStatusFilePath: string;
  repoNamespace: string;
  hfToken?: string | null;
  solverHfProxyUrl?: string | null;
  scenarioLibrary?: SolverScenarioLibraryItem[];
}): SolverJobPreview {
  const solverRoot = effectiveSolverRoot(server);

  const file = readPreflopRangeFile(preflopRangesPath, input.rangePath);
  const settings = normalizeSolverJobSettings(input.settings);
  const scenario = scenarioFromPreviewInput(input, scenarioLibrary);
  const datasetName = normalizeDatasetName(input.datasetName) ?? datasetNameFromRangePath(input.rangePath, scenario);
  const repoId = `${repoNamespace}/${datasetName}`;
  const solverRangeText = solverRangeTextFromDocument(file.summary.data);
  const tmuxSession = server.tmuxSession?.trim() || "solver";
  const pipelineStatusFilePath = server.pipelineStatusFilePath?.trim() || defaultPipelineStatusFilePath;
  const remoteRangePath = jobScopedRemoteRangePath("<job-id>", datasetName, solverRoot);
  const remoteResultPath = jobScopedRemoteResultPath("<job-id>", datasetName, solverRoot);
  const commandPreview = buildRunPipelineCommand({
    solverRoot,
    repoId,
    scenario,
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

  return {
    server,
    rangePath: file.path,
    rangeName: file.path.split("/").at(-1) ?? file.path,
    learned,
    datasetName,
    repoId,
    scenario,
    solverRangeText,
    remoteRangePath,
    remoteResultPath,
    commandPreview,
    tmuxSession,
    pipelineStatusFilePath,
    settings,
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

function scenarioFromPreviewInput(
  input: SolverJobPreviewRequest,
  scenarioLibrary: SolverScenarioLibraryItem[]
): SolverScenario {
  const scenarioIds = new Set(scenarioLibrary.map((scenario) => scenario.id));
  if (input.scenario == null) {
    const inferred = scenarioFromRangePath(input.rangePath);
    if (scenarioIds.has(inferred)) return inferred;
    throw new Error(`Unsupported solver scenario: ${inferred}`);
  }
  if (scenarioIds.has(input.scenario)) return input.scenario;
  throw new Error(`Unsupported solver scenario: ${input.scenario}`);
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

async function huggingFaceDatasetRepoExists(
  repoId: string,
  hfToken: string | null,
  hfProxyUrl: string | null
): Promise<boolean> {
  const response = await huggingFaceFetch(`${HUGGING_FACE_ORIGIN}/api/datasets/${repoIdPath(repoId)}`, {
    headers: huggingFaceHeaders(hfToken),
    proxyUrl: hfProxyUrl,
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 404) return false;
  if (response.ok) return true;
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
  if (response.ok || response.status === 409) return;
  if (response.status === 400 && await huggingFaceDatasetRepoExists(repoId, hfToken, hfProxyUrl)) return;
  throw new Error(`Hugging Face dataset repo creation failed for ${repoId}: ${await huggingFaceErrorMessage(response)}`);
}

function huggingFaceDatasetUrl(repoId: string): string {
  return `${HUGGING_FACE_ORIGIN}/datasets/${repoId}`;
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
    scenario
  ];
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

export function buildDeployRangeCommand(job: SolverJob): string {
  const tmpPath = `${job.remoteRangePath}.tmp`;
  return [
    "set -e",
    `RANGE_PATH=${shellQuoteRemotePath(job.remoteRangePath)}`,
    `TMP_PATH=${shellQuoteRemotePath(tmpPath)}`,
    `mkdir -p ${shellQuoteRemotePath(dirnameRemote(job.remoteRangePath))}`,
    `cat > "$TMP_PATH" <<'SOLVER_RANGE_EOF'`,
    job.solverRangeText.trimEnd(),
    "SOLVER_RANGE_EOF",
    `mv "$TMP_PATH" "$RANGE_PATH"`
  ].join("\n");
}

export function buildTmuxStartCommand(job: SolverJob, solverRoot: string, command = job.command): string {
  return [
    "set -e",
    `tmux has-session -t ${shellQuote(job.tmuxSession)} 2>/dev/null || tmux new-session -d -s ${shellQuote(job.tmuxSession)} -c ${shellQuoteRemotePath(solverRoot)}`,
    `tmux send-keys -t ${shellQuote(job.tmuxSession)} ${shellQuote(command)} C-m`
  ].join("\n");
}

export function buildServerOperationTmuxStartCommand(operation: ServerOperation, solverRoot: string, command = operation.command): string {
  return [
    "set -e",
    `tmux has-session -t ${shellQuote(operation.tmuxSession)} 2>/dev/null || tmux new-session -d -s ${shellQuote(operation.tmuxSession)} -c ${shellQuoteRemotePath(solverRoot)}`,
    `tmux send-keys -t ${shellQuote(operation.tmuxSession)} ${shellQuote(command)} C-m`
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
SYNC_FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ "$STASH_CODE" -eq 0 ] && [ "$PULL_CODE" -eq 0 ]; then
  if printf '%s\n' "$PULL_OUTPUT" | grep -qi "Already up to date"; then SYNC_KIND=latest; else SYNC_KIND=synced; fi
else
  SYNC_KIND=failed
fi
export STASH_OUTPUT PULL_OUTPUT
python - "$OP_RESULT_FILE" "$SYNC_KIND" "$STASH_CODE" "$PULL_CODE" "$SYNC_STARTED_AT" "$SYNC_FINISHED_AT" <<'PY'
import json
import os
import sys

path, kind, stash_code, pull_code, started_at, finished_at = sys.argv[1:7]
stash_output = os.environ.get("STASH_OUTPUT", "")
pull_output = os.environ.get("PULL_OUTPUT", "")
result = {
    "summary": {
        "latest": 1 if kind == "latest" else 0,
        "synced": 1 if kind == "synced" else 0,
        "failed": 1 if kind == "failed" else 0,
        "stash_code": int(stash_code),
        "pull_code": int(pull_code),
    },
    "details": [{
        "kind": kind,
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
if [ "$STASH_CODE" -ne 0 ] || [ "$PULL_CODE" -ne 0 ]; then exit 1; fi`;
}

export function buildServerCodeReadyCommand({
  solverRoot,
  proxyUrl = DEFAULT_REMOTE_PROXY_URL
}: {
  solverRoot: string;
  proxyUrl?: string;
}): string {
  return String.raw`set +e
cd ${shellQuoteRemotePath(solverRoot)} 2>/dev/null
CD_CODE=$?
if [ "$CD_CODE" -ne 0 ]; then
  echo "CODE_READY=0"
  echo "CODE_REASON=solver root missing"
  exit 0
fi
export http_proxy=${shellQuote(proxyUrl)}
export https_proxy=${shellQuote(proxyUrl)}
git rev-parse --is-inside-work-tree >/dev/null 2>&1
GIT_CODE=$?
if [ "$GIT_CODE" -ne 0 ]; then
  echo "CODE_READY=0"
  echo "CODE_REASON=solver root is not a git repo"
  exit 0
fi
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
if [ -z "$UPSTREAM" ]; then
  echo "CODE_READY=0"
  echo "CODE_REASON=no git upstream configured"
  exit 0
fi
git fetch --quiet
FETCH_CODE=$?
if [ "$FETCH_CODE" -ne 0 ]; then
  echo "CODE_READY=0"
  echo "CODE_REASON=git fetch failed"
  exit 0
fi
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse '@{u}' 2>/dev/null)
BASE=$(git merge-base HEAD '@{u}' 2>/dev/null)
if ! git diff --quiet --ignore-submodules -- . || ! git diff --cached --quiet --ignore-submodules -- .; then
  echo "CODE_READY=0"
  echo "CODE_REASON=tracked working tree changes"
  echo "CODE_LOCAL=$LOCAL"
  echo "CODE_REMOTE=$REMOTE"
  exit 0
fi
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "CODE_READY=1"
  echo "CODE_REASON=up to date"
elif [ "$LOCAL" = "$BASE" ]; then
  echo "CODE_READY=0"
  echo "CODE_REASON=behind upstream"
elif [ "$REMOTE" = "$BASE" ]; then
  echo "CODE_READY=1"
  echo "CODE_REASON=local contains upstream"
else
  echo "CODE_READY=0"
  echo "CODE_REASON=diverged from upstream"
fi
echo "CODE_LOCAL=$LOCAL"
echo "CODE_REMOTE=$REMOTE"`;
}

export function buildServerUploadCommand({
  solverRoot,
  items,
  hfToken,
  proxyUrl = DEFAULT_REMOTE_PROXY_URL,
  redactSecrets = false
}: {
  solverRoot: string;
  items: ServerUploadItem[];
  hfToken?: string | null;
  proxyUrl?: string;
  redactSecrets?: boolean;
}): string {
  const token = hfToken?.trim();
  if (!token) throw new Error("HF_TOKEN is required for upload operations.");
  const plan = JSON.stringify(items.map((item) => ({
    datasetName: item.datasetName,
    repoId: item.repoId,
    jobId: item.jobId ?? "",
    resultsDir: item.resultsDir,
    fileFormat: item.fileFormat,
    fileCount: item.fileCount ?? 0
  })));
  return String.raw`set -e
cd ${shellQuoteRemotePath(solverRoot)}
export http_proxy=${shellQuote(proxyUrl)}
export https_proxy=${shellQuote(proxyUrl)}
${redactSecrets ? "export HF_TOKEN=$HF_TOKEN" : `export HF_TOKEN=${shellQuote(token)}`}
cat > "$OP_UPLOAD_PLAN_FILE" <<'SERVER_UPLOAD_PLAN_JSON'
${plan}
SERVER_UPLOAD_PLAN_JSON
python - "$OP_UPLOAD_PLAN_FILE" "$OP_RESULT_FILE" <<'PY'
import json
import subprocess
import sys
import time

plan_path, result_path = sys.argv[1:3]
with open(plan_path, "r", encoding="utf-8") as handle:
    items = json.load(handle)

summary = {
    "folders": len(items),
    "upload_success": 0,
    "upload_failed": 0,
    "files_requested": 0,
    "no_files": 1 if not items else 0,
    "duration_seconds": 0,
}
details = []
started = time.time()

for item in items:
    file_count = int(item.get("fileCount") or 0)
    summary["files_requested"] += file_count
    command = [
        "python",
        "upload.py",
        "--results-dir",
        item["resultsDir"],
        "--repo-id",
        item["repoId"],
        "--file-format",
        item.get("fileFormat") or "parquet",
    ]
    item_started = time.time()
    print("[Upload]", item["repoId"], "<-", item["resultsDir"], flush=True)
    process = subprocess.run(command, text=True, capture_output=True)
    output = (process.stdout or "") + (process.stderr or "")
    if output:
        print(output, end="" if output.endswith("\n") else "\n", flush=True)
    duration = max(0, round(time.time() - item_started))
    success = process.returncode == 0
    if success:
        summary["upload_success"] += 1
    else:
        summary["upload_failed"] += 1
    details.append({
        "dataset_name": item.get("datasetName") or "",
        "repo_id": item["repoId"],
        "job_id": item.get("jobId") or "",
        "results_dir": item["resultsDir"],
        "file_format": item.get("fileFormat") or "parquet",
        "file_count": file_count,
        "exit_code": process.returncode,
        "success": success,
        "duration_seconds": duration,
        "output_tail": output[-1600:],
    })

summary["duration_seconds"] = max(0, round(time.time() - started))
with open(result_path, "w", encoding="utf-8") as handle:
    json.dump({"summary": summary, "details": details}, handle, ensure_ascii=True)
sys.exit(0 if summary["upload_failed"] == 0 else 1)
PY`;
}

export function buildTrackedServerOperationCommand({
  id,
  type,
  statusFilePath,
  logFilePath,
  bodyCommand
}: {
  id: string;
  type: "sync" | "upload";
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

export function buildReadServerOperationStatusCommand(statusFilePath: string): string {
  return [
    "set -e",
    `cat ${shellQuoteRemotePath(statusFilePath)}`
  ].join("\n");
}

export function buildStopServerOperationCommand(tmuxSession: string): string {
  return [
    "set -u",
    `SESSION=${shellQuote(tmuxSession)}`,
    `tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" || true`
  ].join("\n");
}

export function buildDispatchPreflightCommand(statusFilePath: string): string {
  return String.raw`set -e
STATUS_FILE=${shellQuoteRemotePath(statusFilePath)}
PID=""
if [ -f "$STATUS_FILE" ]; then
  PID=$(grep -Eo '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STATUS_FILE" | tail -1 | grep -Eo '[0-9]+$' || true)
fi
if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
  echo "DISPATCH_READY=0"
  echo "DISPATCH_REASON=active pid $PID"
else
  echo "DISPATCH_READY=1"
fi`;
}

export function buildGracefulStopPipelineCommand(job: SolverJob): string {
  return String.raw`set -u
SESSION=${shellQuote(job.tmuxSession)}
STATUS_FILE=${shellQuote(statusFileFromJob(job))}
case "$STATUS_FILE" in
  "~/"*) STATUS_FILE="$HOME/${"$"}{STATUS_FILE#~/}" ;;
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
  "~/"*) STATUS_FILE="$HOME/${"$"}{STATUS_FILE#~/}" ;;
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
  const match = job.command.match(/--status-file\s+('([^']|'\\'')*'|"[^"]+"|\S+)/);
  const raw = match?.[1] ?? "~/run/solver_running_status.json";
  return raw.replace(/^'|'$/g, "").replace(/'\\''/g, "'");
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
  return pipeline.repoId === job.repoId || pipeline.datasetName === job.datasetName;
}

function serverIsOnline(server: ServerRow): boolean {
  return server.latest?.connectionStatus === "online";
}

function serverIsReadyForParallelSelection(server: ServerRow, activeJob: SolverJob | null): boolean {
  return server.enabled && serverIsOnline(server) && !activeJob && !isPipelineActive(server.pipeline);
}

function parseDispatchPreflightOutput(output: string): DispatchPreflightResult {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const readyLine = lines.find((line) => line.startsWith("DISPATCH_READY="));
  const reasonLine = lines.find((line) => line.startsWith("DISPATCH_REASON="));
  return {
    ready: readyLine === "DISPATCH_READY=1",
    reason: reasonLine ? reasonLine.slice("DISPATCH_REASON=".length).trim() || null : null
  };
}

function parseServerCodeReadyOutput(output: string): ServerCodeReadyResult {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const readyLine = lines.find((line) => line.startsWith("CODE_READY="));
  const reasonLine = lines.find((line) => line.startsWith("CODE_REASON="));
  return {
    ready: readyLine === "CODE_READY=1",
    reason: reasonLine ? reasonLine.slice("CODE_REASON=".length).trim() || null : null
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
    return `Server is running a different task (${pipeline.datasetName ?? pipeline.repoId ?? pipeline.displayStatus}).`;
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
      throw new Error(`Server ${id} is not enabled or available for parallel jobs.`);
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
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

function parseRemoteOperationStatus(output: string): {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  exitCode: number | null;
  error: string | null;
  result: ServerOperationResult | null;
} | null {
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

function serverOperationPaths(id: string): { statusFilePath: string; logFilePath: string } {
  return {
    statusFilePath: `~/run/server_operation_${id}.json`,
    logFilePath: `~/run/server_operation_${id}.log`
  };
}

function safeTmuxName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

async function fetchMissingBoardIndices(
  repoId: string,
  allBoards: string[],
  hfToken: string | null,
  hfProxyUrl: string | null
): Promise<number[]> {
  const existing = await fetchHuggingFaceDatasetBoardKeys(repoId, hfToken, hfProxyUrl);
  const missing: number[] = [];
  allBoards.forEach((board, index) => {
    if (!existing.has(boardKeyFromName(board))) missing.push(index + 1);
  });
  return missing;
}

async function fetchHuggingFaceDatasetBoardKeys(
  repoId: string,
  hfToken: string | null,
  hfProxyUrl: string | null
): Promise<Set<string>> {
  const response = await huggingFaceFetch(`${HUGGING_FACE_ORIGIN}/api/datasets/${repoIdPath(repoId)}/tree/main?recursive=1`, {
    headers: huggingFaceHeaders(hfToken),
    proxyUrl: hfProxyUrl,
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`Hugging Face dataset file listing failed for ${repoId}: ${await huggingFaceErrorMessage(response)}`);
  }
  const data = await response.json() as unknown;
  const items = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.items)
      ? data.items
      : [];
  const keys = new Set<string>();
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
  return keys;
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
      completedCount: completedCount || slice.assignedIndices.length,
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
  if (statuses.every((status) => status === "canceled")) {
    return { status: "canceled", startedAt, finishedAt, lastError: "All slices were canceled." };
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

function effectiveSolverRoot(server?: Pick<ServerRow, "solverRoot"> | null): string {
  return server?.solverRoot?.trim() || DEFAULT_SOLVER_ROOT;
}

function jobScopedRemoteRangePath(jobId: string, datasetName: string, solverRoot = DEFAULT_SOLVER_ROOT): string {
  return joinRemotePath(solverRoot, "job-ranges", jobId, `${datasetName}.txt`);
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
