import { describe, expect, it } from "vitest";
import {
  normalizePreflopRangeDocument,
  parseRangeText,
  serializePreflopRangeDocument,
  setPreflopHandFrequency,
  summarizePreflopRange
} from "../../src/shared/preflopRange";

describe("preflop range helpers", () => {
  it("normalizes legacy .range JSON and preserves decimal frequencies", () => {
    const document = normalizePreflopRangeDocument({
      player_names: { A: "3OD-4.3", B: "3IA-4.2" },
      learned: true,
      A: { raise: "AA,AKs:0.500", call: "AQs:0.250" },
      B: { raise: "KK", call: "" }
    }, "3OD-4.3 vs 3IA-4.2.json");

    expect(document.learned).toBe(true);
    expect(document.player_positions).toEqual({ A: "OOP", B: "IP" });
    expect(parseRangeText(document.A.raise)).toMatchObject({ AA: 1, AKs: 0.5 });
    expect(document.A.call).toBe("AQs:0.250");
  });

  it("maps legacy run statuses into review and run layers", () => {
    const document = normalizePreflopRangeDocument({
      status: "running",
      A: { raise: "AA", call: "" },
      B: { raise: "", call: "KK" }
    });

    expect(document.status).toBe("approved");
    expect(document.reviewStatus).toBe("approved");
    expect(document.runStatus).toBe("running");
    expect(document.learned).toBe(true);
  });

  it("serializes only range content and leaves status out of range files", () => {
    const serialized = serializePreflopRangeDocument(normalizePreflopRangeDocument({
      learned: true,
      status: "solved",
      reviewStatus: "approved",
      runStatus: "solved",
      A: { raise: "AA", call: "" },
      B: { raise: "", call: "KK" }
    }));
    const saved = JSON.parse(serialized) as Record<string, unknown>;

    expect(saved).not.toHaveProperty("learned");
    expect(saved).not.toHaveProperty("status");
    expect(saved).not.toHaveProperty("reviewStatus");
    expect(saved).not.toHaveProperty("runStatus");
    expect(saved.A).toEqual({ raise: "AA", call: "" });
    expect(saved.B).toEqual({ raise: "", call: "KK" });
  });

  it("summarizes raise, call, and fold percentages for both players", () => {
    const summary = summarizePreflopRange({
      player_names: { A: "HERO", B: "VILLAIN" },
      player_positions: { A: "Unknown", B: "Unknown" },
      learned: false,
      A: { raise: "AA", call: "" },
      B: { raise: "", call: "AKs:0.500" }
    });

    expect(summary.players.A.stats.raise).toBeCloseTo(0.5, 1);
    expect(summary.players.B.stats.call).toBeCloseTo(0.2, 1);
    expect(summary.players.A.matrix.AA.raise).toBe(1);
    expect(summary.players.B.matrix.AKs.call).toBe(0.5);
  });

  it("edits hand frequencies while capping call behind raise", () => {
    const base = normalizePreflopRangeDocument({
      A: { raise: "AA:0.750", call: "AA:0.250" },
      B: { raise: "", call: "" }
    });

    const edited = setPreflopHandFrequency(base, "A", "raise", "AA", 90);
    expect(parseRangeText(edited.A.raise).AA).toBe(0.9);
    expect(parseRangeText(edited.A.call).AA).toBeCloseTo(0.1);
  });
});
