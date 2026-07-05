import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  SOLVER_EXPORT_FORMATS,
  DEFAULT_SOLVER_SCENARIO_LIBRARY,
  SOLVER_UPLOAD_FORMATS,
  type ParallelFailurePoolEntry,
  type ParallelFailurePoolPreviewRequest,
  type ParallelFailurePoolSubmitRequest,
  type ParallelSolverJobCreateRequest,
  type ParallelSolverJobPreview,
  type ParallelSolverJobPreviewRequest,
  type ParallelSolverRun,
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
  solverCardsPath?: string | null;
  getHfProxySettings?: () => Pick<AlertSettings, "hfProxyEnabled" | "solverHfProxyEnabled">;
  getScenarioLibrary?: () => SolverScenarioLibraryItem[];
};

const ACTIVE_JOB_STATUSES = new Set<SolverJobStatus>(["deploying", "running", "stopping"]);
const DEFAULT_SOLVER_ROOT = "~/solver";
const ACTIVE_JOB_RECONCILE_GRACE_MS = 15_000;
const HUGGING_FACE_ORIGIN = "https://huggingface.co";

export class SolverJobService {
  private readonly executor: SshExecutor;
  private readonly repoNamespace: string;
  private readonly defaultPipelineStatusFilePath: string;
  private readonly hfToken: string | null;
  private readonly hfProxyUrl: string | null;
  private readonly solverHfProxyUrl: string | null;
  private readonly solverCardsPath: string | null;
  private readonly getHfProxySettings: () => Pick<AlertSettings, "hfProxyEnabled" | "solverHfProxyEnabled">;
  private readonly getScenarioLibrary: () => SolverScenarioLibraryItem[];

