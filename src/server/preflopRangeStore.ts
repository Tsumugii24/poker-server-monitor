import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  PREFLOP_REVIEW_STATUSES,
  PREFLOP_RUN_STATUSES,
  normalizePreflopRangeDocument,
  serializePreflopRangeDocument,
  summarizePreflopRange,
  type PreflopRangeDocument,
  type PreflopRangeFileItem,
  type PreflopRangeFileResponse,
  type PreflopRangeFolderItem,
  type PreflopRangeProgress,
  type PreflopReviewStatus,
  type PreflopRunStatus,
  type PreflopRangeTreeItem,
  type PreflopRangeTreeResponse
} from "../shared/preflopRange";
import { datasetNameFromRangePath, scenarioFromRangePath } from "../shared/preflopDataset";
import { SOLVER_TOTAL_BOARD_COUNT, type SolverJob, type SolverJobStatus } from "../shared/solverJobs";
import { huggingFaceFetch, type HuggingFaceFetchOptions } from "./huggingFaceHttp";

const ORDER_FILE = ".range_order.json";
const STATUS_FILE = ".range_status.json";
const PROGRESS_FILE = ".range_progress.json";
const RUNNING_JOB_STATUSES = new Set<SolverJobStatus>(["deploying", "running", "stopping"]);
const HUGGING_FACE_ORIGIN = "https://huggingface.co";
const HUGGING_FACE_TREE_PAGE_LIMIT = 1000;
const HUGGING_FACE_TREE_MAX_PAGES = 100;

type RangeStatusEntry = {
  reviewStatus: PreflopReviewStatus;
  runStatus: PreflopRunStatus;
  updatedAt: string;
};

type RangeStatusMetadata = {
  version: 1;
  ranges: Record<string, RangeStatusEntry>;
};

type RangeProgressEntry = PreflopRangeProgress & {
  updatedAt?: string;
};

type RangeProgressMetadata = {
  version: 1;
  ranges: Record<string, RangeProgressEntry>;
};

export type PreflopRangeRuntimeInput = {
  jobs?: SolverJob[];
  progress?: RangeProgressMetadata;
};

type RangeRuntimeContext = {
  jobsByPath: Map<string, SolverJob[]>;
  progress: RangeProgressMetadata;
};

export type PreflopRangeProgressRefreshResult = {
  root: string;
  checked: number;
  failed: number;
  fileListingFallbacks: number;
  failures: Array<{
    rangePath: string;
    datasetName: string;
    message: string;
  }>;
  progress: RangeProgressMetadata;
};

export type UploadedPreflopRangeFile = {
  filename?: unknown;
  relativePath?: unknown;
  content?: unknown;
};

export type PreflopRangeDownload = {
  filename: string;
  contentType: string;
  buffer: Buffer;
};

export function listPreflopRanges(rootPath: string, runtimeInput?: PreflopRangeRuntimeInput): PreflopRangeTreeResponse {
  const root = ensureRoot(rootPath);
  const runtime = createRangeRuntimeContext(root, runtimeInput);
  return {
    root,
    tree: buildTree(root, root, runtime)
  };
}

export function readPreflopRangeFile(
  rootPath: string,
  relativePath: string,
  runtimeInput?: PreflopRangeRuntimeInput
): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertRangeFile(target);
  const runtime = createRangeRuntimeContext(root, runtimeInput);
  const data = applyRuntimeState(root, target, readRangeDocumentWithStatus(root, target), runtime);
  const stat = fs.statSync(target);
  return {
    path: relativeString(root, target),
    modified: stat.mtime.toISOString(),
    summary: summarizePreflopRange(data, path.basename(target))
  };
}

export function savePreflopRangeFile(
  rootPath: string,
  relativePath: string,
  document: PreflopRangeDocument
): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertJsonFilePath(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const normalized = normalizePreflopRangeDocument(document, path.basename(target));
  writeRangeDocument(target, normalized);
  setStoredStatusFromDocument(root, target, normalized);
  appendToOrder(root, path.dirname(target), path.basename(target));
  return readPreflopRangeFile(root, relativeString(root, target));
}

