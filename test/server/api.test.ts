import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricSnapshot, ServerConfig } from "../../src/shared/types";
import { createApp } from "../../src/server/api";
import { MonitorDatabase } from "../../src/server/db";
import { RefreshService } from "../../src/server/refreshService";

const servers: ServerConfig[] = [
  { id: "prod-01", name: "Production 01", host: "10.0.0.1", port: 22, enabled: true, note: "TBD" }
];

function snapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id: "snap-1",
    serverId: "prod-01",
    collectedAt: new Date().toISOString(),
    connectionStatus: "online",
    healthLevel: "healthy",
    cpuUsedPercent: 20,
    memoryUsedPercent: 30,
    diskUsedPercent: 40,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    uptimeSeconds: 3600,
    errorCode: null,
    errorMessage: null,
    cpuModel: "Intel Xeon E5-2686 v4",
    cpuVcores: 4,
    memoryTotalBytes: 8589934592,
    memoryUsedBytes: 2576980378,
    diskTotalBytes: 107374182400,
    diskUsedBytes: 42949672960,
    ...overrides
  };
}

describe("monitor API", () => {
  let db: MonitorDatabase;
  let service: RefreshService;
  let tempDir: string;
  let inventoryPath: string;
  let alertSettingsPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-monitor-api-"));
    inventoryPath = path.join(tempDir, "servers.json");
    alertSettingsPath = path.join(tempDir, "alerts.json");
    fs.writeFileSync(inventoryPath, JSON.stringify(servers));
    db = await MonitorDatabase.createInMemory();
    db.syncServers(servers);
    db.insertSnapshot(snapshot());
    service = new RefreshService({
      db,
      servers,
      intervalMs: 3_600_000,
      collect: async () => ({
        ...snapshot(),
        id: crypto.randomUUID(),
        collectedAt: new Date().toISOString()
      })
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns overview data with summary and latest server rows", async () => {
    const response = await request(createApp({ db, refreshService: service })).get("/api/overview");

    expect(response.status).toBe(200);
    expect(response.body.summary.total).toBe(1);
    expect(response.body.servers[0].latest.connectionStatus).toBe("online");
    expect(response.body.servers[0].latest.healthLevel).toBe("healthy");
    expect(response.body.summary.pipelineRunning).toBe(0);
    expect(response.body.description).toContain("1 of 1 servers online");
  });

  it("counts warning-health servers as online in the overview connectivity total", async () => {
    const warningServer: ServerConfig = {
      id: "prod-02",
      name: "Production 02",
      host: "10.0.0.2",
      port: 22,
      enabled: true,
      note: "TBD"
    };
    db.syncServers([...servers, warningServer]);
    db.insertSnapshot(snapshot({
      id: "snap-2",
      serverId: "prod-02",
      connectionStatus: "online",
      healthLevel: "warning",
      cpuUsedPercent: 85
    }));

    const response = await request(createApp({ db, refreshService: service })).get("/api/overview");

    expect(response.status).toBe(200);
    expect(response.body.summary.online).toBe(2);
    expect(response.body.summary.warning).toBe(1);
    expect(response.body.summary.healthy).toBe(1);
    expect(response.body.description).toContain("2 of 2 servers online");
  });

  it("returns server detail and history", async () => {
    const response = await request(createApp({ db, refreshService: service })).get(
      "/api/servers/prod-01/history?hours=24"
    );

    expect(response.status).toBe(200);
    expect(response.body.server.id).toBe("prod-01");
    expect(response.body.history).toHaveLength(1);
  });

  it("triggers a manual refresh", async () => {
    const response = await request(createApp({ db, refreshService: service })).post("/api/refresh");

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
  });

  it("updates a server note in the inventory file and database", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .patch("/api/servers/prod-01")
      .send({ note: "Primary solver" });

    expect(response.status).toBe(200);
    expect(response.body.note).toBe("Primary solver");
    expect(db.getServer("prod-01")?.note).toBe("Primary solver");
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))[0].note).toBe("Primary solver");
  });

  it("updates server tiers in the inventory file and database", async () => {
    fs.writeFileSync(inventoryPath, JSON.stringify([
      ...servers,
      { id: "prod-02", name: "Production 02", host: "10.0.0.2", port: 22, enabled: true, note: "TBD" }
    ]));

    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .put("/api/servers/tiers")
      .send({ performanceServerIds: ["prod-02"] });

    expect(response.status).toBe(200);
    expect(response.body.servers.map((server: ServerConfig) => [server.id, server.tier])).toEqual([
      ["prod-01", "standard"],
      ["prod-02", "performance"]
    ]);
    expect(db.getServers().map((server) => [server.id, server.tier])).toEqual([
      ["prod-01", "standard"],
      ["prod-02", "performance"]
    ]);
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8")).map((server: ServerConfig) => (
      [server.id, server.tier]
    ))).toEqual([
      ["prod-01", "standard"],
      ["prod-02", "performance"]
    ]);
  });

  it("rejects an unknown Performance Tier server", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .put("/api/servers/tiers")
      .send({ performanceServerIds: ["missing"] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_server_tiers");
  });

  it("creates a server in the inventory file and database", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .post("/api/servers")
      .send({
        host: "10.0.0.2",
        port: 2222,
        group: "prod",
        enabled: false,
        note: "Secondary solver",
        solverRoot: "/srv/solver",
        tmuxSession: "solver-b",
        pipelineStatusFilePath: "~/run/status-b.json"
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: "10-0-0-2-2222",
      name: "10.0.0.2",
      host: "10.0.0.2",
      port: 2222,
      group: "prod",
      enabled: false,
      note: "Secondary solver",
      solverRoot: "/srv/solver",
      tmuxSession: "solver-b",
      pipelineStatusFilePath: "~/run/status-b.json"
    });
    expect(db.getServer("10-0-0-2-2222")).toMatchObject({
      name: "10.0.0.2",
      host: "10.0.0.2",
      solverRoot: "/srv/solver"
    });
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))[1]).toMatchObject({
      id: "10-0-0-2-2222",
      name: "10.0.0.2",
      solverRoot: "/srv/solver"
    });
  });

  it("rejects manual id and name when creating a server", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .post("/api/servers")
      .send({ id: "manual-id", name: "Manual Name", host: "10.0.0.2", port: 22, enabled: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("immutable_server_field");
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))).toHaveLength(1);
  });

  it("updates editable server inventory fields", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .patch("/api/servers/prod-01")
      .send({
        host: "10.0.0.8",
        port: 2222,
        group: "analytics",
        enabled: false,
        note: "GPU solver",
        solverRoot: "/srv/solver",
        tmuxSession: "solver-prod",
        pipelineStatusFilePath: "~/run/prod-status.json"
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: "prod-01",
      name: "Production 01",
      host: "10.0.0.8",
      port: 2222,
      group: "analytics",
      enabled: false,
      note: "GPU solver",
      solverRoot: "/srv/solver",
      tmuxSession: "solver-prod",
      pipelineStatusFilePath: "~/run/prod-status.json"
    });
    expect(db.getServer("prod-01")).toMatchObject({
      name: "Production 01",
      host: "10.0.0.8",
      port: 2222,
      group: "analytics",
      enabled: false,
      note: "GPU solver",
      solverRoot: "/srv/solver",
      tmuxSession: "solver-prod",
      pipelineStatusFilePath: "~/run/prod-status.json"
    });
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))[0]).toMatchObject({
      id: "prod-01",
      name: "Production 01",
      host: "10.0.0.8",
      solverRoot: "/srv/solver"
    });
  });

  it("rejects manual id and name changes", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .patch("/api/servers/prod-01")
      .send({ id: "manual-id", name: "Manual Name", host: "10.0.0.8" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("immutable_server_field");
    expect(db.getServer("prod-01")?.name).toBe("Production 01");
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))[0].name).toBe("Production 01");
  });

  it("deletes a server from the inventory file and database", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .delete("/api/servers/prod-01");

    expect(response.status).toBe(200);
    expect(db.getServer("prod-01")).toBeNull();
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))).toEqual([]);
    expect(response.body.servers).toEqual([]);
  });

  it("rejects empty server note updates", async () => {
    const response = await request(createApp({ db, refreshService: service, inventoryPath }))
      .patch("/api/servers/prod-01")
      .send({ note: " " });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_server_note");
  });

  it("returns disabled alert settings by default", async () => {
    const response = await request(createApp({ db, refreshService: service, alertSettingsPath })).get(
      "/api/settings/alerts"
    );

    expect(response.status).toBe(200);
    expect(response.body.settings).toEqual({
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
    expect(response.body.status).toEqual({ enabled: false, configured: false });
    expect(response.body.hfProxy).toEqual({
      serverMonitor: { configured: false, enabled: false },
      solver: { configured: false, enabled: false }
    });
  });

  it("updates alert settings", async () => {
    const startAlertConnector = vi.fn();
    const response = await request(createApp({ db, refreshService: service, alertSettingsPath, startAlertConnector }))
      .patch("/api/settings/alerts")
      .send({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 15, language: "zh" });

    expect(response.status).toBe(200);
    expect(response.body.settings.enabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(alertSettingsPath, "utf8"))).toMatchObject({
      enabled: true,
      wechatRoomId: "12345@chatroom",
      cooldownMinutes: 15,
      language: "zh"
    });
    expect(startAlertConnector).toHaveBeenCalledTimes(1);
  });

  it("requires configured proxy URLs and enabled settings for Hugging Face proxy", async () => {
    const app = createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      hfProxyUrl: "http://127.0.0.1:7890",
      solverHfProxyUrl: "http://127.0.0.1:7890"
    });

    const initial = await request(app).get("/api/settings/alerts");
    expect(initial.body.hfProxy).toEqual({
      serverMonitor: { configured: true, enabled: false },
      solver: { configured: true, enabled: false }
    });

    const updated = await request(app)
      .patch("/api/settings/alerts")
      .send({
        enabled: true,
        wechatRoomId: "",
        cooldownMinutes: 15,
        language: "en",
        hfProxyEnabled: true,
        solverHfProxyEnabled: true
      });

    expect(updated.status).toBe(200);
    expect(updated.body.hfProxy).toEqual({
      serverMonitor: { configured: true, enabled: true },
      solver: { configured: true, enabled: true }
    });
  });

  it("sends a test alert through the configured alert service", async () => {
    const sent: string[] = [];

    const response = await request(createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      sendTestAlert: async (message) => {
        sent.push(message);
      }
    }))
      .post("/api/settings/alerts/test")
      .send({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 15, language: "en" });

    expect(response.status).toBe(202);
    expect(sent[0]).toContain("Server Monitor test alert");
  });

  it("sends a global test alert to every enabled recipient", async () => {
    const sent: Array<{ message: string; roomId: string }> = [];

    const response = await request(createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      sendTestAlert: async (message, roomId) => {
        sent.push({ message, roomId });
      }
    }))
      .post("/api/settings/alerts/test")
      .send({
        enabled: true,
        wechatRoomId: "",
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
        ],
        cooldownMinutes: 15,
        language: "en"
      });

    expect(response.status).toBe(202);
    expect(response.body.recipientCount).toBe(2);
    expect(sent.map((item) => item.roomId)).toEqual(["one@im.wechat", "two@im.wechat"]);
    expect(sent[0]?.message).toContain("Server Monitor test alert");
  });

  it("sends a global test alert to every enabled verified WeChat account", async () => {
    const sent: Array<{ message: string; targetId: string }> = [];

    const response = await request(createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      sendTestAlert: async (message, targetId) => {
        sent.push({ message, targetId });
      }
    }))
      .post("/api/settings/alerts/test")
      .send({
        enabled: true,
        wechatRoomId: "",
        wechatRecipients: [
          {
            id: "recipient-1",
            contactId: "legacy@im.wechat",
            label: "Legacy",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z"
          }
        ],
        wechatAccounts: [
          {
            id: "account-1",
            label: "One",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z",
            botUserId: "bot-one@im.wechat",
            alertTargetUserId: "one@im.wechat"
          },
          {
            id: "account-2",
            label: "Two",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z",
            botUserId: "bot-two@im.wechat",
            alertTargetUserId: "two@im.wechat"
          },
          {
            id: "account-3",
            label: "Pending",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z",
            botUserId: "pending@im.wechat",
            alertTargetUserId: null
          }
        ],
        cooldownMinutes: 15,
        language: "en"
      });

    expect(response.status).toBe(202);
    expect(response.body.targetCount).toBe(2);
    expect(sent.map((item) => item.targetId)).toEqual(["account-1", "account-2"]);
    expect(sent[0]?.message).toContain("Server Monitor test alert");
  });

  it("sends a Chinese test alert when alert language is zh", async () => {
    const sent: string[] = [];

    const response = await request(createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      sendTestAlert: async (message) => {
        sent.push(message);
      }
    }))
      .post("/api/settings/alerts/test")
      .send({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 15, language: "zh" });

    expect(response.status).toBe(202);
    expect(sent[0]).toContain("Server Monitor 测试告警");
    expect(sent[0]).toContain("时间:");
    expect(sent[0]).toContain("WeChat 离线告警已配置成功");
  });

  it("returns WeChat connector status", async () => {
    const response = await request(createApp({
      db,
      refreshService: service,
      getWeChatStatus: () => ({
        started: true,
        loggedIn: true,
        polling: true,
        ready: true,
        qrUrl: null,
        awaitingQr: false,
        botUserId: "bot@im.wechat",
        storedSession: {
          available: true,
          botUserId: "bot@im.wechat",
          savedAt: "2026-05-20T10:00:00.000Z",
          contextUserIds: ["12345@chatroom"],
          verifiedForTarget: true
        },
        lastError: null,
        messageCount: 1,
        lastMessageAt: "2026-05-20T10:00:00.000Z",
        recentChats: [
          { userId: "12345@chatroom", text: "setup", receivedAt: "2026-05-20T10:00:00.000Z" }
        ],
        target: {
          userId: "12345@chatroom",
          lastInboundAt: "2026-05-20T10:00:00.000Z",
          lastSendSuccessAt: "2026-05-20T10:05:00.000Z",
          lastSendFailureAt: null,
          lastSendFailureCode: null
        },
        delivery: { phase: "ready", severity: "success" }
      })
    })).get("/api/settings/wechat");

    expect(response.status).toBe(200);
    expect(response.body.loggedIn).toBe(true);
    expect(response.body.storedSession.available).toBe(true);
    expect(response.body.recentChats[0].userId).toBe("12345@chatroom");
  });

  it("returns WeChat account status list", async () => {
    const response = await request(createApp({
      db,
      refreshService: service,
      getWeChatAccountsStatus: () => ({
        accounts: [
          {
            id: "account-1",
            label: "Ops owner",
            enabled: true,
            addedAt: "2026-05-20T10:00:00.000Z",
            botUserId: "bot@im.wechat",
            alertTargetUserId: "owner@im.wechat",
            storageDir: "/tmp/wechat-account",
            verified: true,
            connector: {
              started: true,
              loggedIn: true,
              polling: true,
              ready: true,
              qrUrl: null,
              awaitingQr: false,
              botUserId: "bot@im.wechat",
              storedSession: {
                available: true,
                botUserId: "bot@im.wechat",
                savedAt: "2026-05-20T10:00:00.000Z",
                contextUserIds: ["owner@im.wechat"],
                verifiedForTarget: true
              },
              lastError: null,
              messageCount: 1,
              lastMessageAt: "2026-05-20T10:00:00.000Z",
              recentChats: [],
              target: null,
              delivery: { phase: "ready", severity: "success" }
            }
          }
        ],
        activeLoginAccountId: null,
        enabledCount: 1,
        verifiedCount: 1
      })
    })).get("/api/settings/wechat/accounts");

    expect(response.status).toBe(200);
    expect(response.body.accounts[0].label).toBe("Ops owner");
    expect(response.body.verifiedCount).toBe(1);
  });

  it("creates a WeChat account and starts a QR login flow", async () => {
    const createWeChatAccount = vi.fn(async () => ({
      id: "account-1",
      label: "WeChat 1",
      enabled: true,
      addedAt: "2026-05-20T10:00:00.000Z",
      botUserId: null,
      alertTargetUserId: null,
      storageDir: "/tmp/wechat-account",
      verified: false,
      connector: {
        started: true,
        loggedIn: false,
        polling: false,
        ready: false,
        qrUrl: "https://example.com/qr",
        awaitingQr: true,
        botUserId: null,
        storedSession: {
          available: false,
          botUserId: null,
          savedAt: null,
          contextUserIds: [],
          verifiedForTarget: false
        },
        lastError: null,
        messageCount: 0,
        lastMessageAt: null,
        recentChats: [],
        target: null,
        delivery: { phase: "awaiting_qr" as const, severity: "warning" as const }
      }
    }));
    const getWeChatAccountsStatus = () => ({
      accounts: [
        {
          id: "account-1",
          label: "WeChat 1",
          enabled: true,
          addedAt: "2026-05-20T10:00:00.000Z",
          botUserId: null,
          alertTargetUserId: null,
          storageDir: "/tmp/wechat-account",
          verified: false,
          connector: {
            started: true,
            loggedIn: false,
            polling: false,
            ready: false,
            qrUrl: "https://example.com/qr",
            awaitingQr: true,
            botUserId: null,
            storedSession: {
              available: false,
              botUserId: null,
              savedAt: null,
              contextUserIds: [],
              verifiedForTarget: false
            },
            lastError: null,
            messageCount: 0,
            lastMessageAt: null,
            recentChats: [],
            target: null,
            delivery: { phase: "awaiting_qr" as const, severity: "warning" as const }
          }
        }
      ],
      activeLoginAccountId: "account-1",
      enabledCount: 1,
      verifiedCount: 0
    });

    const response = await request(createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      createWeChatAccount,
      getWeChatAccountsStatus
    }))
      .post("/api/settings/wechat/accounts")
      .send({});

    expect(response.status).toBe(201);
    expect(createWeChatAccount).toHaveBeenCalledTimes(1);
    expect(response.body.account.connector.qrUrl).toBe("https://example.com/qr");
    expect(response.body.wechatAccounts.activeLoginAccountId).toBe("account-1");
  });

  it("starts the WeChat connector", async () => {
    const startAlertConnector = vi.fn();
    const response = await request(createApp({
      db,
      refreshService: service,
      startAlertConnector,
      getWeChatStatus: () => ({
        started: true,
        loggedIn: false,
        polling: false,
        ready: false,
        qrUrl: "https://example.com/qr",
        awaitingQr: true,
        botUserId: null,
        storedSession: {
          available: false,
          botUserId: null,
          savedAt: null,
          contextUserIds: [],
          verifiedForTarget: false
        },
        lastError: null,
        messageCount: 0,
        lastMessageAt: null,
        recentChats: [],
        target: null,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      })
    })).post("/api/settings/wechat/start");

    expect(response.status).toBe(202);
    expect(startAlertConnector).toHaveBeenCalledTimes(1);
    expect(response.body.accepted).toBe(true);
  });

  it("refreshes the WeChat login QR code", async () => {
    const refreshWeChatConnector = vi.fn();
    const response = await request(createApp({
      db,
      refreshService: service,
      refreshWeChatConnector
    })).post("/api/settings/wechat/qr/refresh");

    expect(response.status).toBe(202);
    expect(refreshWeChatConnector).toHaveBeenCalledTimes(1);
    expect(response.body.accepted).toBe(true);
  });

  it("restores a stored WeChat session", async () => {
    const restoreAlertConnector = vi.fn();
    const response = await request(createApp({
      db,
      refreshService: service,
      restoreAlertConnector,
      getWeChatStatus: () => ({
        started: true,
        loggedIn: true,
        polling: true,
        ready: true,
        qrUrl: null,
        awaitingQr: false,
        botUserId: "bot@im.wechat",
        storedSession: {
          available: true,
          botUserId: "bot@im.wechat",
          savedAt: "2026-05-20T10:00:00.000Z",
          contextUserIds: ["123@im.wechat"],
          verifiedForTarget: true
        },
        lastError: null,
        messageCount: 0,
        lastMessageAt: null,
        recentChats: [],
        target: null,
        delivery: { phase: "awaiting_context", severity: "warning" }
      })
    })).post("/api/settings/wechat/restore");

    expect(response.status).toBe(200);
    expect(restoreAlertConnector).toHaveBeenCalledTimes(1);
    expect(response.body.loggedIn).toBe(true);
  });

  it("logs out the WeChat connector", async () => {
    const logoutWeChatConnector = vi.fn();
    const response = await request(createApp({
      db,
      refreshService: service,
      logoutWeChatConnector,
      getWeChatStatus: () => ({
        started: false,
        loggedIn: false,
        polling: false,
        ready: false,
        qrUrl: null,
        awaitingQr: false,
        botUserId: null,
        storedSession: {
          available: false,
          botUserId: null,
          savedAt: null,
          contextUserIds: [],
          verifiedForTarget: false
        },
        lastError: null,
        messageCount: 0,
        lastMessageAt: null,
        recentChats: [],
        target: null,
        delivery: { phase: "bot_offline", severity: "warning" }
      })
    })).post("/api/settings/wechat/logout");

    expect(response.status).toBe(200);
    expect(logoutWeChatConnector).toHaveBeenCalledTimes(1);
    expect(response.body.loggedIn).toBe(false);
  });

  it("switches the WeChat account", async () => {
    const switchWeChatConnector = vi.fn();
    const response = await request(createApp({
      db,
      refreshService: service,
      switchWeChatConnector,
      getWeChatStatus: () => ({
        started: true,
        loggedIn: false,
        polling: false,
        ready: false,
        qrUrl: "https://example.com/qr",
        awaitingQr: true,
        botUserId: null,
        storedSession: {
          available: false,
          botUserId: null,
          savedAt: null,
          contextUserIds: [],
          verifiedForTarget: false
        },
        lastError: null,
        messageCount: 0,
        lastMessageAt: null,
        recentChats: [],
        target: null,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      })
    })).post("/api/settings/wechat/switch");

    expect(response.status).toBe(202);
    expect(switchWeChatConnector).toHaveBeenCalledTimes(1);
    expect(response.body.accepted).toBe(true);
  });

  it("updates a recipient contact id and display label", async () => {
    fs.writeFileSync(alertSettingsPath, JSON.stringify({
      enabled: true,
      wechatRoomId: "old@im.wechat",
      wechatRecipients: [
        {
          id: "recipient-1",
          contactId: "old@im.wechat",
          label: "Old",
          enabled: true,
          addedAt: "2026-05-20T10:00:00.000Z"
        }
      ],
      cooldownMinutes: 15,
      language: "en"
    }));

    const response = await request(createApp({ db, refreshService: service, alertSettingsPath }))
      .patch("/api/settings/alerts/recipients/recipient-1")
      .send({ contactId: "new@im.wechat", label: "New owner" });

    expect(response.status).toBe(200);
    expect(response.body.recipient).toMatchObject({
      id: "recipient-1",
      contactId: "new@im.wechat",
      label: "New owner",
      enabled: true
    });
    expect(response.body.settings.wechatRoomId).toBe("new@im.wechat");
  });

  it("requires a logged-in WeChat bot before adding recipients when status is available", async () => {
    const response = await request(createApp({
      db,
      refreshService: service,
      alertSettingsPath,
      getWeChatStatus: () => ({
        started: true,
        loggedIn: false,
        polling: false,
        ready: false,
        qrUrl: "https://example.com/qr",
        awaitingQr: true,
        botUserId: null,
        storedSession: {
          available: false,
          botUserId: null,
          savedAt: null,
          contextUserIds: [],
          verifiedForTarget: false
        },
        lastError: null,
        messageCount: 0,
        lastMessageAt: null,
        recentChats: [],
        target: null,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      })
    }))
      .post("/api/settings/alerts/recipients")
      .send({ contactId: "new@im.wechat", label: "New" });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("wechat_login_required");
  });
});
