import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricSnapshot, ServerConfig } from "../../src/shared/types";
import { AlertService, formatTestAlertMessage } from "../../src/server/alertService";

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
      getSettings: () => ({ enabled: false, wechatRoomId: "", cooldownMinutes: 60, language: "en" }),
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
      getSettings: () => ({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 60, language: "en" }),
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
    expect(message).not.toContain("Production 01");
    expect(message).not.toContain("prod-01");
  });

  it("formats offline alerts in Chinese", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => ({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 60, language: "zh" }),
      send
    });

    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "manual",
      startedAt: "2026-05-20T10:00:00.000Z"
    });

    const message = send.mock.calls[0][0];
    expect(message).toContain("Server Monitor");
    expect(message).toContain("\n- \u89e6\u53d1: \u624b\u52a8\u5237\u65b0");
    expect(message).toMatch(/\n- .*10\.0\.0\.1:22 \u539f\u56e0: Connection failed/);
  });

  it("formats test alerts in Chinese", () => {
    const message = formatTestAlertMessage("zh", new Date("2026-05-20T10:00:00.000Z"));
    expect(message).toContain("Server Monitor 测试告警");
    expect(message).toContain("WeChat 离线告警已配置成功");
  });

  it("does not repeat an offline alert before the cooldown expires", async () => {
    const send = vi.fn();
    const service = new AlertService({
      getSettings: () => ({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 120, language: "en" }),
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
    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "online")],
      trigger: "scheduled",
      startedAt: "2026-05-20T12:00:00.000Z"
    });
    await service.handleRefresh({
      servers,
      snapshots: [snapshot("prod-01", "offline")],
      trigger: "scheduled",
      startedAt: "2026-05-20T13:00:00.000Z"
    });

    expect(send).toHaveBeenCalledTimes(2);
  });
});