export async function refreshPreflopRangeProgress(
  rootPath: string,
  options: { hfToken?: string | null; hfProxyUrl?: string | null; repoNamespace?: string; totalRows?: number } = {}
): Promise<PreflopRangeProgressRefreshResult> {
  const root = ensureRoot(rootPath);
  const metadata = loadProgressMetadata(root);
  const nextRanges: Record<string, RangeProgressEntry> = {};
  const repoNamespace = normalizedRepoNamespace(options.repoNamespace);
  const totalRows = positiveTotalRows(options.totalRows);
  const approvedFiles = walkRangeFiles(root).flatMap((file) => {
    const document = readRangeDocumentWithStatus(root, file);
    if (document.reviewStatus !== "approved") return [];
    const rangePath = relativeString(root, file);
    return [{
      file,
      rangePath,
      datasetName: canonicalDatasetName(rangePath)
    }];
  });

  let failed = 0;
  let fileListingFallbacks = 0;
  const failures: PreflopRangeProgressRefreshResult["failures"] = [];
  const fetchContext = { preferFileListing: false };
  await runWithConcurrency(approvedFiles, 4, async ({ rangePath, datasetName }) => {
    const checkedAt = new Date().toISOString();
    const previous = metadata.ranges[rangePath];
    try {
      const result = await fetchHuggingFaceDatasetRows(
        `${repoNamespace}/${datasetName}`,
        options.hfToken ?? null,
        options.hfProxyUrl ?? null,
        fetchContext
      );
      if (result.usedFileListing) fileListingFallbacks += 1;
      nextRanges[rangePath] = progressEntry(datasetName, result.rows, totalRows, checkedAt);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ rangePath, datasetName, message });
      const fallbackRows = previous?.datasetName === datasetName ? previous.rows : 0;
      nextRanges[rangePath] = {
        ...progressEntry(datasetName, fallbackRows, totalRows, checkedAt),
        error: message
      };
    }
  });

  saveProgressMetadata(root, { version: 1, ranges: nextRanges });
  return {
    root,
    checked: approvedFiles.length,
    failed,
    fileListingFallbacks,
    failures,
    progress: { version: 1, ranges: nextRanges }
  };
}

export function createPreflopRangeFolder(rootPath: string, parentRelative: string, name: string): string {
  const root = ensureRoot(rootPath);
  const parent = safePath(root, parentRelative);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error("Parent folder does not exist.");
  }
  const target = uniquePath(path.join(parent, cleanFolderName(name)));
  fs.mkdirSync(target, { recursive: true });
  appendToOrder(root, parent, path.basename(target));
  return relativeString(root, target);
}

export function renamePreflopRangePath(rootPath: string, relativePath: string, nextName: string): string {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  if (!fs.existsSync(target) || path.basename(target).startsWith(".")) {
    throw new Error("Path does not exist.");
  }

  const stat = fs.statSync(target);
  const destination = uniquePath(path.join(
    path.dirname(target),
    stat.isDirectory() ? cleanFolderName(nextName) : cleanRangeFilename(nextName)
  ));
  const oldName = path.basename(target);
  fs.renameSync(target, destination);
  renameStatusKeys(root, target, destination);
  renameProgressKeys(root, target, destination);

  const metadata = loadOrderMetadata(root);
  const parentKey = folderKey(root, path.dirname(destination));
  metadata[parentKey] = (metadata[parentKey] ?? []).map((item) => item === oldName ? path.basename(destination) : item);
  saveOrderMetadata(root, metadata);
  if (stat.isDirectory()) renameOrderKeys(root, target, destination);
  return relativeString(root, destination);
}

export function deletePreflopRangePath(rootPath: string, relativePath: string): void {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  if (target === root || !fs.existsSync(target) || path.basename(target).startsWith(".")) {
    throw new Error("Path does not exist.");
  }

  const stat = fs.statSync(target);
  const parent = path.dirname(target);
  const name = path.basename(target);
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
    deleteOrderKeys(root, target);
  } else if (stat.isFile() && path.extname(target).toLowerCase() === ".json") {
    fs.unlinkSync(target);
  } else {
    throw new Error("Only range JSON files and folders can be deleted.");
  }
  deleteStatusKeys(root, target);
  deleteProgressKeys(root, target);
  removeFromOrder(root, parent, name);
}

export function movePreflopRangePath(rootPath: string, sourceRelative: string, targetFolderRelative: string): string {
  const root = ensureRoot(rootPath);
  const source = safePath(root, sourceRelative);
  const targetFolder = safePath(root, targetFolderRelative);
  if (!fs.existsSync(source) || path.basename(source).startsWith(".")) {
    throw new Error("Source path does not exist.");
  }
  if (!fs.existsSync(targetFolder) || !fs.statSync(targetFolder).isDirectory()) {
    throw new Error("Target folder does not exist.");
  }
  if (fs.statSync(source).isDirectory() && (source === targetFolder || isInside(targetFolder, source))) {
    throw new Error("A folder cannot be moved inside itself.");
  }

  const destination = uniquePath(path.join(targetFolder, path.basename(source)));
  const oldParent = path.dirname(source);
  fs.renameSync(source, destination);
  renameStatusKeys(root, source, destination);
  renameProgressKeys(root, source, destination);
  removeFromOrder(root, oldParent, path.basename(source));
  appendToOrder(root, targetFolder, path.basename(destination));
  if (fs.statSync(destination).isDirectory()) renameOrderKeys(root, source, destination);
  return relativeString(root, destination);
}

export function reorderPreflopRanges(rootPath: string, folderRelative: string, orderedNames: unknown): void {
  const root = ensureRoot(rootPath);
  const folder = safePath(root, folderRelative);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error("Parent folder does not exist.");
  }
  if (!Array.isArray(orderedNames)) {
    throw new Error("orderedNames must be an array.");
  }

  const existing = new Set(orderedChildren(root, folder).map((item) => path.basename(item)));
  const cleanedOrder = orderedNames
    .map((item) => String(item))
    .filter((item) => existing.has(item));
  const remaining = orderedChildren(root, folder)
    .map((item) => path.basename(item))
    .filter((item) => !cleanedOrder.includes(item));
  const metadata = loadOrderMetadata(root);
  metadata[folderKey(root, folder)] = [...cleanedOrder, ...remaining];
  saveOrderMetadata(root, metadata);
}

