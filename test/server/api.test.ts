import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MetricSnapshot, ServerConfig } from "../../src/shared/types";
import { createApp } from "../../src/server/api";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";

const servers: ServerConfig[] = [
  { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true }
];

function snapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id: "snap-1",
    serverId: "prod-01",
    collectedAt: new Date().toISOString(),
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
    cpuModel: "Intel Xeon E5-2686 v4",
    cpuVcores: 4,
    memoryTotalBytes: 8589934592,
    memoryUsedBytes: 2576980378,
    diskTotalBytes: 107374182400,
    diskUsedBytes: 42949672960,
    ...overrides
  };
}

describe("monitor API", () => {
  let db: MonitorDatabase;
  let service: RefreshService;
  let tempDir: string;
  let inventoryPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-api-"));
    inventoryPath = path.join(tempDir, "servers.json");
    fs.writeFileSync(inventoryPath, JSON.stringify(servers));
    db = await MonitorDatabase.createInMemory();
    db.syncServers(servers);
    db.insertSnapshot(snapshot());
    service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async () => ({
        ...snapshot(),
        id: crypto.randomUUID(),
        collectedAt: new Date().toISOString()
      })
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns overview data with summary and latest server rows", async () => {
    const response = await request(createApp({ db, refreshService: service })).get("/api/overview");

    expect(response.status).toBe(200);
    expect(response.body.summary.total).toBe(1);
    expect(response.body.servers[0].latest.connectionStatus).toBe("online");
    expect(response.body.servers[0].latest.healthLevel).toBe("healthy");
    expect(response.body.description).toContain("1 of 1 servers online");
  });

  it("counts warning-health servers as online in the overview connectivity total", async () => {
    const warningServer: ServerConfig = {
      id: "prod-02",
      name: "Production 02",
      host: "10.0.0.2",
      port: 22,
      enabled: true
    };
    db.syncServers([...servers, warningServer]);
    db.insertSnapshot(snapshot({
      id: "snap-2",
      serverId: "prod-02",
      connectionStatus: "online",
      healthLevel: "warning",
      cpuUsedPercent: 85
    }));

    const response = await request(createApp({ db, refreshService: service })).get("/api/overview");

    expect(response.status).toBe(200);
    expect(response.body.summary.online).toBe(2);
    expect(response.body.summary.warning).toBe(1);
    expect(response.body.summary.healthy).toBe(1);
    expect(response.body.description).toContain("2 of 2 servers online");
  });

  it("returns server detail and history", async () => {
    const response = await request(createApp({ db, refreshService: service })).get(
      "/api/servers/prod-01/history?hours=24"
    );

    expect(response.status).toBe(200);
    expect(response.body.server.id).toBe("prod-01");
    expect(response.body.history).toHaveLength(1);
  });

  it("triggers a manual refresh", async () => {
    const response = await request(createApp({ db, refreshService: service })).post("/api/refresh");

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
  });

  it("updates a server name in the inventory file and database", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .patch("/api/servers/prod-01")
      .send({ name: "Main Poker Node" });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe("Main Poker Node");
    expect(db.getServer("prod-01")?.name).toBe("Main Poker Node");
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))[0].name).toBe("Main Poker Node");
  });

  it("rejects empty server name updates", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .patch("/api/servers/prod-01")
      .send({ name: " " });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_server_name");
  });
});
