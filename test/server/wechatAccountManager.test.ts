import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WeChatConnectorStatus } from "../../src/shared/types";
import { buildWeChatDelivery } from "../../src/shared/wechatDelivery";
import { defaultWeChatStoredSession } from "../../src/shared/wechatSession";
import { WeChatAccountManager } from "../../src/server/wechatAccountManager";

let tempDir: string;
let alertSettingsPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-account-manager-"));
  alertSettingsPath = path.join(tempDir, "alerts.json");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("WeChatAccountManager", () => {
  it("rejects verification when the contact is already configured", () => {
    fs.writeFileSync(alertSettingsPath, JSON.stringify({
      enabled: true,
      wechatRoomId: "",
      wechatRecipients: [],
      wechatAccounts: [
        {
          id: "account-1",
          label: "Ops owner",
          enabled: true,
          addedAt: "2026-05-20T10:00:00.000Z",
          botUserId: "bot-one@im.wechat",
          alertTargetUserId: "owner@im.wechat"
        },
        {
          id: "account-2",
          label: "Duplicate scan",
          enabled: true,
          addedAt: "2026-05-20T10:01:00.000Z",
          botUserId: null,
          alertTargetUserId: null
        }
      ],
      cooldownMinutes: 60,
      language: "en",
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10
    }));

    const manager = new WeChatAccountManager({
      alertSettingsPath,
      notifierFactory: () => fakeNotifier(loggedInStatus({
        botUserId: "bot-two@im.wechat",
        recentChats: [
          { userId: "owner@im.wechat", text: "setup", receivedAt: "2026-05-20T10:02:00.000Z" }
        ],
        contextUserIds: ["owner@im.wechat"]
      }))
    });

    expect(() => manager.verifyAccount("account-2", "owner@im.wechat")).toThrow(
      "WeChat contact owner@im.wechat is already configured as Ops owner."
    );
  });

  it("requires the selected contact to have a cached context token", () => {
    fs.writeFileSync(alertSettingsPath, JSON.stringify({
      enabled: true,
      wechatRoomId: "",
      wechatRecipients: [],
      wechatAccounts: [
        {
          id: "account-1",
          label: "Pending",
          enabled: true,
          addedAt: "2026-05-20T10:00:00.000Z",
          botUserId: null,
          alertTargetUserId: null
        }
      ],
      cooldownMinutes: 60,
      language: "en",
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10
    }));

    const manager = new WeChatAccountManager({
      alertSettingsPath,
      notifierFactory: () => fakeNotifier(loggedInStatus({
        botUserId: "bot-one@im.wechat",
        recentChats: [],
        contextUserIds: []
      }))
    });

    expect(() => manager.verifyAccount("account-1", "owner@im.wechat")).toThrow(
      "Selected WeChat contact has no cached context token."
    );
  });

  it("sends context refresh reminders to enabled verified accounts", async () => {
    fs.writeFileSync(alertSettingsPath, JSON.stringify({
      enabled: true,
      wechatRoomId: "",
      wechatRecipients: [],
      wechatAccounts: [
        {
          id: "account-1",
          label: "Ops owner",
          enabled: true,
          addedAt: "2026-05-20T10:00:00.000Z",
          botUserId: "bot-one@im.wechat",
          alertTargetUserId: "owner@im.wechat"
        },
        {
          id: "account-2",
          label: "Paused",
          enabled: false,
          addedAt: "2026-05-20T10:01:00.000Z",
          botUserId: "bot-two@im.wechat",
          alertTargetUserId: "paused@im.wechat"
        }
      ],
      cooldownMinutes: 60,
      language: "zh",
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10
    }));

    const now = Date.parse("2026-06-25T12:00:00.000Z");
    const sent: Array<{ userId: string; message: string; now: number }> = [];
    const manager = new WeChatAccountManager({
      alertSettingsPath,
      notifierFactory: (storageDir) => {
        const accountId = path.basename(storageDir);
        return fakeNotifier(
          loggedInStatus({
            botUserId: `${accountId}@bot.im.wechat`,
            recentChats: [],
            contextUserIds: [accountId === "account-1" ? "owner@im.wechat" : "paused@im.wechat"],
            target: {
              userId: accountId === "account-1" ? "owner@im.wechat" : "paused@im.wechat",
              lastInboundAt: new Date(now - 23.5 * 60 * 60_000).toISOString(),
              lastSendSuccessAt: null,
              lastSendFailureAt: null,
              lastSendFailureCode: null
            }
          }),
          async (userId, message, reminderNow) => {
            sent.push({ userId, message, now: reminderNow ?? 0 });
            return true;
          }
        );
      }
    });

    const summary = await manager.sendContextRefreshReminders(now);

    expect(summary.sent).toEqual(["account-1"]);
    expect(summary.failed).toEqual([]);
    expect(sent).toEqual([{
      userId: "owner@im.wechat",
      message: expect.stringContaining("请向我发送任意消息来再次激活连接"),
      now
    }]);
  });
});

function loggedInStatus({
  botUserId,
  recentChats,
  contextUserIds,
  target = null
}: {
  botUserId: string;
  recentChats: WeChatConnectorStatus["recentChats"];
  contextUserIds: string[];
  target?: WeChatConnectorStatus["target"];
}): WeChatConnectorStatus {
  return {
    started: true,
    loggedIn: true,
    polling: true,
    ready: true,
    qrUrl: null,
    awaitingQr: false,
    botUserId,
    storedSession: {
      available: true,
      botUserId,
      savedAt: "2026-05-20T10:00:00.000Z",
      contextUserIds,
      verifiedForTarget: false
    },
    lastError: null,
    messageCount: recentChats.length,
    lastMessageAt: recentChats[0]?.receivedAt ?? null,
    recentChats,
    target,
    delivery: buildWeChatDelivery({
      alertsConfigured: false,
      started: true,
      loggedIn: true,
      polling: true,
      ready: true,
      qrUrl: null,
      awaitingQr: false,
      lastError: null,
      target: null
    })
  };
}

function fakeNotifier(
  status: WeChatConnectorStatus,
  sendContextRefreshReminderIfDue: (
    userId: string,
    message: string,
    now?: number
  ) => Promise<boolean> = async () => false
) {
  return {
    getStatus: () => status,
    restartLogin: async () => undefined,
    refreshLoginQr: async () => undefined,
    restoreSession: async () => undefined,
    logout: async () => undefined,
    startInBackground: () => undefined,
    ensureStarted: async () => undefined,
    send: async () => undefined,
    sendContextRefreshReminderIfDue,
    getStorageDir: () => undefined
  };
}
