import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Check,
  ClipboardList,
  Copy,
  Download,
  FileJson,
  Folder,
  FolderPlus,
  GripVertical,
  Lock,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PREFLOP_HAND_GRID,
  PREFLOP_RANKS,
  PREFLOP_PLAYERS,
  PREFLOP_REVIEW_STATUSES,
  PREFLOP_RUN_STATUSES,
  normalizePreflopRangeDocument,
  summarizePreflopRange,
  type PreflopHandCode,
  type PreflopPlayerKey,
  type PreflopRangeDocument,
  type PreflopRangeFileItem,
  type PreflopRangeFileResponse,
  type PreflopRangeFolderItem,
  type PreflopRangeProgress,
  type PreflopReviewStatus,
  type PreflopRunStatus,
  type PreflopRangeSummary,
  type PreflopRangeTreeItem,
  type PreflopRangeTreeResponse
} from "../shared/preflopRange";
import {
  DEFAULT_SOLVER_JOB_SETTINGS,
  DEFAULT_SOLVER_SCENARIO_LIBRARY,
  SOLVER_EXPORT_FORMATS,
  SOLVER_UPLOAD_FORMATS,
  type ParallelFailurePoolEntry,
  type ParallelFailureReason,
  type ParallelSolverJobPreview,
  type ParallelSolverJobPreviewRequest,
  type ParallelSolverJobsResponse,
  type ParallelSolverReportsClearResponse,
  type ParallelSolverRun,
  type SolverExportFormat,
  type SolverDatasetRepoStatus,
  type SolverJob,
  type SolverJobEvent,
  type SolverJobPreview,
  type SolverJobPreviewRequest,
  type SolverJobSettings,
  type SolverJobsResponse,
  type SolverScenario,
  type SolverScenarioLibraryItem,
  type SolverScenarioLibraryResponse,
  type SolverUploadFormat
} from "../shared/solverJobs";
import type {
  ServerOperation,
  ServerOperationsResponse,
  ServerUploadCandidate,
  ServerUploadCandidatesResponse,
  ServerUploadItem
} from "../shared/serverOperations";
import type {
  ConnectionStatus,
  OverviewResponse,
  PipelineDisplayStatus,
  PipelineStatusSnapshot,
  ServerRow
} from "../shared/types";

type SelectedRangePath =
  | { type: "folder"; path: string; name: string }
  | { type: "file"; path: string; name: string };

type DragItem = {
  type: "folder" | "file";
  path: string;
  name: string;
  parent: string;
};

type DropTarget = {
  path: string;
  mode: "inside" | "before" | "after";
};

type PendingStatusChange = {
  path: string;
  name: string;
  from: PreflopReviewStatus;
  to: PreflopReviewStatus;
};

type RangeStatusView = "labeling" | "already";

type OfflineServerNotice = {
  serverId: string;
  host: string | null;
  status: ConnectionStatus | "unknown";
  action: string;
};

type PendingDatasetRepoAction = {
  action: "preview" | "start-now" | "queue-next" | "parallel-preview" | "parallel-start" | "pool-submit";
  request: SolverJobPreviewRequest;
  parallelRequest?: ParallelSolverJobPreviewRequest;
  parallelQueueMode?: "start_now" | "queue_next";
  parallelBestServerId?: string;
};

type PendingScenarioLibraryAction = {
  action: "add" | "update" | "delete";
  scenario: SolverScenarioLibraryItem;
  previousId?: string;
};

type PendingParallelReportsAction = {
  action: "download" | "clear";
  runCount: number;
  clearableCount: number;
};

type PendingServerOperationAction = {
  action: "sync" | "upload" | "clear";
  serverCount: number;
  itemCount: number;
  serverIds?: string[];
  itemIds?: string[];
};

const EXPANDED_FOLDERS_KEY = "preflop-range-expanded-folders";
const PARALLEL_BEST_SERVER_ID_KEY = "preflop-range-parallel-best-server-id";
const DEFAULT_SELECTED_HAND = "AA";
const REVIEW_STATUS_LABELS: Record<PreflopReviewStatus, string> = {
  under_review: "Under review",
  has_problem: "Has problem",
  approved: "Approved"
};
const RUN_STATUS_LABELS: Record<PreflopRunStatus, string> = {
  idle: "Idle",
  queue: "Queue",
  running: "Running",
  solved: "Solved"
};

