import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import type { Dirent } from 'fs';
import { fileExists, getJacInVenv } from './envUtils';

export const WALK_DEPTH_WORKSPACE = 3;
const WALK_DIR_BUDGET = 80; // max dirs visited per walk (prevents runaway scans in large repos)

const SKIP_DIRS = new Set([
    'node_modules', '.git', '__pycache__', 'site-packages',
    'dist', 'build', '.cache', '.npm', '.yarn',
]);

// ── Venv-manager store scanners ───────────────────────────────────────────────

/**
 * Scans a venv-manager store directory (e.g. ~/.virtualenvs, poetry cache).
 * Uses `pyvenv.cfg` as a guard to avoid false positives.
 */
export async function scanVenvManagerRoot(managerDir: string): Promise<string[]> {
    let entries: Dirent[];
    try { entries = await fs.readdir(managerDir, { withFileTypes: true }); }
    catch { return []; }

    const subDirs   = entries.filter(e => e.isDirectory()).map(e => path.join(managerDir, e.name));
    const jacPaths  = await Promise.all(subDirs.map(async (venvDir) => {
        const isVenv = await fileExists(path.join(venvDir, 'pyvenv.cfg'));
        return isVenv ? getJacInVenv(venvDir) : null;
    }));
    return jacPaths.filter((p): p is string => p !== null);
}

/**
 * Scans a tool-installer directory (uv tool / pipx) where each
 * sub-directory is a named-tool environment.
 */
export async function scanToolsDir(toolsDir: string): Promise<string[]> {
    let entries: Dirent[];
    try { entries = await fs.readdir(toolsDir, { withFileTypes: true }); }
    catch { return []; }

    const subDirs  = entries.filter(e => e.isDirectory()).map(e => path.join(toolsDir, e.name));
    // no pyvenv.cfg guard here — tool dirs (e.g. uv tools/jaclang) skip the cfg
    const jacPaths = await Promise.all(subDirs.map(venvDir => getJacInVenv(venvDir)));
    return jacPaths.filter((p): p is string => p !== null);
}

/**
 * Scans a Python-version install directory (pyenv / uv python).
 * Handles both direct installs and pyenv-virtualenv nested envs
 * (`<version>/envs/<name>/bin/jac`).
 */
export async function scanPythonInstallDir(installDir: string): Promise<string[]> {
    let entries: Dirent[];
    try { entries = await fs.readdir(installDir, { withFileTypes: true }); }
    catch { return []; }

    const subDirs = entries.filter(e => e.isDirectory()).map(e => path.join(installDir, e.name));
    const versionJacPaths = await Promise.all(subDirs.map(async (versionDir) => {
        const jacPathsForVersion: string[] = [];

        // Direct install: e.g. ~/.pyenv/versions/3.11.0/bin/jac
        const directJacPath = await getJacInVenv(versionDir);
        if (directJacPath) { jacPathsForVersion.push(directJacPath); }

        // pyenv-virtualenv: <version>/envs/<name>/bin/jac
        try {
            const envsDir           = path.join(versionDir, 'envs');
            const envEntries        = await fs.readdir(envsDir, { withFileTypes: true });
            const virtualenvJacPaths = await Promise.all(
                envEntries.filter(e => e.isDirectory())
                          .map(e => getJacInVenv(path.join(envsDir, e.name)))
            );
            jacPathsForVersion.push(...virtualenvJacPaths.filter((p): p is string => p !== null));
        } catch { /* envs/ doesn't exist for plain Python versions — normal */ }

        return jacPathsForVersion;
    }));
    return versionJacPaths.flat();
}

/**
 * Finds `jac` installed via `pip install --user`.
 *   macOS   → ~/Library/Python/X.Y/bin/jac
 *   Linux   → ~/.local/bin/jac
 *   Windows → %APPDATA%\Python\PythonXY\Scripts\jac.exe
 */