export function updatePreflopRangeLearned(rootPath: string, relativePath: string, learned: boolean): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertRangeFile(target);
  setStoredReviewStatus(root, target, learned ? "approved" : "under_review");
  return readPreflopRangeFile(root, relativeString(root, target));
}

export function updatePreflopRangeStatus(
  rootPath: string,
  relativePath: string,
  status: PreflopReviewStatus
): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertRangeFile(target);
  setStoredReviewStatus(root, target, status);
  return readPreflopRangeFile(root, relativeString(root, target));
}

export function updatePreflopRangeRunStatus(
  rootPath: string,
  relativePath: string,
  runStatus: PreflopRunStatus
): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertRangeFile(target);
  setStoredRunStatus(root, target, runStatus);
  return readPreflopRangeFile(root, relativeString(root, target));
}

export function approveAllPreflopRanges(
  rootPath: string,
  runtimeInput?: PreflopRangeRuntimeInput
): { count: number; tree: PreflopRangeTreeItem[]; root: string } {
  const root = ensureRoot(rootPath);
  const metadata = loadStatusMetadata(root);
  const now = new Date().toISOString();
  let count = 0;
  for (const file of walkRangeFiles(root)) {
    const key = relativeString(root, file);
    metadata.ranges[key] = {
      reviewStatus: "approved",
      runStatus: "idle",
      updatedAt: now
    };
    count += 1;
  }
  saveStatusMetadata(root, metadata);
  return {
    count,
    root,
    tree: buildTree(root, root, createRangeRuntimeContext(root, runtimeInput))
  };
}

export function saveUploadedPreflopRangeFiles(
  rootPath: string,
  folderRelative: string,
  files: UploadedPreflopRangeFile[]
): string[] {
  const root = ensureRoot(rootPath);
  const folder = safePath(root, folderRelative);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error("Target folder does not exist.");
  }

  return files.map((file) => {
    const filename = cleanRangeFilename(String(file.filename || "range.json"));
    const uploadRelative = typeof file.relativePath === "string" ? file.relativePath : "";
    const targetRelative = normalizedUploadRelative(filename, uploadRelative);
    const target = uniquePath(safePath(root, path.join(folderRelative, targetRelative)));
    const parsed = JSON.parse(String(file.content ?? "{}")) as unknown;
    const normalized = normalizePreflopRangeDocument(parsed, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeRangeDocument(target, normalized);
    setStoredStatusFromDocument(root, target, normalized);
    appendToOrder(root, path.dirname(target), path.basename(target));
    return relativeString(root, target);
  });
}

export function buildPreflopRangeDownload(rootPath: string, relativePath: string): PreflopRangeDownload {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  if (!fs.existsSync(target)) {
    throw new Error("Path does not exist.");
  }

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    assertRangeFile(target);
    return {
      filename: path.basename(target),
      contentType: "application/json; charset=utf-8",
      buffer: fs.readFileSync(target)
    };
  }

  if (!stat.isDirectory()) {
    throw new Error("Only range JSON files and folders can be downloaded.");
  }

  const zip = new AdmZip();
  for (const file of walkRangeFiles(target)) {
    zip.addLocalFile(file, path.dirname(path.relative(target === root ? root : path.dirname(target), file)));
  }

  return {
    filename: `${target === root ? "preflop-ranges" : path.basename(target)}.zip`,
    contentType: "application/zip",
    buffer: zip.toBuffer()
  };
}

function buildTree(root: string, folder: string, runtime: RangeRuntimeContext): PreflopRangeTreeItem[] {
  return orderedChildren(root, folder).flatMap((item): PreflopRangeTreeItem[] => {
    const name = path.basename(item);
    if (name.startsWith(".")) return [];
    const stat = fs.statSync(item);
    if (stat.isDirectory()) {
      const folderItem: PreflopRangeFolderItem = {
        type: "folder",
        name,
        path: relativeString(root, item),
        children: buildTree(root, item, runtime)
      };
      return [folderItem];
    }
    if (stat.isFile() && path.extname(item).toLowerCase() === ".json") {
      return [fileSummary(root, item, runtime)];
    }
    return [];
  });
}

