import {
  ArrowLeft,
  Check,
  Download,
  FileJson,
  Folder,
  FolderPlus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { type ChangeEvent, type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PREFLOP_HAND_GRID,
  PREFLOP_RANKS,
  PREFLOP_PLAYERS,
  setPreflopHandFrequency,
  setPreflopLearned,
  setPreflopPlayerName,
  setPreflopPlayerPosition,
  summarizePreflopRange,
  type PreflopHandCode,
  type PreflopPlayerKey,
  type PreflopPlayerPosition,
  type PreflopRangeDocument,
  type PreflopRangeFileItem,
  type PreflopRangeFileResponse,
  type PreflopRangeFolderItem,
  type PreflopRangeSummary,
  type PreflopRangeTreeItem,
  type PreflopRangeTreeResponse
} from "../shared/preflopRange";

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

const EXPANDED_FOLDERS_KEY = "preflop-range-expanded-folders";
const DEFAULT_SELECTED_HAND = "AA";

export function PreflopRangeView({ onBack }: { onBack: () => void }) {
  const [tree, setTree] = useState<PreflopRangeTreeItem[]>([]);
  const [currentFolderPath, setCurrentFolderPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<SelectedRangePath | null>(null);
  const [selectedFile, setSelectedFile] = useState<PreflopRangeFileResponse | null>(null);
  const [draft, setDraft] = useState<PreflopRangeDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedHand, setSelectedHand] = useState<PreflopHandCode>(DEFAULT_SELECTED_HAND);
  const [activePlayer, setActivePlayer] = useState<PreflopPlayerKey>("A");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => readExpandedFolders());
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const loadTree = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchPreflopJson<PreflopRangeTreeResponse>("/api/preflop-ranges");
      setTree(response.tree);
      if (currentFolderPath && !findFolder(response.tree, currentFolderPath)) {
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

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...expandedFolders]));
    } catch {
      // ignore storage failures
    }
  }, [expandedFolders]);

  const folder = findFolder(tree, currentFolderPath);
  const currentItems = useMemo(
    () => filterTreeItems(folder ? folder.children : tree, query),
    [folder, query, tree]
  );
  const summary = useMemo<PreflopRangeSummary | null>(
    () => draft ? summarizePreflopRange(draft, selectedPath?.name ?? "") : selectedFile?.summary ?? null,
    [draft, selectedFile, selectedPath?.name]
  );
  const selectedCell = summary?.players[activePlayer].matrix[selectedHand] ?? { raise: 0, call: 0 };
  const selectedFolderForWrites = selectedPath?.type === "folder" ? selectedPath.path : currentFolderPath;
  const folderCount = useMemo(() => countFolders(tree), [tree]);

  const selectFolder = (path: string) => {
    setCurrentFolderPath(path);
    expandAncestors(path, setExpandedFolders);
    setSelectedPath({ type: "folder", path, name: folderName(path) });
    setSelectedFile(null);
    setDraft(null);
    setDirty(false);
  };

  const selectFile = async (item: PreflopRangeFileItem) => {
    setError(null);
    try {
      const response = await fetchPreflopJson<PreflopRangeFileResponse>(
        `/api/preflop-ranges/file?path=${encodeURIComponent(item.path)}`
      );
      setSelectedPath({ type: "file", path: item.path, name: item.name });
      setSelectedFile(response);
      setDraft(response.summary.data);
      setDirty(false);
      setSelectedHand(DEFAULT_SELECTED_HAND);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const updateDraft = (next: PreflopRangeDocument) => {
    setDraft(next);
    setDirty(true);
  };

  const saveDraft = async () => {
    if (!selectedPath || selectedPath.type !== "file" || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetchPreflopJson<PreflopRangeFileResponse>(
        `/api/preflop-ranges/file?path=${encodeURIComponent(selectedPath.path)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: draft })
        }
      );
      setSelectedFile(response);
      setDraft(response.summary.data);
      setDirty(false);
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggleLearned = async (item?: PreflopRangeFileItem) => {
    const targetPath = item?.path ?? (selectedPath?.type === "file" ? selectedPath.path : "");
    const currentLearned = item?.learned ?? draft?.learned ?? false;
    if (!targetPath) return;
    setError(null);
    try {
      const response = await fetchPreflopJson<PreflopRangeFileResponse>("/api/preflop-ranges/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath, learned: !currentLearned })
      });
      if (selectedPath?.type === "file" && selectedPath.path === targetPath) {
        setSelectedFile(response);
        setDraft(response.summary.data);
        setDirty(false);
      }
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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

  const renameSelected = async () => {
    if (!selectedPath || selectedPath.path === "") return;
    const nextName = window.prompt("New name", selectedPath.name);
    if (!nextName) return;
    setError(null);
    try {
      const response = await fetchPreflopJson<{ path: string }>("/api/preflop-ranges/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedPath.path, newName: nextName })
      });
      if (selectedPath.type === "folder") {
        setCurrentFolderPath(response.path);
      }
      const renamedName = selectedPath.type === "file"
        ? (nextName.replace(/\.range$/i, ".json").endsWith(".json") ? nextName.replace(/\.range$/i, ".json") : `${nextName}.json`)
        : nextName;
      setSelectedPath({ ...selectedPath, path: response.path, name: renamedName });
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const deleteSelected = async () => {
    if (!selectedPath || selectedPath.path === "") return;
    if (!window.confirm(`Delete ${selectedPath.name}?`)) return;
    setError(null);
    try {
      await fetchPreflopJson<{ ok: boolean }>(`/api/preflop-ranges/path?path=${encodeURIComponent(selectedPath.path)}`, {
        method: "DELETE"
      });
      setSelectedPath(null);
      setSelectedFile(null);
      setDraft(null);
      setDirty(false);
      await loadTree();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const uploadFiles = async (input: HTMLInputElement, preserveRelativePath: boolean) => {
    const files = [...(input.files ?? [])].filter((file) => /\.(json|range)$/i.test(file.name));
    if (files.length === 0) {
      setError("Choose .json or .range files first.");
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
    const names = currentItems.map((item) => item.name).filter((name) => name !== dragItem.name);
    const targetIndex = names.indexOf(target.name);
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

  return (
    <>
      <button className="icon-button ghost" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to Overview
      </button>

      <section className="section-heading preflop-heading">
        <div>
          <h2>Preflop Range Library</h2>
          <p>{countFiles(tree)} JSON ranges · {folderCount} folders</p>
        </div>
        <div className="preflop-heading-actions">
          <button className="icon-button" onClick={() => void loadTree()} disabled={loading || saving}>
            <RefreshCw size={16} />
            Refresh
          </button>
          <button className="icon-button primary" onClick={() => void saveDraft()} disabled={!dirty || saving || !draft}>
            <Save size={16} />
            {saving ? "Saving..." : "Save Range"}
          </button>
        </div>
      </section>

      {error ? <div className="notice error">{error}</div> : null}

      <section className="preflop-layout">
        <aside className="panel preflop-library">
          <div className="preflop-library-header">
            <div className="panel-title">
              <FileJson size={16} />
              <h3>Range Files</h3>
            </div>
            <span className="preflop-library-count">{currentItems.length}</span>
          </div>

          <label className="preflop-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="Search folders, players, spots"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

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
                <strong>{folderName(currentFolderPath)}</strong>
                <span>{currentItems.length} items</span>
              </div>
              <div className="preflop-file-list">
                {loading ? <div className="preflop-empty">Loading ranges...</div> : null}
                {!loading && currentItems.length === 0 ? (
                  <div className="preflop-empty">{query ? "No matches in this folder." : "No files in this folder."}</div>
                ) : null}
                {currentItems.map((item) => (
                  <button
                    key={item.path}
                    className={[
                      "preflop-file-row",
                      item.type === "folder" ? "folder" : "file",
                      selectedPath?.path === item.path ? "active" : "",
                      item.type === "file" && item.learned ? "learned" : "",
                      dropTarget?.path === item.path ? `drop-${dropTarget.mode}` : ""
                    ].filter(Boolean).join(" ")}
                    draggable
                    onClick={() => item.type === "folder" ? selectFolder(item.path) : void selectFile(item)}
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
                      <strong>{item.name}</strong>
                      <span>{item.type === "file" ? item.label : `${item.children.length} items`}</span>
                    </span>
                    {item.type === "file" ? (
                      <span className="preflop-row-meta">
                        <span>A {item.rangePct.A.toFixed(1)}%</span>
                        <span>B {item.rangePct.B.toFixed(1)}%</span>
                      </span>
                    ) : null}
                    {item.type === "file" ? (
                      <span
                        className={`preflop-learned-toggle ${item.learned ? "checked" : ""}`}
                        role="checkbox"
                        aria-checked={item.learned}
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleLearned(item);
                        }}
                      >
                        {item.learned ? <Check size={13} /> : null}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </aside>

        <section className="preflop-workspace">
          <div className="panel preflop-workspace-toolbar">
            <div>
              <div className="panel-title">
                <FileJson size={16} />
                <h3>{selectedPath?.type === "file" ? selectedPath.name : "No range selected"}</h3>
              </div>
              <p>{selectedFile ? formatFileMeta(selectedFile) : "Select a range JSON file to inspect and edit."}</p>
            </div>
            <div className="preflop-workspace-actions">
              <button className="icon-button compact" onClick={() => void renameSelected()} disabled={!selectedPath || selectedPath.path === "" || saving}>
                Rename
              </button>
              <button className="icon-button compact danger" onClick={() => void deleteSelected()} disabled={!selectedPath || selectedPath.path === "" || saving}>
                <Trash2 size={15} />
                Delete
              </button>
            </div>
          </div>

          {summary && draft ? (
            <>
              <section className="panel preflop-editor-panel">
                <div className="preflop-editor-grid">
                  {PREFLOP_PLAYERS.map((player) => (
                    <PlayerEditor
                      key={player}
                      player={player}
                      document={draft}
                      active={activePlayer === player}
                      onSelect={() => setActivePlayer(player)}
                      onChange={updateDraft}
                    />
                  ))}
                  <label className="preflop-learned-switch">
                    <input
                      type="checkbox"
                      checked={draft.learned}
                      onChange={(event) => updateDraft(setPreflopLearned(draft, event.target.checked))}
                    />
                    <span>{draft.learned ? "Studied" : "Not studied"}</span>
                  </label>
                </div>

                <div className="preflop-hand-editor">
                  <div>
                    <span className="settings-status-label">Selected hand</span>
                    <strong>{selectedHand}</strong>
                  </div>
                  <RangeSlider
                    label={`${activePlayer} Raise`}
                    value={Math.round(selectedCell.raise * 100)}
                    onChange={(value) => updateDraft(setPreflopHandFrequency(draft, activePlayer, "raise", selectedHand, value))}
                  />
                  <RangeSlider
                    label={`${activePlayer} Call`}
                    value={Math.round(selectedCell.call * 100)}
                    onChange={(value) => updateDraft(setPreflopHandFrequency(draft, activePlayer, "call", selectedHand, value))}
                  />
                  <div>
                    <span className="settings-status-label">Fold</span>
                    <strong>{Math.round(Math.max(0, 1 - selectedCell.raise - selectedCell.call) * 100)}%</strong>
                  </div>
                </div>
              </section>

              <section className="preflop-matrix-grid">
                {PREFLOP_PLAYERS.map((player) => (
                  <RangeMatrix
                    key={player}
                    player={player}
                    summary={summary}
                    active={activePlayer === player}
                    selectedHand={selectedHand}
                    onPlayerSelect={() => setActivePlayer(player)}
                    onHandSelect={setSelectedHand}
                  />
                ))}
              </section>
            </>
          ) : (
            <section className="panel preflop-empty-workspace">
              <FileJson size={24} />
              <p>No range file selected.</p>
            </section>
          )}
        </section>
      </section>
    </>
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
  const hasChildFolders = item.children.some((child) => child.type === "folder");
  const expanded = query.trim() !== "" || expandedFolders.has(item.path);
  return (
    <button
      className={[
        "preflop-folder-row",
        activePath === item.path ? "active" : "",
        dropTarget?.path === item.path && dropTarget.mode === "inside" ? "drop-inside" : ""
      ].filter(Boolean).join(" ")}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable={item.path !== ""}
      onClick={() => onSelect(item.path)}
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
        {hasChildFolders ? (expanded ? "v" : ">") : ""}
      </span>
      <Folder size={14} />
      <span>{item.name}</span>
      <strong>{item.children.length}</strong>
    </button>
  );
}

function PlayerEditor({
  player,
  document,
  active,
  onSelect,
  onChange
}: {
  player: PreflopPlayerKey;
  document: PreflopRangeDocument;
  active: boolean;
  onSelect: () => void;
  onChange: (document: PreflopRangeDocument) => void;
}) {
  return (
    <div className={`preflop-player-editor ${active ? "active" : ""}`} onClick={onSelect}>
      <label>
        <span>{player} name</span>
        <input
          value={document.player_names[player]}
          onChange={(event) => onChange(setPreflopPlayerName(document, player, event.target.value))}
        />
      </label>
      <label>
        <span>Position</span>
        <select
          value={document.player_positions[player]}
          onChange={(event) => onChange(setPreflopPlayerPosition(document, player, event.target.value as PreflopPlayerPosition))}
        >
          <option value="Unknown">Unknown</option>
          <option value="IP">IP</option>
          <option value="OOP">OOP</option>
        </select>
      </label>
    </div>
  );
}

function RangeSlider({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="preflop-range-slider">
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min="0"
        max="100"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <strong>%</strong>
    </label>
  );
}

function RangeMatrix({
  player,
  summary,
  active,
  selectedHand,
  onPlayerSelect,
  onHandSelect
}: {
  player: PreflopPlayerKey;
  summary: PreflopRangeSummary;
  active: boolean;
  selectedHand: string;
  onPlayerSelect: () => void;
  onHandSelect: (hand: PreflopHandCode) => void;
}) {
  const data = summary.players[player];
  return (
    <article className={`panel preflop-matrix-card ${active ? "active" : ""}`} onClick={onPlayerSelect}>
      <div className="preflop-matrix-head">
        <div>
          <h3>{data.position && data.position !== "Unknown" ? `${data.name} · ${data.position}` : data.name}</h3>
          <p>{player} player</p>
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

function filterTreeItems(items: PreflopRangeTreeItem[], query: string): PreflopRangeTreeItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) => `${item.name} ${item.type === "file" ? item.label : ""}`.toLowerCase().includes(normalized));
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

function countFolders(items: PreflopRangeTreeItem[]): number {
  return items.reduce((count, item) => item.type === "folder" ? count + 1 + countFolders(item.children) : count, 0);
}

function countFiles(items: PreflopRangeTreeItem[]): number {
  return items.reduce((count, item) => item.type === "folder" ? count + countFiles(item.children) : count + 1, 0);
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

function formatFileMeta(file: PreflopRangeFileResponse): string {
  const modified = new Date(file.summary.data.updatedAt ?? Date.now()).toLocaleString();
  return `${file.summary.players.A.name} vs ${file.summary.players.B.name} · Updated ${modified}`;
}
