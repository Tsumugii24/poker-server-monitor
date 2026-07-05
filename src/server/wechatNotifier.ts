import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WeChatChatCandidate, WeChatConnectorStatus } from "../shared/types";
import {
  buildWeChatDelivery,
  classifyWeChatSendError,
  classifyWeChatStartupError,
  type WeChatTargetActivity
} from "../shared/wechatDelivery";
import {
  shouldSendWeChatContextRefreshReminder
} from "./wechatContextReminder";
import { readStoredWeChatSession } from "./wechatStorage";

type WeChatBotInstance = {
  stop?: () => void;
  storage?: {
    delete: (key: string) => Promise<void>;
  };
  getCredentials?: () => { userId?: string } | undefined;
  login: (options?: {
    force?: boolean;
    callbacks?: {
      onQrUrl?: (url: string) => void;
    };
  }) => Promise<unknown>;
  start: () => Promise<void>;
  send: (roomId: string, message: string) => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => unknown;
};

type WeChatBotInternalInstance = WeChatBotInstance & {
  poller?: {
    removeAllListeners: (event?: string) => unknown;
    on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => unknown;
  };
};

type WeChatBotConstructor = new (options?: {
  storageDir?: string;
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
}) => WeChatBotInstance;

type WeChatBotModule = {
  WeChatBot?: WeChatBotConstructor;
  default?: WeChatBotConstructor;
};

type IncomingWeChatMessage = {
  userId: string;
  text?: string;
  timestamp?: Date;
};

type InternalWeChatTargetActivity = WeChatTargetActivity & {
  lastContextRefreshReminderAt: string | null;
};

export type WeChatNotifierOptions = {
  storageDir?: string;
};

export class WeChatNotifier {
  private bot: WeChatBotInstance | null = null;
  private botPromise: Promise<WeChatBotInstance> | null = null;
  private loginTask: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private started = false;
  private loggedIn = false;
  private polling = false;
  private ready = false;
  private qrUrl: string | null = null;
  private forceQrLogin = false;
  private loginAttemptStartedAt: number | null = null;
  private loginGeneration = 0;
  private lastError: string | null = null;
  private messageCount = 0;
  private lastMessageAt: string | null = null;
  private suppressAutoRelogin = false;
  private readonly recentChats: WeChatChatCandidate[] = [];
  private readonly targetActivity = new Map<string, InternalWeChatTargetActivity>();

  constructor(private readonly options: WeChatNotifierOptions = {}) {
    this.loadPersistedTargetActivity();
  }

  getStorageDir(): string | undefined {
    return this.options.storageDir;
  }

  async ensureStarted(): Promise<void> {
    if (this.loggedIn || this.isLoginFailed() || this.loginTask) {
      return;
    }
    try {
      await this.getBot();
    } catch {
      /* Previous login attempt failed; wait for restartLogin(). */
    }
  }

  async restartLogin(): Promise<void> {
    this.suppressAutoRelogin = false;
    this.restartPromise ??= this.doRestartLogin().finally(() => {
      this.restartPromise = null;
    });
    await this.restartPromise;
  }

  async refreshLoginQr(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    this.suppressAutoRelogin = false;
    this.restartPromise ??= this.doRestartLogin({ force: true }).finally(() => {
      this.restartPromise = null;
    });
    await this.restartPromise;
  }

  async logout(): Promise<void> {
    this.suppressAutoRelogin = false;
    await this.stopActiveBot();
    await this.clearPersistedSession();
    this.resetConnector();
    this.clearRuntimeSession();
  }

  async switchAccount(): Promise<void> {
    await this.logout();
    this.forceQrLogin = true;
    try {
      await this.getBot();
    } finally {
      this.forceQrLogin = false;
    }
  }

  async restoreSession(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    this.suppressAutoRelogin = false;
    await this.ensureStarted();
  }

  startInBackground(): void {
    void this.ensureStarted().catch((error: unknown) => {
      const classified = classifyWeChatStartupError(error);
      this.lastError = classified.message;
      console.error(classified.logMessage);
    });
  }

  async send(message: string, roomId: string): Promise<void> {
    if (!this.loggedIn) {
      throw new Error(this.lastError ?? "WeChat bot is not logged in yet.");
    }

    const bot = await this.whenReady();
    try {
      await bot.send(roomId, message);
      this.noteTargetSuccess(roomId);
      this.lastError = null;
    } catch (error) {
      const classified = classifyWeChatSendError(error);
      this.lastError = classified.message;
      this.noteTargetFailure(roomId, classified.code);
      throw error;
    }
  }

