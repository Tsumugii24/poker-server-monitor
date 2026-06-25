import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import type {
  AlertSettings,
  OverviewResponse,
  OverviewSummary,
  ServerDetailResponse,
  WeChatConnectorStatus,
  WeChatRecipient
} from "../shared/types";
import { loadAlertSettings, loadServerInventory, saveAlertSettings, updateServerInventoryNote } from "./config";
import { formatTestAlertMessage, alertRefreshIntervalMs } from "./alertService";
import type { MonitorDatabase } from "./db";
import type { RefreshService } from "./refreshService";
import { buildWeChatDelivery } from "../shared/wechatDelivery";
import { defaultWeChatStoredSession } from "../shared/wechatSession";

export type AppDependencies = {
  db: MonitorDatabase;
  refreshService: RefreshService;
  inventoryPath?: string;
  alertSettingsPath?: string;
  defaultRefreshIntervalMs?: number;
  sendTestAlert?: (message: string, roomId: string) => Promise<void> | void;
  startAlertConnector?: () => Promise<void> | void;
  restartAlertConnector?: () => Promise<void> | void;
  restoreAlertConnector?: () => Promise<void> | void;
  logoutWeChatConnector?: () => Promise<void> | void;
  switchWeChatConnector?: () => Promise<void> | void;
  getWeChatStatus?: () => WeChatConnectorStatus;
};

