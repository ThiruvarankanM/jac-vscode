import * as fs from 'fs/promises';
import * as path from 'path';
import { JAC_EXECUTABLE_NIX, JAC_EXECUTABLE_WIN, fileExists, getJacInVenv } from './fsUtils';
import { COMMON_VENV_NAMES, getKnownPaths } from './platformPaths';
import {
    scanVenvManagerRoot, scanToolsDir, scanPythonInstallDir,
    findInUserPipInstalls, findWithSpotlight, findWithUnixFind, walkForVenvs,
    WALK_DEPTH_WORKSPACE,
} from './venvScanner';

// Re-export low-level helpers for backward compatibility.
export { JAC_EXECUTABLE_NIX, JAC_EXECUTABLE_WIN, fileExists, getJacInVenv } from './fsUtils';
export { COMMON_VENV_NAMES, getKnownPaths } from './platformPaths';
export type { KnownPaths } from './platformPaths';
export {
    scanVenvManagerRoot, scanToolsDir, scanPythonInstallDir,
    findInUserPipInstalls, findWithSpotlight, findWithUnixFind, walkForVenvs,
} from './venvScanner';

const MAX_CONDA_ENVS = 30;

// ── Public locators ───────────────────────────────────────────────────────────

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

export async function findInCondaEnvs(): Promise<string[]> {
    const homeDir  = process.env.HOME || process.env.USERPROFILE || '';
    const envPaths: string[] = [];

    try {
        const txt = await fs.readFile(path.join(homeDir, '.conda', 'environments.txt'), 'utf-8');
        envPaths.push(...txt.split('\n').map(l => l.trim()).filter(Boolean));
    } catch { /* conda not installed */ }

    const condaRoots = [
        path.join(homeDir, 'anaconda3'), path.join(homeDir, 'miniconda3'),
        path.join(homeDir, 'miniforge3'), path.join(homeDir, 'mambaforge'),
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

export async function findInWorkspace(workspaceRoot: string): Promise<string[]> {
    const nativePromise: Promise<string[]> =
        process.platform === 'darwin'
            ? findWithSpotlight(workspaceRoot).then(dirs => Promise.all(dirs.map(d => getJacInVenv(d)))).then(r => r.filter((p): p is string => p !== null))
        : process.platform === 'linux'
            ? findWithUnixFind(workspaceRoot, 4).then(dirs => Promise.all(dirs.map(d => getJacInVenv(d)))).then(r => r.filter((p): p is string => p !== null))
        : Promise.resolve([]);
    const walkPromise = walkForVenvs(workspaceRoot, WALK_DEPTH_WORKSPACE);

    // Common names resolve in ~5 ms — short-circuit if they find anything.
    const fromCommon = (await Promise.all(
        COMMON_VENV_NAMES.map(name => getJacInVenv(path.join(workspaceRoot, name)))
    )).filter((p): p is string => p !== null);

    if (fromCommon.length > 0) {
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
        Promise.all(venvManagerDirs.map(d => scanVenvManagerRoot(d))).then(r => r.flat()),
        Promise.all(toolsDirs.map(d => scanToolsDir(d))).then(r => r.flat()),
        Promise.all(pythonInstallDirs.map(d => scanPythonInstallDir(d))).then(r => r.flat()),
        findInUserPipInstalls(homeDir),
    ]);
    return Array.from(new Set([...fromVenvManagers, ...fromTools, ...fromPythonInstalls, ...fromUserPip]));
}

// ── Validation ────────────────────────────────────────────────────────────────

export async function validateJacExecutable(jacPath: string): Promise<boolean> {
    if (path.isAbsolute(jacPath)) { return fileExists(jacPath); }
    const pathDirs = process.env.PATH?.split(path.delimiter) ?? [];
    const checks   = await Promise.all(pathDirs.map(dir => fileExists(path.join(dir, jacPath))));
    return checks.some(Boolean);
}

// ── Programmatic API ──────────────────────────────────────────────────────────

export async function findPythonEnvsWithJac(workspaceRoot: string = process.cwd()): Promise<string[]> {
    const results = await Promise.allSettled([
        findInPath(), findInCondaEnvs(), findInWorkspace(workspaceRoot), findInHome(),
    ]);
    const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    return Array.from(new Set(all));
}
