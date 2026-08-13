// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  type ParallelServerSelectionScope,
  type ParallelSolverRun
} from "../../src/shared/solverJobs";
import {
  ParallelHistoryBoard,
  ParallelQueueBoard,
  ParallelRunProgress,
  PreflopRangeView,
  RangeProgressPill,
  ServerOperationsPanel,
  SettingLibrarySection,
  parallelServersForTier,
  readRangeProgressViewPreference,
  reorderRangeTreeFolder,
  writeRangeProgressViewPreference
} from "../../src/client/PreflopRangeView";
import { DEFAULT_SOLVER_SETTING_LIBRARY } from "../../src/shared/solverSettings";
import type { ServerRow } from "../../src/shared/types";
import type { PreflopRangeFileItem, PreflopRangeTreeItem } from "../../src/shared/preflopRange";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function completedRun(id: string, datasetName: string, status: "completed" | "completed_with_failures"): ParallelSolverRun {
  const run = queuedRun(id, datasetName, 1);
  return {
    ...run,
    status,
    finishedAt: "2026-08-03T01:00:00.000Z",
    report: {
      ...run.report,
      completedBoards: status === "completed" ? 1 : 0,
      failedBoards: status === "completed" ? 0 : 1,
      queuedBoards: 0,
      successRate: status === "completed" ? 1 : 0
    }
  };
}

function onlineOperationServer(id: string): ServerRow {
  return {
    id,
    name: `Server ${id}`,
    host: `10.0.0.${id}`,
    port: 22,
    enabled: true,
    note: "",
    tier: "standard",
    solverRoot: "/srv/solver",
    latest: {
      connectionStatus: "online",
      errorCode: null
    },
    pipeline: null
  } as ServerRow;
}

