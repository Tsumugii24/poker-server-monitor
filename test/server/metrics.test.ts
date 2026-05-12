import { describe, expect, it } from "vitest";
import type { ParsedMetrics } from "../../src/server/metrics";
import {
  buildFailureSnapshot,
  calculateHealthLevel,
  parseCollectorOutput
} from "../../src/server/metrics";

/** Base metrics fixture with hardware info included. */
function baseMetrics(overrides: Partial<ParsedMetrics> = {}): ParsedMetrics {
  return {
    cpuUsedPercent: 20,
    memoryUsedPercent: 30,
    diskUsedPercent: 40,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    uptimeSeconds: 3600,
    cpuModel: "Intel Xeon E5-2686 v4",
    cpuVcores: 4,
    memoryTotalBytes: 8589934592,
    memoryUsedBytes: 2147483648,
    diskTotalBytes: 107374182400,
    diskUsedBytes: 42949672960,
    ...overrides
  };
}

describe("collector output parsing", () => {
  it("parses key-value Linux metric output", () => {
    const parsed = parseCollectorOutput(`CPU_USED_PERCENT=12.5
CPU_MODEL=Intel Xeon E5-2686 v4
CPU_VCORES=4
MEMORY_USED_PERCENT=63.2
MEMORY_TOTAL_BYTES=8589934592
MEMORY_USED_BYTES=5418909696
DISK_USED_PERCENT=71
DISK_TOTAL_BYTES=107374182400
DISK_USED_BYTES=76236627968
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
      uptimeSeconds: 86400,
      cpuModel: "Intel Xeon E5-2686 v4",
      cpuVcores: 4,
      memoryTotalBytes: 8589934592,
      memoryUsedBytes: 5418909696,
      diskTotalBytes: 107374182400,
      diskUsedBytes: 76236627968
    });
  });

  it("throws a parse error when required values are missing", () => {
    expect(() => parseCollectorOutput("CPU_USED_PERCENT=12")).toThrow(
      "Missing metric"
    );
  });
});

describe("health level calculation", () => {
  it("returns healthy when metrics are under warning thresholds", () => {
    expect(calculateHealthLevel(baseMetrics())).toBe("healthy");
  });

  it("returns warning when any utilization reaches warning threshold", () => {
    expect(calculateHealthLevel(baseMetrics({ cpuUsedPercent: 80 }))).toBe("warning");
  });

  it("returns dangerous when any utilization reaches dangerous threshold", () => {
    expect(calculateHealthLevel(baseMetrics({ cpuUsedPercent: 92 }))).toBe("dangerous");
  });

  it("builds an offline snapshot for SSH failures", () => {
    const snapshot = buildFailureSnapshot("server-1", "auth_failed", "Authentication failed");

    expect(snapshot.connectionStatus).toBe("offline");
    expect(snapshot.healthLevel).toBeNull();
    expect(snapshot.cpuModel).toBeNull();
    expect(snapshot.serverId).toBe("server-1");
    expect(snapshot.errorCode).toBe("auth_failed");
  });
});
