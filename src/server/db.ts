import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  ConnectionStatus,
  HealthLevel,
  MetricSnapshot,
  PipelineStatusSnapshot,
  RefreshRun,
  ServerConfig,
  ServerRow
} from "../shared/types";
import type {
  ParallelFailurePoolEntry,
  ParallelFailureReason,
  ParallelFailurePoolStatus,
  ParallelSolverRun,
  ParallelSolverRunStatus,
  ParallelSolverSlice,
  ParallelSolverSliceStatus,
  SolverJob,
  SolverJobEvent,
  SolverJobSettings,
  SolverJobStatus
} from "../shared/solverJobs";
import type {
  ServerOperation,
  ServerOperationEvent,
  ServerOperationItem,
  ServerOperationResult,
  ServerOperationStatus,
  ServerOperationType
} from "../shared/serverOperations";

let sqlPromise: Promise<SqlJsStatic> | null = null;

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: () => path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm")
  });
  return sqlPromise;
}

type SqlValue = string | number | null;

export class MonitorDatabase {
  private constructor(
    private readonly database: Database,
    private readonly filename: string | null
  ) {
    this.initializeSchema();
  }

  static async createInMemory(): Promise<MonitorDatabase> {
    const SQL = await getSql();
    return new MonitorDatabase(new SQL.Database(), null);
  }

  static async open(filename: string): Promise<MonitorDatabase> {
    const SQL = await getSql();
    const existing = fs.existsSync(filename) ? fs.readFileSync(filename) : undefined;
    return new MonitorDatabase(new SQL.Database(existing), filename);
  }

  close(): void {
    this.persist();
    this.database.close();
  }

  syncServers(servers: ServerConfig[]): void {
    this.removeServersMissingFromInventory(servers.map((server) => server.id));

    const stmt = this.database.prepare(`
      INSERT INTO servers (
        id, name, host, port, group_name, enabled, note,
        solver_root, tmux_session, pipeline_status_file_path,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM servers WHERE id = ?), ?), ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        port = excluded.port,
        group_name = excluded.group_name,
        enabled = excluded.enabled,
        note = excluded.note,
        solver_root = excluded.solver_root,
        tmux_session = excluded.tmux_session,
        pipeline_status_file_path = excluded.pipeline_status_file_path,
        updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    try {
      for (const server of servers) {
        stmt.run([
          server.id,
          server.name,
          server.host,
          server.port,
          server.group ?? null,
          server.enabled ? 1 : 0,
          server.note,
          server.solverRoot ?? null,
          server.tmuxSession ?? null,
          server.pipelineStatusFilePath ?? null,
          server.id,
          now,
          now
        ]);
      }
    } finally {
      stmt.free();
    }
    this.persist();
  }

  private removeServersMissingFromInventory(serverIds: string[]): void {
    if (serverIds.length === 0) {
      this.database.run("DELETE FROM servers");
      return;
    }

    const placeholders = serverIds.map(() => "?").join(", ");
    this.database.run(`DELETE FROM servers WHERE id NOT IN (${placeholders})`, serverIds);
  }

  getServers(): ServerConfig[] {
    return this.query<ServerConfig>(
      `SELECT
        id, name, host, port, group_name, enabled, note,
        solver_root, tmux_session, pipeline_status_file_path
      FROM servers ORDER BY name ASC`,
      [],
      mapServerConfig
    );
  }

  getServer(id: string): ServerConfig | null {
    return (
      this.query<ServerConfig>(
        `SELECT
          id, name, host, port, group_name, enabled, note,
          solver_root, tmux_session, pipeline_status_file_path
        FROM servers WHERE id = ?`,
        [id],
        mapServerConfig
      )[0] ?? null
    );
  }

  insertSnapshot(snapshot: MetricSnapshot): void {
    this.database.run(
      `INSERT INTO metric_snapshots (
        id, server_id, collected_at, connection_status, health_level,
        cpu_used_percent, memory_used_percent, disk_used_percent,
        load_1, load_5, load_15, uptime_seconds, error_code, error_message,
        cpu_model, cpu_vcores, memory_total_bytes, memory_used_bytes, disk_total_bytes, disk_used_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.serverId,
        snapshot.collectedAt,
        snapshot.connectionStatus,
        snapshot.healthLevel,
        snapshot.cpuUsedPercent,
        snapshot.memoryUsedPercent,
        snapshot.diskUsedPercent,
        snapshot.load1,
        snapshot.load5,
        snapshot.load15,
        snapshot.uptimeSeconds,
        snapshot.errorCode,
        snapshot.errorMessage,
        snapshot.cpuModel,
        snapshot.cpuVcores,
        snapshot.memoryTotalBytes,
        snapshot.memoryUsedBytes,
        snapshot.diskTotalBytes,
        snapshot.diskUsedBytes
      ]
    );
    this.persist();
  }

  getServerRows(): ServerRow[] {
    return this.getServers().map((server) => ({
      ...server,
      latest: this.getLatestSnapshot(server.id),
      pipeline: this.getLatestPipelineSnapshot(server.id),
      lastDatasetName: this.getLastDatasetName(server.id)
    }));
  }

  getLastDatasetName(serverId: string): string | null {
    return (
      this.query<string | null>(
        "SELECT last_dataset_name FROM servers WHERE id = ?",
        [serverId],
        (row) => (row.last_dataset_name == null ? null : String(row.last_dataset_name))
      )[0] ?? null
    );
  }

  updateServerLastDatasetName(serverId: string, datasetName: string): void {
    const trimmed = datasetName.trim();
    if (trimmed === "") return;

    this.database.run("UPDATE servers SET last_dataset_name = ? WHERE id = ?", [trimmed, serverId]);
    this.persist();
  }

  getLatestSnapshot(serverId: string): MetricSnapshot | null {
    return (
      this.query<MetricSnapshot>(
        "SELECT * FROM metric_snapshots WHERE server_id = ? ORDER BY collected_at DESC LIMIT 1",
        [serverId],
        mapSnapshot
      )[0] ?? null
    );
  }

  getServerHistory(serverId: string, hours: number, now = new Date().toISOString()): MetricSnapshot[] {
    const since = new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
    return this.query<MetricSnapshot>(
      "SELECT * FROM metric_snapshots WHERE server_id = ? AND collected_at >= ? ORDER BY collected_at ASC",
      [serverId, since],
      mapSnapshot
    );
  }

  pruneSnapshots(hours: number, now = new Date().toISOString()): void {
    const cutoff = new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
    this.database.run("DELETE FROM metric_snapshots WHERE collected_at < ?", [cutoff]);
    this.database.run("DELETE FROM pipeline_status_snapshots WHERE collected_at < ?", [cutoff]);
    this.persist();
  }

