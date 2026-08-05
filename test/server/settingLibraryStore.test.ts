import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SOLVER_SETTING_LIBRARY
} from "../../src/shared/solverSettings";
import {
  addSolverSetting,
  deleteSolverSetting,
  duplicateSolverSetting,
  deleteSolverSettingRangeFolderLinks,
  loadSolverSettingLibrary,
  renameSolverSettingRangeFolderLinks,
  saveSolverSettingLibrary,
  updateSolverSetting
} from "../../src/server/settingLibraryStore";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solver-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("setting library store", () => {
  it("migrates a legacy scenario library and expands symbolic config presets", () => {
    const directory = temporaryDirectory();
    const legacyPath = path.join(directory, "solver-scenarios.json");
    const settingPath = path.join(directory, "solver-settings.json");
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      scenarios: [{
        id: "legacy-setting",
        label: "Legacy Setting",
        rangeSubdir: "legacy-setting",
        configTemplate: "SOA_SID_CONFIG",
        pot: 5,
        effectiveStack: 98
      }]
    }));

    const loaded = loadSolverSettingLibrary(settingPath);

    expect(loaded.migratedFrom).toBe(path.resolve(legacyPath));
    expect(loaded.settings[0]).toMatchObject({
      id: "legacy-setting",
      rangeFolderPaths: ["legacy-setting"],
      configTemplate: expect.stringContaining("set_accuracy 1"),
      parameters: expect.objectContaining({
        allinThreshold: 0.67,
        maxIteration: 300,
        useIsomorphism: true
      })
    });
    expect(JSON.parse(fs.readFileSync(settingPath, "utf8"))).toMatchObject({ version: 2 });
  });

  it("creates, duplicates, and updates complete solving settings", () => {
    const filename = path.join(temporaryDirectory(), "solver-settings.json");
    const source = {
      ...DEFAULT_SOLVER_SETTING_LIBRARY[0]!,
      id: "custom",
      label: "Custom",
      rangeFolderPaths: ["Custom"],
      rangeSubdir: "Custom"
    };

    expect(addSolverSetting(filename, source).settings).toContainEqual(expect.objectContaining({ id: "custom" }));
    expect(duplicateSolverSetting(filename, "custom", "custom-copy").settings).toContainEqual(
      expect.objectContaining({ id: "custom-copy", label: "Custom Copy", rangeFolderPaths: [] })
    );
    const updated = updateSolverSetting(filename, "custom-copy", {
      ...source,
      id: "custom-copy",
      label: "Updated Copy",
      rangeFolderPaths: ["Custom/Nested"],
      rangeSubdir: "Custom/Nested",
      pot: 7,
      effectiveStack: 91
    });
    expect(updated.settings).toContainEqual(expect.objectContaining({
      id: "custom-copy",
      label: "Updated Copy",
      rangeFolderPaths: ["Custom/Nested"],
      rangeSubdir: "Custom/Nested",
      pot: 7,
      effectiveStack: 91
    }));
  });

  it("generates the solver config from structured fields when the client omits config text", () => {
    const filename = path.join(temporaryDirectory(), "solver-settings.json");
    const source = DEFAULT_SOLVER_SETTING_LIBRARY[0]!;
    const settings = addSolverSetting(filename, {
      id: "structured-only",
      label: "Structured Only",
      rangeSubdir: "structured-only",
      pot: 6,
      effectiveStack: 94,
      parameters: {
        ...source.parameters,
        accuracy: 0.25,
        maxIteration: 777
      }
    }).settings;
    const saved = settings.find((setting) => setting.id === "structured-only")!;

    expect(saved.configTemplate).toContain("set_pot {pot}");
    expect(saved.configTemplate).toContain("set_accuracy 0.25");
    expect(saved.configTemplate).toContain("set_max_iteration 777");
  });

  it("removes unsupported Donk rules from legacy saved Settings", () => {
    const filename = path.join(temporaryDirectory(), "solver-settings.json");
    const source = DEFAULT_SOLVER_SETTING_LIBRARY[0]!;
    const saved = addSolverSetting(filename, {
      ...source,
      id: "legacy-donk",
      rangeFolderPaths: [],
      rangeSubdir: "",
      parameters: {
        ...source.parameters,
        betSizeRules: [
          ...source.parameters.betSizeRules,
          { position: "oop", street: "flop", action: "donk", enabled: true, sizes: [25] },
          { position: "ip", street: "turn", action: "donk", enabled: true, sizes: [50] }
        ]
      }
    }).settings.find((setting) => setting.id === "legacy-donk")!;

    expect(saved.parameters.betSizeRules.filter((rule) => rule.action === "donk")).toMatchObject([
      { position: "oop", street: "turn" },
      { position: "oop", street: "river" }
    ]);
    expect(saved.configTemplate).not.toContain("oop,flop,donk");
    expect(saved.configTemplate).not.toContain("ip,turn,donk");
  });

  it("keeps at least one setting available for automatic linking", () => {
    const filename = path.join(temporaryDirectory(), "solver-settings.json");
    saveSolverSettingLibrary(filename, [DEFAULT_SOLVER_SETTING_LIBRARY[0]!]);
    expect(() => deleteSolverSetting(filename, DEFAULT_SOLVER_SETTING_LIBRARY[0]!.id)).toThrow(/at least one/i);
  });

  it("rewrites and removes linked Range folder paths", () => {
    const filename = path.join(temporaryDirectory(), "solver-settings.json");
    const source = DEFAULT_SOLVER_SETTING_LIBRARY[0]!;
    saveSolverSettingLibrary(filename, [{
      ...source,
      rangeFolderPaths: ["SOD", "SID"],
      rangeSubdir: "SOD"
    }]);

    const renamed = renameSolverSettingRangeFolderLinks(filename, "SOD", "Ranges/SOD");
    expect(renamed.changes).toHaveLength(1);
    expect(renamed.settings[0]!.rangeFolderPaths).toEqual(["SID", "Ranges/SOD"]);

    const deleted = deleteSolverSettingRangeFolderLinks(filename, "Ranges");
    expect(deleted.changes).toHaveLength(1);
    expect(deleted.settings[0]!.rangeFolderPaths).toEqual(["SID"]);
  });

  it("rejects invalid structured solver parameters", () => {
    const filename = path.join(temporaryDirectory(), "solver-settings.json");
    expect(() => addSolverSetting(filename, {
      ...DEFAULT_SOLVER_SETTING_LIBRARY[0]!,
      id: "invalid-setting",
      parameters: {
        ...DEFAULT_SOLVER_SETTING_LIBRARY[0]!.parameters,
        accuracy: 0
      }
    })).toThrow(/accuracy must be a positive number/i);
  });
});
