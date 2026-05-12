import { describe, expect, it } from "vitest";
import { CONNECTION_STATUSES, HEALTH_LEVELS, type OverviewResponse } from "../../src/shared/types";

describe("shared monitor contracts", () => {
  it("keeps connection status values stable for API clients", () => {
    expect(CONNECTION_STATUSES).toEqual(["online", "offline", "unknown"]);
  });

  it("keeps health level values stable for API clients", () => {
    expect(HEALTH_LEVELS).toEqual(["healthy", "warning", "dangerous"]);
  });

  it("allows overview responses with macro summary and latest rows", () => {
    const overview: OverviewResponse = {
      generatedAt: "2026-05-12T00:00:00.000Z",
      refresh: {
        active: false,
        nextRefreshAt: "2026-05-12T01:00:00.000Z",
        lastRun: null
      },
      summary: {
        total: 1,
        online: 1,
        offline: 0,
        unknown: 0,
        healthy: 1,
        warning: 0,
        dangerous: 0,
        averageCpu: 12,
        averageMemory: 34,
        averageDisk: 56
      },
      description: "1 server online. All healthy.",
      servers: [
        {
          id: "prod-01",
          name: "Production 01",
          host: "10.0.0.1",
          port: 22,
          enabled: true,
          latest: {
            id: "snap-1",
            serverId: "prod-01",
            collectedAt: "2026-05-12T00:00:00.000Z",
            connectionStatus: "online",
            healthLevel: "healthy",
            cpuUsedPercent: 12,
            memoryUsedPercent: 34,
            diskUsedPercent: 56,
            load1: 0.1,
            load5: 0.2,
            load15: 0.3,
            uptimeSeconds: 3600,
            errorCode: null,
            errorMessage: null,
            cpuModel: "Intel Xeon E5-2686 v4",
            cpuVcores: 4,
            memoryTotalBytes: 8589934592,
            memoryUsedBytes: 2919235584,
            diskTotalBytes: 107374182400,
            diskUsedBytes: 60129542144
          }
        }
      ],
      overallHistory: []
    };

    expect(overview.summary.total).toBe(1);
    expect(overview.servers[0]?.latest?.connectionStatus).toBe("online");
    expect(overview.servers[0]?.latest?.healthLevel).toBe("healthy");
  });
});