export function PreflopRangeView({ onBack }: { onBack: () => void }) {
  const [tree, setTree] = useState<PreflopRangeTreeItem[]>([]);
  const [currentFolderPath, setCurrentFolderPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<SelectedRangePath | null>(null);
  const [selectedFile, setSelectedFile] = useState<PreflopRangeFileResponse | null>(null);
  const [draft, setDraft] = useState<PreflopRangeDocument | null>(null);
  const [query, setQuery] = useState("");
  const [selectedHand, setSelectedHand] = useState<PreflopHandCode>(DEFAULT_SELECTED_HAND);
  const [activePlayer, setActivePlayer] = useState<PreflopPlayerKey>("A");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => readExpandedFolders());
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");
  const [rangeManageMode, setRangeManageMode] = useState(false);
  const [rangeStatusView, setRangeStatusView] = useState<RangeStatusView>("labeling");
  const [visibleReviewStatuses, setVisibleReviewStatuses] = useState<Set<PreflopReviewStatus>>(
    () => new Set(PREFLOP_REVIEW_STATUSES)
  );
  const [visibleRunStatuses, setVisibleRunStatuses] = useState<Set<PreflopRunStatus>>(
    () => new Set(PREFLOP_RUN_STATUSES)
  );
  const [deleteTarget, setDeleteTarget] = useState<SelectedRangePath | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusChange | null>(null);
  const [approveAllPending, setApproveAllPending] = useState(false);
  const [rangeTextCopied, setRangeTextCopied] = useState(false);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [jobs, setJobs] = useState<SolverJob[]>([]);
  const [jobEvents, setJobEvents] = useState<SolverJobEvent[]>([]);
  const [parallelRuns, setParallelRuns] = useState<ParallelSolverRun[]>([]);
  const [failurePool, setFailurePool] = useState<ParallelFailurePoolEntry[]>([]);
  const [parallelPreview, setParallelPreview] = useState<ParallelSolverJobPreview | null>(null);
  const [selectedParallelServerIds, setSelectedParallelServerIds] = useState<string[]>([]);
  const [parallelQueueDragId, setParallelQueueDragId] = useState<string | null>(null);
  const [parallelServerTab, setParallelServerTab] = useState<"available" | "unavailable">("available");
  const [parallelBestServerId, setParallelBestServerId] = useState(() => localStorage.getItem(PARALLEL_BEST_SERVER_ID_KEY) ?? "");
  const [activeSolverJobTab, setActiveSolverJobTab] = useState<"single" | "parallel" | "operations">("single");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [serverOperations, setServerOperations] = useState<ServerOperation[]>([]);
  const [uploadCandidates, setUploadCandidates] = useState<ServerUploadCandidate[]>([]);
  const [jobSettings, setJobSettings] = useState<SolverJobSettings>(DEFAULT_SOLVER_JOB_SETTINGS);
  const [jobPreview, setJobPreview] = useState<SolverJobPreview | null>(null);
  const [selectedJobScenario, setSelectedJobScenario] = useState<SolverScenario | "">("");
  const [jobDatasetName, setJobDatasetName] = useState("");
  const [jobDatasetNameTouched, setJobDatasetNameTouched] = useState(false);
  const [confirmUnstudied, setConfirmUnstudied] = useState(false);
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [scenarioLibrary, setScenarioLibrary] = useState<SolverScenarioLibraryItem[]>(DEFAULT_SOLVER_SCENARIO_LIBRARY);
  const [scenarioLibraryUpdatedAt, setScenarioLibraryUpdatedAt] = useState<string | null>(null);
  const [selectedScenarioLibraryId, setSelectedScenarioLibraryId] = useState<string>(DEFAULT_SOLVER_SCENARIO_LIBRARY[0]?.id ?? "");
  const [scenarioManageMode, setScenarioManageMode] = useState(false);
  const [scenarioDraft, setScenarioDraft] = useState<SolverScenarioLibraryItem>(
    DEFAULT_SOLVER_SCENARIO_LIBRARY[0] ?? emptyScenarioLibraryItem()
  );
  const [scenarioCopied, setScenarioCopied] = useState(false);
  const [pendingScenarioAction, setPendingScenarioAction] = useState<PendingScenarioLibraryAction | null>(null);
  const [pendingParallelReportsAction, setPendingParallelReportsAction] = useState<PendingParallelReportsAction | null>(null);
  const [pendingServerOperationAction, setPendingServerOperationAction] = useState<PendingServerOperationAction | null>(null);
  const [offlineServerNotice, setOfflineServerNotice] = useState<OfflineServerNotice | null>(null);
  const [datasetRepoStatus, setDatasetRepoStatus] = useState<SolverDatasetRepoStatus | null>(null);
  const [datasetRepoDialog, setDatasetRepoDialog] = useState<SolverDatasetRepoStatus | null>(null);
  const [datasetRepoConfirmed, setDatasetRepoConfirmed] = useState(false);
  const [pendingDatasetRepoAction, setPendingDatasetRepoAction] = useState<PendingDatasetRepoAction | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchPreflopJson<PreflopRangeTreeResponse>("/api/preflop-ranges");
      const normalizedTree = normalizeRangeTreeItems(response.tree);
      setTree(normalizedTree);
      if (currentFolderPath && !findFolder(normalizedTree, currentFolderPath)) {
        setCurrentFolderPath("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [currentFolderPath]);

  const refreshRangeProgress = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchPreflopJson<PreflopRangeTreeResponse & { ok: boolean; checked: number; failed: number }>(
        "/api/preflop-ranges/refresh-progress",
        { method: "POST" }
      );
      const normalizedTree = normalizeRangeTreeItems(response.tree);
      setTree(normalizedTree);
      if (currentFolderPath && !findFolder(normalizedTree, currentFolderPath)) {
        setCurrentFolderPath("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [currentFolderPath]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const loadJobContext = useCallback(async () => {
    setJobError(null);
    try {
      const [overviewResponse, jobsResponse, parallelResponse, operationsResponse] = await Promise.all([
        fetchPreflopJson<OverviewResponse>("/api/overview"),
        fetchPreflopJson<SolverJobsResponse>("/api/jobs"),
        fetchPreflopJson<ParallelSolverJobsResponse>("/api/parallel-jobs"),
        fetchPreflopJson<ServerOperationsResponse>("/api/server-operations")
      ]);
      setServers(overviewResponse.servers);
      setJobs(jobsResponse.jobs);
      setJobEvents(jobsResponse.events);
      setParallelRuns(parallelResponse.runs);
      setFailurePool(parallelResponse.failurePool);
      setServerOperations(operationsResponse.operations);
      setSelectedParallelServerIds((current) => {
        const availableIds = overviewResponse.servers
          .slice()
          .sort(compareServersByNaturalId)
          .filter(parallelServerIsAvailable)
          .map((server) => server.id);
        const retained = current.filter((id) => availableIds.includes(id));
        return retained.length > 0 ? retained : availableIds;
      });
      setSelectedServerId((current) =>
        current && overviewResponse.servers.some((server) => server.id === current)
          ? current
          : defaultSolverServerId(overviewResponse.servers)
      );
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const refreshJobContext = useCallback(async () => {
    setJobBusy("refresh");
    setJobError(null);
    try {
      await fetchPreflopJson<unknown>("/api/refresh", { method: "POST" });
      await loadJobContext();
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
    } finally {
      setJobBusy(null);
    }
  }, [loadJobContext]);

  useEffect(() => {
    void loadJobContext();
  }, [loadJobContext]);

  const loadScenarioLibrary = useCallback(async () => {
    try {
      const response = await fetchPreflopJson<SolverScenarioLibraryResponse>("/api/scenarios");
      setScenarioLibrary(response.scenarios);
      setScenarioLibraryUpdatedAt(response.updatedAt);
      setSelectedScenarioLibraryId((current) =>
        current && response.scenarios.some((scenario) => scenario.id === current)
          ? current
          : response.scenarios[0]?.id ?? ""
      );
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void loadScenarioLibrary();
  }, [loadScenarioLibrary]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...expandedFolders]));
    } catch {
      // ignore storage failures
    }
  }, [expandedFolders]);

  useEffect(() => {
    try {
      const trimmed = parallelBestServerId.trim();
      if (trimmed) {
        localStorage.setItem(PARALLEL_BEST_SERVER_ID_KEY, trimmed);
      } else {
        localStorage.removeItem(PARALLEL_BEST_SERVER_ID_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [parallelBestServerId]);

  useEffect(() => {
    setJobPreview(null);
    setParallelPreview(null);
    setSelectedJobScenario("");
    setJobDatasetName("");
    setJobDatasetNameTouched(false);
    setDatasetRepoStatus(null);
    setDatasetRepoDialog(null);
    setDatasetRepoConfirmed(false);
    setPendingDatasetRepoAction(null);
    setConfirmUnstudied(false);
  }, [selectedPath?.path]);

  const folder = findFolder(tree, currentFolderPath);
  const currentFolderItems = folder ? folder.children : tree;
  const currentItems = useMemo(
    () => filterTreeItems(currentFolderItems, query, rangeStatusView, visibleReviewStatuses, visibleRunStatuses),
    [currentFolderItems, query, rangeStatusView, visibleReviewStatuses, visibleRunStatuses]
  );
  const summary = useMemo<PreflopRangeSummary | null>(
    () => draft ? summarizePreflopRange(draft, selectedPath?.name ?? "") : selectedFile?.summary ?? null,
    [draft, selectedFile, selectedPath?.name]
  );
  const selectedFolderForWrites = selectedPath?.type === "folder" ? selectedPath.path : currentFolderPath;
  const reviewStatusCounts = useMemo(() => countReviewStatuses(tree), [tree]);
  const runStatusCounts = useMemo(() => countRunStatuses(tree), [tree]);
  const allStatusesVisible = rangeStatusView === "labeling"
    ? visibleReviewStatuses.size === PREFLOP_REVIEW_STATUSES.length
    : visibleRunStatuses.size === PREFLOP_RUN_STATUSES.length;
  const statusScopeCount = rangeStatusView === "labeling" ? countFiles(tree) : countApprovedFiles(tree);
  const selectedRangePathForJob = selectedPath?.type === "file" ? selectedPath.path : "";
  const selectedRangeNameForJob = selectedPath?.type === "file" ? displayRangeName(selectedPath.name) : "";
  const solverRangeText = useMemo(() => summary ? formatSolverRangeText(summary) : "", [summary]);
  const selectedScenarioLibraryItem = useMemo(
    () => scenarioLibrary.find((scenario) => scenario.id === selectedScenarioLibraryId) ?? scenarioLibrary[0] ?? null,
    [scenarioLibrary, selectedScenarioLibraryId]
  );
  useEffect(() => {
    if (!scenarioManageMode && selectedScenarioLibraryItem) {
      setScenarioDraft(selectedScenarioLibraryItem);
    }
  }, [scenarioManageMode, selectedScenarioLibraryItem]);

  const clearSelectedRange = () => {
    setSelectedPath(null);
    setSelectedFile(null);
    setDraft(null);
    setSelectedHand(DEFAULT_SELECTED_HAND);
    setActivePlayer("A");
    setRenamingPath(null);
    setRenamingName("");
  };

  const toggleRangeManageMode = () => {
    if (rangeManageMode) {
      cancelRenaming();
      setRangeManageMode(false);
      return;
    }
    clearSelectedRange();
    setRangeManageMode(true);
  };

  const selectFolder = (path: string) => {
    setCurrentFolderPath(path);
    expandAncestors(path, setExpandedFolders);
    setSelectedPath({ type: "folder", path, name: folderName(path) });
    setSelectedFile(null);
    setDraft(null);
  };

  const selectFile = async (item: PreflopRangeFileItem) => {
    if (selectedPath?.type === "file" && selectedPath.path === item.path) {
      clearSelectedRange();
      return;
    }
    setError(null);
    try {
      const response = normalizeRangeFileResponse(await fetchPreflopJson<PreflopRangeFileResponse>(
        `/api/preflop-ranges/file?path=${encodeURIComponent(item.path)}`
      ));
      setSelectedPath({ type: "file", path: item.path, name: item.name });
      setSelectedFile(response);
      setDraft(response.summary.data);
      setSelectedHand(DEFAULT_SELECTED_HAND);
      setActivePlayer(preferredActivePlayer(response.summary));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const activateRangeItem = (item: PreflopRangeTreeItem) => {
    if (item.type === "folder") {
      selectFolder(item.path);
      return;
    }
    if (!rangeManageMode) {
      void selectFile(item);
    }
  };

  const requestRangeStatusChange = (status: PreflopReviewStatus, item?: PreflopRangeFileItem) => {
    const targetPath = item?.path ?? (selectedPath?.type === "file" ? selectedPath.path : "");
    const originalStatus = item?.reviewStatus ?? draft?.reviewStatus ?? draft?.status;
    const targetName = item?.name ?? selectedPath?.name ?? targetPath;
    if (!targetPath || !originalStatus || originalStatus === status) return;
    setPendingStatusChange({
      path: targetPath,
      name: targetName,
      from: originalStatus,
      to: status
    });
  };

  const updateRangeStatus = async (status: PreflopReviewStatus, targetPath: string) => {
    if (!targetPath) return false;
    setError(null);
    setSaving(true);
    try {
      const response = normalizeRangeFileResponse(await fetchPreflopJson<PreflopRangeFileResponse>("/api/preflop-ranges/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath, status })
      }));
      if (selectedPath?.type === "file" && selectedPath.path === targetPath) {
        setSelectedFile(response);
        setDraft(response.summary.data);
      }
      await loadTree();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const confirmRangeStatusChange = async () => {
    if (!pendingStatusChange) return;
    const updated = await updateRangeStatus(pendingStatusChange.to, pendingStatusChange.path);
    if (updated) setPendingStatusChange(null);
  };

  const confirmApproveAllRanges = async () => {
    setError(null);
    setSaving(true);
    try {
      const response = await fetchPreflopJson<{ ok: boolean; count: number; tree: PreflopRangeTreeItem[] }>(
        "/api/preflop-ranges/approve-all",
        { method: "POST" }
      );
      setTree(normalizeRangeTreeItems(response.tree));
      if (selectedPath?.type === "file") {
        const selectedResponse = normalizeRangeFileResponse(await fetchPreflopJson<PreflopRangeFileResponse>(
          `/api/preflop-ranges/file?path=${encodeURIComponent(selectedPath.path)}`
        ));
        setSelectedFile(selectedResponse);
        setDraft(selectedResponse.summary.data);
      }
      setApproveAllPending(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await fetchPreflopJson<{ path: string }>("/api/preflop-ranges/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: selectedFolderForWrites, name: newFolderName })
      });
      setNewFolderName("");
      setShowNewFolder(false);
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const startRenaming = (item: SelectedRangePath | PreflopRangeFileItem | PreflopRangeFolderItem) => {
    if (!item.path) return;
    setRenamingPath(item.path);
    setRenamingName(item.type === "file" ? displayRangeName(item.name) : item.name);
  };

  const cancelRenaming = () => {
    setRenamingPath(null);
    setRenamingName("");
  };

  useEffect(() => {
    if (!rangeManageMode) cancelRenaming();
  }, [rangeManageMode]);

  const showAllStatuses = () => {
    if (rangeStatusView === "labeling") {
      setVisibleReviewStatuses(new Set(PREFLOP_REVIEW_STATUSES));
    } else {
      setVisibleRunStatuses(new Set(PREFLOP_RUN_STATUSES));
    }
  };

  const activateRangeStatusView = (view: RangeStatusView) => {
    setRangeStatusView(view);
    if (view === "already") {
      void refreshRangeProgress();
    }
  };

  const toggleReviewStatusFilter = (status: PreflopReviewStatus) => {
    setVisibleReviewStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const toggleRunStatusFilter = (status: PreflopRunStatus) => {
    setVisibleRunStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const submitRename = async (pathToRename = renamingPath, nextName = renamingName) => {
    if (!pathToRename) return;
    if (!nextName.trim()) {
      cancelRenaming();
      return;
    }
    const normalizedName = normalizeRenameName(pathToRename, nextName);
    if (!normalizedName) {
      cancelRenaming();
      return;
    }
    if (normalizedName === pathBasename(pathToRename)) {
      cancelRenaming();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const response = await fetchPreflopJson<{ path: string }>("/api/preflop-ranges/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathToRename, newName: normalizedName })
      });
      if (currentFolderPath === pathToRename || currentFolderPath.startsWith(`${pathToRename}/`)) {
        setCurrentFolderPath(replacePathPrefix(currentFolderPath, pathToRename, response.path));
      }
      if (selectedPath?.path === pathToRename) {
        setSelectedPath({ ...selectedPath, path: response.path, name: normalizedName });
      } else if (selectedPath?.path.startsWith(`${pathToRename}/`)) {
        setSelectedPath({
          ...selectedPath,
          path: replacePathPrefix(selectedPath.path, pathToRename, response.path)
        });
      }
      setExpandedFolders((current) => renameExpandedFolderPaths(current, pathToRename, response.path));
      cancelRenaming();
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const requestDeleteSelected = () => {
    if (!selectedPath || selectedPath.path === "") return;
    setDeleteTarget(selectedPath);
  };

  const requestDeletePath = (target: SelectedRangePath) => {
    if (target.path === "") return;
    setDeleteTarget(target);
  };

  const confirmDeleteSelected = async () => {
    if (!deleteTarget || deleteTarget.path === "") return;
    setError(null);
    setSaving(true);
    try {
      await fetchPreflopJson<{ ok: boolean }>(`/api/preflop-ranges/path?path=${encodeURIComponent(deleteTarget.path)}`, {
        method: "DELETE"
      });
      if (selectedPath && pathIsSameOrInside(selectedPath.path, deleteTarget.path)) {
        setSelectedPath(null);
        setSelectedFile(null);
        setDraft(null);
      }
      if (pathIsSameOrInside(currentFolderPath, deleteTarget.path)) {
        setCurrentFolderPath(parentPath(deleteTarget.path));
      }
      setExpandedFolders((current) => deleteExpandedFolderPaths(current, deleteTarget.path));
      setDeleteTarget(null);
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const copySolverRangeText = async () => {
    if (!solverRangeText) return;
    try {
      await navigator.clipboard.writeText(solverRangeText);
      setRangeTextCopied(true);
      window.setTimeout(() => setRangeTextCopied(false), 1400);
    } catch {
      setError("Unable to copy range text.");
    }
  };

  const uploadFiles = async (input: HTMLInputElement, preserveRelativePath: boolean) => {
    const files = [...(input.files ?? [])].filter((file) => /\.(json|range)$/i.test(file.name));
    if (files.length === 0) {
      setError("Choose range files first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = await Promise.all(files.map(async (file) => ({
        filename: file.name,
        relativePath: preserveRelativePath ? (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name : file.name,
        content: await file.text()
      })));
      await fetchPreflopJson<{ count: number }>("/api/preflop-ranges/upload-many", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: selectedFolderForWrites, files: payload })
      });
      input.value = "";
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const downloadSelected = async () => {
    const targetPath = selectedPath?.path ?? "";
    setError(null);
    try {
      const response = await fetch(`/api/preflop-ranges/download?path=${encodeURIComponent(targetPath)}`);
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const blob = await response.blob();
      const filename = filenameFromDisposition(response.headers.get("Content-Disposition")) ||
        (selectedPath?.type === "file" ? selectedPath.name : `${selectedPath?.name || "preflop-ranges"}.zip`);
      triggerDownload(blob, filename);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const moveItem = async (path: string, targetFolder: string) => {
    await fetchPreflopJson<{ path: string }>("/api/preflop-ranges/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, targetFolder })
    });
  };

  const reorderAround = async (target: PreflopRangeTreeItem, mode: "before" | "after") => {
    if (!dragItem) return;
    const targetParent = currentFolderPath;
    if (dragItem.parent !== targetParent) {
      await moveItem(dragItem.path, targetParent);
    }
    const names = currentFolderItems.map((item) => item.name).filter((name) => name !== dragItem.name);
    const targetIndex = names.indexOf(target.name);
    if (targetIndex === -1) return;
    names.splice(mode === "before" ? targetIndex : targetIndex + 1, 0, dragItem.name);
    await fetchPreflopJson<{ ok: boolean }>("/api/preflop-ranges/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: targetParent, orderedNames: names })
    });
  };

  const handleDropOnFolder = async (folderPath: string) => {
    if (!dragItem || dragItem.path === folderPath) return;
    setError(null);
    try {
      await moveItem(dragItem.path, folderPath);
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDragItem(null);
      setDropTarget(null);
    }
  };

  const handleDropOnItem = async (item: PreflopRangeTreeItem) => {
    if (!dragItem || dragItem.path === item.path || !dropTarget) return;
    setError(null);
    try {
      if (dropTarget.mode === "inside" && item.type === "folder") {
        await moveItem(dragItem.path, item.path);
      } else if (dropTarget.mode === "before" || dropTarget.mode === "after") {
        await reorderAround(item, dropTarget.mode);
      }
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDragItem(null);
      setDropTarget(null);
    }
  };

  const clearDatasetRepoGate = () => {
    setDatasetRepoStatus(null);
    setDatasetRepoDialog(null);
    setDatasetRepoConfirmed(false);
    setPendingDatasetRepoAction(null);
  };

  const solverJobRequest = (scenarioOverride = selectedJobScenario): SolverJobPreviewRequest | null => {
    if (!selectedRangePathForJob || !selectedServerId) return null;
    return {
      serverId: selectedServerId,
      rangePath: selectedRangePathForJob,
      scenario: scenarioOverride || undefined,
      datasetName: jobDatasetNameTouched ? jobDatasetName.trim() || undefined : undefined,
      settings: jobSettings,
      confirmUnstudied
    };
  };

  const parallelJobRequest = (scenarioOverride = selectedJobScenario): ParallelSolverJobPreviewRequest | null => {
    if (!selectedRangePathForJob) return null;
    return {
      rangePath: selectedRangePathForJob,
      scenario: scenarioOverride || undefined,
      datasetName: jobDatasetNameTouched ? jobDatasetName.trim() || undefined : undefined,
      serverIds: selectedParallelServerIds,
      settings: jobSettings,
      confirmUnstudied
    };
  };

  const datasetGateRequestForParallel = (requestPayload: ParallelSolverJobPreviewRequest): SolverJobPreviewRequest | null => {
    const serverId = requestPayload.serverIds?.[0] ?? selectedParallelServerIds[0] ?? selectedServerId;
    if (!serverId) return null;
    return {
      serverId,
      rangePath: requestPayload.rangePath,
      scenario: requestPayload.scenario,
      datasetName: requestPayload.datasetName,
      settings: requestPayload.settings,
      confirmUnstudied: requestPayload.confirmUnstudied
    };
  };

  const previewParallelJob = async () => {
    const requestPayload = parallelJobRequest();
    if (!requestPayload) return;
    const gateRequest = datasetGateRequestForParallel(requestPayload);
    if (!gateRequest) return;
    setJobBusy("parallel-preview");
    setJobError(null);
    try {
      const repoStatus = await checkDatasetRepoForAction("parallel-preview", gateRequest);
      if (!repoStatus) {
        setPendingDatasetRepoAction({ action: "parallel-preview", request: gateRequest, parallelRequest: requestPayload });
        return;
      }
      const preview = await fetchPreflopJson<ParallelSolverJobPreview>("/api/parallel-jobs/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestPayload, datasetName: repoStatus.datasetName })
      });
      setParallelPreview(preview);
      setJobDatasetName(preview.datasetName);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJobBusy(null);
    }
  };

  const createParallelJob = async (queueMode: "start_now" | "queue_next") => {
    const requestPayload = parallelJobRequest();
    if (!requestPayload) return;
    const gateRequest = datasetGateRequestForParallel(requestPayload);
    if (!gateRequest) return;
    setJobBusy("parallel-start");
    setJobError(null);
    try {
      const repoStatus = await checkDatasetRepoForAction("parallel-start", gateRequest);
      if (!repoStatus) {
        setPendingDatasetRepoAction({
          action: "parallel-start",
          request: gateRequest,
          parallelRequest: requestPayload,
          parallelQueueMode: queueMode
        });
        return;
      }
      await createParallelJobAfterRepoReady({ ...requestPayload, datasetName: repoStatus.datasetName }, queueMode);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
      await loadTree();
    } finally {
      setJobBusy(null);
    }
  };

  const createParallelJobAfterRepoReady = async (
    requestPayload: ParallelSolverJobPreviewRequest,
    queueMode: "start_now" | "queue_next"
  ) => {
    await fetchPreflopJson<{ run: ParallelSolverRun }>("/api/parallel-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestPayload, confirmDatasetName: true, queueMode })
    });
    setParallelPreview(null);
    await loadJobContext();
    await loadTree();
  };

  const submitFailurePool = async (queueMode: "start_now" | "queue_next") => {
    const requestPayload = parallelJobRequest();
    if (!requestPayload) return;
    const gateRequest = datasetGateRequestForParallel(requestPayload);
    if (!gateRequest) return;
    setJobBusy("pool-submit");
    setJobError(null);
    try {
      const repoStatus = await checkDatasetRepoForAction("pool-submit", gateRequest);
      if (!repoStatus) {
        setPendingDatasetRepoAction({
          action: "pool-submit",
          request: gateRequest,
          parallelRequest: requestPayload,
          parallelQueueMode: queueMode,
          parallelBestServerId
        });
        return;
      }
      await fetchPreflopJson<{ run: ParallelSolverRun }>("/api/parallel-jobs/failure-pool/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestPayload,
          datasetName: repoStatus.datasetName,
          confirmDatasetName: true,
          queueMode,
          bestServerId: parallelBestServerId.trim() || undefined
        })
      });
      await loadJobContext();
      await loadTree();
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
      await loadTree();
    } finally {
      setJobBusy(null);
    }
  };

  const reorderParallelQueue = async (targetRunId: string) => {
    const draggedRunId = parallelQueueDragId;
    setParallelQueueDragId(null);
    if (!draggedRunId || draggedRunId === targetRunId) return;
    const movableRunIds = parallelQueueRuns(parallelRuns)
      .filter((run) => run.status === "queued" && !parallelRunIsLocked(run))
      .map((run) => run.id);
    const fromIndex = movableRunIds.indexOf(draggedRunId);
    const toIndex = movableRunIds.indexOf(targetRunId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = movableRunIds.splice(fromIndex, 1);
    if (!moved) return;
    movableRunIds.splice(toIndex, 0, moved);
    setJobBusy("parallel-reorder");
    setJobError(null);
    try {
      const response = await fetchPreflopJson<ParallelSolverJobsResponse>("/api/parallel-jobs/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds: movableRunIds })
      });
      setParallelRuns(response.runs);
      setFailurePool(response.failurePool);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
    } finally {
      setJobBusy(null);
    }
  };

  const cancelParallelRun = async (run: ParallelSolverRun) => {
    setJobBusy(`parallel-cancel:${run.id}`);
    setJobError(null);
    try {
      await fetchPreflopJson<{ run: ParallelSolverRun }>(`/api/parallel-jobs/${encodeURIComponent(run.id)}/cancel`, {
        method: "POST"
      });
      await loadJobContext();
      await loadTree();
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
    } finally {
      setJobBusy(null);
    }
  };

  const requestDownloadParallelReports = () => {
    if (parallelRuns.length === 0) return;
    setPendingParallelReportsAction({
      action: "download",
      runCount: parallelRuns.length,
      clearableCount: terminalParallelReportRuns(parallelRuns).length
    });
  };

  const requestClearParallelReports = () => {
    const clearableCount = terminalParallelReportRuns(parallelRuns).length;
    if (clearableCount === 0) return;
    setPendingParallelReportsAction({
      action: "clear",
      runCount: parallelRuns.length,
      clearableCount
    });
  };

  const confirmParallelReportsAction = async () => {
    if (!pendingParallelReportsAction) return;
    if (pendingParallelReportsAction.action === "download") {
      const markdown = buildParallelReportsMarkdown(parallelRuns, failurePool);
      downloadTextFile(`parallel-reports-${new Date().toISOString().slice(0, 10)}.md`, markdown);
      setPendingParallelReportsAction(null);
      return;
    }

    setJobBusy("parallel-clear-reports");
    setJobError(null);
    try {
      const response = await fetchPreflopJson<ParallelSolverReportsClearResponse>("/api/parallel-jobs/reports", {
        method: "DELETE"
      });
      setParallelRuns(response.runs);
      setFailurePool(response.failurePool);
      setPendingParallelReportsAction(null);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
    } finally {
      setJobBusy(null);
    }
  };

  const applyServerOperationsResponse = (response: ServerOperationsResponse) => {
    setServerOperations(response.operations);
  };

  const scanUploadCandidates = async () => {
    setJobBusy("operation-scan");
    setJobError(null);
    try {
      const response = await fetchPreflopJson<ServerUploadCandidatesResponse>(
        "/api/server-operations/upload-candidates"
      );
      setUploadCandidates(response.candidates);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJobBusy(null);
    }
  };

  const requestSyncOperations = () => {
    const targetServers = servers
      .slice()
      .sort(compareServersByNaturalId)
      .filter((server) => server.enabled && serverIsOnlineForJob(server));
    if (targetServers.length === 0) {
      setJobError("No online enabled servers are available for sync.");
      return;
    }
    setPendingServerOperationAction({
      action: "sync",
      serverCount: targetServers.length,
      itemCount: targetServers.length,
      serverIds: targetServers.map((server) => server.id)
    });
  };

  const requestUploadOperation = () => {
    const targetServers = servers
      .slice()
      .sort(compareServersByNaturalId)
      .filter((server) => server.enabled && serverIsOnlineForJob(server));
    if (targetServers.length === 0) {
      setJobError("No online enabled servers are available for upload.");
      return;
    }
    setPendingServerOperationAction({
      action: "upload",
      serverCount: targetServers.length,
      itemCount: uploadCandidates.length,
      serverIds: targetServers.map((server) => server.id)
    });
  };

  const requestClearServerOperations = () => {
    const clearableCount = serverOperations.filter((operation) => serverOperationIsTerminal(operation)).length;
    if (clearableCount === 0) return;
    setPendingServerOperationAction({
      action: "clear",
      serverCount: 0,
      itemCount: clearableCount
    });
  };

  const confirmServerOperationAction = async () => {
    if (!pendingServerOperationAction) return;
    const pending = pendingServerOperationAction;
    setJobBusy(`operation-${pending.action}`);
    setJobError(null);
    try {
      if (pending.action === "sync") {
        const response = await fetchPreflopJson<ServerOperationsResponse>("/api/server-operations/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverIds: pending.serverIds ?? [] })
        });
        applyServerOperationsResponse(response);
      } else if (pending.action === "upload") {
        const response = await fetchPreflopJson<ServerOperationsResponse>("/api/server-operations/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverIds: pending.serverIds ?? []
          })
        });
        applyServerOperationsResponse(response);
      } else {
        await fetchPreflopJson<{ cleared: number }>("/api/server-operations/reports", { method: "DELETE" });
        const response = await fetchPreflopJson<ServerOperationsResponse>("/api/server-operations");
        applyServerOperationsResponse(response);
      }
      setPendingServerOperationAction(null);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
    } finally {
      setJobBusy(null);
    }
  };

  const stopServerOperation = async (operation: ServerOperation) => {
    const server = servers.find((candidate) => candidate.id === operation.serverId) ?? null;
    if (!serverIsOnlineForJob(server)) {
      showOfflineServerNotice(server, operation.serverId, `stop ${operation.type} operation`);
      return;
    }
    setJobBusy(`operation-stop:${operation.id}`);
    setJobError(null);
    try {
      const response = await fetchPreflopJson<ServerOperationsResponse>(
        `/api/server-operations/${encodeURIComponent(operation.id)}/stop`,
        { method: "POST" }
      );
      applyServerOperationsResponse(response);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
    } finally {
      setJobBusy(null);
    }
  };

  const checkDatasetRepoForAction = async (
    action: PendingDatasetRepoAction["action"],
    requestPayload: SolverJobPreviewRequest
  ): Promise<SolverDatasetRepoStatus | null> => {
    const status = await fetchPreflopJson<SolverDatasetRepoStatus>("/api/jobs/dataset-repo/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload)
    });
    setJobPreview(status.preview);
    setDatasetRepoStatus(status);
    setJobDatasetName(status.datasetName);
    if (!status.exists) {
      setDatasetRepoDialog(status);
      setDatasetRepoConfirmed(false);
      setPendingDatasetRepoAction({ action, request: { ...requestPayload, datasetName: status.datasetName } });
      return null;
    }
    return status;
  };

  const previewJob = async (scenarioOverride = selectedJobScenario) => {
    const requestPayload = solverJobRequest(scenarioOverride);
    if (!requestPayload) return;
    setJobBusy("preview");
    setJobError(null);
    try {
      await checkDatasetRepoForAction("preview", requestPayload);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJobBusy(null);
    }
  };

  const changeJobScenario = (scenario: SolverScenario | "") => {
    setSelectedJobScenario(scenario);
    setJobPreview(null);
    setParallelPreview(null);
    if (!jobDatasetNameTouched) setJobDatasetName("");
    clearDatasetRepoGate();
    if (selectedRangePathForJob && selectedServerId) {
      void previewJob(scenario);
    }
  };

  const createSolverJob = async (queueMode: "manual" | "queue_next", autoStart: boolean) => {
    const requestPayload = solverJobRequest();
    if (!requestPayload) return;
    const server = servers.find((candidate) => candidate.id === selectedServerId) ?? null;
    if (!serverIsOnlineForJob(server)) {
      showOfflineServerNotice(server, selectedServerId, autoStart ? "start job" : "queue job");
      return;
    }
    setJobBusy(autoStart ? "start-now" : "queue-next");
    setJobError(null);
    try {
      const repoStatus = await checkDatasetRepoForAction(autoStart ? "start-now" : "queue-next", requestPayload);
      if (!repoStatus) return;
      await createSolverJobAfterRepoReady(queueMode, autoStart, {
        ...requestPayload,
        datasetName: repoStatus.datasetName,
        confirmDatasetName: true
      });
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
      await loadTree();
    } finally {
      setJobBusy(null);
    }
  };

  const createSolverJobAfterRepoReady = async (
    queueMode: "manual" | "queue_next",
    autoStart: boolean,
    requestPayload: SolverJobPreviewRequest & { confirmDatasetName: boolean }
  ) => {
      const created = await fetchPreflopJson<{ job: SolverJob; events: SolverJobEvent[] }>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestPayload,
          queueMode
        })
      });
      if (autoStart) {
        await fetchPreflopJson<{ job: SolverJob; events: SolverJobEvent[] }>(
          `/api/jobs/${encodeURIComponent(created.job.id)}/start`,
          { method: "POST" }
        );
      }
      setJobPreview(null);
      await loadJobContext();
      await loadTree();
  };

  const confirmDatasetRepoCreation = async () => {
    if (!datasetRepoDialog || !pendingDatasetRepoAction || !datasetRepoConfirmed) return;
    setJobBusy("dataset-repo");
    setJobError(null);
    try {
      const ensured = await fetchPreflopJson<SolverDatasetRepoStatus>("/api/jobs/dataset-repo/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...pendingDatasetRepoAction.request,
          datasetName: datasetRepoDialog.datasetName,
          confirmDatasetName: true
        })
      });
      setDatasetRepoStatus(ensured);
      setJobPreview(ensured.preview);
      setJobDatasetName(ensured.datasetName);
      const pending = pendingDatasetRepoAction;
      setDatasetRepoDialog(null);
      setPendingDatasetRepoAction(null);
      setDatasetRepoConfirmed(false);
      if (pending.action === "preview") return;
      if (pending.action === "parallel-preview" && pending.parallelRequest) {
        const preview = await fetchPreflopJson<ParallelSolverJobPreview>("/api/parallel-jobs/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...pending.parallelRequest, datasetName: ensured.datasetName })
        });
        setParallelPreview(preview);
        return;
      }
      if (pending.action === "parallel-start" && pending.parallelRequest) {
        await createParallelJobAfterRepoReady(
          { ...pending.parallelRequest, datasetName: ensured.datasetName },
          pending.parallelQueueMode ?? "start_now"
        );
        return;
      }
      if (pending.action === "pool-submit" && pending.parallelRequest) {
        await fetchPreflopJson<{ run: ParallelSolverRun }>("/api/parallel-jobs/failure-pool/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...pending.parallelRequest,
            datasetName: ensured.datasetName,
            confirmDatasetName: true,
            queueMode: pending.parallelQueueMode ?? "queue_next",
            bestServerId: pending.parallelBestServerId?.trim() || undefined
          })
        });
        await loadJobContext();
        await loadTree();
        return;
      }
      if (pending.action !== "start-now" && pending.action !== "queue-next") return;
      await createSolverJobAfterRepoReady(
        pending.action === "start-now" ? "manual" : "queue_next",
        pending.action === "start-now",
        {
          ...pending.request,
          datasetName: ensured.datasetName,
          confirmDatasetName: true
        }
      );
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
      await loadTree();
    } finally {
      setJobBusy(null);
    }
  };

  const selectScenarioLibraryItem = (scenarioId: string) => {
    const scenario = scenarioLibrary.find((item) => item.id === scenarioId);
    if (!scenario) return;
    setSelectedScenarioLibraryId(scenario.id);
    setScenarioDraft(scenario);
    onScenarioLibrarySelect(scenario.id);
  };

  const onScenarioLibrarySelect = (scenarioId: string) => {
    changeJobScenario(scenarioId);
  };

  const copyScenarioSettings = async () => {
    if (!selectedScenarioLibraryItem) return;
    try {
      await navigator.clipboard.writeText(formatScenarioLibraryText(selectedScenarioLibraryItem));
      setScenarioCopied(true);
      window.setTimeout(() => setScenarioCopied(false), 1400);
    } catch {
      setJobError("Unable to copy scenario settings.");
    }
  };

  const startAddScenario = () => {
    setScenarioManageMode(true);
    setSelectedScenarioLibraryId("");
    setScenarioDraft(emptyScenarioLibraryItem());
  };

  const requestScenarioAdd = () => {
    const scenario = normalizeScenarioDraft(scenarioDraft);
    if (!scenario) {
      setJobError("Scenario id, label, config template, pot and effective stack are required.");
      return;
    }
    setPendingScenarioAction({ action: "add", scenario });
  };

  const requestScenarioUpdate = () => {
    const scenario = normalizeScenarioDraft(scenarioDraft);
    if (!scenario || !selectedScenarioLibraryId) {
      setJobError("Select a scenario before updating.");
      return;
    }
    setPendingScenarioAction({ action: "update", scenario, previousId: selectedScenarioLibraryId });
  };

  const requestScenarioDelete = () => {
    if (!selectedScenarioLibraryItem) return;
    setPendingScenarioAction({ action: "delete", scenario: selectedScenarioLibraryItem });
  };

  const confirmScenarioLibraryAction = async () => {
    if (!pendingScenarioAction) return;
    setJobBusy(`scenario:${pendingScenarioAction.action}`);
    setJobError(null);
    try {
      let response: SolverScenarioLibraryResponse;
      if (pendingScenarioAction.action === "add") {
        response = await fetchPreflopJson<SolverScenarioLibraryResponse>("/api/scenarios", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario: pendingScenarioAction.scenario })
        });
      } else if (pendingScenarioAction.action === "update") {
        response = await fetchPreflopJson<SolverScenarioLibraryResponse>(
          `/api/scenarios/${encodeURIComponent(pendingScenarioAction.previousId ?? pendingScenarioAction.scenario.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario: pendingScenarioAction.scenario })
          }
        );
      } else {
        response = await fetchPreflopJson<SolverScenarioLibraryResponse>(
          `/api/scenarios/${encodeURIComponent(pendingScenarioAction.scenario.id)}`,
          { method: "DELETE" }
        );
      }
      setScenarioLibrary(response.scenarios);
      setScenarioLibraryUpdatedAt(response.updatedAt);
      const nextSelectedId = pendingScenarioAction.action === "delete"
        ? response.scenarios[0]?.id ?? ""
        : pendingScenarioAction.scenario.id;
      setSelectedScenarioLibraryId(nextSelectedId);
      const nextScenario = response.scenarios.find((scenario) => scenario.id === nextSelectedId) ?? response.scenarios[0];
      setScenarioDraft(nextScenario ?? emptyScenarioLibraryItem());
      if (
        pendingScenarioAction.action === "update" &&
        selectedJobScenario === pendingScenarioAction.previousId &&
        pendingScenarioAction.previousId !== pendingScenarioAction.scenario.id
      ) {
        changeJobScenario(pendingScenarioAction.scenario.id);
      } else if (selectedJobScenario && !response.scenarios.some((scenario) => scenario.id === selectedJobScenario)) {
        changeJobScenario("");
      }
      setPendingScenarioAction(null);
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJobBusy(null);
    }
  };

  const runJobAction = async (job: SolverJob, action: SolverJobAction) => {
    const server = servers.find((candidate) => candidate.id === job.serverId) ?? null;
    if (!serverIsOnlineForJob(server)) {
      showOfflineServerNotice(server, job.serverId, JOB_ACTION_LABELS[action]);
      return;
    }
    setJobBusy(`${action}:${job.id}`);
    setJobError(null);
    try {
      await fetchPreflopJson<{ job: SolverJob; events: SolverJobEvent[] }>(
        `/api/jobs/${encodeURIComponent(job.id)}/${action}`,
        { method: "POST" }
      );
      await loadJobContext();
      await loadTree();
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : String(caught));
      await loadJobContext();
      await loadTree();
    } finally {
      setJobBusy(null);
    }
  };

  const showOfflineServerNotice = (server: ServerRow | null, serverId: string, action: string) => {
    setOfflineServerNotice({
      serverId: server?.id ?? serverId,
      host: server?.host ?? null,
      status: server?.latest?.connectionStatus ?? "unknown",
      action
    });
  };

  return (
    <>
      <button className="icon-button ghost" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to Overview
      </button>

      <section className="section-heading preflop-heading">
        <div>
          <h2>Range Library</h2>
        </div>
        <div className="preflop-heading-actions">
          <button
            className="icon-button"
            onClick={() => void (rangeStatusView === "already" ? refreshRangeProgress() : loadTree())}
            disabled={loading || saving}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
      </section>

      {error ? <div className="notice error">{error}</div> : null}

      <section className="preflop-flow">
        <section className="panel preflop-library">
          <div className="preflop-library-header">
            <div className="panel-title">
              <FileJson size={16} />
              <h3>Range Files</h3>
            </div>
            <div className="preflop-library-tools">
              <span className="preflop-library-count">{currentItems.length}</span>
              <button
                className={`icon-button compact ${rangeManageMode ? "primary" : ""}`}
                onClick={toggleRangeManageMode}
              >
                <Pencil size={15} />
                {rangeManageMode ? "Done" : "Manage"}
              </button>
            </div>
          </div>

          <label className="preflop-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="Search for folder or file"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="preflop-status-control">
            <div className="preflop-status-mode-switch" aria-label="Range status mode">
              <button
                className={rangeStatusView === "labeling" ? "active" : ""}
                aria-pressed={rangeStatusView === "labeling"}
                onClick={() => activateRangeStatusView("labeling")}
              >
                All Labeling
                <span>{countFiles(tree)}</span>
              </button>
              <button
                className={rangeStatusView === "already" ? "active" : ""}
                aria-pressed={rangeStatusView === "already"}
                onClick={() => activateRangeStatusView("already")}
              >
                Already
                <span>{countApprovedFiles(tree)}</span>
              </button>
            </div>

            <div className="preflop-status-filters" aria-label="Range status filters">
              <button
                className={`preflop-status-filter-chip all ${allStatusesVisible ? "active" : "inactive"}`}
                aria-pressed={allStatusesVisible}
                onClick={showAllStatuses}
              >
                All
                <span>{statusScopeCount}</span>
              </button>
              {rangeStatusView === "labeling" ? PREFLOP_REVIEW_STATUSES.map((status) => {
                const visible = visibleReviewStatuses.has(status);
                return (
                  <button
                    key={status}
                    className={[
                      "preflop-status-filter-chip",
                      `status-${status}`,
                      visible ? "active" : "inactive"
                    ].join(" ")}
                    aria-pressed={visible}
                    onClick={() => toggleReviewStatusFilter(status)}
                  >
                    <span className={`preflop-status-initial status-${status}`}>{reviewStatusInitial(status)}</span>
                    {REVIEW_STATUS_LABELS[status]}
                    <span>{reviewStatusCounts[status]}</span>
                  </button>
                );
              }) : PREFLOP_RUN_STATUSES.map((status) => {
                const visible = visibleRunStatuses.has(status);
                return (
                  <button
                    key={status}
                    className={[
                      "preflop-status-filter-chip",
                      `status-${status}`,
                      visible ? "active" : "inactive"
                    ].join(" ")}
                    aria-pressed={visible}
                    onClick={() => toggleRunStatusFilter(status)}
                  >
                    <span className={`preflop-status-initial status-${status}`}>{runStatusInitial(status)}</span>
                    {RUN_STATUS_LABELS[status]}
                    <span>{runStatusCounts[status]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="preflop-command-grid">
            <button className="icon-button compact" onClick={() => fileInputRef.current?.click()} disabled={saving}>
              <Upload size={15} />
              Files
            </button>
            <button className="icon-button compact" onClick={() => folderInputRef.current?.click()} disabled={saving}>
              <Upload size={15} />
              Folder
            </button>
            <button className="icon-button compact" onClick={() => setShowNewFolder((current) => !current)} disabled={saving}>
              <FolderPlus size={15} />
              New
            </button>
            <button className="icon-button compact" onClick={() => setApproveAllPending(true)} disabled={saving || countFiles(tree) === 0}>
              <Check size={15} />
              Approve All
            </button>
            <button className="icon-button compact" onClick={() => void downloadSelected()} disabled={saving}>
              <Download size={15} />
              Export
            </button>
          </div>

          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept=".json,.range,application/json"
            multiple
            onChange={(event) => void uploadFiles(event.currentTarget, false)}
          />
          <input
            ref={folderInputRef}
            className="hidden-file-input"
            type="file"
            accept=".json,.range,application/json"
            multiple
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => void uploadFiles(event.currentTarget, true)}
          />

          {showNewFolder ? (
            <div className="preflop-new-folder">
              <input
                value={newFolderName}
                placeholder="Folder name"
                disabled={saving}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createFolder();
                  if (event.key === "Escape") setShowNewFolder(false);
                }}
              />
              <button className="inventory-action-button primary" aria-label="Create folder" onClick={() => void createFolder()}>
                <Check size={15} />
              </button>
              <button className="inventory-action-button" aria-label="Cancel folder" onClick={() => setShowNewFolder(false)}>
                <X size={15} />
              </button>
            </div>
          ) : null}

          <div className="preflop-browser">
            <nav className="preflop-folder-pane">
              <PreflopFolderRow
                item={{ type: "folder", name: "All Ranges", path: "", children: tree }}
                depth={0}
                activePath={currentFolderPath}
                expandedFolders={expandedFolders}
                query={query}
                dropTarget={dropTarget}
                onToggle={(path) => toggleFolder(path, setExpandedFolders)}
                onSelect={selectFolder}
                onDragStartItem={(item) => setDragItem({ type: "folder", path: item.path, name: item.name, parent: parentPath(item.path) })}
                onDragOverFolder={(path) => setDropTarget({ path, mode: "inside" })}
                onDropFolder={(path) => void handleDropOnFolder(path)}
              />
              {tree.flatMap((item) =>
                item.type === "folder" ? (
                  <PreflopFolderBranch
                    key={item.path}
                    item={item}
                    depth={1}
                    activePath={currentFolderPath}
                    expandedFolders={expandedFolders}
                    query={query}
                    dropTarget={dropTarget}
                    onToggle={(path) => toggleFolder(path, setExpandedFolders)}
                    onSelect={selectFolder}
                    onDragStartItem={(folderItem) => setDragItem({
                      type: "folder",
                      path: folderItem.path,
                      name: folderItem.name,
                      parent: parentPath(folderItem.path)
                    })}
                    onDragOverFolder={(path) => setDropTarget({ path, mode: "inside" })}
                    onDropFolder={(path) => void handleDropOnFolder(path)}
                  />
                ) : []
              )}
            </nav>

            <section className="preflop-file-pane">
              <div className="preflop-current-folder">
                <div className="preflop-current-folder-main">
                  {rangeManageMode && currentFolderPath && renamingPath === currentFolderPath ? (
                    <span className="preflop-rename-inline" onClick={(event) => event.stopPropagation()}>
                      <input
                        value={renamingName}
                        autoFocus
                        disabled={saving}
                        onChange={(event) => setRenamingName(event.target.value)}
                        onBlur={() => void submitRename(currentFolderPath, renamingName)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            cancelRenaming();
                          }
                        }}
                      />
                    </span>
                  ) : rangeManageMode && currentFolderPath ? (
                    <button
                      className="preflop-current-folder-name-button"
                      aria-label={`Rename folder ${folderName(currentFolderPath)}`}
                      onClick={() => startRenaming({ type: "folder", path: currentFolderPath, name: folderName(currentFolderPath) })}
                    >
                      {folderName(currentFolderPath)}
                    </button>
                  ) : (
                    <strong>{folderName(currentFolderPath)}</strong>
                  )}
                  <span>{currentItems.length} items</span>
                </div>
                {rangeManageMode && currentFolderPath ? (
                  <div className="preflop-current-folder-actions">
                    <button
                      className="inventory-action-button danger"
                      aria-label={`Delete folder ${folderName(currentFolderPath)}`}
                      title="Delete folder"
                      onClick={() => requestDeletePath({ type: "folder", path: currentFolderPath, name: folderName(currentFolderPath) })}
                      disabled={saving}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="preflop-file-list">
                {loading ? <div className="preflop-empty">Loading ranges...</div> : null}
                {!loading && currentItems.length === 0 ? (
                  <div className="preflop-empty">{query ? "No matches in this folder." : "No files in this folder."}</div>
                ) : null}
                {currentItems.map((item) => (
                  <div
                    key={item.path}
                    className={[
                      "preflop-file-row",
                      item.type === "folder" ? "folder" : "file",
                      rangeManageMode ? "managed" : "",
                      selectedPath?.path === item.path ? "active" : "",
                      item.type === "file" ? `status-${rangeDisplayStatus(item, rangeStatusView)}` : "",
                      dropTarget?.path === item.path ? `drop-${dropTarget.mode}` : ""
                    ].filter(Boolean).join(" ")}
                    role="button"
                    tabIndex={0}
                    draggable
                    onClick={() => activateRangeItem(item)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      if (rangeManageMode) {
                        startRenaming(item);
                        return;
                      }
                      activateRangeItem(item);
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      setDragItem({ type: item.type, path: item.path, name: item.name, parent: currentFolderPath });
                    }}
                    onDragOver={(event) => {
                      if (!dragItem || dragItem.path === item.path) return;
                      event.preventDefault();
                      const mode = dropModeFromEvent(event, item.type);
                      setDropTarget({ path: item.path, mode });
                    }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDropOnItem(item);
                    }}
                    onDragEnd={() => {
                      setDragItem(null);
                      setDropTarget(null);
                    }}
                  >
                    <span className="preflop-row-icon">
                      {item.type === "folder" ? <Folder size={15} /> : <FileJson size={15} />}
                    </span>
                    <span className="preflop-row-main">
                      {renamingPath === item.path ? (
                        <span className="preflop-rename-inline" onClick={(event) => event.stopPropagation()}>
                          <input
                            value={renamingName}
                            autoFocus
                            disabled={saving}
                            onChange={(event) => setRenamingName(event.target.value)}
                            onBlur={() => void submitRename(item.path, renamingName)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.currentTarget.blur();
                              }
                              if (event.key === "Escape") {
                                event.stopPropagation();
                                cancelRenaming();
                              }
                            }}
                          />
                        </span>
                      ) : (
                        item.type === "file" ? (
                          rangeManageMode ? (
                            <button
                              className="preflop-file-name-button"
                              aria-label={`Rename ${displayRangeName(item.name)}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                startRenaming(item);
                              }}
                            >
                              {displayRangeName(item.name)}
                            </button>
                          ) : (
                            <strong>{displayRangeName(item.name)}</strong>
                          )
                        ) : (
                          <>
                            {rangeManageMode ? (
                              <button
                                className="preflop-file-name-button"
                                aria-label={`Rename folder ${item.name}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  startRenaming(item);
                                }}
                              >
                                {item.name}
                              </button>
                            ) : (
                              <strong>{item.name}</strong>
                            )}
                            <span>{countFolderFiles(item)} items</span>
                          </>
                        )
                      )}
                    </span>
                    {item.type === "file" && rangeStatusView === "already" ? (
                      <span
                        className={`preflop-progress-pill ${rangeProgressClass(item.progress?.ratio)}`}
                        title={rangeProgressTitle(item)}
                      >
                        {formatRangeProgress(item.progress)}
                      </span>
                    ) : null}
                    {item.type === "folder" ? null : (
                      <span
                        className={`preflop-status-badge status-${rangeDisplayStatus(item, rangeStatusView)}`}
                        title={rangeDisplayStatusLabel(item, rangeStatusView)}
                        aria-label={rangeDisplayStatusLabel(item, rangeStatusView)}
                      >
                        {rangeDisplayStatusInitial(item, rangeStatusView)}
                      </span>
                    )}
                    {rangeManageMode && item.path ? (
                      <button
                        className="inventory-action-button danger preflop-row-delete-button"
                        aria-label={`Delete ${item.type === "folder" ? "folder" : "range"} ${item.type === "file" ? displayRangeName(item.name) : item.name}`}
                        title={item.type === "folder" ? "Delete folder" : "Delete range"}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDeletePath({
                            type: item.type,
                            path: item.path,
                            name: item.name
                          });
                        }}
                        disabled={saving}
                      >
                        <Trash2 size={15} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </section>

        <section className="preflop-workspace">
          {summary && draft ? (
            <section className="panel preflop-visual-panel">
              <div className="preflop-visual-head">
                <div>
                  <div className="panel-title">
                    <FileJson size={16} />
                    {selectedPath?.type === "file" && rangeManageMode && renamingPath === selectedPath.path ? (
                      <span className="preflop-title-rename" onClick={(event) => event.stopPropagation()}>
                        <input
                          value={renamingName}
                          autoFocus
                          disabled={saving}
                          onChange={(event) => setRenamingName(event.target.value)}
                          onBlur={() => void submitRename(selectedPath.path, renamingName)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.currentTarget.blur();
                            }
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              cancelRenaming();
                            }
                          }}
                        />
                      </span>
                    ) : selectedPath?.type === "file" && rangeManageMode ? (
                      <button
                        className="preflop-title-name-button"
                        aria-label={`Rename ${displayRangeName(selectedPath.name)}`}
                        onClick={() => startRenaming(selectedPath)}
                      >
                        {displayRangeName(selectedPath.name)}
                      </button>
                    ) : (
                      <h3>{selectedPath?.type === "file" ? displayRangeName(selectedPath.name) : "Selected Range"}</h3>
                    )}
                  </div>
                  <p>{selectedFile ? formatLastUpdatedTime(selectedFile) : ""}</p>
                </div>
                <div className="preflop-workspace-actions">
                  {selectedPath?.type === "file" ? (
                    <label className={`preflop-detail-status-field status-${draft.reviewStatus}`}>
                      <span className={`preflop-status-initial status-${draft.reviewStatus}`}>
                        {reviewStatusInitial(draft.reviewStatus)}
                      </span>
                      <span className="preflop-detail-status-label">Review Status</span>
                      <select
                        className={`preflop-detail-status-select status-${draft.reviewStatus}`}
                        value={draft.reviewStatus}
                        onChange={(event) => requestRangeStatusChange(event.target.value as PreflopReviewStatus)}
                        disabled={saving}
                      >
                        {PREFLOP_REVIEW_STATUSES.map((status) => (
                          <option key={status} value={status}>{REVIEW_STATUS_LABELS[status]}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <button className="icon-button compact danger" onClick={requestDeleteSelected} disabled={!selectedPath || selectedPath.path === "" || saving}>
                    <Trash2 size={15} />
                    Delete
                  </button>
                </div>
              </div>

              <div className="preflop-selected-hand-strip">
                <div className="preflop-selected-hand-main">
                  <span>Selected Hand</span>
                  <strong>{selectedHand}</strong>
                </div>
                {orderedRangePlayers(summary).map(({ player, role }) => (
                  <div key={`${player}-selected`} className={`preflop-hand-readout ${activePlayer === player ? "active" : ""}`}>
                    <span>{role} · {summary.players[player].name}</span>
                    <strong>
                      R {Math.round((summary.players[player].matrix[selectedHand]?.raise ?? 0) * 100)}%
                      {" / "}
                      C {Math.round((summary.players[player].matrix[selectedHand]?.call ?? 0) * 100)}%
                      {" / "}
                      F {Math.round(Math.max(0, 1 - ((summary.players[player].matrix[selectedHand]?.raise ?? 0) + (summary.players[player].matrix[selectedHand]?.call ?? 0))) * 100)}%
                    </strong>
                  </div>
                ))}
              </div>

              <section className="preflop-matrix-grid">
                {orderedRangePlayers(summary).map(({ player, role }) => (
                  <RangeMatrix
                    key={player}
                    player={player}
                    role={role}
                    summary={summary}
                    active={activePlayer === player}
                    selectedHand={selectedHand}
                    onPlayerSelect={() => setActivePlayer(player)}
                    onHandSelect={setSelectedHand}
                  />
                ))}
              </section>

              <section className="preflop-range-text-panel">
                <div className="preflop-range-text-head">
                  <strong>Range Text Display</strong>
                  <button
                    className="icon-button compact"
                    type="button"
                    onClick={() => void copySolverRangeText()}
                    disabled={!solverRangeText}
                    title="Copy range text"
                  >
                    <Copy size={14} />
                    {rangeTextCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre>{solverRangeText}</pre>
              </section>
            </section>
          ) : (
            <section className="panel preflop-empty-workspace">
              <FileJson size={24} />
              <p>No range file selected.</p>
            </section>
          )}
        </section>

        <SolverJobPanel
          servers={servers}
          jobs={jobs}
          events={jobEvents}
          parallelRuns={parallelRuns}
          failurePool={failurePool}
          parallelPreview={parallelPreview}
          selectedParallelServerIds={selectedParallelServerIds}
          parallelServerTab={parallelServerTab}
          parallelBestServerId={parallelBestServerId}
          activeTab={activeSolverJobTab}
          selectedServerId={selectedServerId}
          selectedRangePath={selectedRangePathForJob}
          selectedRangeName={selectedRangeNameForJob}
          selectedRangeLearned={Boolean(draft?.learned)}
          settings={jobSettings}
          preview={jobPreview}
          serverOperations={serverOperations}
          uploadCandidates={uploadCandidates}
          datasetName={jobDatasetName}
          datasetRepoStatus={datasetRepoStatus}
          selectedScenario={selectedJobScenario}
          scenarioLibrary={scenarioLibrary}
          scenarioLibraryUpdatedAt={scenarioLibraryUpdatedAt}
          selectedScenarioLibraryId={selectedScenarioLibraryId}
          scenarioManageMode={scenarioManageMode}
          scenarioDraft={scenarioDraft}
          scenarioCopied={scenarioCopied}
          confirmUnstudied={confirmUnstudied}
          busy={jobBusy}
          error={jobError}
          onRefresh={() => void refreshJobContext()}
          onServerChange={(serverId) => {
            setSelectedServerId(serverId);
            setJobPreview(null);
            clearDatasetRepoGate();
          }}
          onOperationScanUploads={() => void scanUploadCandidates()}
          onOperationSync={requestSyncOperations}
          onOperationUpload={requestUploadOperation}
          onOperationStop={(operation) => void stopServerOperation(operation)}
          onOperationClear={requestClearServerOperations}
          onParallelServerToggle={(serverId) => {
            setSelectedParallelServerIds((current) =>
              current.includes(serverId)
                ? current.filter((id) => id !== serverId)
                : [...current, serverId]
            );
            setParallelPreview(null);
            clearDatasetRepoGate();
          }}
          onParallelServerTabChange={setParallelServerTab}
          onParallelBestServerChange={(serverId) => {
            setParallelBestServerId(serverId);
            setParallelPreview(null);
            clearDatasetRepoGate();
          }}
          onTabChange={setActiveSolverJobTab}
          onDatasetNameChange={(datasetName) => {
            setJobDatasetName(datasetName);
            setJobDatasetNameTouched(Boolean(datasetName.trim()));
            setJobPreview(null);
            setParallelPreview(null);
            clearDatasetRepoGate();
          }}
          onSettingsChange={(patch) => {
            setJobSettings((current) => ({ ...current, ...patch }));
            setJobPreview(null);
            setParallelPreview(null);
            clearDatasetRepoGate();
          }}
          onConfirmUnstudiedChange={(checked) => {
            setConfirmUnstudied(checked);
            setJobPreview(null);
            clearDatasetRepoGate();
          }}
          onScenarioChange={changeJobScenario}
          onScenarioLibrarySelect={selectScenarioLibraryItem}
          onScenarioManageModeChange={(manage) => {
            setScenarioManageMode(manage);
            if (!manage && selectedScenarioLibraryItem) setScenarioDraft(selectedScenarioLibraryItem);
          }}
          onScenarioDraftChange={(patch) => setScenarioDraft((current) => ({ ...current, ...patch }))}
          onScenarioAdd={requestScenarioAdd}
          onScenarioUpdate={requestScenarioUpdate}
          onScenarioDelete={requestScenarioDelete}
          onScenarioCopy={() => void copyScenarioSettings()}
          onPreview={() => void previewJob()}
          onStartNow={() => void createSolverJob("manual", true)}
          onQueueNext={() => void createSolverJob("queue_next", false)}
          onParallelPreview={() => void previewParallelJob()}
          onParallelStart={() => void createParallelJob("start_now")}
          onParallelQueueNext={() => void createParallelJob("queue_next")}
          onFailurePoolSubmit={() => void submitFailurePool("queue_next")}
          onParallelCancel={(run) => void cancelParallelRun(run)}
          onParallelReportsDownload={requestDownloadParallelReports}
          onParallelReportsClear={requestClearParallelReports}
          parallelQueueDragId={parallelQueueDragId}
          onParallelQueueDragStart={setParallelQueueDragId}
          onParallelQueueDragEnd={() => setParallelQueueDragId(null)}
          onParallelQueueDrop={(runId) => void reorderParallelQueue(runId)}
          onJobAction={(job, action) => void runJobAction(job, action)}
        />
      </section>

      {offlineServerNotice ? (
        <div className="modal-backdrop job-offline-backdrop" role="presentation" onClick={() => setOfflineServerNotice(null)}>
          <section
            className="job-offline-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-offline-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="job-offline-icon">
              <X size={18} />
            </div>
            <div>
              <h3 id="job-offline-title">Server is offline</h3>
              <p>
                Server <strong>{offlineServerNotice.serverId}</strong>
                {offlineServerNotice.host ? ` (${offlineServerNotice.host})` : ""} is currently
                {" "}<strong>{offlineServerNotice.status}</strong>. Cannot {offlineServerNotice.action} until the server is online.
              </p>
            </div>
            <div className="job-offline-actions">
              <button className="icon-button compact primary" onClick={() => setOfflineServerNotice(null)}>
                OK
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {datasetRepoDialog ? (
        <div className="modal-backdrop solver-dataset-backdrop" role="presentation" onClick={() => setDatasetRepoDialog(null)}>
          <section
            className="solver-dataset-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="solver-dataset-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="solver-dataset-icon">
              <ClipboardList size={18} />
            </div>
            <div className="solver-dataset-content">
              <h3 id="solver-dataset-title">Confirm dataset repo</h3>
              <p>The Hugging Face dataset repo does not exist yet. Confirm the dataset name before creating it.</p>
              <dl>
                <div>
                  <dt>Dataset</dt>
                  <dd>{datasetRepoDialog.datasetName}</dd>
                </div>
                <div>
                  <dt>Repo</dt>
                  <dd>{datasetRepoDialog.repoId}</dd>
                </div>
                <div>
                  <dt>Scenario</dt>
                  <dd>{datasetRepoDialog.preview.scenario}</dd>
                </div>
                <div>
                  <dt>URL</dt>
                  <dd>{datasetRepoDialog.url}</dd>
                </div>
              </dl>
              <label className="solver-dataset-confirm">
                <input
                  type="checkbox"
                  checked={datasetRepoConfirmed}
                  onChange={(event) => setDatasetRepoConfirmed(event.target.checked)}
                />
                <span>Dataset name is correct. Create this Hugging Face dataset repo.</span>
              </label>
              {!datasetRepoDialog.tokenConfigured ? (
                <div className="notice error compact-notice">HF_TOKEN is required to create the dataset repo.</div>
              ) : null}
            </div>
            <div className="solver-dataset-actions">
              <button
                className="icon-button compact"
                onClick={() => {
                  setDatasetRepoDialog(null);
                  setPendingDatasetRepoAction(null);
                  setDatasetRepoConfirmed(false);
                }}
                disabled={jobBusy === "dataset-repo"}
              >
                Cancel
              </button>
              <button
                className="icon-button compact primary"
                onClick={() => void confirmDatasetRepoCreation()}
                disabled={!datasetRepoConfirmed || !datasetRepoDialog.tokenConfigured || jobBusy === "dataset-repo"}
              >
                <Check size={15} />
                {jobBusy === "dataset-repo" ? "Creating..." : "Create Repo"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingScenarioAction ? (
        <div className="modal-backdrop preflop-confirm-backdrop" role="presentation" onClick={() => setPendingScenarioAction(null)}>
          <section
            className="preflop-confirm-dialog scenario-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scenario-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preflop-confirm-icon">
              {pendingScenarioAction.action === "delete" ? <Trash2 size={18} /> : <Check size={18} />}
            </div>
            <div>
              <h3 id="scenario-confirm-title">{scenarioActionTitle(pendingScenarioAction.action)}</h3>
              <p>{pendingScenarioAction.scenario.id}</p>
              <pre className="scenario-confirm-preview">{formatScenarioLibraryText(pendingScenarioAction.scenario)}</pre>
            </div>
            <div className="preflop-confirm-actions">
              <button className="icon-button compact" onClick={() => setPendingScenarioAction(null)} disabled={jobBusy?.startsWith("scenario:")}>
                Cancel
              </button>
              <button
                className={`icon-button compact ${pendingScenarioAction.action === "delete" ? "danger" : "primary"}`}
                onClick={() => void confirmScenarioLibraryAction()}
                disabled={jobBusy?.startsWith("scenario:")}
              >
                {pendingScenarioAction.action === "delete" ? <Trash2 size={15} /> : <Check size={15} />}
                Confirm
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingParallelReportsAction ? (
        <div className="modal-backdrop preflop-confirm-backdrop" role="presentation" onClick={() => setPendingParallelReportsAction(null)}>
          <section
            className="preflop-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="parallel-reports-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preflop-confirm-icon">
              {pendingParallelReportsAction.action === "clear" ? <Trash2 size={18} /> : <Download size={18} />}
            </div>
            <div>
              <h3 id="parallel-reports-confirm-title">
                {pendingParallelReportsAction.action === "clear" ? "Clear parallel reports?" : "Download parallel reports?"}
              </h3>
              {pendingParallelReportsAction.action === "clear" ? (
                <p>
                  This will remove <strong>{pendingParallelReportsAction.clearableCount}</strong> completed, failed, or canceled
                  parallel report{pendingParallelReportsAction.clearableCount === 1 ? "" : "s"}. Active and queued runs stay in the queue.
                </p>
              ) : (
                <p>
                  This will export <strong>{pendingParallelReportsAction.runCount}</strong> parallel report
                  {pendingParallelReportsAction.runCount === 1 ? "" : "s"} as a Markdown file.
                </p>
              )}
            </div>
            <div className="preflop-confirm-actions">
              <button className="icon-button compact" onClick={() => setPendingParallelReportsAction(null)} disabled={jobBusy === "parallel-clear-reports"}>
                Cancel
              </button>
              <button
                className={`icon-button compact ${pendingParallelReportsAction.action === "clear" ? "danger" : "primary"}`}
                onClick={() => void confirmParallelReportsAction()}
                disabled={jobBusy === "parallel-clear-reports"}
              >
                {pendingParallelReportsAction.action === "clear" ? <Trash2 size={15} /> : <Download size={15} />}
                Confirm
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingServerOperationAction ? (
        <div className="modal-backdrop preflop-confirm-backdrop" role="presentation" onClick={() => setPendingServerOperationAction(null)}>
          <section
            className="preflop-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="server-operation-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preflop-confirm-icon">
              {pendingServerOperationAction.action === "clear" ? <Trash2 size={18} /> : (
                pendingServerOperationAction.action === "sync" ? <RefreshCw size={18} /> : <Upload size={18} />
              )}
            </div>
            <div>
              <h3 id="server-operation-confirm-title">
                {serverOperationConfirmTitle(pendingServerOperationAction.action)}
              </h3>
              <p>{serverOperationConfirmCopy(pendingServerOperationAction)}</p>
            </div>
            <div className="preflop-confirm-actions">
              <button className="icon-button compact" onClick={() => setPendingServerOperationAction(null)} disabled={jobBusy?.startsWith("operation-")}>
                Cancel
              </button>
              <button
                className={`icon-button compact ${pendingServerOperationAction.action === "clear" ? "danger" : "primary"}`}
                onClick={() => void confirmServerOperationAction()}
                disabled={jobBusy?.startsWith("operation-")}
              >
                {pendingServerOperationAction.action === "clear" ? <Trash2 size={15} /> : <Check size={15} />}
                Confirm
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingStatusChange ? (
        <div className="modal-backdrop preflop-confirm-backdrop" role="presentation" onClick={() => setPendingStatusChange(null)}>
          <section
            className="preflop-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preflop-status-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preflop-confirm-icon">
              <RefreshCw size={18} />
            </div>
            <div>
              <h3 id="preflop-status-confirm-title">Confirm status change?</h3>
              <p>{displayRangeName(pendingStatusChange.name)}</p>
              <div className="preflop-status-change-line">
                <span className={`preflop-status-change-chip status-${pendingStatusChange.from}`}>
                  {REVIEW_STATUS_LABELS[pendingStatusChange.from]}
                </span>
                <ChevronRight size={15} />
                <span className={`preflop-status-change-chip status-${pendingStatusChange.to}`}>
                  {REVIEW_STATUS_LABELS[pendingStatusChange.to]}
                </span>
              </div>
            </div>
            <div className="preflop-confirm-actions">
              <button className="icon-button compact" onClick={() => setPendingStatusChange(null)} disabled={saving}>
                Cancel
              </button>
              <button className="icon-button compact primary" onClick={() => void confirmRangeStatusChange()} disabled={saving}>
                <Check size={15} />
                Confirm
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {approveAllPending ? (
        <div className="modal-backdrop preflop-confirm-backdrop" role="presentation" onClick={() => setApproveAllPending(false)}>
          <section
            className="preflop-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preflop-approve-all-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preflop-confirm-icon">
              <Check size={18} />
            </div>
            <div>
              <h3 id="preflop-approve-all-title">Approve all ranges?</h3>
              <p>This will mark every range file in the library as Approved.</p>
            </div>
            <div className="preflop-confirm-actions">
              <button className="icon-button compact" onClick={() => setApproveAllPending(false)} disabled={saving}>
                Cancel
              </button>
              <button className="icon-button compact primary" onClick={() => void confirmApproveAllRanges()} disabled={saving}>
                <Check size={15} />
                Approve All
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-backdrop preflop-delete-backdrop" role="presentation" onClick={() => setDeleteTarget(null)}>
          <section
            className="preflop-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preflop-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preflop-delete-icon">
              <Trash2 size={18} />
            </div>
            <div>
              <h3 id="preflop-delete-title">
                Delete {deleteTarget.type === "folder" ? "folder" : "range"}?
              </h3>
              <p>
                <strong>{deleteTarget.type === "file" ? displayRangeName(deleteTarget.name) : deleteTarget.name}</strong>
                {deleteTarget.type === "folder" ? " and everything inside will be removed." : " will be removed."}
              </p>
            </div>
            <div className="preflop-delete-actions">
              <button className="icon-button compact" onClick={() => setDeleteTarget(null)} disabled={saving}>
                Cancel
              </button>
              <button className="icon-button compact danger" onClick={() => void confirmDeleteSelected()} disabled={saving}>
                <Trash2 size={15} />
                Delete
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

type SolverJobAction = "start" | "stop" | "force-stop" | "resume" | "switch" | "cancel" | "delete";

const JOB_ACTION_LABELS: Record<SolverJobAction, string> = {
  start: "start this job",
  stop: "stop this job",
  "force-stop": "force stop this job",
  resume: "retry this job",
  switch: "switch to this job",
  cancel: "cancel this job",
  delete: "delete this job"
};

function serverIsOnlineForJob(server: ServerRow | null | undefined): boolean {
  return server?.latest?.connectionStatus === "online";
}

function compareServersByNaturalId(left: ServerRow, right: ServerRow): number {
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
}

function parallelServerIsAvailable(server: ServerRow): boolean {
  return server.enabled && serverIsOnlineForJob(server) && !pipelineIsActiveForClient(server.pipeline);
}

function parallelServerUnavailableReason(server: ServerRow): string {
  if (!server.enabled) return "Disabled";
  const status = server.latest?.connectionStatus ?? "unknown";
  if (status !== "online") return status;
  if (pipelineIsActiveForClient(server.pipeline)) return server.pipeline?.displayStatus ?? "Busy";
  return "Not idle";
}

function pipelineIsActiveForClient(pipeline: PipelineStatusSnapshot | null): boolean {
  return Boolean(
    pipeline &&
      pipeline.processAlive !== false &&
      (pipeline.displayStatus === "running" ||
        pipeline.displayStatus === "solving" ||
        pipeline.displayStatus === "uploading" ||
        pipeline.displayStatus === "cleanup")
  );
}

function SolverJobPanel({
  servers,
  jobs,
  events,
  parallelRuns,
  failurePool,
  parallelPreview,
  selectedParallelServerIds,
  parallelServerTab,
  parallelBestServerId,
  activeTab,
  selectedServerId,
  selectedRangePath,
  selectedRangeName,
  selectedRangeLearned,
  settings,
  preview,
  serverOperations,
  uploadCandidates,
  datasetName,
  datasetRepoStatus,
  selectedScenario,
  scenarioLibrary,
  scenarioLibraryUpdatedAt,
  selectedScenarioLibraryId,
  scenarioManageMode,
  scenarioDraft,
  scenarioCopied,
  confirmUnstudied,
  busy,
  error,
  onRefresh,
  onServerChange,
  onOperationScanUploads,
  onOperationSync,
  onOperationUpload,
  onOperationStop,
  onOperationClear,
  onParallelServerToggle,
  onParallelServerTabChange,
  onParallelBestServerChange,
  onTabChange,
  onDatasetNameChange,
  onSettingsChange,
  onScenarioChange,
  onScenarioLibrarySelect,
  onScenarioManageModeChange,
  onScenarioDraftChange,
  onScenarioAdd,
  onScenarioUpdate,
  onScenarioDelete,
  onScenarioCopy,
  onConfirmUnstudiedChange,
  onPreview,
  onStartNow,
  onQueueNext,
  onParallelPreview,
  onParallelStart,
  onParallelQueueNext,
  onFailurePoolSubmit,
  onParallelCancel,
  onParallelReportsDownload,
  onParallelReportsClear,
  parallelQueueDragId,
  onParallelQueueDragStart,
  onParallelQueueDragEnd,
  onParallelQueueDrop,
  onJobAction
}: {
  servers: ServerRow[];
  jobs: SolverJob[];
  events: SolverJobEvent[];
  parallelRuns: ParallelSolverRun[];
  failurePool: ParallelFailurePoolEntry[];
  parallelPreview: ParallelSolverJobPreview | null;
  selectedParallelServerIds: string[];
  parallelServerTab: "available" | "unavailable";
  parallelBestServerId: string;
  activeTab: "single" | "parallel" | "operations";
  selectedServerId: string;
  selectedRangePath: string;
  selectedRangeName: string;
  selectedRangeLearned: boolean;
  settings: SolverJobSettings;
  preview: SolverJobPreview | null;
  serverOperations: ServerOperation[];
  uploadCandidates: ServerUploadCandidate[];
  datasetName: string;
  datasetRepoStatus: SolverDatasetRepoStatus | null;
  selectedScenario: SolverScenario | "";
  scenarioLibrary: SolverScenarioLibraryItem[];
  scenarioLibraryUpdatedAt: string | null;
  selectedScenarioLibraryId: string;
  scenarioManageMode: boolean;
  scenarioDraft: SolverScenarioLibraryItem;
  scenarioCopied: boolean;
  confirmUnstudied: boolean;
  busy: string | null;
  error: string | null;
  onRefresh: () => void;
  onServerChange: (serverId: string) => void;
  onOperationScanUploads: () => void;
  onOperationSync: () => void;
  onOperationUpload: () => void;
  onOperationStop: (operation: ServerOperation) => void;
  onOperationClear: () => void;
  onParallelServerToggle: (serverId: string) => void;
  onParallelServerTabChange: (tab: "available" | "unavailable") => void;
  onParallelBestServerChange: (serverId: string) => void;
  onTabChange: (tab: "single" | "parallel" | "operations") => void;
  onDatasetNameChange: (datasetName: string) => void;
  onSettingsChange: (patch: Partial<SolverJobSettings>) => void;
  onScenarioChange: (scenario: SolverScenario | "") => void;
  onScenarioLibrarySelect: (scenarioId: string) => void;
  onScenarioManageModeChange: (manage: boolean) => void;
  onScenarioDraftChange: (patch: Partial<SolverScenarioLibraryItem>) => void;
  onScenarioAdd: () => void;
  onScenarioUpdate: () => void;
  onScenarioDelete: () => void;
  onScenarioCopy: () => void;
  onConfirmUnstudiedChange: (checked: boolean) => void;
  onPreview: () => void;
  onStartNow: () => void;
  onQueueNext: () => void;
  onParallelPreview: () => void;
  onParallelStart: () => void;
  onParallelQueueNext: () => void;
  onFailurePoolSubmit: () => void;
  onParallelCancel: (run: ParallelSolverRun) => void;
  onParallelReportsDownload: () => void;
  onParallelReportsClear: () => void;
  parallelQueueDragId: string | null;
  onParallelQueueDragStart: (runId: string) => void;
  onParallelQueueDragEnd: () => void;
  onParallelQueueDrop: (runId: string) => void;
  onJobAction: (job: SolverJob, action: SolverJobAction) => void;
}) {
  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? null;
  const filteredJobs = selectedServerId ? jobs.filter((job) => job.serverId === selectedServerId) : jobs;
  const activeJobs = filteredJobs.filter((job) => ["deploying", "running", "stopping"].includes(job.status));
  const queuedJobs = filteredJobs.filter((job) => job.status === "queued");
  const recentJobs = filteredJobs
    .filter((job) => !["deploying", "running", "stopping", "queued"].includes(job.status))
    .slice(0, 5);
  const latestEventByJobId = useMemo(() => latestJobEvents(events), [events]);
  const requiresApproval = Boolean(selectedRangePath && !selectedRangeLearned) || Boolean(preview?.requiresConfirmation);
  const canSubmit = Boolean(selectedRangePath && selectedServerId && selectedServer);
  const submitDisabled = !canSubmit || requiresApproval || busy != null;
  const warnings = [
    ...(!selectedRangePath ? ["Select a range file before creating a job."] : []),
    ...(requiresApproval ? ["Approve this range before creating a solver job."] : []),
    ...(datasetRepoStatus && !datasetRepoStatus.exists ? ["Dataset repo must be confirmed and created before submission."] : []),
    ...(preview?.warnings ?? [])
  ].filter((warning, index, all) => all.indexOf(warning) === index);

  return (
    <section className="panel solver-job-panel">
      <div className="solver-job-head">
        <div className="panel-title">
          <ClipboardList size={16} />
          <h3>Solver Jobs</h3>
        </div>
        <button className="icon-button compact" onClick={onRefresh} disabled={busy != null}>
          <RefreshCw size={15} />
          {busy === "refresh" ? "Refreshing..." : "Refresh Status"}
        </button>
      </div>

      {error ? <div className="notice error compact-notice">{error}</div> : null}

      <div className="solver-job-tabs" role="tablist" aria-label="Solver job mode">
        <button className={activeTab === "single" ? "active" : ""} onClick={() => onTabChange("single")}>
          Job System
        </button>
        <button className={activeTab === "parallel" ? "active" : ""} onClick={() => onTabChange("parallel")}>
          Parallel Job System
        </button>
        <button className={activeTab === "operations" ? "active" : ""} onClick={() => onTabChange("operations")}>
          Server Operations
        </button>
      </div>

      {activeTab === "single" ? (
      <div className="solver-job-grid">
        <div className="solver-job-submit">
          <div className="solver-job-selected-range">
            <span>Selected Range</span>
            <strong>{selectedRangeName || "None"}</strong>
            <em className={selectedRangeLearned ? "studied" : "unstudied"}>
              {selectedRangePath ? (selectedRangeLearned ? "Approved" : "Needs approval") : "No file selected"}
            </em>
          </div>

          <div className="solver-job-form-grid">
            <label className="solver-job-field wide">
              <span>Server</span>
              <select value={selectedServerId} onChange={(event) => onServerChange(event.target.value)}>
                <option value="">Select server</option>
                {servers.slice().sort(compareServersByNaturalId).map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="solver-job-field wide">
              <span>Dataset</span>
              <input
                value={datasetName}
                placeholder="Auto from range"
                onChange={(event) => onDatasetNameChange(event.target.value)}
              />
            </label>
            <label className="solver-job-field">
              <span>Range Expr</span>
              <input
                value={settings.rangeExpr}
                onChange={(event) => onSettingsChange({ rangeExpr: event.target.value })}
              />
            </label>
            <label className="solver-job-field">
              <span>Batch Size</span>
              <input
                type="number"
                min="1"
                value={settings.batchSize}
                onChange={(event) => onSettingsChange({
                  batchSize: positiveNumberFromInput(event.target.value, settings.batchSize)
                })}
              />
            </label>
            <label className="solver-job-field">
              <span>Threads</span>
              <input
                type="number"
                value={settings.threadNum}
                onChange={(event) => onSettingsChange({
                  threadNum: integerFromInput(event.target.value, settings.threadNum)
                })}
              />
            </label>
            <label className="solver-job-field">
              <span>Max Iteration</span>
              <input
                type="number"
                min="1"
                value={settings.maxIteration}
                onChange={(event) => onSettingsChange({
                  maxIteration: positiveNumberFromInput(event.target.value, settings.maxIteration)
                })}
              />
            </label>
            <label className="solver-job-field">
              <span>Export</span>
              <select
                value={settings.exportFormat}
                onChange={(event) => onSettingsChange({ exportFormat: event.target.value as SolverExportFormat })}
              >
                {SOLVER_EXPORT_FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}
              </select>
            </label>
            <label className="solver-job-field">
              <span>Upload Format</span>
              <select
                value={settings.uploadFormat}
                onChange={(event) => onSettingsChange({ uploadFormat: event.target.value as SolverUploadFormat })}
                disabled={!settings.uploadEnabled}
              >
                {SOLVER_UPLOAD_FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}
              </select>
            </label>
            <label className="solver-job-field">
              <span>Upload Timeout</span>
              <input
                type="number"
                min="1"
                value={settings.uploadAttemptTimeoutSeconds}
                disabled={!settings.uploadEnabled}
                onChange={(event) => onSettingsChange({
                  uploadAttemptTimeoutSeconds: positiveNumberFromInput(
                    event.target.value,
                    settings.uploadAttemptTimeoutSeconds
                  )
                })}
              />
            </label>
          </div>

          <div className="solver-job-toggle-grid">
            <label>
              <input
                type="checkbox"
                checked={settings.uploadEnabled}
                onChange={(event) => onSettingsChange({ uploadEnabled: event.target.checked })}
              />
              <span>Upload</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.useIsomorphism === 1}
                onChange={(event) => onSettingsChange({ useIsomorphism: event.target.checked ? 1 : 0 })}
              />
              <span>Use isomorphism</span>
            </label>
          </div>

          <div className="solver-job-advanced-grid">
            <label className="solver-job-field">
              <span>Stall Timeout</span>
              <input
                type="number"
                min="1"
                placeholder="default"
                value={settings.stallTimeoutSeconds ?? ""}
                onChange={(event) => onSettingsChange({
                  stallTimeoutSeconds: nullablePositiveNumberFromInput(event.target.value)
                })}
              />
            </label>
            <label className="solver-job-field">
              <span>No Output Timeout</span>
              <input
                type="number"
                min="1"
                placeholder="default"
                value={settings.noOutputTimeoutSeconds ?? ""}
                onChange={(event) => onSettingsChange({
                  noOutputTimeoutSeconds: nullablePositiveNumberFromInput(event.target.value)
                })}
              />
            </label>
          </div>

          <ScenarioLibraryPanel
            scenarios={scenarioLibrary}
            updatedAt={scenarioLibraryUpdatedAt}
            selectedScenarioId={selectedScenarioLibraryId}
            explicitScenarioId={selectedScenario}
            manageMode={scenarioManageMode}
            draft={scenarioDraft}
            copied={scenarioCopied}
            busy={busy}
            onSelect={onScenarioLibrarySelect}
            onAutoSelect={() => onScenarioChange("")}
            onManageModeChange={onScenarioManageModeChange}
            onDraftChange={onScenarioDraftChange}
            onAdd={onScenarioAdd}
            onUpdate={onScenarioUpdate}
            onDelete={onScenarioDelete}
            onCopy={onScenarioCopy}
          />

          {warnings.length > 0 ? (
            <div className="solver-job-warnings">
              {warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
          ) : null}

          <div className="solver-job-actions">
            <button className="icon-button compact" onClick={onPreview} disabled={!selectedRangePath || !selectedServerId || busy != null}>
              <Search size={15} />
              Preview
            </button>
            <button className="icon-button compact primary" onClick={onStartNow} disabled={submitDisabled}>
              <Play size={15} />
              Start Now
            </button>
            <button className="icon-button compact" onClick={onQueueNext} disabled={submitDisabled}>
              <Send size={15} />
              Queue Next
            </button>
          </div>

          {preview ? (
            <div className="solver-job-preview">
              <dl>
                <div>
                  <dt>Repo</dt>
                  <dd>{preview.repoId}</dd>
                </div>
                <div>
                  <dt>Scenario</dt>
                  <dd className="solver-job-scenario-cell">
                    <select
                      value={selectedScenario}
                      onChange={(event) => onScenarioChange(event.target.value as SolverScenario | "")}
                      disabled={busy != null}
                    >
                      <option value="">Auto: {preview.scenario}</option>
                      {scenarioLibrary.map((scenario) => (
                        <option key={scenario.id} value={scenario.id}>{scenario.id}</option>
                      ))}
                    </select>
                  </dd>
                </div>
                <div>
                  <dt>Dataset</dt>
                  <dd>{preview.datasetName}</dd>
                </div>
                <div>
                  <dt>Repo Status</dt>
                  <dd>
                    {datasetRepoStatus ? (
                      <span className={`solver-dataset-repo-status ${datasetRepoStatus.exists ? "ready" : "missing"}`}>
                        {datasetRepoStatus.exists ? (datasetRepoStatus.created ? "Created" : "Exists") : "Missing"}
                      </span>
                    ) : "Not checked"}
                  </dd>
                </div>
                <div>
                  <dt>Submitted Range</dt>
                  <dd>{preview.remoteRangePath}</dd>
                </div>
                <div>
                  <dt>Result Path</dt>
                  <dd>{preview.remoteResultPath}</dd>
                </div>
              </dl>
              <pre>{preview.commandPreview}</pre>
            </div>
          ) : null}
        </div>

        <div className="solver-job-list-panel">
          <div className="solver-job-list-head">
            <strong>{selectedServer ? `${selectedServer.id} Jobs` : "Jobs"}</strong>
            <span>{filteredJobs.length}</span>
          </div>
          <SolverServerSnapshot server={selectedServer} />
          <SolverJobGroup
            title="Active"
            jobs={activeJobs}
            latestEventByJobId={latestEventByJobId}
            busy={busy}
            emptyText="No active solver job."
            onJobAction={onJobAction}
          />
          <SolverJobGroup
            title="Queued"
            jobs={queuedJobs}
            latestEventByJobId={latestEventByJobId}
            busy={busy}
            emptyText="No queued job."
            onJobAction={onJobAction}
          />
          <SolverJobGroup
            title="Recent"
            jobs={recentJobs}
            latestEventByJobId={latestEventByJobId}
            busy={busy}
            emptyText="No job history yet."
            showRecentLabels
            allowDelete
            onJobAction={onJobAction}
          />
        </div>
      </div>
      ) : activeTab === "parallel" ? (
        <ParallelSolverJobPanel
          servers={servers}
          selectedServerIds={selectedParallelServerIds}
          serverTab={parallelServerTab}
          bestServerId={parallelBestServerId}
          selectedRangePath={selectedRangePath}
          selectedRangeName={selectedRangeName}
          selectedRangeLearned={selectedRangeLearned}
          settings={settings}
          preview={parallelPreview}
          datasetName={datasetName}
          selectedScenario={selectedScenario}
          scenarioLibrary={scenarioLibrary}
          runs={parallelRuns}
          failurePool={failurePool}
          busy={busy}
          onServerToggle={onParallelServerToggle}
          onServerTabChange={onParallelServerTabChange}
          onDatasetNameChange={onDatasetNameChange}
          onSettingsChange={onSettingsChange}
          onScenarioChange={onScenarioChange}
          onPreview={onParallelPreview}
          onStart={onParallelStart}
          onQueueNext={onParallelQueueNext}
          onFailurePoolSubmit={onFailurePoolSubmit}
          onCancelRun={onParallelCancel}
          onReportsDownload={onParallelReportsDownload}
          onReportsClear={onParallelReportsClear}
          queueDragId={parallelQueueDragId}
          onQueueDragStart={onParallelQueueDragStart}
          onQueueDragEnd={onParallelQueueDragEnd}
          onQueueDrop={onParallelQueueDrop}
        />
      ) : (
        <ServerOperationsPanel
          servers={servers}
          bestServerId={parallelBestServerId}
          operations={serverOperations}
          uploadCandidates={uploadCandidates}
          busy={busy}
          onScanUploads={onOperationScanUploads}
          onSync={onOperationSync}
          onUpload={onOperationUpload}
          onStop={onOperationStop}
          onClear={onOperationClear}
          onBestServerChange={onParallelBestServerChange}
        />
      )}
    </section>
  );
}

function ScenarioLibraryPanel({
  scenarios,
  updatedAt,
  selectedScenarioId,
  explicitScenarioId,
  manageMode,
  draft,
  copied,
  busy,
  onSelect,
  onAutoSelect,
  onManageModeChange,
  onDraftChange,
  onAdd,
  onUpdate,
  onDelete,
  onCopy
}: {
  scenarios: SolverScenarioLibraryItem[];
  updatedAt: string | null;
  selectedScenarioId: string;
  explicitScenarioId: SolverScenario | "";
  manageMode: boolean;
  draft: SolverScenarioLibraryItem;
  copied: boolean;
  busy: string | null;
  onSelect: (scenarioId: string) => void;
  onAutoSelect: () => void;
  onManageModeChange: (manage: boolean) => void;
  onDraftChange: (patch: Partial<SolverScenarioLibraryItem>) => void;
  onAdd: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const selectedScenario = scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? scenarios[0] ?? null;
  const disabled = busy != null;
  return (
    <section className="solver-scenario-library">
      <div className="solver-scenario-head">
        <div>
          <strong>Scenario Library</strong>
          <span>{updatedAt ? `Updated ${formatShortDateTime(updatedAt)}` : `${scenarios.length} defaults`}</span>
        </div>
        <div className="solver-scenario-actions">
          <button className="icon-button compact" type="button" onClick={onCopy} disabled={!selectedScenario || disabled}>
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            className={`icon-button compact ${manageMode ? "primary" : ""}`}
            type="button"
            onClick={() => onManageModeChange(!manageMode)}
            disabled={disabled}
          >
            <Pencil size={14} />
            {manageMode ? "Done" : "Manage"}
          </button>
        </div>
      </div>

      <div className="solver-scenario-selector">
        <button
          type="button"
          className={!explicitScenarioId ? "active auto" : "auto"}
          onClick={onAutoSelect}
          disabled={disabled}
        >
          Auto
        </button>
        {scenarios.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            className={explicitScenarioId && selectedScenarioId === scenario.id ? "active" : ""}
            onClick={() => onSelect(scenario.id)}
            disabled={disabled}
          >
            {scenario.id}
          </button>
        ))}
      </div>

      {manageMode ? (
        <div className="solver-scenario-editor">
          <label>
            <span>ID</span>
            <input value={draft.id} onChange={(event) => onDraftChange({ id: event.target.value })} />
          </label>
          <label>
            <span>Label</span>
            <input value={draft.label} onChange={(event) => onDraftChange({ label: event.target.value })} />
          </label>
          <label>
            <span>Range Subdir</span>
            <input value={draft.rangeSubdir} onChange={(event) => onDraftChange({ rangeSubdir: event.target.value })} />
          </label>
          <label>
            <span>Config Template</span>
            <input value={draft.configTemplate} onChange={(event) => onDraftChange({ configTemplate: event.target.value })} />
          </label>
          <label>
            <span>Pot</span>
            <input
              type="number"
              min="1"
              value={draft.pot}
              onChange={(event) => onDraftChange({ pot: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Effective Stack</span>
            <input
              type="number"
              min="1"
              value={draft.effectiveStack}
              onChange={(event) => onDraftChange({ effectiveStack: Number(event.target.value) })}
            />
          </label>
          <label className="wide">
            <span>Description</span>
            <input
              value={draft.description ?? ""}
              onChange={(event) => onDraftChange({ description: event.target.value })}
            />
          </label>
          <div className="solver-scenario-editor-actions">
            <button className="icon-button compact" type="button" onClick={onAdd} disabled={disabled}>
              <FolderPlus size={14} />
              Add
            </button>
            <button className="icon-button compact primary" type="button" onClick={onUpdate} disabled={!selectedScenario || disabled}>
              <Check size={14} />
              Update
            </button>
            <button className="icon-button compact danger" type="button" onClick={onDelete} disabled={!selectedScenario || disabled}>
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>
      ) : (
        <pre className="solver-scenario-text">{selectedScenario ? formatScenarioLibraryText(selectedScenario) : ""}</pre>
      )}
    </section>
  );
}

function ParallelSolverJobPanel({
  servers,
  selectedServerIds,
  serverTab,
  bestServerId,
  selectedRangePath,
  selectedRangeName,
  selectedRangeLearned,
  settings,
  preview,
  datasetName,
  selectedScenario,
  scenarioLibrary,
  runs,
  failurePool,
  busy,
  onServerToggle,
  onServerTabChange,
  onDatasetNameChange,
  onSettingsChange,
  onScenarioChange,
  onPreview,
  onStart,
  onQueueNext,
  onFailurePoolSubmit,
  onCancelRun,
  onReportsDownload,
  onReportsClear,
  queueDragId,
  onQueueDragStart,
  onQueueDragEnd,
  onQueueDrop
}: {
  servers: ServerRow[];
  selectedServerIds: string[];
  serverTab: "available" | "unavailable";
  bestServerId: string;
  selectedRangePath: string;
  selectedRangeName: string;
  selectedRangeLearned: boolean;
  settings: SolverJobSettings;
  preview: ParallelSolverJobPreview | null;
  datasetName: string;
  selectedScenario: SolverScenario | "";
  scenarioLibrary: SolverScenarioLibraryItem[];
  runs: ParallelSolverRun[];
  failurePool: ParallelFailurePoolEntry[];
  busy: string | null;
  onServerToggle: (serverId: string) => void;
  onServerTabChange: (tab: "available" | "unavailable") => void;
  onDatasetNameChange: (datasetName: string) => void;
  onSettingsChange: (patch: Partial<SolverJobSettings>) => void;
  onScenarioChange: (scenario: SolverScenario | "") => void;
  onPreview: () => void;
  onStart: () => void;
  onQueueNext: () => void;
  onFailurePoolSubmit: () => void;
  onCancelRun: (run: ParallelSolverRun) => void;
  onReportsDownload: () => void;
  onReportsClear: () => void;
  queueDragId: string | null;
  onQueueDragStart: (runId: string) => void;
  onQueueDragEnd: () => void;
  onQueueDrop: (runId: string) => void;
}) {
  const orderedServers = servers.slice().sort(compareServersByNaturalId);
  const availableServers = orderedServers.filter(parallelServerIsAvailable);
  const unavailableServers = orderedServers.filter((server) => !parallelServerIsAvailable(server));
  const visibleServers = serverTab === "available" ? availableServers : unavailableServers;
  const selectedServers = availableServers.filter((server) => selectedServerIds.includes(server.id));
  const activeDatasetName = preview?.datasetName ?? datasetName.trim();
  const visibleFailurePool = failurePool.filter((entry) =>
    entry.rangePath === selectedRangePath &&
    (!activeDatasetName || entry.datasetName === activeDatasetName) &&
    (entry.status === "pending" || entry.status === "failed")
  );
  const baseSubmitDisabled = !selectedRangePath || !selectedRangeLearned || busy != null;
  const submitDisabled = baseSubmitDisabled || selectedServers.length === 0;
  const latestRuns = runs
    .slice()
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 6);
  const clearableRuns = terminalParallelReportRuns(runs);
  const failurePoolDatasets = summarizeFailurePoolDatasets(visibleFailurePool);
  const failurePoolReasons = summarizeFailurePoolReasons(visibleFailurePool);
  const retryableFailurePoolCount = visibleFailurePool.filter((entry) => failurePoolEntryIsRetryable(entry)).length;
  const skippedFailurePoolCount = visibleFailurePool.filter((entry) => entry.failureReason === "skipped").length;
  const normalFailurePoolCount = visibleFailurePool.filter((entry) =>
    failurePoolEntryIsRetryable(entry) && entry.failureReason !== "skipped"
  ).length;
  const failurePoolSubmitDisabled =
    baseSubmitDisabled ||
    retryableFailurePoolCount === 0 ||
    (normalFailurePoolCount > 0 && selectedServers.length === 0) ||
    (skippedFailurePoolCount > 0 && !bestServerId.trim());

  return (
    <div className="parallel-job-shell">
      <ParallelQueueBoard
        runs={runs}
        busy={busy}
        dragId={queueDragId}
        onDragStart={onQueueDragStart}
        onDragEnd={onQueueDragEnd}
        onDrop={onQueueDrop}
      />

    <div className="parallel-job-grid">
      <div className="parallel-job-submit">
        <div className="solver-job-selected-range">
          <span>Selected Range</span>
          <strong>{selectedRangeName || "None"}</strong>
          <em className={selectedRangeLearned ? "studied" : "unstudied"}>
            {selectedRangePath ? (selectedRangeLearned ? "Approved" : "Needs approval") : "No file selected"}
          </em>
        </div>

        <div className="parallel-server-strip">
          <div className="parallel-section-title">
            <strong>Servers</strong>
            <span>{selectedServers.length}/{availableServers.length} available selected</span>
          </div>
          <div className="parallel-server-tabs" role="tablist" aria-label="Parallel server availability">
            <button
              type="button"
              className={serverTab === "available" ? "active" : ""}
              onClick={() => onServerTabChange("available")}
            >
              Available
              <em>{availableServers.length}</em>
            </button>
            <button
              type="button"
              className={serverTab === "unavailable" ? "active" : ""}
              onClick={() => onServerTabChange("unavailable")}
            >
              Unavailable
              <em>{unavailableServers.length}</em>
            </button>
          </div>
          <div className="parallel-server-tags">
            {visibleServers.length === 0 ? (
              <span className="text-muted">
                {serverTab === "available" ? "No online idle enabled servers." : "No unavailable servers."}
              </span>
            ) : null}
            {visibleServers.map((server) => {
              const selected = selectedServerIds.includes(server.id);
              const available = parallelServerIsAvailable(server);
              const isBestServer = server.id === bestServerId;
              return (
                <button
                  key={server.id}
                  className={[
                    "parallel-server-tag",
                    selected ? "selected" : "",
                    available ? "available" : "unavailable"
                  ].filter(Boolean).join(" ")}
                  onClick={() => available && onServerToggle(server.id)}
                  disabled={busy != null || !available}
                >
                  <strong className="parallel-server-id">{server.id}</strong>
                  <ConnectionBadge status={server.latest?.connectionStatus ?? "unknown"} />
                  {isBestServer ? <small className="parallel-server-best-badge">Best</small> : null}
                  <em>{available ? "Idle" : parallelServerUnavailableReason(server)}</em>
                </button>
              );
            })}
          </div>
        </div>

        <div className="solver-job-form-grid parallel-config-grid">
          <label className="solver-job-field wide">
            <span>Dataset</span>
            <input value={datasetName} placeholder="Auto from range" onChange={(event) => onDatasetNameChange(event.target.value)} />
          </label>
          <label className="solver-job-field wide">
            <span>Scenario</span>
            <select value={selectedScenario} onChange={(event) => onScenarioChange(event.target.value as SolverScenario | "")}>
              <option value="">Auto</option>
              {scenarioLibrary.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.id}</option>)}
            </select>
          </label>
          <label className="solver-job-field">
            <span>Batch Size</span>
            <input
              type="number"
              min="1"
              value={settings.batchSize}
              onChange={(event) => onSettingsChange({ batchSize: positiveNumberFromInput(event.target.value, settings.batchSize) })}
            />
          </label>
          <label className="solver-job-field">
            <span>Threads</span>
            <input
              type="number"
              value={settings.threadNum}
              onChange={(event) => onSettingsChange({ threadNum: integerFromInput(event.target.value, settings.threadNum) })}
            />
          </label>
          <label className="solver-job-field">
            <span>Max Iteration</span>
            <input
              type="number"
              min="1"
              value={settings.maxIteration}
              onChange={(event) => onSettingsChange({ maxIteration: positiveNumberFromInput(event.target.value, settings.maxIteration) })}
            />
          </label>
          <label className="solver-job-field">
            <span>Upload</span>
            <select
              value={settings.uploadEnabled ? "on" : "off"}
              onChange={(event) => onSettingsChange({ uploadEnabled: event.target.value === "on" })}
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </label>
        </div>

        <div className="solver-job-actions">
          <button className="icon-button compact" onClick={onPreview} disabled={submitDisabled}>
            <Search size={15} />
            Preview Distribution
          </button>
          <button className="icon-button compact primary" onClick={onStart} disabled={submitDisabled || (preview != null && preview.missingIndices.length === 0)}>
            <Play size={15} />
            Start Parallel
          </button>
          <button className="icon-button compact" onClick={onQueueNext} disabled={submitDisabled || (preview != null && preview.missingIndices.length === 0)}>
            <Send size={15} />
            Queue Next
          </button>
          <button className="icon-button compact" onClick={onFailurePoolSubmit} disabled={failurePoolSubmitDisabled}>
            <RotateCcw size={15} />
            Queue Failure Pool
          </button>
        </div>

        {!selectedRangeLearned && selectedRangePath ? (
          <div className="notice warning compact-notice">Approve this range before creating parallel jobs.</div>
        ) : null}

        {preview ? (
          <div className="parallel-preview-panel">
            <div className="parallel-preview-summary">
              <div><span>Repo</span><strong>{preview.repoId}</strong></div>
              <div><span>Missing</span><strong>{preview.missingIndices.length}</strong></div>
              <div><span>Chunks</span><strong>{preview.allocations.filter((item) => item.indices.length > 0).length}</strong></div>
              <div><span>Repo Status</span><strong>{preview.repoExists ? "Exists" : "Missing"}</strong></div>
            </div>
            <div className="parallel-allocation-list">
              {preview.allocations.map((allocation, index) => (
                <article key={`${allocation.server.id}:${allocation.rangeExpr}:${index}`} className="parallel-allocation-row">
                  <div>
                    <strong>Chunk {index + 1}</strong>
                    <span>{allocation.indices.length} boards · Pool {allocation.candidateServerIds.join(", ")}</span>
                  </div>
                  <code>{allocation.rangeExpr || "-"}</code>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="parallel-job-report-panel">
        <div className="parallel-report-block">
          <div className="parallel-section-title">
            <strong>Failure Pool</strong>
            <span>{retryableFailurePoolCount}/{visibleFailurePool.length} retryable</span>
          </div>
          {failurePoolReasons.length > 0 ? (
            <div className="failure-pool-reason-list">
              {failurePoolReasons.map((item) => (
                <span key={item.reason} className={`failure-reason-chip ${item.reason}`}>
                  <strong>{failureReasonLabel(item.reason)}</strong>
                  <em>{item.count}</em>
                </span>
              ))}
            </div>
          ) : null}
          {failurePoolDatasets.length > 0 ? (
            <div className="failure-pool-dataset-list">
              {failurePoolDatasets.map((item) => (
                <span key={item.datasetName} className="failure-pool-dataset-chip">
                  <strong>{item.datasetName}</strong>
                  <em>{item.count}</em>
                </span>
              ))}
            </div>
          ) : null}
          {visibleFailurePool.length === 0 ? (
            <p className="solver-job-empty">No pending failed boards for this range.</p>
          ) : (
            <div className="failure-pool-list">
              {visibleFailurePool.slice(0, 24).map((entry) => (
                <span key={entry.id} className={`failure-pool-chip ${entry.status} ${entry.failureReason}`}>
                  <em>{entry.datasetName}</em>
                  {entry.boardIndex}. {entry.boardName}
                  <small>{failureReasonLabel(entry.failureReason)}</small>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="parallel-report-block">
          <div className="parallel-section-title parallel-section-title-with-actions">
            <div>
              <strong>Parallel Reports</strong>
              <span>{runs.length} total · {clearableRuns.length} clearable</span>
            </div>
            <div className="parallel-report-actions">
              <button className="icon-button compact" type="button" onClick={onReportsDownload} disabled={runs.length === 0 || busy != null}>
                <Download size={14} />
                Download
              </button>
              <button
                className="icon-button compact danger"
                type="button"
                onClick={onReportsClear}
                disabled={clearableRuns.length === 0 || busy != null}
              >
                <Trash2 size={14} />
                Clear
              </button>
            </div>
          </div>
          {latestRuns.length === 0 ? <p className="solver-job-empty">No parallel runs yet.</p> : null}
          {latestRuns.map((run) => {
            const dispatch = parallelDispatchState(run);
            return (
            <article key={run.id} className={`parallel-run-card ${run.status} ${dispatch.className}`}>
              <div className="parallel-run-head">
                <div>
                  <strong>{run.datasetName}</strong>
                  <span>
                    {run.sourceType === "failure_pool" ? "Failure pool retry" : "Parallel run"} · {formatShortDateTime(run.createdAt)} · {dispatch.summary}
                  </span>
                </div>
                <em className={`solver-job-status ${dispatch.className || run.status}`}>{dispatch.label}</em>
              </div>
              <div className="parallel-run-metrics">
                <div><span>Total</span><strong>{run.report.totalBoards}</strong></div>
                <div><span>Dispatch</span><strong>{dispatch.metric}</strong></div>
                <div><span>Done</span><strong>{run.report.completedBoards}</strong></div>
                <div><span>Failed</span><strong>{run.report.failedBoards}</strong></div>
                <div><span>Success</span><strong>{formatRatio(run.report.successRate)}</strong></div>
                <div><span>Duration</span><strong>{formatDuration(run.report.durationSeconds)}</strong></div>
              </div>
              <div className="parallel-slice-list">
                {run.slices.map((slice) => (
                  <div key={slice.id} className={`parallel-slice-row ${slice.status}`}>
                    <span>{formatSliceServerId(slice)}</span>
                    <strong>{slice.assignedIndices.length}</strong>
                    <em>{slice.status}</em>
                    <small>{slice.status === "queued" ? slice.lastError ?? slice.job?.lastError ?? "Pending dispatch" : slice.rangeExpr}</small>
                  </div>
                ))}
              </div>
              {["queued", "running"].includes(run.status) ? (
                <button className="icon-button compact danger" onClick={() => onCancelRun(run)} disabled={busy === `parallel-cancel:${run.id}`}>
                  <X size={14} />
                  Cancel
                </button>
              ) : null}
            </article>
          );
          })}
        </div>
      </div>
    </div>
    </div>
  );
}

function ParallelQueueBoard({
  runs,
  busy,
  dragId,
  onDragStart,
  onDragEnd,
  onDrop
}: {
  runs: ParallelSolverRun[];
  busy: string | null;
  dragId: string | null;
  onDragStart: (runId: string) => void;
  onDragEnd: () => void;
  onDrop: (runId: string) => void;
}) {
  const queueRuns = parallelQueueRuns(runs);
  const movableCount = queueRuns.filter((run) => run.status === "queued" && !parallelRunIsLocked(run)).length;

  return (
    <section className="parallel-queue-board">
      <div className="parallel-section-title">
        <strong>Parallel Queue</strong>
        <span>{queueRuns.length} active / queued · {movableCount} movable</span>
      </div>
      {queueRuns.length === 0 ? (
        <p className="solver-job-empty">No active or queued parallel run.</p>
      ) : (
        <div className="parallel-queue-lane" aria-label="Parallel queue order">
          {queueRuns.map((run, index) => {
            const locked = parallelRunIsLocked(run);
            const movable = run.status === "queued" && !locked && busy == null;
            const isDragging = dragId === run.id;
            const canDrop = movable && dragId != null && dragId !== run.id;
            const dispatch = parallelDispatchState(run);
            const runningServers = run.slices.filter((slice) => slice.status === "running").map((slice) => formatSliceServerId(slice));
            const serverText = runningServers.length > 0
              ? `${runningServers.length} running: ${runningServers.join(", ")}`
              : `${run.serverIds.length} server${run.serverIds.length === 1 ? "" : "s"}`;
            return (
              <article
                key={run.id}
                className={[
                  "parallel-queue-item",
                  run.status,
                  run.sourceType,
                  locked ? "locked" : "",
                  movable ? "movable" : "",
                  isDragging ? "dragging" : ""
                ].filter(Boolean).join(" ")}
                draggable={movable}
                onDragStart={(event) => {
                  if (!movable) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", run.id);
                  onDragStart(run.id);
                }}
                onDragOver={(event) => {
                  if (!canDrop) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  if (!canDrop) return;
                  event.preventDefault();
                  onDrop(run.id);
                }}
                onDragEnd={onDragEnd}
              >
                <div className="parallel-queue-rank">{index + 1}</div>
                <div className="parallel-queue-marker" aria-hidden="true" />
                <div className="parallel-queue-copy">
                  <strong>{run.datasetName}</strong>
                  <span>
                    {run.sourceType === "failure_pool" ? "Pool retry" : "Parallel run"} · {run.report.totalBoards} boards · {serverText} · {dispatch.summary}
                  </span>
                </div>
                <div className="parallel-queue-state">
                  <em className={`solver-job-status ${dispatch.className || run.status}`}>{dispatch.label}</em>
                  {locked ? (
                    <span className="parallel-queue-lock" title="Locked while any server is running this run">
                      <Lock size={12} />
                    </span>
                  ) : (
                    <span className="parallel-queue-grip" title={movable ? "Drag to reorder" : "Queued run can be moved after refresh"}>
                      <GripVertical size={14} />
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ServerOperationsPanel({
  servers,
  bestServerId,
  operations,
  uploadCandidates,
  busy,
  onScanUploads,
  onSync,
  onUpload,
  onStop,
  onClear,
  onBestServerChange
}: {
  servers: ServerRow[];
  bestServerId: string;
  operations: ServerOperation[];
  uploadCandidates: ServerUploadCandidate[];
  busy: string | null;
  onScanUploads: () => void;
  onSync: () => void;
  onUpload: () => void;
  onStop: (operation: ServerOperation) => void;
  onClear: () => void;
  onBestServerChange: (serverId: string) => void;
}) {
  const orderedServers = servers.slice().sort(compareServersByNaturalId);
  const onlineServers = orderedServers.filter((server) => server.enabled && serverIsOnlineForJob(server));
  const offlineServers = orderedServers.filter((server) => server.enabled && !serverIsOnlineForJob(server));
  const bestServer = orderedServers.find((server) => server.id === bestServerId) ?? null;
  const terminalCount = operations.filter((operation) => serverOperationIsTerminal(operation)).length;
  const operationSummary = summarizeServerOperations(operations);
  const candidateSummary = summarizeUploadCandidates(uploadCandidates);
  const activeOperations = operations
    .filter((operation) => !serverOperationIsTerminal(operation))
    .sort(compareServerOperations);
  const operationRows = operations.slice().sort(compareServerOperations);
  const operationBusy = busy?.startsWith("operation-") ?? false;

  return (
    <div className="server-ops-shell">
      <section className="server-ops-command-center">
        <div className="server-ops-command-copy">
          <strong>Server Operations</strong>
          <span>{onlineServers.length} SSH-ready · {offlineServers.length} unavailable · {operations.length} tracked operations</span>
        </div>
        <label className="solver-job-field best-server-field">
          <span>Best Server</span>
          <select value={bestServerId} onChange={(event) => onBestServerChange(event.target.value)} disabled={operationBusy}>
            <option value="">Select</option>
            {orderedServers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.id}{server.latest?.connectionStatus ? ` · ${server.latest.connectionStatus}` : ""}
              </option>
            ))}
          </select>
        </label>
      </section>
      {bestServerId && !bestServer ? (
        <div className="notice warning compact-notice">Best Server ID is not in the current server inventory.</div>
      ) : null}

      <div className="server-ops-overview-grid">
        <ServerOperationMetric label="Sync Commands" value={operationSummary.syncTotal} detail={`${operationSummary.syncLatest} latest · ${operationSummary.syncSynced} synced`} />
        <ServerOperationMetric label="Sync Failed" value={operationSummary.syncFailed} detail="terminal sync failures" />
        <ServerOperationMetric label="Upload Commands" value={operationSummary.uploadTotal} detail={`${operationSummary.uploadSuccess} completed`} />
        <ServerOperationMetric label="Upload Failed" value={operationSummary.uploadFailed} detail={`${operationSummary.noFiles} no-file server(s)`} />
      </div>

      <div className="server-ops-grid">
        <section className="server-ops-card">
          <div className="parallel-section-title">
            <div>
              <strong>Sync Code</strong>
              <span>{onlineServers.length} online enabled target{onlineServers.length === 1 ? "" : "s"}</span>
            </div>
            <button className="icon-button compact primary" type="button" onClick={onSync} disabled={operationBusy || onlineServers.length === 0}>
              <RefreshCw size={14} />
              New Sync Tmux
            </button>
          </div>
          <div className="server-ops-target-list">
            {onlineServers.length === 0 ? <p className="solver-job-empty">No online enabled server.</p> : null}
            {onlineServers.map((server) => (
              <span key={server.id} className="server-ops-target-chip">
                <strong>{server.id}</strong>
                <ConnectionBadge status={server.latest?.connectionStatus ?? "unknown"} />
                <em>{server.solverRoot || "~/solver"}</em>
              </span>
            ))}
          </div>
          <pre className="server-ops-command-preview">{`cd "$HOME/solver" && export http_proxy='http://127.0.0.1:7890' && export https_proxy='http://127.0.0.1:7890' && git stash && git pull --rebase`}</pre>
        </section>

        <section className="server-ops-card">
          <div className="parallel-section-title">
            <div>
              <strong>Scan + Upload All</strong>
              <span>{candidateSummary.folders} folders · {candidateSummary.files} files found in last scan</span>
            </div>
            <button className="icon-button compact primary" type="button" onClick={onUpload} disabled={operationBusy || onlineServers.length === 0}>
              <Upload size={14} />
              Upload All
            </button>
          </div>

          <div className="server-ops-upload-controls auto">
            <button className="icon-button compact" type="button" onClick={onScanUploads} disabled={operationBusy || onlineServers.length === 0}>
              <Search size={14} />
              Scan All Results
            </button>
            <span className="server-ops-muted">Upload All performs a fresh scan before starting tmux sessions.</span>
          </div>

          <div className="server-ops-upload-list">
            {uploadCandidates.length === 0 ? (
              <p className="solver-job-empty">Scan all SSH-ready servers to preview retained result folders under results/&lt;dataset&gt;/&lt;job-id&gt;.</p>
            ) : null}
            {uploadCandidates.map((candidate) => {
              return (
                <article key={candidate.id} className="server-ops-upload-row selected">
                  <div className="server-ops-upload-check">
                    <strong>{candidate.serverId}</strong>
                    <span>
                      <strong>{candidate.datasetName}</strong>
                      <em>{candidate.jobId}</em>
                    </span>
                  </div>
                  <div className="server-ops-upload-meta">
                    <span>{candidate.parquetCount} parquet</span>
                    <span>{candidate.jsonCount} json</span>
                    <code>{candidate.resultsDir}</code>
                  </div>
                  <code className="server-ops-repo-code">{candidate.repoId}</code>
                  <span className="server-ops-format-pill">{candidate.fileFormat}</span>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <section className="server-ops-card">
        <div className="parallel-section-title parallel-section-title-with-actions">
          <div>
            <strong>Operation Report</strong>
            <span>{activeOperations.length} active · {operationRows.length} total · {terminalCount} clearable</span>
          </div>
          <button className="icon-button compact danger" type="button" onClick={onClear} disabled={operationBusy || terminalCount === 0}>
            <Trash2 size={14} />
            Clear
          </button>
        </div>
        <div className="server-ops-report-grid">
          <ServerOperationMetric label="Already Latest" value={operationSummary.syncLatest} detail="git already up to date" />
          <ServerOperationMetric label="Synced" value={operationSummary.syncSynced} detail="pulled successfully" />
          <ServerOperationMetric label="Sync Failed" value={operationSummary.syncFailed} detail="needs manual check" />
          <ServerOperationMetric label="Files Requested" value={operationSummary.filesRequested} detail="upload operation input" />
        </div>
        {operationRows.length === 0 ? <p className="solver-job-empty">No server operation has been recorded.</p> : null}
        {operationRows.length > 0 ? (
          <div className="server-ops-history-table-wrap">
            <table className="server-ops-history-table">
              <thead>
                <tr>
                  <th>Server ID</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {operationRows.map((operation) => (
                  <ServerOperationRow
                    key={operation.id}
                    operation={operation}
                    busy={busy}
                    onStop={onStop}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ServerOperationRow({
  operation,
  busy,
  onStop
}: {
  operation: ServerOperation;
  busy: string | null;
  onStop: (operation: ServerOperation) => void;
}) {
  const active = !serverOperationIsTerminal(operation);
  const stopping = busy === `operation-stop:${operation.id}`;
  const result = serverOperationCompactResult(operation);
  return (
    <tr className={`server-ops-history-row ${operation.status} ${operation.type}`}>
      <td>
        <strong>{operation.serverId}</strong>
      </td>
      <td>{serverOperationTypeLabel(operation.type)}</td>
      <td>
        <span className={`server-ops-status-pill ${operation.status}`}>{formatServerOperationStatus(operation.status)}</span>
      </td>
      <td>
        <span className={`server-ops-result-pill ${result.tone}`}>{result.label}</span>
      </td>
      <td>{formatShortDateTime(operation.createdAt)}</td>
      <td>
        {active ? (
          <button className="inventory-confirm-button danger" type="button" onClick={() => onStop(operation)} disabled={stopping}>
            <Square size={14} />
            {stopping ? "Stopping" : "Stop"}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ServerOperationMetric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <div className="server-ops-overview-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

function SolverServerSnapshot({ server }: { server: ServerRow | null }) {
  if (!server) {
    return (
      <div className="solver-server-snapshot empty">
        <div className="solver-server-snapshot-head">
          <strong>No server selected</strong>
          <span className="text-muted">Select a server to inspect task status.</span>
        </div>
      </div>
    );
  }

  const task = server.pipeline;
  return (
    <div className="solver-server-snapshot">
      <div className="solver-server-snapshot-head">
        <div>
          <strong>{server.id}</strong>
          <span>{server.host}:{server.port}</span>
        </div>
        <div className="solver-server-badges">
          <ConnectionBadge status={server.latest?.connectionStatus ?? "unknown"} />
          {task ? <SolverTaskBadge status={task.displayStatus} /> : <span className="badge task-badge unavailable">no task</span>}
        </div>
      </div>

      <div className="solver-server-metrics">
        <SolverServerMetric label="Process" value={task ? formatProcessAlive(task.processAlive) : "-"} />
        <SolverServerMetric label="Dataset" value={task?.datasetName ?? task?.repoId ?? server.lastDatasetName ?? "-"} />
        <SolverServerMetric label="Batch" value={task ? formatTaskBatch(task) : "-"} />
        <SolverServerMetric label="CPU" value={formatMetricPercent(server.latest?.cpuUsedPercent)} />
        <SolverServerMetric label="Memory" value={formatMetricPercent(server.latest?.memoryUsedPercent)} />
        <SolverServerMetric label="Disk" value={formatMetricPercent(server.latest?.diskUsedPercent)} />
        <SolverServerMetric label="Updated" value={formatTaskUpdated(task)} />
      </div>

      {task?.error || task?.errorMessage ? (
        <p className="solver-server-error">{task.errorMessage ?? task.error}</p>
      ) : null}
    </div>
  );
}

function SolverServerMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return <span className={`badge conn-badge ${status}`}>{status}</span>;
}

function SolverTaskBadge({ status }: { status: PipelineDisplayStatus }) {
  return <span className={`badge task-badge ${status}`}>{formatTaskStatusLabel(status)}</span>;
}

function SolverJobGroup({
  title,
  jobs,
  latestEventByJobId,
  busy,
  emptyText,
  showRecentLabels = false,
  allowDelete = false,
  onJobAction
}: {
  title: string;
  jobs: SolverJob[];
  latestEventByJobId: Map<string, SolverJobEvent>;
  busy: string | null;
  emptyText: string;
  showRecentLabels?: boolean;
  allowDelete?: boolean;
  onJobAction: (job: SolverJob, action: SolverJobAction) => void;
}) {
  return (
    <div className="solver-job-group">
      <h4>{title}</h4>
      {jobs.length === 0 ? <p className="solver-job-empty">{emptyText}</p> : null}
      {jobs.map((job) => (
        <SolverJobCard
          key={job.id}
          job={job}
          latestEvent={latestEventByJobId.get(job.id) ?? null}
          busy={busy}
          showRecentLabels={showRecentLabels}
          allowDelete={allowDelete}
          onJobAction={onJobAction}
        />
      ))}
    </div>
  );
}

function SolverJobCard({
  job,
  latestEvent,
  busy,
  showRecentLabels,
  allowDelete,
  onJobAction
}: {
  job: SolverJob;
  latestEvent: SolverJobEvent | null;
  busy: string | null;
  showRecentLabels: boolean;
  allowDelete: boolean;
  onJobAction: (job: SolverJob, action: SolverJobAction) => void;
}) {
  const jobBusy = Boolean(busy?.endsWith(job.id));
  const canRetry = job.status === "interrupted" || job.status === "failed";
  return (
    <article className={`solver-job-card ${job.status}`}>
      <div className="solver-job-card-head">
        <div>
          <strong>{job.datasetName}</strong>
          <span>{job.scenario} · {displayRangeName(job.rangeName)}</span>
        </div>
        <em className={`solver-job-status ${job.status}`}>{formatJobStatus(job.status)}</em>
      </div>
      <dl>
        <div>
          <dt>{showRecentLabels ? "Dataset Repo" : "Repo"}</dt>
          <dd>{job.repoId}</dd>
        </div>
        <div>
          <dt>{showRecentLabels ? "Created Time" : "Created"}</dt>
          <dd>{formatShortDateTime(job.createdAt)}</dd>
        </div>
      </dl>
      {latestEvent ? <p className="solver-job-event">{latestEvent.message}</p> : null}
      {job.lastError ? <p className="solver-job-error">{job.lastError}</p> : null}
      <div className="solver-job-card-actions">
        {job.status === "queued" ? (
          <>
            <button className="inventory-action-button primary" title="Start" disabled={jobBusy} onClick={() => onJobAction(job, "start")}>
              <Play size={14} />
            </button>
            <button className="inventory-action-button" title="Switch now" disabled={jobBusy} onClick={() => onJobAction(job, "switch")}>
              <Send size={14} />
            </button>
            <button className="inventory-action-button danger" title="Cancel" disabled={jobBusy} onClick={() => onJobAction(job, "cancel")}>
              <X size={14} />
            </button>
          </>
        ) : null}
        {["deploying", "running", "stopping"].includes(job.status) ? (
          <>
            <button className="inventory-action-button danger" title="Stop" disabled={jobBusy || job.status === "stopping"} onClick={() => onJobAction(job, "stop")}>
              <Square size={14} />
            </button>
            <button className="inventory-action-button danger" title="Force Kill" disabled={jobBusy} onClick={() => onJobAction(job, "force-stop")}>
              <Trash2 size={14} />
            </button>
          </>
        ) : null}
        {canRetry ? (
          allowDelete ? (
            <button className="inventory-confirm-button" title="Retry" disabled={jobBusy} onClick={() => onJobAction(job, "resume")}>
              <RotateCcw size={14} />
              Retry
            </button>
          ) : (
            <button className="inventory-action-button" title="Retry" disabled={jobBusy} onClick={() => onJobAction(job, "resume")}>
              <RotateCcw size={14} />
            </button>
          )
        ) : null}
        {allowDelete ? (
          <button className="inventory-confirm-button danger" title="Delete" disabled={jobBusy} onClick={() => onJobAction(job, "delete")}>
            <Trash2 size={14} />
            Delete
          </button>
        ) : null}
      </div>
    </article>
  );
}

function PreflopFolderBranch(props: {
  item: PreflopRangeFolderItem;
  depth: number;
  activePath: string;
  expandedFolders: Set<string>;
  query: string;
  dropTarget: DropTarget | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDragStartItem: (item: PreflopRangeFolderItem) => void;
  onDragOverFolder: (path: string) => void;
  onDropFolder: (path: string) => void;
}): ReactNode {
  if (!folderHasMatch(props.item, props.query)) return null;
  const expanded = props.query.trim() !== "" || props.expandedFolders.has(props.item.path);
  return (
    <>
      <PreflopFolderRow {...props} />
      {expanded ? props.item.children.flatMap((child) =>
        child.type === "folder" ? (
          <PreflopFolderBranch key={child.path} {...props} item={child} depth={props.depth + 1} />
        ) : []
      ) : null}
    </>
  );
}

function PreflopFolderRow({
  item,
  depth,
  activePath,
  expandedFolders,
  query,
  dropTarget,
  onToggle,
  onSelect,
  onDragStartItem,
  onDragOverFolder,
  onDropFolder
}: {
  item: PreflopRangeFolderItem;
  depth: number;
  activePath: string;
  expandedFolders: Set<string>;
  query: string;
  dropTarget: DropTarget | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDragStartItem: (item: PreflopRangeFolderItem) => void;
  onDragOverFolder: (path: string) => void;
  onDropFolder: (path: string) => void;
}) {
  const hasChildFolders = item.path !== "" && item.children.some((child) => child.type === "folder");
  const expanded = query.trim() !== "" || expandedFolders.has(item.path);
  return (
    <button
      className={[
        "preflop-folder-row",
        activePath === item.path ? "active" : "",
        dropTarget?.path === item.path && dropTarget.mode === "inside" ? "drop-inside" : ""
      ].filter(Boolean).join(" ")}
      style={{ paddingLeft: 4 + depth * 12 }}
      draggable={item.path !== ""}
      onClick={() => {
        onSelect(item.path);
        if (hasChildFolders && query.trim() === "") onToggle(item.path);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStartItem(item);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOverFolder(item.path);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropFolder(item.path);
      }}
    >
      <span
        className="preflop-folder-expander"
        onClick={(event) => {
          event.stopPropagation();
          if (hasChildFolders) onToggle(item.path);
        }}
      >
        {hasChildFolders ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
      </span>
      <Folder size={14} />
      <span>{item.name}</span>
      <strong className="preflop-folder-count">{countFolderFiles(item)}</strong>
    </button>
  );
}

function RangeMatrix({
  player,
  role,
  summary,
  active,
  selectedHand,
  onPlayerSelect,
  onHandSelect
}: {
  player: PreflopPlayerKey;
  role: string;
  summary: PreflopRangeSummary;
  active: boolean;
  selectedHand: string;
  onPlayerSelect: () => void;
  onHandSelect: (hand: PreflopHandCode) => void;
}) {
  const data = summary.players[player];
  return (
    <article className={`preflop-matrix-card ${active ? "active" : ""}`} onClick={onPlayerSelect}>
      <div className="preflop-matrix-head">
        <div>
          <h3>{data.position && data.position !== "Unknown" ? `${data.name} · ${data.position}` : data.name}</h3>
          <p>{role} range · player {player}</p>
        </div>
        <div className="preflop-matrix-stats">
          <span className="raise">Raise {data.stats.raise.toFixed(1)}%</span>
          <span className="call">Call {data.stats.call.toFixed(1)}%</span>
          <span>Fold {data.stats.fold.toFixed(1)}%</span>
        </div>
      </div>

      <div className="preflop-matrix">
        <div className="preflop-matrix-label" />
        {PREFLOP_RANKS.map((rank) => <div key={`col-${rank}`} className="preflop-matrix-label">{rank}</div>)}
        {PREFLOP_HAND_GRID.map((row, rowIndex) => (
          <div className="preflop-matrix-row-fragment" key={row[0]}>
            <div className="preflop-matrix-label">{PREFLOP_RANKS[rowIndex]}</div>
            {row.map((hand) => {
              const value = data.matrix[hand] ?? { raise: 0, call: 0 };
              const filled = value.raise + value.call > 0;
              return (
                <button
                  key={`${player}-${hand}`}
                  className={[
                    "preflop-hand-cell",
                    filled ? "filled" : "",
                    selectedHand === hand ? "selected" : ""
                  ].filter(Boolean).join(" ")}
                  title={`${hand}: raise ${(value.raise * 100).toFixed(0)}%, call ${(value.call * 100).toFixed(0)}%`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlayerSelect();
                    onHandSelect(hand);
                  }}
                >
                  <span className="preflop-seg-raise" style={{ width: `${value.raise * 100}%` }} />
                  <span className="preflop-seg-call" style={{ left: `${value.raise * 100}%`, width: `${value.call * 100}%` }} />
                  <strong>{hand}</strong>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </article>
  );
}

function orderedRangePlayers(summary: PreflopRangeSummary): Array<{ player: PreflopPlayerKey; role: string }> {
  const byPosition = (position: "IP" | "OOP") =>
    PREFLOP_PLAYERS.find((player) => summary.players[player].position === position);
  const ip = byPosition("IP");
  const oop = byPosition("OOP");
  if (ip && oop && ip !== oop) {
    return [
      { player: ip, role: "IP" },
      { player: oop, role: "OOP" }
    ];
  }
  return PREFLOP_PLAYERS.map((player) => ({
    player,
    role: summary.players[player].position !== "Unknown" ? summary.players[player].position : player
  }));
}

function preferredActivePlayer(summary: PreflopRangeSummary): PreflopPlayerKey {
  return orderedRangePlayers(summary)[0]?.player ?? "A";
}

function defaultSolverServerId(servers: ServerRow[]): string {
  const orderedServers = servers.slice().sort(compareServersByNaturalId);
  return (
    orderedServers.find((server) => server.enabled)?.id ??
    orderedServers[0]?.id ??
    ""
  );
}

function positiveNumberFromInput(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function integerFromInput(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function nullablePositiveNumberFromInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function latestJobEvents(events: SolverJobEvent[]): Map<string, SolverJobEvent> {
  const latest = new Map<string, SolverJobEvent>();
  for (const event of events) {
    const current = latest.get(event.jobId);
    if (!current || event.createdAt > current.createdAt) {
      latest.set(event.jobId, event);
    }
  }
  return latest;
}

function formatJobStatus(status: SolverJob["status"]): string {
  return status.replace(/_/g, " ");
}

function formatParallelRunStatus(status: ParallelSolverRun["status"]): string {
  return status.replace(/_/g, " ");
}

function formatServerOperationStatus(status: ServerOperation["status"]): string {
  return status.replace(/_/g, " ");
}

function serverOperationTypeLabel(type: ServerOperation["type"]): string {
  return type === "sync" ? "Sync" : "Upload";
}

function serverOperationIsTerminal(operation: ServerOperation): boolean {
  return operation.status === "completed" || operation.status === "failed" || operation.status === "canceled";
}

function compareServerOperations(left: ServerOperation, right: ServerOperation): number {
  const activeDelta = Number(serverOperationIsTerminal(left)) - Number(serverOperationIsTerminal(right));
  if (activeDelta !== 0) return activeDelta;
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function summarizeUploadCandidates(candidates: ServerUploadCandidate[]): { folders: number; files: number; servers: number } {
  return {
    folders: candidates.length,
    files: candidates.reduce((total, candidate) => total + candidate.fileCount, 0),
    servers: new Set(candidates.map((candidate) => candidate.serverId)).size
  };
}

function summarizeServerOperations(operations: ServerOperation[]): {
  syncTotal: number;
  syncSynced: number;
  syncLatest: number;
  syncFailed: number;
  uploadTotal: number;
  uploadSuccess: number;
  uploadFailed: number;
  filesRequested: number;
  noFiles: number;
} {
  const summary = {
    syncTotal: 0,
    syncSynced: 0,
    syncLatest: 0,
    syncFailed: 0,
    uploadTotal: 0,
    uploadSuccess: 0,
    uploadFailed: 0,
    filesRequested: 0,
    noFiles: 0
  };
  for (const operation of operations) {
    const result = operation.result?.summary ?? {};
    if (operation.type === "sync") {
      summary.syncTotal += 1;
      summary.syncLatest += numericResult(result.latest);
      summary.syncSynced += numericResult(result.synced);
      summary.syncFailed += operation.status === "failed" ? 1 : numericResult(result.failed);
    } else {
      summary.uploadTotal += 1;
      summary.uploadSuccess += numericResult(result.upload_success);
      summary.uploadFailed += operation.status === "failed" ? Math.max(1, numericResult(result.upload_failed)) : numericResult(result.upload_failed);
      summary.filesRequested += numericResult(result.files_requested);
      summary.noFiles += numericResult(result.no_files);
    }
  }
  return summary;
}

function serverOperationCompactResult(operation: ServerOperation): { label: string; tone: "success" | "danger" | "warning" | "neutral" | "active" } {
  const summary = operation.result?.summary ?? {};
  if (operation.type === "sync") {
    if (operation.status === "failed" || numericResult(summary.failed) > 0) return { label: "failed", tone: "danger" };
    if (numericResult(summary.synced) > 0) return { label: "synced", tone: "success" };
    if (numericResult(summary.latest) > 0) return { label: "latest", tone: "neutral" };
    if (operation.status === "canceled") return { label: "canceled", tone: "warning" };
    if (!serverOperationIsTerminal(operation)) return { label: "in progress", tone: "active" };
    return { label: formatServerOperationStatus(operation.status), tone: operation.status === "completed" ? "success" : "neutral" };
  }

  const success = numericResult(summary.upload_success);
  const failed = numericResult(summary.upload_failed);
  if (operation.status === "failed" || failed > 0) {
    return { label: success > 0 ? `${success} ok / ${failed || 1} failed` : "failed", tone: "danger" };
  }
  if (numericResult(summary.no_files) > 0) return { label: "no files", tone: "neutral" };
  if (success > 0) return { label: `${success} uploaded`, tone: "success" };
  if (operation.status === "canceled") return { label: "canceled", tone: "warning" };
  if (!serverOperationIsTerminal(operation)) return { label: "in progress", tone: "active" };
  return { label: formatServerOperationStatus(operation.status), tone: operation.status === "completed" ? "success" : "neutral" };
}

function numericResult(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function serverOperationConfirmTitle(action: PendingServerOperationAction["action"]): string {
  if (action === "sync") return "Start sync tmux?";
  if (action === "upload") return "Start upload tmux?";
  return "Clear operation history?";
}

function serverOperationConfirmCopy(action: PendingServerOperationAction): string {
  if (action.action === "sync") {
    return `This will start sync tmux sessions on ${action.serverCount} online enabled server${action.serverCount === 1 ? "" : "s"}.`;
  }
  if (action.action === "upload") {
    const preview = action.itemCount > 0 ? ` Last scan found ${action.itemCount} retained folder${action.itemCount === 1 ? "" : "s"}.` : "";
    return `This will scan ${action.serverCount} online enabled server${action.serverCount === 1 ? "" : "s"} and start upload tmux sessions for retained results.${preview}`;
  }
  return `This will remove ${action.itemCount} completed, failed, or canceled server operation record${action.itemCount === 1 ? "" : "s"}. Active operations stay visible.`;
}

function parallelDispatchState(run: ParallelSolverRun): {
  label: string;
  className: string;
  summary: string;
  metric: string;
} {
  const total = Math.max(1, run.slices.length);
  const queued = run.slices.filter((slice) => slice.status === "queued").length;
  const running = run.slices.filter((slice) => slice.status === "running").length;
  const dispatched = total - queued;
  if (run.status === "queued") {
    return {
      label: "Pending dispatch",
      className: "dispatch-pending",
      summary: `${queued}/${total} pending`,
      metric: `${dispatched}/${total}`
    };
  }
  if (run.status === "running") {
    if (queued > 0) {
      return {
        label: "Partially successful",
        className: "dispatch-partial",
        summary: `${running}/${total} running, ${queued} pending`,
        metric: `${dispatched}/${total}`
      };
    }
    return {
      label: "All running",
      className: "dispatch-all-running",
      summary: `${dispatched}/${total} dispatched`,
      metric: `${dispatched}/${total}`
    };
  }
  return {
    label: formatParallelRunStatus(run.status),
    className: run.status,
    summary: `${dispatched}/${total} dispatched`,
    metric: `${dispatched}/${total}`
  };
}

function parallelQueueRuns(runs: ParallelSolverRun[]): ParallelSolverRun[] {
  return runs
    .filter((run) => run.status === "queued" || run.status === "running")
    .sort(compareParallelRunQueue);
}

function terminalParallelReportRuns(runs: ParallelSolverRun[]): ParallelSolverRun[] {
  return runs.filter((run) =>
    run.status === "completed" ||
    run.status === "completed_with_failures" ||
    run.status === "failed" ||
    run.status === "canceled"
  );
}

function compareParallelRunQueue(left: ParallelSolverRun, right: ParallelSolverRun): number {
  const orderDelta = left.queueOrder - right.queueOrder;
  if (orderDelta !== 0) return orderDelta;
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function parallelRunIsLocked(run: ParallelSolverRun): boolean {
  return run.slices.some((slice) =>
    slice.status === "running" ||
    slice.job?.status === "deploying" ||
    slice.job?.status === "running" ||
    slice.job?.status === "stopping"
  );
}

function formatSliceServerId(slice: ParallelSolverRun["slices"][number]): string {
  return slice.serverId || "Pending";
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function summarizeFailurePoolDatasets(entries: ParallelFailurePoolEntry[]): Array<{ datasetName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.datasetName, (counts.get(entry.datasetName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([datasetName, count]) => ({ datasetName, count }))
    .sort((left, right) => left.datasetName.localeCompare(right.datasetName));
}

function summarizeFailurePoolReasons(entries: ParallelFailurePoolEntry[]): Array<{ reason: ParallelFailureReason; count: number }> {
  const order: ParallelFailureReason[] = ["abnormal_end", "skipped", "best_server_skipped", "unclassified"];
  const counts = new Map<ParallelFailureReason, number>();
  for (const entry of entries) {
    counts.set(entry.failureReason, (counts.get(entry.failureReason) ?? 0) + 1);
  }
  return order
    .map((reason) => ({ reason, count: counts.get(reason) ?? 0 }))
    .filter((item) => item.count > 0);
}

function failurePoolEntryIsRetryable(entry: ParallelFailurePoolEntry): boolean {
  return entry.failureReason !== "best_server_skipped";
}

function failureReasonLabel(reason: ParallelFailureReason): string {
  switch (reason) {
    case "abnormal_end":
      return "Abnormal";
    case "skipped":
      return "Skipped";
    case "best_server_skipped":
      return "Terminal";
    default:
      return "Unclassified";
  }
}

function buildParallelReportsMarkdown(
  runs: ParallelSolverRun[],
  failurePool: ParallelFailurePoolEntry[]
): string {
  const sortedRuns = runs
    .slice()
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const lines = [
    "# Parallel Solver Reports",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Runs: ${sortedRuns.length}`,
    `Failure Pool Entries: ${failurePool.length}`,
    ""
  ];

  if (sortedRuns.length === 0) {
    lines.push("No parallel reports.", "");
  }

  for (const run of sortedRuns) {
    lines.push(
      `## ${run.datasetName}`,
      "",
      `- Run ID: ${run.id}`,
      `- Source: ${run.sourceType === "failure_pool" ? "Failure pool retry" : "Parallel run"}`,
      `- Status: ${formatParallelRunStatus(run.status)}`,
      `- Repo: ${run.repoId}`,
      `- Scenario: ${run.scenario}`,
      `- Range: ${run.rangeName}`,
      `- Created: ${run.createdAt}`,
      `- Started: ${run.startedAt ?? "-"}`,
      `- Finished: ${run.finishedAt ?? "-"}`,
      `- Total Boards: ${run.report.totalBoards}`,
      `- Completed Boards: ${run.report.completedBoards}`,
      `- Failed Boards: ${run.report.failedBoards}`,
      `- Queued Boards: ${run.report.queuedBoards}`,
      `- Running Boards: ${run.report.runningBoards}`,
      `- Success Rate: ${formatRatio(run.report.successRate)}`,
      `- Duration: ${formatDuration(run.report.durationSeconds)}`,
      "",
      "| Server | Status | Boards | Completed | Failed | Range Expr |",
      "| --- | --- | ---: | ---: | ---: | --- |"
    );
    for (const slice of run.slices) {
      lines.push(
        `| ${markdownCell(formatSliceServerId(slice))} | ${markdownCell(slice.status)} | ${slice.assignedIndices.length} | ${slice.completedCount} | ${slice.failedCount} | ${markdownCell(slice.rangeExpr || "-")} |`
      );
    }
    if (run.lastError) {
      lines.push("", `Last Error: ${run.lastError}`);
    }
    lines.push("");
  }

  const failureByDataset = summarizeFailurePoolDatasets(failurePool);
  lines.push("## Failure Pool Snapshot", "");
  if (failureByDataset.length === 0) {
    lines.push("No failure pool entries.", "");
  } else {
    lines.push("| Dataset | Entries |", "| --- | ---: |");
    for (const item of failureByDataset) {
      lines.push(`| ${markdownCell(item.datasetName)} | ${item.count} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatDuration(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatShortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatTaskStatusLabel(status: PipelineDisplayStatus): string {
  return status.replace(/_/g, " ");
}

function formatProcessAlive(processAlive: boolean | null): string {
  if (processAlive === true) return "Alive";
  if (processAlive === false) return "Not running";
  return "-";
}

function formatTaskBatch(task: PipelineStatusSnapshot): string {
  if (task.currentBatch != null && task.totalBatches != null) {
    const expr = task.batchExpr ? ` (${task.batchExpr})` : "";
    return `${task.currentBatch}/${task.totalBatches}${expr}`;
  }
  if (task.totalTasks != null) return `${task.totalTasks} tasks`;
  return "-";
}

function formatTaskUpdated(task: PipelineStatusSnapshot | null): string {
  if (!task) return "-";
  return formatShortDateTime(task.updatedAt ?? task.collectedAt);
}

function formatMetricPercent(value: number | null | undefined): string {
  return value == null ? "-" : `${value.toFixed(1)}%`;
}

async function fetchPreflopJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const payload = await response.json() as { message?: string; error?: string };
      message = payload.message ?? payload.error ?? message;
    } catch {
      // ignore malformed error bodies
    }
    throw new Error(message);
  }
  return await response.json() as T;
}

function normalizeRangeTreeItems(items: PreflopRangeTreeItem[]): PreflopRangeTreeItem[] {
  return items.map((item) => {
    if (item.type === "folder") {
      return {
        ...item,
        children: normalizeRangeTreeItems(item.children)
      };
    }
    return normalizeRangeFileItem(item);
  });
}

function normalizeRangeFileItem(item: PreflopRangeFileItem): PreflopRangeFileItem {
  const reviewStatus = normalizeReviewStatusForClient(item.reviewStatus ?? item.status, Boolean(item.learned));
  const runStatus = reviewStatus === "approved"
    ? normalizeRunStatusForClient(item.runStatus ?? item.status)
    : "idle";
  const progress = normalizeRangeProgress(item.progress, item.datasetName);
  return {
    ...item,
    status: reviewStatus,
    reviewStatus,
    runStatus,
    datasetName: progress?.datasetName ?? item.datasetName,
    progress,
    learned: reviewStatus === "approved"
  };
}

function normalizeRangeFileResponse(response: PreflopRangeFileResponse): PreflopRangeFileResponse {
  const filename = response.path.split("/").at(-1) ?? response.path;
  const data = normalizePreflopRangeDocument(response.summary.data, filename);
  return {
    ...response,
    summary: summarizePreflopRange(data, filename)
  };
}

function normalizeReviewStatusForClient(value: unknown, learnedFallback = false): PreflopReviewStatus {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PREFLOP_REVIEW_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as PreflopReviewStatus;
  }
  if ((PREFLOP_RUN_STATUSES as readonly string[]).includes(normalized)) {
    return "approved";
  }
  return learnedFallback ? "approved" : "under_review";
}

function normalizeRunStatusForClient(value: unknown): PreflopRunStatus {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PREFLOP_RUN_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as PreflopRunStatus;
  }
  return "idle";
}

function normalizeRangeProgress(
  value: PreflopRangeProgress | undefined,
  datasetName: string | undefined
): PreflopRangeProgress | undefined {
  if (!value && !datasetName) return undefined;
  const totalRows = positiveNumber(value?.totalRows, 1755);
  const rows = Math.max(0, Math.floor(Number(value?.rows ?? 0)));
  return {
    datasetName: value?.datasetName || datasetName || "",
    rows,
    totalRows,
    ratio: clampProgressRatio(value?.ratio ?? rows / totalRows),
    checkedAt: value?.checkedAt,
    error: value?.error
  };
}

function findFolder(items: PreflopRangeTreeItem[], path: string): PreflopRangeFolderItem | null {
  if (!path) return { type: "folder", name: "All Ranges", path: "", children: items };
  for (const item of items) {
    if (item.type !== "folder") continue;
    if (item.path === path) return item;
    const found = findFolder(item.children, path);
    if (found) return found;
  }
  return null;
}

function filterTreeItems(
  items: PreflopRangeTreeItem[],
  query: string,
  statusView: RangeStatusView,
  visibleReviewStatuses: Set<PreflopReviewStatus>,
  visibleRunStatuses: Set<PreflopRunStatus>
): PreflopRangeTreeItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    if (item.type === "file") {
      return fileVisibleInStatusView(item, statusView, visibleReviewStatuses, visibleRunStatuses) &&
        (!normalized || fileMatchesQuery(item, normalized));
    }
    if (!folderHasVisibleStatus(item, statusView, visibleReviewStatuses, visibleRunStatuses)) return false;
    return !normalized || folderHasMatch(item, query);
  });
}

function folderHasMatch(item: PreflopRangeFolderItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const ownMatch = item.name.toLowerCase().includes(normalized);
  return ownMatch || item.children.some((child) =>
    child.type === "folder"
      ? folderHasMatch(child, query)
      : `${child.name} ${child.label}`.toLowerCase().includes(normalized)
  );
}

function countFiles(items: PreflopRangeTreeItem[]): number {
  return items.reduce((count, item) => item.type === "folder" ? count + countFiles(item.children) : count + 1, 0);
}

function countFolderFiles(item: PreflopRangeFolderItem): number {
  return countFiles(item.children);
}

function countApprovedFiles(items: PreflopRangeTreeItem[]): number {
  return items.reduce((count, item) => {
    if (item.type === "folder") return count + countApprovedFiles(item.children);
    return item.reviewStatus === "approved" ? count + 1 : count;
  }, 0);
}

function countReviewStatuses(items: PreflopRangeTreeItem[]): Record<PreflopReviewStatus, number> {
  const counts = Object.fromEntries(PREFLOP_REVIEW_STATUSES.map((status) => [status, 0])) as Record<PreflopReviewStatus, number>;
  const visit = (nodes: PreflopRangeTreeItem[]) => {
    for (const item of nodes) {
      if (item.type === "folder") {
        visit(item.children);
      } else {
        counts[item.reviewStatus] += 1;
      }
    }
  };
  visit(items);
  return counts;
}

function countRunStatuses(items: PreflopRangeTreeItem[]): Record<PreflopRunStatus, number> {
  const counts = Object.fromEntries(PREFLOP_RUN_STATUSES.map((status) => [status, 0])) as Record<PreflopRunStatus, number>;
  const visit = (nodes: PreflopRangeTreeItem[]) => {
    for (const item of nodes) {
      if (item.type === "folder") {
        visit(item.children);
      } else if (item.reviewStatus === "approved") {
        counts[item.runStatus] += 1;
      }
    }
  };
  visit(items);
  return counts;
}

function folderHasVisibleStatus(
  item: PreflopRangeFolderItem,
  statusView: RangeStatusView,
  visibleReviewStatuses: Set<PreflopReviewStatus>,
  visibleRunStatuses: Set<PreflopRunStatus>
): boolean {
  return item.children.some((child) =>
    child.type === "folder"
      ? folderHasVisibleStatus(child, statusView, visibleReviewStatuses, visibleRunStatuses)
      : fileVisibleInStatusView(child, statusView, visibleReviewStatuses, visibleRunStatuses)
  );
}

function fileVisibleInStatusView(
  item: PreflopRangeFileItem,
  statusView: RangeStatusView,
  visibleReviewStatuses: Set<PreflopReviewStatus>,
  visibleRunStatuses: Set<PreflopRunStatus>
): boolean {
  if (statusView === "labeling") return visibleReviewStatuses.has(item.reviewStatus);
  return item.reviewStatus === "approved" && visibleRunStatuses.has(item.runStatus);
}

function fileMatchesQuery(item: PreflopRangeFileItem, normalizedQuery: string): boolean {
  return `${item.name} ${item.label}`.toLowerCase().includes(normalizedQuery);
}

function displayRangeName(name: string): string {
  return name.replace(/\.(json|range)$/i, "");
}

function normalizeRenameName(pathToRename: string, nextName: string): string {
  const trimmed = nextName.trim();
  if (!isRangeFilePath(pathToRename)) return trimmed;
  const basename = displayRangeName(trimmed).trim();
  return basename ? `${basename}.json` : "";
}

function isRangeFilePath(pathValue: string): boolean {
  return /\.(json|range)$/i.test(pathValue);
}

function pathBasename(pathValue: string): string {
  return pathValue.split("/").filter(Boolean).at(-1) ?? pathValue;
}

function reviewStatusInitial(status: PreflopReviewStatus): string {
  return REVIEW_STATUS_LABELS[status][0] ?? "?";
}

function runStatusInitial(status: PreflopRunStatus): string {
  return RUN_STATUS_LABELS[status][0] ?? "?";
}

function rangeDisplayStatus(item: PreflopRangeFileItem, statusView: RangeStatusView): PreflopReviewStatus | PreflopRunStatus {
  return statusView === "already" ? item.runStatus : item.reviewStatus;
}

function rangeDisplayStatusLabel(item: PreflopRangeFileItem, statusView: RangeStatusView): string {
  return statusView === "already" ? RUN_STATUS_LABELS[item.runStatus] : REVIEW_STATUS_LABELS[item.reviewStatus];
}

function rangeDisplayStatusInitial(item: PreflopRangeFileItem, statusView: RangeStatusView): string {
  return statusView === "already" ? runStatusInitial(item.runStatus) : reviewStatusInitial(item.reviewStatus);
}

function formatRangeProgress(progress: PreflopRangeProgress | undefined): string {
  const ratio = clampProgressRatio(progress?.ratio ?? 0);
  return `${Math.round(ratio * 100)}%`;
}

function rangeProgressTitle(item: PreflopRangeFileItem): string {
  const progress = item.progress;
  const rows = Math.max(0, Math.floor(Number(progress?.rows ?? 0)));
  const total = positiveNumber(progress?.totalRows, 1755);
  const checked = progress?.checkedAt ? ` · checked ${formatTimestamp(progress.checkedAt)}` : "";
  const error = progress?.error ? ` · ${progress.error}` : "";
  return `${rows} / ${total} rows${checked}${error}`;
}

function rangeProgressClass(ratio: unknown): string {
  const normalized = clampProgressRatio(ratio);
  if (normalized >= 1) return "complete";
  if (normalized > 0) return "partial";
  return "empty";
}

function clampProgressRatio(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(1, parsed);
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function folderName(path: string): string {
  if (!path) return "All Ranges";
  return path.split("/").filter(Boolean).at(-1) ?? "All Ranges";
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function pathIsSameOrInside(pathValue: string, parent: string): boolean {
  if (!pathValue || !parent) return pathValue === parent;
  return pathValue === parent || pathValue.startsWith(`${parent}/`);
}

function replacePathPrefix(pathValue: string, oldPrefix: string, newPrefix: string): string {
  if (pathValue === oldPrefix) return newPrefix;
  if (pathValue.startsWith(`${oldPrefix}/`)) return `${newPrefix}${pathValue.slice(oldPrefix.length)}`;
  return pathValue;
}

function renameExpandedFolderPaths(paths: Set<string>, oldPrefix: string, newPrefix: string): Set<string> {
  const next = new Set<string>();
  for (const pathValue of paths) {
    next.add(replacePathPrefix(pathValue, oldPrefix, newPrefix));
  }
  return next;
}

function deleteExpandedFolderPaths(paths: Set<string>, deletedPath: string): Set<string> {
  const next = new Set<string>();
  for (const pathValue of paths) {
    if (!pathIsSameOrInside(pathValue, deletedPath)) next.add(pathValue);
  }
  return next;
}

function toggleFolder(path: string, setExpandedFolders: (updater: (current: Set<string>) => Set<string>) => void): void {
  setExpandedFolders((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
}

function expandAncestors(path: string, setExpandedFolders: (updater: (current: Set<string>) => Set<string>) => void): void {
  const parts = path.split("/").filter(Boolean);
  setExpandedFolders((current) => {
    const next = new Set(current);
    for (let index = 1; index < parts.length; index += 1) {
      next.add(parts.slice(0, index).join("/"));
    }
    return next;
  });
}

function readExpandedFolders(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPANDED_FOLDERS_KEY) || "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.map((item) => String(item)) : []);
  } catch {
    return new Set();
  }
}

function dropModeFromEvent(event: DragEvent<HTMLElement>, itemType: "folder" | "file"): DropTarget["mode"] {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = event.clientY - rect.top;
  if (itemType === "folder" && y > rect.height * 0.35 && y < rect.height * 0.65) return "inside";
  return y < rect.height / 2 ? "before" : "after";
}

function filenameFromDisposition(value: string | null): string | null {
  const match = value?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? null;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatLastUpdatedTime(file: PreflopRangeFileResponse): string {
  const updatedAt = file.summary.data.updatedAt ?? file.modified;
  if (!updatedAt) return "Last Updated Time: Not recorded";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Last Updated Time: Not recorded";
  return `Last Updated Time: ${date.toLocaleString()}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatSolverRangeText(summary: PreflopRangeSummary): string {
  const orderedPlayers = orderedRangePlayers(summary);
  const oop = orderedPlayers.find((item) => item.role === "OOP") ?? orderedPlayers[1] ?? orderedPlayers[0];
  const ip = orderedPlayers.find((item) => item.role === "IP") ?? orderedPlayers.find((item) => item.player !== oop?.player) ?? orderedPlayers[0];
  return [
    `OOP_RANGE = "${oop ? formatPlayerSolverRange(summary, oop.player) : ""}"`,
    `IP_RANGE = "${ip ? formatPlayerSolverRange(summary, ip.player) : ""}"`
  ].join("\n");
}

function formatScenarioLibraryText(scenario: SolverScenarioLibraryItem): string {
  return [
    `SCENARIO = "${scenario.id}"`,
    `LABEL = "${scenario.label}"`,
    `RANGE_SUBDIR = "${scenario.rangeSubdir}"`,
    `CONFIG_TEMPLATE = "${scenario.configTemplate}"`,
    `POT = ${scenario.pot}`,
    `EFFECTIVE_STACK = ${scenario.effectiveStack}`,
    scenario.description ? `DESCRIPTION = "${scenario.description}"` : ""
  ].filter(Boolean).join("\n");
}

function emptyScenarioLibraryItem(): SolverScenarioLibraryItem {
  return {
    id: "",
    label: "",
    rangeSubdir: "",
    configTemplate: "SIA_SOD_CONFIG",
    pot: 5,
    effectiveStack: 98
  };
}

function normalizeScenarioDraft(draft: SolverScenarioLibraryItem): SolverScenarioLibraryItem | null {
  const id = draft.id.trim();
  const label = draft.label.trim();
  const rangeSubdir = draft.rangeSubdir.trim() || id;
  const configTemplate = draft.configTemplate.trim();
  const pot = Number(draft.pot);
  const effectiveStack = Number(draft.effectiveStack);
  if (!id || !label || !rangeSubdir || !configTemplate || !Number.isFinite(pot) || !Number.isFinite(effectiveStack)) {
    return null;
  }
  return {
    id,
    label,
    rangeSubdir,
    configTemplate,
    pot,
    effectiveStack,
    ...(draft.description?.trim() ? { description: draft.description.trim() } : {})
  };
}

function scenarioActionTitle(action: PendingScenarioLibraryAction["action"]): string {
  if (action === "add") return "Add scenario?";
  if (action === "update") return "Update scenario?";
  return "Delete scenario?";
}

function formatPlayerSolverRange(summary: PreflopRangeSummary, player: PreflopPlayerKey): string {
  const matrix = summary.players[player].matrix;
  return PREFLOP_HAND_GRID
    .flat()
    .flatMap((hand) => {
      const value = matrix[hand] ?? { raise: 0, call: 0 };
      const frequency = Math.max(0, Math.min(1, value.raise + value.call));
      if (frequency <= 0) return [];
      return [formatSolverHandFrequency(hand, frequency)];
    })
    .join(",");
}

function formatSolverHandFrequency(hand: PreflopHandCode, frequency: number): string {
  if (Math.abs(frequency - 1) < 0.0005) return hand;
  return `${hand}:${frequency.toFixed(3)}`;
}
