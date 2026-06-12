import express, { type Express } from "express";
import type {
  AlertSettings,
  OverviewResponse,
  OverviewSummary,
  ServerDetailResponse,
  WeChatConnectorStatus
} from "../shared/types";
import { loadAlertSettings, loadServerInventory, saveAlertSettings, updateServerInventoryNote } from "./config";
import { formatTestAlertMessage } from "./alertService";
import type { MonitorDatabase } from "./db";
import type { RefreshService } from "./refreshService";

export type AppDependencies = {
  db: MonitorDatabase;
  refreshService: RefreshService;
  inventoryPath?: string;
  alertSettingsPath?: string;
  sendTestAlert?: (message: string, roomId: string) => Promise<void> | void;
  startAlertConnector?: () => Promise<void> | void;
  getWeChatStatus?: () => WeChatConnectorStatus;
};

export function createApp({
  db,
  refreshService,
  inventoryPath = "config/servers.json",
  alertSettingsPath = "config/alerts.json",
  sendTestAlert,
  startAlertConnector,
  getWeChatStatus
}: AppDependencies): Express {
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
      pipeline: db.getLatestPipelineSnapshot(server.id),
      pipelineHistory: db.getPipelineHistory(server.id, 24),
      history: db.getServerHistory(server.id, 24)
    };
    response.json(body);
  });

  app.patch("/api/servers/:id", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.note !== "string" || request.body.note.trim() === "") {
      response.status(400).json({ error: "invalid_server_note" });
      return;
    }

    try {
      const updated = updateServerInventoryNote(inventoryPath, request.params.id, request.body.note);
      db.syncServers(loadServerInventory(inventoryPath));
      response.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        response.status(404).json({ error: "server_not_found" });
        return;
      }
      if (/note must be/i.test(message)) {
        response.status(400).json({ error: "invalid_server_note" });
        return;
      }
      response.status(500).json({ error: "inventory_update_failed", message });
    }
  });

  app.get("/api/settings/alerts", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json({
      settings,
      status: alertStatus(settings)
    });
  });

  app.patch("/api/settings/alerts", (request, response) => {
    if (!isAlertSettingsInput(request.body)) {
      response.status(400).json({ error: "invalid_alert_settings" });
      return;
    }

    try {
      const settings = saveAlertSettings(alertSettingsPath, request.body);
      if (settings.enabled) {
        void Promise.resolve(startAlertConnector?.()).catch((error: unknown) => {
          console.error("Alert connector startup failed", error);
        });
      }
      response.json({
        settings,
        status: alertStatus(settings)
      });
    } catch (error) {
      response.status(400).json({
        error: "invalid_alert_settings",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/alerts/test", async (request, response) => {
    if (!isAlertSettingsInput(request.body)) {
      response.status(400).json({ error: "invalid_alert_settings" });
      return;
    }

    try {
      const settings = saveAlertSettings(alertSettingsPath, request.body);
      if (!settings.enabled || settings.wechatRoomId.trim() === "") {
        response.status(400).json({ error: "alert_not_configured" });
        return;
      }

      await sendTestAlert?.(formatTestAlertMessage(settings.language), settings.wechatRoomId);
      response.status(202).json({ accepted: true, status: alertStatus(settings) });
    } catch (error) {
      response.status(500).json({
        error: "alert_test_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/settings/wechat", (_request, response) => {
    response.json(getWeChatStatus?.() ?? defaultWeChatStatus());
  });

  app.post("/api/settings/wechat/start", (_request, response) => {
    void Promise.resolve(startAlertConnector?.()).catch((error: unknown) => {
      console.error("WeChat connector startup failed", error);
    });
    response.status(202).json(getWeChatStatus?.() ?? defaultWeChatStatus());
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
      pipeline: db.getLatestPipelineSnapshot(server.id),
      pipelineHistory: db.getPipelineHistory(server.id, Number.isFinite(hours) ? hours : 24),
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
  const onlineServerIds = new Set(
    servers.filter((server) => server.latest?.connectionStatus === "online").map((server) => server.id)
  );
  const onlinePipelines = servers
    .filter((server) => onlineServerIds.has(server.id))
    .map((server) => server.pipeline);

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
    averageDisk: average(onlineSnapshots.map((s) => s?.diskUsedPercent ?? null)),
    pipelineRunning: onlinePipelines.filter((pipeline) =>
      pipeline != null &&
      (pipeline.displayStatus === "running" ||
        pipeline.displayStatus === "solving" ||
        pipeline.displayStatus === "uploading" ||
        pipeline.displayStatus === "cleanup")
    ).length,
    pipelineIdle: onlinePipelines.filter((pipeline) => pipeline?.displayStatus === "idle").length,
    pipelineStale: onlinePipelines.filter((pipeline) => pipeline?.displayStatus === "stale").length
  };
}

function describeOverview(summary: OverviewSummary): string {
  const connectivity = `${summary.online} of ${summary.total} servers online`;
  const healthIssues: string[] = [];
  if (summary.warning > 0) healthIssues.push(`${summary.warning} warning`);
  if (summary.dangerous > 0) healthIssues.push(`${summary.dangerous} dangerous`);
  const health = healthIssues.length > 0 ? healthIssues.join(", ") : "all healthy";
  const offline = summary.offline > 0 ? `${summary.offline} offline` : "none offline";
  const pipelineParts: string[] = [];
  if (summary.pipelineRunning > 0) pipelineParts.push(`${summary.pipelineRunning} task running`);
  if (summary.pipelineStale > 0) pipelineParts.push(`${summary.pipelineStale} stale task`);
  const pipeline = pipelineParts.length > 0 ? pipelineParts.join(", ") : "no active tasks";
  return `${connectivity}; ${health}; ${offline}; ${pipeline}.`;
}

function average(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAlertSettingsInput(value: unknown): value is AlertSettings {
  return isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.wechatRoomId === "string" &&
    typeof value.cooldownMinutes === "number" &&
    Number.isFinite(value.cooldownMinutes) &&
    (value.language === "en" || value.language === "zh");
}

function alertStatus(settings: AlertSettings): { enabled: boolean; configured: boolean } {
  return {
    enabled: settings.enabled,
    configured: settings.wechatRoomId.trim() !== ""
  };
}

function defaultWeChatStatus(): WeChatConnectorStatus {
  return {
    started: false,
    loggedIn: false,
    polling: false,
    qrUrl: null,
    lastError: null,
    messageCount: 0,
    lastMessageAt: null,
    recentChats: []
  };
}
