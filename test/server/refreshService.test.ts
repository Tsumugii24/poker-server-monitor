import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ConnectionStatus,
  HealthLevel,
  MetricSnapshot,
  PipelineStatusSnapshot,
  ServerConfig
} from "../../src/shared/types";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";
import type { AlertService } from "../../src/server/alertService";

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

  it("keeps provider-reachable SSH failures online but degraded and retains last-known metrics", async () => {
    db.insertSnapshot(metric("prod-01", "online"));
    const collectPipeline = vi.fn(async () => buildIdlePipeline("prod-01"));
    const service = new RefreshService({
      db,
      servers: [servers[0]!],
      intervalMs: 3_600_000,
      probeConnectivity: async () => ({
        reachable: true,
        latencyMs: 12.5,
        banner: "SSH-2.0-OpenSSH_9.6",
        errorCode: null,
        errorMessage: null
      }),
      collect: async (server) => metric(server.id, "offline"),
      collectPipeline
    });

    await service.refreshAll("manual");

    const row = db.getServerRows().find((server) => server.id === "prod-01")!;
    expect(row.latest).toMatchObject({
      connectionStatus: "online",
      errorCode: "connect_failed",
      cpuUsedPercent: 20,
      memoryUsedPercent: 30
    });
    expect(row.pipeline).toMatchObject({ displayStatus: "unavailable", errorCode: "connect_failed" });
    expect(collectPipeline).not.toHaveBeenCalled();
    expect(db.getLastRefreshRun()).toMatchObject({ warningCount: 1, failureCount: 0 });
  });

  it("marks a failed provider connectivity probe offline and skips authenticated SSH", async () => {
    const collect = vi.fn(async (server: ServerConfig) => metric(server.id, "online"));
    const collectPipeline = vi.fn(async (server: ServerConfig) => buildIdlePipeline(server.id));
    const service = new RefreshService({
      db,
      servers: [servers[0]!],
      intervalMs: 3_600_000,
      probeConnectivity: async () => ({
        reachable: false,
        latencyMs: null,
        banner: null,
        errorCode: "connection_refused",
        errorMessage: "Connection refused (port may be closed)"
      }),
      collect,
      collectPipeline
    });

    await service.refreshAll("manual");

    expect(collect).not.toHaveBeenCalled();
    expect(collectPipeline).not.toHaveBeenCalled();
    expect(db.getServerRows()[0]?.latest).toMatchObject({
      connectionStatus: "offline",
      errorCode: "connection_refused"
    });
  });

  it("limits a full refresh to four servers in flight", async () => {
    const manyServers = Array.from({ length: 8 }, (_, index): ServerConfig => ({
      id: `prod-${index + 1}`,
      name: `Production ${index + 1}`,
      host: `10.0.1.${index + 1}`,
      port: 22,
      enabled: true,
      note: "TBD"
    }));
    db.syncServers(manyServers);
    let activeCollectors = 0;
    let maximumActiveCollectors = 0;
    const service = new RefreshService({
      db,
      servers: manyServers,
      intervalMs: 3_600_000,
      probeConnectivity: async () => ({
        reachable: true,
        latencyMs: 1,
        banner: "SSH-2.0-test",
        errorCode: null,
        errorMessage: null
      }),
      collect: async (server) => {
        activeCollectors += 1;
        maximumActiveCollectors = Math.max(maximumActiveCollectors, activeCollectors);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCollectors -= 1;
        return metric(server.id, "online");
      },
      collectPipeline: async (server) => buildIdlePipeline(server.id)
    });

    await service.refreshAll("manual");

    expect(maximumActiveCollectors).toBe(4);
    expect(db.getServerRows().filter((server) => server.latest?.connectionStatus === "online")).toHaveLength(8);
  });

  it("refreshes one recovered server without running a full inventory refresh", async () => {
    const collectedServerIds: string[] = [];
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) => {
        collectedServerIds.push(server.id);
        return metric(server.id, "online");
      }
    });

    const refreshed = await service.refreshServer("prod-02");

    expect(refreshed?.metrics.connectionStatus).toBe("online");
    expect(collectedServerIds).toEqual(["prod-02"]);
    expect(db.getServerRows().find((server) => server.id === "prod-02")?.latest?.connectionStatus).toBe("online");
    expect(db.getServerRows().find((server) => server.id === "prod-01")?.latest).toBeNull();
    expect(db.getLastRefreshRun()).toBeNull();
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

  it("publishes completed server snapshots before the slowest server finishes", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) => {
        if (server.id === "prod-02") await blocker;
        return metric(server.id, "online");
      }
    });

    const refresh = service.refreshAll("manual");
    await vi.waitFor(() => expect(
      db.getServerRows().find((server) => server.id === "prod-01")?.latest?.connectionStatus
    ).toBe("online"));

    expect(db.getServerRows().find((server) => server.id === "prod-02")?.latest).toBeNull();
    expect(service.getState()).toMatchObject({
      active: true,
      current: { totalServers: 2, completedServers: 1 }
    });

    release();
    await refresh;
    expect(service.getState()).toMatchObject({ active: false, current: null });
  });

  it("does not keep refresh active while alert delivery is still pending", async () => {
    let releaseAlert!: () => void;
    const alertPending = new Promise<void>((resolve) => {
      releaseAlert = resolve;
    });
    const service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async (server) => metric(server.id, "online"),
      alerts: {
        handleRefresh: async () => alertPending
      } as unknown as AlertService
    });

    await service.refreshAll("manual");

    expect(service.getState().active).toBe(false);
    expect(db.getLastRefreshRun()).toMatchObject({ status: "completed" });
    releaseAlert();
  });
});

function buildIdlePipeline(serverId: string): PipelineStatusSnapshot {
  return {
    id: `${serverId}-idle-${crypto.randomUUID()}`,
    serverId,
    collectedAt: new Date().toISOString(),
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
    errorCode: null,
    errorMessage: null
  };
}
