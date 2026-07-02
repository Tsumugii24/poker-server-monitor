import { randomUUID } from "node:crypto";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  SOLVER_EXPORT_FORMATS,
  DEFAULT_SOLVER_SCENARIO_LIBRARY,
  SOLVER_UPLOAD_FORMATS,
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

export { datasetNameFromRangePath, scenarioFromRangePath } from "../shared/preflopDataset";

type SolverJobServiceOptions = {
  db: MonitorDatabase;
  preflopRangesPath: string;
  credentials?: SshCredentials;
  executor?: SshExecutor;
  defaultPipelineStatusFilePath?: string;
  repoNamespace?: string;
  hfToken?: string | null;
  getScenarioLibrary?: () => SolverScenarioLibraryItem[];
};

const ACTIVE_JOB_STATUSES = new Set<SolverJobStatus>(["deploying", "running", "stopping"]);
const DEFAULT_SOLVER_ROOT = "~/solver";
const HF_UPLOAD_PROXY = "http://127.0.0.1:7890";
const ACTIVE_JOB_RECONCILE_GRACE_MS = 15_000;
const HUGGING_FACE_ORIGIN = "https://huggingface.co";

export class SolverJobService {
  private readonly executor: SshExecutor;
  private readonly repoNamespace: string;
  private readonly defaultPipelineStatusFilePath: string;
  private readonly hfToken: string | null;
  private readonly getScenarioLibrary: () => SolverScenarioLibraryItem[];

  constructor(private readonly options: SolverJobServiceOptions) {
    this.executor = options.executor ?? new Ssh2Executor();
    this.repoNamespace = (options.repoNamespace ?? "Tsumugii").trim() || "Tsumugii";
    this.defaultPipelineStatusFilePath = options.defaultPipelineStatusFilePath ?? "~/run/solver_running_status.json";
    this.hfToken = options.hfToken?.trim() || null;
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

  preview(input: SolverJobPreviewRequest): SolverJobPreview {
    return buildSolverJobPreview({
      input,
      server: this.requireServer(input.serverId),
      preflopRangesPath: this.options.preflopRangesPath,
      defaultPipelineStatusFilePath: this.defaultPipelineStatusFilePath,
      repoNamespace: this.repoNamespace,
      hfToken: this.hfToken,
      scenarioLibrary: this.getScenarioLibrary()
    });
  }

  async checkDatasetRepo(input: SolverJobPreviewRequest): Promise<SolverDatasetRepoStatus> {
    const preview = this.preview(input);
    const exists = await huggingFaceDatasetRepoExists(preview.repoId, this.hfToken);
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
    await createHuggingFaceDatasetRepo(status.repoId, this.hfToken);
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
    const remoteRangePath = jobScopedRemoteRangePath(jobId, preview.datasetName);
    const command = buildRunPipelineCommand({
      solverRoot: effectiveSolverRoot(),
      repoId: preview.repoId,
      scenario: preview.scenario,
      rangePath: remoteRangePath,
      settings: preview.settings,
      statusFilePath: preview.pipelineStatusFilePath,
      hfToken: this.hfToken,
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
    const executionCommand = this.buildExecutionCommand(job);

    this.options.db.updateSolverJob(job.id, { status: "deploying", lastError: null });
    this.recordEvent(job.id, "deploying", `Submitting selected range to ${job.remoteRangePath}.`, null);
    try {
      await this.executor.run(server, this.options.credentials!, buildDeployRangeCommand(job));
      this.recordEvent(job.id, "deployed", "Selected range submitted.", null);
      await this.executor.run(server, this.options.credentials!, buildTmuxStartCommand(job, effectiveSolverRoot(), executionCommand));
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
    const servers = this.options.db.getServerRows();
    for (const server of servers) {
      const queued = this.options.db.getQueuedSolverJobForServer(server.id);
      if (!queued) continue;
      if (!serverIsOnline(server)) continue;
      if (this.options.db.getActiveSolverJobForServer(server.id)) continue;
      if (isPipelineActive(server.pipeline)) continue;
      await this.start(queued.id);
    }
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

  private buildExecutionCommand(job: SolverJob): string {
    return buildRunPipelineCommand({
      solverRoot: effectiveSolverRoot(),
      repoId: job.repoId,
      scenario: job.scenario,
      rangePath: job.remoteRangePath,
      settings: job.settings,
      statusFilePath: statusFileFromJob(job),
      hfToken: this.hfToken
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
  scenarioLibrary = DEFAULT_SOLVER_SCENARIO_LIBRARY
}: {
  input: SolverJobPreviewRequest;
  server: ServerRow;
  preflopRangesPath: string;
  defaultPipelineStatusFilePath: string;
  repoNamespace: string;
  hfToken?: string | null;
  scenarioLibrary?: SolverScenarioLibraryItem[];
}): SolverJobPreview {
  const solverRoot = effectiveSolverRoot();

  const file = readPreflopRangeFile(preflopRangesPath, input.rangePath);
  const settings = normalizeSolverJobSettings(input.settings);
  const scenario = scenarioFromPreviewInput(input, scenarioLibrary);
  const datasetName = normalizeDatasetName(input.datasetName) ?? datasetNameFromRangePath(input.rangePath, scenario);
  const repoId = `${repoNamespace}/${datasetName}`;
  const solverRangeText = solverRangeTextFromDocument(file.summary.data);
  const tmuxSession = server.tmuxSession?.trim() || "solver";
  const pipelineStatusFilePath = server.pipelineStatusFilePath?.trim() || defaultPipelineStatusFilePath;
  const remoteRangePath = jobScopedRemoteRangePath("<job-id>", datasetName);
  const commandPreview = buildRunPipelineCommand({
    solverRoot,
    repoId,
    scenario,
    rangePath: remoteRangePath,
    settings,
    statusFilePath: pipelineStatusFilePath,
    hfToken,
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

async function huggingFaceDatasetRepoExists(repoId: string, hfToken: string | null): Promise<boolean> {
  const response = await fetch(`${HUGGING_FACE_ORIGIN}/api/datasets/${repoIdPath(repoId)}`, {
    headers: huggingFaceHeaders(hfToken),
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`Hugging Face dataset repo check failed for ${repoId}: ${await huggingFaceErrorMessage(response)}`);
}

async function createHuggingFaceDatasetRepo(repoId: string, hfToken: string): Promise<void> {
  const { namespace, name } = splitRepoId(repoId);
  const response = await fetch(`${HUGGING_FACE_ORIGIN}/api/repos/create`, {
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
    signal: AbortSignal.timeout(15_000)
  });
  if (response.ok || response.status === 409) return;
  if (response.status === 400 && await huggingFaceDatasetRepoExists(repoId, hfToken)) return;
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
  settings,
  statusFilePath,
  hfToken,
  redactSecrets = false
}: {
  solverRoot: string;
  repoId: string;
  scenario: SolverScenario;
  rangePath?: string;
  rangeFileName?: string;
  oopRange?: string;
  ipRange?: string;
  settings: SolverJobSettings;
  statusFilePath: string;
  hfToken?: string | null;
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
    environmentExports.push(
      `export http_proxy=${shellQuote(HF_UPLOAD_PROXY)}`,
      `export https_proxy=${shellQuote(HF_UPLOAD_PROXY)}`,
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

function effectiveSolverRoot(): string {
  return DEFAULT_SOLVER_ROOT;
}

function jobScopedRemoteRangePath(jobId: string, datasetName: string): string {
  return joinRemotePath(effectiveSolverRoot(), "job-ranges", jobId, `${datasetName}.txt`);
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
