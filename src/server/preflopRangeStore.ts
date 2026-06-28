import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  normalizePreflopRangeDocument,
  serializePreflopRangeDocument,
  setPreflopLearned,
  setPreflopStatus,
  summarizePreflopRange,
  type PreflopRangeDocument,
  type PreflopRangeFileItem,
  type PreflopRangeFileResponse,
  type PreflopRangeFolderItem,
  type PreflopRangeStatus,
  type PreflopRangeTreeItem,
  type PreflopRangeTreeResponse
} from "../shared/preflopRange";

const ORDER_FILE = ".range_order.json";

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

export function listPreflopRanges(rootPath: string): PreflopRangeTreeResponse {
  const root = ensureRoot(rootPath);
  return {
    root,
    tree: buildTree(root, root)
  };
}

export function readPreflopRangeFile(rootPath: string, relativePath: string): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertRangeFile(target);
  const data = normalizePreflopRangeDocument(readJson(target), path.basename(target));
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
  writeRangeDocument(target, document);
  appendToOrder(root, path.dirname(target), path.basename(target));
  return readPreflopRangeFile(root, relativeString(root, target));
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
  const data = normalizePreflopRangeDocument(readJson(target), path.basename(target));
  writeRangeDocument(target, setPreflopLearned(data, learned));
  return readPreflopRangeFile(root, relativeString(root, target));
}

export function updatePreflopRangeStatus(
  rootPath: string,
  relativePath: string,
  status: PreflopRangeStatus
): PreflopRangeFileResponse {
  const root = ensureRoot(rootPath);
  const target = safePath(root, relativePath);
  assertRangeFile(target);
  const data = normalizePreflopRangeDocument(readJson(target), path.basename(target));
  writeRangeDocument(target, setPreflopStatus(data, status));
  return readPreflopRangeFile(root, relativeString(root, target));
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
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeRangeDocument(target, normalizePreflopRangeDocument(parsed, filename));
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

function buildTree(root: string, folder: string): PreflopRangeTreeItem[] {
  return orderedChildren(root, folder).flatMap((item): PreflopRangeTreeItem[] => {
    const name = path.basename(item);
    if (name.startsWith(".")) return [];
    const stat = fs.statSync(item);
    if (stat.isDirectory()) {
      const folderItem: PreflopRangeFolderItem = {
        type: "folder",
        name,
        path: relativeString(root, item),
        children: buildTree(root, item)
      };
      return [folderItem];
    }
    if (stat.isFile() && path.extname(item).toLowerCase() === ".json") {
      return [fileSummary(root, item)];
    }
    return [];
  });
}

function fileSummary(root: string, file: string): PreflopRangeFileItem {
  let label = "Invalid JSON";
  let learned = false;
  let status: PreflopRangeStatus = "under_review";
  let rangePct: PreflopRangeFileItem["rangePct"] = { A: 0, B: 0 };
  try {
    const data = normalizePreflopRangeDocument(readJson(file), path.basename(file));
    const summary = summarizePreflopRange(data, path.basename(file));
    label = `${summary.players.A.name} vs ${summary.players.B.name}`;
    learned = summary.data.learned;
    status = summary.data.status;
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
    rangePct
  };
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
