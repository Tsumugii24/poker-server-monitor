import { describe, expect, it } from "vitest";
import { DEFAULT_SOLVER_JOB_SETTINGS } from "../../src/shared/solverJobs";
import {
  collectCompletedBoardIndicesFromRun,
  collectRetryableFailurePoolBoardIndices,
  computeMissingSolveBoardIndices
} from "../../src/shared/solverCoverage";
import type { ParallelFailurePoolEntry, ParallelSolverRun, ParallelSolverSlice } from "../../src/shared/solverJobs";

const rangePath = "3OD-EP/3OD-4.3 vs 3IA-4.2.json";
const datasetName = "3ia-4.2-3od-4.3";
const allBoards = ["AhKhQhJh", "2c3c4c5c", "9s9h9d9c", "AsKsQsJs", "7h7d7c7s"];

function makeSlice(overrides: Partial<ParallelSolverSlice> & Pick<ParallelSolverSlice, "id" | "assignedIndices" | "status">): ParallelSolverSlice {
  return {
    runId: "run-1",
    serverId: "solver-01",
    candidateServerIds: ["solver-01"],
    jobId: "job-1",
    rangeExpr: overrides.assignedIndices.join(","),
    assignedBoardNames: overrides.assignedIndices.map(String),
    completedCount: 0,
    failedCount: 0,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
    lastError: null,
    job: null,
    ...overrides
  };
}

function makeRun(overrides: Partial<ParallelSolverRun> & Pick<ParallelSolverRun, "id" | "status" | "slices">): ParallelSolverRun {
  return {
    sourceType: "parallel",
    rangePath,
    rangeName: "3OD-4.3 vs 3IA-4.2",
    datasetName,
    repoId: `Tsumugii/${datasetName}`,
    scenario: "3ia-3od",
    settings: DEFAULT_SOLVER_JOB_SETTINGS,
    solverRangeText: "",
    reportCleared: false,
    queueOrder: 1,
    serverIds: ["solver-01"],
    totalIndices: [1, 2, 3, 4, 5],
    missingIndices: [1, 2, 3, 4, 5],
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
    startedAt: "2026-06-13T10:00:00.000Z",
    finishedAt: "2026-06-13T11:00:00.000Z",
    lastError: null,
    report: {
      totalBoards: 5,
      completedBoards: 0,
      failedBoards: 0,
      queuedBoards: 0,
      runningBoards: 0,
      successRate: 0,
      durationSeconds: 3600
    },
    ...overrides
  };
}

function makeFailureEntry(boardIndex: number, failureReason: ParallelFailurePoolEntry["failureReason"] = "abnormal_end"): ParallelFailurePoolEntry {
  return {
    id: `fp-${boardIndex}`,
    rangePath,
    datasetName,
    repoId: `Tsumugii/${datasetName}`,
    scenario: "3ia-3od",
    boardIndex,
    boardName: allBoards[boardIndex - 1] ?? String(boardIndex),
    boardKey: (allBoards[boardIndex - 1] ?? String(boardIndex)).replace(/,/g, "").toLowerCase(),
    status: "pending",
    failureReason,
    attemptCount: 1,
    lastRunId: "run-failed",
    lastSliceId: "slice-failed",
    lastServerId: "solver-01",
    lastError: "solver failed",
    createdAt: "2026-06-13T11:00:00.000Z",
    updatedAt: "2026-06-13T11:00:00.000Z"
  };
}

describe("computeMissingSolveBoardIndices", () => {
  it("collects completed board indices from terminal runs", () => {
    const run = makeRun({
      id: "run-completed",
      status: "completed",
      slices: [
        makeSlice({
          id: "slice-1",
          assignedIndices: [1, 2, 3],
          status: "completed"
        })
      ]
    });

    expect(collectCompletedBoardIndicesFromRun(run)).toEqual([1, 2, 3]);
  });

  it("excludes boards already present on Hugging Face", () => {
    const remoteBoardKeys = new Set(["ahkhqhjh", "2c3c4c5c"]);
    const result = computeMissingSolveBoardIndices({
      allBoards,
      remoteBoardKeys,
      runs: [],
      datasetName,
      rangePath
    });

    expect(result.missingIndices).toEqual([3, 4, 5]);
    expect(result.coverage.remoteCoveredCount).toBe(2);
    expect(result.coverage.missingCount).toBe(3);
  });

  it("excludes historically completed boards even when Hugging Face is missing them", () => {
    const run = makeRun({
      id: "run-completed",
      status: "completed_with_failures",
      slices: [
        makeSlice({
          id: "slice-1",
          assignedIndices: [1, 2, 3],
          status: "completed"
        })
      ]
    });

    const result = computeMissingSolveBoardIndices({
      allBoards,
      remoteBoardKeys: new Set(),
      runs: [run],
      datasetName,
      rangePath
    });

    expect(result.missingIndices).toEqual([4, 5]);
    expect(result.coverage.historicallyCompletedCount).toBe(3);
    expect(result.coverage.uploadPendingCount).toBe(3);
  });

  it("matches retryable failure pool boards when a terminal run already accounted for completed boards", () => {
    const completedRun = makeRun({
      id: "run-completed",
      status: "completed_with_failures",
      slices: [
        makeSlice({
          id: "slice-done",
          assignedIndices: [1, 2],
          status: "completed"
        })
      ]
    });
    const failurePool = [makeFailureEntry(3), makeFailureEntry(4, "skipped")];

    const result = computeMissingSolveBoardIndices({
      allBoards,
      remoteBoardKeys: new Set(),
      runs: [completedRun],
      datasetName,
      rangePath,
      failurePoolEntries: failurePool
    });

    expect(result.missingIndices).toEqual([3, 4, 5]);
    expect(collectRetryableFailurePoolBoardIndices(failurePool, datasetName, rangePath)).toEqual([3, 4]);
    expect(result.coverage.failurePoolPendingCount).toBe(2);
    expect(result.missingIndices.slice(0, 2)).toEqual([3, 4]);
  });

  it("treats a full-dataset terminal run as failure pool equals remaining missing boards", () => {
    const completedRun = makeRun({
      id: "run-full",
      status: "completed_with_failures",
      slices: [
        makeSlice({
          id: "slice-done",
          assignedIndices: [1, 2, 3],
          status: "completed"
        }),
        makeSlice({
          id: "slice-failed",
          assignedIndices: [4, 5],
          status: "failed"
        })
      ]
    });
    const failurePool = [makeFailureEntry(4), makeFailureEntry(5)];

    const result = computeMissingSolveBoardIndices({
      allBoards,
      remoteBoardKeys: new Set(),
      runs: [completedRun],
      datasetName,
      rangePath,
      failurePoolEntries: failurePool
    });

    expect(result.missingIndices).toEqual([4, 5]);
    expect(result.coverage.failurePoolPendingCount).toBe(2);
    expect(result.coverage.missingCount).toBe(result.coverage.failurePoolPendingCount);
  });
});
