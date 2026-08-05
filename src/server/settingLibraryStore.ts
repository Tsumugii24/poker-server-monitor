import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SOLVER_SETTING_LIBRARY,
  SOLVER_SETTING_TEMPLATE_PLACEHOLDERS,
  allSolverBetSizeRules,
  buildSolverSettingConfigTemplate,
  expandLegacySolverSettingTemplate,
  normalizeSolverSettingRangeFolderPath,
  normalizeSolverSettingRangeFolderPaths,
  solverBetSizeRuleKey,
  solverBetSizeRuleIsSupported,
  solverSettingParametersFromTemplate,
  type SolverBetSizeRule,
  type SolverSettingLibraryItem,
  type SolverSettingLibraryResponse,
  type SolverSettingParameters
} from "../shared/solverSettings";

type SettingLibraryFile = {
  version: 2;
  updatedAt: string;
  settings: SolverSettingLibraryItem[];
};

export function loadSolverSettingLibrary(
  filename = "config/solver-settings.json",
  legacyFilename = defaultLegacyScenarioFilename(filename)
): SolverSettingLibraryResponse {
  const fullPath = path.resolve(filename);
  if (!fs.existsSync(fullPath)) {
    const legacyPath = path.resolve(legacyFilename);
    if (legacyPath !== fullPath && fs.existsSync(legacyPath)) {
      const legacy = readSettingLibraryFile(legacyPath);
      const migrated = saveSolverSettingLibrary(filename, legacy.settings);
      return { ...migrated, migratedFrom: legacyPath };
    }
    return {
      settings: normalizeSettingLibrary(DEFAULT_SOLVER_SETTING_LIBRARY),
      updatedAt: null
    };
  }
  return readSettingLibraryFile(fullPath);
}

export function saveSolverSettingLibrary(
  filename: string,
  settings: SolverSettingLibraryItem[]
): SolverSettingLibraryResponse {
  const normalized = normalizeSettingLibrary(settings);
  const updatedAt = new Date().toISOString();
  const fullPath = path.resolve(filename);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const payload: SettingLibraryFile = {
    version: 2,
    updatedAt,
    settings: normalized
  };
  fs.writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { settings: normalized, updatedAt };
}

export function addSolverSetting(
  filename: string,
  setting: unknown
): SolverSettingLibraryResponse {
  const current = loadSolverSettingLibrary(filename).settings;
  const normalized = normalizeSolverSetting(setting);
  if (current.some((item) => item.id === normalized.id)) {
    throw new Error(`Setting ${normalized.id} already exists.`);
  }
  return saveSolverSettingLibrary(filename, [...current, normalized]);
}

export function updateSolverSetting(
  filename: string,
  id: string,
  setting: unknown
): SolverSettingLibraryResponse {
  const current = loadSolverSettingLibrary(filename).settings;
  const normalized = normalizeSolverSetting(setting);
  const index = current.findIndex((item) => item.id === id);
  if (index === -1) throw new Error(`Setting ${id} not found.`);
  if (normalized.id !== id && current.some((item) => item.id === normalized.id)) {
    throw new Error(`Setting ${normalized.id} already exists.`);
  }
  const next = current.slice();
  next[index] = normalized;
  return saveSolverSettingLibrary(filename, next);
}

export function deleteSolverSetting(filename: string, id: string): SolverSettingLibraryResponse {
  const current = loadSolverSettingLibrary(filename).settings;
  if (!current.some((item) => item.id === id)) throw new Error(`Setting ${id} not found.`);
  if (current.length === 1) throw new Error("Setting Library must keep at least one setting.");
  return saveSolverSettingLibrary(filename, current.filter((item) => item.id !== id));
}

export function duplicateSolverSetting(
  filename: string,
  sourceId: string,
  nextId: string
): SolverSettingLibraryResponse {
  const current = loadSolverSettingLibrary(filename).settings;
  const source = current.find((item) => item.id === sourceId);
  if (!source) throw new Error(`Setting ${sourceId} not found.`);
  return addSolverSetting(filename, {
    ...source,
    id: nextId,
    label: `${source.label} Copy`,
    rangeFolderPaths: [],
    rangeSubdir: ""
  });
}

