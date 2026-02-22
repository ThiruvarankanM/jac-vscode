import * as fs from 'fs/promises';
import * as path from 'path';
import { JAC_EXECUTABLE_NIX, JAC_EXECUTABLE_WIN, fileExists, getJacInVenv } from './fsUtils';
import { COMMON_VENV_NAMES, getKnownPaths } from './platformPaths';
import {
    scanVenvManagerRoot, scanToolsDir, scanPythonInstallDir,
    findInUserPipInstalls, findWithSpotlight, findWithUnixFind, walkForVenvs,
    WALK_DEPTH_WORKSPACE,
} from './venvScanner';

const MAX_CONDA_ENVS = 30;

// ── Public locators ───────────────────────────────────────────────────────────

/**
 * Finds `jac` executables available on the system PATH.
 */
export async function findInPath(): Promise<string[]> {
    const jacExe   = process.platform === 'win32' ? JAC_EXECUTABLE_WIN : JAC_EXECUTABLE_NIX;
    const pathDirs = [...new Set(process.env.PATH?.split(path.delimiter) ?? [])];
    const hits = await Promise.all(
        pathDirs.map(async (dir) => {
            const p = path.join(dir, jacExe);
            return (await fileExists(p)) ? p : null;
        })
    );
    return hits.filter((p): p is string => p !== null);
}

/**
 * Finds `jac` in all known conda environments.
 * Reads `~/.conda/environments.txt` and scans common conda root directories.
 */
export async function findInCondaEnvs(): Promise<string[]> {
    const homeDir  = process.env.HOME || process.env.USERPROFILE || '';
    const envPaths: string[] = [];

    try {
        const txt = await fs.readFile(path.join(homeDir, '.conda', 'environments.txt'), 'utf-8');
        envPaths.push(...txt.split('\n').map(l => l.trim()).filter(Boolean));
    } catch { /* conda not installed */ }

    const condaRoots = [
        path.join(homeDir, 'anaconda3'),
        path.join(homeDir, 'miniconda3'),
        path.join(homeDir, 'miniforge3'),
        path.join(homeDir, 'mambaforge'),
        '/opt/anaconda3', '/opt/miniconda3',
        '/opt/homebrew/Caskroom/miniforge/base',
        '/opt/homebrew/Caskroom/mambaforge/base',
    ];
    const rootScans = await Promise.all(condaRoots.map(async (root) => {
        try {
            const entries = await fs.readdir(path.join(root, 'envs'), { withFileTypes: true });
            return entries.filter(e => e.isDirectory()).map(e => path.join(root, 'envs', e.name));
        } catch { return []; }
    }));
    envPaths.push(...rootScans.flat());

    const unique  = [...new Set(envPaths)].slice(0, MAX_CONDA_ENVS);
    const results = await Promise.all(unique.map(p => getJacInVenv(p)));
    return results.filter((p): p is string => p !== null);
}

/**
 * Finds `jac` in virtual environments inside a workspace root.
 * Runs three strategies in parallel:
 *   1. Common venv names (.venv, venv, env, …)
 *   2. Platform-native search (Spotlight on macOS, `find` on Linux)
 *   3. Shallow JS directory walk (safety net for unindexed / custom names)
 */
export async function findInWorkspace(workspaceRoot: string): Promise<string[]> {
    // Start native/walk immediately so they're already running in the background.
    let nativePromise: Promise<string[]>;
    if (process.platform === 'darwin') {
        nativePromise = findWithSpotlight(workspaceRoot)
            .then(dirs => Promise.all(dirs.map(d => getJacInVenv(d))))
            .then(r => r.filter((p): p is string => p !== null));
    } else if (process.platform === 'linux') {
        nativePromise = findWithUnixFind(workspaceRoot, 4)
            .then(dirs => Promise.all(dirs.map(d => getJacInVenv(d))))
            .then(r => r.filter((p): p is string => p !== null));
    } else {
        nativePromise = Promise.resolve([]);
    }
    const walkPromise = walkForVenvs(workspaceRoot, WALK_DEPTH_WORKSPACE);

    // Common names resolve in ~5 ms — short-circuit if they find anything
    // so we don't block on mdfind/find (up to 1.5 s) when .venv already exists.
    const fromCommon = (await Promise.all(
        COMMON_VENV_NAMES.map(name => getJacInVenv(path.join(workspaceRoot, name)))
    )).filter((p): p is string => p !== null);

    if (fromCommon.length > 0) {
        // Silence floating promises — they resolve to [] on error so no unhandled rejection,
        // but explicit suppression makes the intent clear.
        nativePromise.catch(() => {});
        walkPromise.catch(() => {});
        return fromCommon;
    }

    const [fromNative, fromWalk] = await Promise.all([nativePromise, walkPromise]);
    return Array.from(new Set([...fromNative, ...fromWalk]));
}

/**
 * Finds `jac` in all home-directory virtual environments.
 * Runs four strategies in parallel:
 *   1. Venv-manager stores (virtualenvwrapper, poetry, pipenv, hatch, pdm, tox, nox…)
 *   2. Tool installs (uv tool, pipx)
 *   3. Python version installs (pyenv, uv python)
 *   4. pip install --user
 */
export async function findInHome(): Promise<string[]> {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) { return []; }

    const { venvManagerDirs, toolsDirs, pythonInstallDirs } = getKnownPaths(homeDir);

    const [fromVenvManagers, fromTools, fromPythonInstalls, fromUserPip] = await Promise.all([
        Promise.all(venvManagerDirs.map(d => scanVenvManagerRoot(d))).then(r => r.flat()),
        Promise.all(toolsDirs.map(d => scanToolsDir(d))).then(r => r.flat()),
        Promise.all(pythonInstallDirs.map(d => scanPythonInstallDir(d))).then(r => r.flat()),
        findInUserPipInstalls(homeDir),
    ]);

    return Array.from(new Set([...fromVenvManagers, ...fromTools, ...fromPythonInstalls, ...fromUserPip]));
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Returns `true` when `jacPath` points to an existing executable —
 * either as an absolute path or resolvable on the system PATH.
 */
export async function validateJacExecutable(jacPath: string): Promise<boolean> {
    if (path.isAbsolute(jacPath)) { return fileExists(jacPath); }
    const pathDirs = process.env.PATH?.split(path.delimiter) ?? [];
    const checks   = await Promise.all(pathDirs.map(dir => fileExists(path.join(dir, jacPath))));
    return checks.some(Boolean);
}

// ── Programmatic API ──────────────────────────────────────────────────────────

/**
 * Runs all four locators in parallel and returns a deduplicated list of
 * all found `jac` executables. Used by tests and external callers.
 */
export async function findPythonEnvsWithJac(workspaceRoot: string = process.cwd()): Promise<string[]> {
    const results = await Promise.allSettled([
        findInPath(),
        findInCondaEnvs(),
        findInWorkspace(workspaceRoot),
        findInHome(),
    ]);
    const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    return Array.from(new Set(all));
}
