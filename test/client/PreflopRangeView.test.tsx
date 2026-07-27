// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  type ParallelServerSelectionScope,
  type ParallelSolverRun
} from "../../src/shared/solverJobs";
import {
  ParallelQueueBoard,
  ParallelRunProgress,
  parallelServersForTier
} from "../../src/client/PreflopRangeView";
import type { ServerRow } from "../../src/shared/types";

function queuedRun(
  id: string,
  datasetName: string,
  queueOrder: number,
  serverScope: ParallelServerSelectionScope | null = "all"
): ParallelSolverRun {
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
    serverScope,
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
  it("shows the saved server range for each queued run", () => {
    render(
      <ParallelQueueBoard
        runs={[
          queuedRun("run-all", "dataset-all", 1, "all"),
          queuedRun("run-performance", "dataset-performance", 2, "performance"),
          queuedRun("run-standard", "dataset-standard", 3, "standard"),
          queuedRun("run-legacy", "dataset-legacy", 4, null)
        ]}
        activeRunId="run-all"
        busy={null}
        onRunSelect={vi.fn()}
        onRunDelete={vi.fn()}
        onSaveOrder={vi.fn(async () => true)}
      />
    );

    expect(screen.getByLabelText("Server range: All Servers")).toBeInTheDocument();
    expect(screen.getByLabelText("Server range: Performance")).toBeInTheDocument();
    expect(screen.getByLabelText("Server range: Standard")).toBeInTheDocument();
    expect(screen.getByLabelText("Server range: Selected Servers")).toHaveAttribute(
      "title",
      expect.stringContaining("tier was not recorded")
    );
  });

  it("keeps queue edits local until one explicit save", async () => {
    const user = userEvent.setup();
    const runs = [
      queuedRun("run-a", "dataset-a", 1),
      queuedRun("run-b", "dataset-b", 2),
      queuedRun("run-c", "dataset-c", 3)
    ];
    const onSaveOrder = vi.fn(async () => true);

    function Harness() {
      const [activeRunId, setActiveRunId] = useState<string | null>("run-a");
      return (
        <ParallelQueueBoard
          runs={runs}
          activeRunId={activeRunId}
          busy={null}
          onRunSelect={setActiveRunId}
          onRunDelete={vi.fn()}
          onSaveOrder={onSaveOrder}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByLabelText("Saved parallel queue order")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move selected run left" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByText("dataset-c").closest("article")!);
    await user.click(screen.getByRole("button", { name: "Move selected run to first" }));
    expect(queueDatasetOrder()).toEqual(["dataset-c", "dataset-a", "dataset-b"]);
    expect(onSaveOrder).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Move selected run right" }));
    expect(queueDatasetOrder()).toEqual(["dataset-a", "dataset-c", "dataset-b"]);
    expect(onSaveOrder).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(queueDatasetOrder()).toEqual(["dataset-a", "dataset-b", "dataset-c"]);
    expect(screen.getByText("2 positions pending")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(queueDatasetOrder()).toEqual(["dataset-a", "dataset-c", "dataset-b"]);
    await user.click(screen.getByRole("button", { name: "Save order" }));

    expect(onSaveOrder).toHaveBeenCalledTimes(1);
    expect(onSaveOrder).toHaveBeenCalledWith(["run-a", "run-c", "run-b"]);
    expect(screen.getByLabelText("Saved parallel queue order")).toBeInTheDocument();
    expect(screen.getByText("Queue order saved.")).toBeInTheDocument();
  });

  it("reports the editable queue boundaries without saving", async () => {
    const user = userEvent.setup();
    const runs = [queuedRun("run-a", "dataset-a", 1), queuedRun("run-b", "dataset-b", 2)];
    const onSaveOrder = vi.fn(async () => true);

    render(
      <ParallelQueueBoard
        runs={runs}
        activeRunId="run-a"
        busy={null}
        onRunSelect={vi.fn()}
        onRunDelete={vi.fn()}
        onSaveOrder={onSaveOrder}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Move selected run left" }));
    expect(screen.getByRole("status")).toHaveTextContent("already first in the movable queue");
    expect(onSaveOrder).not.toHaveBeenCalled();
  });

  it("blocks a stale draft until the current server order is reloaded", async () => {
    const user = userEvent.setup();
    const baseRuns = [queuedRun("run-a", "dataset-a", 1), queuedRun("run-b", "dataset-b", 2)];
    const onSaveOrder = vi.fn(async () => true);
    const renderBoard = (runs: ParallelSolverRun[]) => (
      <ParallelQueueBoard
        runs={runs}
        activeRunId="run-b"
        busy={null}
        onRunSelect={vi.fn()}
        onRunDelete={vi.fn()}
        onSaveOrder={onSaveOrder}
      />
    );
    const { rerender } = render(renderBoard(baseRuns));

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Move selected run left" }));
    expect(queueDatasetOrder()).toEqual(["dataset-b", "dataset-a"]);

    rerender(renderBoard([...baseRuns, queuedRun("run-c", "dataset-c", 3)]));

    expect(screen.getByRole("alert")).toHaveTextContent("live queue changed");
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reload current order" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(queueDatasetOrder()).toEqual(["dataset-a", "dataset-b", "dataset-c"]);
    expect(onSaveOrder).not.toHaveBeenCalled();
  });
});

function queueDatasetOrder(): string[] {
  return Array.from(document.querySelectorAll(".parallel-queue-lane .parallel-queue-heading strong"))
    .map((element) => element.textContent ?? "");
}

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

describe("parallelServersForTier", () => {
  it("selects all, Performance, or Standard enabled servers in natural id order", () => {
    const servers = [
      { id: "22", enabled: true, tier: "standard" },
      { id: "3", enabled: true, tier: "performance" },
      { id: "21", enabled: true, tier: "performance" },
      { id: "1", enabled: true },
      { id: "4", enabled: false, tier: "performance" }
    ] as ServerRow[];

    expect(parallelServersForTier(servers, "all").map((server) => server.id)).toEqual(["1", "3", "21", "22"]);
    expect(parallelServersForTier(servers, "performance").map((server) => server.id)).toEqual(["3", "21"]);
    expect(parallelServersForTier(servers, "standard").map((server) => server.id)).toEqual(["1", "22"]);
  });
});
