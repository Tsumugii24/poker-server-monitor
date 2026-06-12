import type { WeChatChatCandidate, WeChatConnectorStatus } from "../shared/types";

type WeChatBotConstructor = new (options?: {
  storageDir?: string;
  loginCallbacks?: {
    onQrUrl?: (url: string) => void;
  };
}) => {
  login: () => Promise<unknown>;
  start: () => Promise<void>;
  send: (roomId: string, message: string) => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => unknown;
};

type WeChatBotModule = {
  WeChatBot?: WeChatBotConstructor;
  default?: WeChatBotConstructor;
};

type IncomingWeChatMessage = {
  userId: string;
  text?: string;
  timestamp?: Date;
};

export class WeChatNotifier {
  private botPromise: Promise<InstanceType<WeChatBotConstructor>> | null = null;
  private readyPromise: Promise<void> | null = null;
  private started = false;
  private loggedIn = false;
  private polling = false;
  private qrUrl: string | null = null;
  private lastError: string | null = null;
  private messageCount = 0;
  private lastMessageAt: string | null = null;
  private readonly recentChats: WeChatChatCandidate[] = [];

  async ensureStarted(): Promise<void> {
    await this.whenReady();
  }

  startInBackground(): void {
    void this.ensureStarted().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("WeChat connector startup failed", error);
    });
  }

  async send(message: string, roomId: string): Promise<void> {
    const bot = await this.whenReady();
    await bot.send(roomId, message);
  }

  getStatus(): WeChatConnectorStatus {
    return {
      started: this.started,
      loggedIn: this.loggedIn,
      polling: this.polling,
      qrUrl: this.qrUrl,
      lastError: this.lastError,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      recentChats: [...this.recentChats]
    };
  }

  private async whenReady(): Promise<InstanceType<WeChatBotConstructor>> {
    const bot = await this.getBot();
    if (this.readyPromise) {
      await this.readyPromise;
    }
    return bot;
  }

  private async getBot(): Promise<InstanceType<WeChatBotConstructor>> {
    this.botPromise ??= this.createBot();
    return this.botPromise;
  }

  private async createBot(): Promise<InstanceType<WeChatBotConstructor>> {
    const mod = await importEsm<WeChatBotModule>("@wechatbot/wechatbot");
    const Bot = mod.WeChatBot ?? mod.default;
    if (!Bot) {
      throw new Error("@wechatbot/wechatbot did not export WeChatBot");
    }
    this.started = true;
    const bot = new Bot({
      loginCallbacks: {
        onQrUrl: (url: string) => {
          this.qrUrl = url;
        }
      }
    });
    bot.on("poll:start", () => {
      this.polling = true;
    });
    bot.on("poll:stop", () => {
      this.polling = false;
    });
    bot.on("message", (message) => this.recordChat(message as IncomingWeChatMessage));
    bot.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    await bot.login();
    this.loggedIn = true;
    this.qrUrl = null;
    this.lastError = null;

    // poll:start fires after contextStore.load(); sending before that causes ret=-2.
    this.readyPromise = new Promise<void>((resolve, reject) => {
      bot.on("poll:start", () => resolve());
      void bot.start().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error("WeChat bot polling failed", error);
        reject(error);
      });
    });

    return bot;
  }

  private recordChat(message: IncomingWeChatMessage): void {
    this.messageCount += 1;
    this.lastMessageAt = new Date().toISOString();
    const candidate: WeChatChatCandidate = {
      userId: message.userId,
      text: message.text ?? "",
      receivedAt: (message.timestamp ?? new Date()).toISOString()
    };
    const existingIndex = this.recentChats.findIndex((chat) => chat.userId === candidate.userId);
    if (existingIndex >= 0) {
      this.recentChats.splice(existingIndex, 1);
    }
    this.recentChats.unshift(candidate);
    this.recentChats.splice(10);
  }
}

async function importEsm<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<T>;
  return dynamicImport(specifier);
}
