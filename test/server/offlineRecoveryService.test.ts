import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus, MetricSnapshot, ServerConfig } from "../../src/shared/types";
import { MonitorDatabase } from "../../src/server/db";
import { buildPipelineFailureSnapshot } from "../../src/server/pipelineStatusCollector";
import {
  OfflineRecoveryService,
  type OfflineRecoveryServiceOptions
} from "../../src/server/offlineRecoveryService";

const servers: ServerConfig[] = [
  { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true, note: "TBD" },
  { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 22, enabled: true, note: "TBD" },
  { id: "prod-03", name: "Production 03", host: "10.0.0.3", port: 22, enabled: false, note: "TBD" }
];

function metric(serverId: string, connectionStatus: ConnectionStatus): MetricSnapshot {
  const online = connectionStatus === "online";
  return {
    id: `${serverId}-${connectionStatus}-${crypto.randomUUID()}`,
    serverId,
    collectedAt: new Date().toISOString(),
    connectionStatus,
    healthLevel: online ? "healthy" : null,
    cpuUsedPercent: online ? 20 : null,
    memoryUsedPercent: online ? 30 : null,
    diskUsedPercent: online ? 40 : null,
    load1: online ? 0.1 : null,
    load5: online ? 0.2 : null,
    load15: online ? 0.3 : null,
    uptimeSeconds: online ? 3600 : null,
    errorCode: online ? null : "connect_failed",
    errorMessage: online ? null : "Connection failed",
    cpuModel: online ? "Intel Xeon" : null,
    cpuVcores: online ? 4 : null,
    memoryTotalBytes: online ? 8589934592 : null,
    memoryUsedBytes: online ? 2576980378 : null,
    diskTotalBytes: online ? 107374182400 : null,
    diskUsedBytes: online ? 42949672960 : null
  };
}

describe("OfflineRecoveryService", () => {
  let db: MonitorDatabase;

  beforeEach(async () => {
    db = await MonitorDatabase.createInMemory();
    db.syncServers(servers);
    db.insertSnapshot(metric("prod-01", "offline"));
    db.insertSnapshot(metric("prod-02", "online"));
    db.insertSnapshot(metric("prod-03", "offline"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("probes only enabled offline servers, refreshes recovered status, and triggers queue reconciliation", async () => {
    const probe = vi.fn(async () => undefined);
    const onRecovered = vi.fn(async () => undefined);
    const refreshServer = vi.fn(async (serverId: string) => ({
      metrics: metric(serverId, "online"),
      pipeline: buildPipelineFailureSnapshot(serverId, "not_configured", "test")
    }));
    const service = createService({ probe, onRecovered, refreshServer });

    const result = await service.checkNow();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0].id).toBe("prod-01");
    expect(refreshServer).toHaveBeenCalledWith("prod-01");
    expect(result).toEqual({
      checked: 1,
      recoveredServerIds: ["prod-01"],
      failedServerIds: [],
      skippedWhileRefreshing: false
    });
    expect(onRecovered).toHaveBeenCalledWith(["prod-01"]);
  });

  it("keeps failed probes offline and skips recovery checks during a full refresh", async () => {
    const refreshServer = vi.fn();
    const failedProbe = vi.fn(async () => {
      throw new Error("connect failed");
    });
    const failedService = createService({ probe: failedProbe, refreshServer });

    expect(await failedService.checkNow()).toMatchObject({
      checked: 1,
      recoveredServerIds: [],
      failedServerIds: ["prod-01"],
      skippedWhileRefreshing: false
    });
    expect(refreshServer).not.toHaveBeenCalled();

    const skippedProbe = vi.fn(async () => undefined);
    const skippedService = createService({
      probe: skippedProbe,
      refreshServer,
      refreshActive: true
    });
    expect(await skippedService.checkNow()).toMatchObject({
      checked: 0,
      skippedWhileRefreshing: true
    });
    expect(skippedProbe).not.toHaveBeenCalled();
  });

  it("uses the saved interval and reschedules when Settings changes", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => {
      throw new Error("still offline");
    });
    const service = createService({ probe, intervalSeconds: 60 });
    service.start();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    service.updateIntervalSeconds(30);
    expect(service.getIntervalSeconds()).toBe(30);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    service.stop();
  });

  function createService({
    probe = vi.fn(async () => undefined),
    onRecovered,
    refreshServer = vi.fn(async () => null),
    refreshActive = false,
    intervalSeconds = 60
  }: {
    probe?: NonNullable<OfflineRecoveryServiceOptions["probe"]>;
    onRecovered?: OfflineRecoveryServiceOptions["onRecovered"];
    refreshServer?: OfflineRecoveryServiceOptions["refreshService"]["refreshServer"];
    refreshActive?: boolean;
    intervalSeconds?: number;
  } = {}): OfflineRecoveryService {
    return new OfflineRecoveryService({
      db,
      intervalSeconds,
      probe,
      onRecovered,
      refreshService: {
        getState: () => ({
          active: refreshActive,
          nextRefreshAt: null,
          lastRun: null,
          current: null
        }),
        refreshServer
      }
    });
  }
});
