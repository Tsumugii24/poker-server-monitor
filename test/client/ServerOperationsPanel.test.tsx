// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServerOperationsPanel } from "../../src/client/PreflopRangeView";
import type { ServerOperation, ServerUploadCandidate } from "../../src/shared/serverOperations";
import type { ServerRow } from "../../src/shared/types";

const servers = [{
  id: "1",
  name: "Solver 1",
  host: "solver-1.example",
  port: 22,
  enabled: true,
  note: "",
  solverRoot: "~/solver",
  latest: { connectionStatus: "online" }
}] as ServerRow[];

const networkServers = [
  ...servers,
  {
    ...servers[0],
    id: "21",
    name: "Solver 21",
    host: "solver-21.example"
  },
  {
    ...servers[0],
    id: "22",
    name: "Solver 22",
    host: "solver-22.example"
  },
  {
    ...servers[0],
    id: "23",
    name: "Solver 23",
    host: "solver-23.example",
    latest: { connectionStatus: "offline" }
  }
] as ServerRow[];

const candidates: ServerUploadCandidate[] = [{
  id: "1:/home/jane/solver/results/sia-30-sod-13.5/job-1",
  serverId: "1",
  datasetName: "sia-30-sod-13.5",
  repoId: "Tsumugii/sia-30-sod-13.5",
  jobId: "job-1",
  resultsDir: "/home/jane/solver/results/sia-30-sod-13.5/job-1",
  parquetCount: 12,
  jsonCount: 2,
  fileFormat: "parquet",
  fileCount: 12
}, {
  id: "1:/home/jane/solver/results/3ia-9-3od-5.8/job-2",
  serverId: "1",
  datasetName: "3ia-9-3od-5.8",
  repoId: "Tsumugii/3ia-9-3od-5.8",
  jobId: "job-2",
  resultsDir: "/home/jane/solver/results/3ia-9-3od-5.8/job-2",
  parquetCount: 4,
  jsonCount: 0,
  fileFormat: "parquet",
  fileCount: 4
}];

const uploadOperation: ServerOperation = {
  id: "upload-1",
  type: "upload",
  serverId: "1",
  status: "completed",
  tmuxSession: "upload-1",
  command: "python upload.py",
  items: [{
    serverId: "1",
    datasetName: "sia-30-sod-13.5",
    repoId: "Tsumugii/sia-30-sod-13.5",
    jobId: "job-1",
    resultsDir: "/home/jane/solver/results/sia-30-sod-13.5/job-1",
    fileFormat: "parquet",
    fileCount: 12
  }],
  statusFilePath: "~/run/upload.json",
  logFilePath: "~/run/upload.log",
  createdAt: "2026-07-18T10:00:00.000Z",
  updatedAt: "2026-07-18T10:02:00.000Z",
  startedAt: "2026-07-18T10:00:00.000Z",
  finishedAt: "2026-07-18T10:02:00.000Z",
  lastError: null,
  result: {
    summary: {
      folders: 1,
      files_found: 12,
      files_uploaded: 12,
      files_deleted: 12,
      files_remaining: 0,
      duration_seconds: 120,
      upload_success: 1,
      upload_failed: 0
    },
    details: [{
      dataset_name: "sia-30-sod-13.5",
      results_dir: "/home/jane/solver/results/sia-30-sod-13.5/job-1",
      files_found: 12,
      files_uploaded: 12,
      files_deleted: 12,
      files_remaining: 0,
      duration_seconds: 120,
      exit_code: 0,
      success: true,
      output_tail: "Done"
    }]
  }
};

const runningUploadOperation: ServerOperation = {
  ...uploadOperation,
  id: "upload-running",
  status: "running",
  finishedAt: null,
  items: [0, 1, 2].map((index) => ({
    serverId: "1",
    datasetName: `dataset-${index + 1}`,
    repoId: `Tsumugii/dataset-${index + 1}`,
    jobId: `job-${index + 1}`,
    resultsDir: `/home/jane/solver/results/dataset-${index + 1}/job-${index + 1}`,
    fileFormat: "parquet" as const,
    fileCount: 10
  })),
  result: {
    summary: {
      folders: 3,
      folders_completed: 1,
      folders_remaining: 2,
      files_found: 30,
      files_uploaded: 10,
      files_deleted: 10,
      files_remaining: 20,
      upload_success: 1,
      upload_failed: 0,
      current_dataset: "dataset-2",
      current_results_dir: "/home/jane/solver/results/dataset-2/job-2",
      current_file_format: "parquet",
      duration_seconds: 45
    },
    details: [{
      dataset_name: "dataset-1",
      results_dir: "/home/jane/solver/results/dataset-1/job-1",
      file_format: "parquet",
      files_found: 10,
      files_uploaded: 10,
      files_deleted: 10,
      files_remaining: 0,
      duration_seconds: 30,
      exit_code: 0,
      success: true
    }]
  }
};