export function normalizeSolverSetting(value: unknown): SolverSettingLibraryItem {
  if (!isRecord(value)) throw new Error("Setting must be an object.");
  const id = requiredSettingId(value.id, "setting.id");
  const label = requiredTrimmedString(value.label ?? id, "setting.label");
  const builtIn = DEFAULT_SOLVER_SETTING_LIBRARY.find((setting) => setting.id === id);
  const legacyRangeSubdir = typeof value.rangeSubdir === "string"
    ? normalizeSolverSettingRangeFolderPath(value.rangeSubdir)
    : "";
  const rawRangeFolderPaths = Array.isArray(value.rangeFolderPaths)
    ? value.rangeFolderPaths
    : builtIn?.rangeFolderPaths ?? (legacyRangeSubdir ? [legacyRangeSubdir] : []);
  if (rawRangeFolderPaths.some((folderPath) => typeof folderPath !== "string")) {
    throw new Error("setting.rangeFolderPaths must contain only folder paths.");
  }
  if (rawRangeFolderPaths.length > 100) throw new Error("A Setting cannot link more than 100 Range folders.");
  const rangeFolderPaths = normalizeSolverSettingRangeFolderPaths(rawRangeFolderPaths as string[]);
  if (rangeFolderPaths.length !== rawRangeFolderPaths.filter((folderPath) => String(folderPath).trim()).length) {
    const invalid = rawRangeFolderPaths.find((folderPath) =>
      String(folderPath).trim() && !normalizeSolverSettingRangeFolderPath(String(folderPath))
    );
    if (invalid != null) throw new Error(`Invalid Range folder path: ${String(invalid)}`);
  }
  const rangeSubdir = rangeFolderPaths[0] ?? "";
  const legacyTemplate = expandLegacySolverSettingTemplate(
    typeof value.configTemplate === "string" && value.configTemplate.trim()
      ? value.configTemplate
      : DEFAULT_SOLVER_SETTING_LIBRARY[0]!.configTemplate
  );
  const parameters = normalizeSolverSettingParameters(
    value.parameters,
    solverSettingParametersFromTemplate(legacyTemplate)
  );
  const configTemplate = validatedConfigTemplate(
    buildSolverSettingConfigTemplate({ parameters }),
    "setting.configTemplate"
  );
  const pot = requiredPositiveNumber(value.pot, "setting.pot");
  const effectiveStack = requiredPositiveNumber(value.effectiveStack, "setting.effectiveStack");
  const description = typeof value.description === "string" ? value.description.trim() : "";
  return {
    id,
    label,
    rangeFolderPaths,
    rangeSubdir,
    configTemplate,
    pot,
    effectiveStack,
    parameters,
    ...(description ? { description } : {})
  };
}

export type SolverSettingFolderLinkChange = {
  id: string;
  label: string;
  previousPaths: string[];
  nextPaths: string[];
};

export function renameSolverSettingRangeFolderLinks(
  filename: string,
  previousPath: string,
  nextPath: string
): SolverSettingLibraryResponse & { changes: SolverSettingFolderLinkChange[] } {
  return mutateSolverSettingRangeFolderLinks(filename, previousPath, nextPath);
}

export function deleteSolverSettingRangeFolderLinks(
  filename: string,
  deletedPath: string
): SolverSettingLibraryResponse & { changes: SolverSettingFolderLinkChange[] } {
  return mutateSolverSettingRangeFolderLinks(filename, deletedPath, null);
}

