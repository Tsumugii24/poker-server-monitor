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
import type { SolverJob, SolverJobEvent, SolverJobSettings, SolverJobStatus } from "../shared/solverJobs";

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
        pid, started_at, updated_at, finished_at, command_text, error_text, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        confirm_unstudied, tmux_session, remote_range_path, created_at, updated_at,
        started_at, finished_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        `SELECT * FROM solver_jobs
         WHERE server_id = ? AND status = 'queued' AND queue_mode = 'queue_next'
         ORDER BY created_at ASC LIMIT 1`,
        [serverId],
        (row) => mapSolverJob(row, this.getLatestPipelineSnapshot(String(row.server_id)))
      )[0] ?? null
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
    `);
    this.ensureServerNoteColumn();
    this.ensureLastDatasetNameColumn();
    this.ensureServerSolverColumns();
    this.persist();
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
    command: String(row.command_text),
    solverRangeText: String(row.solver_range_text),
    status: String(row.status) as SolverJobStatus,
    queueMode: String(row.queue_mode) as SolverJob["queueMode"],
    confirmUnstudied: Number(row.confirm_unstudied) === 1,
    tmuxSession: String(row.tmux_session),
    remoteRangePath: String(row.remote_range_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    pipeline
  };
}

function mapSolverJobEvent(row: Record<string, SqlValue>): SolverJobEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    type: String(row.event_type),
    message: String(row.message),
    commandPreview: row.command_preview == null ? null : String(row.command_preview),
    createdAt: String(row.created_at)
  };
}

function parseSolverJobSettings(value: SqlValue): SolverJobSettings {
  if (typeof value !== "string") {
    throw new Error("solver job settings must be JSON");
  }
  return JSON.parse(value) as SolverJobSettings;
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
    pid: nullableNumber(row.pid),
    startedAt: row.started_at == null ? null : String(row.started_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    command: row.command_text == null ? null : String(row.command_text),
    error: row.error_text == null ? null : String(row.error_text),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message)
  };
}

function nullableNumber(value: SqlValue): number | null {
  return value == null ? null : Number(value);
}
