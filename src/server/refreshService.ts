import type {
  MetricSnapshot,
  PipelineStatusSnapshot,
  RefreshResponse,
  RefreshRun,
  RefreshState,
  RefreshTrigger,
  ServerConfig
} from "../shared/types";
import type { MonitorDatabase } from "./db";
import { collectServerPipelineStatus, buildPipelineFailureSnapshot } from "./pipelineStatusCollector";
import type { SshTimeoutOptions } from "./sshCollector";
import { collectServerMetrics, type SshCredentials, Ssh2Executor } from "./sshCollector";
import type { AlertService } from "./alertService";
import { classifyWeChatSendError } from "./wechatNotifier";
import { loadServerInventory, updateServerInventoryName } from "./config";
import {
  probeSshConnectivity,
  type SshConnectivityProbeResult
} from "./sshConnectivityProbe";
import { buildFailureSnapshot } from "./metrics";

const DEFAULT_REFRESH_CONCURRENCY = 4;

export type RefreshServiceOptions = {
  db: MonitorDatabase;
  servers: ServerConfig[];
  intervalMs: number;
  credentials?: SshCredentials;
  pipelineStatusFilePath?: string;
  collect?: (server: ServerConfig) => Promise<MetricSnapshot>;
  collectPipeline?: (server: ServerConfig) => Promise<PipelineStatusSnapshot>;
  probeConnectivity?: (server: ServerConfig) => Promise<SshConnectivityProbeResult>;
  refreshConcurrency?: number;
  getSshTimeouts?: () => SshTimeoutOptions;
  alerts?: AlertService;
  inventoryPath?: string;
};

export type ServerRefreshResult = {
  metrics: MetricSnapshot;
  pipeline: PipelineStatusSnapshot;
};

export class RefreshService {
  private active = false;
  private nextRefreshAt: string | null = null;
  private nextRefreshAtMs: number | null = null;
  private scheduler: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private current: RefreshState["current"] = null;
  private readonly serverRefreshTasks = new Map<string, Promise<ServerRefreshResult>>();
  private readonly collect: (server: ServerConfig) => Promise<MetricSnapshot>;
  private readonly collectPipeline: (server: ServerConfig) => Promise<PipelineStatusSnapshot>;
  private readonly probeConnectivity: ((server: ServerConfig) => Promise<SshConnectivityProbeResult>) | null;

  constructor(private readonly options: RefreshServiceOptions) {
    this.intervalMs = options.intervalMs;
    this.collect =
      options.collect ??
      ((server) => {
        if (!options.credentials) {
          throw new Error("SSH credentials are required for refresh collection");
        }
        return collectServerMetrics(server, options.credentials, this.createExecutor());
      });
    this.collectPipeline =
      options.collectPipeline ??
      ((server) => {
        if (!options.credentials) {
          return Promise.resolve(
            buildPipelineFailureSnapshot(server.id, "not_configured", "SSH credentials are required")
          );
        }
        return collectServerPipelineStatus(
          server,
          options.credentials,
          server.pipelineStatusFilePath ?? options.pipelineStatusFilePath ?? "~/run/solver_running_status.json",
          this.createExecutor()
        );
      });
    this.probeConnectivity = options.probeConnectivity ?? (options.credentials ? probeSshConnectivity : null);
  }

  private createExecutor(): Ssh2Executor {
    return new Ssh2Executor(this.options.getSshTimeouts?.());
  }