function mutateSolverSettingRangeFolderLinks(
  filename: string,
  previousPathValue: string,
  nextPathValue: string | null
): SolverSettingLibraryResponse & { changes: SolverSettingFolderLinkChange[] } {
  const previousPath = normalizeSolverSettingRangeFolderPath(previousPathValue);
  const nextPath = nextPathValue == null ? null : normalizeSolverSettingRangeFolderPath(nextPathValue);
  if (!previousPath || (nextPathValue != null && !nextPath)) throw new Error("Range folder link path is invalid.");
  const current = loadSolverSettingLibrary(filename).settings;
  const changes: SolverSettingFolderLinkChange[] = [];
  const settings = current.map((setting) => {
    const previousPaths = setting.rangeFolderPaths;
    const rewritten = previousPaths.flatMap((folderPath) => {
      if (!pathIsSameOrInside(folderPath, previousPath)) return [folderPath];
      if (nextPath == null) return [];
      return [`${nextPath}${folderPath.slice(previousPath.length)}`];
    });
    const nextPaths = normalizeSolverSettingRangeFolderPaths(rewritten);
    if (sameStringArray(previousPaths, nextPaths)) return setting;
    changes.push({ id: setting.id, label: setting.label, previousPaths, nextPaths });
    return { ...setting, rangeFolderPaths: nextPaths, rangeSubdir: nextPaths[0] ?? "" };
  });
  if (changes.length === 0) {
    const loaded = loadSolverSettingLibrary(filename);
    return { ...loaded, changes };
  }
  return { ...saveSolverSettingLibrary(filename, settings), changes };
}

function normalizeSolverSettingParameters(
  value: unknown,
  fallback: SolverSettingParameters
): SolverSettingParameters {
  if (value == null) return fallback;
  if (!isRecord(value)) throw new Error("setting.parameters must be an object.");
  const inputRules = Array.isArray(value.betSizeRules) ? value.betSizeRules : fallback.betSizeRules;
  const rulesByKey = new Map<string, SolverBetSizeRule>();
  for (const inputRule of inputRules) {
    if (!isRecord(inputRule)) throw new Error("Each bet-size rule must be an object.");
    const position = inputRule.position === "oop" || inputRule.position === "ip" ? inputRule.position : null;
    const street = inputRule.street === "flop" || inputRule.street === "turn" || inputRule.street === "river"
      ? inputRule.street
      : null;
    const action = inputRule.action === "bet" || inputRule.action === "raise" || inputRule.action === "donk" || inputRule.action === "allin"
      ? inputRule.action
      : null;
    if (!position || !street || !action) throw new Error("Bet-size rule position, street, or action is invalid.");
    // Older Setting files included a Donk placeholder for every position and
    // street, and could even enable OOP Flop Donk. Those combinations are not
    // part of the solver model, so omit them while normalizing legacy data.
    if (!solverBetSizeRuleIsSupported(position, street, action)) continue;
    const enabled = Boolean(inputRule.enabled);
    const sizes = action === "allin" ? [] : normalizeSolverBetSizes(inputRule.sizes);
    if (enabled && action !== "allin" && sizes.length === 0) {
      throw new Error(`${position} ${street} ${action} requires at least one size when enabled.`);
    }
    const key = solverBetSizeRuleKey(position, street, action);
    if (rulesByKey.has(key)) throw new Error(`Duplicate bet-size rule ${key}.`);
    rulesByKey.set(key, { position, street, action, enabled, sizes });
  }
  const fallbackByKey = new Map(fallback.betSizeRules.map((rule) => [
    solverBetSizeRuleKey(rule.position, rule.street, rule.action),
    rule
  ]));
  return {
    betSizeRules: allSolverBetSizeRules().map((emptyRule) => {
      const key = solverBetSizeRuleKey(emptyRule.position, emptyRule.street, emptyRule.action);
      return rulesByKey.get(key) ?? fallbackByKey.get(key) ?? emptyRule;
    }),
    allinThreshold: numberInRange(value.allinThreshold, fallback.allinThreshold, 0, 1, "setting.parameters.allinThreshold"),
    raiseLimit: positiveInteger(value.raiseLimit, fallback.raiseLimit, "setting.parameters.raiseLimit"),
    accuracy: requiredPositiveNumber(value.accuracy ?? fallback.accuracy, "setting.parameters.accuracy"),
    maxIteration: positiveInteger(value.maxIteration, fallback.maxIteration, "setting.parameters.maxIteration"),
    printInterval: positiveInteger(value.printInterval, fallback.printInterval, "setting.parameters.printInterval"),
    useIsomorphism: typeof value.useIsomorphism === "boolean" ? value.useIsomorphism : fallback.useIsomorphism,
    enableRange: typeof value.enableRange === "boolean" ? value.enableRange : fallback.enableRange
  };
}

