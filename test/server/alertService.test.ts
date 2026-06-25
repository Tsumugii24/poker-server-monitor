import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricSnapshot, ServerConfig } from "../../src/shared/types";
import {
  AlertService,
  formatTestAlertMessage,
  shouldSendOfflineAlert
} from "../../src/server/alertService";
import { defaultAlertSettingsFixture, enabledRecipientSettings } from "../fixtures/alertSettings";

const servers: ServerConfig[] = [
  { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true, note: "TBD" },
  { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 22, enabled: true, note: "TBD" }
];

function snapshot(serverId: string, connectionStatus: "online" | "offline"): MetricSnapshot {
  const offline = connectionStatus === "offline";
  return {
    id: `${serverId}-${connectionStatus}`,
    serverId,
    collectedAt: "2026-05-20T10:00:00.000Z",
    connectionStatus,
    healthLevel: offline ? null : "healthy",
    cpuUsedPercent: offline ? null : 20,
    memoryUsedPercent: offline ? null : 30,
    diskUsedPercent: offline ? null : 40,
    load1: offline ? null : 0.1,
    load5: offline ? null : 0.2,
    load15: offline ? null : 0.3,
    uptimeSeconds: offline ? null : 3600,
    errorCode: offline ? "connect_failed" : null,
    errorMessage: offline ? "Connection failed" : null,
    cpuModel: null,
    cpuVcores: null,
    memoryTotalBytes: null,
    memoryUsedBytes: null,
    diskTotalBytes: null,
    diskUsedBytes: null
  };
}

describe("shouldSendOfflineAlert", () => {
  const settings = { enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 60, language: "en" as const };

  it("always allows manual refresh alerts", () => {
    expect(shouldSendOfflineAlert("manual", settings, Date.now())).toBe(true);
  });

  it("allows automatic alerts when nothing was sent yet", () => {
    expect(shouldSendOfflineAlert("scheduled", settings, null)).toBe(true);
  });

  it("blocks automatic alerts until the global cooldown expires", () => {
    const now = Date.parse("2026-05-20T12:00:00.000Z");
    expect(shouldSendOfflineAlert("scheduled", settings, now - 30 * 60_000, now)).toBe(false);
    expect(shouldSendOfflineAlert("scheduled", settings, now - 61 * 60_000, now)).toBe(true);
  });
});

describe("AlertService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not send alerts when disabled", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => defaultAlertSettingsFixture,
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:00:00.000Z"
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("sends one WeChat alert when a server becomes offline", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => enabledRecipientSettings(),
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline"), snapshot("prod-02", "online")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:00:00.000Z"
    });

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message).toContain("Server Monitor Alert");
    expect(message).toContain("\n- Status: Offline server detected");
    expect(message).toMatch(/\n- .*10\.0\.0\.1:22 Reason: Connection failed/);
  });

  it("sends offline alerts to every enabled recipient", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => enabledRecipientSettings({
        wechatRoomId: "one@im.wechat",
        wechatRecipients: [
          {
            id: "recipient-1",
            contactId: "one@im.wechat",
            label: "One",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z"
          },
          {
            id: "recipient-2",
            contactId: "two@im.wechat",
            label: "Two",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z"
          },
          {
            id: "recipient-3",
            contactId: "paused@im.wechat",
            label: "Paused",
            enabled: false,
            addedAt: "2026-05-20T10:00:00.000Z"
          }
        ]
      }),
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:00:00.000Z"
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[1])).toEqual(["one@im.wechat", "two@im.wechat"]);
  });

  it("formats offline alerts in Chinese", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => enabledRecipientSettings({ language: "zh" }),
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "manual",
      startedAt: "2026-05-20T10:00:00.000Z"
    });

    const message = send.mock.calls[0][0];
    expect(message).toContain("\n- \u89e6\u53d1: \u624b\u52a8\u5237\u65b0");
  });

  it("formats test alerts in Chinese", () => {
    const message = formatTestAlertMessage("zh", new Date("2026-05-20T10:00:00.000Z"));
    expect(message).toContain("Server Monitor 测试告警");
  });

  it("does not consume cooldown when send fails", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("WeChat bot is not logged in yet."))
      .mockResolvedValue(undefined);
    const service = new AlertService({
      getSettings: () => enabledRecipientSettings({ cooldownMinutes: 120 }),
      send
    });

    await expect(service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:00:00.000Z"
    })).rejects.toThrow("WeChat bot is not logged in yet.");

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:30:00.000Z"
    });

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("always sends on manual refresh even inside the cooldown window", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => enabledRecipientSettings({ cooldownMinutes: 120 }),
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:00:00.000Z"
    });
    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "manual",
      startedAt: "2026-05-20T10:30:00.000Z"
    });

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not repeat automatic alerts before the global cooldown expires", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => enabledRecipientSettings({ cooldownMinutes: 120 }),
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T10:00:00.000Z"
    });
    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T11:00:00.000Z"
    });
    vi.setSystemTime(new Date("2026-05-20T13:00:00.000Z"));
    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T13:00:00.000Z"
    });

    expect(send).toHaveBeenCalledTimes(2);
  });
});