function fileSummary(root: string, file: string, runtime: RangeRuntimeContext): PreflopRangeFileItem {
  let label = "Invalid JSON";
  let learned = false;
  let status: PreflopReviewStatus = "under_review";
  let reviewStatus: PreflopReviewStatus = "under_review";
  let runStatus: PreflopRunStatus = "idle";
  let datasetName: string | undefined;
  let progress: PreflopRangeProgress | undefined;
  let rangePct: PreflopRangeFileItem["rangePct"] = { A: 0, B: 0 };
  try {
    const data = applyRuntimeState(root, file, readRangeDocumentWithStatus(root, file), runtime);
    const summary = summarizePreflopRange(data, path.basename(file));
    label = `${summary.players.A.name} vs ${summary.players.B.name}`;
    learned = summary.data.learned;
    status = summary.data.status;
    reviewStatus = summary.data.reviewStatus;
    runStatus = summary.data.runStatus;
    datasetName = canonicalDatasetName(relativeString(root, file));
    progress = reviewStatus === "approved" ? runtimeProgress(root, file, runtime, datasetName) : undefined;
    rangePct = {
      A: Math.round((summary.players.A.stats.raise + summary.players.A.stats.call) * 10) / 10,
      B: Math.round((summary.players.B.stats.raise + summary.players.B.stats.call) * 10) / 10
    };
  } catch {
    // Keep invalid files visible so users can replace or delete them.
  }

  const stat = fs.statSync(file);
  return {
    type: "file",
    name: path.basename(file),
    path: relativeString(root, file),
    modified: stat.mtime.toISOString(),
    size: stat.size,
    label,
    learned,
    status,
    reviewStatus,
    runStatus,
    datasetName,
    progress,
    rangePct
  };
}

function readRangeDocumentWithStatus(root: string, file: string): PreflopRangeDocument {
  const data = normalizePreflopRangeDocument(readJson(file), path.basename(file));
  const stored = loadStatusMetadata(root).ranges[relativeString(root, file)];
  if (!stored) return data;
  return {
    ...data,
    status: stored.reviewStatus,
    reviewStatus: stored.reviewStatus,
    runStatus: "idle",
    learned: stored.reviewStatus === "approved"
  };
}

function createRangeRuntimeContext(root: string, input: PreflopRangeRuntimeInput = {}): RangeRuntimeContext {
  const jobsByPath = new Map<string, SolverJob[]>();
  for (const job of input.jobs ?? []) {
    const existing = jobsByPath.get(job.rangePath) ?? [];
    existing.push(job);
    jobsByPath.set(job.rangePath, existing);
  }
  return {
    jobsByPath,
    progress: input.progress ?? loadProgressMetadata(root)
  };
}

function applyRuntimeState(
  root: string,
  file: string,
  document: PreflopRangeDocument,
  runtime: RangeRuntimeContext
): PreflopRangeDocument {
  if (document.reviewStatus !== "approved") {
    return {
      ...document,
      runStatus: "idle"
    };
  }
  return {
    ...document,
    runStatus: runtimeRunStatus(root, file, runtime)
  };
}

function runtimeRunStatus(root: string, file: string, runtime: RangeRuntimeContext): PreflopRunStatus {
  const rangePath = relativeString(root, file);
  const jobs = runtime.jobsByPath.get(rangePath) ?? [];
  if (jobs.some((job) => RUNNING_JOB_STATUSES.has(job.status))) return "running";
  if (jobs.some((job) => job.status === "queued")) return "queue";

  const progress = runtimeProgress(root, file, runtime, canonicalDatasetName(rangePath));
  return progress.ratio >= 1 ? "solved" : "idle";
}

function runtimeProgress(
  root: string,
  file: string,
  runtime: RangeRuntimeContext,
  datasetName = canonicalDatasetName(relativeString(root, file))
): PreflopRangeProgress {
  const rangePath = relativeString(root, file);
  const entry = runtime.progress.ranges[rangePath];
  if (entry?.datasetName === datasetName) {
    return {
      datasetName,
      rows: normalizedRows(entry.rows),
      totalRows: positiveTotalRows(entry.totalRows),
      ratio: clampRatio(entry.ratio),
      checkedAt: entry.checkedAt,
      error: entry.error
    };
  }
  return progressEntry(datasetName, 0, SOLVER_TOTAL_BOARD_COUNT, entry?.checkedAt);
}

function canonicalDatasetName(rangePath: string): string {
  return datasetNameFromRangePath(rangePath, scenarioFromRangePath(rangePath));
}

function ensureRoot(rootPath: string): string {
  const root = path.resolve(rootPath);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safePath(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath || "");
  if (target !== root && !isInside(target, root)) {
    throw new Error("Path outside range storage.");
  }
  return target;
}

function isInside(target: string, parent: string): boolean {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function relativeString(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/g, "/");
}

function orderedChildren(root: string, folder: string): string[] {
  if (!fs.existsSync(folder)) return [];
  const entries = fs.readdirSync(folder)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(folder, name));
  const order = loadOrderMetadata(root)[folderKey(root, folder)] ?? [];
  const index = new Map(order.map((name, position) => [name, position]));
  return entries.sort((left, right) => {
    const leftIndex = index.get(path.basename(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = index.get(path.basename(right)) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return path.basename(left).localeCompare(path.basename(right), undefined, { numeric: true, sensitivity: "base" });
  });
}

function orderFilePath(root: string): string {
  return path.join(root, ORDER_FILE);
}

function statusFilePath(root: string): string {
  return path.join(root, STATUS_FILE);
}

function progressFilePath(root: string): string {
  return path.join(root, PROGRESS_FILE);
}

function loadOrderMetadata(root: string): Record<string, string[]> {
  const file = orderFilePath(root);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(data)) return {};
    return Object.fromEntries(
      Object.entries(data)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([key, value]) => [key, value.map((item) => String(item))])
    );
  } catch {
    return {};
  }
}

