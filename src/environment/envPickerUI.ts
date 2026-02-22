import * as vscode from 'vscode';
import * as path from 'path';

// ── Display helpers ───────────────────────────────────────────────────────────

/**
 * Shortens an absolute path for display: replaces the home directory with `~`
 * and collapses very long paths to `start/.../end`.
 */
function formatPathForDisplay(envPath: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir && envPath.startsWith(homeDir)) {
        return envPath.replace(homeDir, '~');
    }
    const parts = envPath.split(path.sep);
    if (parts.length > 6) {
        const start = parts.slice(0, 2).join(path.sep);
        const end   = parts.slice(-3).join(path.sep);
        return `${start}${path.sep}...${path.sep}${end}`;
    }
    return envPath;
}

/**
 * Builds a QuickPick item for a given `jac` executable path.
 * Label: `Jac (envName)`, Description: shortened path.
 */
export function buildQuickPickItem(env: string): { label: string; description: string; env: string } {
    const pathDirs = process.env.PATH?.split(path.delimiter) || [];
    const isGlobal = env === 'jac' || env === 'jac.exe' ||
        pathDirs.some(dir => path.join(dir, path.basename(env)) === env);

    let displayName = '';
    if (isGlobal) {
        displayName = 'Jac';
    } else if (env.includes('conda') || env.includes('miniconda') || env.includes('anaconda')) {
        const m = env.match(/envs[\/\\]([^\/\\]+)/);
        displayName = m ? `Jac (${m[1]})` : 'Jac';
    } else {
        const venvMatch = env.match(/([^\/\\]*(?:\.?venv|virtualenv)[^\/\\]*)/);
        if (venvMatch) {
            displayName = `Jac (${venvMatch[1]})`;
        } else {
            const dirPath = path.dirname(env);
            const parent  = path.basename(dirPath);
            displayName = (parent === 'Scripts' || parent === 'bin')
                ? `Jac (${path.basename(path.dirname(dirPath))})`
                : `Jac (${parent})`;
        }
    }
    return { label: displayName, description: formatPathForDisplay(env), env };
}

// ── No-env prompt ─────────────────────────────────────────────────────────────

/**
 * Shows a non-blocking information message when no Jac environment is selected.
 * Returns the user's chosen action so the caller can react accordingly.
 */
export async function showEnvironmentPrompt(): Promise<'select' | 'install' | undefined> {
    const action = await vscode.window.showInformationMessage(
        'No Jac environment selected. Select one to enable IntelliSense.',
        'Select Environment',
        'Install Jac'
    );
    if (action === 'Select Environment') { return 'select'; }
    if (action === 'Install Jac')        { return 'install'; }
    return undefined;
}

// ── Manual path entry ─────────────────────────────────────────────────────────

/**
 * Shows an input box for the user to type an absolute path to a Jac executable.
 * Validates the path with the provided callback.
 *
 * Returns:
 *   - the normalised absolute path on success
 *   - `'browse'` if the user chose "Browse for File" after a validation failure
 *   - `undefined` if the user cancelled
 */
export async function showManualPathEntry(
    validate: (p: string) => Promise<boolean>
): Promise<string | 'browse' | undefined> {
    const manualPath = await vscode.window.showInputBox({
        prompt: 'Enter the path to the Jac executable',
        placeHolder: '/path/to/jac or C:\\path\\to\\jac.exe',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) { return 'Path cannot be empty'; }
            if (!path.isAbsolute(value) && !value.startsWith('~')) { return 'Please enter an absolute path'; }
            return null;
        },
    });

    if (!manualPath) { return undefined; }

    const normalized = manualPath.startsWith('~')
        ? path.join(process.env.HOME || process.env.USERPROFILE || '', manualPath.slice(1))
        : manualPath;

    if (await validate(normalized)) { return normalized; }

    const retry = await vscode.window.showErrorMessage(
        `Invalid Jac executable: ${normalized}`,
        'Retry',
        'Browse for File'
    );
    if (retry === 'Retry')           { return showManualPathEntry(validate); }
    if (retry === 'Browse for File') { return 'browse'; }
    return undefined;
}

// ── File browser ──────────────────────────────────────────────────────────────

/**
 * Opens a native file picker for the user to select a Jac executable.
 * Validates the selection with the provided callback.
 *
 * Returns:
 *   - the selected absolute path on success
 *   - `'manual'` if the user chose "Enter Path Manually" after a validation failure
 *   - `undefined` if the user cancelled
 */
export async function showFileBrowser(
    validate: (p: string) => Promise<boolean>
): Promise<string | 'manual' | undefined> {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select Jac Executable',
        filters: process.platform === 'win32'
            ? { 'Executable Files': ['exe'], 'All Files': ['*'] }
            : { 'All Files': ['*'] },
        defaultUri: vscode.Uri.file(process.env.HOME || process.env.USERPROFILE || '/'),
        title: 'Select Jac Executable',
    });

    if (!fileUri || fileUri.length === 0) { return undefined; }

    const selectedPath = fileUri[0].fsPath;
    if (await validate(selectedPath)) { return selectedPath; }

    const retry = await vscode.window.showErrorMessage(
        `The selected file is not a valid Jac executable: ${selectedPath}`,
        'Try Again',
        'Enter Path Manually'
    );
    if (retry === 'Try Again')           { return showFileBrowser(validate); }
    if (retry === 'Enter Path Manually') { return 'manual'; }
    return undefined;
}
