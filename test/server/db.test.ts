import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SOLVER_JOB_SETTINGS } from "../../src/shared/solverJobs";
import { DEFAULT_SOLVER_SETTING_LIBRARY } from "../../src/shared/solverSettings";
import type { ConnectionStatus, HealthLevel, MetricSnapshot, ServerConfig } from "../../src/shared/types";
import { MonitorDatabase } from "../../src/server/db";

const servers: ServerConfig[] = [
  {
    id: "prod-01",
    name: "Production 01",
    host: "10.0.0.1",
    port: 22,
    group: "production",
    enabled: true,
    note: "TBD",
    tier: "performance"
  },
  {
    id: "prod-02",
    name: "Production 02",
    host: "10.0.0.2",
    port: 2222,
    enabled: true,
    note: "TBD"
  }
];

function snapshot(
  serverId: string,
  collectedAt: string,
  connectionStatus: ConnectionStatus = "online",
  healthLevel: HealthLevel | null = connectionStatus === "online" ? "healthy" : null
): MetricSnapshot {
  const isOffline = connectionStatus === "offline";
  return {
    id: `${serverId}-${collectedAt}`,
    serverId,
    collectedAt,
    connectionStatus,
    healthLevel,
    cpuUsedPercent: isOffline ? null : 20,
    memoryUsedPercent: isOffline ? null : 40,
    diskUsedPercent: isOffline ? null : 60,
    load1: isOffline ? null : 0.1,
    load5: isOffline ? null : 0.2,
    load15: isOffline ? null : 0.3,
    uptimeSeconds: isOffline ? null : 3600,
    errorCode: isOffline ? "connect_failed" : null,
    errorMessage: isOffline ? "Connection failed" : null,
    cpuModel: isOffline ? null : "Intel Xeon E5-2686 v4",
    cpuVcores: isOffline ? null : 4,
    memoryTotalBytes: isOffline ? null : 8589934592,
    memoryUsedBytes: isOffline ? null : 3435973837,
    diskTotalBytes: isOffline ? null : 107374182400,
    diskUsedBytes: isOffline ? null : 64424509440
  };
}