function saveOrderMetadata(root: string, metadata: Record<string, string[]>): void {
  fs.writeFileSync(orderFilePath(root), `${JSON.stringify(metadata, null, 2)}\n`);
}

function folderKey(root: string, folder: string): string {
  return path.resolve(folder) === root ? "" : relativeString(root, folder);
}

function appendToOrder(root: string, folder: string, name: string): void {
  const metadata = loadOrderMetadata(root);
  const key = folderKey(root, folder);
  const order = (metadata[key] ?? []).filter((item) => item !== name);
  order.push(name);
  metadata[key] = order;
  saveOrderMetadata(root, metadata);
}

function removeFromOrder(root: string, folder: string, name: string): void {
  const metadata = loadOrderMetadata(root);
  const key = folderKey(root, folder);
  if (metadata[key]) {
    metadata[key] = metadata[key].filter((item) => item !== name);
    saveOrderMetadata(root, metadata);
  }
}

function renameOrderKeys(root: string, oldPath: string, newPath: string): void {
  const metadata = loadOrderMetadata(root);
  const oldKey = folderKey(root, oldPath);
  const newKey = folderKey(root, newPath);
  const updates: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === oldKey) {
      updates[newKey] = value;
    } else if (key.startsWith(`${oldKey}/`)) {
      updates[`${newKey}${key.slice(oldKey.length)}`] = value;
    } else {
      updates[key] = value;
    }
  }
  saveOrderMetadata(root, updates);
}

function deleteOrderKeys(root: string, deletedPath: string): void {
  const metadata = loadOrderMetadata(root);
  const deletedKey = folderKey(root, deletedPath);
  saveOrderMetadata(root, Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== deletedKey && !key.startsWith(`${deletedKey}/`))
  ));
}

function loadStatusMetadata(root: string): RangeStatusMetadata {
  const file = statusFilePath(root);
  if (!fs.existsSync(file)) return { version: 1, ranges: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const rawRanges = isRecord(data) && isRecord(data.ranges)
      ? data.ranges
      : isRecord(data)
        ? data
        : {};
    const ranges: Record<string, RangeStatusEntry> = {};
    for (const [key, value] of Object.entries(rawRanges)) {
      const entry = normalizeStoredStatusEntry(value);
      if (!entry) continue;
      ranges[String(key)] = {
        ...entry,
        updatedAt: isRecord(value) && typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
      };
    }
    return { version: 1, ranges };
  } catch {
    return { version: 1, ranges: {} };
  }
}

function saveStatusMetadata(root: string, metadata: RangeStatusMetadata): void {
  fs.writeFileSync(statusFilePath(root), `${JSON.stringify(metadata, null, 2)}\n`);
}

function loadProgressMetadata(root: string): RangeProgressMetadata {
  const file = progressFilePath(root);
  if (!fs.existsSync(file)) return { version: 1, ranges: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const rawRanges = isRecord(data) && isRecord(data.ranges)
      ? data.ranges
      : isRecord(data)
        ? data
        : {};
    const ranges: Record<string, RangeProgressEntry> = {};
    for (const [key, value] of Object.entries(rawRanges)) {
      const entry = normalizeProgressEntry(value);
      if (entry) ranges[String(key)] = entry;
    }
    return { version: 1, ranges };
  } catch {
    return { version: 1, ranges: {} };
  }
}

function saveProgressMetadata(root: string, metadata: RangeProgressMetadata): void {
  fs.writeFileSync(progressFilePath(root), `${JSON.stringify(metadata, null, 2)}\n`);
}

function setStoredReviewStatus(root: string, file: string, status: PreflopReviewStatus): void {
  const normalizedStatus = normalizeStoredReviewStatus(status);
  if (!normalizedStatus) {
    throw new Error("Invalid range review status.");
  }
  const metadata = loadStatusMetadata(root);
  metadata.ranges[relativeString(root, file)] = {
    reviewStatus: normalizedStatus,
    runStatus: "idle",
    updatedAt: new Date().toISOString()
  };
  saveStatusMetadata(root, metadata);
}

function setStoredRunStatus(root: string, file: string, runStatus: PreflopRunStatus): void {
  const normalizedRunStatus = normalizeStoredRunStatus(runStatus);
  if (!normalizedRunStatus) {
    throw new Error("Invalid range run status.");
  }
  const metadata = loadStatusMetadata(root);
  const key = relativeString(root, file);
  const current = metadata.ranges[key];
  const storedDocument = normalizePreflopRangeDocument(readJson(file), path.basename(file));
  const reviewStatus = current?.reviewStatus ?? storedDocument.reviewStatus;
  if (reviewStatus !== "approved") {
    throw new Error("Range must be approved before run status can be updated.");
  }
  metadata.ranges[key] = {
    reviewStatus,
    runStatus: normalizedRunStatus,
    updatedAt: new Date().toISOString()
  };
  saveStatusMetadata(root, metadata);
}

