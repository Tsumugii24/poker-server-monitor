import type {
  ParallelFailurePoolEntry,
  ParallelSolverCoverageSummary,
  ParallelSolverRun,
  ParallelSolverSlice
} from "./solverJobs";

const TERMINAL_PARALLEL_RUN_STATUSES = new Set([
  "completed",
  "completed_with_failures",
  "failed",
  "canceled"
]);

export function boardKeyFromBoardName(board: string): string {
  return board.replace(/,/g, "").trim().toLowerCase();
}

export function assignedBoardIndicesInSlice(slice: ParallelSolverSlice, indices: number[]): number[] {
  const assigned = new Set(slice.assignedIndices);
  return indices.filter((index) => assigned.has(index));
}

export function completedBoardIndicesForSlice(slice: ParallelSolverSlice): number[] {
  if (slice.status === "completed") return slice.assignedIndices;
  const fromPipeline = assignedBoardIndicesInSlice(slice, slice.job?.pipeline?.completedIndices ?? []);
  return fromPipeline;
}

export function collectCompletedBoardIndicesFromRun(run: ParallelSolverRun): number[] {
  return uniqueSorted(run.slices.flatMap((slice) => completedBoardIndicesForSlice(slice)));
}

export function collectHistoricallyCompletedBoardIndices(
  runs: ParallelSolverRun[],
  datasetName: string,
  rangePath: string
): number[] {
  const completed = new Set<number>();
  for (const run of runs) {
    if (run.datasetName !== datasetName || run.rangePath !== rangePath) continue;
    if (!TERMINAL_PARALLEL_RUN_STATUSES.has(run.status)) continue;
    for (const index of collectCompletedBoardIndicesFromRun(run)) {
      completed.add(index);
    }
  }
  return [...completed].sort((left, right) => left - right);
}

export function collectInFlightBoardIndices(
  runs: ParallelSolverRun[],
  datasetName: string,
  rangePath: string
): number[] {
  const inFlight = new Set<number>();
  for (const run of runs) {
    if (run.datasetName !== datasetName || run.rangePath !== rangePath) continue;
    if (run.status !== "queued" && run.status !== "running") continue;
    for (const slice of run.slices) {
      if (slice.status !== "queued" && slice.status !== "running") continue;
      for (const index of slice.assignedIndices) {
        inFlight.add(index);
      }
    }
  }
  return [...inFlight].sort((left, right) => left - right);
}

export function collectRemoteCoveredBoardIndices(allBoards: string[], remoteBoardKeys: Set<string>): number[] {
  const covered: number[] = [];
  allBoards.forEach((board, index) => {
    if (remoteBoardKeys.has(boardKeyFromBoardName(board))) covered.push(index + 1);
  });
  return covered;
}

export function collectRetryableFailurePoolBoardIndices(
  entries: ParallelFailurePoolEntry[],
  datasetName: string,
  rangePath: string
): number[] {
  const indices = new Set<number>();
  for (const entry of entries) {
    if (entry.datasetName !== datasetName || entry.rangePath !== rangePath) continue;
    if (entry.status !== "pending" && entry.status !== "failed") continue;
    if (entry.failureReason === "best_server_skipped") continue;
    indices.add(entry.boardIndex);
  }
  return [...indices].sort((left, right) => left - right);
}

export function computeMissingSolveBoardIndices(options: {
  allBoards: string[];
  remoteBoardKeys: Set<string>;
  runs: ParallelSolverRun[];
  datasetName: string;
  rangePath: string;
  failurePoolEntries?: ParallelFailurePoolEntry[];
}): { missingIndices: number[]; coverage: ParallelSolverCoverageSummary } {
  const remoteCovered = collectRemoteCoveredBoardIndices(options.allBoards, options.remoteBoardKeys);
  const historicallyCompleted = collectHistoricallyCompletedBoardIndices(
    options.runs,
    options.datasetName,
    options.rangePath
  );
  const inFlight = collectInFlightBoardIndices(options.runs, options.datasetName, options.rangePath);
  const failurePoolPending = collectRetryableFailurePoolBoardIndices(
    options.failurePoolEntries ?? [],
    options.datasetName,
    options.rangePath
  );

  const remoteSet = new Set(remoteCovered);
  const uploadPendingCount = historicallyCompleted.filter((index) => !remoteSet.has(index)).length;

  const covered = new Set<number>([...remoteCovered, ...historicallyCompleted, ...inFlight]);
  const missingIndices: number[] = [];
  for (let index = 1; index <= options.allBoards.length; index += 1) {
    if (!covered.has(index)) missingIndices.push(index);
  }

  return {
    missingIndices,
    coverage: {
      totalBoards: options.allBoards.length,
      remoteCoveredCount: remoteCovered.length,
      historicallyCompletedCount: historicallyCompleted.length,
      uploadPendingCount,
      inFlightCount: inFlight.length,
      failurePoolPendingCount: failurePoolPending.length,
      missingCount: missingIndices.length
    }
  };
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
