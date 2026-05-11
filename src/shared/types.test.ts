import { describe, expect, it } from "vitest";
import { SERVER_STATUSES, type OverviewResponse } from "./types";

describe("shared monitor contracts", () => {
  it("keeps server status values stable for API clients", () => {
    expect(SERVER_STATUSES).toEqual(["online", "warning", "offline", "unknown"]);
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
        warning: 0,
        offline: 0,
        unknown: 0,
        averageCpu: 12,
        averageMemory: 34,
        averageDisk: 56
      },
      description: "1 server online. No warnings.",
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
            status: "online",
            cpuUsedPercent: 12,
            memoryUsedPercent: 34,
            diskUsedPercent: 56,
            load1: 0.1,
            load5: 0.2,
            load15: 0.3,
            uptimeSeconds: 3600,
            errorCode: null,
            errorMessage: null
          }
        }
      ],
      overallHistory: []
    };

    expect(overview.summary.total).toBe(1);
    expect(overview.servers[0]?.latest?.status).toBe("online");
  });
});