describe("RangeProgressPill", () => {
  it("shows only the progress selected by the separate source tab", () => {
    const item: PreflopRangeFileItem = {
      type: "file",
      name: "range.json",
      path: "ranges/range.json",
      modified: "2026-08-03T00:00:00.000Z",
      size: 100,
      label: "IP vs OOP",
      learned: true,
      status: "approved",
      reviewStatus: "approved",
      runStatus: "idle",
      datasetName: "range",
      progress: {
        datasetName: "range",
        rows: 2,
        totalRows: 5,
        ratio: 0.4,
        localRows: 2,
        localOnlyRows: 1,
        combinedRows: 3,
        combinedRatio: 0.6,
        localOverlapKnown: true,
        checkedAt: "2026-08-03T00:00:00.000Z"
      },
      rangePct: { A: 10, B: 20 }
    };

    const view = render(<RangeProgressPill item={item} view="remote" />);

    expect(screen.getByLabelText("Remote progress 40%")).toHaveTextContent("40%");
    expect(screen.queryByLabelText(/Total progress/)).not.toBeInTheDocument();

    view.rerender(<RangeProgressPill item={item} view="total" />);
    expect(screen.getByLabelText("Total progress 60%")).toHaveTextContent("60%");
    expect(screen.queryByLabelText(/Remote progress/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Total progress 60%")).toHaveAttribute(
      "title",
      expect.stringContaining("1 awaiting remote upload")
    );
  });

  it("persists and restores the progress source preference", () => {
    localStorage.clear();
    expect(readRangeProgressViewPreference()).toBe("total");

    writeRangeProgressViewPreference("remote");
    expect(readRangeProgressViewPreference()).toBe("remote");

    writeRangeProgressViewPreference("total");
    expect(readRangeProgressViewPreference()).toBe("total");
  });
});

describe("reorderRangeTreeFolder", () => {
  it("updates root and nested folder order without replacing range data", () => {
    const nestedChildren = [
      { type: "file", name: "first.json", path: "SOD/first.json" },
      { type: "file", name: "second.json", path: "SOD/second.json" },
      { type: "file", name: "third.json", path: "SOD/third.json" }
    ] as PreflopRangeTreeItem[];
    const tree = [
      { type: "folder", name: "SIA", path: "SIA", children: [] },
      { type: "folder", name: "SOD", path: "SOD", children: nestedChildren }
    ] as PreflopRangeTreeItem[];

    const nestedResult = reorderRangeTreeFolder(tree, "SOD", ["third.json", "first.json", "second.json"]);
    const nestedFolder = nestedResult[1];
    expect(nestedFolder?.type).toBe("folder");
    expect(nestedFolder?.type === "folder" ? nestedFolder.children.map((item) => item.name) : []).toEqual([
      "third.json",
      "first.json",
      "second.json"
    ]);
    expect(nestedFolder?.type === "folder" ? nestedFolder.children[0] : null).toBe(nestedChildren[2]);

    const rootResult = reorderRangeTreeFolder(nestedResult, "", ["SOD", "SIA"]);
    expect(rootResult.map((item) => item.name)).toEqual(["SOD", "SIA"]);
  });

  it("persists a drag reorder without loading the range tree again", async () => {
    const rangeTree = [
      { type: "folder", name: "SIA", path: "SIA", children: [] },
      { type: "folder", name: "SOD", path: "SOD", children: [] }
    ] as PreflopRangeTreeItem[];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/preflop-ranges" && method === "GET") {
        return new Response(JSON.stringify({ root: "/ranges", tree: rangeTree }), { status: 200 });
      }
      if (url === "/api/preflop-ranges/reorder" && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "/api/overview") {
        return new Response(JSON.stringify({
          generatedAt: "2026-08-08T00:00:00.000Z",
          refresh: { lastRun: null },
          servers: []
        }), { status: 200 });
      }
      if (url === "/api/jobs?compact=1") {
        return new Response(JSON.stringify({ jobs: [], events: [] }), { status: 200 });
      }
      if (url === "/api/parallel-jobs?compact=1") {
        return new Response(JSON.stringify({ runs: [], reconciling: false }), { status: 200 });
      }
      if (url === "/api/server-operations") {
        return new Response(JSON.stringify({ operations: [], capabilities: { networkSyncConfigured: false } }), { status: 200 });
      }
      if (url === "/api/solver-settings") {
        return new Response(JSON.stringify({ settings: DEFAULT_SOLVER_SETTING_LIBRARY, updatedAt: null }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PreflopRangeView onBack={vi.fn()} />);
    await waitFor(() => expect(document.querySelectorAll(".preflop-file-row")).toHaveLength(2));
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".preflop-file-row"));
    const source = rows.find((row) => row.textContent?.includes("SIA"));
    const target = rows.find((row) => row.textContent?.includes("SOD"));
    expect(source).toBeDefined();
    expect(target).toBeDefined();

    const dataTransfer = { effectAllowed: "none" } as DataTransfer;
    fireEvent.dragStart(source!, { dataTransfer });
    fireEvent.dragOver(target!, { dataTransfer });
    fireEvent.drop(target!, { dataTransfer });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/preflop-ranges/reorder",
      expect.objectContaining({ method: "POST" })
    ));
    const reorderCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/preflop-ranges/reorder");
    expect(JSON.parse(String(reorderCall?.[1]?.body))).toEqual({
      folder: "",
      orderedNames: ["SOD", "SIA"]
    });
    await waitFor(() => {
      expect(Array.from(document.querySelectorAll(".preflop-file-row .preflop-row-main > strong"))
        .map((row) => row.textContent)).toEqual(["SOD", "SIA"]);
    });
    expect(fetchMock.mock.calls.filter(([url, options]) => (
      String(url) === "/api/preflop-ranges" && (options?.method ?? "GET") === "GET"
    ))).toHaveLength(1);
    expect(screen.queryByText("Loading ranges...")).not.toBeInTheDocument();
  });
});

