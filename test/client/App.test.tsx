// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/client/App";
import { defaultAlertSettingsFixture, enabledRecipientSettings } from "../fixtures/alertSettings";

const overview = {
  generatedAt: "2026-05-12T00:00:00.000Z",
  refresh: { active: false, nextRefreshAt: "2026-05-12T01:00:00.000Z", lastRun: null },
  summary: {
    total: 2,
    online: 2,
    offline: 0,
    unknown: 0,
    healthy: 1,
    warning: 1,
    dangerous: 0,
    averageCpu: 50,
    averageMemory: 55,
    averageDisk: 60,
    pipelineRunning: 1,
    pipelineIdle: 1,
    pipelineStale: 0
  },
  description: "2 of 2 servers online; 1 warning; none offline; 1 task running.",
  servers: [
    {
      id: "prod-01",
      name: "Production 01",
      host: "10.0.0.1",
      port: 22,
      enabled: true,
      note: "TBD",
      latest: {
        id: "snap-1",
        serverId: "prod-01",
        collectedAt: "2026-05-12T00:00:00.000Z",
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
        diskUsedBytes: 42949672960
      },
      pipeline: {
        id: "pipe-1",
        serverId: "prod-01",
        collectedAt: "2026-05-12T00:00:00.000Z",
        available: true,
        processAlive: true,
        fileStatus: "running",
        displayStatus: "solving",
        phase: "solving",
        repoId: "Tsumugii/sia-45-sod-40",
        datasetName: "sia-45-sod-40",
        scenario: "sia-sod",
        currentBatch: 2,
        totalBatches: 5,
        totalTasks: 25,
        batchExpr: "6-10",
        pid: 12345,
        startedAt: "2026-06-13T10:00:00Z",
        updatedAt: "2026-06-13T10:05:00Z",
        finishedAt: null,
        command: "python run_pipeline.py 1-25 --repo-id Tsumugii/sia-45-sod-40",
        error: null,
        errorCode: null,
        errorMessage: null
      },
      lastDatasetName: "sia-45-sod-40"
    },
    {
      id: "prod-02",
      name: "Production 02",
      host: "10.0.0.2",
      port: 22,
      enabled: true,
      note: "TBD",
      latest: {
        id: "snap-2",
        serverId: "prod-02",
        collectedAt: "2026-05-12T00:00:00.000Z",
        connectionStatus: "online",
        healthLevel: "warning",
        cpuUsedPercent: 82,
        memoryUsedPercent: 70,
        diskUsedPercent: 66,
        load1: 2.1,
        load5: 2.2,
        load15: 2.3,
        uptimeSeconds: 7200,
        errorCode: null,
        errorMessage: null,
        cpuModel: "AMD EPYC 7R32",
        cpuVcores: 8,
        memoryTotalBytes: 17179869184,
        memoryUsedBytes: 12025908429,
        diskTotalBytes: 214748364800,
        diskUsedBytes: 141733920358
      },
      pipeline: {
        id: "pipe-2",
        serverId: "prod-02",
        collectedAt: "2026-05-12T00:00:00.000Z",
        available: false,
        processAlive: null,
        fileStatus: null,
        displayStatus: "idle",
        phase: null,
        repoId: null,
        datasetName: null,
        scenario: null,
        currentBatch: null,
        totalBatches: null,
        totalTasks: null,
        batchExpr: null,
        pid: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        command: null,
        error: null,
        errorCode: null,
        errorMessage: null
      },
      lastDatasetName: "3ia-16.5-3od-13"
    }
  ],
  overallHistory: [
    { collectedAt: "2026-05-12T00:00:00.000Z", averageCpu: 50, averageMemory: 55, averageDisk: 60 }
  ]
};

const detail = {
  server: overview.servers[1],
  latest: overview.servers[1].latest,
  pipeline: overview.servers[1].pipeline,
  pipelineHistory: [overview.servers[1].pipeline],
  history: [overview.servers[1].latest]
};