  async refreshAll(trigger: RefreshTrigger): Promise<RefreshResponse> {
    if (this.active) {
      return {
        accepted: false,
        code: "refresh_in_progress",
        message: "A refresh is already running.",
        state: this.getState()
      };
    }

    this.active = true;
    const startedAt = new Date().toISOString();

    try {
      const enabledServers = this.options.servers.filter((server) => server.enabled);
      const collectedAt = startedAt;
      this.current = {
        trigger,
        startedAt,
        totalServers: enabledServers.length,
        completedServers: 0
      };
      const collected = await mapWithConcurrency(
        enabledServers,
        normalizeConcurrency(this.options.refreshConcurrency),
        async (server) => {
          const item = await this.collectAndPersistServer(server, collectedAt);
          if (this.current?.startedAt === startedAt) {
            this.current.completedServers += 1;
          }
          return item;
        }
      );
      this.syncDiscoveredServerNames(collected);
      this.options.db.pruneSnapshots(24);

      const snapshots = collected.map((item) => item.metrics);

      const run: RefreshRun = {
        id: crypto.randomUUID(),
        trigger,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "completed",
        successCount: collected.filter(
          (item) => item.metrics.connectionStatus === "online" &&
            item.metrics.errorCode == null &&
            item.pipeline.errorCode == null &&
            item.metrics.healthLevel === "healthy"
        ).length,
        warningCount: collected.filter(
          (item) => item.metrics.connectionStatus === "online" &&
            (
              item.metrics.errorCode != null ||
              item.pipeline.errorCode != null ||
              item.metrics.healthLevel !== "healthy"
            )
        ).length,
        failureCount: snapshots.filter(
          (item) => item.connectionStatus === "offline" || item.connectionStatus === "unknown"
        ).length
      };
      this.options.db.insertRefreshRun(run);
      if (this.options.alerts) {
        void this.options.alerts.handleRefresh({
          servers: enabledServers,
          snapshots,
          trigger,
          startedAt
        }).catch((error: unknown) => {
          console.error(classifyWeChatSendError(error).logMessage);
        });
      }

      return {
        accepted: true,
        state: this.getState()
      };
    } finally {
      this.active = false;
      this.current = null;
    }
  }

  async refreshServer(serverId: string): Promise<ServerRefreshResult | null> {
    const server = this.options.servers.find((candidate) => candidate.id === serverId);
    if (!server?.enabled) return null;
    const item = await this.collectAndPersistServer(server, new Date().toISOString());
    this.syncDiscoveredServerNames([item]);
    this.options.db.pruneSnapshots(24);
    return item;
  }

  getState(): RefreshState {
    return {
      active: this.active,
      nextRefreshAt: this.nextRefreshAt,
      lastRun: this.options.db.getLastRefreshRun(),
      current: this.current ? { ...this.current } : null
    };
  }

  startScheduler(options: { runImmediately?: boolean } = {}): void {
    this.stopScheduler();
    this.scheduleNextTime(Date.now() + this.intervalMs);
    if (options.runImmediately) {
      void this.refreshAll("startup").catch((error: unknown) => {
        console.error("Startup refresh failed", error);
      });
    }
    this.scheduler = setInterval(() => {
      this.advanceScheduledRefreshTime();
      void this.refreshAll("scheduled");
    }, this.intervalMs);
  }

  updateScheduleInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.scheduler) {
      this.startScheduler();
    }
  }

  updateServers(servers: ServerConfig[]): void {
    this.options.servers = servers;
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
  }

  private advanceScheduledRefreshTime(): void {
    this.scheduleNextTime((this.nextRefreshAtMs ?? Date.now()) + this.intervalMs);
  }

  private scheduleNextTime(timestampMs: number): void {
    this.nextRefreshAtMs = timestampMs;
    this.nextRefreshAt = new Date(timestampMs).toISOString();
  }

  private collectAndPersistServer(server: ServerConfig, collectedAt: string): Promise<ServerRefreshResult> {
    const current = this.serverRefreshTasks.get(server.id);
    if (current) return current;

    const task = this.collectServer(server).then(({ metrics, pipeline }) => {
      const item: ServerRefreshResult = {
        metrics: { ...metrics, collectedAt },
        pipeline: { ...pipeline, collectedAt }
      };
      this.options.db.insertSnapshot(item.metrics);
      this.options.db.insertPipelineSnapshot(item.pipeline);
      if (item.pipeline.datasetName) {
        this.options.db.updateServerLastDatasetName(item.metrics.serverId, item.pipeline.datasetName);
      }
      return item;
    }).finally(() => {
      if (this.serverRefreshTasks.get(server.id) === task) {
        this.serverRefreshTasks.delete(server.id);
      }
    });
    this.serverRefreshTasks.set(server.id, task);
    return task;
  }

  private async collectServer(server: ServerConfig): Promise<ServerRefreshResult> {
    if (!this.probeConnectivity) {
      const [metrics, pipeline] = await Promise.all([
        this.collect(server),
        this.collectPipeline(server)
      ]);
      return { metrics, pipeline };
    }

    let connectivity: SshConnectivityProbeResult;
    try {
      connectivity = await this.probeConnectivity(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connectivity = {
        reachable: false,
        latencyMs: null,
        banner: null,
        errorCode: "probe_failed",
        errorMessage: message
      };
    }

    if (!connectivity.reachable) {
      const errorCode = connectivity.errorCode ?? "connect_failed";
      const errorMessage = connectivity.errorMessage ?? "SSH connectivity probe failed";
      return {
        metrics: buildFailureSnapshot(server.id, errorCode, errorMessage),
        pipeline: buildPipelineFailureSnapshot(server.id, errorCode, errorMessage)
      };
    }

    let metrics: MetricSnapshot;
    try {
      metrics = await this.collect(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics = buildFailureSnapshot(server.id, "collection_failed", message);
    }

    // The provider-style probe established network connectivity. An auth,
    // handshake, command, or parse failure is therefore degraded SSH readiness,
    // not an offline server.
    metrics = this.withReachableConnectivity(metrics, server.id);

    if (metrics.errorCode != null) {
      return {
        metrics,
        pipeline: buildPipelineFailureSnapshot(
          server.id,
          metrics.errorCode,
          metrics.errorMessage ?? "Authenticated SSH metric collection failed"
        )
      };
    }

    let pipeline: PipelineStatusSnapshot;
    try {
      pipeline = await this.collectPipeline(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pipeline = buildPipelineFailureSnapshot(server.id, "pipeline_collection_failed", message);
    }
    return { metrics, pipeline };
  }

  private withReachableConnectivity(snapshot: MetricSnapshot, serverId: string): MetricSnapshot {
    if (snapshot.errorCode == null) {
      return { ...snapshot, connectionStatus: "online" };
    }

    const previous = this.options.db.getLatestSnapshot(serverId);
    return {
      ...snapshot,
      connectionStatus: "online",
      healthLevel: previous?.healthLevel ?? null,
      cpuUsedPercent: previous?.cpuUsedPercent ?? null,
      memoryUsedPercent: previous?.memoryUsedPercent ?? null,
      diskUsedPercent: previous?.diskUsedPercent ?? null,
      load1: previous?.load1 ?? null,
      load5: previous?.load5 ?? null,
      load15: previous?.load15 ?? null,
      uptimeSeconds: previous?.uptimeSeconds ?? null,
      cpuModel: previous?.cpuModel ?? null,
      cpuVcores: previous?.cpuVcores ?? null,
      memoryTotalBytes: previous?.memoryTotalBytes ?? null,
      memoryUsedBytes: previous?.memoryUsedBytes ?? null,
      diskTotalBytes: previous?.diskTotalBytes ?? null,
      diskUsedBytes: previous?.diskUsedBytes ?? null
    };
  }

  private syncDiscoveredServerNames(collected: Array<{
    metrics: MetricSnapshot;
    pipeline: PipelineStatusSnapshot;
  }>): void {
    if (!this.options.inventoryPath) return;

    let changed = false;
    for (const item of collected) {
      const datasetName = item.pipeline.datasetName?.trim();
      if (!datasetName) continue;
      const current = this.options.db.getServer(item.metrics.serverId);
      if (current?.name === datasetName) continue;
      try {
        updateServerInventoryName(this.options.inventoryPath, item.metrics.serverId, datasetName);
        changed = true;
      } catch (error) {
        console.error("Failed to sync discovered server name", error);
      }
    }

    if (changed) {
      const servers = loadServerInventory(this.options.inventoryPath);
      this.options.db.syncServers(servers);
      this.updateServers(servers);
    }
  }
}

function normalizeConcurrency(value: number | undefined): number {
  if (value == null) return DEFAULT_REFRESH_CONCURRENCY;
  const parsed = Math.trunc(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_CONCURRENCY;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await callback(item);
    }
  });
  await Promise.all(workers);
  return results;
}
