import type { PipelineStatusSnapshot, ServerConfig } from "../shared/types";
import { type SshCredentials, type SshExecutor } from "./sshCollector";

export function buildPipelineStatusCommand(statusFilePath: string): string {
  const statusFile = remoteStatusPath(statusFilePath);
  return String.raw`set -e
STATUS_FILE=${statusFile}
if [ ! -f "$STATUS_FILE" ]; then
  echo "PIPELINE_AVAILABLE=false"
  exit 0
fi
echo "PIPELINE_AVAILABLE=true"
PID=$(grep -Eo '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STATUS_FILE" | tail -1 | grep -Eo '[0-9]+$' || true)
if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
  echo "PIPELINE_PROCESS_ALIVE=true"
else
  echo "PIPELINE_PROCESS_ALIVE=false"
fi
echo "PIPELINE_JSON_BEGIN"
cat "$STATUS_FILE"
echo "PIPELINE_JSON_END"`;
}

export async function collectServerPipelineStatus(
  server: ServerConfig,
  credentials: SshCredentials,
  statusFilePath: string,
  executor: SshExecutor
): Promise<PipelineStatusSnapshot> {
  try {
    const output = await executor.run(server, credentials, buildPipelineStatusCommand(statusFilePath));
    return buildPipelineSnapshot(server.id, parsePipelineCollectorOutput(output));
  } catch (error) {
    const normalized = normalizePipelineError(error);
    return buildPipelineFailureSnapshot(server.id, normalized.code, normalized.message);
  }
}

type ParsedPipelineOutput = {
  available: boolean;
  processAlive: boolean | null;
  raw: Record<string, unknown> | null;
};

export function parsePipelineCollectorOutput(output: string): ParsedPipelineOutput {
  const lines = output.split(/\r?\n/);
  const flags = new Map<string, string>();
  let jsonStart = -1;
  let jsonEnd = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "PIPELINE_JSON_BEGIN") {
      jsonStart = index + 1;
      continue;
    }
    if (line === "PIPELINE_JSON_END") {
      jsonEnd = index;
      break;
    }
    const [key, ...rest] = line.split("=");
    if (key && rest.length > 0) {
      flags.set(key, rest.join("="));
    }
  }

  const available = flags.get("PIPELINE_AVAILABLE") === "true";
  if (!available) {
    return { available: false, processAlive: null, raw: null };
  }

  const processAlive = flags.get("PIPELINE_PROCESS_ALIVE") === "true"
    ? true
    : flags.get("PIPELINE_PROCESS_ALIVE") === "false"
      ? false
      : null;

  if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
    throw new Error("Missing pipeline status JSON payload");
  }

  const jsonText = lines.slice(jsonStart, jsonEnd).join("\n").trim();
  const raw = JSON.parse(jsonText) as unknown;
  if (!isRecord(raw)) {
    throw new Error("Pipeline status JSON must be an object");
  }

  return { available: true, processAlive, raw };
}