  insertPipelineSnapshot(snapshot: PipelineStatusSnapshot): void {
    this.database.run(
      `INSERT INTO pipeline_status_snapshots (
        id, server_id, collected_at, available, process_alive, file_status, display_status, phase,
        repo_id, dataset_name, scenario, current_batch, total_batches, total_tasks, batch_expr,
        assigned_indices_json, completed_indices_json, failed_indices_json, skipped_indices_json,
        completed_count, failed_count, skipped_count, result_path,
        pid, started_at, updated_at, finished_at, command_text, error_text, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.serverId,
        snapshot.collectedAt,
        snapshot.available ? 1 : 0,
        snapshot.processAlive == null ? null : snapshot.processAlive ? 1 : 0,
        snapshot.fileStatus,
        snapshot.displayStatus,
        snapshot.phase,
        snapshot.repoId,
        snapshot.datasetName,
        snapshot.scenario,
        snapshot.currentBatch,
        snapshot.totalBatches,
        snapshot.totalTasks,
        snapshot.batchExpr,
        JSON.stringify(snapshot.assignedIndices ?? []),
        JSON.stringify(snapshot.completedIndices ?? []),
        JSON.stringify(snapshot.failedIndices ?? []),
        JSON.stringify(snapshot.skippedIndices ?? []),
        snapshot.completedCount ?? null,
        snapshot.failedCount ?? null,
        snapshot.skippedCount ?? null,
        snapshot.resultPath ?? null,
        snapshot.pid,
        snapshot.startedAt,
        snapshot.updatedAt,
        snapshot.finishedAt,
        snapshot.command,
        snapshot.error,
        snapshot.errorCode,
        snapshot.errorMessage
      ]
    );
    this.persist();
  }

  getLatestPipelineSnapshot(serverId: string): PipelineStatusSnapshot | null {
    return (
      this.query<PipelineStatusSnapshot>(
        "SELECT * FROM pipeline_status_snapshots WHERE server_id = ? ORDER BY collected_at DESC LIMIT 1",
        [serverId],
        mapPipelineSnapshot
      )[0] ?? null
    );
  }

  getPipelineHistory(serverId: string, hours: number, now = new Date().toISOString()): PipelineStatusSnapshot[] {
    const since = new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
    return this.query<PipelineStatusSnapshot>(
      "SELECT * FROM pipeline_status_snapshots WHERE server_id = ? AND collected_at >= ? ORDER BY collected_at ASC",
      [serverId, since],
      mapPipelineSnapshot
    );
  }

  insertRefreshRun(run: RefreshRun): void {
    this.database.run(
      `INSERT INTO refresh_runs (
        id, trigger, started_at, finished_at, status, success_count, warning_count, failure_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.trigger,
        run.startedAt,
        run.finishedAt,
        run.status,
        run.successCount,
        run.warningCount,
        run.failureCount
      ]
    );
    this.persist();
  }

  getLastRefreshRun(): RefreshRun | null {
    return (
      this.query<RefreshRun>(
        "SELECT * FROM refresh_runs ORDER BY started_at DESC LIMIT 1",
        [],
        (row) => ({
          id: String(row.id),
          trigger: row.trigger as RefreshRun["trigger"],
          startedAt: String(row.started_at),
          finishedAt: row.finished_at == null ? null : String(row.finished_at),
          status: row.status as RefreshRun["status"],
          successCount: Number(row.success_count),
          warningCount: Number(row.warning_count),
          failureCount: Number(row.failure_count)
        })
      )[0] ?? null
    );
  }

  getOverallHistory(hours: number, now = new Date().toISOString()) {
    const since = new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
    return this.query(
      `SELECT
        COALESCE(refresh_runs.started_at, metric_snapshots.collected_at) AS collected_at,
        AVG(metric_snapshots.cpu_used_percent) AS average_cpu,
        AVG(metric_snapshots.memory_used_percent) AS average_memory,
        AVG(metric_snapshots.disk_used_percent) AS average_disk
      FROM metric_snapshots
      LEFT JOIN refresh_runs
        ON metric_snapshots.collected_at >= refresh_runs.started_at
        AND (
          refresh_runs.finished_at IS NULL
          OR metric_snapshots.collected_at <= refresh_runs.finished_at
        )
      WHERE metric_snapshots.collected_at >= ?
        AND metric_snapshots.connection_status = 'online'
      GROUP BY COALESCE(refresh_runs.started_at, metric_snapshots.collected_at)
      ORDER BY collected_at ASC`,
      [since],
      (row) => ({
        collectedAt: String(row.collected_at),
        averageCpu: nullableNumber(row.average_cpu),
        averageMemory: nullableNumber(row.average_memory),
        averageDisk: nullableNumber(row.average_disk)
      })
    );
  }

