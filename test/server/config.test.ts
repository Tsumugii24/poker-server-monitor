import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadAlertSettings,
  loadRuntimeConfig,
  loadServerInventory,
  saveAlertSettings,
  updateServerInventoryNote,
  updateServerInventoryName
} from "../../src/server/config";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-config-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("server inventory loading", () => {
  it("loads inventory with default port and enabled values", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ id: "prod-01", name: "Production 01", host: "10.0.0.1" }])
    );

    expect(loadServerInventory(file)).toEqual([
      {
        id: "prod-01",
        name: "Production 01",
        host: "10.0.0.1",
        port: 22,
        enabled: true,
        note: "TBD"
      }
    ]);
  });

  it("rejects duplicate server ids", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "prod-01", name: "Production 01", host: "10.0.0.1" },
        { id: "prod-01", name: "Production 01 Copy", host: "10.0.0.2" }
      ])
    );

    expect(() => loadServerInventory(file)).toThrow("Duplicate server id prod-01");
  });

  it("updates a server note in the inventory file", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
        { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 2222, enabled: false }
      ])
    );

    const updated = updateServerInventoryNote(file, "prod-02", "Primary solver");

    expect(updated).toMatchObject({ id: "prod-02", note: "Primary solver", host: "10.0.0.2" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
      { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 2222, enabled: false, note: "Primary solver" }
    ]);
  });

  it("rejects empty server notes when updating inventory", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "prod-01", name: "Production 01", host: "10.0.0.1" }]));

    expect(() => updateServerInventoryNote(file, "prod-01", "   ")).toThrow("note must be a non-empty string");
  });

  it("updates a server name in the inventory file", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
        { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 2222, enabled: false }
      ])
    );

    const updated = updateServerInventoryName(file, "prod-02", "Analytics 02");

    expect(updated).toMatchObject({ id: "prod-02", name: "Analytics 02", host: "10.0.0.2" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true },
      { id: "prod-02", name: "Analytics 02", host: "10.0.0.2", port: 2222, enabled: false }
    ]);
  });

  it("rejects empty server names when updating inventory", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "prod-01", name: "Production 01", host: "10.0.0.1" }]));

    expect(() => updateServerInventoryName(file, "prod-01", "   ")).toThrow("name must be a non-empty string");
  });
});

describe("runtime config loading", () => {
  it("loads SSH credentials and runtime defaults from environment", () => {
    const config = loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret"
    });

    expect(config.ssh.username).toBe("root");
    expect(config.ssh.password).toBe("secret");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
    expect(config.refreshIntervalMs).toBe(3_600_000);
    expect(config.alertSettingsPath).toBe("config/alerts.json");
    expect(config.pipelineStatusFilePath).toBe("~/run/solver_running_status.json");
  });

  it("allows overriding the HTTP bind host for deployment", () => {
    const config = loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret",
      SERVER_MONITOR_HOST: "0.0.0.0"
    });

    expect(config.host).toBe("0.0.0.0");
  });

  it("fails clearly when SSH credentials are missing", () => {
    expect(() => loadRuntimeConfig({ SSH_USERNAME: "root" })).toThrow(
      "SSH_PASSWORD is required"
    );
  });
});

describe("alert settings loading", () => {
  it("uses disabled defaults when the alert settings file is missing", () => {
    const file = path.join(tempDir, "alerts.json");

    expect(loadAlertSettings(file)).toEqual({
      enabled: false,
      wechatRoomId: "",
      wechatRecipients: [],
      wechatAccounts: [],
      cooldownMinutes: 60,
      language: "en",
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10
    });
  });

  it("loads and saves alert settings", () => {
    const file = path.join(tempDir, "alerts.json");

    saveAlertSettings(file, {
      enabled: true,
      wechatRoomId: "12345@chatroom",
      wechatRecipients: [],
      wechatAccounts: [],
      cooldownMinutes: 30,
      language: "zh",
      sshCommandTimeoutSeconds: 20,
      sshConnectTimeoutSeconds: 8
    });

    expect(loadAlertSettings(file)).toMatchObject({
      enabled: true,
      wechatRoomId: "12345@chatroom",
      wechatAccounts: [],
      cooldownMinutes: 30,
      language: "zh",
      sshCommandTimeoutSeconds: 20,
      sshConnectTimeoutSeconds: 8
    });
  });

  it("applies SSH timeout defaults when fields are omitted", () => {
    const file = path.join(tempDir, "alerts-partial.json");
    fs.writeFileSync(file, JSON.stringify({ enabled: true, cooldownMinutes: 30, language: "en" }));

    expect(loadAlertSettings(file)).toMatchObject({
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10
    });
  });

  it("normalizes persisted WeChat account entries", () => {
    const file = path.join(tempDir, "alerts-accounts.json");
    fs.writeFileSync(file, JSON.stringify({
      enabled: true,
      cooldownMinutes: 30,
      language: "zh",
      wechatAccounts: [
        {
          id: "account-1",
          label: "Ops owner",
          enabled: true,
          addedAt: "2026-05-20T10:00:00.000Z",
          botUserId: "bot@im.wechat",
          alertTargetUserId: "owner@im.wechat"
        },
        {
          id: "account-1",
          label: "Duplicate",
          enabled: true
        },
        {
          id: "account-2",
          label: "Duplicate contact",
          enabled: true,
          addedAt: "2026-05-20T10:01:00.000Z",
          botUserId: "another-bot@im.wechat",
          alertTargetUserId: "owner@im.wechat"
        }
      ]
    }));

    expect(loadAlertSettings(file).wechatAccounts).toEqual([
      {
        id: "account-1",
        label: "Ops owner",
        enabled: true,
        addedAt: "2026-05-20T10:00:00.000Z",
        botUserId: "bot@im.wechat",
        alertTargetUserId: "owner@im.wechat"
      }
    ]);
  });
});