  async sendContextRefreshReminderIfDue(
    userId: string,
    message: string,
    now = Date.now()
  ): Promise<boolean> {
    const current = this.getInternalTargetActivity(userId);
    if (!shouldSendWeChatContextRefreshReminder(current, now)) {
      return false;
    }

    try {
      await this.send(message, userId);
      return true;
    } finally {
      this.noteContextRefreshReminder(userId, new Date(now).toISOString());
    }
  }

  getStatus(alertTargetUserId = ""): WeChatConnectorStatus {
    const configuredTarget = alertTargetUserId.trim();
    const target = configuredTarget ? this.getTargetActivity(configuredTarget) : null;
    const awaitingQr = this.isAwaitingQr();
    const storedSession = readStoredWeChatSession(configuredTarget, this.options.storageDir);

    return {
      started: this.started,
      loggedIn: this.loggedIn,
      polling: this.polling,
      ready: this.ready,
      qrUrl: this.qrUrl,
      awaitingQr,
      botUserId: this.getBotUserId() ?? storedSession.botUserId,
      storedSession,
      lastError: this.lastError,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      recentChats: [...this.recentChats],
      target,
      delivery: buildWeChatDelivery({
        alertsConfigured: configuredTarget.length > 0,
        started: this.started,
        loggedIn: this.loggedIn,
        polling: this.polling,
        ready: this.ready,
        qrUrl: this.qrUrl,
        awaitingQr,
        lastError: this.lastError,
        target
      })
    };
  }

  private isAwaitingQr(): boolean {
    if (this.loggedIn) return false;
    return this.qrUrl != null || this.loginTask != null || (this.started && !this.lastError);
  }

  private isLoginFailed(): boolean {
    return this.started && !this.loggedIn && this.lastError != null && this.loginTask == null;
  }

  private async doRestartLogin(options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && this.loginTask && !this.isLoginFailed()) {
      const ageMs = this.loginAttemptStartedAt == null ? 0 : Date.now() - this.loginAttemptStartedAt;
      if (ageMs < 45_000 && !this.lastError) {
        return;
      }
      try {
        await this.loginTask;
      } catch {
        /* fall through to forced restart */
      }
      if (this.loggedIn) {
        return;
      }
    }