describe("SettingLibrarySection", () => {
  const setting = DEFAULT_SOLVER_SETTING_LIBRARY[0]!;
  const baseProps = {
    settings: [setting],
    rangeFolders: [
      { path: "SIA", hasDirectCheckedFiles: true },
      { path: "SOD", hasDirectCheckedFiles: false },
      { path: "SOD/2BB", hasDirectCheckedFiles: true }
    ],
    updatedAt: null,
    selectedSettingId: setting.id,
    draft: setting,
    busy: null,
    onSelect: vi.fn(),
    onManageModeChange: vi.fn(),
    onDraftChange: vi.fn(),
    onNew: vi.fn(),
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn()
  };

  it("renders a structured, read-only preview without generated setting text", () => {
    render(<SettingLibrarySection {...baseProps} manageMode={false} />);

    expect(screen.getByRole("heading", { name: "Setting Library" })).toBeInTheDocument();
    expect(screen.getByText("Saved Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SIA vs SOD/ })).toBeInTheDocument();
    expect(screen.getByText("Identity & Stack")).toBeInTheDocument();
    expect(screen.getByText("Solver Parameters")).toBeInTheDocument();
    expect(screen.getByText("Bet Sizes")).toBeInTheDocument();
    expect(screen.getByText("Range Folder Links")).toBeInTheDocument();
    expect(screen.queryByText("Setting Text Preview")).not.toBeInTheDocument();
    expect(screen.queryByText(/set_pot 5/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Effective Stack")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove size 33" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add oop flop bet size" })).not.toBeInTheDocument();

    const groups = [...document.querySelectorAll(".setting-bet-size-group h4")].map((heading) => heading.textContent);
    expect(groups).toEqual([
      "IP · flop",
      "OOP · flop",
      "IP · turn",
      "OOP · turn",
      "IP · river",
      "OOP · river"
    ]);
    expect(screen.getAllByText("donk")).toHaveLength(2);
  });

  it("collapses and expands the Setting Library without discarding it", async () => {
    const user = userEvent.setup();
    render(<SettingLibrarySection {...baseProps} manageMode={false} />);

    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText("Saved Settings")).not.toBeInTheDocument();
    expect(screen.getByText(/1 saved settings/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Saved Settings")).toBeInTheDocument();
  });

  it("edits bet sizes through structured add and remove controls", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(
      <SettingLibrarySection
        {...baseProps}
        manageMode
        onDraftChange={onDraftChange}
      />
    );

    await user.click(screen.getAllByRole("button", { name: "Remove size 33" })[0]!);
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({
        betSizeRules: expect.arrayContaining([
          expect.objectContaining({ position: "oop", street: "flop", action: "bet", sizes: [] })
        ])
      })
    }));

    const addButton = screen.getByRole("button", { name: "Add oop flop bet size" });
    expect(screen.queryByRole("button", { name: "Add oop flop donk size" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add ip turn donk size" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add oop turn donk size" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add oop river donk size" })).toBeInTheDocument();
    const addInput = addButton.parentElement?.querySelector("input");
    expect(addInput).not.toBeNull();
    await user.type(addInput!, "42");
    await user.click(addButton);
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({
        betSizeRules: expect.arrayContaining([
          expect.objectContaining({ position: "oop", street: "flop", action: "bet", sizes: [33, 42] })
        ])
      })
    }));
  });

  it("edits Range Folder Links as structured multi-select values", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(<SettingLibrarySection {...baseProps} manageMode onDraftChange={onDraftChange} />);

    await user.click(screen.getByRole("checkbox", { name: /SOD\/2BB/ }));
    expect(onDraftChange).toHaveBeenCalledWith({
      rangeFolderPaths: ["SIA", "SOD/2BB"],
      rangeSubdir: "SIA"
    });
  });

  it("allows a linked folder with zero checked files to be unlinked", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const soaSetting = DEFAULT_SOLVER_SETTING_LIBRARY.find((candidate) => candidate.id === "soa-sid")!;
    render(
      <SettingLibrarySection
        {...baseProps}
        settings={[soaSetting]}
        rangeFolders={[
          { path: "SOA", hasDirectCheckedFiles: false },
          { path: "SID", hasDirectCheckedFiles: true }
        ]}
        selectedSettingId={soaSetting.id}
        draft={soaSetting}
        manageMode
        onDraftChange={onDraftChange}
      />
    );

    const soaCheckbox = screen.getByRole("checkbox", { name: "SOA" });
    expect(soaCheckbox).toBeChecked();
    expect(soaCheckbox).not.toBeDisabled();
    await user.click(soaCheckbox);
    expect(onDraftChange).toHaveBeenCalledWith({
      rangeFolderPaths: ["SID"],
      rangeSubdir: "SID"
    });
  });

  it("disables a parent folder when all child folders are linked and it has no direct checked files", () => {
    const sodSettings = DEFAULT_SOLVER_SETTING_LIBRARY.filter((candidate) =>
      ["sia-sod-open2", "sia-sod-open2.5", "sia-sod-open3"].includes(candidate.id)
    );
    const selected = sodSettings[0]!;
    const rangeFolders = [
      { path: "SOD", hasDirectCheckedFiles: false },
      { path: "SOD/2BB", hasDirectCheckedFiles: true },
      { path: "SOD/2.5BB", hasDirectCheckedFiles: true },
      { path: "SOD/3BB", hasDirectCheckedFiles: true }
    ];
    const props = {
      ...baseProps,
      settings: sodSettings,
      rangeFolders,
      selectedSettingId: selected.id,
      draft: selected,
      manageMode: true
    };
    const { rerender } = render(<SettingLibrarySection {...props} />);

    const sodLabel = screen.getByText("SOD").closest("label");
    expect(sodLabel).toHaveTextContent("All subfolders linked");
    expect(sodLabel?.querySelector("input")).toBeDisabled();

    rerender(
      <SettingLibrarySection
        {...props}
        rangeFolders={rangeFolders.map((folder) => folder.path === "SOD" ? { ...folder, hasDirectCheckedFiles: true } : folder)}
      />
    );
    expect(screen.getByText("SOD").closest("label")?.querySelector("input")).not.toBeDisabled();
  });
});

