import type { AlertSettings, MetricSnapshot, RefreshTrigger, ServerConfig } from "../shared/types";

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
  private readonly lastOfflineAlertAt = new Map<string, number>();

  constructor(private readonly options: AlertServiceOptions) {}

  async handleRefresh(event: AlertRefreshEvent): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.enabled || settings.wechatRoomId.trim() === "") {
      return;
    }

    const serverById = new Map(event.servers.map((server) => [server.id, server]));
    const offlineSnapshots = event.snapshots.filter((snapshot) => snapshot.connectionStatus === "offline");
    const onlineIds = new Set(event.snapshots
      .filter((snapshot) => snapshot.connectionStatus !== "offline")
      .map((snapshot) => snapshot.serverId));

    for (const serverId of onlineIds) {
      this.lastOfflineAlertAt.delete(serverId);
    }

    const alertable = offlineSnapshots.filter((snapshot) => this.shouldAlert(snapshot.serverId, settings));
    if (alertable.length === 0) {
      return;
    }

    const now = Date.now();
    for (const snapshot of alertable) {
      this.lastOfflineAlertAt.set(snapshot.serverId, now);
    }

    await this.options.send(this.formatOfflineMessage(alertable, serverById, event, settings.language), settings.wechatRoomId);
  }

  async sendTest(settings: AlertSettings): Promise<void> {
    if (!settings.enabled || settings.wechatRoomId.trim() === "") {
      throw new Error("WeChat alerts must be enabled and configured before sending a test alert");
    }

    await this.options.send(formatTestAlertMessage(settings.language), settings.wechatRoomId);
  }

  getStatus(): { enabled: boolean; configured: boolean } {
    const settings = this.options.getSettings();
    return {
      enabled: settings.enabled,
      configured: settings.wechatRoomId.trim() !== ""
    };
  }

  private shouldAlert(serverId: string, settings: AlertSettings): boolean {
    const lastSentAt = this.lastOfflineAlertAt.get(serverId);
    if (lastSentAt == null) {
      return true;
    }
    return Date.now() - lastSentAt >= settings.cooldownMinutes * 60_000;
  }

  private formatOfflineMessage(
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
