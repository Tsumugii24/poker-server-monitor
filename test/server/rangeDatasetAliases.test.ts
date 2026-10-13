import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SOLVER_SETTING_LIBRARY } from "../../src/shared/solverSettings";
import { rangePathsAreIdenticalAliases } from "../../src/server/solverJobService";

describe("identical Range library aliases", () => {
  let root: string;
  const firstPath = "first/3OA 3.5 VS 3ID 5.json";
  const secondPath = "second/3OA 3.5 VS 3ID 5.json";
  const setting = {
    ...DEFAULT_SOLVER_SETTING_LIBRARY[0]!,
    id: "shared",
    rangeFolderPaths: ["first", "second"]
  };
  const document = {
    player_names: { A: "OOP", B: "IP" },
    player_positions: { A: "OOP", B: "IP" },
    A: { raise: "AA,AKs:0.500", call: "" },
    B: { raise: "", call: "KK:0.250,QQ" }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identical-range-aliases-"));
    for (const relativePath of [firstPath, secondPath]) {
      fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(root, relativePath), JSON.stringify(document));
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("accepts duplicate copies under one canonical name and one linked Setting", () => {
    expect(rangePathsAreIdenticalAliases(root, firstPath, secondPath,
      "3oa-3.5-3id-5", [setting], "shared")).toBe(true);
  });

  it("keeps the collision when an IP hand weight differs", () => {
    fs.writeFileSync(path.join(root, secondPath), JSON.stringify({
      ...document, B: { raise: "", call: "KK:0.500,QQ" }
    }));
    expect(rangePathsAreIdenticalAliases(root, firstPath, secondPath,
      "3oa-3.5-3id-5", [setting], "shared")).toBe(false);
  });

  it("keeps the collision when the folders link to different Settings", () => {
    const otherSetting = { ...setting, id: "other", rangeFolderPaths: ["second"], pot: setting.pot + 1 };
    expect(rangePathsAreIdenticalAliases(root, firstPath, secondPath,
      "3oa-3.5-3id-5", [{ ...setting, rangeFolderPaths: ["first"] }, otherSetting], "shared")).toBe(false);
  });

  it("does not permit explicit reuse of an unrelated dataset name", () => {
    expect(rangePathsAreIdenticalAliases(root, firstPath, secondPath,
      "shared-explicit-name", [setting], "shared")).toBe(false);
  });

  it("keeps ambiguous Setting links and unreadable files blocked", () => {
    expect(rangePathsAreIdenticalAliases(root, firstPath, secondPath,
      "3oa-3.5-3id-5", [setting, { ...setting, id: "other" }], "shared")).toBe(false);
    fs.writeFileSync(path.join(root, secondPath), "broken json");
    expect(rangePathsAreIdenticalAliases(root, firstPath, secondPath,
      "3oa-3.5-3id-5", [setting], "shared")).toBe(false);
  });
});
