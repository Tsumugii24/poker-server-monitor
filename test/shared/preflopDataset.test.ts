import { describe, expect, it } from "vitest";
import { datasetNameFromRangePath, scenarioFromRangePath } from "../../src/shared/preflopDataset";

describe("datasetNameFromRangePath", () => {
  it("keeps terminal integer labels for 3OA/3ID ranges", () => {
    expect(datasetNameFromRangePath("3OA - BB - 2-2.3/3OA 3.5 VS 3ID 5.json")).toBe(
      "3oa-3.5-3id-5"
    );
    expect(datasetNameFromRangePath("3OA - BB - 2-2.3/3OA 3.5 VS 3ID 7.json")).toBe(
      "3oa-3.5-3id-7"
    );
  });

  it("retains a meaningful leading variant prefix", () => {
    expect(datasetNameFromRangePath("3OA SB 150/150 3OA 11.5 VS 3ID 8.json")).toBe(
      "150-3oa-11.5-3id-8"
    );
  });

  it("normalizes all supported pair spellings regardless of source order", () => {
    expect(datasetNameFromRangePath("SOD/2.5BB/SOD-32.0 vs SIA-45.json")).toBe(
      "sia-45-sod-32"
    );
    expect(datasetNameFromRangePath("SOA/SOA-35 vs SID-28.8.json")).toBe(
      "soa-35-sid-28.8"
    );
    expect(datasetNameFromRangePath("3OD - EP/3OD-5.1 vs 3IA-4.2.json")).toBe(
      "3ia-4.2-3od-5.1"
    );
  });

  it("preserves legacy fallback behavior for files without a supported pair", () => {
    expect(datasetNameFromRangePath("misc/No Pair 17.json")).toBe("no-pair");
  });
});

describe("scenarioFromRangePath", () => {
  it("continues to identify SIA/SOD scenario folders", () => {
    expect(scenarioFromRangePath("SOD/2.5BB/SOD-32.0 vs SIA-45.json")).toBe("sia-sod-open2.5");
    expect(scenarioFromRangePath("SIA/SIA-45 vs SOD-32.0.json")).toBe("sia-sod");
  });
});
