import { randomUUID } from "node:crypto";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  SOLVER_EXPORT_FORMATS,
  SOLVER_UPLOAD_FORMATS,
  type SolverJob,
  type SolverJobCreateRequest,
  type SolverJobEvent,
  type SolverJobPreview,
  type SolverJobPreviewRequest,
  type SolverJobSettings,
  type SolverJobStatus,
  type SolverScenario
} from "../shared/solverJobs";
import type { PipelineStatusSnapshot, ServerRow } from "../shared/types";
import {
  PREFLOP_HAND_CODES,
  PREFLOP_PLAYERS,
  parseRangeText,
  type PreflopPlayerKey,
  type PreflopRangeDocument
} from "../shared/preflopRange";
import type { MonitorDatabase } from "./db";
import { readPreflopRangeFile } from "./preflopRangeStore";
import type { SshCredentials, SshExecutor } from "./sshCollector";
import { Ssh2Executor } from "./sshCollector";

type SolverJobServiceOptions = {
  db: MonitorDatabase;
  preflopRangesPath: string;
  credentials?: SshCredentials;
  executor?: SshExecutor;
  defaultPipelineStatusFilePath?: string;
  repoNamespace?: string;
};

const ACTIVE_JOB_STATUSES = new Set<SolverJobStatus>(["deploying", "running", "stopping"]);
const DEFAULT_SOLVER_ROOT = "~/solver";

export class SolverJobService {
  private readonly executor: SshExecutor;
  private readonly repoNamespace: string;
  private readonly defaultPipelineStatusFilePath: string;

  constructor(private readonly options: SolverJobServiceOptions) {
    this.executor = options.executor ?? new Ssh2Executor();
    this.repoNamespace = (options.repoNamespace ?? "Tsumugii").trim() || "Tsumugii";
    this.defaultPipelineStatusFilePath = options.defaultPipelineStatusFilePath ?? "~/run/solver_running_status.json";
  }

  listJobs() {
    return {
      jobs: this.options.db.getSolverJobs(),
      events: this.options.db.getSolverJobEvents()
    };
  }

