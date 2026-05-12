import type { ConnectionStatus, HealthLevel, MetricSnapshot } from "../shared/types";

export type ParsedMetrics = {
  cpuUsedPercent: number;
  memoryUsedPercent: number;
  diskUsedPercent: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSeconds: number;
  cpuModel: string;
  cpuVcores: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
};

export type Thresholds = {
  cpu: number;
  memory: number;
  disk: number;
};

export const WARNING_THRESHOLDS: Thresholds = { cpu: 80, memory: 80, disk: 80 };
export const DANGEROUS_THRESHOLDS: Thresholds = { cpu: 90, memory: 90, disk: 90 };

const FIELD_MAP = {
  CPU_USED_PERCENT: "cpuUsedPercent",
  MEMORY_USED_PERCENT: "memoryUsedPercent",
  DISK_USED_PERCENT: "diskUsedPercent",
  LOAD_1: "load1",
  LOAD_5: "load5",
  LOAD_15: "load15",
  UPTIME_SECONDS: "uptimeSeconds",
  CPU_MODEL: "cpuModel",
  CPU_VCORES: "cpuVcores",
  MEMORY_TOTAL_BYTES: "memoryTotalBytes",
  MEMORY_USED_BYTES: "memoryUsedBytes",
  DISK_TOTAL_BYTES: "diskTotalBytes",
  DISK_USED_BYTES: "diskUsedBytes"
} as const;

export function parseCollectorOutput(output: string): ParsedMetrics {
  const values = new Map<string, string | number>();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split("=");
    const rawValue = rest.join("=");
    if (!key || rawValue === undefined) continue;
    
    if (key === "CPU_MODEL") {
      values.set(key, rawValue);
    } else {
      const numValue = Number(rawValue);
      if (Number.isFinite(numValue)) {
        values.set(key, numValue);
      }
    }
  }

  const parsed: Partial<ParsedMetrics> = {};
  for (const [sourceKey, targetKey] of Object.entries(FIELD_MAP)) {
    const value = values.get(sourceKey);
    if (value === undefined) {
      throw new Error(`Missing metric ${sourceKey}`);
    }
    // @ts-expect-error - dynamic assignment
    parsed[targetKey as keyof ParsedMetrics] = value;
  }

  return parsed as ParsedMetrics;
}

/** Determine the health level of an online server based on resource utilisation. */
export function calculateHealthLevel(
  metrics: ParsedMetrics,
  warning: Thresholds = WARNING_THRESHOLDS,
  dangerous: Thresholds = DANGEROUS_THRESHOLDS
): HealthLevel {
  if (
    metrics.cpuUsedPercent >= dangerous.cpu ||
    metrics.memoryUsedPercent >= dangerous.memory ||
    metrics.diskUsedPercent >= dangerous.disk
  ) {
    return "dangerous";
  }
  if (
    metrics.cpuUsedPercent >= warning.cpu ||
    metrics.memoryUsedPercent >= warning.memory ||
    metrics.diskUsedPercent >= warning.disk
  ) {
    return "warning";
  }
  return "healthy";
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
    connectionStatus: "online",
    healthLevel: calculateHealthLevel(metrics),
    cpuUsedPercent: metrics.cpuUsedPercent,
    memoryUsedPercent: metrics.memoryUsedPercent,
    diskUsedPercent: metrics.diskUsedPercent,
    load1: metrics.load1,
    load5: metrics.load5,
    load15: metrics.load15,
    uptimeSeconds: metrics.uptimeSeconds,
    errorCode: null,
    errorMessage: null,
    cpuModel: metrics.cpuModel,
    cpuVcores: metrics.cpuVcores,
    memoryTotalBytes: metrics.memoryTotalBytes,
    memoryUsedBytes: metrics.memoryUsedBytes,
    diskTotalBytes: metrics.diskTotalBytes,
    diskUsedBytes: metrics.diskUsedBytes
  };
}

export function buildFailureSnapshot(
  serverId: string,
  errorCode: string,
  errorMessage: string,
  collectedAt = new Date()
): MetricSnapshot {
  const connectionStatus: ConnectionStatus =
    errorCode === "parse_failed" || errorCode === "no_metrics" ? "unknown" : "offline";

  return {
    id: crypto.randomUUID(),
    serverId,
    collectedAt: collectedAt.toISOString(),
    connectionStatus,
    healthLevel: null,
    cpuUsedPercent: null,
    memoryUsedPercent: null,
    diskUsedPercent: null,
    load1: null,
    load5: null,
    load15: null,
    uptimeSeconds: null,
    errorCode,
    errorMessage,
    cpuModel: null,
    cpuVcores: null,
    memoryTotalBytes: null,
    memoryUsedBytes: null,
    diskTotalBytes: null,
    diskUsedBytes: null
  };
}
