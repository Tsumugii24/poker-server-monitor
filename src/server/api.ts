import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import type {
  AlertSettings,
  HfProxyRuntimeStatus,
  OverviewResponse,
  OverviewSummary,
  ServerDetailResponse,
  ServerConfig,
  WeChatAccountConnectorStatus,
  WeChatAccountsStatus,
  WeChatConnectorStatus,
  WeChatRecipient
} from "../shared/types";
import type { PreflopRangeDocument } from "../shared/preflopRange";
import { PREFLOP_REVIEW_STATUSES } from "../shared/preflopRange";
import {
  createServerInventoryEntry,
  deleteServerInventoryEntry,
  loadAlertSettings,
  loadServerInventory,
  saveAlertSettings,
  updateServerInventoryEntry,
  type ServerInventoryCreateInput,
  type ServerInventoryUpdateInput
} from "./config";
import {
  enabledAlertTargets,
  findAlertTarget,
  formatTestAlertMessage,
  alertRefreshIntervalMs,
  type AlertDeliveryTarget
} from "./alertService";
import type { MonitorDatabase } from "./db";
import type { RefreshService } from "./refreshService";
import { buildWeChatDelivery } from "../shared/wechatDelivery";
import { defaultWeChatStoredSession } from "../shared/wechatSession";
import {
  approveAllPreflopRanges,
  buildPreflopRangeDownload,
  createPreflopRangeFolder,
  deletePreflopRangePath,
  listPreflopRanges,
  movePreflopRangePath,
  readPreflopRangeFile,
  renamePreflopRangePath,
  reorderPreflopRanges,
  refreshPreflopRangeProgress,
  savePreflopRangeFile,
  saveUploadedPreflopRangeFiles,
  updatePreflopRangeLearned,
  updatePreflopRangeStatus,
  type PreflopRangeRuntimeInput,
  type UploadedPreflopRangeFile
} from "./preflopRangeStore";
import { SolverJobService } from "./solverJobService";
import {
  SOLVER_JOB_QUEUE_MODES,
  type ParallelFailurePoolPreviewRequest,
  type ParallelFailurePoolSubmitRequest,
  type ParallelSolverJobCreateRequest,
  type ParallelSolverJobPreviewRequest,
  type ParallelSolverQueueReorderRequest,
  type SolverDatasetRepoEnsureRequest,
  type SolverJobCreateRequest,
  type SolverJobPreviewRequest,
  type SolverScenarioLibraryItem
} from "../shared/solverJobs";
import type {
  ServerNetworkCheckRequest,
  ServerNetworkSyncRequest,
  ServerSyncRequest,
  ServerUploadRequest
} from "../shared/serverOperations";
import {
  addSolverScenario,
  deleteSolverScenario,
  loadSolverScenarioLibrary,
  updateSolverScenario
} from "./scenarioLibraryStore";

export type AppDependencies = {
  db: MonitorDatabase;
  refreshService: RefreshService;
  inventoryPath?: string;
  alertSettingsPath?: string;
  preflopRangesPath?: string;
  solverScenarioLibraryPath?: string;
  solverJobService?: SolverJobService;
  solverJobRepoNamespace?: string;
  hfToken?: string | null;
  hfProxyUrl?: string | null;
  solverHfProxyUrl?: string | null;
  networkSubscriptionUrl?: string | null;
  giteeUsername?: string | null;
  giteeToken?: string | null;
  sshUsername?: string | null;
  defaultRefreshIntervalMs?: number;
  sendTestAlert?: (message: string, roomId: string) => Promise<void> | void;
  startAlertConnector?: () => Promise<void> | void;
  restartAlertConnector?: () => Promise<void> | void;
  refreshWeChatConnector?: () => Promise<void> | void;
  restoreAlertConnector?: () => Promise<void> | void;
  logoutWeChatConnector?: () => Promise<void> | void;
  switchWeChatConnector?: () => Promise<void> | void;
  getWeChatStatus?: () => WeChatConnectorStatus;
  getWeChatAccountsStatus?: () => WeChatAccountsStatus;
  createWeChatAccount?: (label?: string) => Promise<WeChatAccountConnectorStatus> | WeChatAccountConnectorStatus;
  refreshWeChatAccountQr?: (accountId: string) => Promise<WeChatAccountConnectorStatus> | WeChatAccountConnectorStatus;
  restoreWeChatAccount?: (accountId: string) => Promise<WeChatAccountConnectorStatus> | WeChatAccountConnectorStatus;
  logoutWeChatAccount?: (accountId: string) => Promise<WeChatAccountConnectorStatus> | WeChatAccountConnectorStatus;
  removeWeChatAccount?: (accountId: string) => Promise<WeChatAccountsStatus> | WeChatAccountsStatus;
  updateWeChatAccount?: (
    accountId: string,
    patch: { label?: string; enabled?: boolean }
  ) => Promise<WeChatAccountConnectorStatus> | WeChatAccountConnectorStatus;
  verifyWeChatAccount?: (
    accountId: string,
    targetUserId?: string
  ) => Promise<WeChatAccountConnectorStatus> | WeChatAccountConnectorStatus;
};

