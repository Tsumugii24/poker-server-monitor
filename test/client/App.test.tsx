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
    averageDisk: 60
  },
  description: "2 of 2 servers online; 1 warning; none offline.",
  servers: [
    {
      id: "prod-01",
      name: "Production 01",
      host: "10.0.0.1",
      port: 22,
      enabled: true,
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
      }
    },
    {
      id: "prod-02",
      name: "Production 02",
      host: "10.0.0.2",
      port: 22,
      enabled: true,
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
      }
    }
  ],
  overallHistory: [
    { collectedAt: "2026-05-12T00:00:00.000Z", averageCpu: 50, averageMemory: 55, averageDisk: 60 }
  ]
};

const detail = {
  server: overview.servers[1],
  latest: overview.servers[1].latest,
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
    vi.stubGlobal("localStorage", storageMock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") return json(overview);
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
    expect(screen.getByText("Production 02")).toBeInTheDocument();
    expect(screen.getByText("2 of 2 servers online; 1 warning; none offline.")).toBeInTheDocument();
  });

  it("shows separate Status and Health columns in the server table", async () => {
    render(<App />);

    expect(await screen.findByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Health")).toBeInTheDocument();
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

  it("toggles between dark and light themes", async () => {
    render(<App />);

    const toggle = await screen.findByLabelText("Switch to light mode");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    await userEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens a server detail view from the server list", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("Production 02"));

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
