import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SOLVER_SCENARIO_LIBRARY,
  type SolverScenarioLibraryItem,
  type SolverScenarioLibraryResponse
} from "../shared/solverJobs";

type ScenarioLibraryFile = {
  version: 1;
  updatedAt: string;
  scenarios: SolverScenarioLibraryItem[];
};

export function loadSolverScenarioLibrary(filename = "config/solver-scenarios.json"): SolverScenarioLibraryResponse {
  const fullPath = path.resolve(filename);
  if (!fs.existsSync(fullPath)) {
    return {
      scenarios: normalizeScenarioLibrary(DEFAULT_SOLVER_SCENARIO_LIBRARY),
      updatedAt: null
    };
  }

  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  const scenarios = isRecord(raw) && Array.isArray(raw.scenarios)
    ? normalizeScenarioLibrary(raw.scenarios)
    : normalizeScenarioLibrary(raw);
  return {
    scenarios,
    updatedAt: isRecord(raw) && typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

export function saveSolverScenarioLibrary(
  filename: string,
  scenarios: SolverScenarioLibraryItem[]
): SolverScenarioLibraryResponse {
  const normalized = normalizeScenarioLibrary(scenarios);
  const updatedAt = new Date().toISOString();
  const fullPath = path.resolve(filename);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const payload: ScenarioLibraryFile = {
    version: 1,
    updatedAt,
    scenarios: normalized
  };
  fs.writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    scenarios: normalized,
    updatedAt
  };
}

export function addSolverScenario(
  filename: string,
  scenario: SolverScenarioLibraryItem
): SolverScenarioLibraryResponse {
  const current = loadSolverScenarioLibrary(filename).scenarios;
  const normalized = normalizeScenario(scenario);
  if (current.some((item) => item.id === normalized.id)) {
    throw new Error(`Scenario ${normalized.id} already exists.`);
  }
  return saveSolverScenarioLibrary(filename, [...current, normalized]);
}

export function updateSolverScenario(
  filename: string,
  id: string,
  scenario: SolverScenarioLibraryItem
): SolverScenarioLibraryResponse {
  const current = loadSolverScenarioLibrary(filename).scenarios;
  const normalized = normalizeScenario(scenario);
  const index = current.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`Scenario ${id} not found.`);
  }
  if (normalized.id !== id && current.some((item) => item.id === normalized.id)) {
    throw new Error(`Scenario ${normalized.id} already exists.`);
  }
  const next = current.slice();
  next[index] = normalized;
  return saveSolverScenarioLibrary(filename, next);
}

export function deleteSolverScenario(filename: string, id: string): SolverScenarioLibraryResponse {
  const current = loadSolverScenarioLibrary(filename).scenarios;
  if (!current.some((item) => item.id === id)) {
    throw new Error(`Scenario ${id} not found.`);
  }
  return saveSolverScenarioLibrary(filename, current.filter((item) => item.id !== id));
}

function normalizeScenarioLibrary(value: unknown): SolverScenarioLibraryItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Scenario library must be an array.");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const scenario = normalizeScenario(item);
    if (seen.has(scenario.id)) {
      throw new Error(`Duplicate scenario id ${scenario.id}.`);
    }
    seen.add(scenario.id);
    if (index > 200) {
      throw new Error("Scenario library is too large.");
    }
    return scenario;
  });
}

function normalizeScenario(value: unknown): SolverScenarioLibraryItem {
  if (!isRecord(value)) {
    throw new Error("Scenario must be an object.");
  }
  const id = requiredScenarioId(value.id, "scenario.id");
  const label = requiredTrimmedString(value.label ?? id, "scenario.label");
  const rangeSubdir = requiredScenarioId(value.rangeSubdir ?? id, "scenario.rangeSubdir");
  const configTemplate = requiredConfigTemplate(value.configTemplate, "scenario.configTemplate");
  const pot = requiredPositiveNumber(value.pot, "scenario.pot");
  const effectiveStack = requiredPositiveNumber(value.effectiveStack, "scenario.effectiveStack");
  const description = typeof value.description === "string" ? value.description.trim() : "";
  return {
    id,
    label,
    rangeSubdir,
    configTemplate,
    pot,
    effectiveStack,
    ...(description ? { description } : {})
  };
}

function requiredScenarioId(value: unknown, field: string): string {
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

function requiredConfigTemplate(value: unknown, field: string): string {
  const text = requiredTrimmedString(value, field);
  if (!/^[A-Z0-9_]+$/.test(text)) {
    throw new Error(`${field} must use uppercase letters, numbers and underscores.`);
  }
  return text;
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function requiredPositiveNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