const fakeStorage = new Map<string, string>();
const storageMock = {
  getItem: (key: string) => fakeStorage.get(key) ?? null,
  setItem: (key: string, value: string) => fakeStorage.set(key, value),
  removeItem: (key: string) => fakeStorage.delete(key),
  clear: () => fakeStorage.clear(),
  get length() { return fakeStorage.size; },
  key: () => null
};

const emptyWeChatAccountsStatus = {
  accounts: [],
  activeLoginAccountId: null,
  enabledCount: 0,
  verifiedCount: 0
};

function weChatAccountStatus(overrides: Record<string, unknown> = {}) {
  const connectorOverrides = (overrides.connector ?? {}) as Record<string, unknown>;
  const connector = {
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
    delivery: { phase: "bot_offline", severity: "warning" },
    ...connectorOverrides
  };
  return {
    id: "account-1",
    label: "WeChat 1",
    enabled: true,
    addedAt: "2026-05-20T10:00:00.000Z",
    botUserId: connector.botUserId,
    alertTargetUserId: null,
    storageDir: "/tmp/wechat-account-1",
    verified: false,
    ...overrides,
    connector
  };
}

function weChatAccountsStatus(accounts: Array<ReturnType<typeof weChatAccountStatus>>, activeLoginAccountId: string | null = null) {
  return {
    accounts,
    activeLoginAccountId,
    enabledCount: accounts.filter((account) => account.enabled).length,
    verifiedCount: accounts.filter((account) => account.enabled && account.verified).length
  };
}