export function createApp({
  db,
  refreshService,
  inventoryPath = "config/servers.json",
  alertSettingsPath = "config/alerts.json",
  preflopRangesPath = "config/preflop-ranges",
  solverScenarioLibraryPath = "config/solver-scenarios.json",
  solverJobService: providedSolverJobService,
  solverJobRepoNamespace = "Tsumugii",
  hfToken = null,
  hfProxyUrl = null,
  solverHfProxyUrl = null,
  networkSubscriptionUrl = null,
  giteeUsername = null,
  giteeToken = null,
  sshUsername = null,
  defaultRefreshIntervalMs = 3_600_000,
  sendTestAlert,
  startAlertConnector,
  restartAlertConnector,
  refreshWeChatConnector,
  restoreAlertConnector,
  logoutWeChatConnector,
  switchWeChatConnector,
  getWeChatStatus,
  getWeChatAccountsStatus,
  createWeChatAccount,
  refreshWeChatAccountQr,
  restoreWeChatAccount,
  logoutWeChatAccount,
  removeWeChatAccount,
  updateWeChatAccount,
  verifyWeChatAccount
}: AppDependencies): Express {
  const solverJobService = providedSolverJobService ?? new SolverJobService({
    db,
    preflopRangesPath,
    repoNamespace: solverJobRepoNamespace,
    hfToken,
    hfProxyUrl,
    solverHfProxyUrl,
    networkSubscriptionUrl,
    giteeUsername,
    giteeToken,
    getHfProxySettings: () => loadAlertSettings(alertSettingsPath),
    getScenarioLibrary: () => loadSolverScenarioLibrary(solverScenarioLibraryPath).scenarios
  });
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/overview", (_request, response) => {
    const servers = db.getServerRows();
    const summary = buildSummary(servers);
    const body: OverviewResponse = {
      generatedAt: new Date().toISOString(),
      refresh: refreshService.getState(),
      sshUsername,
      summary,
      description: describeOverview(summary),
      servers,
      overallHistory: db.getOverallHistory(24)
    };
    response.json(body);
  });

  app.get("/api/servers", (_request, response) => {
    response.json(db.getServers());
  });

  app.post("/api/servers", (request, response) => {
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_server_create" });
      return;
    }
    if ("id" in request.body || "name" in request.body) {
      response.status(400).json({
        error: "immutable_server_field",
        message: "id and name are managed automatically"
      });
      return;
    }

    try {
      const created = createServerInventoryEntry(inventoryPath, serverCreateInputFromBody(request.body));
      syncServerInventory(db, refreshService, inventoryPath);
      response.status(201).json(created);
    } catch (error) {
      response.status(400).json({
        error: "invalid_server_create",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/servers/:id", (request, response) => {
    const server = db.getServer(request.params.id);
    if (!server) {
      response.status(404).json({ error: "server_not_found" });
      return;
    }

    const body: ServerDetailResponse = {
      server,
      latest: db.getLatestSnapshot(server.id),
      pipeline: db.getLatestPipelineSnapshot(server.id),
      pipelineHistory: db.getPipelineHistory(server.id, 24),
      history: db.getServerHistory(server.id, 24)
    };
    response.json(body);
  });

  app.patch("/api/servers/:id", (request, response) => {
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_server_update" });
      return;
    }
    if ("id" in request.body || "name" in request.body) {
      response.status(400).json({
        error: "immutable_server_field",
        message: "id and name are managed automatically"
      });
      return;
    }

    try {
      const patch = serverUpdateInputFromBody(request.body);
      if (Object.keys(patch).length === 0) {
        response.status(400).json({ error: "invalid_server_update" });
        return;
      }
      const updated = updateServerInventoryEntry(inventoryPath, request.params.id, patch);
      syncServerInventory(db, refreshService, inventoryPath);
      response.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        response.status(404).json({ error: "server_not_found" });
        return;
      }
      if (/note must be/i.test(message)) {
        response.status(400).json({ error: "invalid_server_note" });
        return;
      }
      if (/must be/i.test(message)) {
        response.status(400).json({ error: "invalid_server_update", message });
        return;
      }
      response.status(500).json({ error: "inventory_update_failed", message });
    }
  });

  app.delete("/api/servers/:id", (request, response) => {
    try {
      deleteServerInventoryEntry(inventoryPath, request.params.id);
      const servers = syncServerInventory(db, refreshService, inventoryPath);
      response.json({ servers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        response.status(404).json({ error: "server_not_found" });
        return;
      }
      response.status(500).json({ error: "inventory_delete_failed", message });
    }
  });

  // ── Range Library ─────────────────────────────────────

  const preflopRangeRuntime = (): PreflopRangeRuntimeInput => ({
    jobs: solverJobService.listJobs().jobs
  });

  app.get("/api/preflop-ranges", (_request, response) => {
    try {
      response.json(listPreflopRanges(preflopRangesPath, preflopRangeRuntime()));
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_list_failed");
    }
  });

  app.get("/api/preflop-ranges/file", (request, response) => {
    try {
      response.json(readPreflopRangeFile(
        preflopRangesPath,
        String(request.query.path ?? ""),
        preflopRangeRuntime()
      ));
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_read_failed");
    }
  });

  app.post("/api/preflop-ranges/refresh-progress", async (_request, response) => {
    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const progress = await refreshPreflopRangeProgress(preflopRangesPath, {
        hfToken,
        repoNamespace: solverJobRepoNamespace,
        hfProxyUrl: settings.hfProxyEnabled ? hfProxyUrl : null
      });
      response.json({
        ok: true,
        ...progress,
        ...listPreflopRanges(preflopRangesPath, preflopRangeRuntime())
      });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_progress_failed");
    }
  });

  app.put("/api/preflop-ranges/file", (request, response) => {
    if (!isRecord(request.body) || !isRecord(request.body.document)) {
      response.status(400).json({ error: "invalid_preflop_range", message: "document is required" });
      return;
    }

    try {
      response.json(savePreflopRangeFile(
        preflopRangesPath,
        String(request.query.path ?? request.body.path ?? ""),
        request.body.document as PreflopRangeDocument
      ));
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_save_failed");
    }
  });

  app.post("/api/preflop-ranges/upload-many", (request, response) => {
    if (!isRecord(request.body) || !Array.isArray(request.body.files)) {
      response.status(400).json({ error: "invalid_preflop_upload", message: "files are required" });
      return;
    }

    try {
      const saved = saveUploadedPreflopRangeFiles(
        preflopRangesPath,
        typeof request.body.folder === "string" ? request.body.folder : "",
        request.body.files as UploadedPreflopRangeFile[]
      );
      response.status(201).json({ ok: true, saved, count: saved.length });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_upload_failed");
    }
  });

  app.post("/api/preflop-ranges/folder", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.name !== "string") {
      response.status(400).json({ error: "invalid_preflop_folder", message: "name is required" });
      return;
    }

    try {
      const path = createPreflopRangeFolder(
        preflopRangesPath,
        typeof request.body.parent === "string" ? request.body.parent : "",
        request.body.name
      );
      response.status(201).json({ ok: true, path });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_folder_failed");
    }
  });

  app.post("/api/preflop-ranges/rename", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.path !== "string" || typeof request.body.newName !== "string") {
      response.status(400).json({ error: "invalid_preflop_rename", message: "path and newName are required" });
      return;
    }

    try {
      const path = renamePreflopRangePath(preflopRangesPath, request.body.path, request.body.newName);
      response.json({ ok: true, path });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_rename_failed");
    }
  });

  app.post("/api/preflop-ranges/move", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.path !== "string" || typeof request.body.targetFolder !== "string") {
      response.status(400).json({ error: "invalid_preflop_move", message: "path and targetFolder are required" });
      return;
    }

    try {
      const path = movePreflopRangePath(preflopRangesPath, request.body.path, request.body.targetFolder);
      response.json({ ok: true, path });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_move_failed");
    }
  });

  app.post("/api/preflop-ranges/reorder", (request, response) => {
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_preflop_reorder" });
      return;
    }

    try {
      reorderPreflopRanges(
        preflopRangesPath,
        typeof request.body.folder === "string" ? request.body.folder : "",
        request.body.orderedNames
      );
      response.json({ ok: true });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_reorder_failed");
    }
  });

  app.post("/api/preflop-ranges/status", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.path !== "string") {
      response.status(400).json({ error: "invalid_preflop_status", message: "path is required" });
      return;
    }

    try {
      if (typeof request.body.status === "string") {
        if (!(PREFLOP_REVIEW_STATUSES as readonly string[]).includes(request.body.status)) {
          response.status(400).json({ error: "invalid_preflop_status", message: "status is invalid" });
          return;
        }
        response.json(updatePreflopRangeStatus(
          preflopRangesPath,
          request.body.path,
          request.body.status as (typeof PREFLOP_REVIEW_STATUSES)[number]
        ));
        return;
      }
      if (typeof request.body.learned === "boolean") {
        response.json(updatePreflopRangeLearned(preflopRangesPath, request.body.path, request.body.learned));
        return;
      }
      response.status(400).json({ error: "invalid_preflop_status", message: "status or learned is required" });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_status_failed");
    }
  });

  app.post("/api/preflop-ranges/approve-all", (_request, response) => {
    try {
      response.json({ ok: true, ...approveAllPreflopRanges(preflopRangesPath, preflopRangeRuntime()) });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_approve_all_failed");
    }
  });

  app.get("/api/preflop-ranges/download", (request, response) => {
    try {
      const download = buildPreflopRangeDownload(preflopRangesPath, String(request.query.path ?? ""));
      response.setHeader("Content-Type", download.contentType);
      response.setHeader("Content-Disposition", `attachment; filename="${download.filename.replace(/"/g, "")}"`);
      response.send(download.buffer);
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_download_failed");
    }
  });

  app.delete("/api/preflop-ranges/path", (request, response) => {
    try {
      deletePreflopRangePath(preflopRangesPath, String(request.query.path ?? ""));
      response.json({ ok: true });
    } catch (error) {
      respondPreflopRangeError(response, error, "preflop_range_delete_failed");
    }
  });

  // ── Solver scenario library ──────────────────────────────────

  app.get("/api/scenarios", (_request, response) => {
    try {
      response.json(loadSolverScenarioLibrary(solverScenarioLibraryPath));
    } catch (error) {
      response.status(500).json({
        error: "solver_scenario_list_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/scenarios", (request, response) => {
    if (!isRecord(request.body) || !isRecord(request.body.scenario)) {
      response.status(400).json({ error: "invalid_solver_scenario", message: "scenario is required" });
      return;
    }

    try {
      response.status(201).json(addSolverScenario(
        solverScenarioLibraryPath,
        request.body.scenario as SolverScenarioLibraryItem
      ));
    } catch (error) {
      respondScenarioLibraryError(response, error, "solver_scenario_create_failed");
    }
  });

  app.patch("/api/scenarios/:id", (request, response) => {
    if (!isRecord(request.body) || !isRecord(request.body.scenario)) {
      response.status(400).json({ error: "invalid_solver_scenario", message: "scenario is required" });
      return;
    }

    try {
      response.json(updateSolverScenario(
        solverScenarioLibraryPath,
        request.params.id,
        request.body.scenario as SolverScenarioLibraryItem
      ));
    } catch (error) {
      respondScenarioLibraryError(response, error, "solver_scenario_update_failed");
    }
  });

  app.delete("/api/scenarios/:id", (request, response) => {
    try {
      response.json(deleteSolverScenario(solverScenarioLibraryPath, request.params.id));
    } catch (error) {
      respondScenarioLibraryError(response, error, "solver_scenario_delete_failed");
    }
  });

  // ── Solver job system ─────────────────────────────────────────

  app.get("/api/jobs", (_request, response) => {
    try {
      response.json(solverJobService.listJobs());
    } catch (error) {
      respondSolverJobError(response, error, "solver_jobs_list_failed");
    }
  });

  app.post("/api/jobs/preview", (request, response) => {
    if (!isSolverJobPreviewRequest(request.body)) {
      response.status(400).json({ error: "invalid_solver_job_preview" });
      return;
    }

    try {
      response.json(solverJobService.preview(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_preview_failed");
    }
  });

  app.post("/api/jobs/dataset-repo/check", async (request, response) => {
    if (!isSolverJobPreviewRequest(request.body)) {
      response.status(400).json({ error: "invalid_solver_dataset_repo_check" });
      return;
    }

    try {
      response.json(await solverJobService.checkDatasetRepo(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "solver_dataset_repo_check_failed");
    }
  });

  app.post("/api/jobs/dataset-repo/ensure", async (request, response) => {
    if (!isSolverDatasetRepoEnsureRequest(request.body)) {
      response.status(400).json({ error: "invalid_solver_dataset_repo_ensure" });
      return;
    }

    try {
      response.json(await solverJobService.ensureDatasetRepo(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "solver_dataset_repo_ensure_failed");
    }
  });

  app.post("/api/jobs", async (request, response) => {
    if (!isSolverJobCreateRequest(request.body)) {
      response.status(400).json({ error: "invalid_solver_job" });
      return;
    }

    try {
      const job = await solverJobService.create(request.body);
      response.status(201).json({
        job,
        events: solverJobService.getJob(job.id).events
      });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_create_failed");
    }
  });

  app.get("/api/jobs/:id", (request, response) => {
    try {
      response.json(solverJobService.getJob(request.params.id));
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_read_failed");
    }
  });

  app.post("/api/jobs/:id/start", async (request, response) => {
    try {
      const job = await solverJobService.start(request.params.id);
      response.json({ job, events: solverJobService.getJob(job.id).events });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_start_failed");
    }
  });

  app.post("/api/jobs/:id/stop", async (request, response) => {
    try {
      const job = await solverJobService.stop(request.params.id);
      response.json({ job, events: solverJobService.getJob(job.id).events });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_stop_failed");
    }
  });

  app.post("/api/jobs/:id/force-stop", async (request, response) => {
    try {
      const job = await solverJobService.forceStop(request.params.id);
      response.json({ job, events: solverJobService.getJob(job.id).events });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_force_stop_failed");
    }
  });

  app.post("/api/jobs/:id/resume", async (request, response) => {
    try {
      const job = await solverJobService.resume(request.params.id);
      response.json({ job, events: solverJobService.getJob(job.id).events });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_resume_failed");
    }
  });

  app.post("/api/jobs/:id/switch", async (request, response) => {
    try {
      const job = await solverJobService.switchTo(request.params.id);
      response.json({ job, events: solverJobService.getJob(job.id).events });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_switch_failed");
    }
  });

  app.post("/api/jobs/:id/cancel", (request, response) => {
    try {
      const job = solverJobService.cancel(request.params.id);
      response.json({ job, events: solverJobService.getJob(job.id).events });
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_cancel_failed");
    }
  });

  app.post("/api/jobs/:id/delete", (request, response) => {
    try {
      response.json(solverJobService.deleteJob(request.params.id));
    } catch (error) {
      respondSolverJobError(response, error, "solver_job_delete_failed");
    }
  });

  app.get("/api/parallel-jobs", async (request, response) => {
    try {
      const shouldReconcile = request.query.reconcile === "1" || request.query.reconcile === "true";
      response.json(shouldReconcile ? solverJobService.refreshParallelJobs() : solverJobService.readParallelJobs());
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_jobs_list_failed");
    }
  });

  app.post("/api/parallel-jobs/preview", async (request, response) => {
    if (!isParallelSolverJobPreviewRequest(request.body)) {
      response.status(400).json({ error: "invalid_parallel_solver_job_preview" });
      return;
    }

    try {
      response.json(await solverJobService.previewParallel(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_job_preview_failed");
    }
  });

  app.post("/api/parallel-jobs", async (request, response) => {
    if (!isParallelSolverJobCreateRequest(request.body)) {
      response.status(400).json({ error: "invalid_parallel_solver_job" });
      return;
    }

    try {
      const run = await solverJobService.createParallel(request.body);
      response.status(201).json({ run, ...solverJobService.listParallelJobs() });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_job_create_failed");
    }
  });

  app.post("/api/parallel-jobs/reorder", (request, response) => {
    if (!isParallelSolverQueueReorderRequest(request.body)) {
      response.status(400).json({ error: "invalid_parallel_solver_queue_reorder" });
      return;
    }

    try {
      const runs = solverJobService.reorderParallelQueue(request.body.runIds);
      response.json({ runs, failurePool: solverJobService.listParallelJobs().failurePool });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_queue_reorder_failed");
    }
  });

  app.delete("/api/parallel-jobs/reports", (_request, response) => {
    try {
      const cleared = solverJobService.clearParallelReports();
      response.json({ ...cleared, ...solverJobService.listParallelJobs() });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_reports_clear_failed");
    }
  });

  app.delete("/api/parallel-jobs/failure-pool", (_request, response) => {
    try {
      const cleared = solverJobService.clearFailurePool();
      response.json({ ...cleared, ...solverJobService.listParallelJobs() });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_failure_pool_clear_failed");
    }
  });

  app.get("/api/parallel-jobs/:id", (request, response) => {
    try {
      response.json({ run: solverJobService.getParallelRun(request.params.id) });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_job_read_failed");
    }
  });

  app.post("/api/parallel-jobs/:id/cancel", async (request, response) => {
    try {
      response.json({ run: await solverJobService.cancelParallelRun(request.params.id), ...solverJobService.listParallelJobs() });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_job_cancel_failed");
    }
  });

  app.delete("/api/parallel-jobs/:id", (request, response) => {
    try {
      response.json({ ...solverJobService.deleteQueuedParallelRun(request.params.id), ...solverJobService.listParallelJobs() });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_solver_job_delete_failed");
    }
  });

  app.post("/api/parallel-jobs/failure-pool/preview", async (request, response) => {
    if (!isParallelFailurePoolPreviewRequest(request.body)) {
      response.status(400).json({ error: "invalid_parallel_failure_pool_preview" });
      return;
    }

    try {
      response.json(await solverJobService.previewFailurePool(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "parallel_failure_pool_preview_failed");
    }
  });

  app.post("/api/parallel-jobs/failure-pool/submit", async (request, response) => {
    if (!isParallelFailurePoolSubmitRequest(request.body)) {
      response.status(400).json({ error: "invalid_parallel_failure_pool_submit" });
      return;
    }

    try {
      const run = await solverJobService.submitFailurePool(request.body);
      response.status(201).json({ run, ...solverJobService.listParallelJobs() });
    } catch (error) {
      respondSolverJobError(response, error, "parallel_failure_pool_submit_failed");
    }
  });

  app.get("/api/server-operations", async (_request, response) => {
    try {
      response.json(await solverJobService.listServerOperations());
    } catch (error) {
      respondSolverJobError(response, error, "server_operations_list_failed");
    }
  });

  app.post("/api/server-operations/sync", async (request, response) => {
    if (!isServerSyncRequest(request.body)) {
      response.status(400).json({ error: "invalid_server_sync_operation" });
      return;
    }

    try {
      response.status(201).json(await solverJobService.startSyncOperations(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "server_sync_operation_failed");
    }
  });

  app.post("/api/server-operations/network-sync", async (request, response) => {
    if (!isServerNetworkSyncRequest(request.body)) {
      response.status(400).json({ error: "invalid_server_network_sync_operation" });
      return;
    }

    try {
      response.status(201).json(await solverJobService.startNetworkSyncOperations(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "server_network_sync_operation_failed");
    }
  });

  app.post("/api/server-operations/network-check", async (request, response) => {
    if (!isServerNetworkCheckRequest(request.body)) {
      response.status(400).json({ error: "invalid_server_network_check_operation" });
      return;
    }

    try {
      response.status(201).json(await solverJobService.startNetworkCheckOperations(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "server_network_check_operation_failed");
    }
  });

  app.get("/api/server-operations/upload-candidates", async (request, response) => {
    const serverId = typeof request.query.serverId === "string" ? request.query.serverId.trim() : "";
    try {
      response.json(serverId
        ? await solverJobService.scanUploadCandidates(serverId)
        : await solverJobService.scanAllUploadCandidates()
      );
    } catch (error) {
      respondSolverJobError(response, error, "server_upload_candidates_failed");
    }
  });

  app.post("/api/server-operations/upload", async (request, response) => {
    if (!isServerUploadRequest(request.body)) {
      response.status(400).json({ error: "invalid_server_upload_operation" });
      return;
    }

    try {
      response.status(201).json(await solverJobService.startUploadOperation(request.body));
    } catch (error) {
      respondSolverJobError(response, error, "server_upload_operation_failed");
    }
  });

  app.post("/api/server-operations/:id/stop", async (request, response) => {
    try {
      response.json(await solverJobService.stopServerOperation(request.params.id));
    } catch (error) {
      respondSolverJobError(response, error, "server_operation_stop_failed");
    }
  });

  app.post("/api/server-operations/:id/retry", async (request, response) => {
    try {
      response.status(201).json(await solverJobService.retryServerOperation(request.params.id));
    } catch (error) {
      respondSolverJobError(response, error, "server_operation_retry_failed");
    }
  });

  app.delete("/api/server-operations/reports", (_request, response) => {
    try {
      response.json({ ...solverJobService.clearServerOperationReports() });
    } catch (error) {
      respondSolverJobError(response, error, "server_operation_reports_clear_failed");
    }
  });

  app.get("/api/settings/alerts", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json({
      settings,
      status: alertStatus(settings),
      hfProxy: hfProxyStatus(settings, hfProxyUrl, solverHfProxyUrl)
    });
  });

  app.patch("/api/settings/alerts", (request, response) => {
    if (!isAlertSettingsInput(request.body)) {
      response.status(400).json({ error: "invalid_alert_settings" });
      return;
    }

    try {
      const settings = saveAlertSettings(alertSettingsPath, request.body);
      refreshService.updateScheduleInterval(alertRefreshIntervalMs(settings, defaultRefreshIntervalMs));
      if (settings.enabled) {
        void Promise.resolve(startAlertConnector?.()).catch((error: unknown) => {
          console.error("Alert connector startup failed", error);
        });
      }
      response.json({
        settings,
        status: alertStatus(settings),
        hfProxy: hfProxyStatus(settings, hfProxyUrl, solverHfProxyUrl)
      });
    } catch (error) {
      response.status(400).json({
        error: "invalid_alert_settings",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/alerts/test", async (request, response) => {
    if (!isAlertSettingsInput(request.body)) {
      response.status(400).json({ error: "invalid_alert_settings" });
      return;
    }

    try {
      const settings = saveAlertSettings(alertSettingsPath, request.body);
      const targets = enabledAlertTargets(settings);
      if (!settings.enabled || targets.length === 0) {
        response.status(400).json({ error: "alert_not_configured" });
        return;
      }

      await sendTestAlertToTargets(sendTestAlert, formatTestAlertMessage(settings.language), targets);
      response.status(202).json({
        accepted: true,
        recipientCount: targets.length,
        targetCount: targets.length,
        status: alertStatus(settings),
        hfProxy: hfProxyStatus(settings, hfProxyUrl, solverHfProxyUrl),
        wechat: getWeChatStatus?.() ?? defaultWeChatStatus(settings.wechatRoomId),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      response.status(500).json({
        error: "alert_test_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/settings/wechat", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json(getWeChatStatus?.() ?? defaultWeChatStatus(settings.enabled ? settings.wechatRoomId : ""));
  });

  app.get("/api/settings/wechat/accounts", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json(getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings));
  });

  app.post("/api/settings/wechat/accounts", async (request, response) => {
    if (!createWeChatAccount) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }
    if (!isRecord(request.body) && request.body != null) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }

    try {
      const label = isRecord(request.body) && typeof request.body.label === "string"
        ? request.body.label
        : undefined;
      const account = await Promise.resolve(createWeChatAccount(label));
      const settings = loadAlertSettings(alertSettingsPath);
      response.status(201).json({
        account,
        settings,
        status: alertStatus(settings),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      response.status(500).json({
        error: "wechat_account_create_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.patch("/api/settings/wechat/accounts/:accountId", async (request, response) => {
    if (!updateWeChatAccount) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }

    const patch: { label?: string; enabled?: boolean } = {};
    if (request.body.label != null) {
      if (typeof request.body.label !== "string") {
        response.status(400).json({ error: "invalid_wechat_account", message: "label must be a string" });
        return;
      }
      patch.label = request.body.label;
    }
    if (request.body.enabled != null) {
      if (typeof request.body.enabled !== "boolean") {
        response.status(400).json({ error: "invalid_wechat_account", message: "enabled must be a boolean" });
        return;
      }
      patch.enabled = request.body.enabled;
    }

    try {
      const account = await Promise.resolve(updateWeChatAccount(request.params.accountId, patch));
      const settings = loadAlertSettings(alertSettingsPath);
      response.json({
        account,
        settings,
        status: alertStatus(settings),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      respondWeChatAccountError(response, error, "wechat_account_update_failed");
    }
  });

  app.delete("/api/settings/wechat/accounts/:accountId", async (request, response) => {
    if (!removeWeChatAccount) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }

    try {
      const wechatAccounts = await Promise.resolve(removeWeChatAccount(request.params.accountId));
      const settings = loadAlertSettings(alertSettingsPath);
      response.json({
        settings,
        status: alertStatus(settings),
        wechatAccounts
      });
    } catch (error) {
      respondWeChatAccountError(response, error, "wechat_account_delete_failed");
    }
  });

  app.post("/api/settings/wechat/accounts/:accountId/qr/refresh", async (request, response) => {
    if (!refreshWeChatAccountQr) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }

    try {
      const account = await Promise.resolve(refreshWeChatAccountQr(request.params.accountId));
      response.status(202).json({
        accepted: true,
        account,
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(loadAlertSettings(alertSettingsPath))
      });
    } catch (error) {
      respondWeChatAccountError(response, error, "wechat_qr_refresh_failed");
    }
  });

  app.post("/api/settings/wechat/accounts/:accountId/restore", async (request, response) => {
    if (!restoreWeChatAccount) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }

    try {
      const account = await Promise.resolve(restoreWeChatAccount(request.params.accountId));
      response.json({
        account,
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(loadAlertSettings(alertSettingsPath))
      });
    } catch (error) {
      respondWeChatAccountError(response, error, "wechat_restore_failed");
    }
  });

  app.post("/api/settings/wechat/accounts/:accountId/logout", async (request, response) => {
    if (!logoutWeChatAccount) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }

    try {
      const account = await Promise.resolve(logoutWeChatAccount(request.params.accountId));
      const settings = loadAlertSettings(alertSettingsPath);
      response.json({
        account,
        settings,
        status: alertStatus(settings),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      respondWeChatAccountError(response, error, "wechat_logout_failed");
    }
  });

  app.post("/api/settings/wechat/accounts/:accountId/verify", async (request, response) => {
    if (!verifyWeChatAccount) {
      response.status(501).json({ error: "wechat_accounts_unavailable" });
      return;
    }
    if (!isRecord(request.body) && request.body != null) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }

    try {
      const targetUserId = isRecord(request.body) && typeof request.body.targetUserId === "string"
        ? request.body.targetUserId
        : undefined;
      const account = await Promise.resolve(verifyWeChatAccount(request.params.accountId, targetUserId));
      const settings = loadAlertSettings(alertSettingsPath);
      response.json({
        account,
        settings,
        status: alertStatus(settings),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      respondWeChatAccountError(response, error, "wechat_account_verify_failed");
    }
  });

  app.post("/api/settings/wechat/start", (_request, response) => {
    void Promise.resolve(restartAlertConnector?.() ?? startAlertConnector?.()).catch((error: unknown) => {
      console.error("WeChat connector startup failed", error);
    });
    response.status(202).json({ accepted: true });
  });

  app.post("/api/settings/wechat/qr/refresh", (_request, response) => {
    void Promise.resolve(refreshWeChatConnector?.() ?? restartAlertConnector?.() ?? startAlertConnector?.()).catch((error: unknown) => {
      console.error("WeChat QR refresh failed", error);
    });
    response.status(202).json({ accepted: true });
  });

  app.post("/api/settings/wechat/restore", async (_request, response) => {
    try {
      await Promise.resolve(restoreAlertConnector?.());
      const settings = loadAlertSettings(alertSettingsPath);
      response.json(getWeChatStatus?.() ?? defaultWeChatStatus(settings.enabled ? settings.wechatRoomId : ""));
    } catch (error) {
      response.status(500).json({
        error: "wechat_restore_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/wechat/logout", async (_request, response) => {
    try {
      await Promise.resolve(logoutWeChatConnector?.());
      const settings = loadAlertSettings(alertSettingsPath);
      response.json(getWeChatStatus?.() ?? defaultWeChatStatus(settings.enabled ? settings.wechatRoomId : ""));
    } catch (error) {
      response.status(500).json({
        error: "wechat_logout_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/wechat/switch", (_request, response) => {
    void Promise.resolve(switchWeChatConnector?.()).catch((error: unknown) => {
      console.error("WeChat account switch failed", error);
    });
    response.status(202).json({ accepted: true });
  });

  // ── Recipient management ──────────────────────────────────────

  app.get("/api/settings/alerts/recipients", (_request, response) => {
    const settings = loadAlertSettings(alertSettingsPath);
    response.json({ recipients: settings.wechatRecipients });
  });

  app.post("/api/settings/alerts/recipients", (request, response) => {
    if (!isRecord(request.body) ||
        typeof request.body.contactId !== "string" ||
        request.body.contactId.trim() === "") {
      response.status(400).json({ error: "invalid_recipient", message: "contactId is required" });
      return;
    }

    try {
      const wechat = getWeChatStatus?.();
      if (wechat && !wechat.loggedIn) {
        response.status(409).json({ error: "wechat_login_required", message: "Log in the WeChat bot before adding recipients" });
        return;
      }

      const settings = loadAlertSettings(alertSettingsPath);
      const contactId = (request.body.contactId as string).trim();
      const label = typeof request.body.label === "string" ? request.body.label.trim() : contactId;

      // Check for duplicate contactId
      if (settings.wechatRecipients.some((r) => r.contactId === contactId)) {
        response.status(409).json({ error: "duplicate_recipient", message: `Recipient ${contactId} already exists` });
        return;
      }

      const newRecipient: WeChatRecipient = {
        id: randomUUID(),
        contactId,
        label: label || contactId,
        enabled: true,
        addedAt: new Date().toISOString()
      };

      settings.wechatRecipients.push(newRecipient);
      // Sync legacy field
      const firstEnabled = settings.wechatRecipients.find((r) => r.enabled);
      settings.wechatRoomId = firstEnabled?.contactId ?? "";

      const saved = saveAlertSettings(alertSettingsPath, settings);
      response.status(201).json({ recipient: newRecipient, settings: saved, status: alertStatus(saved) });
    } catch (error) {
      response.status(500).json({
        error: "recipient_add_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.patch("/api/settings/alerts/recipients/:id", (request, response) => {
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }

    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const recipient = settings.wechatRecipients.find((r) => r.id === request.params.id);
      if (!recipient) {
        response.status(404).json({ error: "recipient_not_found" });
        return;
      }

      if (typeof request.body.enabled === "boolean") {
        recipient.enabled = request.body.enabled;
      }
      if (request.body.contactId != null) {
        if (typeof request.body.contactId !== "string" || request.body.contactId.trim() === "") {
          response.status(400).json({ error: "invalid_recipient", message: "contactId must be a non-empty string" });
          return;
        }

        const nextContactId = request.body.contactId.trim();
        const duplicate = settings.wechatRecipients.some((r) =>
          r.id !== recipient.id && r.contactId === nextContactId
        );
        if (duplicate) {
          response.status(409).json({ error: "duplicate_recipient", message: `Recipient ${nextContactId} already exists` });
          return;
        }

        const previousContactId = recipient.contactId;
        recipient.contactId = nextContactId;
        if (recipient.label === previousContactId && typeof request.body.label !== "string") {
          recipient.label = nextContactId;
        }
      }
      if (typeof request.body.label === "string") {
        recipient.label = request.body.label.trim() || recipient.contactId;
      }

      // Sync legacy field
      const firstEnabled = settings.wechatRecipients.find((r) => r.enabled);
      settings.wechatRoomId = firstEnabled?.contactId ?? "";

      const saved = saveAlertSettings(alertSettingsPath, settings);
      response.json({
        recipient: saved.wechatRecipients.find((r) => r.id === recipient.id) ?? recipient,
        settings: saved,
        status: alertStatus(saved)
      });
    } catch (error) {
      response.status(500).json({
        error: "recipient_update_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.delete("/api/settings/alerts/recipients/:id", (request, response) => {
    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const index = settings.wechatRecipients.findIndex((r) => r.id === request.params.id);
      if (index === -1) {
        response.status(404).json({ error: "recipient_not_found" });
        return;
      }

      settings.wechatRecipients.splice(index, 1);
      // Sync legacy field
      const firstEnabled = settings.wechatRecipients.find((r) => r.enabled);
      settings.wechatRoomId = firstEnabled?.contactId ?? "";

      const saved = saveAlertSettings(alertSettingsPath, settings);
      response.json({ settings: saved, status: alertStatus(saved) });
    } catch (error) {
      response.status(500).json({
        error: "recipient_delete_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/alerts/test/account/:accountId", async (request, response) => {
    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const target = findAlertTarget(settings, request.params.accountId);
      if (!target || target.kind !== "wechat-account") {
        response.status(404).json({ error: "wechat_account_not_found" });
        return;
      }

      await sendTestAlert?.(formatTestAlertMessage(settings.language), target.targetId);
      response.status(202).json({
        accepted: true,
        accountId: target.id,
        status: alertStatus(settings),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      response.status(500).json({
        error: "alert_test_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/settings/alerts/test/:recipientId", async (request, response) => {
    try {
      const settings = loadAlertSettings(alertSettingsPath);
      const target = findAlertTarget(settings, request.params.recipientId);
      if (!target) {
        response.status(404).json({ error: "recipient_not_found" });
        return;
      }

      await sendTestAlert?.(formatTestAlertMessage(settings.language), target.targetId);
      response.status(202).json({
        accepted: true,
        recipientId: target.id,
        status: alertStatus(settings),
        wechat: getWeChatStatus?.() ?? defaultWeChatStatus(target.targetId),
        wechatAccounts: getWeChatAccountsStatus?.() ?? defaultWeChatAccountsStatus(settings)
      });
    } catch (error) {
      response.status(500).json({
        error: "alert_test_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/servers/:id/history", (request, response) => {
    const server = db.getServer(request.params.id);
    if (!server) {
      response.status(404).json({ error: "server_not_found" });
      return;
    }
    const hours = Number(request.query.hours ?? 24);
    const body: ServerDetailResponse = {
      server,
      latest: db.getLatestSnapshot(server.id),
      pipeline: db.getLatestPipelineSnapshot(server.id),
      pipelineHistory: db.getPipelineHistory(server.id, Number.isFinite(hours) ? hours : 24),
      history: db.getServerHistory(server.id, Number.isFinite(hours) ? hours : 24)
    };
    response.json(body);
  });

  app.post("/api/refresh", async (_request, response) => {
    const current = refreshService.getState();
    if (current.active) {
      response.status(409).json({
        accepted: false,
        code: "refresh_in_progress",
        message: "A refresh is already running.",
        state: current
      });
      return;
    }
    void refreshService.refreshAll("manual").catch((error: unknown) => {
      console.error("Manual refresh failed", error);
    });
    response.status(202).json({ accepted: true, state: refreshService.getState() });
  });

  app.get("/api/refresh/current", (_request, response) => {
    response.json(refreshService.getState());
  });

  return app;
}

function buildSummary(servers: ReturnType<MonitorDatabase["getServerRows"]>): OverviewSummary {
  const latest = servers.map((server) => server.latest);
  const onlineSnapshots = latest.filter((s) => s?.connectionStatus === "online");
  const onlineServerIds = new Set(
    servers.filter((server) => server.latest?.connectionStatus === "online").map((server) => server.id)
  );
  const onlinePipelines = servers
    .filter((server) => onlineServerIds.has(server.id))
    .map((server) => server.pipeline);

  return {
    total: servers.length,
    // Connectivity
    online: onlineSnapshots.length,
    offline: latest.filter((s) => s?.connectionStatus === "offline").length,
    unknown: latest.filter((s) => !s || s.connectionStatus === "unknown").length,
    // Health (among online servers)
    healthy: onlineSnapshots.filter((s) => s?.healthLevel === "healthy").length,
    warning: onlineSnapshots.filter((s) => s?.healthLevel === "warning").length,
    dangerous: onlineSnapshots.filter((s) => s?.healthLevel === "dangerous").length,
    // Averages (among online servers)
    averageCpu: average(onlineSnapshots.map((s) => s?.cpuUsedPercent ?? null)),
    averageMemory: average(onlineSnapshots.map((s) => s?.memoryUsedPercent ?? null)),
    averageDisk: average(onlineSnapshots.map((s) => s?.diskUsedPercent ?? null)),
    pipelineRunning: onlinePipelines.filter((pipeline) =>
      pipeline != null &&
      (pipeline.displayStatus === "running" ||
        pipeline.displayStatus === "solving" ||
        pipeline.displayStatus === "uploading" ||
        pipeline.displayStatus === "cleanup")
    ).length,
    pipelineIdle: onlinePipelines.filter((pipeline) => pipeline?.displayStatus === "idle").length,
    pipelineStale: onlinePipelines.filter((pipeline) => pipeline?.displayStatus === "stale").length
  };
}

function serverCreateInputFromBody(body: Record<string, unknown>): ServerInventoryCreateInput {
  return {
    host: body.host as string,
    port: body.port as number | undefined,
    group: body.group as string | null | undefined,
    enabled: body.enabled as boolean | undefined,
    note: body.note as string | undefined,
    solverRoot: body.solverRoot as string | null | undefined,
    tmuxSession: body.tmuxSession as string | null | undefined,
    pipelineStatusFilePath: body.pipelineStatusFilePath as string | null | undefined
  };
}

function serverUpdateInputFromBody(body: Record<string, unknown>): ServerInventoryUpdateInput {
  const patch: ServerInventoryUpdateInput = {};
  if ("host" in body) patch.host = body.host as string;
  if ("port" in body) patch.port = body.port as number;
  if ("group" in body) patch.group = body.group as string | null;
  if ("enabled" in body) patch.enabled = body.enabled as boolean;
  if ("note" in body) patch.note = body.note as string;
  if ("solverRoot" in body) patch.solverRoot = body.solverRoot as string | null;
  if ("tmuxSession" in body) patch.tmuxSession = body.tmuxSession as string | null;
  if ("pipelineStatusFilePath" in body) patch.pipelineStatusFilePath = body.pipelineStatusFilePath as string | null;
  return patch;
}

function syncServerInventory(
  db: MonitorDatabase,
  refreshService: RefreshService,
  inventoryPath: string
): ServerConfig[] {
  const servers = loadServerInventory(inventoryPath);
  db.syncServers(servers);
  refreshService.updateServers(servers);
  return servers;
}

function describeOverview(summary: OverviewSummary): string {
  const connectivity = `${summary.online} of ${summary.total} servers online`;
  const healthIssues: string[] = [];
  if (summary.warning > 0) healthIssues.push(`${summary.warning} warning`);
  if (summary.dangerous > 0) healthIssues.push(`${summary.dangerous} dangerous`);
  const health = healthIssues.length > 0 ? healthIssues.join(", ") : "all healthy";
  const offline = summary.offline > 0 ? `${summary.offline} offline` : "none offline";
  const pipelineParts: string[] = [];
  if (summary.pipelineRunning > 0) pipelineParts.push(`${summary.pipelineRunning} task running`);
  if (summary.pipelineStale > 0) pipelineParts.push(`${summary.pipelineStale} stale task`);
  const pipeline = pipelineParts.length > 0 ? pipelineParts.join(", ") : "no active tasks";
  return `${connectivity}; ${health}; ${offline}; ${pipeline}.`;
}

function average(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAlertSettingsInput(value: unknown): value is AlertSettings {
  if (!isRecord(value)) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (typeof value.cooldownMinutes !== "number" || !Number.isFinite(value.cooldownMinutes)) return false;
  if (value.language !== "en" && value.language !== "zh") return false;
  if (
    value.sshCommandTimeoutSeconds != null &&
    (typeof value.sshCommandTimeoutSeconds !== "number" || !Number.isFinite(value.sshCommandTimeoutSeconds))
  ) {
    return false;
  }
  if (
    value.sshConnectTimeoutSeconds != null &&
    (typeof value.sshConnectTimeoutSeconds !== "number" || !Number.isFinite(value.sshConnectTimeoutSeconds))
  ) {
    return false;
  }
  if (value.hfProxyEnabled != null && typeof value.hfProxyEnabled !== "boolean") return false;
  if (value.solverHfProxyEnabled != null && typeof value.solverHfProxyEnabled !== "boolean") return false;
  // wechatRoomId is optional now (derived from recipients), but accept it for backward compat
  if (value.wechatRoomId != null && typeof value.wechatRoomId !== "string") return false;
  // wechatRecipients is optional in input (config normalizer handles it)
  if (value.wechatRecipients != null && !Array.isArray(value.wechatRecipients)) return false;
  // wechatAccounts is optional in input (config normalizer handles it)
  if (value.wechatAccounts != null && !Array.isArray(value.wechatAccounts)) return false;
  return true;
}

function isSolverJobPreviewRequest(value: unknown): value is SolverJobPreviewRequest {
  if (!isRecord(value)) return false;
  if (typeof value.serverId !== "string" || value.serverId.trim() === "") return false;
  if (typeof value.rangePath !== "string" || value.rangePath.trim() === "") return false;
  if (
    value.scenario != null &&
    (
      typeof value.scenario !== "string" ||
      value.scenario.trim() === ""
    )
  ) {
    return false;
  }
  if (value.settings != null && !isRecord(value.settings)) return false;
  if (value.datasetName != null && typeof value.datasetName !== "string") return false;
  if (value.confirmUnstudied != null && typeof value.confirmUnstudied !== "boolean") return false;
  return true;
}

function isSolverDatasetRepoEnsureRequest(value: unknown): value is SolverDatasetRepoEnsureRequest {
  if (!isSolverJobPreviewRequest(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.confirmDatasetName != null && typeof candidate.confirmDatasetName !== "boolean") return false;
  return true;
}

function isSolverJobCreateRequest(value: unknown): value is SolverJobCreateRequest {
  if (!isSolverJobPreviewRequest(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.confirmDatasetName != null && typeof candidate.confirmDatasetName !== "boolean") return false;
  if (
    candidate.queueMode != null &&
    (
      typeof candidate.queueMode !== "string" ||
      !(SOLVER_JOB_QUEUE_MODES as readonly string[]).includes(candidate.queueMode)
    )
  ) {
    return false;
  }
  return true;
}

function isParallelSolverJobPreviewRequest(value: unknown): value is ParallelSolverJobPreviewRequest {
  if (!isRecord(value)) return false;
  if (typeof value.rangePath !== "string" || value.rangePath.trim() === "") return false;
  if (
    value.scenario != null &&
    (typeof value.scenario !== "string" || value.scenario.trim() === "")
  ) {
    return false;
  }
  if (value.datasetName != null && typeof value.datasetName !== "string") return false;
  if (value.settings != null && !isRecord(value.settings)) return false;
  if (value.confirmUnstudied != null && typeof value.confirmUnstudied !== "boolean") return false;
  if (value.chunkCount != null && (typeof value.chunkCount !== "number" || !Number.isInteger(value.chunkCount) || value.chunkCount < 1)) {
    return false;
  }
  if (value.serverIds != null && (!Array.isArray(value.serverIds) || value.serverIds.some((id) => typeof id !== "string"))) {
    return false;
  }
  return true;
}

function isParallelSolverJobCreateRequest(value: unknown): value is ParallelSolverJobCreateRequest {
  if (!isParallelSolverJobPreviewRequest(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.confirmDatasetName != null && typeof candidate.confirmDatasetName !== "boolean") return false;
  if (
    candidate.queueMode != null &&
    candidate.queueMode !== "start_now" &&
    candidate.queueMode !== "queue_next"
  ) {
    return false;
  }
  return true;
}

function isParallelFailurePoolPreviewRequest(value: unknown): value is ParallelFailurePoolPreviewRequest {
  if (!isParallelSolverJobPreviewRequest(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.indices != null && (!Array.isArray(candidate.indices) || candidate.indices.some((index) => typeof index !== "number"))) {
    return false;
  }
  if (candidate.bestServerId != null && typeof candidate.bestServerId !== "string") {
    return false;
  }
  return true;
}

function isParallelFailurePoolSubmitRequest(value: unknown): value is ParallelFailurePoolSubmitRequest {
  if (!isParallelFailurePoolPreviewRequest(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.confirmDatasetName != null && typeof candidate.confirmDatasetName !== "boolean") return false;
  if (
    candidate.queueMode != null &&
    candidate.queueMode !== "start_now" &&
    candidate.queueMode !== "queue_next"
  ) {
    return false;
  }
  return true;
}

function isParallelSolverQueueReorderRequest(value: unknown): value is ParallelSolverQueueReorderRequest {
  if (!isRecord(value)) return false;
  return Array.isArray(value.runIds) && value.runIds.every((id) => typeof id === "string" && id.trim() !== "");
}

function isServerSyncRequest(value: unknown): value is ServerSyncRequest {
  if (!isRecord(value)) return false;
  return value.serverIds == null || (
    Array.isArray(value.serverIds) &&
    value.serverIds.every((id) => typeof id === "string" && id.trim() !== "")
  );
}

function isServerNetworkSyncRequest(value: unknown): value is ServerNetworkSyncRequest {
  return isServerSyncRequest(value);
}

function isServerNetworkCheckRequest(value: unknown): value is ServerNetworkCheckRequest {
  return isServerSyncRequest(value);
}

function isServerUploadRequest(value: unknown): value is ServerUploadRequest {
  if (!isRecord(value)) return false;
  if (value.serverId != null && typeof value.serverId !== "string") return false;
  if (value.serverIds != null && (
    !Array.isArray(value.serverIds) ||
    !value.serverIds.every((id) => typeof id === "string" && id.trim() !== "")
  )) return false;
  if (value.items == null) return true;
  if (!Array.isArray(value.items)) return false;
  return value.items.every((item) => {
    if (!isRecord(item)) return false;
    return (
      (item.serverId == null || typeof item.serverId === "string") &&
      typeof item.datasetName === "string" &&
      typeof item.repoId === "string" &&
      typeof item.resultsDir === "string" &&
      (item.fileFormat === "json" || item.fileFormat === "parquet") &&
      (item.jobId == null || typeof item.jobId === "string") &&
      (item.fileCount == null || typeof item.fileCount === "number")
    );
  });
}

function alertStatus(settings: AlertSettings): { enabled: boolean; configured: boolean } {
  return {
    enabled: settings.enabled,
    configured: enabledAlertTargets(settings).length > 0
  };
}

function hfProxyStatus(
  settings: AlertSettings,
  hfProxyUrl: string | null,
  solverHfProxyUrl: string | null
): HfProxyRuntimeStatus {
  const serverMonitorConfigured = Boolean(hfProxyUrl?.trim());
  const solverConfigured = Boolean(solverHfProxyUrl?.trim());
  return {
    serverMonitor: {
      configured: serverMonitorConfigured,
      enabled: serverMonitorConfigured && settings.hfProxyEnabled
    },
    solver: {
      configured: solverConfigured,
      enabled: solverConfigured && settings.solverHfProxyEnabled
    }
  };
}

async function sendTestAlertToTargets(
  sendTestAlert: AppDependencies["sendTestAlert"],
  message: string,
  targets: AlertDeliveryTarget[]
): Promise<void> {
  const failures: string[] = [];

  for (const target of targets) {
    try {
      await sendTestAlert?.(message, target.targetId);
    } catch (error) {
      failures.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to send test alert to ${failures.length} recipient(s): ${failures.join("; ")}`);
  }
}

function defaultWeChatStatus(alertTargetUserId = ""): WeChatConnectorStatus {
  const configuredTarget = alertTargetUserId.trim();
  return {
    started: false,
    loggedIn: false,
    polling: false,
    ready: false,
    qrUrl: null,
    awaitingQr: false,
    botUserId: null,
    storedSession: defaultWeChatStoredSession(),
    lastError: null,
    messageCount: 0,
    lastMessageAt: null,
    recentChats: [],
    target: configuredTarget
      ? {
          userId: configuredTarget,
          lastInboundAt: null,
          lastSendSuccessAt: null,
          lastSendFailureAt: null,
          lastSendFailureCode: null
        }
      : null,
    delivery: buildWeChatDelivery({
      alertsConfigured: configuredTarget.length > 0,
      started: false,
      loggedIn: false,
      polling: false,
      ready: false,
      qrUrl: null,
      awaitingQr: false,
      lastError: null,
      target: configuredTarget
        ? {
            userId: configuredTarget,
            lastInboundAt: null,
            lastSendSuccessAt: null,
            lastSendFailureAt: null,
            lastSendFailureCode: null
          }
        : null
    })
  };
}

function defaultWeChatAccountsStatus(settings: AlertSettings): WeChatAccountsStatus {
  const accounts = settings.wechatAccounts.map((account): WeChatAccountConnectorStatus => {
    const connector = defaultWeChatStatus(account.alertTargetUserId ?? "");
    return {
      ...account,
      storageDir: "",
      verified: Boolean(account.alertTargetUserId),
      connector
    };
  });

  return {
    accounts,
    activeLoginAccountId: null,
    enabledCount: accounts.filter((account) => account.enabled).length,
    verifiedCount: accounts.filter((account) => account.enabled && account.verified).length
  };
}

function respondWeChatAccountError(
  response: express.Response,
  error: unknown,
  code: string
): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message)
    ? 404
    : /already configured|duplicate/i.test(message)
      ? 409
      : /must be|No inbound|not verified|no cached context/i.test(message)
        ? 400
      : 500;
  response.status(status).json({ error: code, message });
}

function respondPreflopRangeError(
  response: express.Response,
  error: unknown,
  code: string
): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /does not exist|not found/i.test(message)
    ? 404
    : /must be|required|invalid|outside|only range|cannot be moved|too many/i.test(message)
      ? 400
      : 500;
  response.status(status).json({ error: code, message });
}

function respondSolverJobError(
  response: express.Response,
  error: unknown,
  code: string
): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found|does not exist/i.test(message)
    ? 404
      : /already has active|must be stopped|must be canceled|confirmation is required|must be approved|dataset repo is missing|online server|is offline|is unknown|only queued/i.test(message)
      ? 409
      : /missing|must have|required|invalid|outside|not marked studied/i.test(message)
        ? 400
        : 500;
  response.status(status).json({ error: code, message });
}

function respondScenarioLibraryError(
  response: express.Response,
  error: unknown,
  code: string
): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message)
    ? 404
    : /already exists|duplicate/i.test(message)
      ? 409
      : /required|must|invalid/i.test(message)
        ? 400
        : 500;
  response.status(status).json({ error: code, message });
}
