import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MetricSnapshot, ServerConfig } from "../shared/types";
import { MonitorDatabase } from "./db";

const servers: ServerConfig[] = [
  {
    id: "prod-01",
    name: "Production 01",
    host: "10.0.0.1",
    port: 22,
    group: "production",
    enabled: true
  },
  {
    id: "prod-02",
    name: "Production 02",
    host: "10.0.0.2",
    port: 2222,
    enabled: true
  }
];

function snapshot(
  serverId: string,
  collectedAt: string,
  status: MetricSnapshot["status"] = "online"
): MetricSnapshot {
  return {
    id: `${serverId}-${collectedAt}`,
    serverId,
    collectedAt,
    status,
    cpuUsedPercent: status === "offline" ? null : 20,
    memoryUsedPercent: status === "offline" ? null : 40,
    diskUsedPercent: status === "offline" ? null : 60,
    load1: status === "offline" ? null : 0.1,
    load5: status === "offline" ? null : 0.2,
    load15: status === "offline" ? null : 0.3,
    uptimeSeconds: status === "offline" ? null : 3600,
    errorCode: status === "offline" ? "connect_failed" : null,
    errorMessage: status === "offline" ? "Connection failed" : null
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
    expect(rows[0]?.latest?.status).toBe("online");
    expect(rows[1]?.latest?.errorCode).toBe("connect_failed");
  });

  it("removes servers that are no longer present in config inventory", () => {
    db.syncServers(servers);
    db.syncServers([servers[0]!]);

    expect(db.getServers().map((server) => server.id)).toEqual(["prod-01"]);
  });

  it("returns per-server history sorted by collection time", () => {
    db.syncServers(servers);
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T01:00:00.000Z"));
    db.insertSnapshot(snapshot("prod-01", "2026-05-12T00:00:00.000Z", "warning"));

    const history = db.getServerHistory("prod-01", 24, "2026-05-12T02:00:00.000Z");

    expect(history.map((item) => item.status)).toEqual(["warning", "online"]);
  });

  it("prunes metric snapshots older than 24 hours", () => {
    db.syncServers(servers);
    db.insertSnapshot(snapshot("prod-01", "2026-05-10T23:59:59.000Z"));
    db.insertSnapshot(snapshot("prod-01", "2026-05-11T00:00:01.000Z"));

    db.pruneSnapshots(24, "2026-05-12T00:00:00.000Z");

    expect(db.getServerHistory("prod-01", 48, "2026-05-12T00:00:00.000Z")).toHaveLength(1);
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
});
