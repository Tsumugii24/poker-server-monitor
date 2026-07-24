// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SOLVER_JOB_SETTINGS, type ParallelSolverRun } from "../../src/shared/solverJobs";
import { ParallelQueueBoard, ParallelRunProgress } from "../../src/client/PreflopRangeView";

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

describe("ParallelRunProgress", () => {
  it("shows done versus assigned boards as a bounded accessible percentage", () => {
    const { rerender } = render(<ParallelRunProgress assigned={20} done={7} />);

    let progress = screen.getByRole("progressbar", { name: "Parallel run completion" });
    expect(progress).toHaveAttribute("aria-valuenow", "35");
    expect(progress).toHaveAttribute("aria-valuetext", "7 of 20 assigned boards done");
    expect(screen.getByText("35%")).toBeInTheDocument();
    expect(progress.firstElementChild).toHaveStyle({ width: "35%" });

    rerender(<ParallelRunProgress assigned={10} done={12} />);
    progress = screen.getByRole("progressbar", { name: "Parallel run completion" });
    expect(progress).toHaveAttribute("aria-valuenow", "100");
    expect(progress.firstElementChild).toHaveStyle({ width: "100%" });

    rerender(<ParallelRunProgress assigned={0} done={0} />);
    progress = screen.getByRole("progressbar", { name: "Parallel run completion" });
    expect(progress).toHaveAttribute("aria-valuenow", "0");
    expect(progress.firstElementChild).toHaveStyle({ width: "0%" });
  });
});
