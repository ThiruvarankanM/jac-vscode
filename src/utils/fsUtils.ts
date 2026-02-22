import * as fs from 'fs/promises';
import * as path from 'path';

export const JAC_EXECUTABLE_NIX = 'jac';
export const JAC_EXECUTABLE_WIN = 'jac.exe';

/**
 * Returns `true` when the given path exists on disk (any file type).
 */
export async function fileExists(filePath: string): Promise<boolean> {
    try { await fs.access(filePath, fs.constants.F_OK); return true; }
    catch { return false; }
}

/**
 * Resolves the `jac` executable inside a virtual-environment root.
 * Checks `bin/jac` (Unix) and `Scripts/jac.exe` (Windows) in parallel.
 * Returns the absolute path or `null` if neither exists.
 */
export async function getJacInVenv(venvPath: string): Promise<string | null> {
    const nix = path.join(venvPath, 'bin',     JAC_EXECUTABLE_NIX);
    const win = path.join(venvPath, 'Scripts',  JAC_EXECUTABLE_WIN);
    const [nixOk, winOk] = await Promise.all([fileExists(nix), fileExists(win)]);
    if (nixOk) { return nix; }
    if (winOk) { return win; }
    return null;
}
