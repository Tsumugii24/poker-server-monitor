export const PREFLOP_RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"] as const;
export type PreflopRank = (typeof PREFLOP_RANKS)[number];

export const PREFLOP_PLAYERS = ["A", "B"] as const;
export type PreflopPlayerKey = (typeof PREFLOP_PLAYERS)[number];

export const PREFLOP_PLAYER_POSITIONS = ["IP", "OOP", "Unknown"] as const;
export type PreflopPlayerPosition = (typeof PREFLOP_PLAYER_POSITIONS)[number];

export const PREFLOP_RANGE_ACTIONS = ["raise", "call"] as const;
export type PreflopRangeAction = (typeof PREFLOP_RANGE_ACTIONS)[number];

export const PREFLOP_RANGE_STATUSES = [
  "under_review",
  "has_problem",
  "approved",
  "queue",
  "running",
  "solved"
] as const;
export type PreflopRangeStatus = (typeof PREFLOP_RANGE_STATUSES)[number];

export type PreflopHandCode = string;

export type PreflopPlayerRange = Record<PreflopRangeAction, string>;

export type PreflopRangeDocument = {
  player_names: Record<PreflopPlayerKey, string>;
  player_positions: Record<PreflopPlayerKey, PreflopPlayerPosition>;
  learned: boolean;
  status: PreflopRangeStatus;
  A: PreflopPlayerRange;
  B: PreflopPlayerRange;
  notes?: string;
  updatedAt?: string;
};

export type PreflopMatrixValue = {
  raise: number;
  call: number;
};

export type PreflopRangeStats = {
  raise: number;
  call: number;
  fold: number;
};

export type PreflopPlayerSummary = {
  name: string;
  position: PreflopPlayerPosition;
  matrix: Record<PreflopHandCode, PreflopMatrixValue>;
  stats: PreflopRangeStats;
};

export type PreflopRangeSummary = {
  data: PreflopRangeDocument;
  players: Record<PreflopPlayerKey, PreflopPlayerSummary>;
};

export type PreflopRangeFileItem = {
  type: "file";
  name: string;
  path: string;
  modified: string;
  size: number;
  label: string;
  learned: boolean;
  status: PreflopRangeStatus;
  rangePct: Record<PreflopPlayerKey, number>;
};

export type PreflopRangeFolderItem = {
  type: "folder";
  name: string;
  path: string;
  children: PreflopRangeTreeItem[];
};

export type PreflopRangeTreeItem = PreflopRangeFileItem | PreflopRangeFolderItem;

export type PreflopRangeTreeResponse = {
  tree: PreflopRangeTreeItem[];
  root: string;
};

export type PreflopRangeFileResponse = {
  path: string;
  modified?: string;
  summary: PreflopRangeSummary;
};

const RANK_SET = new Set<string>(PREFLOP_RANKS);
const TOTAL_COMBOS = 1326;

const DEFAULT_PLAYER_NAMES: Record<PreflopPlayerKey, string> = {
  A: "HERO",
  B: "VILLAIN"
};

const DEFAULT_PLAYER_POSITIONS: Record<PreflopPlayerKey, PreflopPlayerPosition> = {
  A: "Unknown",
  B: "Unknown"
};

export const PREFLOP_HAND_GRID: PreflopHandCode[][] = PREFLOP_RANKS.map((rowRank, rowIndex) =>
  PREFLOP_RANKS.map((colRank, colIndex) => {
    if (rowIndex === colIndex) return `${rowRank}${colRank}`;
    return rowIndex < colIndex ? `${rowRank}${colRank}s` : `${colRank}${rowRank}o`;
  })
);

export const PREFLOP_HAND_CODES: PreflopHandCode[] = PREFLOP_HAND_GRID.flat();

export function createEmptyPreflopRangeDocument(): PreflopRangeDocument {
  return {
    player_names: { ...DEFAULT_PLAYER_NAMES },
    player_positions: { ...DEFAULT_PLAYER_POSITIONS },
    learned: false,
    status: "under_review",
    A: { raise: "", call: "" },
    B: { raise: "", call: "" }
  };
}

