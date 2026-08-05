export type SolverSettingId = string;

export const SOLVER_SETTING_POSITIONS = ["oop", "ip"] as const;
export const SOLVER_SETTING_STREETS = ["flop", "turn", "river"] as const;
export const SOLVER_SETTING_ACTIONS = ["bet", "raise", "donk", "allin"] as const;

export type SolverSettingPosition = (typeof SOLVER_SETTING_POSITIONS)[number];
export type SolverSettingStreet = (typeof SOLVER_SETTING_STREETS)[number];
export type SolverSettingAction = (typeof SOLVER_SETTING_ACTIONS)[number];

export type SolverBetSizeRule = {
  position: SolverSettingPosition;
  street: SolverSettingStreet;
  action: SolverSettingAction;
  enabled: boolean;
  sizes: number[];
};

export type SolverSettingParameters = {
  betSizeRules: SolverBetSizeRule[];
  allinThreshold: number;
  raiseLimit: number;
  accuracy: number;
  maxIteration: number;
  printInterval: number;
  useIsomorphism: boolean;
  enableRange: boolean;
};

export type SolverSettingLibraryItem = {
  id: SolverSettingId;
  label: string;
  /** Range Library folders linked to this Setting. A parent path includes all descendants. */
  rangeFolderPaths: string[];
  /** @deprecated Use rangeFolderPaths. Retained for stored-job and API compatibility. */
  rangeSubdir: string;
  configTemplate: string;
  pot: number;
  effectiveStack: number;
  parameters: SolverSettingParameters;
  description?: string;
};

export type SolverSettingLibraryResponse = {
  settings: SolverSettingLibraryItem[];
  updatedAt: string | null;
  migratedFrom?: string;
};

export const SOLVER_SETTING_TEMPLATE_PLACEHOLDERS = [
  "pot",
  "effective_stack",
  "board",
  "range_oop",
  "range_ip",
  "estimate_memory_line",
  "thread_num",
  "dump_format",
  "output_file"
] as const;

export const DEFAULT_SOLVER_SETTING_PARAMETERS: Omit<SolverSettingParameters, "betSizeRules"> = {
  allinThreshold: 0.67,
  raiseLimit: 3,
  accuracy: 1,
  maxIteration: 300,
  printInterval: 10,
  useIsomorphism: true,
  enableRange: true
};

export const SIA_SOD_CONFIG_TEMPLATE = `set_pot {pot}
set_effective_stack {effective_stack}
set_board {board}
set_range_oop {range_oop}
set_range_ip {range_ip}
set_bet_sizes oop,flop,bet,33
set_bet_sizes oop,flop,raise,50,100
set_bet_sizes oop,flop,allin
set_bet_sizes ip,flop,bet,30,50,70
set_bet_sizes ip,flop,raise,50
set_bet_sizes ip,flop,allin
set_bet_sizes oop,turn,bet,25,50,75,150
set_bet_sizes oop,turn,raise,150
set_bet_sizes oop,turn,donk,33
set_bet_sizes oop,turn,allin
set_bet_sizes ip,turn,bet,50,80,150
set_bet_sizes ip,turn,raise,75
set_bet_sizes ip,turn,allin
set_bet_sizes oop,river,bet,30,50,75,125,200
set_bet_sizes oop,river,raise,75,175
set_bet_sizes oop,river,donk,33
set_bet_sizes oop,river,allin
set_bet_sizes ip,river,bet,30,50,75,125,200
set_bet_sizes ip,river,raise,75,175
set_bet_sizes ip,river,allin
set_allin_threshold 0.5
set_raise_limit 3
build_tree
{estimate_memory_line}
set_thread_num {thread_num}
set_accuracy {accuracy}
set_max_iteration {max_iteration}
set_print_interval {print_interval}
set_use_isomorphism {use_isomorphism}
set_enable_range 1
start_solve
set_dump_format {dump_format}
set_dump_rounds 1
dump_result {output_file}
`;