  insertSolverJob(job: SolverJob): void {
    this.database.run(
      `INSERT INTO solver_jobs (
        id, server_id, range_path, range_name, dataset_name, scenario, repo_id,
        settings_json, command_text, solver_range_text, status, queue_mode,
        confirm_unstudied, tmux_session, remote_range_path, remote_result_path,
        parallel_run_id, parallel_slice_id, assigned_indices_json, source_type,
        created_at, updated_at, started_at, finished_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.serverId,
        job.rangePath,
        job.rangeName,
        job.datasetName,
        job.scenario,
        job.repoId,
        JSON.stringify(job.settings),
        job.command,
        job.solverRangeText,
        job.status,
        job.queueMode,
        job.confirmUnstudied ? 1 : 0,
        job.tmuxSession,
        job.remoteRangePath,
        job.remoteResultPath,
        job.parallelRunId,
        job.parallelSliceId,
        JSON.stringify(job.assignedIndices),
        job.sourceType,
        job.createdAt,
        job.updatedAt,
        job.startedAt,
        job.finishedAt,
        job.lastError
      ]
    );
    this.persist();
  }

  updateSolverJob(
    id: string,
    patch: Partial<Pick<SolverJob, "status" | "startedAt" | "finishedAt" | "lastError" | "updatedAt">>
  ): SolverJob {
    const current = this.getSolverJob(id);
    if (!current) {
      throw new Error(`Solver job ${id} not found`);
    }

    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    this.database.run(
      `UPDATE solver_jobs
       SET status = ?, started_at = ?, finished_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.status ?? current.status,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        updatedAt,
        id
      ]
    );
    this.persist();
    const updated = this.getSolverJob(id);
    if (!updated) {
      throw new Error(`Solver job ${id} not found`);
    }
    return updated;
  }

  getSolverJobs(): SolverJob[] {
    return this.query<SolverJob>(
      "SELECT * FROM solver_jobs ORDER BY created_at DESC",
      [],
      (row) => mapSolverJob(row, this.getLatestPipelineSnapshot(String(row.server_id)))
    );
  }

  getSolverJob(id: string): SolverJob | null {
    return (
      this.query<SolverJob>(
        "SELECT * FROM solver_jobs WHERE id = ?",
        [id],
        (row) => mapSolverJob(row, this.getLatestPipelineSnapshot(String(row.server_id)))
      )[0] ?? null
    );
  }

  deleteSolverJob(id: string): void {
    this.database.run("DELETE FROM solver_job_events WHERE job_id = ?", [id]);
    this.database.run("DELETE FROM solver_jobs WHERE id = ?", [id]);
    this.persist();
  }

  getActiveSolverJobForServer(serverId: string, exceptJobId?: string): SolverJob | null {
    return (
      this.query<SolverJob>(
        `SELECT * FROM solver_jobs
         WHERE server_id = ?
           AND status IN ('deploying', 'running', 'stopping')
           AND (? IS NULL OR id != ?)
         ORDER BY updated_at DESC LIMIT 1`,
        [serverId, exceptJobId ?? null, exceptJobId ?? null],
        (row) => mapSolverJob(row, this.getLatestPipelineSnapshot(String(row.server_id)))
      )[0] ?? null
    );
  }

  getQueuedSolverJobForServer(serverId: string): SolverJob | null {
    return (
      this.query<SolverJob>(
        `SELECT solver_jobs.* FROM solver_jobs
         LEFT JOIN parallel_solver_runs ON parallel_solver_runs.id = solver_jobs.parallel_run_id
         WHERE solver_jobs.server_id = ? AND solver_jobs.status = 'queued' AND solver_jobs.queue_mode IN ('queue_next', 'parallel')
         ORDER BY COALESCE(parallel_solver_runs.queue_order, 999999), solver_jobs.created_at ASC LIMIT 1`,
        [serverId],
        (row) => mapSolverJob(row, this.getLatestPipelineSnapshot(String(row.server_id)))
      )[0] ?? null
    );
  }

  insertParallelSolverRun(run: ParallelSolverRun): void {
    this.database.run(
      `INSERT INTO parallel_solver_runs (
        id, source_type, range_path, range_name, dataset_name, scenario, repo_id,
        settings_json, solver_range_text, status, report_cleared, server_ids_json, total_indices_json,
        missing_indices_json, queue_order, created_at, updated_at, started_at, finished_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.sourceType,
        run.rangePath,
        run.rangeName,
        run.datasetName,
        run.scenario,
        run.repoId,
        JSON.stringify(run.settings),
        run.solverRangeText,
        run.status,
        run.reportCleared ? 1 : 0,
        JSON.stringify(run.serverIds),
        JSON.stringify(run.totalIndices),
        JSON.stringify(run.missingIndices),
        run.queueOrder,
        run.createdAt,
        run.updatedAt,
        run.startedAt,
        run.finishedAt,
        run.lastError
      ]
    );
    this.persist();
  }

  updateParallelSolverRun(
    id: string,
    patch: Partial<Pick<ParallelSolverRun, "status" | "startedAt" | "finishedAt" | "lastError" | "updatedAt">>
  ): ParallelSolverRun {
    const current = this.getParallelSolverRun(id);
    if (!current) throw new Error(`Parallel solver run ${id} not found`);
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    this.database.run(
      `UPDATE parallel_solver_runs
       SET status = ?, started_at = ?, finished_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.status ?? current.status,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        updatedAt,
        id
      ]
    );
    this.persist();
    const updated = this.getParallelSolverRun(id);
    if (!updated) throw new Error(`Parallel solver run ${id} not found`);
    return updated;
  }

  insertParallelSolverSlice(slice: ParallelSolverSlice): void {
    this.database.run(
      `INSERT INTO parallel_solver_slices (
        id, run_id, server_id, candidate_server_ids_json, job_id, range_expr, assigned_indices_json, assigned_board_names_json,
        status, completed_count, failed_count, started_at, finished_at, created_at, updated_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slice.id,
        slice.runId,
        slice.serverId,
        JSON.stringify(slice.candidateServerIds),
        slice.jobId,
        slice.rangeExpr,
        JSON.stringify(slice.assignedIndices),
        JSON.stringify(slice.assignedBoardNames),
        slice.status,
        slice.completedCount,
        slice.failedCount,
        slice.startedAt,
        slice.finishedAt,
        slice.createdAt,
        slice.updatedAt,
        slice.lastError
      ]
    );
    this.persist();
  }

  updateParallelSolverSlice(
    id: string,
    patch: Partial<Pick<ParallelSolverSlice, "serverId" | "candidateServerIds" | "status" | "jobId" | "completedCount" | "failedCount" | "startedAt" | "finishedAt" | "lastError" | "updatedAt">>
  ): ParallelSolverSlice {
    const current = this.getParallelSolverSlice(id);
    if (!current) throw new Error(`Parallel solver slice ${id} not found`);
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    this.database.run(
      `UPDATE parallel_solver_slices
       SET server_id = ?, candidate_server_ids_json = ?, status = ?, job_id = ?, completed_count = ?, failed_count = ?, started_at = ?, finished_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.serverId !== undefined ? patch.serverId : current.serverId,
        patch.candidateServerIds !== undefined ? JSON.stringify(patch.candidateServerIds) : JSON.stringify(current.candidateServerIds),
        patch.status ?? current.status,
        patch.jobId !== undefined ? patch.jobId : current.jobId,
        patch.completedCount !== undefined ? patch.completedCount : current.completedCount,
        patch.failedCount !== undefined ? patch.failedCount : current.failedCount,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        updatedAt,
        id
      ]
    );
    this.persist();
    const updated = this.getParallelSolverSlice(id);
    if (!updated) throw new Error(`Parallel solver slice ${id} not found`);
    return updated;
  }

  getParallelSolverRuns(): ParallelSolverRun[] {
    return this.query<ParallelSolverRun>(
      "SELECT * FROM parallel_solver_runs ORDER BY queue_order ASC, created_at DESC",
      [],
      (row) => mapParallelSolverRun(row, this.getParallelSolverSlices(String(row.id)))
    );
  }

  getParallelSolverRun(id: string): ParallelSolverRun | null {
    return (
      this.query<ParallelSolverRun>(
        "SELECT * FROM parallel_solver_runs WHERE id = ?",
        [id],
        (row) => mapParallelSolverRun(row, this.getParallelSolverSlices(String(row.id)))
      )[0] ?? null
    );
  }

  deleteParallelSolverRuns(ids: string[]): void {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.database.run(
      `DELETE FROM solver_job_events
       WHERE job_id IN (SELECT id FROM solver_jobs WHERE parallel_run_id IN (${placeholders}))`,
      uniqueIds
    );
    this.database.run(
      `DELETE FROM solver_jobs WHERE parallel_run_id IN (${placeholders})`,
      uniqueIds
    );
    this.database.run(
      `DELETE FROM parallel_solver_slices WHERE run_id IN (${placeholders})`,
      uniqueIds
    );
    this.database.run(
      `DELETE FROM parallel_solver_runs WHERE id IN (${placeholders})`,
      uniqueIds
    );
    this.persist();
  }

  clearParallelSolverRunReports(ids: string[]): void {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.database.run(
      `UPDATE parallel_solver_runs
       SET report_cleared = 1, updated_at = ?
       WHERE id IN (${placeholders})`,
      [new Date().toISOString(), ...uniqueIds]
    );
    this.persist();
  }

  getNextParallelSolverQueueOrder(): number {
    return (
      this.query<number>(
        "SELECT COALESCE(MAX(queue_order), 0) + 1 AS next_order FROM parallel_solver_runs",
        [],
        (row) => Number(row.next_order)
      )[0] ?? 1
    );
  }

  updateParallelSolverRunQueueOrder(id: string, queueOrder: number): void {
    this.database.run(
      "UPDATE parallel_solver_runs SET queue_order = ?, updated_at = ? WHERE id = ?",
      [queueOrder, new Date().toISOString(), id]
    );
    this.persist();
  }

  getParallelSolverSlices(runId?: string): ParallelSolverSlice[] {
    if (runId) {
      return this.query<ParallelSolverSlice>(
        "SELECT * FROM parallel_solver_slices WHERE run_id = ? ORDER BY created_at ASC",
        [runId],
        (row) => mapParallelSolverSlice(row, row.job_id == null ? null : this.getSolverJob(String(row.job_id)))
      );
    }
    return this.query<ParallelSolverSlice>(
      "SELECT * FROM parallel_solver_slices ORDER BY created_at ASC",
      [],
      (row) => mapParallelSolverSlice(row, row.job_id == null ? null : this.getSolverJob(String(row.job_id)))
    );
  }

  getParallelSolverSlice(id: string): ParallelSolverSlice | null {
    return (
      this.query<ParallelSolverSlice>(
        "SELECT * FROM parallel_solver_slices WHERE id = ?",
        [id],
        (row) => mapParallelSolverSlice(row, row.job_id == null ? null : this.getSolverJob(String(row.job_id)))
      )[0] ?? null
    );
  }

  getParallelSolverSliceByJobId(jobId: string): ParallelSolverSlice | null {
    return (
      this.query<ParallelSolverSlice>(
        "SELECT * FROM parallel_solver_slices WHERE job_id = ?",
        [jobId],
        (row) => mapParallelSolverSlice(row, this.getSolverJob(jobId))
      )[0] ?? null
    );
  }

  upsertParallelFailurePoolEntry(entry: ParallelFailurePoolEntry): void {
    const existing = this.query<{ id: string; attemptCount: number }>(
      "SELECT id, attempt_count FROM parallel_failure_pool_entries WHERE range_path = ? AND dataset_name = ? AND board_index = ?",
      [entry.rangePath, entry.datasetName, entry.boardIndex],
      (row) => ({ id: String(row.id), attemptCount: Number(row.attempt_count) })
    )[0];
    if (existing) {
      this.database.run(
        `UPDATE parallel_failure_pool_entries
         SET repo_id = ?, scenario = ?, board_name = ?, board_key = ?, status = ?, failure_reason = ?, attempt_count = ?,
             last_run_id = ?, last_slice_id = ?, last_server_id = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [
          entry.repoId,
          entry.scenario,
          entry.boardName,
          entry.boardKey,
          entry.status,
          entry.failureReason,
          Math.max(existing.attemptCount + 1, entry.attemptCount),
          entry.lastRunId,
          entry.lastSliceId,
          entry.lastServerId,
          entry.lastError,
          entry.updatedAt,
          existing.id
        ]
      );
    } else {
      this.database.run(
        `INSERT INTO parallel_failure_pool_entries (
          id, range_path, dataset_name, repo_id, scenario, board_index, board_name, board_key,
          status, failure_reason, attempt_count, last_run_id, last_slice_id, last_server_id, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.rangePath,
          entry.datasetName,
          entry.repoId,
          entry.scenario,
          entry.boardIndex,
          entry.boardName,
          entry.boardKey,
          entry.status,
          entry.failureReason,
          entry.attemptCount,
          entry.lastRunId,
          entry.lastSliceId,
          entry.lastServerId,
          entry.lastError,
          entry.createdAt,
          entry.updatedAt
        ]
      );
    }
    this.persist();
  }

  updateParallelFailurePoolEntries(
    rangePath: string,
    datasetName: string,
    indices: number[],
    status: ParallelFailurePoolStatus
  ): void {
    if (indices.length === 0) return;
    const placeholders = indices.map(() => "?").join(", ");
    this.database.run(
      `UPDATE parallel_failure_pool_entries
       SET status = ?, updated_at = ?
       WHERE range_path = ? AND dataset_name = ? AND board_index IN (${placeholders})`,
      [status, new Date().toISOString(), rangePath, datasetName, ...indices]
    );
    this.persist();
  }

  clearParallelFailurePoolEntries(): number {
    const count = this.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM parallel_failure_pool_entries",
      [],
      (row) => ({ count: Number(row.count) })
    )[0]?.count ?? 0;
    if (count === 0) return 0;
    this.database.run("DELETE FROM parallel_failure_pool_entries");
    this.persist();
    return count;
  }

  getParallelFailurePoolEntries(rangePath?: string, datasetName?: string): ParallelFailurePoolEntry[] {
    if (rangePath && datasetName) {
      return this.query<ParallelFailurePoolEntry>(
        `SELECT * FROM parallel_failure_pool_entries
         WHERE range_path = ? AND dataset_name = ?
         ORDER BY board_index ASC`,
        [rangePath, datasetName],
        mapParallelFailurePoolEntry
      );
    }
    return this.query<ParallelFailurePoolEntry>(
      "SELECT * FROM parallel_failure_pool_entries ORDER BY updated_at DESC, board_index ASC",
      [],
      mapParallelFailurePoolEntry
    );
  }

  cancelQueuedSolverJobsForServer(serverId: string, exceptJobId?: string): void {
    const now = new Date().toISOString();
    this.database.run(
      `UPDATE solver_jobs
       SET status = 'canceled', finished_at = ?, updated_at = ?
       WHERE server_id = ? AND status = 'queued' AND queue_mode = 'queue_next' AND (? IS NULL OR id != ?)`,
      [now, now, serverId, exceptJobId ?? null, exceptJobId ?? null]
    );
    this.persist();
  }

  insertSolverJobEvent(event: SolverJobEvent): void {
    this.database.run(
      `INSERT INTO solver_job_events (id, job_id, event_type, message, command_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, event.jobId, event.type, event.message, event.commandPreview, event.createdAt]
    );
    this.persist();
  }

  getSolverJobEvents(jobId?: string): SolverJobEvent[] {
    if (jobId) {
      return this.query<SolverJobEvent>(
        "SELECT * FROM solver_job_events WHERE job_id = ? ORDER BY created_at ASC",
        [jobId],
        mapSolverJobEvent
      );
    }
    return this.query<SolverJobEvent>(
      "SELECT * FROM solver_job_events ORDER BY created_at DESC LIMIT 200",
      [],
      mapSolverJobEvent
    );
  }

  insertServerOperation(operation: ServerOperation): void {
    this.database.run(
      `INSERT INTO server_operations (
        id, operation_type, server_id, status, tmux_session, command_text, items_json,
        status_file_path, log_file_path, created_at, updated_at, started_at, finished_at, last_error, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.id,
        operation.type,
        operation.serverId,
        operation.status,
        operation.tmuxSession,
        operation.command,
        JSON.stringify(operation.items),
        operation.statusFilePath,
        operation.logFilePath,
        operation.createdAt,
        operation.updatedAt,
        operation.startedAt,
        operation.finishedAt,
        operation.lastError,
        operation.result ? JSON.stringify(operation.result) : null
      ]
    );
    this.persist();
  }

  upsertServerOperation(operation: ServerOperation): void {
    this.database.run(
      `INSERT INTO server_operations (
        id, operation_type, server_id, status, tmux_session, command_text, items_json,
        status_file_path, log_file_path, created_at, updated_at, started_at, finished_at, last_error, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        operation_type = excluded.operation_type,
        server_id = excluded.server_id,
        status = excluded.status,
        tmux_session = excluded.tmux_session,
        command_text = excluded.command_text,
        items_json = excluded.items_json,
        status_file_path = excluded.status_file_path,
        log_file_path = excluded.log_file_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        last_error = excluded.last_error,
        result_json = excluded.result_json`,
      [
        operation.id,
        operation.type,
        operation.serverId,
        operation.status,
        operation.tmuxSession,
        operation.command,
        JSON.stringify(operation.items),
        operation.statusFilePath,
        operation.logFilePath,
        operation.createdAt,
        operation.updatedAt,
        operation.startedAt,
        operation.finishedAt,
        operation.lastError,
        operation.result ? JSON.stringify(operation.result) : null
      ]
    );
    this.persist();
  }

  updateServerOperation(
    id: string,
    patch: Partial<Pick<ServerOperation, "status" | "startedAt" | "finishedAt" | "lastError" | "updatedAt" | "result">>
  ): ServerOperation {
    const current = this.getServerOperation(id);
    if (!current) {
      throw new Error(`Server operation ${id} not found`);
    }
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    this.database.run(
      `UPDATE server_operations
       SET status = ?, started_at = ?, finished_at = ?, last_error = ?, result_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.status ?? current.status,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        patch.result !== undefined ? (patch.result ? JSON.stringify(patch.result) : null) : (current.result ? JSON.stringify(current.result) : null),
        updatedAt,
        id
      ]
    );
    this.persist();
    const updated = this.getServerOperation(id);
    if (!updated) {
      throw new Error(`Server operation ${id} not found`);
    }
    return updated;
  }

  getServerOperations(): ServerOperation[] {
    return this.query<ServerOperation>(
      "SELECT * FROM server_operations ORDER BY created_at DESC LIMIT 200",
      [],
      mapServerOperation
    );
  }

  getServerOperation(id: string): ServerOperation | null {
    return (
      this.query<ServerOperation>(
        "SELECT * FROM server_operations WHERE id = ?",
        [id],
        mapServerOperation
      )[0] ?? null
    );
  }

  getLatestServerOperation(serverId: string, type: ServerOperationType): ServerOperation | null {
    return (
      this.query<ServerOperation>(
        `SELECT * FROM server_operations
         WHERE server_id = ? AND operation_type = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
        [serverId, type],
        mapServerOperation
      )[0] ?? null
    );
  }

  getServerOperationInventory(): ServerOperation[] {
    const operations = this.query<ServerOperation>(
      `SELECT * FROM server_operations
       ORDER BY updated_at DESC, created_at DESC`,
      [],
      mapServerOperation
    );
    const latest = new Map<string, ServerOperation>();
    for (const operation of operations) {
      const key = `${operation.serverId}\u0000${operation.type}`;
      if (!latest.has(key)) latest.set(key, operation);
    }
    return Array.from(latest.values()).sort((left, right) => {
      const serverDelta = left.serverId.localeCompare(right.serverId, undefined, { numeric: true, sensitivity: "base" });
      return serverDelta !== 0 ? serverDelta : left.type.localeCompare(right.type);
    });
  }

  clearTerminalServerOperations(): number {
    const rows = this.query<{ id: string }>(
      "SELECT id FROM server_operations WHERE status IN ('completed', 'failed', 'canceled')",
      [],
      (row) => ({ id: String(row.id) })
    );
    if (rows.length === 0) return 0;
    const placeholders = rows.map(() => "?").join(", ");
    const ids = rows.map((row) => row.id);
    this.database.run(`DELETE FROM server_operation_events WHERE operation_id IN (${placeholders})`, ids);
    this.database.run(`DELETE FROM server_operations WHERE id IN (${placeholders})`, ids);
    this.persist();
    return ids.length;
  }

  insertServerOperationEvent(event: ServerOperationEvent): void {
    this.database.run(
      `INSERT INTO server_operation_events (id, operation_id, event_type, message, command_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, event.operationId, event.type, event.message, event.commandPreview, event.createdAt]
    );
    this.persist();
  }

  getServerOperationEvents(operationId?: string): ServerOperationEvent[] {
    if (operationId) {
      return this.query<ServerOperationEvent>(
        "SELECT * FROM server_operation_events WHERE operation_id = ? ORDER BY created_at ASC",
        [operationId],
        mapServerOperationEvent
      );
    }
    return this.query<ServerOperationEvent>(
      "SELECT * FROM server_operation_events ORDER BY created_at DESC LIMIT 200",
      [],
      mapServerOperationEvent
    );
  }

  private initializeSchema(): void {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        group_name TEXT,
        enabled INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT 'TBD',
        solver_root TEXT,
        tmux_session TEXT,
        pipeline_status_file_path TEXT,
        last_dataset_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        connection_status TEXT NOT NULL,
        health_level TEXT,
        cpu_used_percent REAL,
        memory_used_percent REAL,
        disk_used_percent REAL,
        load_1 REAL,
        load_5 REAL,
        load_15 REAL,
        uptime_seconds REAL,
        error_code TEXT,
        error_message TEXT,
        cpu_model TEXT,
        cpu_vcores INTEGER,
        memory_total_bytes REAL,
        memory_used_bytes REAL,
        disk_total_bytes REAL,
        disk_used_bytes REAL
      );

      CREATE INDEX IF NOT EXISTS idx_metric_snapshots_server_time
        ON metric_snapshots(server_id, collected_at);

      CREATE TABLE IF NOT EXISTS pipeline_status_snapshots (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        available INTEGER NOT NULL,
        process_alive INTEGER,
        file_status TEXT,
        display_status TEXT NOT NULL,
        phase TEXT,
        repo_id TEXT,
        dataset_name TEXT,
        scenario TEXT,
        current_batch INTEGER,
        total_batches INTEGER,
        total_tasks INTEGER,
        batch_expr TEXT,
        assigned_indices_json TEXT,
        completed_indices_json TEXT,
        failed_indices_json TEXT,
        skipped_indices_json TEXT,
        completed_count INTEGER,
        failed_count INTEGER,
        skipped_count INTEGER,
        result_path TEXT,
        pid INTEGER,
        started_at TEXT,
        updated_at TEXT,
        finished_at TEXT,
        command_text TEXT,
        error_text TEXT,
        error_code TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_status_snapshots_server_time
        ON pipeline_status_snapshots(server_id, collected_at);

      CREATE TABLE IF NOT EXISTS refresh_runs (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        success_count INTEGER NOT NULL,
        warning_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS solver_jobs (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        range_path TEXT NOT NULL,
        range_name TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        scenario TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        command_text TEXT NOT NULL,
        solver_range_text TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_mode TEXT NOT NULL,
        confirm_unstudied INTEGER NOT NULL,
        tmux_session TEXT NOT NULL,
        remote_range_path TEXT NOT NULL,
        remote_result_path TEXT,
        parallel_run_id TEXT,
        parallel_slice_id TEXT,
        assigned_indices_json TEXT,
        source_type TEXT NOT NULL DEFAULT 'single',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_solver_jobs_server_status_time
        ON solver_jobs(server_id, status, created_at);

      CREATE TABLE IF NOT EXISTS solver_job_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        command_preview TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_solver_job_events_job_time
        ON solver_job_events(job_id, created_at);

      CREATE TABLE IF NOT EXISTS server_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        server_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tmux_session TEXT NOT NULL,
        command_text TEXT NOT NULL,
        items_json TEXT NOT NULL,
        status_file_path TEXT NOT NULL,
        log_file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_server_operations_server_status_time
        ON server_operations(server_id, status, created_at);

      CREATE TABLE IF NOT EXISTS server_operation_events (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        command_preview TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_server_operation_events_operation_time
        ON server_operation_events(operation_id, created_at);

      CREATE TABLE IF NOT EXISTS parallel_solver_runs (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        range_path TEXT NOT NULL,
        range_name TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        scenario TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        solver_range_text TEXT NOT NULL,
        status TEXT NOT NULL,
        report_cleared INTEGER NOT NULL DEFAULT 0,
        server_ids_json TEXT NOT NULL,
        total_indices_json TEXT NOT NULL,
        missing_indices_json TEXT NOT NULL,
        queue_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS parallel_solver_slices (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        candidate_server_ids_json TEXT NOT NULL DEFAULT '[]',
        job_id TEXT,
        range_expr TEXT NOT NULL,
        assigned_indices_json TEXT NOT NULL,
        assigned_board_names_json TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_count INTEGER NOT NULL,
        failed_count INTEGER NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_parallel_solver_slices_run
        ON parallel_solver_slices(run_id, server_id);

      CREATE TABLE IF NOT EXISTS parallel_failure_pool_entries (
        id TEXT PRIMARY KEY,
        range_path TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        scenario TEXT NOT NULL,
        board_index INTEGER NOT NULL,
        board_name TEXT NOT NULL,
        board_key TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_reason TEXT NOT NULL DEFAULT 'unclassified',
        attempt_count INTEGER NOT NULL,
        last_run_id TEXT,
        last_slice_id TEXT,
        last_server_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_parallel_failure_pool_unique
        ON parallel_failure_pool_entries(range_path, dataset_name, board_index);
    `);
    this.ensureServerNoteColumn();
    this.ensureLastDatasetNameColumn();
    this.ensureServerSolverColumns();
    this.ensurePipelineDetailColumns();
    this.ensureSolverJobParallelColumns();
    this.ensureParallelSolverRunQueueOrderColumn();
    this.ensureParallelSolverRunReportClearedColumn();
    this.ensureParallelSolverSliceCandidateServerColumn();
    this.ensureParallelFailurePoolReasonColumn();
    this.ensureSolverJobResultPathColumn();
    this.ensureServerOperationResultColumn();
    this.persist();
  }

  private ensureServerOperationResultColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(server_operations)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "result_json")) {
      this.database.run("ALTER TABLE server_operations ADD COLUMN result_json TEXT");
    }
  }

  private ensureParallelSolverSliceCandidateServerColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(parallel_solver_slices)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "candidate_server_ids_json")) {
      this.database.run("ALTER TABLE parallel_solver_slices ADD COLUMN candidate_server_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private ensureParallelFailurePoolReasonColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(parallel_failure_pool_entries)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "failure_reason")) {
      this.database.run("ALTER TABLE parallel_failure_pool_entries ADD COLUMN failure_reason TEXT NOT NULL DEFAULT 'unclassified'");
    }
  }

  private ensureSolverJobResultPathColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(solver_jobs)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "remote_result_path")) {
      this.database.run("ALTER TABLE solver_jobs ADD COLUMN remote_result_path TEXT");
    }
  }

  private ensurePipelineDetailColumns(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(pipeline_status_snapshots)",
      [],
      (row) => ({ name: String(row.name) })
    );
    const names = new Set(columns.map((column) => column.name));
    const additions: Array<[string, string]> = [
      ["assigned_indices_json", "TEXT"],
      ["completed_indices_json", "TEXT"],
      ["failed_indices_json", "TEXT"],
      ["skipped_indices_json", "TEXT"],
      ["completed_count", "INTEGER"],
      ["failed_count", "INTEGER"],
      ["skipped_count", "INTEGER"],
      ["result_path", "TEXT"]
    ];
    for (const [name, type] of additions) {
      if (!names.has(name)) {
        this.database.run(`ALTER TABLE pipeline_status_snapshots ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private ensureSolverJobParallelColumns(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(solver_jobs)",
      [],
      (row) => ({ name: String(row.name) })
    );
    const names = new Set(columns.map((column) => column.name));
    const additions: Array<[string, string]> = [
      ["parallel_run_id", "TEXT"],
      ["parallel_slice_id", "TEXT"],
      ["assigned_indices_json", "TEXT"],
      ["source_type", "TEXT NOT NULL DEFAULT 'single'"]
    ];
    for (const [name, type] of additions) {
      if (!names.has(name)) {
        this.database.run(`ALTER TABLE solver_jobs ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private ensureParallelSolverRunQueueOrderColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(parallel_solver_runs)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "queue_order")) {
      this.database.run("ALTER TABLE parallel_solver_runs ADD COLUMN queue_order INTEGER NOT NULL DEFAULT 0");
      this.database.run("UPDATE parallel_solver_runs SET queue_order = CAST(strftime('%s', created_at) AS INTEGER) WHERE queue_order = 0");
    }
  }

  private ensureParallelSolverRunReportClearedColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(parallel_solver_runs)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "report_cleared")) {
      this.database.run("ALTER TABLE parallel_solver_runs ADD COLUMN report_cleared INTEGER NOT NULL DEFAULT 0");
    }
  }

  private ensureServerSolverColumns(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(servers)",
      [],
      (row) => ({ name: String(row.name) })
    );
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("solver_root")) {
      this.database.run("ALTER TABLE servers ADD COLUMN solver_root TEXT");
    }
    if (!names.has("tmux_session")) {
      this.database.run("ALTER TABLE servers ADD COLUMN tmux_session TEXT");
    }
    if (!names.has("pipeline_status_file_path")) {
      this.database.run("ALTER TABLE servers ADD COLUMN pipeline_status_file_path TEXT");
    }
  }

  private ensureLastDatasetNameColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(servers)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "last_dataset_name")) {
      this.database.run("ALTER TABLE servers ADD COLUMN last_dataset_name TEXT");
    }
  }

  private ensureServerNoteColumn(): void {
    const columns = this.query<{ name: string }>(
      "PRAGMA table_info(servers)",
      [],
      (row) => ({ name: String(row.name) })
    );
    if (!columns.some((column) => column.name === "note")) {
      this.database.run("ALTER TABLE servers ADD COLUMN note TEXT NOT NULL DEFAULT 'TBD'");
    }
  }

  private query<T>(
    sql: string,
    params: SqlValue[],
    mapper: (row: Record<string, SqlValue>) => T
  ): T[] {
    const stmt = this.database.prepare(sql);
    const results: T[] = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        results.push(mapper(stmt.getAsObject() as Record<string, SqlValue>));
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  private persist(): void {
    if (!this.filename) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename, Buffer.from(this.database.export()));
  }
}

