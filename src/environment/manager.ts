import * as vscode from 'vscode';
import * as path from 'path';
import { findInPath, findInCondaEnvs, findInWorkspace, findInHome, validateJacExecutable } from '../utils/envDetection';
import { getLspManager, createAndStartLsp } from '../extension';
import { EnvCache } from './envCache';

export class EnvManager {
    private context: vscode.ExtensionContext;
    private statusBar: vscode.StatusBarItem;
    private jacPath: string | undefined;

    private cachedPaths: string[] | undefined;    // all known jac paths (mem + disk)
    private pathPromise:      Promise<string[]> | undefined;
    private condaPromise:     Promise<string[]> | undefined;
    private workspacePromise: Promise<string[]> | undefined;
    private homePromise:      Promise<string[]> | undefined;
    private readonly cache: EnvCache;
    private lastDiscoveryAt = 0;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'jaclang-extension.selectEnv';
        context.subscriptions.push(this.statusBar);

        this.cache = new EnvCache(context.globalStorageUri.fsPath);

        // Fire all locators immediately — discovery runs while extension activates.
        // By the time the user opens QuickPick, results are already in cachedPaths.
        this.startBackgroundDiscovery();
    }


    async init() {
        // TODO: workspaceState — per-workspace env, fall back to globalState
        this.jacPath = this.context.globalState.get<string>('jacEnvPath');

        const loaded = await this.cache.load();
        if (loaded) { this.cachedPaths = loaded; }

        this.updateStatusBar();
        await this.validateAndClearIfInvalid();

        if (!this.jacPath) {
            this.showEnvironmentPrompt(); // fire-and-forget
        }

        this.updateStatusBar();
    }

    private startBackgroundDiscovery(): void {
        if (this.pathPromise) { return; } // already running — reuse in-progress promises
        this.lastDiscoveryAt = Date.now();
        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [process.cwd()];

        this.pathPromise      = findInPath();
        this.condaPromise     = findInCondaEnvs();
        this.workspacePromise = Promise.all(workspaceRoots.map(r => findInWorkspace(r)))
            .then(all => Array.from(new Set(all.flat())));
        this.homePromise      = findInHome();

        const seenPaths = new Set<string>(); // start fresh — don't carry stale/deleted entries forward
        const merge = (paths: string[]) => {
            paths.forEach(p => seenPaths.add(p));
            this.cachedPaths = Array.from(seenPaths);
        };
        this.pathPromise.then(merge).catch(() => {});
        this.condaPromise.then(merge).catch(() => {});
        this.workspacePromise.then(merge).catch(() => {});
        this.homePromise.then(paths => { merge(paths); void this.cache.save(this.cachedPaths!); }).catch(() => {});
    }

    private invalidateAll(): void {
        this.pathPromise      = undefined;
        this.condaPromise     = undefined;
        this.workspacePromise = undefined;
        this.homePromise      = undefined;
    }

    private async showEnvironmentPrompt() {
        // Await all background locators (already running from constructor).
        // If cachedPaths is filled, this resolves immediately.
        await Promise.allSettled([
            this.pathPromise, this.condaPromise,
            this.workspacePromise, this.homePromise,
        ]);
        const envs = this.cachedPaths ?? [];

        const isNoEnv = envs.length === 0;
        const action = isNoEnv
            ? await vscode.window.showWarningMessage(
                'No Jac environments found. Install Jac to enable IntelliSense and language features.',
                'Install Jac',
                'Select Manually'
            )
            : await vscode.window.showInformationMessage(
                'No Jac environment selected. Select one to enable IntelliSense.',
                'Select Environment'
            );

        if (action === 'Install Jac') {
            vscode.env.openExternal(vscode.Uri.parse('https://www.jac-lang.org/learn/installation/'));
        } else if (action === 'Select Manually' || action === 'Select Environment') {
            await this.promptEnvironmentSelection();
        }
    }

    getJacPath(): string {
        if (this.jacPath) return this.jacPath;
        // Fallback: try to find jac in PATH
        return process.platform === 'win32' ? 'jac.exe' : 'jac';
    }

    getPythonPath(): string {
        if (this.jacPath) {
            // Convert jac path to python path (same directory)
            const jacDir = path.dirname(this.jacPath);
            const pythonExecutable = process.platform === 'win32' ? 'python.exe' : 'python';
            return path.join(jacDir, pythonExecutable);
        }
        // Fallback: try to find python in PATH
        return process.platform === 'win32' ? 'python.exe' : 'python';
    }

    getStatusBar(): vscode.StatusBarItem {
        return this.statusBar;
    }

    //Validates the current environment and clears it if invalid
    private async validateAndClearIfInvalid(): Promise<void> {
        if (this.jacPath && !(await validateJacExecutable(this.jacPath))) {
            this.jacPath = undefined;
            await this.context.globalState.update('jacEnvPath', undefined);
            this.updateStatusBar();
        }
    }

    // Builds a QuickPick item from a jac executable path.
    private buildQuickPickItem(env: string): { label: string; description: string; env: string } {
        const pathDirs = process.env.PATH?.split(path.delimiter) || [];
        const isGlobal = env === 'jac' || env === 'jac.exe' ||
            pathDirs.some(dir => path.join(dir, path.basename(env)) === env);

        let displayName: string;
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
                const parent = path.basename(path.dirname(env));
                displayName = (parent === 'Scripts' || parent === 'bin')
                    ? `Jac (${path.basename(path.dirname(path.dirname(env)))})`
                    : `Jac (${parent})`;
            }
        }
        return { label: displayName, description: this.formatPathForDisplay(env), env };
    }

    // Opens the env picker immediately with cached paths, streaming fresh results as locators finish.
    async promptEnvironmentSelection() {
        try {
            type Item = { label: string; description: string; env: string };
            const staticItems: Item[] = [
                { label: '$(add) Enter interpreter path...', description: 'Manually specify the path to a Jac executable', env: 'manual' },
                { label: '$(folder-opened) Find...',         description: 'Browse for Jac executable using file picker',  env: 'browse' },
            ];

            const quickPick = vscode.window.createQuickPick<Item>();
            quickPick.placeholder        = 'Searching for Jac environments...';
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail      = true;
            quickPick.ignoreFocusOut     = true;
            quickPick.busy               = true;
            quickPick.show();

            // Validate active path without blocking the picker open.
            this.validateAndClearIfInvalid().then(() => this.updateStatusBar());

            const repaint = (paths: string[]) => {
                quickPick.items = [...staticItems, ...paths.map(p => this.buildQuickPickItem(p))];
            };

            // Paint confirmed cache paths immediately — zero wait on second open.
            const confirmedPaths = this.cachedPaths
                ? (await Promise.all(this.cachedPaths.map(async p => (await validateJacExecutable(p)) ? p : null)))
                    .filter((p): p is string => p !== null)
                : [];
            if (this.cachedPaths && confirmedPaths.length !== this.cachedPaths.length) {
                this.cachedPaths = confirmedPaths;
                void this.cache.save(confirmedPaths);
                // Stale entries found — force fresh discovery so settled promises
                // with deleted paths don't replay into onFreshBatch below.
                this.invalidateAll();
            } else if (Date.now() - this.lastDiscoveryAt > 30_000) {
                this.invalidateAll();
            }
            repaint(confirmedPaths);
            this.startBackgroundDiscovery();

            // Stream each locator's results into the picker as they arrive.
            const pickerPaths = new Set<string>(confirmedPaths);
            const onFreshBatch = (paths: string[]) => {
                const prev = pickerPaths.size;
                paths.forEach(p => pickerPaths.add(p));
                if (pickerPaths.size !== prev) { repaint(Array.from(pickerPaths)); }
            };
            const promises = [this.pathPromise, this.condaPromise, this.workspacePromise, this.homePromise]
                .filter((p): p is Promise<string[]> => p !== undefined);
            promises.forEach(p => p.then(onFreshBatch).catch(() => {}));

            // Mark done + persist cache when all locators settle.
            Promise.allSettled(promises).then(() => {
                const finalPaths = Array.from(pickerPaths);
                this.cachedPaths = finalPaths;
                void this.cache.save(finalPaths);
                quickPick.busy = false;
                quickPick.placeholder = finalPaths.length > 0
                    ? `Select Jac environment (${finalPaths.length} found)`
                    : 'Select Jac environment (none detected)';
            });

            const choice = await new Promise<Item | undefined>(resolve => {
                const subs: vscode.Disposable[] = [];
                const cleanup = () => subs.forEach(d => d.dispose());
                subs.push(
                    quickPick.onDidAccept(() => { resolve(quickPick.selectedItems[0]); quickPick.hide(); cleanup(); }),
                    quickPick.onDidHide(()   => { resolve(undefined); cleanup(); }),
                );
            });

            if (!choice || choice.env === 'manual' || choice.env === 'browse') {
                this.updateStatusBar();
                if (choice?.env === 'manual') { await this.handleManualPathEntry(); }
                else if (choice?.env === 'browse') { await this.handleFileBrowser(); }
                return;
            }

            this.jacPath = choice.env;
            this.invalidateAll();
            await this.context.globalState.update('jacEnvPath', choice.env);
            this.startBackgroundDiscovery();
            this.updateStatusBar();
            await this.restartLanguageServer();
        } catch (error: any) {
            this.updateStatusBar();
            vscode.window.showErrorMessage(`Error finding Jac environments: ${error.message || error}`);
        }
    }


    /**
     * Handles manual path entry for Jac executable
     */
    private async handleManualPathEntry() {
        const manualPath = await vscode.window.showInputBox({
            prompt: "Enter the path to the Jac executable",
            placeHolder: "/path/to/jac or C:\\path\\to\\jac.exe",
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return "Path cannot be empty";
                }
                // Basic validation - check if it looks like a valid path
                if (!path.isAbsolute(value) && !value.startsWith('~')) {
                    return "Please enter an absolute path";
                }
                return null;
            }
        });

        if (manualPath) {
            const normalizedPath = manualPath.startsWith('~')
                ? path.join(process.env.HOME || process.env.USERPROFILE || '', manualPath.slice(1))
                : manualPath;

            // Validate the entered path
            if (await validateJacExecutable(normalizedPath)) {
                this.jacPath = normalizedPath;
                await this.context.globalState.update('jacEnvPath', normalizedPath);
                this.updateStatusBar();

                vscode.window.showInformationMessage(
                    `Jac environment set to: ${this.formatPathForDisplay(normalizedPath)}`
                );

                await this.restartLanguageServer();
            } else {
                const retry = await vscode.window.showErrorMessage(
                    `Invalid Jac executable: ${normalizedPath}`,
                    "Retry",
                    "Browse for File"
                );

                if (retry === "Retry") {
                    await this.handleManualPathEntry();
                } else if (retry === "Browse for File") {
                    await this.handleFileBrowser();
                }
            }
        }
    }

    /**
     * Handles file browser for selecting Jac executable
     */
    private async handleFileBrowser() {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: "Select Jac Executable",
            filters: process.platform === 'win32' ? {
                'Executable Files': ['exe'],
                'All Files': ['*']
            } : {
                'All Files': ['*']
            },
            defaultUri: vscode.Uri.file(process.env.HOME || process.env.USERPROFILE || '/'),
            title: "Select Jac Executable"
        });

        if (fileUri && fileUri.length > 0) {
            const selectedPath = fileUri[0].fsPath;

            // Validate the selected file
            if (await validateJacExecutable(selectedPath)) {
                this.jacPath = selectedPath;
                await this.context.globalState.update('jacEnvPath', selectedPath);
                this.updateStatusBar();

                vscode.window.showInformationMessage(
                    `Jac environment set to: ${this.formatPathForDisplay(selectedPath)}`
                );

                await this.restartLanguageServer();
            } else {
                const retry = await vscode.window.showErrorMessage(
                    `The selected file is not a valid Jac executable: ${selectedPath}`,
                    "Try Again",
                    "Enter Path Manually"
                );

                if (retry === "Try Again") {
                    await this.handleFileBrowser();
                } else if (retry === "Enter Path Manually") {
                    await this.handleManualPathEntry();
                }
            }
        }
    }


    /**
     * Formats a file path for display in the quick pick, similar to VS Code Python extension
     */
    private formatPathForDisplay(envPath: string): string {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';

        // Replace home directory with ~
        if (homeDir && envPath.startsWith(homeDir)) {
            return envPath.replace(homeDir, '~');
        }

        // For very long paths, show just the relevant parts
        const pathParts = envPath.split(path.sep);
        if (pathParts.length > 6) {
            const start = pathParts.slice(0, 2).join(path.sep);
            const end = pathParts.slice(-3).join(path.sep);
            return `${start}${path.sep}...${path.sep}${end}`;
        }

        return envPath;
    }

    updateStatusBar() {
        if (this.jacPath) {
            const isGlobal = this.jacPath === 'jac' || this.jacPath === 'jac.exe' ||
                (process.env.PATH?.split(path.delimiter) || []).some(dir =>
                    path.join(dir, path.basename(this.jacPath!)) === this.jacPath);

            const label = isGlobal ? 'Jac (Global)' : 'Jac';
            this.statusBar.text = `$(check) ${label}`;
            this.statusBar.tooltip = `Current: ${this.jacPath}${isGlobal ? ' (Global)' : ''}\nClick to change`;
        } else {
            this.statusBar.text = '$(warning) Jac: No Env';
            this.statusBar.tooltip = 'No Jac environment selected - Click to select';
        }
        this.statusBar.show();
    }

    private async restartLanguageServer(): Promise<void> {
        const lspManager = getLspManager();
        if (lspManager) {
            // LSP exists: restart it
            try {
                await lspManager.restart();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to restart language server: ${error.message || error}`);
            }
        } else {
            // LSP doesn't exist: create and start it
            try {
                await createAndStartLsp(this, this.context);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to start language server: ${error.message || error}`);
            }
        }
    }
}