function setStoredStatusFromDocument(root: string, file: string, document: PreflopRangeDocument): void {
  const metadata = loadStatusMetadata(root);
  metadata.ranges[relativeString(root, file)] = {
    reviewStatus: document.reviewStatus,
    runStatus: document.reviewStatus === "approved" ? document.runStatus : "idle",
    updatedAt: new Date().toISOString()
  };
  saveStatusMetadata(root, metadata);
}

function renameStatusKeys(root: string, oldPath: string, newPath: string): void {
  const metadata = loadStatusMetadata(root);
  if (Object.keys(metadata.ranges).length === 0) return;
  const oldKey = relativeString(root, oldPath);
  const newKey = relativeString(root, newPath);
  const ranges: Record<string, RangeStatusEntry> = {};
  let changed = false;
  for (const [key, value] of Object.entries(metadata.ranges)) {
    if (key === oldKey || key.startsWith(`${oldKey}/`)) {
      ranges[`${newKey}${key.slice(oldKey.length)}`] = value;
      changed = true;
    } else {
      ranges[key] = value;
    }
  }
  if (changed) saveStatusMetadata(root, { version: 1, ranges });
}

function renameProgressKeys(root: string, oldPath: string, newPath: string): void {
  const metadata = loadProgressMetadata(root);
  if (Object.keys(metadata.ranges).length === 0) return;
  const oldKey = relativeString(root, oldPath);
  const newKey = relativeString(root, newPath);
  const ranges: Record<string, RangeProgressEntry> = {};
  let changed = false;
  for (const [key, value] of Object.entries(metadata.ranges)) {
    if (key === oldKey || key.startsWith(`${oldKey}/`)) {
      ranges[`${newKey}${key.slice(oldKey.length)}`] = value;
      changed = true;
    } else {
      ranges[key] = value;
    }
  }
  if (changed) saveProgressMetadata(root, { version: 1, ranges });
}

function deleteStatusKeys(root: string, deletedPath: string): void {
  const metadata = loadStatusMetadata(root);
  if (Object.keys(metadata.ranges).length === 0) return;
  const deletedKey = relativeString(root, deletedPath);
  const ranges = Object.fromEntries(
    Object.entries(metadata.ranges).filter(([key]) => key !== deletedKey && !key.startsWith(`${deletedKey}/`))
  );
  if (Object.keys(ranges).length !== Object.keys(metadata.ranges).length) {
    saveStatusMetadata(root, { version: 1, ranges });
  }
}

function deleteProgressKeys(root: string, deletedPath: string): void {
  const metadata = loadProgressMetadata(root);
  if (Object.keys(metadata.ranges).length === 0) return;
  const deletedKey = relativeString(root, deletedPath);
  const ranges = Object.fromEntries(
    Object.entries(metadata.ranges).filter(([key]) => key !== deletedKey && !key.startsWith(`${deletedKey}/`))
  );
  if (Object.keys(ranges).length !== Object.keys(metadata.ranges).length) {
    saveProgressMetadata(root, { version: 1, ranges });
  }
}

function normalizeStoredStatusEntry(value: unknown): Omit<RangeStatusEntry, "updatedAt"> | null {
  const reviewSource = isRecord(value) ? value.reviewStatus ?? value.status : value;
  const runSource = isRecord(value) ? value.runStatus ?? value.status : value;
  const reviewStatus = normalizeStoredReviewStatus(reviewSource);
  if (!reviewStatus) return null;
  return {
    reviewStatus,
    runStatus: reviewStatus === "approved" ? normalizeStoredRunStatus(runSource) ?? "idle" : "idle"
  };
}

function normalizeStoredReviewStatus(value: unknown): PreflopReviewStatus | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PREFLOP_REVIEW_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as PreflopReviewStatus;
  }
  if ((PREFLOP_RUN_STATUSES as readonly string[]).includes(normalized)) {
    return "approved";
  }
  return null;
}

function normalizeStoredRunStatus(value: unknown): PreflopRunStatus | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PREFLOP_RUN_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as PreflopRunStatus;
  }
  return null;
}

function normalizeProgressEntry(value: unknown): RangeProgressEntry | null {
  if (!isRecord(value)) return null;
  const datasetName = typeof value.datasetName === "string" && value.datasetName.trim()
    ? value.datasetName.trim()
    : null;
  if (!datasetName) return null;
  const totalRows = positiveTotalRows(value.totalRows);
  return {
    datasetName,
    rows: normalizedRows(value.rows),
    totalRows,
    ratio: clampRatio(value.ratio ?? normalizedRows(value.rows) / totalRows),
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    error: typeof value.error === "string" ? value.error : undefined
  };
}

function progressEntry(datasetName: string, rows: number, totalRows: number, checkedAt?: string): RangeProgressEntry {
  const normalizedTotal = positiveTotalRows(totalRows);
  const normalizedRowCount = normalizedRows(rows);
  return {
    datasetName,
    rows: normalizedRowCount,
    totalRows: normalizedTotal,
    ratio: clampRatio(normalizedRowCount / normalizedTotal),
    checkedAt,
    updatedAt: checkedAt
  };
}

