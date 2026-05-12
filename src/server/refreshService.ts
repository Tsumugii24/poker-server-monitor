import type {
  MetricSnapshot,
  RefreshResponse,
  RefreshRun,
  RefreshState,
  RefreshTrigger,
  ServerConfig
} from "../shared/types";
import type { MonitorDatabase } from "./db";
import { collectServerMetrics, type SshCredentials } from "./sshCollector";

export type RefreshServiceOptions = {
  db: MonitorDatabase;
  servers: ServerConfig[];
  intervalMs: number;
  credentials?: SshCredentials;
  collect?: (server: ServerConfig) => Promise<MetricSnapshot>;
};

export class RefreshService {
  private active = false;
  private nextRefreshAt: string | null = null;
  private scheduler: NodeJS.Timeout | null = null;
  private readonly collect: (server: ServerConfig) => Promise<MetricSnapshot>;

  constructor(private readonly options: RefreshServiceOptions) {
    this.collect =
      options.collect ??
      ((server) => {
        if (!options.credentials) {
          throw new Error("SSH credentials are required for refresh collection");
        }
        return collectServerMetrics(server, options.credentials);
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
      const snapshots = (await Promise.all(enabledServers.map((server) => this.collect(server)))).map(
        (snapshot) => ({ ...snapshot, collectedAt })
      );
      for (const snapshot of snapshots) {
        this.options.db.insertSnapshot(snapshot);
      }
      this.options.db.pruneSnapshots(24);

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
      this.scheduleNextTime();

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
    this.scheduleNextTime();
    if (options.runImmediately) {
      void this.refreshAll("startup").catch((error: unknown) => {
        console.error("Startup refresh failed", error);
      });
    }
    this.scheduler = setInterval(() => {
      void this.refreshAll("scheduled");
    }, this.options.intervalMs);
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
  }

  private scheduleNextTime(): void {
    this.nextRefreshAt = new Date(Date.now() + this.options.intervalMs).toISOString();
  }
}