function normalizeSolverBetSizes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const sizes = value.map(Number);
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0 || size > 100_000)) {
    throw new Error("Bet sizes must be positive numbers no greater than 100000.");
  }
  return [...new Set(sizes)].sort((left, right) => left - right);
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer.`);
  return number;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return number;
}

function readSettingLibraryFile(filename: string): SolverSettingLibraryResponse {
  const raw = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  const values = isRecord(raw) && Array.isArray(raw.settings)
    ? raw.settings
    : isRecord(raw) && Array.isArray(raw.scenarios)
      ? raw.scenarios
      : raw;
  return {
    settings: normalizeSettingLibrary(values),
    updatedAt: isRecord(raw) && typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

function normalizeSettingLibrary(value: unknown): SolverSettingLibraryItem[] {
  if (!Array.isArray(value)) throw new Error("Setting library must be an array.");
  if (value.length > 200) throw new Error("Setting library is too large.");
  const seen = new Set<string>();
  const linkedFolders = new Map<string, string>();
  return value.map((item) => {
    const setting = normalizeSolverSetting(item);
    if (seen.has(setting.id)) throw new Error(`Duplicate setting id ${setting.id}.`);
    seen.add(setting.id);
    for (const folderPath of setting.rangeFolderPaths) {
      const key = folderPath.toLowerCase().replace(/\s*-\s*/g, "-");
      const owner = linkedFolders.get(key);
      if (owner) throw new Error(`Range folder ${folderPath} is already linked to Setting ${owner}.`);
      linkedFolders.set(key, setting.id);
    }
    return setting;
  });
}

function validatedConfigTemplate(value: unknown, field: string): string {
  const template = expandLegacySolverSettingTemplate(requiredTrimmedString(value, field));
  if (template.length > 100_000) throw new Error(`${field} is too large.`);
  const placeholders = [...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
  const expected = new Set<string>(SOLVER_SETTING_TEMPLATE_PLACEHOLDERS);
  const unknown = [...new Set(placeholders.filter((placeholder) => !expected.has(placeholder)))];
  const missing = SOLVER_SETTING_TEMPLATE_PLACEHOLDERS.filter((placeholder) => !placeholders.includes(placeholder));
  if (unknown.length > 0) throw new Error(`${field} has unsupported placeholders: ${unknown.join(", ")}.`);
  if (missing.length > 0) throw new Error(`${field} is missing placeholders: ${missing.join(", ")}.`);
  return template.endsWith("\n") ? template : `${template}\n`;
}

function requiredSettingId(value: unknown, field: string): string {
  const text = requiredTrimmedString(value, field);
  if (
    text.length > 96 ||
    text.startsWith(".") ||
    text.endsWith(".") ||
    text.startsWith("-") ||
    text.endsWith("-") ||
    text.includes("..") ||
    text.includes("--") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)
  ) {
    throw new Error(`${field} must use letters, numbers, '.', '_' or '-' and cannot start/end with '.' or '-'.`);
  }
  return text;
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required.`);
  return value.trim();
}

function requiredPositiveNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number.`);
  return parsed;
}

function defaultLegacyScenarioFilename(filename: string): string {
  const fullPath = path.resolve(filename);
  return path.join(path.dirname(fullPath), "solver-scenarios.json");
}

function pathIsSameOrInside(value: string, parent: string): boolean {
  const normalizedValue = normalizeSolverSettingRangeFolderPath(value).toLowerCase();
  const normalizedParent = normalizeSolverSettingRangeFolderPath(parent).toLowerCase();
  return normalizedValue === normalizedParent || normalizedValue.startsWith(`${normalizedParent}/`);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
