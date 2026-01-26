import * as fs from 'fs/promises';
import * as path from 'path';

// JAC EXECUTABLE NAMES
const JAC_EXECUTABLE_NIX = 'jac';
const JAC_EXECUTABLE_WIN = 'jac.exe';

// Check if file exists and is readable
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

// Check if file is executable (Unix/Mac only)
async function isExecutable(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Checks if the path looks like a valid Jac installation.
 * Valid Examples:
 * - .../bin/jac (Unix/Mac)
 * - ...\Scripts\jac.exe (Windows)
 */
function hasValidJacPathStructure(jacPath: string): boolean {
    const normalizedPath = jacPath.toLowerCase();
    const fileName = path.basename(jacPath);

    // Check filename
    if (fileName !== JAC_EXECUTABLE_NIX && fileName !== JAC_EXECUTABLE_WIN) {
        return false;
    }

    // Check directory structure
    const validDirPatterns = [
        '/bin/jac',           // Unix venv/conda/global
        '\\scripts\\jac.exe', // Windows venv
        '/scripts/jac.exe'    // Windows venv (forward slash)
    ];

    return validDirPatterns.some(pattern => normalizedPath.includes(pattern.toLowerCase()));
}

/**
 * Validates a Jac executable very quickly.
 * Checks existence, structure, and permissions without running the command.
 */
export async function fastValidateJacExecutable(jacPath: string): Promise<boolean> {
    // 1. Structure check (fastest)
    if (!hasValidJacPathStructure(jacPath)) {
        return false;
    }

    // 2. Existence check
    if (!await fileExists(jacPath)) {
        return false;
    }

    // 3. Permission check (Unix only)
    if (process.platform === 'win32') {
        return true;
    }

    return await isExecutable(jacPath);
}

/**
 * Validates multiple paths in parallel.
 */
export async function fastValidateMultipleJacPaths(jacPaths: string[]): Promise<string[]> {
    const validationResults = await Promise.all(
        jacPaths.map(async (jacPath) => ({
            path: jacPath,
            isValid: await fastValidateJacExecutable(jacPath)
        }))
    );

    return validationResults
        .filter(result => result.isValid)
        .map(result => result.path);
}
