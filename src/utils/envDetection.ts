import * as fs from 'fs/promises';
import * as path from 'path';
import { JAC_EXECUTABLE_NIX, JAC_EXECUTABLE_WIN, fileExists, getJacInVenv, COMMON_VENV_NAMES, getKnownPaths } from './envUtils';
import {
    scanVenvManagerRoot, scanToolsDir, scanPythonInstallDir,
    findInUserPipInstalls, findWithSpotlight, findWithUnixFind, walkForVenvs,
    WALK_DEPTH_WORKSPACE,
} from './venvScanner';

// Re-export low-level helpers for backward compatibility.
export { JAC_EXECUTABLE_NIX, JAC_EXECUTABLE_WIN, fileExists, getJacInVenv, COMMON_VENV_NAMES, getKnownPaths } from './envUtils';
export type { KnownPaths } from './envUtils';
export {
    scanVenvManagerRoot, scanToolsDir, scanPythonInstallDir,
    findInUserPipInstalls, findWithSpotlight, findWithUnixFind, walkForVenvs,
} from './venvScanner';

const MAX_CONDA_ENVS = 30;

// ── Public locators ───────────────────────────────────────────────────────────

export async function findInPath(): Promise<string[]> {
    const jacExe   = process.platform === 'win32' ? JAC_EXECUTABLE_WIN : JAC_EXECUTABLE_NIX;
    const pathDirs = [...new Set(process.env.PATH?.split(path.delimiter) ?? [])]; // dedupe (e.g. /usr/bin appears twice on some shells)
    const jacPathHits = await Promise.all(
        pathDirs.map(async (dir) => {
            const candidate = path.join(dir, jacExe);
            return (await fileExists(candidate)) ? candidate : null;
        })
    );
    return jacPathHits.filter((p): p is string => p !== null);
}

export async function findInCondaEnvs(): Promise<string[]> {
    const homeDir  = process.env.HOME || process.env.USERPROFILE || '';
    const envPaths: string[] = [];

    try {
        const condaEnvsText = await fs.readFile(path.join(homeDir, '.conda', 'environments.txt'), 'utf-8');
        envPaths.push(...condaEnvsText.split('\n').map(line => line.trim()).filter(Boolean));
    } catch { /* conda not installed */ }

    const condaRoots = [
        // common install locations per OS / package manager
        path.join(homeDir, 'anaconda3'), path.join(homeDir, 'miniconda3'),
        path.join(homeDir, 'miniforge3'), path.join(homeDir, 'mambaforge'),
        '/opt/anaconda3', '/opt/miniconda3',
        '/opt/homebrew/Caskroom/miniforge/base',
        '/opt/homebrew/Caskroom/mambaforge/base',
    ];
    const rootScans = await Promise.all(condaRoots.map(async (root) => {
        try {
            // each entry under <root>/envs/ is a named conda env (e.g. anaconda3/envs/myenv)
            const entries = await fs.readdir(path.join(root, 'envs'), { withFileTypes: true });
            return entries.filter(e => e.isDirectory()).map(e => path.join(root, 'envs', e.name));
        } catch { return []; }
    }));
    envPaths.push(...rootScans.flat());

    const dedupedCondaPaths = [...new Set(envPaths)].slice(0, MAX_CONDA_ENVS); // cap to avoid scanning hundreds of stale envs
    const jacPathResults    = await Promise.all(dedupedCondaPaths.map(p => getJacInVenv(p)));
    return jacPathResults.filter((p): p is string => p !== null);
}

export async function findInWorkspace(workspaceRoot: string): Promise<string[]> {
    const nativePromise: Promise<string[]> =
        process.platform === 'darwin'
            ? findWithSpotlight(workspaceRoot).then(dirs => Promise.all(dirs.map(d => getJacInVenv(d)))).then(r => r.filter((p): p is string => p !== null)) // mdfind, ~10ms
        : process.platform === 'linux'
            ? findWithUnixFind(workspaceRoot, 4).then(dirs => Promise.all(dirs.map(d => getJacInVenv(d)))).then(r => r.filter((p): p is string => p !== null))  // system find, ~30ms
        : Promise.resolve([]);   // Windows: skip, walkPromise handles it
    const walkPromise = walkForVenvs(workspaceRoot, WALK_DEPTH_WORKSPACE);

    // Common names resolve in ~5 ms — short-circuit if they find anything.
    const fromCommon = (await Promise.all(
        COMMON_VENV_NAMES.map(name => getJacInVenv(path.join(workspaceRoot, name)))
    )).filter((p): p is string => p !== null);

    if (fromCommon.length > 0) {
        // suppress unhandled-rejection warnings — results are intentionally discarded
        nativePromise.catch(() => {});
        walkPromise.catch(() => {});
        return fromCommon;
    }
    const [fromNative, fromWalk] = await Promise.all([nativePromise, walkPromise]);
    return Array.from(new Set([...fromNative, ...fromWalk]));
}

export async function findInHome(): Promise<string[]> {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) { return []; }
    const { venvManagerDirs, toolsDirs, pythonInstallDirs } = getKnownPaths(homeDir);
    const [fromVenvManagers, fromTools, fromPythonInstalls, fromUserPip] = await Promise.all([
        Promise.all(venvManagerDirs.map(d => scanVenvManagerRoot(d))).then(r => r.flat()),  // e.g. ~/.virtualenvs, poetry cache
        Promise.all(toolsDirs.map(d => scanToolsDir(d))).then(r => r.flat()),               // e.g. uv tools, pipx
        Promise.all(pythonInstallDirs.map(d => scanPythonInstallDir(d))).then(r => r.flat()), // e.g. ~/.pyenv/versions
        findInUserPipInstalls(homeDir),                                                       // e.g. ~/Library/Python/3.11/bin/jac
    ]);
    return Array.from(new Set([...fromVenvManagers, ...fromTools, ...fromPythonInstalls, ...fromUserPip]));
}

// ── Validation ────────────────────────────────────────────────────────────────

export async function validateJacExecutable(jacPath: string): Promise<boolean> {
    if (path.isAbsolute(jacPath)) { return fileExists(jacPath); }
    // relative name (e.g. plain 'jac') — search every $PATH dir
    const pathDirs = process.env.PATH?.split(path.delimiter) ?? [];
    const checks   = await Promise.all(pathDirs.map(dir => fileExists(path.join(dir, jacPath))));
    return checks.some(Boolean);
}

// ── Programmatic API ──────────────────────────────────────────────────────────

export async function findPythonEnvsWithJac(workspaceRoot: string = process.cwd()): Promise<string[]> {
    const results = await Promise.allSettled([
        findInPath(), findInCondaEnvs(), findInWorkspace(workspaceRoot), findInHome(),
    ]);
    const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []); // allSettled: one failing locator doesn't block the others
    return Array.from(new Set(all));
}
