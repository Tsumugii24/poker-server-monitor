import path from "node:path";
import express from "express";
import { createApp } from "./api";
import { AlertService } from "./alertService";
import { loadAlertSettings, loadRuntimeConfig, loadServerInventory } from "./config";
import { MonitorDatabase } from "./db";
import { RefreshService } from "./refreshService";
import { WeChatNotifier } from "./wechatNotifier";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const servers = loadServerInventory(config.inventoryPath);
  const db = await MonitorDatabase.open(config.databasePath);
  db.syncServers(servers);
  const notifier = new WeChatNotifier();
  const alertService = new AlertService({
    getSettings: () => loadAlertSettings(config.alertSettingsPath),
    send: (message, roomId) => notifier.send(message, roomId)
  });
  const alertSettings = loadAlertSettings(config.alertSettingsPath);
  if (alertSettings.enabled) {
    await notifier.ensureStarted();
  }

  const refreshService = new RefreshService({
    db,
    servers,
    intervalMs: config.refreshIntervalMs,
    credentials: config.ssh,
    pipelineStatusFilePath: config.pipelineStatusFilePath,
    alerts: alertService
  });
  refreshService.startScheduler({ runImmediately: true });

  const app = createApp({
    db,
    refreshService,
    inventoryPath: config.inventoryPath,
    alertSettingsPath: config.alertSettingsPath,
    sendTestAlert: (message, roomId) => notifier.send(message, roomId),
    startAlertConnector: () => notifier.ensureStarted(),
    getWeChatStatus: () => notifier.getStatus()
  });
  const clientDist = path.resolve("dist/client");
  app.use(express.static(clientDist));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientDist, "index.html"));
  });

  app.listen(config.port, config.host, () => {
    console.log(`Server monitor listening on http://${config.host}:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