function mapServerConfig(row: Record<string, SqlValue>): ServerConfig {
  const server: ServerConfig = {
    id: String(row.id),
    name: String(row.name),
    host: String(row.host),
    port: Number(row.port),
    group: row.group_name == null ? undefined : String(row.group_name),
    enabled: Number(row.enabled) === 1,
    note: row.note == null ? "TBD" : String(row.note)
  };
  if (row.solver_root != null) {
    server.solverRoot = String(row.solver_root);
  }
  if (row.tmux_session != null) {
    server.tmuxSession = String(row.tmux_session);
  }
  if (row.pipeline_status_file_path != null) {
    server.pipelineStatusFilePath = String(row.pipeline_status_file_path);
  }
  return server;
}

function mapSolverJob(row: Record<string, SqlValue>, pipeline: PipelineStatusSnapshot | null): SolverJob {
  return {
    id: String(row.id),
    serverId: String(row.server_id),
    rangePath: String(row.range_path),
    rangeName: String(row.range_name),
    datasetName: String(row.dataset_name),
    scenario: String(row.scenario) as SolverJob["scenario"],
    repoId: String(row.repo_id),
    settings: parseSolverJobSettings(row.settings_json),
    command: redactSensitiveCommand(String(row.command_text)),
    solverRangeText: String(row.solver_range_text),
    status: String(row.status) as SolverJobStatus,
    queueMode: String(row.queue_mode) as SolverJob["queueMode"],
    confirmUnstudied: Number(row.confirm_unstudied) === 1,
    tmuxSession: String(row.tmux_session),
    remoteRangePath: String(row.remote_range_path),
    remoteResultPath: row.remote_result_path == null || String(row.remote_result_path).trim() === ""
      ? fallbackRemoteResultPath(String(row.dataset_name), String(row.id))
      : String(row.remote_result_path),
    parallelRunId: row.parallel_run_id == null ? null : String(row.parallel_run_id),
    parallelSliceId: row.parallel_slice_id == null ? null : String(row.parallel_slice_id),
    assignedIndices: parseNumberArray(row.assigned_indices_json),
    sourceType: row.source_type === "parallel" || row.source_type === "failure_pool" ? row.source_type : "single",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    pipeline
  };
}

