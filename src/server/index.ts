import path from "node:path";
import express from "express";
import { createApp } from "./api";
import { AlertService, alertRefreshIntervalMs } from "./alertService";
import { resolveSshTimeouts } from "../shared/sshSettings";
import { loadAlertSettings, loadRuntimeConfig, loadServerInventory } from "./config";
import { MonitorDatabase } from "./db";
import { RefreshService } from "./refreshService";
import { WeChatAccountManager } from "./wechatAccountManager";
import { WeChatNotifier } from "./wechatNotifier";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const servers = loadServerInventory(config.inventoryPath);
  const db = await MonitorDatabase.open(config.databasePath);
  db.syncServers(servers);
  const legacyNotifier = new WeChatNotifier();
  const weChatAccounts = new WeChatAccountManager({
    alertSettingsPath: config.alertSettingsPath
  });
  const sendWeChatTarget = async (message: string, targetId: string) => {
    const settings = loadAlertSettings(config.alertSettingsPath);
    const account = settings.wechatAccounts.find((candidate) => candidate.id === targetId);
    if (account) {
      await weChatAccounts.sendToAccount(account.id, message);
      return;
    }

    const status = legacyNotifier.getStatus(settings.enabled ? settings.wechatRoomId : "");
    if (!status.loggedIn) {
      throw new Error("WeChat bot is not logged in yet.");
    }
    await legacyNotifier.send(message, targetId);
  };
  const alertService = new AlertService({
    getSettings: () => loadAlertSettings(config.alertSettingsPath),
    send: sendWeChatTarget
  });
  const alertSettings = loadAlertSettings(config.alertSettingsPath);
  if (alertSettings.enabled) {
    if (alertSettings.wechatAccounts.length > 0) {
      weChatAccounts.startEnabledAccounts();
    } else {
      legacyNotifier.startInBackground();
    }
  }

  const refreshService = new RefreshService({
    db,
    servers,
    intervalMs: alertRefreshIntervalMs(alertSettings, config.refreshIntervalMs),
    credentials: config.ssh,
    pipelineStatusFilePath: config.pipelineStatusFilePath,
    getSshTimeouts: () => resolveSshTimeouts(loadAlertSettings(config.alertSettingsPath)),
    alerts: alertService
  });
  refreshService.startScheduler({ runImmediately: true });

  const app = createApp({
    db,
    refreshService,
    inventoryPath: config.inventoryPath,
    alertSettingsPath: config.alertSettingsPath,
    defaultRefreshIntervalMs: config.refreshIntervalMs,
    sendTestAlert: sendWeChatTarget,
    startAlertConnector: () => legacyNotifier.ensureStarted(),
    restartAlertConnector: () => legacyNotifier.restartLogin(),
    refreshWeChatConnector: () => legacyNotifier.refreshLoginQr(),
    restoreAlertConnector: () => legacyNotifier.restoreSession(),
    logoutWeChatConnector: () => legacyNotifier.logout(),
    switchWeChatConnector: () => legacyNotifier.switchAccount(),
    getWeChatStatus: () => {
      const settings = loadAlertSettings(config.alertSettingsPath);
      return legacyNotifier.getStatus(settings.enabled ? settings.wechatRoomId : "");
    },
    getWeChatAccountsStatus: () => weChatAccounts.getAccountsStatus(),
    createWeChatAccount: (label) => weChatAccounts.createAccount(label),
    refreshWeChatAccountQr: (accountId) => weChatAccounts.refreshQr(accountId),
    restoreWeChatAccount: (accountId) => weChatAccounts.restoreAccount(accountId),
    logoutWeChatAccount: (accountId) => weChatAccounts.logoutAccount(accountId),
    removeWeChatAccount: (accountId) => weChatAccounts.removeAccount(accountId),
    updateWeChatAccount: (accountId, patch) => weChatAccounts.updateAccount(accountId, patch),
    verifyWeChatAccount: (accountId, targetUserId) => weChatAccounts.verifyAccount(accountId, targetUserId)
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
