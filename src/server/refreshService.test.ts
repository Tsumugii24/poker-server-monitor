import { beforeEach, describe, expect, it } from "vitest";
import type { MetricSnapshot, ServerConfig } from "../shared/types";
import { MonitorDatabase } from "./db";
import { RefreshService } from "./refreshService";

const servers: ServerConfig[] = [
  { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
  { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 22, enabled: true }
];

function metric(serverId: string, status: MetricSnapshot["status"]): MetricSnapshot {
  return {
    id: `${serverId}-${status}`,
    serverId,
    collectedAt: new Date().toISOString(),
    status,
    cpuUsedPercent: status === "offline" ? null : 20,
    memoryUsedPercent: status === "offline" ? null : 30,
    diskUsedPercent: status === "offline" ? null : 40,
    load1: status === "offline" ? null : 0.1,
    load5: status === "offline" ? null : 0.2,
    load15: status === "offline" ? null : 0.3,
    uptimeSeconds: status === "offline" ? null : 3600,
    errorCode: status === "offline" ? "connect_failed" : null,
    errorMessage: status === "offline" ? "Connection failed" : null
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
      collect: async (server) => metric(server.id, server.id === "prod-01" ? "online" : "warning")
    });

    const response = await service.refreshAll("manual");

    expect(response.accepted).toBe(true);
    expect(db.getServerRows().map((row) => row.latest?.status)).toEqual(["online", "warning"]);
    expect(db.getLastRefreshRun()).toMatchObject({
      status: "completed",
      successCount: 1,
      warningCount: 1,
      failureCount: 0
    });
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
