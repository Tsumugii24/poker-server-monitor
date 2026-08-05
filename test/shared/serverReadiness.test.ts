import { describe, expect, it } from "vitest";
import {
  connectionDisplayStatus,
  serverHasConnectivity,
  serverIsJobReady,
  serverIsSshReady
} from "../../src/shared/serverReadiness";
import type { MetricSnapshot, PipelineStatusSnapshot } from "../../src/shared/types";

describe("server readiness", () => {
  it("keeps provider-reachable authenticated failures online but degraded", () => {
    const latest = metric({ connectionStatus: "online", errorCode: "timeout" });
    const server = { latest, pipeline: null };

    expect(serverHasConnectivity(server)).toBe(true);
    expect(serverIsSshReady(server)).toBe(false);
    expect(serverIsJobReady(server)).toBe(false);
    expect(connectionDisplayStatus(latest, null)).toBe("degraded");
  });

  it("blocks job readiness when the pipeline probe failed", () => {
    const latest = metric();
    const pipeline = pipelineFailure();

    expect(serverIsSshReady({ latest, pipeline })).toBe(true);
    expect(serverIsJobReady({ latest, pipeline })).toBe(false);
    expect(connectionDisplayStatus(latest, pipeline)).toBe("degraded");
  });

  it("allows an authenticated online server with no known pipeline error", () => {
    const latest = metric();

    expect(serverIsJobReady({ latest, pipeline: null })).toBe(true);
    expect(connectionDisplayStatus(latest, null)).toBe("online");
  });
});

function metric(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id: "metric-1",
    serverId: "server-1",
    collectedAt: "2026-08-01T12:00:00.000Z",
    connectionStatus: "online",
    healthLevel: "healthy",
    cpuUsedPercent: 20,
    memoryUsedPercent: 30,
    diskUsedPercent: 40,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    uptimeSeconds: 3600,
    errorCode: null,
    errorMessage: null,
    cpuModel: "Intel Xeon",
    cpuVcores: 4,
    memoryTotalBytes: 8_000,
    memoryUsedBytes: 3_000,
    diskTotalBytes: 100_000,
    diskUsedBytes: 40_000,
    ...overrides
  };
}

function pipelineFailure(): PipelineStatusSnapshot {
  return {
    id: "pipeline-1",
    serverId: "server-1",
    collectedAt: "2026-08-01T12:00:00.000Z",
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
    skippedIndices: [],
    completedCount: null,
    failedCount: null,
    skippedCount: null,
    resultPath: null,
    pid: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    command: null,
    error: null,
    errorCode: "timeout",
    errorMessage: "SSH command timed out"
  };
}