export function normalizePreflopRangeDocument(
  value: unknown,
  filename = ""
): PreflopRangeDocument {
  if (!isRecord(value)) {
    throw new Error("Range file must be a JSON object");
  }

  const result = createEmptyPreflopRangeDocument();
  const rawPlayerNames = isRecord(value.player_names) ? value.player_names : {};
  const rawPlayerPositions = isRecord(value.player_positions) ? value.player_positions : {};

  for (const player of PREFLOP_PLAYERS) {
    result.player_names[player] = stringOrDefault(rawPlayerNames[player], DEFAULT_PLAYER_NAMES[player]);
    const position = normalizePosition(rawPlayerPositions[player]);
    result.player_positions[player] = position;
  }

  result.status = normalizeRangeStatus(value.status, Boolean(value.learned));
  result.learned = learnedFromStatus(result.status);

  for (const player of PREFLOP_PLAYERS) {
    const rawPlayer = isRecord(value[player]) ? value[player] : {};
    result[player] = {
      raise: normalizeRangeText(rawPlayer.raise),
      call: normalizeRangeText(rawPlayer.call)
    };
  }

  if (isRecord(value.hands)) {
    mergeModernHandsIntoPlayer(result, value.hands, "A");
  }

  result.player_positions = inferPlayerPositions(result, filename);

  if (typeof value.notes === "string" && value.notes.trim()) {
    result.notes = value.notes;
  }
  if (typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))) {
    result.updatedAt = value.updatedAt;
  }

  return result;
}

export function parsePreflopRangeInput(input: string, fallbackFilename = ""): PreflopRangeDocument {
  const trimmed = input.trim();
  if (!trimmed) return createEmptyPreflopRangeDocument();
  return normalizePreflopRangeDocument(JSON.parse(trimmed) as unknown, fallbackFilename);
}

export function serializePreflopRangeDocument(document: PreflopRangeDocument): string {
  return `${JSON.stringify(
    {
      ...normalizePreflopRangeDocument(document),
      updatedAt: new Date().toISOString()
    },
    null,
    2
  )}\n`;
}

export function summarizePreflopRange(
  document: PreflopRangeDocument,
  filename = ""
): PreflopRangeSummary {
  const data = normalizePreflopRangeDocument(document, filename);
  const positions = inferPlayerPositions(data, filename);
  data.player_positions = positions;

  return {
    data,
    players: {
      A: summarizePlayer(data, "A"),
      B: summarizePlayer(data, "B")
    }
  };
}

export function parseRangeText(value: unknown): Record<PreflopHandCode, number> {
  const values: Record<PreflopHandCode, number> = {};
  if (typeof value !== "string") return values;

  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const [rawHand, rawValue = "1"] = trimmed.split(":").map((part) => part.trim());
    const hand = normalizeHandCode(rawHand ?? "");
    if (!hand) continue;
    const parsedValue = normalizeRangeFrequency(rawValue);
    if (parsedValue > 0) {
      values[hand] = parsedValue;
    }
  }

  return values;
}

export function normalizeRangeText(value: unknown): string {
  const values = parseRangeText(typeof value === "string" ? value : "");
  return PREFLOP_HAND_CODES
    .flatMap((hand) => {
      const frequency = values[hand] ?? 0;
      return frequency > 0 ? [formatRangeValue(hand, frequency)] : [];
    })
    .join(",");
}

export function playerMatrix(playerRange: PreflopPlayerRange): Record<PreflopHandCode, PreflopMatrixValue> {
  const raiseValues = parseRangeText(playerRange.raise);
  const callValues = parseRangeText(playerRange.call);
  const values: Record<PreflopHandCode, PreflopMatrixValue> = {};

  for (const hand of PREFLOP_HAND_CODES) {
    const raise = clampRatio(raiseValues[hand] ?? 0);
    const call = Math.min(1 - raise, clampRatio(callValues[hand] ?? 0));
    values[hand] = { raise, call };
  }

  return values;
}

export function setPreflopHandFrequency(
  document: PreflopRangeDocument,
  player: PreflopPlayerKey,
  action: PreflopRangeAction,
  handCode: PreflopHandCode,
  frequencyPercent: number
): PreflopRangeDocument {
  const hand = normalizeHandCode(handCode);
  if (!hand) return document;

  const normalized = normalizePreflopRangeDocument(document);
  const raiseValues = parseRangeText(normalized[player].raise);
  const callValues = parseRangeText(normalized[player].call);
  const nextValue = clampRatio(frequencyPercent / 100);

  if (action === "raise") {
    if (nextValue <= 0) delete raiseValues[hand];
    else raiseValues[hand] = nextValue;
    if ((callValues[hand] ?? 0) + nextValue > 1) {
      const cappedCall = Math.max(0, 1 - nextValue);
      if (cappedCall <= 0) delete callValues[hand];
      else callValues[hand] = cappedCall;
    }
  } else {
    const maxCall = Math.max(0, 1 - (raiseValues[hand] ?? 0));
    const cappedCall = Math.min(nextValue, maxCall);
    if (cappedCall <= 0) delete callValues[hand];
    else callValues[hand] = cappedCall;
  }

  return {
    ...normalized,
    [player]: {
      raise: formatRangeMap(raiseValues),
      call: formatRangeMap(callValues)
    },
    updatedAt: new Date().toISOString()
  };
}

