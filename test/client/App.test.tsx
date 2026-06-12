// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/client/App";

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
            qrUrl: null,
            lastError: null,
            messageCount: 1,
            lastMessageAt: "2026-05-12T00:00:00.000Z",
            recentChats: [
              { userId: "12345@chatroom", text: "monitor setup", receivedAt: "2026-05-12T00:00:00.000Z" }
            ]
          });
        }
        if (url === "/api/settings/wechat/start" && init?.method === "POST") {
          return json({
            started: true,
            loggedIn: false,
            polling: false,
            qrUrl: "https://example.com/qr",
            lastError: null,
            messageCount: 0,
            lastMessageAt: null,
            recentChats: []
          }, 202);
        }
        if (url === "/api/settings/alerts") {
          if (init?.method === "PATCH") {
            return json({
              settings: JSON.parse(String(init.body)),
              status: { enabled: true, configured: true }
            });
          }
          return json({
            settings: { enabled: false, wechatRoomId: "", cooldownMinutes: 60, language: "en" },
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
    expect(await screen.findByText("Logged in and listening for group messages.")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /12345@chatroom/ }));
    await userEvent.click(await screen.findByLabelText("Enable WeChat offline alerts"));
    await userEvent.clear(screen.getByLabelText("Alert cooldown minutes"));
    await userEvent.type(screen.getByLabelText("Alert cooldown minutes"), "15");
    await userEvent.selectOptions(screen.getByLabelText("Alert language"), "zh");
    await userEvent.click(screen.getByRole("button", { name: "Save alert settings" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/alerts",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: true, wechatRoomId: "12345@chatroom", cooldownMinutes: 15, language: "zh" })
        })
      )
    );
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