export const SOA_SID_CONFIG_TEMPLATE = `set_pot {pot}
set_effective_stack {effective_stack}
set_board {board}
set_range_oop {range_oop}
set_range_ip {range_ip}
set_bet_sizes oop,flop,bet,25,50,75
set_bet_sizes oop,flop,raise,50,100
set_bet_sizes oop,flop,allin
set_bet_sizes ip,flop,bet,25,50,75
set_bet_sizes ip,flop,raise,50,100
set_bet_sizes ip,flop,allin
set_bet_sizes oop,turn,bet,25,50,75,125
set_bet_sizes oop,turn,raise,50,100
set_bet_sizes oop,turn,donk,33
set_bet_sizes oop,turn,allin
set_bet_sizes ip,turn,bet,25,50,75,125
set_bet_sizes ip,turn,raise,50,100
set_bet_sizes ip,turn,allin
set_bet_sizes oop,river,bet,25,50,75,125,200
set_bet_sizes oop,river,raise,75,150
set_bet_sizes oop,river,donk,33
set_bet_sizes oop,river,allin
set_bet_sizes ip,river,bet,25,50,75,125,200
set_bet_sizes ip,river,raise,75,150
set_bet_sizes ip,river,allin
set_allin_threshold 0.67
set_raise_limit 3
build_tree
{estimate_memory_line}
set_thread_num {thread_num}
set_accuracy {accuracy}
set_max_iteration {max_iteration}
set_print_interval {print_interval}
set_use_isomorphism {use_isomorphism}
set_enable_range 1
start_solve
set_dump_format {dump_format}
set_dump_rounds 1
dump_result {output_file}
`;

export const TOA_TID_CONFIG_TEMPLATE = `set_pot {pot}
set_effective_stack {effective_stack}
set_board {board}
set_range_oop {range_oop}
set_range_ip {range_ip}
set_bet_sizes oop,flop,bet,33
set_bet_sizes oop,flop,raise,35,55,75
set_bet_sizes oop,flop,allin
set_bet_sizes ip,flop,bet,20,33,50,75
set_bet_sizes ip,flop,raise,35,75
set_bet_sizes ip,flop,allin
set_bet_sizes oop,turn,bet,33,50,75,150
set_bet_sizes oop,turn,raise,33,50,75
set_bet_sizes oop,turn,donk,33
set_bet_sizes oop,turn,allin
set_bet_sizes ip,turn,bet,33,50,75,125
set_bet_sizes ip,turn,raise,33,50,75
set_bet_sizes ip,turn,allin
set_bet_sizes oop,river,bet,33,50,75,150
set_bet_sizes oop,river,raise,33,50,75
set_bet_sizes oop,river,donk,33
set_bet_sizes oop,river,allin
set_bet_sizes ip,river,bet,33,50,75,125
set_bet_sizes ip,river,raise,33,50,75
set_bet_sizes ip,river,allin
set_allin_threshold 0.67
set_raise_limit 3
build_tree
{estimate_memory_line}
set_thread_num {thread_num}
set_accuracy {accuracy}
set_max_iteration {max_iteration}
set_print_interval {print_interval}
set_use_isomorphism {use_isomorphism}
set_enable_range 1
start_solve
set_dump_format {dump_format}
set_dump_rounds 1
dump_result {output_file}
`;

export const SOLVER_SETTING_TEMPLATE_PRESETS = {
  SIA_SOD_CONFIG: SIA_SOD_CONFIG_TEMPLATE,
  SOA_SID_CONFIG: SOA_SID_CONFIG_TEMPLATE,
  TOA_TID_CONFIG: TOA_TID_CONFIG_TEMPLATE
} as const;

export const DEFAULT_SOLVER_SETTING_LIBRARY: SolverSettingLibraryItem[] = [
  {
    id: "sia-sod",
    label: "SIA vs SOD",
    rangeFolderPaths: ["SIA"],
    rangeSubdir: "SIA",
    configTemplate: SIA_SOD_CONFIG_TEMPLATE,
    pot: 5,
    effectiveStack: 98,
    parameters: solverSettingParametersFromTemplate(SIA_SOD_CONFIG_TEMPLATE),
    description: "Default single-raised SIA/SOD setting."
  },
  {
    id: "sia-sod-open2",
    label: "SIA vs SOD Open 2",
    rangeFolderPaths: ["SOD/2BB"],
    rangeSubdir: "SOD/2BB",
    configTemplate: SIA_SOD_CONFIG_TEMPLATE,
    pot: 4,
    effectiveStack: 98,
    parameters: solverSettingParametersFromTemplate(SIA_SOD_CONFIG_TEMPLATE),
    description: "SIA/SOD open-size setting using open2 defaults."
  },
  {
    id: "sia-sod-open2.5",
    label: "SIA vs SOD Open 2.5",
    rangeFolderPaths: ["SOD/2.5BB"],
    rangeSubdir: "SOD/2.5BB",
    configTemplate: SIA_SOD_CONFIG_TEMPLATE,
    pot: 5,
    effectiveStack: 98,
    parameters: solverSettingParametersFromTemplate(SIA_SOD_CONFIG_TEMPLATE),
    description: "SIA/SOD open-size setting using open2.5 defaults."
  },
  {
    id: "sia-sod-open3",
    label: "SIA vs SOD Open 3",
    rangeFolderPaths: ["SOD/3BB"],
    rangeSubdir: "SOD/3BB",
    configTemplate: SIA_SOD_CONFIG_TEMPLATE,
    pot: 6,
    effectiveStack: 97,
    parameters: solverSettingParametersFromTemplate(SIA_SOD_CONFIG_TEMPLATE),
    description: "SIA/SOD open-size setting using open3 defaults."
  },
  {
    id: "soa-sid",
    label: "SOA vs SID",
    rangeFolderPaths: ["SOA", "SID"],
    rangeSubdir: "SOA",
    configTemplate: SOA_SID_CONFIG_TEMPLATE,
    pot: 5,
    effectiveStack: 98,
    parameters: solverSettingParametersFromTemplate(SOA_SID_CONFIG_TEMPLATE),
    description: "SOA/SID setting."
  },
  {
    id: "3ia-3od",
    label: "3IA vs 3OD",
    rangeFolderPaths: ["3IA -EP", "3IA-BB", "3OD - EP", "3OD-BB-10bb"],
    rangeSubdir: "3IA -EP",
    configTemplate: TOA_TID_CONFIG_TEMPLATE,
    pot: 16,
    effectiveStack: 92,
    parameters: solverSettingParametersFromTemplate(TOA_TID_CONFIG_TEMPLATE),
    description: "3-bet 3IA/3OD setting."
  }
];