function fallbackRemoteResultPath(datasetName: string, jobId: string): string {
  return `~/solver/results/${datasetName}/${jobId}`;
}

function mapParallelSolverRun(row: Record<string, SqlValue>, slices: ParallelSolverSlice[]): ParallelSolverRun {
  const startedAt = row.started_at == null ? null : String(row.started_at);
  const finishedAt = row.finished_at == null ? null : String(row.finished_at);
  const totalBoards = parseNumberArray(row.total_indices_json).length;
  const completedBoards = uniqueCount(slices.flatMap((slice) => {
    const completed = assignedPipelineIndices(slice, slice.job?.pipeline?.completedIndices ?? []);
    if (completed.length > 0) return completed;
    return slice.status === "completed" ? slice.assignedIndices : [];
  }));
  const failedBoards = uniqueCount(slices.flatMap((slice) => {
    const failed = assignedPipelineIndices(slice, slice.job?.pipeline?.failedIndices ?? []);
    if (failed.length > 0) return failed;
    return slice.status === "failed" ? slice.assignedIndices : [];
  }));
  const runningBoards = slices
    .filter((slice) => slice.status === "running")
    .reduce((sum, slice) => sum + slice.assignedIndices.length, 0);
  const queuedBoards = slices
    .filter((slice) => slice.status === "queued")
    .reduce((sum, slice) => sum + slice.assignedIndices.length, 0);
  return {
    id: String(row.id),
    sourceType: row.source_type === "failure_pool" ? "failure_pool" : "parallel",
    rangePath: String(row.range_path),
    rangeName: String(row.range_name),
    datasetName: String(row.dataset_name),
    repoId: String(row.repo_id),
    scenario: String(row.scenario),
    settings: parseSolverJobSettings(row.settings_json),
    solverRangeText: String(row.solver_range_text),
    status: String(row.status) as ParallelSolverRunStatus,
    reportCleared: Number(row.report_cleared ?? 0) === 1,
    queueOrder: Number(row.queue_order ?? 0),
    serverIds: parseStringArray(row.server_ids_json),
    totalIndices: parseNumberArray(row.total_indices_json),
    missingIndices: parseNumberArray(row.missing_indices_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt,
    finishedAt,
    lastError: row.last_error == null ? null : String(row.last_error),
    slices,
    report: {
      totalBoards,
      completedBoards,
      failedBoards,
      queuedBoards,
      runningBoards,
      successRate: totalBoards > 0 ? completedBoards / totalBoards : 1,
      durationSeconds: durationSeconds(startedAt, finishedAt)
    }
  };
}

function assignedPipelineIndices(slice: ParallelSolverSlice, indices: number[]): number[] {
  const assigned = new Set(slice.assignedIndices);
  return indices.filter((index) => assigned.has(index));
}

function mapParallelSolverSlice(row: Record<string, SqlValue>, job: SolverJob | null): ParallelSolverSlice {
  const assignedIndices = parseNumberArray(row.assigned_indices_json);
  const serverId = String(row.server_id ?? "");
  const candidateServerIds = parseStringArray(row.candidate_server_ids_json);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    serverId,
    candidateServerIds: candidateServerIds.length > 0 ? candidateServerIds : (serverId ? [serverId] : []),
    jobId: row.job_id == null ? null : String(row.job_id),
    rangeExpr: String(row.range_expr),
    assignedIndices,
    assignedBoardNames: parseStringArray(row.assigned_board_names_json),
    status: String(row.status) as ParallelSolverSliceStatus,
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    job
  };
}