describe("ParallelQueueBoard", () => {
  it("shows a cache-loading state instead of an empty queue before data arrives", () => {
    render(
      <ParallelQueueBoard
        runs={[]}
        loaded={false}
        activeRunId={null}
        busy={null}
        onRunSelect={vi.fn()}
        onRunDelete={vi.fn()}
        onSaveOrder={vi.fn(async () => true)}
      />
    );

    expect(screen.getByText("Loading last saved parallel queue…")).toBeInTheDocument();
    expect(screen.queryByText("No active or queued parallel run.")).not.toBeInTheDocument();
  });

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

describe("ParallelHistoryBoard", () => {
  it("filters history tabs by keyword and selects the first matching run", async () => {
    const user = userEvent.setup();
    const onRunSelect = vi.fn();
    render(
      <ParallelHistoryBoard
        runs={[
          completedRun("run-alpha", "3ia-alpha-3od", "completed"),
          completedRun("run-beta", "sia-beta-sod", "completed_with_failures")
        ]}
        activeRunId="run-beta"
        busy={null}
        onRunSelect={onRunSelect}
        onRunDelete={vi.fn()}
      />
    );

    await user.type(screen.getByRole("searchbox", { name: "Search parallel history" }), "alpha");

    expect(screen.getByText("3ia-alpha-3od")).toBeInTheDocument();
    expect(screen.queryByText("sia-beta-sod")).not.toBeInTheDocument();
    expect(onRunSelect).toHaveBeenLastCalledWith("run-alpha");
  });

  it("shows a keyword-specific empty state", async () => {
    const user = userEvent.setup();
    render(
      <ParallelHistoryBoard
        runs={[completedRun("run-alpha", "3ia-alpha-3od", "completed")]}
        activeRunId="run-alpha"
        busy={null}
        onRunSelect={vi.fn()}
        onRunDelete={vi.fn()}
      />
    );

    await user.type(screen.getByRole("searchbox", { name: "Search parallel history" }), "missing-range");
    expect(screen.getByText("No parallel history matches “missing-range”.")).toBeInTheDocument();
  });
});

describe("ServerOperationsPanel", () => {
  it("starts Code Sync, Check Online, and Scan + Upload for one server row", async () => {
    const user = userEvent.setup();
    const onSync = vi.fn();
    const onNetworkCheck = vi.fn();
    const onUpload = vi.fn();
    render(
      <ServerOperationsPanel
        servers={[onlineOperationServer("1"), onlineOperationServer("2")]}
        operations={[]}
        networkSyncConfigured
        uploadCandidates={[]}
        busy={null}
        inventoryLoaded
        onScanUploads={vi.fn()}
        onSync={onSync}
        onNetworkSync={vi.fn()}
        onNetworkCheck={onNetworkCheck}
        onUpload={onUpload}
        onUploadCandidate={vi.fn()}
        onUploadCandidates={vi.fn()}
        onDeleteCandidate={vi.fn()}
        onDeleteCandidates={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onClear={vi.fn()}
        onPerformanceTierSave={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Check Online on server 2" }));
    expect(onNetworkCheck).toHaveBeenLastCalledWith(["2"]);

    await user.click(screen.getByRole("tab", { name: "Code Sync" }));
    await user.click(screen.getByRole("button", { name: "Code Sync on server 2" }));
    expect(onSync).toHaveBeenLastCalledWith(["2"]);

    await user.click(screen.getByRole("tab", { name: "Scan + Upload" }));
    await user.click(screen.getByRole("button", { name: "Scan + Upload on server 2" }));
    expect(onUpload).toHaveBeenLastCalledWith(["2"]);
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
