import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AlertSettings,
  WeChatAccount,
  WeChatAccountConnectorStatus,
  WeChatAccountsStatus
} from "../shared/types";
import { loadAlertSettings, saveAlertSettings } from "./config";
import { WeChatNotifier } from "./wechatNotifier";

export type WeChatAccountManagerOptions = {
  alertSettingsPath: string;
  storageRoot?: string;
  notifierFactory?: (storageDir: string) => ManagedWeChatNotifier;
};

export type UpdateWeChatAccountInput = {
  label?: string;
  enabled?: boolean;
};

type ManagedWeChatNotifier = Pick<
  WeChatNotifier,
  | "restartLogin"
  | "refreshLoginQr"
  | "restoreSession"
  | "logout"
  | "startInBackground"
  | "ensureStarted"
  | "send"
  | "getStatus"
>;

export class WeChatAccountManager {
  private readonly storageRoot: string;
  private readonly notifiers = new Map<string, ManagedWeChatNotifier>();
  private activeLoginAccountId: string | null = null;

  constructor(private readonly options: WeChatAccountManagerOptions) {
    this.storageRoot = path.resolve(options.storageRoot ?? "data/wechat-accounts");
  }

  getAccountsStatus(): WeChatAccountsStatus {
    const settings = this.loadSettings();
    return this.buildStatus(settings);
  }

  async createAccount(label?: string): Promise<WeChatAccountConnectorStatus> {
    const settings = this.loadSettings();
    const now = new Date().toISOString();
    const account: WeChatAccount = {
      id: randomUUID(),
      label: label?.trim() || `WeChat ${settings.wechatAccounts.length + 1}`,
      enabled: true,
      addedAt: now,
      botUserId: null,
      alertTargetUserId: null
    };

    settings.wechatAccounts.push(account);
    this.saveSettings(settings);
    this.activeLoginAccountId = account.id;
    await this.getNotifier(account.id).restartLogin();
    return this.getAccountStatus(account.id);
  }

  async refreshQr(accountId: string): Promise<WeChatAccountConnectorStatus> {
    this.ensureAccount(accountId);
    this.activeLoginAccountId = accountId;
    await this.getNotifier(accountId).refreshLoginQr();
    return this.getAccountStatus(accountId);
  }

  async restoreAccount(accountId: string): Promise<WeChatAccountConnectorStatus> {
    this.ensureAccount(accountId);
    await this.getNotifier(accountId).restoreSession();
    return this.getAccountStatus(accountId);
  }

  async logoutAccount(accountId: string): Promise<WeChatAccountConnectorStatus> {
    this.ensureAccount(accountId);
    await this.getNotifier(accountId).logout();
    const settings = this.updateAccountRecord(accountId, (account) => ({
      ...account,
      botUserId: null,
      alertTargetUserId: null
    }));
    this.clearActiveLogin(accountId);
    return this.buildAccountStatus(this.mustFindAccount(settings, accountId));
  }

  async removeAccount(accountId: string): Promise<WeChatAccountsStatus> {
    this.ensureAccount(accountId);
    const notifier = this.notifiers.get(accountId);
    if (notifier) {
      await notifier.logout().catch(() => undefined);
      this.notifiers.delete(accountId);
    }

    const settings = this.loadSettings();
    settings.wechatAccounts = settings.wechatAccounts.filter((account) => account.id !== accountId);
    this.saveSettings(settings);
    this.clearActiveLogin(accountId);
    return this.buildStatus(settings);
  }

  updateAccount(accountId: string, patch: UpdateWeChatAccountInput): WeChatAccountConnectorStatus {
    const settings = this.updateAccountRecord(accountId, (account) => ({
      ...account,
      label: patch.label == null ? account.label : patch.label.trim() || account.label,
      enabled: patch.enabled == null ? account.enabled : patch.enabled
    }));
    return this.buildAccountStatus(this.mustFindAccount(settings, accountId));
  }

  verifyAccount(accountId: string, targetUserId?: string): WeChatAccountConnectorStatus {
    const account = this.ensureAccount(accountId);
    const connector = this.getNotifier(accountId).getStatus(account.alertTargetUserId ?? "");
    if (!connector.loggedIn) {
      throw new Error("WeChat account must be logged in before verification");
    }

    const selectedTarget = targetUserId?.trim() ||
      connector.recentChats[0]?.userId ||
      connector.storedSession.contextUserIds[0];
    if (!selectedTarget) {
      throw new Error("No inbound WeChat message found. Send any message from this account, then verify again.");
    }
    const targetObserved = connector.recentChats.some((chat) => chat.userId === selectedTarget) ||
      connector.storedSession.contextUserIds.includes(selectedTarget);
    if (!targetObserved) {
      throw new Error("Selected WeChat contact has no cached context token. Send a fresh message, then verify again.");
    }

    const botUserId = connector.botUserId ?? connector.storedSession.botUserId ?? account.botUserId;
    const duplicate = findDuplicateAccount(this.loadSettings(), accountId, [
      selectedTarget,
      botUserId
    ]);
    if (duplicate) {
      throw new Error(`WeChat contact ${selectedTarget} is already configured as ${duplicate.label}.`);
    }

    const settings = this.updateAccountRecord(accountId, (current) => ({
      ...current,
      botUserId: botUserId ?? current.botUserId,
      alertTargetUserId: selectedTarget,
      label: current.label || botUserId || selectedTarget
    }));
    return this.buildAccountStatus(this.mustFindAccount(settings, accountId));
  }

