import path from "node:path";
import express from "express";
import { createApp } from "./api";
import { AlertService, alertRefreshIntervalMs } from "./alertService";
import { resolveSshTimeouts } from "../shared/sshSettings";
import { loadAlertSettings, loadRuntimeConfig, loadServerInventory } from "./config";
import { MonitorDatabase } from "./db";
import { RefreshService } from "./refreshService";
import { SolverJobService } from "./solverJobService";
import { loadSolverScenarioLibrary } from "./scenarioLibraryStore";
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
  const remindWeChatContextRefresh = () => {
    void weChatAccounts.sendContextRefreshReminders().then((summary) => {
      if (summary.sent.length > 0) {
        console.log(`Sent WeChat context refresh reminder to ${summary.sent.length} account(s).`);
      }
      if (summary.failed.length > 0) {
        console.error(
          `WeChat context refresh reminder failed for ${summary.failed.length} account(s):\n` +
          summary.failed.map((failure) => `${failure.label}: ${failure.message}`).join("\n")
        );
      }
    }).catch((error: unknown) => {
      console.error("WeChat context refresh reminder check failed", error);
    });
  };
  windowlessTimeout(remindWeChatContextRefresh, 30_000);
  windowlessInterval(remindWeChatContextRefresh, 15 * 60_000);

  const refreshService = new RefreshService({
    db,
    servers,
    intervalMs: alertRefreshIntervalMs(alertSettings, config.refreshIntervalMs),
    credentials: config.ssh,
    pipelineStatusFilePath: config.pipelineStatusFilePath,
    getSshTimeouts: () => resolveSshTimeouts(loadAlertSettings(config.alertSettingsPath)),
    alerts: alertService,
    inventoryPath: config.inventoryPath
  });
  refreshService.startScheduler({ runImmediately: true });

  const solverJobService = new SolverJobService({
    db,
    preflopRangesPath: config.preflopRangesPath,
    credentials: config.ssh,
    defaultPipelineStatusFilePath: config.pipelineStatusFilePath,
    repoNamespace: config.solverJobRepoNamespace,
    hfToken: config.hfToken,
    hfProxyUrl: config.hfProxyUrl,
    solverHfProxyUrl: config.solverHfProxyUrl,
    networkSubscriptionUrl: config.subscriptionUrl,
    giteeUsername: config.giteeUsername,
    giteeToken: config.giteeToken,
    getHfProxySettings: () => loadAlertSettings(config.alertSettingsPath),
    getScenarioLibrary: () => loadSolverScenarioLibrary(config.solverScenarioLibraryPath).scenarios
  });
  windowlessInterval(() => {
    void solverJobService.reconcileAndStartQueuedJobs().catch((error: unknown) => {
      console.error("Solver job queue reconciliation failed", error);
    });
  }, 30_000);

  const app = createApp({
    db,
    refreshService,
    inventoryPath: config.inventoryPath,
    alertSettingsPath: config.alertSettingsPath,
    preflopRangesPath: config.preflopRangesPath,
    solverScenarioLibraryPath: config.solverScenarioLibraryPath,
    solverJobService,
    solverJobRepoNamespace: config.solverJobRepoNamespace,
    hfToken: config.hfToken,
    hfProxyUrl: config.hfProxyUrl,
    solverHfProxyUrl: config.solverHfProxyUrl,
    sshUsername: config.ssh.username,
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

function windowlessInterval(callback: () => void, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  return timer;
}

function windowlessTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}
