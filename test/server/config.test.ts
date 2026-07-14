import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServerInventoryEntry,
  deleteServerInventoryEntry,
  loadAlertSettings,
  loadRuntimeConfig,
  loadServerInventory,
  saveAlertSettings,
  updateServerInventoryEntry,
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

  it("creates a server with generated id and generated initial name", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "10-0-0-1", name: "Production 01", host: "10.0.0.1" }]));

    const created = createServerInventoryEntry(file, {
      host: "10.0.0.1",
      port: 2222,
      group: "prod",
      enabled: false,
      note: "Secondary solver"
    });

    expect(created).toMatchObject({
      id: "10-0-0-1-2222",
      name: "10.0.0.1",
      host: "10.0.0.1",
      port: 2222,
      group: "prod",
      enabled: false,
      note: "Secondary solver"
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))[1]).toMatchObject({
      id: "10-0-0-1-2222",
      name: "10.0.0.1"
    });
  });

  it("updates editable inventory fields without changing id or name", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true, group: "old" }])
    );

    const updated = updateServerInventoryEntry(file, "prod-01", {
      host: "10.0.0.8",
      port: 2222,
      group: null,
      enabled: false,
      note: "Updated solver"
    });

    expect(updated).toEqual({
      id: "prod-01",
      name: "Production 01",
      host: "10.0.0.8",
      port: 2222,
      enabled: false,
      note: "Updated solver"
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { id: "prod-01", name: "Production 01", host: "10.0.0.8", port: 2222, enabled: false, note: "Updated solver" }
    ]);
  });

  it("deletes a server from the inventory file", () => {
    const file = path.join(tempDir, "servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "prod-01", name: "Production 01", host: "10.0.0.1" },
        { id: "prod-02", name: "Production 02", host: "10.0.0.2" }
      ])
    );

    const remaining = deleteServerInventoryEntry(file, "prod-01");

    expect(remaining.map((server) => server.id)).toEqual(["prod-02"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { id: "prod-02", name: "Production 02", host: "10.0.0.2" }
    ]);
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
    expect(config.hfToken).toBeNull();
  });

  it("allows overriding the HTTP bind host for deployment", () => {
    const config = loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret",
      SERVER_MONITOR_HOST: "0.0.0.0"
    });

    expect(config.host).toBe("0.0.0.0");
  });

  it("loads the Hugging Face token for upload jobs", () => {
    const config = loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret",
      HF_TOKEN: "hf_test_token",
      SERVER_MONITOR_HF_PROXY_URL: "http://127.0.0.1:7890",
      SOLVER_HF_PROXY_URL: "http://10.0.0.8:7890",
      SUBSCRIPTION_URL: "https://subscription.example/token"
    });

    expect(config.hfToken).toBe("hf_test_token");
    expect(config.hfProxyUrl).toBe("http://127.0.0.1:7890");
    expect(config.solverHfProxyUrl).toBe("http://10.0.0.8:7890");
    expect(config.subscriptionUrl).toBe("https://subscription.example/token");
  });

  it("rejects invalid Hugging Face proxy URLs", () => {
    expect(() => loadRuntimeConfig({
      SSH_USERNAME: "root",
      SSH_PASSWORD: "secret",
      SERVER_MONITOR_HF_PROXY_URL: "socks5://127.0.0.1:7890"
    })).toThrow("SERVER_MONITOR_HF_PROXY_URL must start with http:// or https://");
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
      sshConnectTimeoutSeconds: 10,
      hfProxyEnabled: false,
      solverHfProxyEnabled: false
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
      sshConnectTimeoutSeconds: 8,
      hfProxyEnabled: true,
      solverHfProxyEnabled: false
    });

    expect(loadAlertSettings(file)).toMatchObject({
      enabled: true,
      wechatRoomId: "12345@chatroom",
      wechatAccounts: [],
      cooldownMinutes: 30,
      language: "zh",
      sshCommandTimeoutSeconds: 20,
      sshConnectTimeoutSeconds: 8,
      hfProxyEnabled: true,
      solverHfProxyEnabled: false
    });
  });

  it("applies SSH timeout defaults when fields are omitted", () => {
    const file = path.join(tempDir, "alerts-partial.json");
    fs.writeFileSync(file, JSON.stringify({ enabled: true, cooldownMinutes: 30, language: "en" }));

    expect(loadAlertSettings(file)).toMatchObject({
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10,
      hfProxyEnabled: false,
      solverHfProxyEnabled: false
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
