import { describe, expect, it } from "vitest";
import { displayDatasetName } from "../../src/client/datasetDisplay";

describe("displayDatasetName", () => {
  it("hides the Hugging Face namespace", () => {
    expect(displayDatasetName("Tsumugii/3ia-7.5-3od-5.7")).toBe("3ia-7.5-3od-5.7");
  });

  it("leaves an existing dataset name unchanged", () => {
    expect(displayDatasetName("3ia-7.5-3od-5.7")).toBe("3ia-7.5-3od-5.7");
  });

  it("uses the requested fallback for an empty value", () => {
    expect(displayDatasetName(null, "—")).toBe("—");
  });
});
