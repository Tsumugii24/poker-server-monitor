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
});

function loggedInStatus({
  botUserId,
  recentChats,
  contextUserIds
}: {
  botUserId: string;
  recentChats: WeChatConnectorStatus["recentChats"];
  contextUserIds: string[];
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
    target: null,
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

function fakeNotifier(status: WeChatConnectorStatus) {
  return {
    getStatus: () => status,
    restartLogin: async () => undefined,
    refreshLoginQr: async () => undefined,
    restoreSession: async () => undefined,
    logout: async () => undefined,
    startInBackground: () => undefined,
    ensureStarted: async () => undefined,
    send: async () => undefined,
    getStorageDir: () => undefined
  };
}