function mapParallelFailurePoolEntry(row: Record<string, SqlValue>): ParallelFailurePoolEntry {
  return {
    id: String(row.id),
    rangePath: String(row.range_path),
    datasetName: String(row.dataset_name),
    repoId: String(row.repo_id),
    scenario: String(row.scenario),
    boardIndex: Number(row.board_index),
    boardName: String(row.board_name),
    boardKey: String(row.board_key),
    status: String(row.status) as ParallelFailurePoolStatus,
    failureReason: normalizeParallelFailureReason(row.failure_reason),
    attemptCount: Number(row.attempt_count),
    lastRunId: row.last_run_id == null ? null : String(row.last_run_id),
    lastSliceId: row.last_slice_id == null ? null : String(row.last_slice_id),
    lastServerId: row.last_server_id == null ? null : String(row.last_server_id),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeParallelFailureReason(value: SqlValue): ParallelFailureReason {
  if (
    value === "abnormal_end" ||
    value === "skipped" ||
    value === "best_server_skipped" ||
    value === "unclassified"
  ) {
    return value;
  }
  return "unclassified";
}

function mapSolverJobEvent(row: Record<string, SqlValue>): SolverJobEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    type: String(row.event_type),
    message: String(row.message),
    commandPreview: row.command_preview == null ? null : redactSensitiveCommand(String(row.command_preview)),
    createdAt: String(row.created_at)
  };
}

