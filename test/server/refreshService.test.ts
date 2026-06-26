import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectionStatus, HealthLevel, MetricSnapshot, ServerConfig } from "../../src/shared/types";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";

const servers: ServerConfig[] = [
  { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true, note: "TBD" },
  { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 22, enabled: true, note: "TBD" }
];

function metric(
  serverId: string,
  connectionStatus: ConnectionStatus,
  healthLevel: HealthLevel | null = connectionStatus === "online" ? "healthy" : null
): MetricSnapshot {
  const isOffline = connectionStatus === "offline";
  return {
    id: `${serverId}-${connectionStatus}`,
    serverId,
    collectedAt: new Date().toISOString(),
    connectionStatus,
    healthLevel,
    cpuUsedPercent: isOffline ? null : 20,
    memoryUsedPercent: isOffline ? null : 30,
    diskUsedPercent: isOffline ? null : 40,
    load1: isOffline ? null : 0.1,
    load5: isOffline ? null : 0.2,
    load15: isOffline ? null : 0.3,
    uptimeSeconds: isOffline ? null : 3600,
    errorCode: isOffline ? "connect_failed" : null,
    errorMessage: isOffline ? "Connection failed" : null,
    cpuModel: isOffline ? null : "Intel Xeon E5-2686 v4",
    cpuVcores: isOffline ? null : 4,
    memoryTotalBytes: isOffline ? null : 8589934592,
    memoryUsedBytes: isOffline ? null : 2576980378,
    diskTotalBytes: isOffline ? null : 107374182400,
    diskUsedBytes: isOffline ? null : 42949672960
  };
}

describe("RefreshService", () => {
  let db: MonitorDatabase;

  beforeEach(async () => {
    db = await MonitorDatabase.createInMemory();
    db.syncServers(servers);
  });

  it("collects all enabled servers and records a run summary", async () => {
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) =>
        metric(server.id, "online", server.id === "prod-01" ? "healthy" : "warning"),
      collectPipeline: async (server) => ({
        id: `${server.id}-pipeline`,
        serverId: server.id,
        collectedAt: new Date().toISOString(),
        available: server.id === "prod-01",
        processAlive: server.id === "prod-01",
        fileStatus: server.id === "prod-01" ? "running" : null,
        displayStatus: server.id === "prod-01" ? "solving" : "idle",
        phase: server.id === "prod-01" ? "solving" : null,
        repoId: server.id === "prod-01" ? "Tsumugii/sia-45-sod-40" : null,
        datasetName: server.id === "prod-01" ? "sia-45-sod-40" : null,
        scenario: null,
        currentBatch: null,
        totalBatches: null,
        totalTasks: null,
        batchExpr: null,
        pid: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        command: null,
        error: null,
        errorCode: null,
        errorMessage: null
      })
    });

    const response = await service.refreshAll("manual");

    expect(response.accepted).toBe(true);
    expect(db.getServerRows().map((row) => row.latest?.connectionStatus)).toEqual(["online", "online"]);
    expect(db.getServerRows().map((row) => row.latest?.healthLevel)).toEqual(["healthy", "warning"]);
    expect(db.getServerRows().map((row) => row.pipeline?.displayStatus)).toEqual(["solving", "idle"]);
    expect(db.getServerRows().map((row) => row.lastDatasetName)).toEqual(["sia-45-sod-40", null]);
    expect(db.getLastRefreshRun()).toMatchObject({
      status: "completed",
      successCount: 1,
      warningCount: 1,
      failureCount: 0
    });
  });

  it("syncs discovered dataset names back to the inventory file", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-refresh-"));
    const inventoryPath = path.join(tempDir, "servers.json");
    fs.writeFileSync(inventoryPath, JSON.stringify(servers));

    try {
      const service = new RefreshService({
        db,
        servers,
        intervalMs: 3_600_000,
        inventoryPath,
        collect: async (server) => metric(server.id, "online"),
        collectPipeline: async (server) => ({
          id: `${server.id}-pipeline`,
          serverId: server.id,
          collectedAt: new Date().toISOString(),
          available: true,
          processAlive: true,
          fileStatus: "running",
          displayStatus: "solving",
          phase: "solving",
          repoId: `Tsumugii/${server.id}-dataset`,
          datasetName: server.id === "prod-01" ? "3ia-16.5-3od-7.6" : null,
          scenario: null,
          currentBatch: null,
          totalBatches: null,
          totalTasks: null,
          batchExpr: null,
          pid: null,
          startedAt: null,
          updatedAt: null,
          finishedAt: null,
          command: null,
          error: null,
          errorCode: null,
          errorMessage: null
        })
      });

      await service.refreshAll("manual");

      expect(db.getServer("prod-01")?.name).toBe("3ia-16.5-3od-7.6");
      expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))[0].name).toBe("3ia-16.5-3od-7.6");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stores one shared collection timestamp for all snapshots in a refresh run", async () => {
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) => ({
        ...metric(server.id, "online"),
        collectedAt: server.id === "prod-01"
          ? "2026-05-12T10:00:00.000Z"
          : "2026-05-12T10:00:05.000Z"
      })
    });

    await service.refreshAll("manual");

    const rows = db.getServerRows();
    expect(new Set(rows.map((row) => row.latest?.collectedAt)).size).toBe(1);

    const history = db.getOverallHistory(24);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      averageCpu: 20,
      averageMemory: 30,
      averageDisk: 40
    });
  });

  it("can run a startup refresh immediately when the scheduler starts", async () => {
    let refreshCount = 0;
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) => {
        refreshCount += 1;
        return metric(server.id, "online");
      }
    });

    service.startScheduler({ runImmediately: true });
    await vi.waitFor(() => expect(db.getLastRefreshRun()).toMatchObject({ trigger: "startup" }));
    service.stopScheduler();

    expect(refreshCount).toBe(servers.length);
    expect(db.getLastRefreshRun()).toMatchObject({ trigger: "startup" });
  });

  it("keeps the automatic refresh schedule fixed after a manual refresh", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
      const service = new RefreshService({
        db,
        servers,
        intervalMs: 3_600_000,
        collect: async (server) => metric(server.id, "online")
      });

      service.startScheduler();
      const nextAutoRefresh = service.getState().nextRefreshAt;

      vi.setSystemTime(new Date("2026-05-20T10:15:00.000Z"));
      await service.refreshAll("manual");
      service.stopScheduler();

      expect(service.getState().nextRefreshAt).toBe(nextAutoRefresh);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances the next automatic refresh time when the scheduled tick fires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
      const service = new RefreshService({
        db,
        servers,
        intervalMs: 3_600_000,
        collect: async (server) => metric(server.id, "online")
      });

      service.startScheduler();
      expect(service.getState().nextRefreshAt).toBe("2026-05-20T11:00:00.000Z");

      await vi.advanceTimersByTimeAsync(3_600_000);
      service.stopScheduler();

      expect(service.getState().nextRefreshAt).toBe("2026-05-20T12:00:00.000Z");
      expect(db.getLastRefreshRun()).toMatchObject({ trigger: "scheduled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects overlapping refresh requests", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) => {
        await blocker;
        return metric(server.id, "online");
      }
    });

    const first = service.refreshAll("manual");
    const second = await service.refreshAll("manual");
    release();
    await first;

    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.code).toBe("refresh_in_progress");
    }
  });
});