  startEnabledAccounts(): void {
    const settings = this.loadSettings();
    for (const account of settings.wechatAccounts) {
      if (!account.enabled || (!account.botUserId && !account.alertTargetUserId)) {
        continue;
      }
      this.getNotifier(account.id).startInBackground();
    }
  }

  async sendToAccount(accountId: string, message: string): Promise<void> {
    const account = this.ensureAccount(accountId);
    if (!account.enabled) {
      throw new Error(`WeChat account ${account.label} is disabled`);
    }
    if (!account.alertTargetUserId) {
      throw new Error(`WeChat account ${account.label} is not verified for alert delivery`);
    }

    const notifier = this.getNotifier(account.id);
    await notifier.ensureStarted();
    const status = notifier.getStatus(account.alertTargetUserId);
    if (!status.loggedIn) {
      throw new Error(status.lastError ?? `WeChat account ${account.label} is not logged in`);
    }
    await notifier.send(message, account.alertTargetUserId);
  }

  getAccountStatus(accountId: string): WeChatAccountConnectorStatus {
    return this.buildAccountStatus(this.ensureAccount(accountId));
  }

  private storageDirFor(accountId: string): string {
    return path.join(this.storageRoot, accountId);
  }

  private getNotifier(accountId: string): ManagedWeChatNotifier {
    let notifier = this.notifiers.get(accountId);
    if (!notifier) {
      const storageDir = this.storageDirFor(accountId);
      notifier = this.options.notifierFactory?.(storageDir) ?? new WeChatNotifier({ storageDir });
      this.notifiers.set(accountId, notifier);
    }
    return notifier;
  }

  private loadSettings(): AlertSettings {
    return loadAlertSettings(this.options.alertSettingsPath);
  }

  private saveSettings(settings: AlertSettings): AlertSettings {
    return saveAlertSettings(this.options.alertSettingsPath, settings);
  }

  private updateAccountRecord(
    accountId: string,
    update: (account: WeChatAccount) => WeChatAccount
  ): AlertSettings {
    const settings = this.loadSettings();
    let found = false;
    settings.wechatAccounts = settings.wechatAccounts.map((account) => {
      if (account.id !== accountId) return account;
      found = true;
      return update(account);
    });
    if (!found) {
      throw new Error(`WeChat account ${accountId} not found`);
    }
    return this.saveSettings(settings);
  }

  private ensureAccount(accountId: string): WeChatAccount {
    const settings = this.loadSettings();
    return this.mustFindAccount(settings, accountId);
  }

  private mustFindAccount(settings: AlertSettings, accountId: string): WeChatAccount {
    const account = settings.wechatAccounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      throw new Error(`WeChat account ${accountId} not found`);
    }
    return account;
  }

  private buildStatus(settings: AlertSettings): WeChatAccountsStatus {
    const accounts = settings.wechatAccounts.map((account) => this.buildAccountStatus(account));
    const activeAccount = accounts.find((account) => account.id === this.activeLoginAccountId);
    const computedActive = activeAccount && isLoginActive(activeAccount)
      ? activeAccount.id
      : accounts.find(isLoginActive)?.id ?? null;

    this.activeLoginAccountId = computedActive;
    return {
      accounts,
      activeLoginAccountId: computedActive,
      enabledCount: accounts.filter((account) => account.enabled).length,
      verifiedCount: accounts.filter((account) => account.enabled && account.verified).length
    };
  }

  private buildAccountStatus(account: WeChatAccount): WeChatAccountConnectorStatus {
    const connector = this.getNotifier(account.id).getStatus(account.alertTargetUserId ?? "");
    return {
      ...account,
      botUserId: connector.botUserId ?? account.botUserId,
      storageDir: this.storageDirFor(account.id),
      verified: isAccountVerified(account, connector),
      connector
    };
  }

  private clearActiveLogin(accountId: string): void {
    if (this.activeLoginAccountId === accountId) {
      this.activeLoginAccountId = null;
    }
  }
}

function isLoginActive(account: WeChatAccountConnectorStatus): boolean {
  return Boolean(account.connector.awaitingQr || account.connector.qrUrl || (account.connector.loggedIn && !account.verified));
}

function isAccountVerified(
  account: WeChatAccount,
  connector: WeChatAccountConnectorStatus["connector"]
): boolean {
  const target = account.alertTargetUserId;
  if (!target) {
    return false;
  }
  return connector.storedSession.verifiedForTarget ||
    connector.recentChats.some((chat) => chat.userId === target);
}

function findDuplicateAccount(
  settings: AlertSettings,
  currentAccountId: string,
  rawIds: Array<string | null | undefined>
): WeChatAccount | null {
  const ids = new Set(rawIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id)));
  if (ids.size === 0) {
    return null;
  }

  return settings.wechatAccounts.find((account) => {
    if (account.id === currentAccountId) return false;
    const accountIds = [account.botUserId, account.alertTargetUserId]
      .map((id) => id?.trim())
      .filter((id): id is string => Boolean(id));
    return accountIds.some((id) => ids.has(id));
  }) ?? null;
}
