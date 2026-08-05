import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPreflopRanges,
  refreshPreflopRangeProgress
} from "../../src/server/preflopRangeStore";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  type ParallelSolverRun
} from "../../src/shared/solverJobs";
import { DEFAULT_SOLVER_SETTING_LIBRARY } from "../../src/shared/solverSettings";

const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
const datasetName = "3ia-4.2-3od-4.3";
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Range Library local progress", () => {
  it("derives Queue and Running from active Parallel runs", () => {
    const root = createApprovedRangeLibrary();
    const queuedRun = completedRun();
    queuedRun.status = "queued";
    queuedRun.startedAt = null;
    queuedRun.finishedAt = null;
    queuedRun.slices[0].status = "queued";
    queuedRun.slices[0].startedAt = null;
    queuedRun.slices[0].finishedAt = null;

    expect(firstFile(listPreflopRanges(root, { parallelRuns: [queuedRun] })).runStatus).toBe("queue");

    queuedRun.status = "running";
    queuedRun.startedAt = "2026-08-03T00:00:00.000Z";
    queuedRun.slices[0].status = "running";
    queuedRun.slices[0].startedAt = "2026-08-03T00:00:00.000Z";

    expect(firstFile(listPreflopRanges(root, { parallelRuns: [queuedRun] })).runStatus).toBe("running");
  });

  it("keeps remote progress unchanged and adds deduplicated local solve history", async () => {
    const root = createApprovedRangeLibrary();
    const run = completedRun();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://huggingface.co/api/datasets/") && !url.includes("/tree/main")) {
        return new Response(JSON.stringify({ id: `Tsumugii/${datasetName}` }), { status: 200 });
      }
      if (url.startsWith("https://datasets-server.huggingface.co/size")) {
        return new Response(JSON.stringify({ size: { dataset: { num_rows: 2 } } }), { status: 200 });
      }
      if (url.includes("/tree/main")) {
        return new Response(JSON.stringify([
          { path: "AcAd3c.parquet" },
          { path: "QhJdTs.parquet" }
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    await refreshPreflopRangeProgress(root, {
      repoNamespace: "Tsumugii",
      totalRows: 5,
      runtime: { parallelRuns: [run] }
    });
    const file = firstFile(listPreflopRanges(root, { parallelRuns: [run] }));

    expect(file.progress).toMatchObject({
      rows: 2,
      ratio: 2 / 5,
      localRows: 2,
      localOnlyRows: 1,
      localOverlapKnown: true,
      combinedRows: 3,
      combinedRatio: 3 / 5
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("derives a conservative local total before the next remote artifact listing", () => {
    const root = createApprovedRangeLibrary();
    fs.writeFileSync(path.join(root, ".range_progress.json"), JSON.stringify({
      version: 1,
      ranges: {
        [rangePath]: {
          datasetName,
          rows: 1,
          totalRows: 5,
          ratio: 0.2
        }
      }
    }));

    const file = firstFile(listPreflopRanges(root, { parallelRuns: [completedRun()] }));

    expect(file.progress).toMatchObject({
      rows: 1,
      localRows: 2,
      localOverlapKnown: false,
      combinedRows: 2,
      combinedRatio: 0.4
    });
  });
});

function createApprovedRangeLibrary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "range-local-progress-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "3OD-EP"), { recursive: true });
  fs.writeFileSync(path.join(root, rangePath), JSON.stringify({
    player_names: { A: "3OD-4.3", B: "3IA-4.2" },
    player_positions: { A: "OOP", B: "IP" },
    learned: true,
    A: { raise: "AA", call: "" },
    B: { raise: "KK", call: "" }
  }));
  fs.writeFileSync(path.join(root, ".range_status.json"), JSON.stringify({
    version: 1,
    ranges: {
      [rangePath]: {
        reviewStatus: "approved",
        runStatus: "idle",
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    }
  }));
  return root;
}

function completedRun(): ParallelSolverRun {
  const setting = DEFAULT_SOLVER_SETTING_LIBRARY.find((item) => item.id === "3ia-3od")!;
  return {
    id: "run-local",
    sourceType: "parallel",
    rangePath,
    rangeName: "3OD-4.3 vs 3IA-4.2.json",
    datasetName,
    repoId: `Tsumugii/${datasetName}`,
    settingId: setting.id,
    setting,
    scenario: setting.id,
    settings: DEFAULT_SOLVER_JOB_SETTINGS,
    solverRangeText: "AA",
    status: "completed",
    reportCleared: false,
    queueOrder: 0,
    serverIds: ["server-1"],
    autoIncludeNewServers: true,
    serverScope: "all",
    totalIndices: [1, 2],
    missingIndices: [1, 2],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:10:00.000Z",
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:10:00.000Z",
    lastError: null,
    slices: [{
      id: "slice-local",
      runId: "run-local",
      serverId: "server-1",
      candidateServerIds: ["server-1"],
      jobId: null,
      rangeExpr: "1-2",
      assignedIndices: [1, 2],
      assignedBoardNames: ["Ac,Ad,3c", "2h,3d,4s"],
      status: "completed",
      completedCount: 2,
      failedCount: 0,
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:10:00.000Z",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:10:00.000Z",
      lastError: null,
      job: null
    }],
    report: {
      totalBoards: 2,
      completedBoards: 2,
      failedBoards: 0,
      queuedBoards: 0,
      runningBoards: 0,
      successRate: 1,
      durationSeconds: 600
    }
  };
}

function firstFile(response: ReturnType<typeof listPreflopRanges>) {
  const folder = response.tree[0];
  if (!folder || folder.type !== "folder") throw new Error("Expected range folder");
  const file = folder.children[0];
  if (!file || file.type !== "file") throw new Error("Expected range file");
  return file;
}