async function fetchHuggingFaceDatasetRows(
  repoId: string,
  hfToken: string | null,
  hfProxyUrl: string | null,
  context: { preferFileListing: boolean }
): Promise<{ rows: number; usedFileListing: boolean }> {
  const headers: Record<string, string> = {};
  const token = hfToken?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!await huggingFaceDatasetMatches(repoId, headers, hfProxyUrl)) {
    return { rows: 0, usedFileListing: false };
  }

  if (context.preferFileListing) {
    return {
      rows: await fetchHuggingFaceBoardArtifactCount(repoId, headers, hfProxyUrl),
      usedFileListing: true
    };
  }

  const url = `https://datasets-server.huggingface.co/size?dataset=${encodeURIComponent(repoId)}`;
  let sizeError: Error;
  try {
    const response = await huggingFaceFetch(url, {
      headers,
      proxyUrl: hfProxyUrl,
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      const data = await response.json() as unknown;
      const rows = extractHuggingFaceRows(data);
      if (rows != null) return { rows: normalizedRows(rows), usedFileListing: false };
      sizeError = new Error(`Hugging Face size check returned no row count for ${repoId}.`);
    } else {
      sizeError = new Error(`Hugging Face size check failed for ${repoId}: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    sizeError = error instanceof Error
      ? new Error(`Hugging Face size check failed for ${repoId}: ${error.message}`)
      : new Error(`Hugging Face size check failed for ${repoId}.`);
  }

  context.preferFileListing = true;
  try {
    return {
      rows: await fetchHuggingFaceBoardArtifactCount(repoId, headers, hfProxyUrl),
      usedFileListing: true
    };
  } catch (error) {
    const fallbackMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`${sizeError.message} Repository file listing fallback failed: ${fallbackMessage}`);
  }
}

async function huggingFaceDatasetMatches(
  repoId: string,
  headers: Record<string, string>,
  hfProxyUrl: string | null
): Promise<boolean> {
  const encodedRepoId = repoId.split("/").map(encodeURIComponent).join("/");
  const response = await retryingHuggingFaceFetch(`https://huggingface.co/api/datasets/${encodedRepoId}`, {
    headers,
    proxyUrl: hfProxyUrl,
    redirect: "manual"
  });
  if (response.status === 404 || isRedirectStatus(response.status)) return false;
  if (!response.ok) {
    throw new Error(`Hugging Face repo check failed for ${repoId}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as unknown;
  const actualRepoId = isRecord(data) && typeof data.id === "string" ? data.id : null;
  if (!actualRepoId) {
    throw new Error(`Hugging Face repo check returned no dataset id for ${repoId}.`);
  }
  return actualRepoId === repoId;
}

async function fetchHuggingFaceBoardArtifactCount(
  repoId: string,
  headers: Record<string, string>,
  hfProxyUrl: string | null
): Promise<number> {
  const encodedRepoId = repoId.split("/").map(encodeURIComponent).join("/");
  const treePath = `/api/datasets/${encodedRepoId}/tree/main`;
  let nextUrl: string | null = `${HUGGING_FACE_ORIGIN}${treePath}?recursive=1&limit=${HUGGING_FACE_TREE_PAGE_LIMIT}`;
  const visitedUrls = new Set<string>();
  const boardKeys = new Set<string>();

  for (let page = 1; nextUrl && page <= HUGGING_FACE_TREE_MAX_PAGES; page += 1) {
    if (visitedUrls.has(nextUrl)) {
      throw new Error(`Hugging Face dataset file listing returned a repeated pagination URL for ${repoId}.`);
    }
    visitedUrls.add(nextUrl);
    const response = await retryingHuggingFaceFetch(nextUrl, {
      headers,
      proxyUrl: hfProxyUrl,
      redirect: "manual"
    });
    if (response.status === 404 || isRedirectStatus(response.status)) return 0;
    if (!response.ok) {
      throw new Error(
        `Hugging Face dataset file listing failed for ${repoId} on page ${page}: ` +
        `${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as unknown;
    const items = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
    for (const item of items) {
      const rawPath = isRecord(item) && typeof item.path === "string"
        ? item.path
        : isRecord(item) && typeof item.rfilename === "string"
          ? item.rfilename
          : null;
      const boardKey = rawPath ? boardArtifactKey(rawPath) : null;
      if (boardKey) boardKeys.add(boardKey);
    }
    nextUrl = validatedHuggingFaceTreeNextUrl(response.headers.get("link"), treePath, repoId);
  }

  if (nextUrl) {
    throw new Error(
      `Hugging Face dataset file listing exceeded ${HUGGING_FACE_TREE_MAX_PAGES} pages for ${repoId}.`
    );
  }
  return boardKeys.size;
}

function boardArtifactKey(rawPath: string): string | null {
  const filename = rawPath.split("/").pop() ?? "";
  const stem = filename.replace(/\.(parquet|json)$/i, "");
  if (stem === filename) return null;
  const key = stem.replace(/,/g, "").trim().toLowerCase();
  if (!/^(?:[2-9tjqka][cdhs]){3}$/.test(key)) return null;
  const cards = key.match(/[2-9tjqka][cdhs]/g) ?? [];
  return new Set(cards).size === 3 ? key : null;
}

function validatedHuggingFaceTreeNextUrl(
  linkHeader: string | null,
  treePath: string,
  repoId: string
): string | null {
  const rawNextUrl = huggingFaceNextLink(linkHeader);
  if (!rawNextUrl) return null;
  const parsed = new URL(rawNextUrl, HUGGING_FACE_ORIGIN);
  if (parsed.origin !== HUGGING_FACE_ORIGIN || parsed.pathname !== treePath) {
    throw new Error(`Hugging Face dataset file listing returned an invalid pagination URL for ${repoId}.`);
  }
  return parsed.toString();
}

function huggingFaceNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    const url = part.match(/<([^>]+)>/)?.[1];
    const relation = part.match(/;\s*rel=(?:"([^"]+)"|([^;\s,]+))/i);
    const relations = (relation?.[1] ?? relation?.[2] ?? "").split(/\s+/);
    if (url && relations.includes("next")) return url;
  }
  return null;
}

async function retryingHuggingFaceFetch(
  url: string,
  options: Omit<HuggingFaceFetchOptions, "signal">
): Promise<Response> {
  const delays = [500, 1_500];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await huggingFaceFetch(url, {
        ...options,
        signal: AbortSignal.timeout(10_000)
      });
      if (!isTransientHuggingFaceStatus(response.status) || attempt === delays.length) {
        return response;
      }
      lastError = new Error(`Hugging Face temporarily returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (attempt === delays.length) throw error;
    }
    await wait(delays[attempt]!);
  }
  throw lastError instanceof Error ? lastError : new Error("Hugging Face request failed.");
}

function isTransientHuggingFaceStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function extractHuggingFaceRows(data: unknown): number | null {
  const record = isRecord(data) ? data : null;
  const size = record && isRecord(record.size) ? record.size : null;
  const sizeDatasetRows = readNestedNumber(size, ["dataset", "num_rows"]);
  if (sizeDatasetRows != null) return sizeDatasetRows;
  const datasetRows = readNestedNumber(data, ["dataset", "num_rows"]);
  if (datasetRows != null) return datasetRows;

  const splits: unknown[] | null = size && Array.isArray(size.splits)
    ? size.splits
    : record && Array.isArray(record.splits)
      ? record.splits
      : null;
  if (splits) {
    const splitRows = splits
      .map((split: unknown) => isRecord(split) && typeof split.num_rows === "number" ? split.num_rows : null)
      .filter((value): value is number => value != null);
    if (splitRows.length > 0) return splitRows.reduce((sum: number, value: number) => sum + value, 0);
  }

  return findFirstNumRows(data);
}

function readNestedNumber(value: unknown, keys: string[]): number | null {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function findFirstNumRows(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumRows(item);
      if (found != null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.num_rows === "number" && Number.isFinite(value.num_rows)) return value.num_rows;
  for (const child of Object.values(value)) {
    const found = findFirstNumRows(child);
    if (found != null) return found;
  }
  return null;
}

function normalizedRows(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function positiveTotalRows(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return SOLVER_TOTAL_BOARD_COUNT;
  return Math.floor(parsed);
}

function clampRatio(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(1, parsed);
}

function normalizedRepoNamespace(value: unknown): string {
  const namespace = typeof value === "string" ? value.trim() : "";
  return namespace || "Tsumugii";
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const item = items[index]!;
      index += 1;
      await worker(item);
    }
  }));
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} ${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Too many files with the same name.");
}

function cleanRangeFilename(name: string): string {
  const cleaned = cleanPathLeaf(name);
  const parsed = path.parse(cleaned);
  if (parsed.ext.toLowerCase() === ".range") return `${parsed.name}.json`;
  if (parsed.ext.toLowerCase() === ".json") return cleaned;
  if (parsed.ext) return `${parsed.name}.json`;
  return `${cleaned}.json`;
}

function cleanFolderName(name: string): string {
  return cleanPathLeaf(name);
}

function cleanPathLeaf(name: string): string {
  const cleaned = path.basename(name).trim().replace(/[\\/:*?"<>|]/g, "").replace(/^\.+|\.+$/g, "").trim();
  if (!cleaned) throw new Error("Invalid name.");
  return cleaned;
}

function normalizedUploadRelative(filename: string, relativePath: string): string {
  if (!relativePath) return filename;
  const parts = relativePath.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
  if (parts.length <= 1) return filename;
  return path.join(...parts.slice(0, -1).map(cleanFolderName), cleanRangeFilename(parts[parts.length - 1] ?? filename));
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function writeRangeDocument(file: string, document: PreflopRangeDocument): void {
  fs.writeFileSync(file, serializePreflopRangeDocument(document));
}

function assertRangeFile(file: string): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || path.extname(file).toLowerCase() !== ".json") {
    throw new Error("Only range JSON files can be opened.");
  }
}

function assertJsonFilePath(file: string): void {
  if (path.extname(file).toLowerCase() !== ".json") {
    throw new Error("Range files must use the .json suffix.");
  }
}

function walkRangeFiles(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) return walkRangeFiles(fullPath);
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".json") return [fullPath];
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