export function solverSettingRangeFolderPaths(
  setting: Pick<SolverSettingLibraryItem, "rangeFolderPaths" | "rangeSubdir">
): string[] {
  const paths = Array.isArray(setting.rangeFolderPaths) && setting.rangeFolderPaths.length > 0
    ? setting.rangeFolderPaths
    : setting.rangeSubdir
      ? [setting.rangeSubdir]
      : [];
  return normalizeSolverSettingRangeFolderPaths(paths);
}

export function normalizeSolverSettingRangeFolderPaths(values: readonly string[]): string[] {
  const normalized = values.flatMap((value) => {
    const path = normalizeSolverSettingRangeFolderPath(value);
    return path ? [path] : [];
  });
  const unique = [...new Map(normalized.map((path) => [path.toLowerCase(), path])).values()]
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  return unique.filter((path, index) => !unique.some((candidate, candidateIndex) =>
    candidateIndex !== index && solverRangePathIsInsideFolder(path, candidate)
  ));
}

export function normalizeSolverSettingRangeFolderPath(value: string): string {
  const normalized = String(value).trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return "";
  return normalized;
}

export function solverRangePathIsInsideFolder(rangePath: string, folderPath: string): boolean {
  const range = canonicalSolverRangeFolderPath(rangePath);
  const folder = canonicalSolverRangeFolderPath(folderPath);
  return Boolean(range && folder) && (range === folder || range.startsWith(`${folder}/`));
}

function canonicalSolverRangeFolderPath(value: string): string {
  return normalizeSolverSettingRangeFolderPath(value).toLowerCase().replace(/\s*-\s*/g, "-");
}

export function solverSettingLinkedFolder(
  setting: Pick<SolverSettingLibraryItem, "rangeFolderPaths" | "rangeSubdir">,
  rangePath: string
): string | null {
  return solverSettingRangeFolderPaths(setting)
    .filter((folderPath) => solverRangePathIsInsideFolder(rangePath, folderPath))
    .sort((left, right) => right.length - left.length)[0] ?? null;
}

export function linkedSolverSettingsForRangePath(
  settings: readonly SolverSettingLibraryItem[],
  rangePath: string
): SolverSettingLibraryItem[] {
  const matches = settings.flatMap((setting) => {
    const folderPath = solverSettingLinkedFolder(setting, rangePath);
    return folderPath ? [{ setting, specificity: folderPath.toLowerCase().length }] : [];
  });
  const bestSpecificity = Math.max(0, ...matches.map((match) => match.specificity));
  return matches.filter((match) => match.specificity === bestSpecificity).map((match) => match.setting);
}

export function expandLegacySolverSettingTemplate(value: string): string {
  return SOLVER_SETTING_TEMPLATE_PRESETS[value as keyof typeof SOLVER_SETTING_TEMPLATE_PRESETS] ?? value;
}

