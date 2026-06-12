import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/shared/types";
import {
  buildPipelineSnapshot,
  collectServerPipelineStatus,
  derivePipelineDisplayStatus,
  parsePipelineCollectorOutput
} from "../../src/server/pipelineStatusCollector";

const server: ServerConfig = {
  id: "solver-01",
  name: "Solver 01",
  host: "10.0.0.1",
  port: 22,
  enabled: true,
  note: "TBD"
};

const runningJson = {
  status: "running",
  phase: "solving",
  repo_id: "Tsumugii/sia-45-sod-40",
  dataset_name: "sia-45-sod-40",
  scenario: "sia-sod",
  current_batch: 2,
  total_batches: 5,
  total_tasks: 25,
  batch_expr: "6-10",
  pid: 12345,
  started_at: "2026-06-13T10:00:00Z",
  updated_at: "2026-06-13T10:05:00Z",
  command: "python run_pipeline.py 1-25 --repo-id Tsumugii/sia-45-sod-40"
};

function collectorOutput(options: {
  available?: boolean;
  processAlive?: boolean;
  json?: Record<string, unknown>;
}): string {
  if (options.available === false) {
    return "PIPELINE_AVAILABLE=false\n";
  }

  const lines = [
    "PIPELINE_AVAILABLE=true",
    `PIPELINE_PROCESS_ALIVE=${options.processAlive === false ? "false" : "true"}`,
    "PIPELINE_JSON_BEGIN",
    JSON.stringify(options.json ?? runningJson),
    "PIPELINE_JSON_END"
  ];
  return `${lines.join("\n")}\n`;
}

describe("parsePipelineCollectorOutput", () => {
  it("returns unavailable state when status file is missing", () => {
    const parsed = parsePipelineCollectorOutput("PIPELINE_AVAILABLE=false\n");
    expect(parsed).toEqual({ available: false, processAlive: null, raw: null });
  });

  it("parses JSON payload and process liveness", () => {
    const parsed = parsePipelineCollectorOutput(collectorOutput({ processAlive: true }));
    expect(parsed.available).toBe(true);
    expect(parsed.processAlive).toBe(true);
    expect(parsed.raw?.repo_id).toBe("Tsumugii/sia-45-sod-40");
  });
});

describe("buildPipelineSnapshot", () => {
  it("maps running pipeline fields and display status", () => {
    const snapshot = buildPipelineSnapshot(
      server.id,
      parsePipelineCollectorOutput(collectorOutput({ processAlive: true }))
    );

    expect(snapshot.available).toBe(true);
    expect(snapshot.displayStatus).toBe("solving");
    expect(snapshot.repoId).toBe("Tsumugii/sia-45-sod-40");
    expect(snapshot.currentBatch).toBe(2);
    expect(snapshot.totalBatches).toBe(5);
  });

  it("marks stale when file says running but process is dead", () => {
    const snapshot = buildPipelineSnapshot(
      server.id,
      parsePipelineCollectorOutput(collectorOutput({ processAlive: false }))
    );

    expect(snapshot.displayStatus).toBe("stale");
  });

  it("returns idle when status file is absent", () => {
    const snapshot = buildPipelineSnapshot(
      server.id,
      parsePipelineCollectorOutput(collectorOutput({ available: false }))
    );

    expect(snapshot.displayStatus).toBe("idle");
    expect(snapshot.available).toBe(false);
  });
});

describe("derivePipelineDisplayStatus", () => {
  it("prefers phase while running", () => {
    expect(derivePipelineDisplayStatus("running", true, "uploading")).toBe("uploading");
  });
});

describe("collectServerPipelineStatus", () => {
  it("collects pipeline status over SSH", async () => {
    const snapshot = await collectServerPipelineStatus(
      server,
      { username: "root", password: "secret" },
      "~/run/solver_running_status.json",
      { run: async () => collectorOutput({ processAlive: true }) }
    );

    expect(snapshot.displayStatus).toBe("solving");
    expect(snapshot.scenario).toBe("sia-sod");
  });

  it("returns unavailable snapshot when SSH fails", async () => {
    const snapshot = await collectServerPipelineStatus(
      server,
      { username: "root", password: "bad" },
      "~/run/solver_running_status.json",
      {
        run: async () => {
          throw new Error("Connection failed");
        }
      }
    );

    expect(snapshot.displayStatus).toBe("unavailable");
    expect(snapshot.errorCode).toBe("connect_failed");
  });
});
