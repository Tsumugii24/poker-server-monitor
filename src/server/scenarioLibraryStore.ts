/**
 * Legacy Scenario Library compatibility surface.
 * New code should use settingLibraryStore and the /api/solver-settings routes.
 */
import type {
  SolverScenarioLibraryItem,
  SolverScenarioLibraryResponse
} from "../shared/solverJobs";
import {
  addSolverSetting,
  deleteSolverSetting,
  loadSolverSettingLibrary,
  saveSolverSettingLibrary,
  updateSolverSetting
} from "./settingLibraryStore";
import {
  SOLVER_SETTING_TEMPLATE_PRESETS,
  buildSolverSettingConfigTemplate,
  solverSettingParametersFromTemplate
} from "../shared/solverSettings";

function legacyResponse(response: ReturnType<typeof loadSolverSettingLibrary>): SolverScenarioLibraryResponse {
  return {
    scenarios: response.settings.map((setting) => ({
      ...setting,
      configTemplate: Object.entries(SOLVER_SETTING_TEMPLATE_PRESETS)
        .find(([, template]) =>
          template === setting.configTemplate ||
          buildSolverSettingConfigTemplate({ parameters: solverSettingParametersFromTemplate(template) }) === setting.configTemplate
        )?.[0] ?? setting.configTemplate
    })),
    updatedAt: response.updatedAt
  };
}

export function loadSolverScenarioLibrary(filename = "config/solver-scenarios.json"): SolverScenarioLibraryResponse {
  return legacyResponse(loadSolverSettingLibrary(filename, filename));
}

export function saveSolverScenarioLibrary(
  filename: string,
  scenarios: SolverScenarioLibraryItem[]
): SolverScenarioLibraryResponse {
  return legacyResponse(saveSolverSettingLibrary(filename, scenarios));
}

export function addSolverScenario(
  filename: string,
  scenario: SolverScenarioLibraryItem
): SolverScenarioLibraryResponse {
  return legacyResponse(addSolverSetting(filename, scenario));
}

export function updateSolverScenario(
  filename: string,
  id: string,
  scenario: SolverScenarioLibraryItem
): SolverScenarioLibraryResponse {
  return legacyResponse(updateSolverSetting(filename, id, scenario));
}

export function deleteSolverScenario(filename: string, id: string): SolverScenarioLibraryResponse {
  return legacyResponse(deleteSolverSetting(filename, id));
}