export function buildPipelineSnapshot(
  serverId: string,
  parsed: ParsedPipelineOutput,
  collectedAt = new Date()
): PipelineStatusSnapshot {
  if (!parsed.available || !parsed.raw) {
    return {
      id: crypto.randomUUID(),
      serverId,
      collectedAt: collectedAt.toISOString(),
      available: false,
      processAlive: null,
      fileStatus: null,
      displayStatus: "idle",
      phase: null,
      repoId: null,
      datasetName: null,
      scenario: null,
      currentBatch: null,
      totalBatches: null,
      totalTasks: null,
      batchExpr: null,
      assignedIndices: [],
      completedIndices: [],
      failedIndices: [],
      completedCount: null,
      failedCount: null,
      resultPath: null,
      pid: null,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      command: null,
      error: null,
      errorCode: null,
      errorMessage: null
    };
  }

  const raw = parsed.raw;
  const fileStatus = optionalPipelineStatus(raw.status);
  const phase = optionalPhase(raw.phase);

  return {
    id: crypto.randomUUID(),
    serverId,
    collectedAt: collectedAt.toISOString(),
    available: true,
    processAlive: parsed.processAlive,
    fileStatus,
    displayStatus: derivePipelineDisplayStatus(fileStatus, parsed.processAlive, phase),
    phase,
    repoId: optionalString(raw.repo_id),
    datasetName: optionalString(raw.dataset_name),
    scenario: optionalString(raw.scenario),
    currentBatch: optionalNumber(raw.current_batch),
    totalBatches: optionalNumber(raw.total_batches),
    totalTasks: optionalNumber(raw.total_tasks),
    batchExpr: optionalString(raw.batch_expr),
    assignedIndices: optionalNumberArray(raw.assigned_indices),
    completedIndices: optionalNumberArray(raw.completed_indices),
    failedIndices: optionalNumberArray(raw.failed_indices),
    completedCount: optionalNumber(raw.completed_count),
    failedCount: optionalNumber(raw.failed_count),
    resultPath: optionalString(raw.result_path),
    pid: optionalNumber(raw.pid),
    startedAt: optionalString(raw.started_at),
    updatedAt: optionalString(raw.updated_at),
    finishedAt: optionalString(raw.finished_at),
    command: optionalString(raw.command),
    error: optionalString(raw.error),
    errorCode: null,
    errorMessage: null
  };
}

export function buildPipelineFailureSnapshot(
  serverId: string,
  errorCode: string,
  errorMessage: string,
  collectedAt = new Date()
): PipelineStatusSnapshot {
  return {
    id: crypto.randomUUID(),
    serverId,
    collectedAt: collectedAt.toISOString(),
    available: false,
    processAlive: null,
    fileStatus: null,
    displayStatus: "unavailable",
    phase: null,
    repoId: null,
    datasetName: null,
    scenario: null,
    currentBatch: null,
    totalBatches: null,
    totalTasks: null,
    batchExpr: null,
    assignedIndices: [],
    completedIndices: [],
    failedIndices: [],
    completedCount: null,
    failedCount: null,
    resultPath: null,
    pid: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    command: null,
    error: null,
    errorCode,
    errorMessage
  };
}

export function derivePipelineDisplayStatus(
  fileStatus: PipelineStatusSnapshot["fileStatus"],
  processAlive: boolean | null,
  phase: PipelineStatusSnapshot["phase"]
): PipelineStatusSnapshot["displayStatus"] {
  if (!fileStatus) return "idle";
  if (fileStatus === "running") {
    if (processAlive === false) return "stale";
    if (phase === "solving" || phase === "uploading" || phase === "cleanup") return phase;
    return "running";
  }
  return fileStatus;
}

function remoteStatusPath(statusFilePath: string): string {
  const trimmed = statusFilePath.trim();
  if (trimmed.startsWith("~/")) {
    return `"$HOME/${trimmed.slice(2)}"`;
  }
  return `"${trimmed.replace(/"/g, "")}"`;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "number" && Number.isFinite(item) ? Math.trunc(item) : null)
    .filter((item): item is number => item != null);
}

function optionalPipelineStatus(value: unknown): PipelineStatusSnapshot["fileStatus"] {
  if (
    value === "running" ||
    value === "completed" ||
    value === "completed_with_upload_failures" ||
    value === "failed" ||
    value === "exited"
  ) {
    return value;
  }
  return null;
}

function optionalPhase(value: unknown): PipelineStatusSnapshot["phase"] {
  if (value === "solving" || value === "uploading" || value === "cleanup") {
    return value;
  }
  return null;
}

function normalizePipelineError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";

  if (code === "AUTH_FAILED" || /auth/i.test(message)) {
    return { code: "auth_failed", message };
  }
  if (/json|parse/i.test(message)) {
    return { code: "parse_failed", message };
  }
  if (/timed out|timeout/i.test(message)) {
    return { code: "timeout", message };
  }
  return { code: "connect_failed", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