function mapServerOperation(row: Record<string, SqlValue>): ServerOperation {
  return {
    id: String(row.id),
    type: normalizeServerOperationType(row.operation_type),
    serverId: String(row.server_id),
    status: normalizeServerOperationStatus(row.status),
    tmuxSession: String(row.tmux_session),
    command: redactSensitiveCommand(String(row.command_text)),
    items: parseServerOperationItems(row.items_json),
    statusFilePath: String(row.status_file_path),
    logFilePath: String(row.log_file_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    result: parseServerOperationResult(row.result_json)
  };
}

function mapServerOperationEvent(row: Record<string, SqlValue>): ServerOperationEvent {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    type: String(row.event_type),
    message: String(row.message),
    commandPreview: row.command_preview == null ? null : redactSensitiveCommand(String(row.command_preview)),
    createdAt: String(row.created_at)
  };
}

function parseSolverJobSettings(value: SqlValue): SolverJobSettings {
  if (typeof value !== "string") {
    throw new Error("solver job settings must be JSON");
  }
  return JSON.parse(value) as SolverJobSettings;
}

function parseServerOperationItems(value: SqlValue): ServerOperationItem[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isServerOperationItem) : [];
  } catch {
    return [];
  }
}

function isServerOperationItem(value: unknown): value is ServerOperationItem {
  return typeof value === "object" && value !== null;
}

