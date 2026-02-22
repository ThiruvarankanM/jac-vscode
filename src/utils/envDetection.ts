// Backward-compatible barrel re-export.
// Existing imports work without change; new code should import directly from:
//   ./fsUtils        — fileExists, getJacInVenv
//   ./platformPaths  — getKnownPaths, KnownPaths, COMMON_VENV_NAMES
//   ./venvScanner    — low-level directory scanners
//   ./envLocators    — public discovery API (findIn*, validateJacExecutable)

export { JAC_EXECUTABLE_NIX, JAC_EXECUTABLE_WIN, fileExists, getJacInVenv } from './fsUtils';
export { COMMON_VENV_NAMES, getKnownPaths } from './platformPaths';
export type { KnownPaths } from './platformPaths';
export {
    scanVenvManagerRoot, scanToolsDir, scanPythonInstallDir,
    findInUserPipInstalls, findWithSpotlight, findWithUnixFind, walkForVenvs,
} from './venvScanner';
export {
    findInPath, findInCondaEnvs, findInWorkspace, findInHome,
    validateJacExecutable, findPythonEnvsWithJac,
} from './envLocators';
