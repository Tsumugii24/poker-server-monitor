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
import { collectServerMetrics, type SshCredentials, Ssh2Executor } from "./sshCollector";
import type { AlertService } from "./alertService";

export type RefreshServiceOptions = {
  db: MonitorDatabase;
  servers: ServerConfig[];
  intervalMs: number;
  credentials?: SshCredentials;
  pipelineStatusFilePath?: string;
  collect?: (server: ServerConfig) => Promise<MetricSnapshot>;
  collectPipeline?: (server: ServerConfig) => Promise<PipelineStatusSnapshot>;
  alerts?: AlertService;
};

export class RefreshService {
  private active = false;
  private nextRefreshAt: string | null = null;
  private nextRefreshAtMs: number | null = null;
  private scheduler: NodeJS.Timeout | null = null;
  private readonly collect: (server: ServerConfig) => Promise<MetricSnapshot>;
  private readonly collectPipeline: (server: ServerConfig) => Promise<PipelineStatusSnapshot>;

  constructor(private readonly options: RefreshServiceOptions) {
    const executor = new Ssh2Executor();
    this.collect =
      options.collect ??
      ((server) => {
        if (!options.credentials) {
          throw new Error("SSH credentials are required for refresh collection");
        }
        return collectServerMetrics(server, options.credentials, executor);
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
          options.pipelineStatusFilePath ?? "~/run/solver_running_status.json",
          executor
        );
      });
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
      const collected = await Promise.all(
        enabledServers.map(async (server) => {
          const [metrics, pipeline] = await Promise.all([
            this.collect(server),
            this.collectPipeline(server)
          ]);
          return {
            metrics: { ...metrics, collectedAt },
            pipeline: { ...pipeline, collectedAt }
          };
        })
      );
      for (const item of collected) {
        this.options.db.insertSnapshot(item.metrics);
        this.options.db.insertPipelineSnapshot(item.pipeline);
        if (item.pipeline.datasetName) {
          this.options.db.updateServerLastDatasetName(item.metrics.serverId, item.pipeline.datasetName);
        }
      }
      this.options.db.pruneSnapshots(24);

      const snapshots = collected.map((item) => item.metrics);

      const run: RefreshRun = {
        id: crypto.randomUUID(),
        trigger,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "completed",
        successCount: snapshots.filter((item) => item.connectionStatus === "online" && item.healthLevel === "healthy").length,
        warningCount: snapshots.filter((item) => item.connectionStatus === "online" && item.healthLevel !== "healthy").length,
        failureCount: snapshots.filter(
          (item) => item.connectionStatus === "offline" || item.connectionStatus === "unknown"
        ).length
      };
      this.options.db.insertRefreshRun(run);
      await this.options.alerts?.handleRefresh({
        servers: enabledServers,
        snapshots,
        trigger,
        startedAt
      }).catch((error: unknown) => {
        console.error("Alert delivery failed", error);
      });

      return {
        accepted: true,
        state: this.getState()
      };
    } finally {
      this.active = false;
    }
  }

  getState(): RefreshState {
    return {
      active: this.active,
      nextRefreshAt: this.nextRefreshAt,
      lastRun: this.options.db.getLastRefreshRun()
    };
  }

  startScheduler(options: { runImmediately?: boolean } = {}): void {
    this.stopScheduler();
    this.scheduleNextTime(Date.now() + this.options.intervalMs);
    if (options.runImmediately) {
      void this.refreshAll("startup").catch((error: unknown) => {
        console.error("Startup refresh failed", error);
      });
    }
    this.scheduler = setInterval(() => {
      this.advanceScheduledRefreshTime();
      void this.refreshAll("scheduled");
    }, this.options.intervalMs);
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
  }

  private advanceScheduledRefreshTime(): void {
    this.scheduleNextTime((this.nextRefreshAtMs ?? Date.now()) + this.options.intervalMs);
  }

  private scheduleNextTime(timestampMs: number): void {
    this.nextRefreshAtMs = timestampMs;
    this.nextRefreshAt = new Date(timestampMs).toISOString();
  }
}
