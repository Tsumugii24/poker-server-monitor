import type { MetricSnapshot, ServerStatus } from "../shared/types";

export type ParsedMetrics = {
  cpuUsedPercent: number;
  memoryUsedPercent: number;
  diskUsedPercent: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSeconds: number;
};

export type Thresholds = {
  cpu: number;
  memory: number;
  disk: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpu: 80,
  memory: 80,
  disk: 80
};

const FIELD_MAP = {
  CPU_USED_PERCENT: "cpuUsedPercent",
  MEMORY_USED_PERCENT: "memoryUsedPercent",
  DISK_USED_PERCENT: "diskUsedPercent",
  LOAD_1: "load1",
  LOAD_5: "load5",
  LOAD_15: "load15",
  UPTIME_SECONDS: "uptimeSeconds"
} as const;

export function parseCollectorOutput(output: string): ParsedMetrics {
  const values = new Map<string, number>();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, rawValue] = trimmed.split("=", 2);
    if (!key || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      values.set(key, value);
    }
  }

  const parsed: Partial<ParsedMetrics> = {};
  for (const [sourceKey, targetKey] of Object.entries(FIELD_MAP)) {
    const value = values.get(sourceKey);
    if (value === undefined) {
      throw new Error(`Missing metric ${sourceKey}`);
    }
    parsed[targetKey as keyof ParsedMetrics] = value;
  }

  return parsed as ParsedMetrics;
}

export function calculateStatus(
  metrics: ParsedMetrics,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): ServerStatus {
  if (
    metrics.cpuUsedPercent >= thresholds.cpu ||
    metrics.memoryUsedPercent >= thresholds.memory ||
    metrics.diskUsedPercent >= thresholds.disk
  ) {
    return "warning";
  }
  return "online";
}

export function buildMetricSnapshot(
  serverId: string,
  metrics: ParsedMetrics,
  collectedAt = new Date()
): MetricSnapshot {
  return {
    id: crypto.randomUUID(),
    serverId,
    collectedAt: collectedAt.toISOString(),
    status: calculateStatus(metrics),
    cpuUsedPercent: metrics.cpuUsedPercent,
    memoryUsedPercent: metrics.memoryUsedPercent,
    diskUsedPercent: metrics.diskUsedPercent,
    load1: metrics.load1,
    load5: metrics.load5,
    load15: metrics.load15,
    uptimeSeconds: metrics.uptimeSeconds,
    errorCode: null,
    errorMessage: null
  };
}

export function buildFailureSnapshot(
  serverId: string,
  errorCode: string,
  errorMessage: string,
  collectedAt = new Date()
): MetricSnapshot {
  const status: ServerStatus =
    errorCode === "parse_failed" || errorCode === "no_metrics" ? "unknown" : "offline";

  return {
    id: crypto.randomUUID(),
    serverId,
    collectedAt: collectedAt.toISOString(),
    status,
    cpuUsedPercent: null,
    memoryUsedPercent: null,
    diskUsedPercent: null,
    load1: null,
    load5: null,
    load15: null,
    uptimeSeconds: null,
    errorCode,
    errorMessage
  };
}