export function solverSettingParametersFromTemplate(templateValue: string): SolverSettingParameters {
  const template = expandLegacySolverSettingTemplate(templateValue);
  const parsedRules = new Map<string, SolverBetSizeRule>();
  for (const line of template.split(/\r?\n/)) {
    const match = line.trim().match(
      /^set_bet_sizes\s+(oop|ip),(flop|turn|river),(bet|raise|donk|allin)(?:,(.*))?$/i
    );
    if (!match) continue;
    const position = match[1]!.toLowerCase() as SolverSettingPosition;
    const street = match[2]!.toLowerCase() as SolverSettingStreet;
    const action = match[3]!.toLowerCase() as SolverSettingAction;
    if (!solverBetSizeRuleIsSupported(position, street, action)) continue;
    const sizes = action === "allin"
      ? []
      : (match[4] ?? "").split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
    parsedRules.set(solverBetSizeRuleKey(position, street, action), {
      position,
      street,
      action,
      enabled: true,
      sizes
    });
  }
  const numericValue = (command: string, fallback: number): number => {
    const match = template.match(new RegExp(`^${command}\\s+([0-9.]+)\\s*$`, "mi"));
    const value = Number(match?.[1]);
    return Number.isFinite(value) ? value : fallback;
  };
  const booleanValue = (command: string, fallback: boolean): boolean => {
    const match = template.match(new RegExp(`^${command}\\s+([01])\\s*$`, "mi"));
    return match ? match[1] === "1" : fallback;
  };
  return {
    betSizeRules: allSolverBetSizeRules().map((rule) =>
      parsedRules.get(solverBetSizeRuleKey(rule.position, rule.street, rule.action)) ?? rule
    ),
    allinThreshold: numericValue("set_allin_threshold", DEFAULT_SOLVER_SETTING_PARAMETERS.allinThreshold),
    raiseLimit: numericValue("set_raise_limit", DEFAULT_SOLVER_SETTING_PARAMETERS.raiseLimit),
    accuracy: numericValue("set_accuracy", DEFAULT_SOLVER_SETTING_PARAMETERS.accuracy),
    maxIteration: numericValue("set_max_iteration", DEFAULT_SOLVER_SETTING_PARAMETERS.maxIteration),
    printInterval: numericValue("set_print_interval", DEFAULT_SOLVER_SETTING_PARAMETERS.printInterval),
    useIsomorphism: booleanValue("set_use_isomorphism", DEFAULT_SOLVER_SETTING_PARAMETERS.useIsomorphism),
    enableRange: booleanValue("set_enable_range", DEFAULT_SOLVER_SETTING_PARAMETERS.enableRange)
  };
}

export function buildSolverSettingConfigTemplate(
  setting: Pick<SolverSettingLibraryItem, "parameters">
): string {
  const parameters = setting.parameters;
  const betSizeLines = parameters.betSizeRules
    .filter((rule) => rule.enabled && solverBetSizeRuleIsSupported(rule.position, rule.street, rule.action))
    .map((rule) => {
      const prefix = `set_bet_sizes ${rule.position},${rule.street},${rule.action}`;
      return rule.action === "allin" || rule.sizes.length === 0
        ? prefix
        : `${prefix},${rule.sizes.map(formatSolverSettingNumber).join(",")}`;
    });
  return [
    "set_pot {pot}",
    "set_effective_stack {effective_stack}",
    "set_board {board}",
    "set_range_oop {range_oop}",
    "set_range_ip {range_ip}",
    ...betSizeLines,
    `set_allin_threshold ${formatSolverSettingNumber(parameters.allinThreshold)}`,
    `set_raise_limit ${formatSolverSettingNumber(parameters.raiseLimit)}`,
    "build_tree",
    "{estimate_memory_line}",
    "set_thread_num {thread_num}",
    `set_accuracy ${formatSolverSettingNumber(parameters.accuracy)}`,
    `set_max_iteration ${formatSolverSettingNumber(parameters.maxIteration)}`,
    `set_print_interval ${formatSolverSettingNumber(parameters.printInterval)}`,
    `set_use_isomorphism ${parameters.useIsomorphism ? 1 : 0}`,
    `set_enable_range ${parameters.enableRange ? 1 : 0}`,
    "start_solve",
    "set_dump_format {dump_format}",
    "set_dump_rounds 1",
    "dump_result {output_file}",
    ""
  ].join("\n");
}

export function allSolverBetSizeRules(): SolverBetSizeRule[] {
  return SOLVER_SETTING_POSITIONS.flatMap((position) =>
    SOLVER_SETTING_STREETS.flatMap((street) =>
      SOLVER_SETTING_ACTIONS.filter((action) => solverBetSizeRuleIsSupported(position, street, action)).map((action) => ({
        position,
        street,
        action,
        enabled: false,
        sizes: []
      }))
    )
  );
}

export function solverBetSizeRuleIsSupported(
  position: SolverSettingPosition,
  street: SolverSettingStreet,
  action: SolverSettingAction
): boolean {
  return action !== "donk" || (position === "oop" && (street === "turn" || street === "river"));
}

export function solverBetSizeRuleKey(
  position: SolverSettingPosition,
  street: SolverSettingStreet,
  action: SolverSettingAction
): string {
  return `${position}.${street}.${action}`;
}

function formatSolverSettingNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
