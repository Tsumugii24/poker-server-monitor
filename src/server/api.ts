import express, { type Express } from "express";
import type { OverviewResponse, OverviewSummary, ServerDetailResponse } from "../shared/types";
import { loadServerInventory, updateServerInventoryName } from "./config";
import type { MonitorDatabase } from "./db";
import type { RefreshService } from "./refreshService";

export type AppDependencies = {
  db: MonitorDatabase;
  refreshService: RefreshService;
  inventoryPath?: string;
};

export function createApp({ db, refreshService, inventoryPath = "config/servers.json" }: AppDependencies): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/overview", (_request, response) => {
    const servers = db.getServerRows();
    const summary = buildSummary(servers);
    const body: OverviewResponse = {
      generatedAt: new Date().toISOString(),
      refresh: refreshService.getState(),
      summary,
      description: describeOverview(summary),
      servers,
      overallHistory: db.getOverallHistory(24)
    };
    response.json(body);
  });

  app.get("/api/servers", (_request, response) => {
    response.json(db.getServers());
  });

  app.get("/api/servers/:id", (request, response) => {
    const server = db.getServer(request.params.id);
    if (!server) {
      response.status(404).json({ error: "server_not_found" });
      return;
    }

    const body: ServerDetailResponse = {
      server,
      latest: db.getLatestSnapshot(server.id),
      history: db.getServerHistory(server.id, 24)
    };
    response.json(body);
  });

  app.patch("/api/servers/:id", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.name !== "string" || request.body.name.trim() === "") {
      response.status(400).json({ error: "invalid_server_name" });
      return;
    }

    try {
      const updated = updateServerInventoryName(inventoryPath, request.params.id, request.body.name);
      db.syncServers(loadServerInventory(inventoryPath));
      response.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        response.status(404).json({ error: "server_not_found" });
        return;
      }
      if (/name must be/i.test(message)) {
        response.status(400).json({ error: "invalid_server_name" });
        return;
      }
      response.status(500).json({ error: "inventory_update_failed", message });
    }
  });

  app.get("/api/servers/:id/history", (request, response) => {
    const server = db.getServer(request.params.id);
    if (!server) {
      response.status(404).json({ error: "server_not_found" });
      return;
    }
    const hours = Number(request.query.hours ?? 24);
    const body: ServerDetailResponse = {
      server,
      latest: db.getLatestSnapshot(server.id),
      history: db.getServerHistory(server.id, Number.isFinite(hours) ? hours : 24)
    };
    response.json(body);
  });

  app.post("/api/refresh", async (_request, response) => {
    const result = await refreshService.refreshAll("manual");
    response.status(result.accepted ? 202 : 409).json(result);
  });

  app.get("/api/refresh/current", (_request, response) => {
    response.json(refreshService.getState());
  });

  return app;
}

function buildSummary(servers: ReturnType<MonitorDatabase["getServerRows"]>): OverviewSummary {
  const latest = servers.map((server) => server.latest);
  const onlineSnapshots = latest.filter((s) => s?.connectionStatus === "online");

  return {
    total: servers.length,
    // Connectivity
    online: onlineSnapshots.length,
    offline: latest.filter((s) => s?.connectionStatus === "offline").length,
    unknown: latest.filter((s) => !s || s.connectionStatus === "unknown").length,
    // Health (among online servers)
    healthy: onlineSnapshots.filter((s) => s?.healthLevel === "healthy").length,
    warning: onlineSnapshots.filter((s) => s?.healthLevel === "warning").length,
    dangerous: onlineSnapshots.filter((s) => s?.healthLevel === "dangerous").length,
    // Averages (among online servers)
    averageCpu: average(onlineSnapshots.map((s) => s?.cpuUsedPercent ?? null)),
    averageMemory: average(onlineSnapshots.map((s) => s?.memoryUsedPercent ?? null)),
    averageDisk: average(onlineSnapshots.map((s) => s?.diskUsedPercent ?? null))
  };
}

function describeOverview(summary: OverviewSummary): string {
  const connectivity = `${summary.online} of ${summary.total} servers online`;
  const healthIssues: string[] = [];
  if (summary.warning > 0) healthIssues.push(`${summary.warning} warning`);
  if (summary.dangerous > 0) healthIssues.push(`${summary.dangerous} dangerous`);
  const health = healthIssues.length > 0 ? healthIssues.join(", ") : "all healthy";
  const offline = summary.offline > 0 ? `${summary.offline} offline` : "none offline";
  return `${connectivity}; ${health}; ${offline}.`;
}

function average(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