function parseServerOperationResult(value: SqlValue): ServerOperationResult | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const summary = isRecord(parsed.summary) ? parsed.summary : {};
    const details = Array.isArray(parsed.details) ? parsed.details.filter(isRecord) : [];
    return {
      summary: normalizeOperationResultRecord(summary),
      details: details.map(normalizeOperationResultRecord),
      raw: typeof parsed.raw === "string" ? parsed.raw : null
    };
  } catch {
    return null;
  }
}

function normalizeOperationResultRecord(value: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const result: Record<string, number | string | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      result[key] = raw;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeServerOperationType(value: SqlValue): ServerOperationType {
  if (value === "network_sync") return "network_sync";
  if (value === "network_check") return "network_check";
  return value === "upload" ? "upload" : "sync";
}

function normalizeServerOperationStatus(value: SqlValue): ServerOperationStatus {
  if (
    value === "queued" ||
    value === "deploying" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return "failed";
}

function redactSensitiveCommand(value: string): string {
  return value
    .replace(/export HF_TOKEN=(?:'[^']*'|"[^"]*"|[^&\s]+)/g, "export HF_TOKEN=$HF_TOKEN")
    .replace(/SUBSCRIPTION_URL=(?:'[^']*'|"[^"]*"|[^&\s]+)/g, "SUBSCRIPTION_URL=$SUBSCRIPTION_URL");
}

function mapSnapshot(row: Record<string, SqlValue>): MetricSnapshot {
  return {
    id: String(row.id),
    serverId: String(row.server_id),
    collectedAt: String(row.collected_at),
    connectionStatus: String(row.connection_status) as ConnectionStatus,
    healthLevel: row.health_level == null ? null : (String(row.health_level) as HealthLevel),
    cpuUsedPercent: nullableNumber(row.cpu_used_percent),
    memoryUsedPercent: nullableNumber(row.memory_used_percent),
    diskUsedPercent: nullableNumber(row.disk_used_percent),
    load1: nullableNumber(row.load_1),
    load5: nullableNumber(row.load_5),
    load15: nullableNumber(row.load_15),
    uptimeSeconds: nullableNumber(row.uptime_seconds),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    cpuModel: row.cpu_model == null ? null : String(row.cpu_model),
    cpuVcores: nullableNumber(row.cpu_vcores),
    memoryTotalBytes: nullableNumber(row.memory_total_bytes),
    memoryUsedBytes: nullableNumber(row.memory_used_bytes),
    diskTotalBytes: nullableNumber(row.disk_total_bytes),
    diskUsedBytes: nullableNumber(row.disk_used_bytes)
  };
}

function mapPipelineSnapshot(row: Record<string, SqlValue>): PipelineStatusSnapshot {
  return {
    id: String(row.id),
    serverId: String(row.server_id),
    collectedAt: String(row.collected_at),
    available: Number(row.available) === 1,
    processAlive: row.process_alive == null ? null : Number(row.process_alive) === 1,
    fileStatus: row.file_status == null ? null : String(row.file_status) as PipelineStatusSnapshot["fileStatus"],
    displayStatus: String(row.display_status) as PipelineStatusSnapshot["displayStatus"],
    phase: row.phase == null ? null : String(row.phase) as PipelineStatusSnapshot["phase"],
    repoId: row.repo_id == null ? null : String(row.repo_id),
    datasetName: row.dataset_name == null ? null : String(row.dataset_name),
    scenario: row.scenario == null ? null : String(row.scenario),
    currentBatch: nullableNumber(row.current_batch),
    totalBatches: nullableNumber(row.total_batches),
    totalTasks: nullableNumber(row.total_tasks),
    batchExpr: row.batch_expr == null ? null : String(row.batch_expr),
    assignedIndices: parseNumberArray(row.assigned_indices_json),
    completedIndices: parseNumberArray(row.completed_indices_json),
    failedIndices: parseNumberArray(row.failed_indices_json),
    skippedIndices: parseNumberArray(row.skipped_indices_json),
    completedCount: nullableNumber(row.completed_count),
    failedCount: nullableNumber(row.failed_count),
    skippedCount: nullableNumber(row.skipped_count),
    resultPath: row.result_path == null ? null : String(row.result_path),
    pid: nullableNumber(row.pid),
    startedAt: row.started_at == null ? null : String(row.started_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    command: row.command_text == null ? null : redactSensitiveCommand(String(row.command_text)),
    error: row.error_text == null ? null : String(row.error_text),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message)
  };
}

function nullableNumber(value: SqlValue): number | null {
  return value == null ? null : Number(value);
}

function parseNumberArray(value: SqlValue): number[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => typeof item === "number" && Number.isFinite(item) ? Math.trunc(item) : null)
      .filter((item): item is number => item != null);
  } catch {
    return [];
  }
}

function parseStringArray(value: SqlValue): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function uniqueCount(values: number[]): number {
  return new Set(values).size;
}

function durationSeconds(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return Math.round((finished - started) / 1000);
}