  constructor(private readonly options: SolverJobServiceOptions) {
    this.executor = options.executor ?? new Ssh2Executor();
    this.repoNamespace = (options.repoNamespace ?? "Tsumugii").trim() || "Tsumugii";
    this.defaultPipelineStatusFilePath = options.defaultPipelineStatusFilePath ?? "~/run/solver_running_status.json";
    this.hfToken = options.hfToken?.trim() || null;
    this.hfProxyUrl = options.hfProxyUrl?.trim() || null;
    this.solverHfProxyUrl = options.solverHfProxyUrl?.trim() || null;
    this.solverCardsPath = options.solverCardsPath?.trim() || process.env.SERVER_MONITOR_SOLVER_CARDS_PATH?.trim() || null;
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

  async cancelParallelRun(id: string): Promise<ParallelSolverRun> {
    const run = this.getParallelRun(id);
    for (const slice of run.slices) {
      if (!slice.job) continue;
      if (slice.job.status === "queued") {
        this.options.db.updateSolverJob(slice.job.id, {
          status: "canceled",
          finishedAt: new Date().toISOString()
        });
        this.recordEvent(slice.job.id, "canceled", "Parallel run canceled.", null);
      } else if (ACTIVE_JOB_STATUSES.has(slice.job.status)) {
        await this.stop(slice.job.id);
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
    const base = await this.buildParallelPreview(input, {
      explicitIndices: this.failurePoolIndices(input)
    });
    return base;
  }

  async submitFailurePool(input: ParallelFailurePoolSubmitRequest): Promise<ParallelSolverRun> {
    const indices = this.failurePoolIndices(input);
    if (indices.length === 0) {
      throw new Error("Failure pool has no pending boards for this range.");
    }
    const preview = await this.buildParallelPreview(input, {
      explicitIndices: indices,
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

  async start(id: string): Promise<SolverJob> {
    const job = this.requireJob(id);
    const server = this.requireServer(job.serverId);
    this.ensureServerOnline(server);
    this.ensureNoActiveJob(server.id, job.id);
    this.ensureCredentials();
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
    const servers = this.options.db.getServerRows();
    for (const server of servers) {
      const queued = this.options.db.getQueuedSolverJobForServer(server.id);
      if (!queued) continue;
      if (!serverIsOnline(server)) continue;
      if (this.options.db.getActiveSolverJobForServer(server.id)) continue;
      if (isPipelineActive(server.pipeline)) continue;
      await this.start(queued.id);
    }
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
  }

  private async buildParallelPreview(
    input: ParallelSolverJobPreviewRequest,
    options: { explicitIndices?: number[]; createRepoIfConfirmed?: boolean } = {}
  ): Promise<ParallelSolverJobPreview> {
    const servers = this.options.db.getServerRows();
    const availableServers = servers.filter((server) => server.enabled && serverIsOnline(server));
    const selectedServerIds = normalizeSelectedServerIds(input.serverIds, availableServers);
    if (selectedServerIds.length === 0) {
      throw new Error("At least one online enabled server is required for parallel solver jobs.");
    }
    const selectedServers = selectedServerIds.map((serverId) => {
      const server = availableServers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error(`Server ${serverId} is not online and available.`);
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

    const allBoards = this.readSolverCards();
    const indices = options.explicitIndices
      ? normalizeBoardIndices(options.explicitIndices, allBoards.length)
      : repoExists
        ? await fetchMissingBoardIndices(basePreview.repoId, allBoards, this.hfToken, this.effectiveHfProxyUrl())
        : [];
    const allocations = allocateRoundRobin(indices, selectedServers).map((allocation) => {
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

    for (const allocation of preview.allocations) {
      if (allocation.indices.length === 0) continue;
      const sliceId = randomUUID();
      const jobId = randomUUID();
      const settings = { ...preview.settings, rangeExpr: allocation.rangeExpr };
      const solverRoot = effectiveSolverRoot(allocation.server);
      const remoteRangePath = jobScopedRemoteRangePath(jobId, preview.datasetName, solverRoot);
      const remoteResultPath = jobScopedRemoteResultPath(jobId, preview.datasetName, solverRoot);
      const statusFilePath = allocation.server.pipelineStatusFilePath?.trim() || this.defaultPipelineStatusFilePath;
      const command = buildRunPipelineCommand({
        solverRoot,
        repoId: preview.repoId,
        scenario: preview.scenario,
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
        serverId: allocation.server.id,
        rangePath: preview.rangePath,
        rangeName: preview.rangeName,
        datasetName: preview.datasetName,
        scenario: preview.scenario,
        repoId: preview.repoId,
        settings,
        command,
        solverRangeText: preview.solverRangeText,
        status: "queued",
        queueMode: "parallel",
        confirmUnstudied: false,
        tmuxSession: allocation.server.tmuxSession?.trim() || "solver",
        remoteRangePath,
        remoteResultPath,
        parallelRunId: runId,
        parallelSliceId: sliceId,
        assignedIndices: allocation.indices,
        sourceType,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        pipeline: allocation.server.pipeline
      };
      const slice: ParallelSolverSlice = {
        id: sliceId,
        runId,
        serverId: allocation.server.id,
        jobId,
        rangeExpr: allocation.rangeExpr,
        assignedIndices: allocation.indices,
        assignedBoardNames: allocation.boardNames,
        status: "queued",
        completedCount: 0,
        failedCount: 0,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
        lastError: null,
        job
      };
      this.options.db.insertSolverJob(job);
      this.options.db.insertParallelSolverSlice(slice);
      this.recordEvent(job.id, "parallel_created", `Queued parallel slice ${allocation.rangeExpr} for ${allocation.server.id}.`, job.command);
    }

    if (autoStart) {
      const inserted = this.options.db.getParallelSolverRun(runId);
      if (!inserted) throw new Error(`Parallel solver run ${runId} not found`);
      for (const slice of inserted.slices) {
        const server = this.requireServer(slice.serverId);
        if (!serverIsOnline(server)) continue;
        if (this.options.db.getActiveSolverJobForServer(server.id)) continue;
        if (isPipelineActive(server.pipeline)) continue;
        if (slice.jobId) {
          await this.start(slice.jobId);
        }
      }
    }
    this.reconcileCompletedJobs();
    this.reconcileParallelRuns();
    return this.getParallelRun(runId);
  }

  private reconcileParallelRuns(): void {
    const runs = this.options.db.getParallelSolverRuns();
    let allBoards: string[] | null = null;
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
          allBoards ??= this.readSolverCards();
          const failedIndices = failedIndicesForSlice(slice, slice.job);
          for (const index of failedIndices) {
            const boardName = allBoards[index - 1] ?? String(index);
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

  private failurePoolIndices(input: ParallelFailurePoolPreviewRequest): number[] {
    const datasetName = input.datasetName?.trim()
      || datasetNameFromRangePath(input.rangePath, input.scenario ?? scenarioFromRangePath(input.rangePath));
    const entries = this.options.db.getParallelFailurePoolEntries(input.rangePath, datasetName)
      .filter((entry) => entry.status === "pending" || entry.status === "failed");
    const selected = input.indices?.length
      ? new Set(normalizeBoardIndices(input.indices, this.readSolverCards().length))
      : null;
    return entries
      .map((entry) => entry.boardIndex)
      .filter((index) => selected == null || selected.has(index));
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

  private effectiveHfProxyUrl(): string | null {
    return this.getHfProxySettings().hfProxyEnabled ? this.hfProxyUrl : null;
  }

  private effectiveSolverHfProxyUrl(): string | null {
    return this.getHfProxySettings().solverHfProxyEnabled ? this.solverHfProxyUrl : null;
  }

  private readSolverCards(): string[] {
    return readSolverCards({
      explicitPath: this.solverCardsPath,
      solverRoots: this.options.db.getServerRows().map((server) => server.solverRoot)
    });
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

function pipelineBelongsToJob(pipeline: PipelineStatusSnapshot, job: SolverJob): boolean {
  return pipeline.repoId === job.repoId || pipeline.datasetName === job.datasetName;
}

function serverIsOnline(server: ServerRow): boolean {
  return server.latest?.connectionStatus === "online";
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

function normalizeSelectedServerIds(serverIds: string[] | undefined, availableServers: ServerRow[]): string[] {
  const availableIds = availableServers.map((server) => server.id);
  const requested = serverIds?.map((id) => id.trim()).filter(Boolean) ?? [];
  const selected = requested.length > 0 ? requested : availableIds;
  const unique: string[] = [];
  for (const id of selected) {
    if (!availableIds.includes(id)) {
      throw new Error(`Server ${id} is not online and available.`);
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

function readSolverCards({
  explicitPath,
  solverRoots
}: {
  explicitPath?: string | null;
  solverRoots?: Array<string | null | undefined>;
} = {}): string[] {
  const candidates = uniqueStrings([
    explicitPath ? resolveLocalPath(explicitPath) : null,
    ...[...(solverRoots ?? []), DEFAULT_SOLVER_ROOT]
      .map((root) => root?.trim())
      .filter((root): root is string => Boolean(root))
      .map((root) => path.join(resolveLocalPath(root), "cards", "cards.txt")),
    path.resolve(process.cwd(), "tmp/solver/cards/cards.txt"),
    path.resolve(process.cwd(), "cards/cards.txt")
  ]);
  const cardsPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!cardsPath) {
    throw new Error(
      `Unable to locate solver cards.txt for parallel allocation. Checked: ${candidates.join(", ")}. ` +
      "Set SERVER_MONITOR_SOLVER_CARDS_PATH or make sure the configured solverRoot contains cards/cards.txt on this host."
    );
  }
  return fs.readFileSync(cardsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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

function allocateRoundRobin(indices: number[], servers: ServerRow[]): Array<{ server: ServerRow; indices: number[]; rangeExpr: string }> {
  const buckets = servers.map((server) => ({ server, indices: [] as number[] }));
  indices.forEach((index, position) => {
    buckets[position % buckets.length]!.indices.push(index);
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

function failedIndicesForSlice(slice: ParallelSolverSlice, job: SolverJob): number[] {
  const failed = job.pipeline?.failedIndices ?? [];
  if (failed.length > 0) return failed.filter((index) => slice.assignedIndices.includes(index));
  const completed = new Set(job.pipeline?.completedIndices ?? []);
  const remaining = slice.assignedIndices.filter((index) => !completed.has(index));
  return remaining.length > 0 ? remaining : slice.assignedIndices;
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

function resolveLocalPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(process.cwd(), trimmed);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
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