  getJob(id: string) {
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
      repoNamespace: this.repoNamespace
    });
  }

  create(input: SolverJobCreateRequest): SolverJob {
    const preview = this.preview(input);
    if (preview.requiresConfirmation && !input.confirmUnstudied) {
      throw new Error("Range is not marked studied; confirmation is required before submitting.");
    }

    const now = new Date().toISOString();
    const job: SolverJob = {
      id: randomUUID(),
      serverId: preview.server.id,
      rangePath: preview.rangePath,
      rangeName: preview.rangeName,
      datasetName: preview.datasetName,
      scenario: preview.scenario,
      repoId: preview.repoId,
      settings: preview.settings,
      command: preview.commandPreview,
      solverRangeText: preview.solverRangeText,
      status: "queued",
      queueMode: input.queueMode ?? "manual",
      confirmUnstudied: Boolean(input.confirmUnstudied),
      tmuxSession: preview.tmuxSession,
      remoteRangePath: preview.remoteRangePath,
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
    this.ensureNoActiveJob(server.id, job.id);
    this.ensureCredentials();

    this.options.db.updateSolverJob(job.id, { status: "deploying", lastError: null });
    this.recordEvent(job.id, "deploying", `Deploying range file to ${job.remoteRangePath}.`, null);
    try {
      await this.executor.run(server, this.options.credentials!, buildDeployRangeCommand(job));
      this.recordEvent(job.id, "deployed", "Range file deployed.", null);
      await this.executor.run(server, this.options.credentials!, buildTmuxStartCommand(job, effectiveSolverRoot()));
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
    this.recordEvent(job.id, "resume_requested", "Resume requested for existing job command.", job.command);
    return this.start(job.id);
  }

  async switchTo(id: string): Promise<SolverJob> {
    const job = this.requireJob(id);
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
      if (this.options.db.getActiveSolverJobForServer(server.id)) continue;
      if (isPipelineActive(server.pipeline)) continue;
      await this.start(queued.id);
    }
  }

  private reconcileCompletedJobs(): void {
    for (const job of this.options.db.getSolverJobs()) {
      if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
      if (!job.pipeline || !pipelineBelongsToJob(job.pipeline, job)) continue;
      if (isPipelineActive(job.pipeline)) continue;
      const nextStatus = completedStatusFromPipeline(job.pipeline);
      this.options.db.updateSolverJob(job.id, {
        status: nextStatus,
        finishedAt: job.pipeline?.finishedAt ?? new Date().toISOString(),
        lastError: nextStatus === "failed" ? job.pipeline?.errorMessage ?? job.pipeline?.error ?? "Pipeline stopped" : null
      });
      this.recordEvent(job.id, nextStatus, `Pipeline reconciled as ${nextStatus}.`, null);
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

  private ensureCredentials(): void {
    if (!this.options.credentials) {
      throw new Error("SSH credentials are required for solver job execution.");
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
}

export function buildSolverJobPreview({
  input,
  server,
  preflopRangesPath,
  defaultPipelineStatusFilePath,
  repoNamespace
}: {
  input: SolverJobPreviewRequest;
  server: ServerRow;
  preflopRangesPath: string;
  defaultPipelineStatusFilePath: string;
  repoNamespace: string;
}): SolverJobPreview {
  const solverRoot = effectiveSolverRoot();

  const file = readPreflopRangeFile(preflopRangesPath, input.rangePath);
  const settings = normalizeSolverJobSettings(input.settings);
  const scenario = scenarioFromRangePath(input.rangePath);
  const datasetName = datasetNameFromRangePath(input.rangePath, scenario);
  const repoId = `${repoNamespace}/${datasetName}`;
  const solverRangeText = solverRangeTextFromDocument(file.summary.data);
  const tmuxSession = server.tmuxSession?.trim() || "solver";
  const pipelineStatusFilePath = server.pipelineStatusFilePath?.trim() || defaultPipelineStatusFilePath;
  const remoteRangePath = joinRemotePath(solverRoot, "ranges", scenario, `${datasetName}.txt`);
  const commandPreview = buildRunPipelineCommand({
    solverRoot,
    repoId,
    scenario,
    rangeFileName: `${datasetName}.txt`,
    settings,
    statusFilePath: pipelineStatusFilePath
  });
  const warnings: string[] = [];
  const learned = file.summary.data.learned;
  if (!learned) {
    warnings.push("Range is not marked studied.");
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
    requiresConfirmation: !learned && !input.confirmUnstudied
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

export function datasetNameFromRangePath(rangePath: string, scenario: SolverScenario): string {
  const stem = (rangePath.split("/").at(-1) ?? rangePath)
    .replace(/\.(json|range|txt)$/i, "")
    .replace(/\s+\d+$/g, "");
  const tokens = [...stem.matchAll(/\b(3ia|3od|sia|sod|soa|sid)[-\s_]*(\d+(?:\.\d+)?)/gi)]
    .map((match) => `${match[1]!.toLowerCase()}-${trimNumericLabel(match[2]!)}`);
  const byPrefix = new Map(tokens.map((token) => [token.split("-")[0], token]));

  if (scenario === "3ia-3od") {
    const name = [byPrefix.get("3ia"), byPrefix.get("3od")].filter(Boolean).join("-");
    return name || fallbackDatasetName(stem);
  }
  if (scenario.startsWith("sia-sod")) {
    const base = [byPrefix.get("sia"), byPrefix.get("sod")].filter(Boolean).join("-");
    const suffix = scenario === "sia-sod"
      ? ""
      : scenario === "sia-sod-open2"
        ? "-open2"
        : scenario === "sia-sod-open2.5"
          ? "-open2.5"
          : "-open3";
    return base ? `${base}${suffix}` : fallbackDatasetName(stem);
  }
  if (scenario === "soa-sid") {
    const name = [byPrefix.get("soa"), byPrefix.get("sid")].filter(Boolean).join("-");
    return name || fallbackDatasetName(stem);
  }

  return fallbackDatasetName(stem);
}

function fallbackDatasetName(stem: string): string {
  const fallback = stem.toLowerCase()
    .replace(/\bvs\b/g, "-")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return fallback;
}

export function scenarioFromRangePath(rangePath: string): SolverScenario {
  const normalized = rangePath.toLowerCase();
  if (normalized.includes("3ia") || normalized.includes("3od")) return "3ia-3od";
  if (normalized.includes("soa") || normalized.includes("sid")) return "soa-sid";
  if (normalized.includes("sod/2.5bb")) return "sia-sod-open2.5";
  if (normalized.includes("sod/2bb")) return "sia-sod-open2";
  if (normalized.includes("sod/3bb")) return "sia-sod-open3";
  if (normalized.includes("open2.5")) return "sia-sod-open2.5";
  if (normalized.includes("open2")) return "sia-sod-open2";
  if (normalized.includes("open3")) return "sia-sod-open3";
  return "sia-sod";
}

export function buildRunPipelineCommand({
  solverRoot,
  repoId,
  scenario,
  rangeFileName,
  settings,
  statusFilePath
}: {
  solverRoot: string;
  repoId: string;
  scenario: SolverScenario;
  rangeFileName: string;
  settings: SolverJobSettings;
  statusFilePath: string;
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
    statusFilePath
  ];
  if (settings.uploadEnabled) {
    args.push(
      "--repo-id",
      repoId,
      "--upload-format",
      settings.uploadFormat,
      "--upload-attempt-timeout",
      String(settings.uploadAttemptTimeoutSeconds)
    );
  } else {
    args.push(
      "--no-upload",
      "--scenario",
      scenario,
      "--range-file",
      rangeFileName
    );
  }
  if (settings.stallTimeoutSeconds != null) args.push("--stall-timeout", String(settings.stallTimeoutSeconds));
  if (settings.noOutputTimeoutSeconds != null) args.push("--no-output-timeout", String(settings.noOutputTimeoutSeconds));
  return `cd ${shellQuoteRemotePath(solverRoot)} && PIPELINE_STATUS_FILE=${shellQuote(statusFilePath)} ${args.map(shellQuote).join(" ")}`;
}

export function buildDeployRangeCommand(job: SolverJob): string {
  const tmpPath = `${job.remoteRangePath}.tmp`;
  return [
    "set -e",
    `RANGE_PATH=${shellQuoteRemotePath(job.remoteRangePath)}`,
    `TMP_PATH=${shellQuoteRemotePath(tmpPath)}`,
    `mkdir -p ${shellQuoteRemotePath(dirnameRemote(job.remoteRangePath))}`,
    `if [ -f "$RANGE_PATH" ]; then cp "$RANGE_PATH" "$RANGE_PATH.bak.$(date +%Y%m%d%H%M%S)"; fi`,
    `cat > "$TMP_PATH" <<'SOLVER_RANGE_EOF'`,
    job.solverRangeText.trimEnd(),
    "SOLVER_RANGE_EOF",
    `mv "$TMP_PATH" "$RANGE_PATH"`
  ].join("\n");
}

export function buildTmuxStartCommand(job: SolverJob, solverRoot: string): string {
  return [
    "set -e",
    `tmux has-session -t ${shellQuote(job.tmuxSession)} 2>/dev/null || tmux new-session -d -s ${shellQuote(job.tmuxSession)} -c ${shellQuoteRemotePath(solverRoot)}`,
    `tmux send-keys -t ${shellQuote(job.tmuxSession)} ${shellQuote(job.command)} C-m`
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
  if (pipeline.displayStatus === "failed" || pipeline.displayStatus === "unavailable") {
    return "failed";
  }
  return "interrupted";
}

function pipelineBelongsToJob(pipeline: PipelineStatusSnapshot, job: SolverJob): boolean {
  return pipeline.repoId === job.repoId || pipeline.datasetName === job.datasetName;
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

function trimNumericLabel(value: string): string {
  return value.replace(/\.0$/, "");
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
