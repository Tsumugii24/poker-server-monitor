import type { AlertSettings, MetricSnapshot, RefreshTrigger, ServerConfig, WeChatRecipient } from "../shared/types";

export type AlertRefreshEvent = {
  servers: ServerConfig[];
  snapshots: MetricSnapshot[];
  trigger: RefreshTrigger;
  startedAt: string;
};

export type AlertServiceOptions = {
  getSettings: () => AlertSettings;
  send: (message: string, roomId: string) => Promise<void> | void;
};

export class AlertService {
  private lastAlertSentAt: number | null = null;

  constructor(private readonly options: AlertServiceOptions) {}

  async handleRefresh(event: AlertRefreshEvent): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.enabled) {
      return;
    }

    const enabledRecipients = settings.wechatRecipients.filter((r) => r.enabled);
    if (enabledRecipients.length === 0) {
      return;
    }

    const offlineSnapshots = event.snapshots.filter((snapshot) => snapshot.connectionStatus === "offline");
    if (offlineSnapshots.length === 0) {
      return;
    }

    if (!shouldSendOfflineAlert(event.trigger, settings, this.lastAlertSentAt)) {
      return;
    }

    const serverById = new Map(event.servers.map((server) => [server.id, server]));
    const message = formatOfflineMessage(offlineSnapshots, serverById, event, settings.language);

    const errors: string[] = [];
    for (const recipient of enabledRecipients) {
      try {
        await this.options.send(message, recipient.contactId);
      } catch (error) {
        errors.push(`${recipient.contactId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.lastAlertSentAt = Date.now();

    if (errors.length > 0) {
      console.error(`Alert delivery failed for ${errors.length} recipient(s):\n${errors.join("\n")}`);
    }
  }

  async sendTest(settings: AlertSettings, recipientId?: string): Promise<void> {
    if (!settings.enabled) {
      throw new Error("WeChat alerts must be enabled before sending a test alert");
    }

    const message = formatTestAlertMessage(settings.language);

    if (recipientId) {
      const recipient = settings.wechatRecipients.find((r) => r.id === recipientId);
      if (!recipient) {
        throw new Error(`Recipient ${recipientId} not found`);
      }
      await this.options.send(message, recipient.contactId);
      return;
    }

    // Send to all enabled recipients
    const enabledRecipients = settings.wechatRecipients.filter((r) => r.enabled);
    if (enabledRecipients.length === 0) {
      throw new Error("No enabled recipients configured");
    }

    for (const recipient of enabledRecipients) {
      await this.options.send(message, recipient.contactId);
    }
  }

  getStatus(): { enabled: boolean; configured: boolean } {
    const settings = this.options.getSettings();
    return {
      enabled: settings.enabled,
      configured: settings.wechatRecipients.some((r) => r.enabled)
    };
  }
}

export function shouldSendOfflineAlert(
  trigger: RefreshTrigger,
  settings: AlertSettings,
  lastAlertSentAt: number | null,
  now = Date.now()
): boolean {
  if (trigger === "manual") {
    return true;
  }
  if (lastAlertSentAt == null) {
    return true;
  }
  return now - lastAlertSentAt >= settings.cooldownMinutes * 60_000;
}

export function alertRefreshIntervalMs(settings: AlertSettings, fallbackMs: number): number {
  if (settings.enabled) {
    return settings.cooldownMinutes * 60_000;
  }
  return fallbackMs;
}

function formatOfflineMessage(
  snapshots: MetricSnapshot[],
  serverById: Map<string, ServerConfig>,
  event: AlertRefreshEvent,
  language: AlertSettings["language"]
): string {
  const lines = snapshots.map((snapshot) => {
    const server = serverById.get(snapshot.serverId);
    const address = server ? `${server.host}:${server.port}` : snapshot.serverId;
    const reason = snapshot.errorMessage
      ? ` ${language === "zh" ? "原因" : "Reason"}: ${snapshot.errorMessage}`
      : "";
    return `- 🔴 ${address}${reason}`;
  });

  if (language === "zh") {
    return [
      "🚨 Server Monitor 告警",
      "",
      `- 状态: 检测到服务器离线`,
      `- 触发: ${formatTrigger(event.trigger, language)}`,
      `- 时间: ${new Date(event.startedAt).toLocaleString()}`,
      "",
      "离线服务器:",
      ...lines
    ].join("\n");
  }

  return [
    "🚨 Server Monitor Alert",
    "",
    `- Status: Offline server detected`,
    `- Trigger: ${formatTrigger(event.trigger, language)}`,
    `- Time: ${new Date(event.startedAt).toLocaleString()}`,
    "",
    "Offline servers:",
    ...lines
  ].join("\n");
}

function formatTrigger(trigger: RefreshTrigger, language: AlertSettings["language"]): string {
  if (language === "zh") {
    if (trigger === "manual") return "手动刷新";
    if (trigger === "scheduled") return "自动检测";
    return "启动检测";
  }
  return trigger;
}

export function formatTestAlertMessage(language: AlertSettings["language"], now = new Date()): string {
  const time = now.toLocaleString();
  if (language === "zh") {
    return [
      "Server Monitor 测试告警",
      `时间: ${time}`,
      "收到此消息表示 WeChat 离线告警已配置成功。"
    ].join("\n");
  }

  return [
    "Server Monitor test alert",
    `Time: ${time}`,
    "If you received this message, WeChat alert delivery is configured."
  ].join("\n");
}
