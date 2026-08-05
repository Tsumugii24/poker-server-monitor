import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOLVER_SETTING_LIBRARY,
  allSolverBetSizeRules,
  buildSolverSettingConfigTemplate,
  linkedSolverSettingsForRangePath,
  normalizeSolverSettingRangeFolderPaths,
  solverSettingParametersFromTemplate
} from "../../src/shared/solverSettings";

describe("solver Setting Range Folder Links", () => {
  it("uses the most-specific linked folder and lets a parent cover descendants", () => {
    const parent = {
      ...DEFAULT_SOLVER_SETTING_LIBRARY[0]!,
      id: "parent",
      rangeFolderPaths: ["SOD"],
      rangeSubdir: "SOD"
    };
    const child = {
      ...DEFAULT_SOLVER_SETTING_LIBRARY[1]!,
      id: "child",
      rangeFolderPaths: ["SOD/rbb"],
      rangeSubdir: "SOD/rbb"
    };

    expect(linkedSolverSettingsForRangePath([parent, child], "SOD/rbb/range.json").map((setting) => setting.id)).toEqual(["child"]);
    expect(linkedSolverSettingsForRangePath([parent, child], "SOD/other/range.json").map((setting) => setting.id)).toEqual(["parent"]);
    expect(linkedSolverSettingsForRangePath([parent, child], "SID/range.json")).toEqual([]);
  });

  it("removes redundant child links when their parent is selected", () => {
    expect(normalizeSolverSettingRangeFolderPaths(["SOD/rbb", "SOD", "SID"])).toEqual(["SID", "SOD"]);
  });
});

describe("solver Setting bet-size actions", () => {
  it("offers Donk only for OOP Turn and OOP River", () => {
    const donkRules = allSolverBetSizeRules()
      .filter((rule) => rule.action === "donk")
      .map((rule) => `${rule.position}.${rule.street}`);

    expect(donkRules).toEqual(["oop.turn", "oop.river"]);
  });

  it("drops unsupported legacy Donk lines when parsing and generating config", () => {
    const parameters = solverSettingParametersFromTemplate(`set_bet_sizes oop,flop,donk,25
set_bet_sizes oop,turn,donk,33
set_bet_sizes ip,river,donk,50`);
    const config = buildSolverSettingConfigTemplate({
      parameters: {
        ...parameters,
        betSizeRules: [
          ...parameters.betSizeRules,
          { position: "ip", street: "turn", action: "donk", enabled: true, sizes: [75] }
        ]
      }
    });

    expect(config).toContain("set_bet_sizes oop,turn,donk,33");
    expect(config).not.toContain("oop,flop,donk");
    expect(config).not.toContain("ip,turn,donk");
    expect(config).not.toContain("ip,river,donk");
  });
});