describe("App", () => {
  beforeEach(() => {
    fakeStorage.clear();
    let currentOverview = structuredClone(overview);
    vi.stubGlobal("localStorage", storageMock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(currentOverview);
        if (url === "/api/settings/wechat") {
          return json({
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
              savedAt: "2026-05-12T00:00:00.000Z",
              contextUserIds: ["12345@chatroom"],
              verifiedForTarget: false
            },
            lastError: null,
            messageCount: 1,
            lastMessageAt: "2026-05-12T00:00:00.000Z",
            recentChats: [
              { userId: "12345@chatroom", text: "monitor setup", receivedAt: "2026-05-12T00:00:00.000Z" }
            ],
            target: {
              userId: "12345@chatroom",
              lastInboundAt: "2026-05-12T00:00:00.000Z",
              lastSendSuccessAt: "2026-05-12T00:05:00.000Z",
              lastSendFailureAt: null,
              lastSendFailureCode: null
            },
            delivery: { phase: "ready", severity: "success" }
          });
        }
        if (url === "/api/settings/wechat/start" && init?.method === "POST") {
          return json({
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
          }, 202);
        }
        if (url === "/api/settings/wechat/qr/refresh" && init?.method === "POST") {
          return json({ accepted: true }, 202);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(emptyWeChatAccountsStatus);
        }
        if (url === "/api/settings/alerts") {
          if (init?.method === "PATCH") {
            return json({
              settings: JSON.parse(String(init.body)),
              status: { enabled: true, configured: true }
            });
          }
          return json({
            settings: defaultAlertSettingsFixture,
            status: { enabled: false, configured: false }
          });
        }
        if (url === "/api/settings/alerts/test" && init?.method === "POST") {
          return json({ accepted: true });
        }
        if (url === "/api/servers/prod-02" && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { note: string };
          currentOverview = {
            ...currentOverview,
            servers: currentOverview.servers.map((server) =>
              server.id === "prod-02" ? { ...server, note: body.note } : server
            )
          };
          return json({ ...currentOverview.servers[1], note: body.note });
        }
        if (url === "/api/servers/prod-02") return json(detail);
        if (url === "/api/refresh" && init?.method === "POST") {
          return json({ accepted: true, state: overview.refresh });
        }
        return json({}, 404);
      })
    );
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders the overview dashboard with summary cards and server rows", async () => {
    render(<App />);

    expect(await screen.findByText("Dashboard Overview")).toBeInTheDocument();
    expect(screen.getByText("Overall Trends Within 24 Hours")).toBeInTheDocument();
    expect(document.querySelectorAll(".chart-point")).toHaveLength(3);
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByText("sia-45-sod-40")).toBeInTheDocument();
    expect(screen.getAllByText("TBD").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("2 of 2 servers online; 1 warning; none offline; 1 task running.")).toBeInTheDocument();
  });

  it("shows separate Status and Health columns in the server table", async () => {
    render(<App />);

    expect(await screen.findByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Health")).toBeInTheDocument();
    expect(screen.getAllByText("Task").length).toBeGreaterThanOrEqual(2);
    // Both servers are online
    const onlineBadges = screen.getAllByText("online");
    expect(onlineBadges.length).toBe(2);
    // One healthy, one warning
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();
  });

  it("shows port column in the server table", async () => {
    render(<App />);

    expect(await screen.findByText("Port")).toBeInTheDocument();
    const portCells = screen.getAllByText("22");
    expect(portCells.length).toBeGreaterThanOrEqual(2);
  });

  it("shows server id as the first inventory column", async () => {
    render(<App />);

    expect(await screen.findByRole("columnheader", { name: "ID" })).toBeInTheDocument();
    expect(screen.getByText("prod-01")).toBeInTheDocument();
    expect(screen.getByText("prod-02")).toBeInTheDocument();
  });

  it("toggles server inventory sorting by id", async () => {
    render(<App />);

    const idSort = await screen.findByRole("button", { name: "Sort by ID descending" });
    expect(inventoryIds()).toEqual(["prod-01", "prod-02"]);

    await userEvent.click(idSort);
    expect(inventoryIds()).toEqual(["prod-02", "prod-01"]);

    await userEvent.click(screen.getByRole("button", { name: "Sort by ID ascending" }));
    expect(inventoryIds()).toEqual(["prod-01", "prod-02"]);
  });

  it("shows dataset name in the inventory name column", async () => {
    render(<App />);

    expect(await screen.findByText("sia-45-sod-40")).toBeInTheDocument();
    expect(screen.getByText("3ia-16.5-3od-13")).toBeInTheDocument();
    expect(document.querySelectorAll(".server-dataset-name.has-dataset")).toHaveLength(2);
  });

  it("edits a server note inline and persists it", async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Edit note for prod-02" }));
    const input = screen.getByLabelText("Server note for prod-02");
    await userEvent.clear(input);
    await userEvent.type(input, "Poker Gateway{Enter}");

    expect(await screen.findByRole("button", { name: "Edit note for prod-02" })).toHaveTextContent("Poker Gateway");
    expect(fetch).toHaveBeenCalledWith(
      "/api/servers/prod-02",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ note: "Poker Gateway" })
      })
    );
  });

  it("opens settings and saves WeChat alert settings", async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByText("WeChat Alert Settings")).toBeInTheDocument();
    expect(await screen.findByText("Alert Recipients")).toBeInTheDocument();

    const [cooldownInput] = screen.getAllByRole("spinbutton");
    await userEvent.clear(cooldownInput);
    await userEvent.type(cooldownInput, "15");
    await userEvent.selectOptions(screen.getByRole("combobox"), "zh");
    await userEvent.click(await screen.findByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/alerts",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"cooldownMinutes":15')
        })
      )
    );
  });

  it("shows a waiting state before the QR URL arrives", async () => {
    const pendingAccount = weChatAccountStatus({
      connector: {
        started: true,
        loggedIn: false,
        qrUrl: null,
        awaitingQr: true,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      }
    });
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: enabledRecipientSettings({ language: "zh", wechatRoomId: "123@im.wechat", wechatRecipients: [{
              id: "recipient-1",
              contactId: "123@im.wechat",
              label: "123@im.wechat",
              enabled: true,
              addedAt: "2026-05-20T10:00:00.000Z"
            }] }),
            status: { enabled: true, configured: true }
          });
        }
        if (url === "/api/settings/wechat/accounts" && init?.method === "POST") {
          created = true;
          return json({
            account: pendingAccount,
            settings: enabledRecipientSettings({ language: "zh" }),
            status: { enabled: true, configured: false },
            wechatAccounts: weChatAccountsStatus([pendingAccount], "account-1")
          }, 201);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(created ? weChatAccountsStatus([pendingAccount], "account-1") : emptyWeChatAccountsStatus);
        }
        if (url === "/api/settings/wechat") {
          return json({
            started: true,
            loggedIn: false,
            polling: false,
            ready: false,
            qrUrl: null,
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
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    expect(await screen.findByText("正在获取登录二维码…")).toBeInTheDocument();
  });

  it("shows the WeChat login QR code in settings while waiting for scan", async () => {
    const qrAccount = weChatAccountStatus({
      connector: {
        started: true,
        loggedIn: false,
        qrUrl: "https://liteapp.weixin.qq.com/q/test",
        awaitingQr: true,
        target: {
          userId: "123@im.wechat",
          lastInboundAt: null,
          lastSendSuccessAt: null,
          lastSendFailureAt: null,
          lastSendFailureCode: null
        },
        delivery: { phase: "awaiting_qr", severity: "warning" }
      }
    });
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: enabledRecipientSettings({ language: "zh", wechatRoomId: "123@im.wechat", wechatRecipients: [{
              id: "recipient-1",
              contactId: "123@im.wechat",
              label: "123@im.wechat",
              enabled: true,
              addedAt: "2026-05-20T10:00:00.000Z"
            }] }),
            status: { enabled: true, configured: true }
          });
        }
        if (url === "/api/settings/wechat/accounts" && init?.method === "POST") {
          created = true;
          return json({
            account: qrAccount,
            settings: enabledRecipientSettings({ language: "zh" }),
            status: { enabled: true, configured: false },
            wechatAccounts: weChatAccountsStatus([qrAccount], "account-1")
          }, 201);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(created ? weChatAccountsStatus([qrAccount], "account-1") : emptyWeChatAccountsStatus);
        }
        if (url === "/api/settings/wechat") {
          return json({
            started: true,
            loggedIn: false,
            polling: false,
            ready: false,
            qrUrl: "https://liteapp.weixin.qq.com/q/test",
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
            target: {
              userId: "123@im.wechat",
              lastInboundAt: null,
              lastSendSuccessAt: null,
              lastSendFailureAt: null,
              lastSendFailureCode: null
            },
            delivery: { phase: "awaiting_qr", severity: "warning" }
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    expect(await screen.findByAltText("微信登录二维码")).toBeInTheDocument();
    expect(screen.getByText("微信扫码登录 Bot")).toBeInTheDocument();
  });

  it("manually refreshes the WeChat login QR code from settings", async () => {
    const qrAccount = weChatAccountStatus({
      connector: {
        started: true,
        loggedIn: false,
        qrUrl: "https://liteapp.weixin.qq.com/q/test",
        awaitingQr: true,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      }
    });
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: enabledRecipientSettings({ language: "zh", wechatRoomId: "123@im.wechat", wechatRecipients: [{
              id: "recipient-1",
              contactId: "123@im.wechat",
              label: "123@im.wechat",
              enabled: true,
              addedAt: "2026-05-20T10:00:00.000Z"
            }] }),
            status: { enabled: true, configured: true }
          });
        }
        if (url === "/api/settings/wechat/accounts" && init?.method === "POST") {
          created = true;
          return json({
            account: qrAccount,
            settings: enabledRecipientSettings({ language: "zh" }),
            status: { enabled: true, configured: false },
            wechatAccounts: weChatAccountsStatus([qrAccount], "account-1")
          }, 201);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(created ? weChatAccountsStatus([qrAccount], "account-1") : emptyWeChatAccountsStatus);
        }
        if (url === "/api/settings/wechat/accounts/account-1/qr/refresh" && init?.method === "POST") {
          return json({
            accepted: true,
            account: qrAccount,
            wechatAccounts: weChatAccountsStatus([qrAccount], "account-1")
          }, 202);
        }
        if (url === "/api/settings/wechat") {
          return json({
            started: true,
            loggedIn: false,
            polling: false,
            ready: false,
            qrUrl: "https://liteapp.weixin.qq.com/q/test",
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
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    const refreshButtons = await screen.findAllByRole("button", { name: "刷新二维码" });
    await userEvent.click(refreshButtons[1]);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/wechat/accounts/account-1/qr/refresh",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("opens the QR connection tab when adding recipients before bot login", async () => {
    const qrAccount = weChatAccountStatus({
      connector: {
        started: true,
        loggedIn: false,
        qrUrl: "https://liteapp.weixin.qq.com/q/test",
        awaitingQr: true,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      }
    });
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: defaultAlertSettingsFixture,
            status: { enabled: false, configured: false }
          });
        }
        if (url === "/api/settings/wechat/accounts" && init?.method === "POST") {
          created = true;
          return json({
            account: qrAccount,
            settings: defaultAlertSettingsFixture,
            status: { enabled: false, configured: false },
            wechatAccounts: weChatAccountsStatus([qrAccount], "account-1")
          }, 201);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(created ? weChatAccountsStatus([qrAccount], "account-1") : emptyWeChatAccountsStatus);
        }
        if (url === "/api/settings/wechat") {
          return json({
            started: true,
            loggedIn: false,
            polling: false,
            ready: false,
            qrUrl: "https://liteapp.weixin.qq.com/q/test",
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
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(await screen.findByText("No recipients configured yet.")).toBeInTheDocument();
    expect(screen.queryByAltText("WeChat login QR code")).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Add" }));

    expect(await screen.findByAltText("WeChat login QR code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connection" })).toHaveClass("active");
  });

  it("creates a new QR login when adding a second recipient account", async () => {
    const firstAccount = weChatAccountStatus({
      id: "account-1",
      label: "First recipient",
      botUserId: "first-bot@im.wechat",
      alertTargetUserId: "first@im.wechat",
      verified: true,
      connector: {
        started: true,
        loggedIn: true,
        polling: true,
        ready: true,
        botUserId: "first-bot@im.wechat",
        storedSession: {
          available: true,
          botUserId: "first-bot@im.wechat",
          savedAt: "2026-05-20T10:00:00.000Z",
          contextUserIds: ["first@im.wechat"],
          verifiedForTarget: true
        },
        delivery: { phase: "ready", severity: "success" }
      }
    });
    const secondAccount = weChatAccountStatus({
      id: "account-2",
      label: "WeChat 2",
      connector: {
        started: true,
        loggedIn: false,
        qrUrl: "https://liteapp.weixin.qq.com/q/second",
        awaitingQr: true,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      }
    });
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: enabledRecipientSettings({
              wechatAccounts: [firstAccount]
            }),
            status: { enabled: true, configured: true }
          });
        }
        if (url === "/api/settings/wechat/accounts" && init?.method === "POST") {
          created = true;
          return json({
            settings: enabledRecipientSettings({
              wechatAccounts: [firstAccount, secondAccount]
            }),
            status: { enabled: true, configured: true },
            account: secondAccount,
            wechatAccounts: weChatAccountsStatus([firstAccount, secondAccount], "account-2")
          }, 201);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(created
            ? weChatAccountsStatus([firstAccount, secondAccount], "account-2")
            : weChatAccountsStatus([firstAccount]));
        }
        if (url === "/api/settings/wechat") {
          return json({
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
              contextUserIds: ["first@im.wechat"],
              verifiedForTarget: true
            },
            lastError: null,
            messageCount: 1,
            lastMessageAt: "2026-05-20T10:00:00.000Z",
            recentChats: [
              { userId: "second@im.wechat", text: "setup", receivedAt: "2026-05-20T10:01:00.000Z" },
              { userId: "first@im.wechat", text: "setup", receivedAt: "2026-05-20T10:00:00.000Z" }
            ],
            target: null,
            delivery: { phase: "ready", severity: "success" }
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(await screen.findByText("First recipient")).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/wechat/accounts",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByAltText("WeChat login QR code")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/settings/alerts/recipients",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows the verification guide with detected WeChat messages", async () => {
    const pendingAccount = weChatAccountStatus({
      id: "account-1",
      label: "WeChat 1",
      connector: {
        started: true,
        loggedIn: true,
        polling: true,
        ready: true,
        botUserId: "bot-one@im.wechat",
        storedSession: {
          available: true,
          botUserId: "bot-one@im.wechat",
          savedAt: "2026-05-20T10:00:00.000Z",
          contextUserIds: ["owner@im.wechat"],
          verifiedForTarget: false
        },
        messageCount: 1,
        lastMessageAt: "2026-05-20T10:02:00.000Z",
        recentChats: [
          { userId: "owner@im.wechat", text: "verify me", receivedAt: "2026-05-20T10:02:00.000Z" }
        ],
        delivery: { phase: "context_unverified", severity: "warning" }
      }
    });
    const verifiedAccount = {
      ...pendingAccount,
      alertTargetUserId: "owner@im.wechat",
      verified: true
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: enabledRecipientSettings({ wechatAccounts: [pendingAccount] }),
            status: { enabled: true, configured: false }
          });
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(weChatAccountsStatus([pendingAccount], "account-1"));
        }
        if (url === "/api/settings/wechat/accounts/account-1/verify" && init?.method === "POST") {
          return json({
            account: verifiedAccount,
            settings: enabledRecipientSettings({ wechatAccounts: [verifiedAccount] }),
            status: { enabled: true, configured: true },
            wechatAccounts: weChatAccountsStatus([verifiedAccount])
          });
        }
        if (url === "/api/settings/wechat") {
          return json({
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
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));

    expect(await screen.findByText("Verify message token")).toBeInTheDocument();
    expect(screen.getAllByText("verify me").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("owner@im.wechat").length).toBeGreaterThanOrEqual(1);

    await userEvent.click(screen.getByRole("button", { name: "Verify recipient" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/wechat/accounts/account-1/verify",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ targetUserId: "owner@im.wechat" })
        })
      );
    });
  });

  it("starts a new QR login when adding recipients from a disconnected state", async () => {
    const qrAccount = weChatAccountStatus({
      connector: {
        started: true,
        loggedIn: false,
        qrUrl: "https://liteapp.weixin.qq.com/q/test",
        awaitingQr: true,
        delivery: { phase: "awaiting_qr", severity: "warning" }
      }
    });
    let accountCreated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
        if (url === "/api/settings/alerts") {
          return json({
            settings: defaultAlertSettingsFixture,
            status: { enabled: false, configured: false }
          });
        }
        if (url === "/api/settings/wechat/accounts" && init?.method === "POST") {
          accountCreated = true;
          return json({
            account: qrAccount,
            settings: defaultAlertSettingsFixture,
            status: { enabled: false, configured: false },
            wechatAccounts: weChatAccountsStatus([qrAccount], "account-1")
          }, 201);
        }
        if (url === "/api/settings/wechat/accounts") {
          return json(accountCreated ? weChatAccountsStatus([qrAccount], "account-1") : emptyWeChatAccountsStatus);
        }
        if (url === "/api/settings/wechat") {
          return json({
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
          });
        }
        return json({}, 404);
      })
    );

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/wechat/accounts",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByAltText("WeChat login QR code")).toBeInTheDocument();
  });

  it("toggles between dark and light themes", async () => {
    render(<App />);

    const toggle = await screen.findByLabelText("Switch to light mode");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    await userEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens a server detail view from the server list", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("10.0.0.2"));

    expect(await screen.findByText("Production 02 Details")).toBeInTheDocument();
    expect(screen.getByText("CPU 24h")).toBeInTheDocument();
  });
});

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function inventoryIds(): string[] {
  return Array.from(document.querySelectorAll(".server-id-value")).map((node) => node.textContent ?? "");
}