export function createApp({
  db,
  refreshService,
  inventoryPath = "config/servers.json",
  alertSettingsPath = "config/alerts.json",
  defaultRefreshIntervalMs = 3_600_000,
  sendTestAlert,
  startAlertConnector,
  restartAlertConnector,
  restoreAlertConnector,
  logoutWeChatConnector,
  switchWeChatConnector,
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
      refreshService.updateScheduleInterval(alertRefreshIntervalMs(settings, defaultRefreshIntervalMs));
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
      if (!settings.enabled || !settings.wechatRecipients.some((r) => r.enabled)) {
        response.status(400).json({ error: "alert_not_configured" });
        return;
      }

      await sendTestAlert?.(formatTestAlertMessage(settings.language), settings.wechatRoomId);
      response.status(202).json({
        accepted: true,
        status: alertStatus(settings),
        wechat: getWeChatStatus?.() ?? defaultWeChatStatus(settings.wechatRoomId)
      });
    } catch (error) {
      response.status(500).json({
        error: "alert_test_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/settings/wechat", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json(getWeChatStatus?.() ?? defaultWeChatStatus(settings.enabled ? settings.wechatRoomId : ""));
  });

  app.post("/api/settings/wechat/start", (_request, response) => {
    void Promise.resolve(restartAlertConnector?.() ?? startAlertConnector?.()).catch((error: unknown) => {
      console.error("WeChat connector startup failed", error);
    });
    response.status(202).json({ accepted: true });
  });

  app.post("/api/settings/wechat/restore", async (_request, response) => {
    try {
      await Promise.resolve(restoreAlertConnector?.());
      const settings = loadAlertSettings(alertSettingsPath);
      response.json(getWeChatStatus?.() ?? defaultWeChatStatus(settings.enabled ? settings.wechatRoomId : ""));
    } catch (error) {
      response.status(500).json({
        error: "wechat_restore_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/wechat/logout", async (_request, response) => {
    try {
      await Promise.resolve(logoutWeChatConnector?.());
      const settings = loadAlertSettings(alertSettingsPath);
      response.json(getWeChatStatus?.() ?? defaultWeChatStatus(settings.enabled ? settings.wechatRoomId : ""));
    } catch (error) {
      response.status(500).json({
        error: "wechat_logout_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/wechat/switch", (_request, response) => {
    void Promise.resolve(switchWeChatConnector?.()).catch((error: unknown) => {
      console.error("WeChat account switch failed", error);
    });
    response.status(202).json({ accepted: true });
  });

  // ── Recipient management ──────────────────────────────────────

  app.get("/api/settings/alerts/recipients", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json({ recipients: settings.wechatRecipients });
  });

  app.post("/api/settings/alerts/recipients", (request, response) => {
    if (!isRecord(request.body) ||
        typeof request.body.contactId !== "string" ||
        request.body.contactId.trim() === "") {
      response.status(400).json({ error: "invalid_recipient", message: "contactId is required" });
      return;
    }

    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const contactId = (request.body.contactId as string).trim();
      const label = typeof request.body.label === "string" ? request.body.label.trim() : contactId;

      // Check for duplicate contactId
      if (settings.wechatRecipients.some((r) => r.contactId === contactId)) {
        response.status(409).json({ error: "duplicate_recipient", message: `Recipient ${contactId} already exists` });
        return;
      }

      const newRecipient: WeChatRecipient = {
        id: randomUUID(),
        contactId,
        label,
        enabled: true,
        addedAt: new Date().toISOString()
      };

      settings.wechatRecipients.push(newRecipient);
      // Sync legacy field
      const firstEnabled = settings.wechatRecipients.find((r) => r.enabled);
      settings.wechatRoomId = firstEnabled?.contactId ?? "";

      const saved = saveAlertSettings(alertSettingsPath, settings);
      response.status(201).json({ recipient: newRecipient, settings: saved, status: alertStatus(saved) });
    } catch (error) {
      response.status(500).json({
        error: "recipient_add_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.patch("/api/settings/alerts/recipients/:id", (request, response) => {
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }

    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const recipient = settings.wechatRecipients.find((r) => r.id === request.params.id);
      if (!recipient) {
        response.status(404).json({ error: "recipient_not_found" });
        return;
      }

      if (typeof request.body.enabled === "boolean") {
        recipient.enabled = request.body.enabled;
      }
      if (typeof request.body.label === "string") {
        recipient.label = request.body.label.trim();
      }

      // Sync legacy field
      const firstEnabled = settings.wechatRecipients.find((r) => r.enabled);
      settings.wechatRoomId = firstEnabled?.contactId ?? "";

      const saved = saveAlertSettings(alertSettingsPath, settings);
      response.json({ recipient, settings: saved, status: alertStatus(saved) });
    } catch (error) {
      response.status(500).json({
        error: "recipient_update_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.delete("/api/settings/alerts/recipients/:id", (request, response) => {
    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const index = settings.wechatRecipients.findIndex((r) => r.id === request.params.id);
      if (index === -1) {
        response.status(404).json({ error: "recipient_not_found" });
        return;
      }

      settings.wechatRecipients.splice(index, 1);
      // Sync legacy field
      const firstEnabled = settings.wechatRecipients.find((r) => r.enabled);
      settings.wechatRoomId = firstEnabled?.contactId ?? "";

      const saved = saveAlertSettings(alertSettingsPath, settings);
      response.json({ settings: saved, status: alertStatus(saved) });
    } catch (error) {
      response.status(500).json({
        error: "recipient_delete_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/alerts/test/:recipientId", async (request, response) => {
    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const recipient = settings.wechatRecipients.find((r) => r.id === request.params.recipientId);
      if (!recipient) {
        response.status(404).json({ error: "recipient_not_found" });
        return;
      }

      await sendTestAlert?.(formatTestAlertMessage(settings.language), recipient.contactId);
      response.status(202).json({
        accepted: true,
        recipientId: recipient.id,
        status: alertStatus(settings),
        wechat: getWeChatStatus?.() ?? defaultWeChatStatus(recipient.contactId)
      });
    } catch (error) {
      response.status(500).json({
        error: "alert_test_failed",
        message: error instanceof Error ? error.message : String(error)
      });
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
  if (!isRecord(value)) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (typeof value.cooldownMinutes !== "number" || !Number.isFinite(value.cooldownMinutes)) return false;
  if (value.language !== "en" && value.language !== "zh") return false;
  if (
    value.sshCommandTimeoutSeconds != null &&
    (typeof value.sshCommandTimeoutSeconds !== "number" || !Number.isFinite(value.sshCommandTimeoutSeconds))
  ) {
    return false;
  }
  if (
    value.sshConnectTimeoutSeconds != null &&
    (typeof value.sshConnectTimeoutSeconds !== "number" || !Number.isFinite(value.sshConnectTimeoutSeconds))
  ) {
    return false;
  }
  // wechatRoomId is optional now (derived from recipients), but accept it for backward compat
  if (value.wechatRoomId != null && typeof value.wechatRoomId !== "string") return false;
  // wechatRecipients is optional in input (config normalizer handles it)
  if (value.wechatRecipients != null && !Array.isArray(value.wechatRecipients)) return false;
  return true;
}

function alertStatus(settings: AlertSettings): { enabled: boolean; configured: boolean } {
  return {
    enabled: settings.enabled,
    configured: settings.wechatRecipients.some((r) => r.enabled)
  };
}

function defaultWeChatStatus(alertTargetUserId = ""): WeChatConnectorStatus {
  const configuredTarget = alertTargetUserId.trim();
  return {
    started: false,
    loggedIn: false,
    polling: false,
    ready: false,
    qrUrl: null,
    awaitingQr: false,
    botUserId: null,
    storedSession: defaultWeChatStoredSession(),
    lastError: null,
    messageCount: 0,
    lastMessageAt: null,
    recentChats: [],
    target: configuredTarget
      ? {
          userId: configuredTarget,
          lastInboundAt: null,
          lastSendSuccessAt: null,
          lastSendFailureAt: null,
          lastSendFailureCode: null
        }
      : null,
    delivery: buildWeChatDelivery({
      alertsConfigured: configuredTarget.length > 0,
      started: false,
      loggedIn: false,
      polling: false,
      ready: false,
      qrUrl: null,
      awaitingQr: false,
      lastError: null,
      target: configuredTarget
        ? {
            userId: configuredTarget,
            lastInboundAt: null,
            lastSendSuccessAt: null,
            lastSendFailureAt: null,
            lastSendFailureCode: null
          }
        : null
    })
  };
}