    await this.stopActiveBot();
    this.forceQrLogin = true;
    this.resetConnector();
    try {
      await this.getBot();
    } finally {
      this.forceQrLogin = false;
    }
  }

  private async whenReady(): Promise<WeChatBotInstance> {
    const bot = await this.getBot();
    if (!this.loggedIn) {
      throw new Error(this.lastError ?? "WeChat bot is not logged in yet.");
    }
    if (this.readyPromise) {
      await this.readyPromise;
    }
    return bot;
  }

  private async getBot(): Promise<WeChatBotInstance> {
    if (this.bot) {
      return this.bot;
    }
    if (this.isLoginFailed()) {
      throw new Error(this.lastError ?? "WeChat login failed");
    }
    this.botPromise ??= this.createBot();
    return this.botPromise;
  }

  private async createBot(): Promise<WeChatBotInstance> {
    let mod: WeChatBotModule;
    try {
      mod = await importWeChatBotModule();
    } catch (error) {
      if (isMissingWeChatBotModuleError(error)) {
        throw new Error(
          "Missing @wechatbot/wechatbot. Run `npm install` in the project root before starting the server."
        );
      }
      throw error;
    }

    const Bot = mod.WeChatBot ?? mod.default;
    if (!Bot) {
      throw new Error("@wechatbot/wechatbot did not export WeChatBot");
    }

    this.started = true;
    this.lastError = null;
    this.loginAttemptStartedAt = Date.now();
    const generation = ++this.loginGeneration;
    const bot = new Bot(this.buildBotOptions());
    this.replaceSdkSessionExpiredHandler(bot);
    this.preventSdkAutoRelogin(bot);
    bot.on("poll:start", () => {
      this.polling = true;
      this.ready = true;
    });
    bot.on("poll:stop", () => {
      this.polling = false;
    });
    bot.on("message", (message: unknown) => this.recordChat(message as IncomingWeChatMessage));
    bot.on("error", (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    bot.on("session:expired", () => {
      this.markSessionExpired(bot);
    });

    this.bot = bot;
    this.loginTask = this.completeLogin(bot, generation);
    void this.loginTask.catch((error: unknown) => {
      if (generation !== this.loginGeneration) {
        return;
      }
      const classified = classifyWeChatStartupError(error);
      this.lastError = classified.message;
      console.error(classified.logMessage);
      this.resetConnector({ keepError: true, soft: true });
    }).finally(() => {
      if (generation === this.loginGeneration) {
        this.loginTask = null;
      }
    });

    return bot;
  }

  private async completeLogin(bot: WeChatBotInstance, generation: number): Promise<void> {
    await bot.login({
      force: this.forceQrLogin,
      callbacks: {
        onQrUrl: (url: string) => {
          if (generation === this.loginGeneration) {
            this.qrUrl = url;
          }
        }
      }
    });
    if (generation !== this.loginGeneration) {
      return;
    }
    this.loggedIn = true;
    this.qrUrl = null;
    this.lastError = null;

    // poll:start fires after contextStore.load(); sending before that causes ret=-2.
    this.readyPromise = new Promise<void>((resolve, reject) => {
      bot.on("poll:start", () => resolve());
      void bot.start().catch((error: unknown) => {
        if (generation !== this.loginGeneration) {
          reject(error);
          return;
        }
        const classified = classifyWeChatStartupError(error);
        this.lastError = classified.message;
        console.error(classified.logMessage);
        reject(error);
      });
    });

    await this.readyPromise;
  }

  private getBotUserId(): string | null {
    return this.bot?.getCredentials?.()?.userId ?? null;
  }

  private async stopActiveBot(): Promise<void> {
    if (!this.bot) return;
    try {
      this.bot.stop?.();
    } catch {
      /* ignore stop errors */
    }
  }

  private async clearPersistedSession(): Promise<void> {
    if (this.bot?.storage) {
      await this.deleteStorageKeys(this.bot.storage);
      return;
    }

    let mod: WeChatBotModule;
    try {
      mod = await importWeChatBotModule();
    } catch {
      return;
    }
    const Bot = mod.WeChatBot ?? mod.default;
    if (!Bot) return;
    const ephemeral = new Bot(this.buildBotOptions());
    if (ephemeral.storage) {
      await this.deleteStorageKeys(ephemeral.storage);
    }
  }

  private async deleteStorageKeys(storage: { delete: (key: string) => Promise<void> }): Promise<void> {
    const keys = ["credentials", "cursor", "context_tokens", "typing_tickets"];
    await Promise.all(keys.map((key) => storage.delete(key).catch(() => undefined)));
    this.deletePersistedTargetActivity();
  }

  private clearRuntimeSession(): void {
    this.recentChats.length = 0;
    this.targetActivity.clear();
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.lastError = null;
  }

  private buildBotOptions(): { storageDir?: string; logLevel?: "debug" | "info" | "warn" | "error" | "silent" } {
    return {
      ...(this.options.storageDir ? { storageDir: this.options.storageDir } : {}),
      logLevel: "warn"
    };
  }

  private replaceSdkSessionExpiredHandler(bot: WeChatBotInstance): void {
    const internal = bot as WeChatBotInternalInstance;
    if (!internal.poller) {
      return;
    }
    internal.poller.removeAllListeners("session:expired");
    internal.poller.on("session:expired", () => {
      this.markSessionExpired(bot);
    });
  }

  private markSessionExpired(bot: WeChatBotInstance): void {
    this.suppressAutoRelogin = true;
    this.loggedIn = false;
    this.ready = false;
    this.polling = false;
    this.qrUrl = null;
    this.lastError = "WeChat bot session expired. Click refresh QR and scan again.";
    try {
      bot.stop?.();
    } catch {
      /* ignore stop errors */
    }
  }

  private preventSdkAutoRelogin(bot: WeChatBotInstance): void {
    const originalLogin = bot.login.bind(bot);
    bot.login = async (options) => {
      if (this.suppressAutoRelogin && options?.force) {
        throw new Error("WeChat session expired; manual QR login required.");
      }
      return originalLogin(options);
    };
  }

  private resetConnector(options: { keepError?: boolean; soft?: boolean } = {}): void {
    if (!options.soft) {
      this.loginGeneration += 1;
    }
    this.bot = null;
    this.botPromise = null;
    this.loginTask = null;
    this.readyPromise = null;
    this.loggedIn = false;
    this.polling = false;
    this.ready = false;
    if (!options.soft) {
      this.started = false;
      this.qrUrl = null;
      this.loginAttemptStartedAt = null;
      if (!options.keepError) {
        this.lastError = null;
      }
    }
  }

  private recordChat(message: IncomingWeChatMessage): void {
    this.messageCount += 1;
    const receivedAt = (message.timestamp ?? new Date()).toISOString();
    this.lastMessageAt = receivedAt;
    this.noteTargetInbound(message.userId, receivedAt);

    const candidate: WeChatChatCandidate = {
      userId: message.userId,
      text: message.text ?? "",
      receivedAt
    };
    const existingIndex = this.recentChats.findIndex((chat) => chat.userId === candidate.userId);
    if (existingIndex >= 0) {
      this.recentChats.splice(existingIndex, 1);
    }
    this.recentChats.unshift(candidate);
    this.recentChats.splice(10);
  }

  private getTargetActivity(userId: string): WeChatTargetActivity {
    const existing = this.getInternalTargetActivity(userId);
    return {
      userId: existing.userId,
      lastInboundAt: existing.lastInboundAt,
      lastSendSuccessAt: existing.lastSendSuccessAt,
      lastSendFailureAt: existing.lastSendFailureAt,
      lastSendFailureCode: existing.lastSendFailureCode
    };
  }

  private getInternalTargetActivity(userId: string): InternalWeChatTargetActivity {
    const existing = this.targetActivity.get(userId);
    if (existing) {
      return { ...existing };
    }

    const inbound = this.recentChats.find((chat) => chat.userId === userId);
    return {
      userId,
      lastInboundAt: inbound?.receivedAt ?? null,
      lastSendSuccessAt: null,
      lastSendFailureAt: null,
      lastSendFailureCode: null,
      lastContextRefreshReminderAt: null
    };
  }

  private noteTargetInbound(userId: string, receivedAt: string): void {
    const current = this.getInternalTargetActivity(userId);
    this.targetActivity.set(userId, {
      ...current,
      lastInboundAt: receivedAt,
      lastSendFailureAt: null,
      lastSendFailureCode: null,
      lastContextRefreshReminderAt: null
    });
    this.persistTargetActivity();
  }

  private noteTargetSuccess(userId: string): void {
    const current = this.getInternalTargetActivity(userId);
    this.targetActivity.set(userId, {
      ...current,
      lastSendSuccessAt: new Date().toISOString(),
      lastSendFailureAt: null,
      lastSendFailureCode: null
    });
    this.persistTargetActivity();
  }

  private noteTargetFailure(userId: string, code: string): void {
    const current = this.getInternalTargetActivity(userId);
    this.targetActivity.set(userId, {
      ...current,
      lastSendFailureAt: new Date().toISOString(),
      lastSendFailureCode: code
    });
    this.persistTargetActivity();
  }

  private noteContextRefreshReminder(userId: string, remindedAt: string): void {
    const current = this.getInternalTargetActivity(userId);
    this.targetActivity.set(userId, {
      ...current,
      lastContextRefreshReminderAt: remindedAt
    });
    this.persistTargetActivity();
  }

  private loadPersistedTargetActivity(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.targetActivityFilePath(), "utf8")) as unknown;
      if (!isRecord(data)) return;
      for (const [userId, rawActivity] of Object.entries(data)) {
        if (!isRecord(rawActivity)) continue;
        this.targetActivity.set(userId, {
          userId,
          lastInboundAt: stringOrNull(rawActivity.lastInboundAt),
          lastSendSuccessAt: stringOrNull(rawActivity.lastSendSuccessAt),
          lastSendFailureAt: stringOrNull(rawActivity.lastSendFailureAt),
          lastSendFailureCode: stringOrNull(rawActivity.lastSendFailureCode),
          lastContextRefreshReminderAt: stringOrNull(rawActivity.lastContextRefreshReminderAt)
        });
      }
    } catch {
      /* No persisted activity yet. */
    }
  }

  private persistTargetActivity(): void {
    try {
      const filePath = this.targetActivityFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(this.targetActivity), null, 2));
    } catch (error) {
      console.error(`Failed to persist WeChat target activity: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private deletePersistedTargetActivity(): void {
    try {
      fs.rmSync(this.targetActivityFilePath(), { force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }

  private targetActivityFilePath(): string {
    return path.join(this.options.storageDir ?? path.join(os.homedir(), ".wechatbot"), "target_activity.json");
  }
}

async function importWeChatBotModule(): Promise<WeChatBotModule> {
  return importEsm<WeChatBotModule>("@wechatbot/wechatbot");
}

function isMissingWeChatBotModuleError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "ERR_MODULE_NOT_FOUND" &&
    String(error.message).includes("@wechatbot/wechatbot");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function importEsm<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<T>;
  return dynamicImport(specifier);
}

export { classifyWeChatSendError, classifyWeChatStartupError };
