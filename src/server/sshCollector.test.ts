import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../shared/types";
import { collectServerMetrics } from "./sshCollector";

const server: ServerConfig = {
  id: "prod-01",
  name: "Production 01",
  host: "10.0.0.1",
  port: 22,
  enabled: true
};

describe("collectServerMetrics", () => {
  it("returns an online metric snapshot when SSH command output parses", async () => {
    const snapshot = await collectServerMetrics(
      server,
      { username: "root", password: "secret" },
      {
        run: async () => `CPU_USED_PERCENT=12
MEMORY_USED_PERCENT=34
DISK_USED_PERCENT=56
LOAD_1=0.1
LOAD_5=0.2
LOAD_15=0.3
UPTIME_SECONDS=3600`
      }
    );

    expect(snapshot.status).toBe("online");
    expect(snapshot.cpuUsedPercent).toBe(12);
  });

  it("normalizes SSH auth failures as offline snapshots", async () => {
    const snapshot = await collectServerMetrics(
      server,
      { username: "root", password: "bad" },
      {
        run: async () => {
          throw Object.assign(new Error("All configured authentication methods failed"), {
            code: "AUTH_FAILED"
          });
        }
      }
    );

    expect(snapshot.status).toBe("offline");
    expect(snapshot.errorCode).toBe("auth_failed");
  });

  it("normalizes parser failures as unknown snapshots", async () => {
    const snapshot = await collectServerMetrics(
      server,
      { username: "root", password: "secret" },
      {
        run: async () => "CPU_USED_PERCENT=12"
      }
    );

    expect(snapshot.status).toBe("unknown");
    expect(snapshot.errorCode).toBe("parse_failed");
  });
});
