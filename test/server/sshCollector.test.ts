import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/shared/types";
import { collectServerMetrics } from "../../src/server/sshCollector";

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
CPU_MODEL=Intel Xeon E5-2686 v4
CPU_VCORES=4
MEMORY_USED_PERCENT=34
MEMORY_TOTAL_BYTES=8589934592
MEMORY_USED_BYTES=2920577761
DISK_USED_PERCENT=56
DISK_TOTAL_BYTES=107374182400
DISK_USED_BYTES=60129542144
LOAD_1=0.1
LOAD_5=0.2
LOAD_15=0.3
UPTIME_SECONDS=3600`
      }
    );

    expect(snapshot.connectionStatus).toBe("online");
    expect(snapshot.healthLevel).toBe("healthy");
    expect(snapshot.cpuUsedPercent).toBe(12);
    expect(snapshot.cpuModel).toBe("Intel Xeon E5-2686 v4");
    expect(snapshot.cpuVcores).toBe(4);
    expect(snapshot.memoryTotalBytes).toBe(8589934592);
    expect(snapshot.diskTotalBytes).toBe(107374182400);
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

    expect(snapshot.connectionStatus).toBe("offline");
    expect(snapshot.healthLevel).toBeNull();
    expect(snapshot.cpuModel).toBeNull();
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

    expect(snapshot.connectionStatus).toBe("unknown");
    expect(snapshot.healthLevel).toBeNull();
    expect(snapshot.errorCode).toBe("parse_failed");
  });
});
