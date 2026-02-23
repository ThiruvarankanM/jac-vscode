import * as fs from 'fs/promises';
import * as path from 'path';

// ── Constants ────────────────────────────────────────────────────────────────
const JAC_EXECUTABLE_NIX = 'jac';
const JAC_EXECUTABLE_WIN = 'jac.exe';

// Common venv folder names to check first before doing a full directory scan.
const COMMON_VENV_NAMES = ['.venv', 'venv', 'env', '.env', 'virtualenv', 'pyenv'];

// How deep to recurse when scanning for venvs. Kept at 2 to stay fast.
const WALK_DEPTH_WORKSPACE = 2;
const WALK_DEPTH_VIRTUALENVS = 2;

// Stop after checking this many conda envs. Prevents slow scans when
// ~/.conda/environments.txt has accumulated hundreds of old entries.
const MAX_CONDA_ENVS = 30;



// Looks for the jac binary inside a venv folder.
// Checks both Unix (bin/jac) and Windows (Scripts/jac.exe) at the same time
// so it works on both platforms without needing a platform-specific branch.
async function getJacInVenv(venvPath: string): Promise<string | null> {
    const nix = path.join(venvPath, 'bin',     JAC_EXECUTABLE_NIX);
    const win = path.join(venvPath, 'Scripts', JAC_EXECUTABLE_WIN);
    const [nixOk, winOk] = await Promise.all([fileExists(nix), fileExists(win)]);
    if (nixOk) { return nix; }
    if (winOk) { return win; }
    return null;
}

// Recursively walks baseDir up to depth levels, collecting jac executable paths.
// Stops recursing into a directory once jac is found there.
async function walkForVenvs(baseDir: string, depth: number): Promise<string[]> {
    if (depth === 0) return [];

    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const results = await Promise.all(
        entries
            .filter(entry => entry.isDirectory())
            .map(async (entry): Promise<string[]> => {
                const fullPath = path.join(baseDir, entry.name);
                const foundJac = await getJacInVenv(fullPath);
                if (foundJac) { return [foundJac]; }
                return depth > 1 ? walkForVenvs(fullPath, depth - 1) : [];
            })
    );
    return results.flat();
}

// ── The four environment locators ───────────────────────────────────────────
// All four run in parallel from startBackgroundDiscovery() so no single one
// blocks the others.  Same approach as Python extension:
//   src/client/pythonEnvironments/base/locators/common/nativePythonFinder.ts

// Locator 1 — scans every $PATH directory for a jac binary (~5 ms).
// Usually the first to finish because PATH dirs are already in the OS cache.
export async function findInPath(): Promise<string[]> {
    const jacExe = process.platform === 'win32' ? JAC_EXECUTABLE_WIN : JAC_EXECUTABLE_NIX;
    const pathDirectories = [...new Set(process.env.PATH?.split(path.delimiter) ?? [])];
    const searchResults = await Promise.all(
        pathDirectories.map(async (directory) => {
            const jacPath = path.join(directory, jacExe);
            return (await fileExists(jacPath)) ? jacPath : null;
        })
    );
    return searchResults.filter((foundPath): foundPath is string => foundPath !== null);
}

// Locator 2 — finds conda environments.
// Reads ~/.conda/environments.txt (one file read, ~1 ms) instead of running
// `conda env list` which spawns a subprocess (~500 ms).
// Falls back to scanning known conda install locations if the file is missing.
// Same approach as Python extension:
//   src/client/pythonEnvironments/common/environmentManagers/conda.ts
export async function findInCondaEnvs(): Promise<string[]> {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const envPaths: string[] = [];

    // environments.txt lists every conda env as an absolute path, one per line.
    try {
        const text = await fs.readFile(path.join(homeDir, '.conda', 'environments.txt'), 'utf-8');
        envPaths.push(...text.split('\n').map(line => line.trim()).filter(Boolean));
    } catch { /* conda not installed or file absent — normal on first run */ }

    // Scan known conda install roots for envs/ subdirectory.
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
            return entries.filter(condaEntry => condaEntry.isDirectory()).map(condaEntry => path.join(root, 'envs', condaEntry.name));
        } catch { return []; }
    }));
    envPaths.push(...rootScans.flat());

    const deduped = [...new Set(envPaths)].slice(0, MAX_CONDA_ENVS);
    const jacResults = await Promise.all(deduped.map(condaEnvPath => getJacInVenv(condaEnvPath)));
    return jacResults.filter((jacPath): jacPath is string => jacPath !== null);
}

// Locator 3 — finds venvs inside the open workspace.
// Step 1: check common names like .venv, venv, env directly (~5 ms).
//         If found, return immediately — no directory walk needed.
// Step 2: only if step 1 found nothing, do a full directory walk (depth 2).
//         This covers custom-named venvs while staying fast for the common case.
// Same approach as Python extension:
//   src/client/pythonEnvironments/common/environmentManagers/simplevirtualenvs.ts
export async function findInWorkspace(workspaceRoot: string): Promise<string[]> {
    // Step 1 — check well-known names first.
    const fromCommon = (await Promise.all(
        COMMON_VENV_NAMES.map(name => getJacInVenv(path.join(workspaceRoot, name)))
    )).filter((foundPath): foundPath is string => foundPath !== null);

    if (fromCommon.length > 0) { return fromCommon; }

    // Step 2 — fall back to a directory walk for custom-named envs.
    return walkForVenvs(workspaceRoot, WALK_DEPTH_WORKSPACE);
}

// Locator 4 — finds venvs in home-directory tool stores
// (virtualenvwrapper, poetry, pipenv, pipx, uv).
// A shallow 2-level scan is enough because each tool puts envs one level
// inside its store folder (e.g. ~/.virtualenvs/myenv/bin/jac).
// Same approach as Python extension:
//   src/client/pythonEnvironments/common/environmentManagers/simplevirtualenvs.ts
export async function findInHome(): Promise<string[]> {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) return [];

    const venvStoreDirs = [
        path.join(homeDir, '.virtualenvs'),                       // virtualenvwrapper
        path.join(homeDir, '.venvs'),                             // some tools default
        path.join(homeDir, '.local', 'share', 'virtualenvs'),     // pipenv
        path.join(homeDir, '.local', 'pipx', 'venvs'),            // pipx
    ];

    const results = await Promise.all(
        venvStoreDirs.map(async (storeDir) => {
            if (!(await directoryExists(storeDir))) return [];
            return walkForVenvs(storeDir, WALK_DEPTH_VIRTUALENVS);
        })
    );
    return results.flat();
}


// ── Utility Helpers ──────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function directoryExists(dirPath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(dirPath);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

// Checks that a jac executable exists on disk (~1 ms, no subprocess).
// Previously ran `jac --version` which took 200–500 ms and visibly slowed
// cold start and every QuickPick open. File existence is enough — we just
// need to confirm it's there before handing the path to the LSP.
export async function validateJacExecutable(jacPath: string): Promise<boolean> {
    if (path.isAbsolute(jacPath)) { return fileExists(jacPath); }
    // bare name (e.g. 'jac') — scan every $PATH dir in parallel
    const pathDirectories = process.env.PATH?.split(path.delimiter) ?? [];
    const existenceChecks = await Promise.all(pathDirectories.map(directory => fileExists(path.join(directory, jacPath))));
    return existenceChecks.some(Boolean);
}