export async function findInUserPipInstalls(homeDir: string): Promise<string[]> {
    if (process.platform === 'darwin') {
        const libPyDir = path.join(homeDir, 'Library', 'Python');
        let entries: Dirent[];
        try { entries = await fs.readdir(libPyDir, { withFileTypes: true }); }
        catch { return []; }
        const results = await Promise.all(
            entries.filter(e => e.isDirectory()).map(async (e) => {
                const jac = path.join(libPyDir, e.name, 'bin', 'jac');
                return (await fileExists(jac)) ? jac : null;
            })
        );
        return results.filter((p): p is string => p !== null);
    }

    if (process.platform === 'linux') {
        const jac = path.join(homeDir, '.local', 'bin', 'jac');
        return (await fileExists(jac)) ? [jac] : [];
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? '';
        const pyBase  = path.join(appData, 'Python');
        let entries: Dirent[];
        try { entries = await fs.readdir(pyBase, { withFileTypes: true }); }
        catch { return []; }
        const results = await Promise.all(
            entries.filter(e => e.isDirectory()).map(async (e) => {
                const jac = path.join(pyBase, e.name, 'Scripts', 'jac.exe');
                return (await fileExists(jac)) ? jac : null;
            })
        );
        return results.filter((p): p is string => p !== null);
    }

    return [];
}

// ── Platform-native deep search ───────────────────────────────────────────────

/**
 * macOS Spotlight — queries the kernel metadata index, zero FS I/O
 * inside the workspace. Returns parent directories of every `pyvenv.cfg`.
 */
export function findWithSpotlight(searchRoot: string): Promise<string[]> {
    return new Promise((resolve) => {
        execFile('mdfind', ['kMDItemFSName == pyvenv.cfg', '-onlyin', searchRoot],
            { timeout: 1500 }, (err, stdout) => {
                if (err || !stdout.trim()) { resolve([]); return; }
                resolve(stdout.trim().split('\n').map(l => path.dirname(l.trim())).filter(Boolean));
            });
    });
}

/**
 * Linux `find` — faster than async JS readdir for large directory trees.
 * Returns parent directories of every `pyvenv.cfg`.
 */
export function findWithUnixFind(searchRoot: string, maxDepth = 4): Promise<string[]> {
    return new Promise((resolve) => {
        execFile('find', [searchRoot, '-maxdepth', String(maxDepth), '-name', 'pyvenv.cfg'],
            { timeout: 3000 }, (_err, stdout) => {
                if (!stdout?.trim()) { resolve([]); return; }
                resolve(stdout.trim().split('\n').map(l => path.dirname(l.trim())).filter(Boolean));
            });
    });
}

// ── JS directory walker ────────────────────────────────────────────────────────

/**
 * Shallow JS directory walk — safety net for newly created / unindexed
 * and custom-named envs not covered by the native search strategies.
 * A shared `budget` object caps total directories visited across recursions.
 */
export async function walkForVenvs(
    baseDir: string,
    depth: number,
    budget: { remaining: number } = { remaining: WALK_DIR_BUDGET }
): Promise<string[]> {
    if (depth === 0 || budget.remaining <= 0) { return []; }

    let entries: Dirent[];
    try { entries = await fs.readdir(baseDir, { withFileTypes: true }); }
    catch { return []; }

    const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name));
    budget.remaining -= dirs.length; // deduct before recursing to keep the budget shared across all levels

    const results = await Promise.all(dirs.map(async (entry) => {
        const fullPath = path.join(baseDir, entry.name);
        const isVenv   = await fileExists(path.join(fullPath, 'pyvenv.cfg')); // presence of pyvenv.cfg = valid venv root
        if (isVenv) {
            const found = await getJacInVenv(fullPath);
            return found ? [found] : [];
        }
        return depth > 1 ? walkForVenvs(fullPath, depth - 1, budget) : [];
    }));

    return results.flat();
}
