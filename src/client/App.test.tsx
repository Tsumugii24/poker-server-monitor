// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const overview = {
  generatedAt: "2026-05-12T00:00:00.000Z",
  refresh: { active: false, nextRefreshAt: "2026-05-12T01:00:00.000Z", lastRun: null },
  summary: {
    total: 2,
    online: 2,
    warning: 1,
    offline: 0,
    unknown: 0,
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
        status: "online",
        cpuUsedPercent: 20,
        memoryUsedPercent: 30,
        diskUsedPercent: 40,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptimeSeconds: 3600,
        errorCode: null,
        errorMessage: null
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
        status: "warning",
        cpuUsedPercent: 82,
        memoryUsedPercent: 70,
        diskUsedPercent: 66,
        load1: 2.1,
        load5: 2.2,
        load15: 2.3,
        uptimeSeconds: 7200,
        errorCode: null,
        errorMessage: null
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

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/overview") {
          return json(overview);
        }
        if (url === "/api/servers/prod-02") {
          return json(detail);
        }
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
  });

  it("renders macro overview, description, and server rows", async () => {
    render(<App />);

    expect(await screen.findByText("整体监控")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByText("Production 02")).toBeInTheDocument();
    expect(screen.getByText("2 of 2 servers online; 1 warning; none offline.")).toBeInTheDocument();
  });

  it("opens a server detail view from the server list", async () => {
    render(<App />);

    await userEvent.click(await screen.findByText("Production 02"));

    expect(await screen.findByText("Production 02 详情")).toBeInTheDocument();
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
