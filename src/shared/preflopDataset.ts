import type { SolverScenario } from "./solverJobs";

export function datasetNameFromRangePath(rangePath: string, scenario: SolverScenario): string {
  const stem = (rangePath.split("/").at(-1) ?? rangePath)
    .replace(/\.(json|range|txt)$/i, "")
    .replace(/\s+\d+$/g, "");
  const tokens = [...stem.matchAll(/\b(3ia|3od|sia|sod|soa|sid)[-\s_]*(\d+(?:\.\d+)?)/gi)]
    .map((match) => `${match[1]!.toLowerCase()}-${trimNumericLabel(match[2]!)}`);
  const byPrefix = new Map(tokens.map((token) => [token.split("-")[0], token]));

  if (scenario === "3ia-3od") {
    const name = [byPrefix.get("3ia"), byPrefix.get("3od")].filter(Boolean).join("-");
    return name || fallbackDatasetName(stem);
  }
  if (scenario.startsWith("sia-sod")) {
    const base = [byPrefix.get("sia"), byPrefix.get("sod")].filter(Boolean).join("-");
    return base || fallbackDatasetName(stem);
  }
  if (scenario === "soa-sid") {
    const name = [byPrefix.get("soa"), byPrefix.get("sid")].filter(Boolean).join("-");
    return name || fallbackDatasetName(stem);
  }

  return fallbackDatasetName(stem);
}

export function scenarioFromRangePath(rangePath: string): SolverScenario {
  const normalized = rangePath.toLowerCase();
  if (normalized.includes("3ia") || normalized.includes("3od")) return "3ia-3od";
  if (normalized.includes("soa") || normalized.includes("sid")) return "soa-sid";
  if (normalized.includes("sod/2.5bb")) return "sia-sod-open2.5";
  if (normalized.includes("sod/2bb")) return "sia-sod-open2";
  if (normalized.includes("sod/3bb")) return "sia-sod-open3";
  if (normalized.includes("open2.5")) return "sia-sod-open2.5";
  if (normalized.includes("open2")) return "sia-sod-open2";
  if (normalized.includes("open3")) return "sia-sod-open3";
  return "sia-sod";
}

function fallbackDatasetName(stem: string): string {
  return stem.toLowerCase()
    .replace(/\bvs\b/g, "-")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function trimNumericLabel(value: string): string {
  return value.replace(/\.0$/, "");
}