describe("MonitorDatabase", () => {
  let db: MonitorDatabase;

  beforeEach(async () => {
    db = await MonitorDatabase.createInMemory();
  });

  afterEach(() => {
    db.close();
  });

  it("upserts server inventory and returns rows with latest snapshots", () => {
    db.syncServers(servers);
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T00:00:00.000Z"));
    db.insertSnapshot(snapshot("prod-02", "2026-05-12T00:00:00.000Z", "offline"));

    const rows = db.getServerRows();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.latest?.connectionStatus).toBe("online");
    expect(rows[0]?.latest?.healthLevel).toBe("healthy");
    expect(rows.map((row) => row.tier)).toEqual(["performance", "standard"]);
    expect(rows[1]?.latest?.errorCode).toBe("connect_failed");
  });

  it("removes servers that are no longer present in config inventory", () => {
    db.syncServers(servers);
    db.syncServers([servers[0]!]);

    expect(db.getServers().map((server) => server.id)).toEqual(["prod-01"]);
  });

  it("returns per-server history sorted by collection time", () => {
    db.syncServers(servers);
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T01:00:00.000Z", "online", "healthy"));
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T00:00:00.000Z", "online", "warning"));

    const history = db.getServerHistory("prod-01", 24, "2026-05-12T02:00:00.000Z");

    expect(history.map((item) => item.healthLevel)).toEqual(["warning", "healthy"]);
  });

  it("prunes metric snapshots older than 24 hours", () => {
    db.syncServers(servers);
    db.insertSnapshot(snapshot("prod-01", "2026-05-10T23:59:59.000Z"));
    db.insertSnapshot(snapshot("prod-01", "2026-05-11T00:00:01.000Z"));

    db.pruneSnapshots(24, "2026-05-12T00:00:00.000Z");

    expect(db.getServerHistory("prod-01", 48, "2026-05-12T00:00:00.000Z")).toHaveLength(1);
  });

  it("persists the last known dataset name on the server record", () => {
    db.syncServers(servers);
    db.updateServerLastDatasetName("prod-01", "sia-45-sod-40");

    expect(db.getLastDatasetName("prod-01")).toBe("sia-45-sod-40");
    expect(db.getServerRows().find((row) => row.id === "prod-01")?.lastDatasetName).toBe("sia-45-sod-40");
  });

  it("relinks solver history and failure-pool records after a range folder rename", () => {
    const setting = DEFAULT_SOLVER_SETTING_LIBRARY[0]!;
    const previousPath = "SOA EP/SOA 15.8 vs SOD 11.5.json";
    const nextPath = "SIA VS SB CC/SOA 15.8 vs SOD 11.5.json";
    const now = "2026-09-04T00:00:00.000Z";
    db.insertParallelSolverRun({
      id: "parallel-rename",
      sourceType: "parallel",
      rangePath: previousPath,
      rangeName: path.posix.basename(previousPath),
      datasetName: "soa-15.8-sod-11.5",
      repoId: "Tsumugii/soa-15.8-sod-11.5",
      settingId: setting.id,
      setting,
      scenario: setting.id,
      settings: DEFAULT_SOLVER_JOB_SETTINGS,
      solverRangeText: "AA",
      status: "completed",
      reportCleared: false,
      queueOrder: 0,
      serverIds: ["prod-01"],
      autoIncludeNewServers: false,
      serverScope: "all",
      totalIndices: [1],
      missingIndices: [1],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
      lastError: null,
      slices: [],
      report: {
        totalBoards: 1,
        completedBoards: 1,
        failedBoards: 0,
        queuedBoards: 0,
        runningBoards: 0,
        successRate: 1,
        durationSeconds: 0
      }
    });
    db.insertSolverJob({
      id: "job-rename",
      serverId: "prod-01",
      rangePath: previousPath,
      rangeName: path.posix.basename(previousPath),
      datasetName: "soa-15.8-sod-11.5",
      settingId: setting.id,
      setting,
      scenario: setting.id,
      repoId: "Tsumugii/soa-15.8-sod-11.5",
      settings: DEFAULT_SOLVER_JOB_SETTINGS,
      command: "python run_pipeline.py",
      solverRangeText: "AA",
      status: "completed",
      queueMode: "manual",
      confirmUnstudied: false,
      tmuxSession: "solver",
      remoteRangePath: "/srv/solver/range.txt",
      remoteResultPath: "/srv/solver/results/job-rename",
      parallelRunId: "parallel-rename",
      parallelSliceId: null,
      assignedIndices: [1],
      sourceType: "parallel",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
      lastError: null,
      pipeline: null
    });
    db.upsertParallelFailurePoolEntry({
      id: "failure-rename",
      rangePath: previousPath,
      datasetName: "soa-15.8-sod-11.5",
      repoId: "Tsumugii/soa-15.8-sod-11.5",
      scenario: setting.id,
      boardIndex: 1,
      boardName: "Ac,Ad,Ah",
      boardKey: "acadah",
      status: "solved",
      failureReason: "abnormal_end",
      attemptCount: 1,
      lastRunId: "parallel-rename",
      lastSliceId: null,
      lastServerId: "prod-01",
      lastError: null,
      createdAt: now,
      updatedAt: now
    });

    const relinked = db.relinkPreflopRangePath("SOA EP", "SIA VS SB CC", true);

    expect(relinked).toEqual({ solverJobs: 1, parallelRuns: 1, failurePoolEntries: 1 });
    expect(db.getSolverJob("job-rename")).toMatchObject({
      rangePath: nextPath,
      rangeName: path.posix.basename(nextPath)
    });
    expect(db.getParallelSolverRun("parallel-rename")).toMatchObject({
      rangePath: nextPath,
      rangeName: path.posix.basename(nextPath)
    });
    expect(db.getParallelFailurePoolEntries(nextPath, "soa-15.8-sod-11.5"))
      .toHaveLength(1);
    expect(db.getParallelFailurePoolEntries(previousPath, "soa-15.8-sod-11.5"))
      .toHaveLength(0);
  });

  it("records refresh runs and returns the latest run", () => {
    db.insertRefreshRun({
      id: "run-1",
      trigger: "manual",
      startedAt: "2026-05-12T00:00:00.000Z",
      finishedAt: "2026-05-12T00:00:02.000Z",
      status: "completed",
      successCount: 1,
      warningCount: 0,
      failureCount: 1
    });

    expect(db.getLastRefreshRun()?.id).toBe("run-1");
  });

  it("groups overall history by refresh run time instead of per-server snapshot time", () => {
    db.syncServers(servers);
    db.insertRefreshRun({
      id: "run-1",
      trigger: "manual",
      startedAt: "2026-05-12T10:00:00.000Z",
      finishedAt: "2026-05-12T10:00:10.000Z",
      status: "completed",
      successCount: 2,
      warningCount: 0,
      failureCount: 0
    });
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T10:00:02.000Z", "online", "healthy"));
    db.insertSnapshot({
      ...snapshot("prod-02", "2026-05-12T10:00:08.000Z", "online", "healthy"),
      cpuUsedPercent: 40,
      memoryUsedPercent: 60,
      diskUsedPercent: 80
    });

    const history = db.getOverallHistory(24, "2026-05-12T11:00:00.000Z");

    expect(history).toEqual([
      {
        collectedAt: "2026-05-12T10:00:00.000Z",
        averageCpu: 30,
        averageMemory: 50,
        averageDisk: 70
      }
    ]);
  });

  it("excludes disabled server snapshots from overall history", () => {
    db.syncServers([
      servers[0]!,
      { ...servers[1]!, enabled: false }
    ]);
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T10:00:00.000Z"));
    db.insertSnapshot({
      ...snapshot("prod-02", "2026-05-12T10:00:00.000Z"),
      cpuUsedPercent: 100,
      memoryUsedPercent: 100,
      diskUsedPercent: 100
    });

    expect(db.getOverallHistory(24, "2026-05-12T11:00:00.000Z")).toEqual([
      {
        collectedAt: "2026-05-12T10:00:00.000Z",
        averageCpu: 20,
        averageMemory: 40,
        averageDisk: 60
      }
    ]);
  });

  it("allows only one process-wide writer for a file-backed database", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-db-lock-"));
    const databasePath = path.join(tempDir, "monitor.sqlite");
    const lockPath = `${databasePath}.lock`;
    const first = await MonitorDatabase.open(databasePath);
    try {
      expect(fs.existsSync(lockPath)).toBe(true);
      await expect(MonitorDatabase.open(databasePath)).rejects.toThrow(
        /already in use by process/
      );
    } finally {
      first.close();
    }

    expect(fs.existsSync(lockPath)).toBe(false);
    const reopened = await MonitorDatabase.open(databasePath);
    reopened.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
