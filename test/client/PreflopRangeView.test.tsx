// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SOLVER_JOB_SETTINGS, type ParallelSolverRun } from "../../src/shared/solverJobs";
import { ParallelQueueBoard } from "../../src/client/PreflopRangeView";

function queuedRun(id: string, datasetName: string, queueOrder: number): ParallelSolverRun {
  return {
    id,
    sourceType: "parallel",
    rangePath: `ranges/${datasetName}.json`,
    rangeName: datasetName,
    datasetName,
    repoId: `Tsumugii/${datasetName}`,
    scenario: "3ia-3od",
    settings: DEFAULT_SOLVER_JOB_SETTINGS,
    solverRangeText: "AA",
    status: "queued",
    reportCleared: false,
    queueOrder,
    serverIds: ["solver-01"],
    autoIncludeNewServers: true,
    totalIndices: [queueOrder],
    missingIndices: [queueOrder],
    createdAt: `2026-07-23T00:00:0${queueOrder}.000Z`,
    updatedAt: `2026-07-23T00:00:0${queueOrder}.000Z`,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    slices: [],
    report: {
      totalBoards: 1,
      completedBoards: 0,
      failedBoards: 0,
      queuedBoards: 1,
      runningBoards: 0,
      successRate: 0,
      durationSeconds: null
    }
  };
}

describe("ParallelQueueBoard", () => {
  it("moves the selected run with arrow controls and reports movable queue boundaries", async () => {
    const runs = [queuedRun("run-a", "dataset-a", 1), queuedRun("run-b", "dataset-b", 2)];
    const onMove = vi.fn();

    function Harness() {
      const [activeRunId, setActiveRunId] = useState<string | null>("run-a");
      return (
        <ParallelQueueBoard
          runs={runs}
          activeRunId={activeRunId}
          busy={null}
          onRunSelect={setActiveRunId}
          onRunDelete={vi.fn()}
          onMove={onMove}
        />
      );
    }

    render(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "Move selected run left" }));
    expect(screen.getByRole("status")).toHaveTextContent("already first in the movable queue");
    expect(onMove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("dataset-b").closest("article")!);
    await userEvent.click(screen.getByRole("button", { name: "Move selected run right" }));
    expect(screen.getByRole("status")).toHaveTextContent("already last in the movable queue");

    await userEvent.click(screen.getByRole("button", { name: "Move selected run left" }));
    expect(onMove).toHaveBeenCalledWith("run-b", "left");
  });
});