describe("ServerOperationsPanel", () => {
  it("starts network sync only on the individually selected servers", async () => {
    const user = userEvent.setup();
    const onNetworkSync = vi.fn();
    renderPanel({ servers: networkServers, onNetworkSync });

    expect(screen.getByRole("button", { name: "Sync Selected" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Select server 23 for network sync" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Select server 22 for network sync" }));
    expect(screen.getByText("1 selected · 3 available")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sync Selected" }));

    expect(onNetworkSync).toHaveBeenCalledTimes(1);
    expect(onNetworkSync).toHaveBeenCalledWith(["22"]);
  });

  it("filters retained results and exposes row upload and delete actions", async () => {
    const user = userEvent.setup();
    const onUploadCandidate = vi.fn();
    const onDeleteCandidate = vi.fn();
    renderPanel({ onUploadCandidate, onDeleteCandidate });

    expect(screen.getByText("12 parquet")).toBeInTheDocument();
    expect(screen.getByText("2 json")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Filter retained results" }), "3ia-9");
    expect(screen.queryByText("sia-30-sod-13.5")).not.toBeInTheDocument();
    const visibleRow = screen.getAllByText("3ia-9-3od-5.8")[0]!.closest("article");
    expect(visibleRow).not.toBeNull();
    await user.click(within(visibleRow!).getByRole("button", { name: "Upload" }));
    await user.click(within(visibleRow!).getByRole("button", { name: "Delete" }));
    expect(onUploadCandidate).toHaveBeenCalledWith(candidates[1]);
    expect(onDeleteCandidate).toHaveBeenCalledWith(candidates[1]);
  });

  it("shows file-level upload results from the inventory", async () => {
    const user = userEvent.setup();
    renderPanel({ operations: [uploadOperation] });

    await user.click(screen.getByRole("tab", { name: "Scan + Upload" }));
    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Upload Result" });
    expect(within(dialog).getByText("12 files uploaded")).toBeInTheDocument();
    expect(within(dialog).getAllByText("12").length).toBeGreaterThanOrEqual(3);
    expect(within(dialog).getAllByText("0").length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getAllByText("2m").length).toBe(2);
  });

  it("shows live aggregate and per-folder upload progress", async () => {
    const user = userEvent.setup();
    renderPanel({ operations: [runningUploadOperation] });

    const overview = screen.getByRole("region", { name: "Upload progress" });
    expect(within(overview).getByText("Upload in progress")).toBeInTheDocument();
    expect(within(overview).getByText("1 / 3")).toBeInTheDocument();
    expect(within(overview).getByText("dataset-2")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Scan + Upload" }));
    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Upload Progress" });
    expect(within(dialog).getByText("1 of 3 folders processed")).toBeInTheDocument();
    expect(within(dialog).getByText("Uploading now")).toBeInTheDocument();
    expect(within(dialog).getByText("Pending")).toBeInTheDocument();
  });

  it("selects every filtered range folder for bulk upload or delete", async () => {
    const user = userEvent.setup();
    const onUploadCandidates = vi.fn();
    const onDeleteCandidates = vi.fn();
    renderPanel({ onUploadCandidates, onDeleteCandidates });

    await user.type(screen.getByRole("searchbox", { name: "Filter retained results" }), "3ia-9");
    await user.click(screen.getByRole("checkbox", { name: "Select all filtered ranges" }));
    expect(screen.getByText("1 selected · 4 files")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upload Selected" }));
    await user.click(screen.getByRole("button", { name: "Delete Selected" }));
    expect(onUploadCandidates).toHaveBeenCalledWith([candidates[1]]);
    expect(onDeleteCandidates).toHaveBeenCalledWith([candidates[1]]);
  });
});

function renderPanel(overrides: Partial<Parameters<typeof ServerOperationsPanel>[0]> = {}) {
  return render(<ServerOperationsPanel
    servers={servers}
    bestServerId="1"
    operations={[]}
    networkSyncConfigured
    uploadCandidates={candidates}
    busy={null}
    inventoryLoaded
    onScanUploads={vi.fn()}
    onSync={vi.fn()}
    onNetworkSync={vi.fn()}
    onNetworkCheck={vi.fn()}
    onUpload={vi.fn()}
    onUploadCandidate={vi.fn()}
    onUploadCandidates={vi.fn()}
    onDeleteCandidate={vi.fn()}
    onDeleteCandidates={vi.fn()}
    onStop={vi.fn()}
    onRetry={vi.fn()}
    onClear={vi.fn()}
    onBestServerChange={vi.fn()}
    {...overrides}
  />);
}
