import type { AlertSettings } from "../../src/shared/types";

export const defaultAlertSettingsFixture: AlertSettings = {
  enabled: false,
  wechatRoomId: "",
  wechatRecipients: [],
  wechatAccounts: [],
  cooldownMinutes: 60,
  language: "en",
  sshCommandTimeoutSeconds: 15,
  sshConnectTimeoutSeconds: 10,
  hfProxyEnabled: false,
  solverHfProxyEnabled: false
};

export function alertSettingsFixture(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return { ...defaultAlertSettingsFixture, ...overrides };
}

export function enabledRecipientSettings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return alertSettingsFixture({
    enabled: true,
    wechatRoomId: "12345@chatroom",
    wechatRecipients: [{
      id: "recipient-1",
      contactId: "12345@chatroom",
      label: "12345@chatroom",
      enabled: true,
      addedAt: "2026-05-20T10:00:00.000Z"
    }],
    ...overrides
  });
}
