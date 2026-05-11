import { describe, expect, it } from "vitest";
import {
  buildFailureSnapshot,
  calculateStatus,
  parseCollectorOutput
} from "./metrics";

describe("collector output parsing", () => {
  it("parses key-value Linux metric output", () => {
    const parsed = parseCollectorOutput(`CPU_USED_PERCENT=12.5
MEMORY_USED_PERCENT=63.2
DISK_USED_PERCENT=71
LOAD_1=0.42
LOAD_5=0.55
LOAD_15=0.70
UPTIME_SECONDS=86400
`);

    expect(parsed).toEqual({
      cpuUsedPercent: 12.5,
      memoryUsedPercent: 63.2,
      diskUsedPercent: 71,
      load1: 0.42,
      load5: 0.55,
      load15: 0.7,
      uptimeSeconds: 86400
    });
  });

  it("throws a parse error when required values are missing", () => {
    expect(() => parseCollectorOutput("CPU_USED_PERCENT=12")).toThrow(
      "Missing metric MEMORY_USED_PERCENT"
    );
  });
});

describe("status calculation", () => {
  it("returns online when metrics are under thresholds", () => {
    expect(
      calculateStatus({
        cpuUsedPercent: 20,
        memoryUsedPercent: 30,
        diskUsedPercent: 40,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptimeSeconds: 3600
      })
    ).toBe("online");
  });

  it("returns warning when any utilization threshold is reached", () => {
    expect(
      calculateStatus({
        cpuUsedPercent: 80,
        memoryUsedPercent: 30,
        diskUsedPercent: 40,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptimeSeconds: 3600
      })
    ).toBe("warning");
  });

  it("builds an offline snapshot for SSH failures", () => {
    const snapshot = buildFailureSnapshot("server-1", "auth_failed", "Authentication failed");

    expect(snapshot.status).toBe("offline");
    expect(snapshot.serverId).toBe("server-1");
    expect(snapshot.errorCode).toBe("auth_failed");
  });
});