export function setPreflopPlayerName(
  document: PreflopRangeDocument,
  player: PreflopPlayerKey,
  name: string
): PreflopRangeDocument {
  const normalized = normalizePreflopRangeDocument(document);
  return {
    ...normalized,
    player_names: {
      ...normalized.player_names,
      [player]: name.trim() || DEFAULT_PLAYER_NAMES[player]
    },
    updatedAt: new Date().toISOString()
  };
}

export function setPreflopPlayerPosition(
  document: PreflopRangeDocument,
  player: PreflopPlayerKey,
  position: PreflopPlayerPosition
): PreflopRangeDocument {
  const normalized = normalizePreflopRangeDocument(document);
  return {
    ...normalized,
    player_positions: {
      ...normalized.player_positions,
      [player]: normalizePosition(position)
    },
    updatedAt: new Date().toISOString()
  };
}

export function setPreflopLearned(
  document: PreflopRangeDocument,
  learned: boolean
): PreflopRangeDocument {
  return {
    ...normalizePreflopRangeDocument(document),
    learned,
    status: learned ? "approved" : "under_review",
    updatedAt: new Date().toISOString()
  };
}

export function setPreflopStatus(
  document: PreflopRangeDocument,
  status: PreflopRangeStatus
): PreflopRangeDocument {
  const normalizedStatus = normalizeRangeStatus(status, document.learned);
  return {
    ...normalizePreflopRangeDocument(document),
    status: normalizedStatus,
    learned: learnedFromStatus(normalizedStatus),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeHandCode(value: string): PreflopHandCode | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 3) return null;

  const first = trimmed[0]?.toUpperCase();
  const second = trimmed[1]?.toUpperCase();
  if (!first || !second || !RANK_SET.has(first) || !RANK_SET.has(second)) return null;

  if (first === second) {
    return trimmed.length === 2 ? `${first}${second}` : null;
  }

  const suffix = trimmed[2]?.toLowerCase();
  if (suffix !== "s" && suffix !== "o") return null;

  const firstIndex = PREFLOP_RANKS.indexOf(first as PreflopRank);
  const secondIndex = PREFLOP_RANKS.indexOf(second as PreflopRank);
  const high = firstIndex < secondIndex ? first : second;
  const low = firstIndex < secondIndex ? second : first;
  return `${high}${low}${suffix}`;
}

export function comboCountForHand(hand: PreflopHandCode): number {
  if (hand.length === 2) return 6;
  return hand.endsWith("s") ? 4 : 12;
}

function summarizePlayer(document: PreflopRangeDocument, player: PreflopPlayerKey): PreflopPlayerSummary {
  const matrix = playerMatrix(document[player]);
  const totals = comboTotals(matrix);
  return {
    name: document.player_names[player],
    position: document.player_positions[player],
    matrix,
    stats: {
      raise: roundPercent(totals.raise),
      call: roundPercent(totals.call),
      fold: roundPercent(totals.fold)
    }
  };
}

function comboTotals(matrix: Record<PreflopHandCode, PreflopMatrixValue>): PreflopRangeStats {
  const totals = { raise: 0, call: 0, fold: 0 };
  for (const hand of PREFLOP_HAND_CODES) {
    const value = matrix[hand] ?? { raise: 0, call: 0 };
    const combos = comboCountForHand(hand);
    totals.raise += combos * value.raise;
    totals.call += combos * value.call;
    totals.fold += combos * Math.max(0, 1 - value.raise - value.call);
  }
  return {
    raise: totals.raise / TOTAL_COMBOS * 100,
    call: totals.call / TOTAL_COMBOS * 100,
    fold: totals.fold / TOTAL_COMBOS * 100
  };
}

function formatRangeMap(values: Record<PreflopHandCode, number>): string {
  return PREFLOP_HAND_CODES
    .flatMap((hand) => {
      const value = values[hand] ?? 0;
      return value > 0 ? [formatRangeValue(hand, value)] : [];
    })
    .join(",");
}

function formatRangeValue(hand: PreflopHandCode, value: number): string {
  const normalized = clampRatio(value);
  if (normalized <= 0) return "";
  if (Math.abs(normalized - 1) < 0.0005) return hand;
  return `${hand}:${normalized.toFixed(3)}`;
}

