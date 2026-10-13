import type { SolverScenario } from "./solverJobs";

export function datasetNameFromRangePath(rangePath: string): string {
  const stem = (rangePath.split("/").at(-1) ?? rangePath)
    .replace(/\.(json|range|txt)$/i, "");
  const tokenMatches = [...stem.matchAll(DATASET_TOKEN_PATTERN)];
  const tokens = tokenMatches.map((match) => ({
    prefix: match[1]!.toLowerCase(),
    value: `${match[1]!.toLowerCase()}-${trimNumericLabel(match[2]!)}`,
    index: match.index ?? 0
  }));
  const byPrefix = new Map(tokens.map((token) => [token.prefix, token.value]));

  for (const [first, second] of [["3ia", "3od"], ["3oa", "3id"], ["sia", "sod"]] as const) {
    const pair = completePair(byPrefix, first, second);
    if (pair) return addLeadingDatasetPrefix(stem, tokens[0]?.index ?? 0, pair);
  }

  const soaSidPair = sourceOrderedPair(tokens, "soa", "sid");
  if (soaSidPair) return addLeadingDatasetPrefix(stem, tokens[0]?.index ?? 0, soaSidPair);

  // Only apply the legacy trailing-number cleanup after token parsing. This
  // keeps names such as "3ID 5" intact while preserving old fallback names
  // for files that do not contain a recognized player token pair.
  return fallbackDatasetName(stem.replace(/\s+\d+$/g, ""));
}

const DATASET_TOKEN_PATTERN = /\b(3ia|3oa|3id|3od|sia|sod|soa|sid)[-\s_]*(\d+(?:\.\d+)?)/gi;

function completePair(byPrefix: Map<string, string>, first: string, second: string): string | null {
  const firstToken = byPrefix.get(first);
  const secondToken = byPrefix.get(second);
  return firstToken && secondToken ? `${firstToken}-${secondToken}` : null;
}

function sourceOrderedPair(
  tokens: Array<{ prefix: string; value: string; index: number }>,
  first: string,
  second: string
): string | null {
  const pair = tokens.filter((token) => token.prefix === first || token.prefix === second);
  return new Set(pair.map((token) => token.prefix)).size === 2
    ? pair.map((token) => token.value).join("-")
    : null;
}

function addLeadingDatasetPrefix(stem: string, firstTokenIndex: number, datasetName: string): string {
  const prefix = stem
    .slice(0, firstTokenIndex)
    .trim()
    .replace(/[^a-z0-9.]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
  return prefix ? `${prefix}-${datasetName}` : datasetName;
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
    .replace(/\b(\d+)\.0+\b/g, "$1")
    .replace(/\bvs\b/g, "-")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function trimNumericLabel(value: string): string {
  return value.replace(/\.0+$/, "");
}
