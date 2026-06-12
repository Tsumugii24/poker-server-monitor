import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    note: "TBD"
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
});