function normalizeRangeFrequency(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).trim().replace("%", ""));
  if (!Number.isFinite(parsed)) return 0;
  if (parsed > 1 && parsed <= 100) return clampRatio(parsed / 100);
  return clampRatio(parsed);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function inferPlayerPositions(
  document: PreflopRangeDocument,
  filename = ""
): Record<PreflopPlayerKey, PreflopPlayerPosition> {
  const positions = { ...document.player_positions };

  for (const player of PREFLOP_PLAYERS) {
    const namePosition = classifyPositionLabel(document.player_names[player]);
    if (namePosition !== "Unknown") positions[player] = namePosition;
  }

  const stem = filename.replace(/\.(json|range)$/i, "");
  const [left, right] = stem.replace(" VS ", " vs ").split(" vs ", 2).map((part) => part.trim());
  if (left && right) {
    const leftPosition = classifyPositionLabel(left);
    const rightPosition = classifyPositionLabel(right);
    if (leftPosition !== "Unknown") positions.A = leftPosition;
    if (rightPosition !== "Unknown") positions.B = rightPosition;
  } else if (stem) {
    const filePosition = classifyPositionLabel(stem);
    if (filePosition !== "Unknown") positions.A = filePosition;
  }

  if (positions.A !== "Unknown" && positions.B === "Unknown") positions.B = oppositePosition(positions.A);
  if (positions.B !== "Unknown" && positions.A === "Unknown") positions.A = oppositePosition(positions.B);
  return positions;
}

function classifyPositionLabel(value: unknown): PreflopPlayerPosition {
  const compact = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.includes("3IA") || compact.includes("SIA")) return "IP";
  if (compact.includes("3OD") || compact.includes("SOD")) return "OOP";
  return "Unknown";
}

function oppositePosition(position: PreflopPlayerPosition): PreflopPlayerPosition {
  if (position === "IP") return "OOP";
  if (position === "OOP") return "IP";
  return "Unknown";
}

function normalizePosition(value: unknown): PreflopPlayerPosition {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "IP" || normalized === "OOP") return normalized;
  return "Unknown";
}

function normalizeRangeStatus(value: unknown, learnedFallback = false): PreflopRangeStatus {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PREFLOP_RANGE_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as PreflopRangeStatus;
  }
  return learnedFallback ? "approved" : "under_review";
}

function learnedFromStatus(status: PreflopRangeStatus): boolean {
  return status === "approved" || status === "queue" || status === "running" || status === "solved";
}

function mergeModernHandsIntoPlayer(
  document: PreflopRangeDocument,
  hands: Record<string, unknown>,
  player: PreflopPlayerKey
): void {
  const raiseValues: Record<PreflopHandCode, number> = parseRangeText(document[player].raise);
  const callValues: Record<PreflopHandCode, number> = parseRangeText(document[player].call);

  for (const [rawHand, rawEntry] of Object.entries(hands)) {
    const hand = normalizeHandCode(rawHand);
    if (!hand) continue;
    const entry = normalizeModernHandEntry(rawEntry);
    if (!entry || entry.frequency <= 0 || entry.action === "fold") continue;
    if (entry.action === "call") {
      callValues[hand] = entry.frequency;
    } else {
      raiseValues[hand] = entry.frequency;
    }
  }

  document[player] = {
    raise: formatRangeMap(raiseValues),
    call: formatRangeMap(callValues)
  };
}

function normalizeModernHandEntry(value: unknown): { action: "fold" | "call" | "raise" | "all-in"; frequency: number } | null {
  if (typeof value === "number") {
    return { action: value > 0 ? "raise" : "fold", frequency: normalizeRangeFrequency(value) };
  }
  if (!isRecord(value)) return null;
  const action = normalizeModernAction(value.action) ?? "raise";
  const rawFrequency = Number(value.frequency ?? 100);
  return {
    action,
    frequency: normalizeRangeFrequency(rawFrequency > 1 ? rawFrequency / 100 : rawFrequency)
  };
}

function normalizeModernAction(value: unknown): "fold" | "call" | "raise" | "all-in" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "fold" || normalized === "f") return "fold";
  if (normalized === "call" || normalized === "c" || normalized === "flat") return "call";
  if (normalized === "raise" || normalized === "r" || normalized === "open" || normalized === "bet") return "raise";
  if (normalized === "all-in" || normalized === "allin" || normalized === "jam" || normalized === "shove") return "all-in";
  return null;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
