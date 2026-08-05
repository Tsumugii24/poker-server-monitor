import type { ServerRow } from "../shared/types";
import type { SshTimeoutOptions } from "./sshCollector";
import type { SshCredentials } from "./sshCollector";
import type { MonitorDatabase } from "./db";
import type { RefreshService } from "./refreshService";
import { serverIsJobReady } from "../shared/serverReadiness";
import { probeSshConnectivity } from "./sshConnectivityProbe";

export type OfflineRecoveryCheckResult = {
  checked: number;
  recoveredServerIds: string[];
  failedServerIds: string[];
  skippedWhileRefreshing: boolean;
};

export type OfflineRecoveryServiceOptions = {
  db: MonitorDatabase;
  refreshService: Pick<RefreshService, "getState" | "refreshServer">;
  intervalSeconds: number;
  credentials?: SshCredentials;
  getSshTimeouts?: () => SshTimeoutOptions;
  concurrency?: number;
  probe?: (server: ServerRow) => Promise<void>;
  onRecovered?: (serverIds: string[]) => Promise<void> | void;
};

export class OfflineRecoveryService {
  private scheduler: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private checkTask: Promise<OfflineRecoveryCheckResult> | null = null;
  private started = false;

  constructor(private readonly options: OfflineRecoveryServiceOptions) {
    this.intervalMs = normalizeIntervalSeconds(options.intervalSeconds) * 1000;
  }

  start(): void {
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.started = false;
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
  }

  updateIntervalSeconds(intervalSeconds: number): void {
    this.intervalMs = normalizeIntervalSeconds(intervalSeconds) * 1000;
    if (this.started) this.schedule();
  }

  getIntervalSeconds(): number {
    return this.intervalMs / 1000;
  }

  async checkNow(): Promise<OfflineRecoveryCheckResult> {
    if (this.checkTask) return this.checkTask;
    const task = this.runCheck();
    this.checkTask = task;
    try {
      return await task;
    } finally {
      if (this.checkTask === task) this.checkTask = null;
    }
  }

  private schedule(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = setInterval(() => {
      void this.checkNow().catch((error: unknown) => {
        console.error("Offline server recovery check failed", error);
      });
    }, this.intervalMs);
    this.scheduler.unref?.();
  }

  private async runCheck(): Promise<OfflineRecoveryCheckResult> {
    if (this.options.refreshService.getState().active) {
      return {
        checked: 0,
        recoveredServerIds: [],
        failedServerIds: [],
        skippedWhileRefreshing: true
      };
    }

    const offlineServers = this.options.db.getServerRows()
      .filter((server) => server.enabled && (
        server.latest?.connectionStatus === "offline" ||
        (server.latest?.connectionStatus === "online" && !serverIsJobReady(server))
      ));
    const recoveredServerIds: string[] = [];
    const failedServerIds: string[] = [];
    let checked = 0;

    await forEachWithConcurrency(
      offlineServers,
      Math.max(1, Math.trunc(this.options.concurrency ?? 8)),
      async (server) => {
        checked += 1;
        try {
          await this.probe(server);
          const refreshed = await this.options.refreshService.refreshServer(server.id);
          if (refreshed && serverIsJobReady({
            latest: refreshed.metrics,
            pipeline: refreshed.pipeline
          })) {
            recoveredServerIds.push(server.id);
          } else {
            failedServerIds.push(server.id);
          }
        } catch {
          failedServerIds.push(server.id);
        }
      }
    );

    recoveredServerIds.sort(compareServerIds);
    failedServerIds.sort(compareServerIds);
    if (recoveredServerIds.length > 0) {
      await this.options.onRecovered?.(recoveredServerIds);
    }
    return {
      checked,
      recoveredServerIds,
      failedServerIds,
      skippedWhileRefreshing: false
    };
  }

  private async probe(server: ServerRow): Promise<void> {
    if (this.options.probe) {
      await this.options.probe(server);
      return;
    }
    const result = await probeSshConnectivity(server);
    if (!result.reachable) {
      throw new Error(result.errorMessage ?? "SSH connectivity probe failed");
    }
  }
}

function normalizeIntervalSeconds(value: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("offline recovery interval must be a positive integer");
  }
  return parsed;
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  callback: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, concurrency) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item !== undefined) await callback(item);
      }
    }
  );
  await Promise.all(workers);
}

function compareServerIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
