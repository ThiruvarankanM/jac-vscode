import * as vscode from 'vscode';
import * as path from 'path';
import { validateJacExecutable, findInPath, findInCondaEnvs, findInWorkspace, findInHome } from '../utils/envDetection';
import { getLspManager, createAndStartLsp } from '../extension';
import { EnvCache } from './envCache';
import { EnvWatcher } from './envWatcher';
import { buildQuickPickItem, showEnvironmentPrompt, showManualPathEntry, showFileBrowser } from './envPickerUI';

export class EnvManager {
    private context: vscode.ExtensionContext;
    private statusBar: vscode.StatusBarItem;
    private jacPath: string | undefined;           // active jac executable path
    private cachedPaths: string[] | undefined;     // all known jac paths (mem + disk)

    // Per-locator promises — reused across QuickPick opens until invalidated
    private pathPromise:      Promise<string[]> | undefined;  // $PATH search
    private condaPromise:     Promise<string[]> | undefined;  // conda envs
    private workspacePromise: Promise<string[]> | undefined;  // workspace .venv scan
    private homePromise:      Promise<string[]> | undefined;  // ~/.virtualenvs etc.

    private readonly cache: EnvCache;
    private readonly watcher: EnvWatcher;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined; // conda debounce
    private lastDiscoveryAt = 0; // epoch ms — tracks when discovery last started

    constructor(context: vscode.ExtensionContext) {
        this.context   = context;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'jaclang-extension.selectEnv';
        context.subscriptions.push(this.statusBar);

        this.cache = new EnvCache(context.globalStorageUri.fsPath);
        this.watcher = new EnvWatcher({
            onJacCreated:   (p) => this.onJacCreated(p),
            onJacDeleted:   (p) => this.onJacDeleted(p),
            onCondaChanged: ()  => this.scheduleRefresh(),
        });
        context.subscriptions.push({ dispose: () => this.watcher.dispose() });

        // Start discovery immediately — mirrors Python ext's "pet" server which starts
        // scanning at construction time, well before init() is awaited by the caller.
        this.startBackgroundDiscovery();
    }

    async init() {
        // TODO: workspaceState — store per-workspace, fall back to globalState for shared envs
        this.jacPath = this.context.globalState.get<string>('jacEnvPath');

        const loaded = await this.cache.load();
        if (loaded) { this.cachedPaths = loaded; }

        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.invalidateAll();
                this.cachedPaths = undefined;
                this.watcher.start();
                this.startBackgroundDiscovery();
            })
        );

        await this.validateAndClearIfInvalid();

        this.watcher.start();
        // Discovery already running from constructor — only restart if invalidated above.
        if (!this.pathPromise) { this.startBackgroundDiscovery(); }

        if (!this.jacPath) {
            this.handleEnvironmentPrompt(); // fire-and-forget
        }

        this.updateStatusBar();
    }

    // ── Watcher callbacks ─────────────────────────────────────────────────────

    // Fires when a jac executable is written — the env is fully usable.
    // 1 s grace period lets the package manager flush any remaining writes.
    private onJacCreated(jacPath: string): void {
        setTimeout(async () => {
            if (this.cachedPaths?.includes(jacPath)) { return; }
            this.cachedPaths = [...(this.cachedPaths ?? []), jacPath];
            void this.cache.save(this.cachedPaths);
            this.invalidateAll();

            const item = buildQuickPickItem(jacPath);
            const action = await vscode.window.showInformationMessage(
                `New Jac environment detected: ${item.label}`,
                'Use This Environment',
                'Ignore'
            );
            if (action === 'Use This Environment') {
                this.jacPath = jacPath;
                await this.context.globalState.update('jacEnvPath', jacPath);
                this.updateStatusBar();
                await this.restartLanguageServer();
            }
        }, 1000);
    }

    // Fires when a jac executable disappears — venv deleted or jac uninstalled.
    private onJacDeleted(jacPath: string): void {
        if (this.cachedPaths) {
            this.cachedPaths = this.cachedPaths.filter(p => p !== jacPath);
            void this.cache.save(this.cachedPaths);
        }
        this.invalidateAll();

        if (this.jacPath === jacPath) {
            this.jacPath = undefined;
            void this.context.globalState.update('jacEnvPath', undefined);
            this.updateStatusBar();
            vscode.window.showWarningMessage(
                'Active Jac environment was removed. Please select a new one.',
                'Select Environment'
            ).then(action => {
                if (action === 'Select Environment') { void this.promptEnvironmentSelection(); }
            });
        }
    }

    // Debounced full re-scan — used for conda and other indirect env changes.
    private scheduleRefresh(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => {
            this.invalidateAll();   // clears all stale promises so the guard doesn't block fresh scan
            this.cachedPaths  = undefined;
            this.startBackgroundDiscovery();
        }, 500);
    }

    // Clears all per-locator promises so the next QuickPick open re-runs discovery.
    private invalidateAll(): void {
        this.pathPromise      = undefined;
        this.condaPromise     = undefined;
        this.workspacePromise = undefined;
        this.homePromise      = undefined;
    }

    // ── Background discovery ──────────────────────────────────────────────────

    private startBackgroundDiscovery(): void {
        if (this.pathPromise) { return; } // already running
        this.lastDiscoveryAt = Date.now();
        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [process.cwd()];

        // Fire all 4 locators in parallel; update cachedPaths incrementally so the
        // picker can show results as soon as the fastest locator (PATH, ~5ms) resolves.
        this.pathPromise      = findInPath();
        this.condaPromise     = findInCondaEnvs();
        this.workspacePromise = Promise.all(workspaceRoots.map(r => findInWorkspace(r)))
            .then(all => Array.from(new Set(all.flat())));
        this.homePromise      = findInHome();

        const seenPaths = new Set<string>();
        const addToSeenPaths = (paths: string[]) => {
            paths.forEach(p => seenPaths.add(p));
            this.cachedPaths = Array.from(seenPaths);
        };
        this.pathPromise.then(addToSeenPaths).catch(() => {});
        this.condaPromise.then(addToSeenPaths).catch(() => {});
        this.workspacePromise.then(addToSeenPaths).catch(() => {});
        // save to disk only after homePromise — it's the last (slowest) locator,
        // so the cache written here reflects the most complete picture available.
        this.homePromise.then(homePaths => { addToSeenPaths(homePaths); void this.cache.save(this.cachedPaths!); }).catch(() => {});
    }

    // ── Env selection ─────────────────────────────────────────────────────────

    private async handleEnvironmentPrompt(): Promise<void> {
        const action = await showEnvironmentPrompt();
        if (action === 'install') {
            vscode.env.openExternal(vscode.Uri.parse('https://www.jac-lang.org/learn/installation/'));
        } else if (action === 'select') {
            await this.promptEnvironmentSelection();
        }
    }

    getJacPath(): string {
        if (this.jacPath) { return this.jacPath; }
        return process.platform === 'win32' ? 'jac.exe' : 'jac';
    }

    getPythonPath(): string {
        if (this.jacPath) {
            // jac and python live in the same bin/ dir (e.g. .venv/bin/python)
            const jacDir = path.dirname(this.jacPath);
            return path.join(jacDir, process.platform === 'win32' ? 'python.exe' : 'python');
        }
        return process.platform === 'win32' ? 'python.exe' : 'python';
    }

    getStatusBar(): vscode.StatusBarItem {
        return this.statusBar;
    }

    private async validateAndClearIfInvalid(): Promise<void> {
        if (this.jacPath && !(await validateJacExecutable(this.jacPath))) {
            this.jacPath = undefined;
            await this.context.globalState.update('jacEnvPath', undefined);
            this.updateStatusBar();
        }
    }

    async promptEnvironmentSelection() {
        try {
            type Item = { label: string; description: string; env: string };
            const staticItems: Item[] = [
                { label: "$(add) Enter interpreter path...", description: "Manually specify the path to a Jac executable", env: "manual" },
                { label: "$(folder-opened) Find...",          description: "Browse for Jac executable using file picker",      env: "browse" },
            ];

            const quickPick = vscode.window.createQuickPick<Item>();
            quickPick.placeholder    = 'Searching for Jac environments...';
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail      = true;
            quickPick.ignoreFocusOut     = true;
            quickPick.busy = true;
            quickPick.show();

            // Validate active path in background — don't block showing the picker.
            this.validateAndClearIfInvalid().then(() => this.updateStatusBar());

            const repaint = (paths: string[]) => {
                quickPick.items = [...staticItems, ...paths.map(buildQuickPickItem)];
            };

            // Validate cached paths (fs.access, ~1-2 ms total) and show immediately.
            const confirmedPaths = this.cachedPaths
                ? (await Promise.all(this.cachedPaths.map(async p => (await validateJacExecutable(p)) ? p : null)))
                    .filter((p): p is string => p !== null)
                : [];
            if (this.cachedPaths && confirmedPaths.length !== this.cachedPaths.length) {
                this.cachedPaths = confirmedPaths;
                void this.cache.save(confirmedPaths);
            }
            repaint(confirmedPaths);

            // Reuse in-progress or recently-settled promises if < 30 s old — avoids
            // discarding constructor-started work when the user opens the picker quickly.
            // Beyond 30 s, invalidate so we catch anything FS watchers may have missed.
            if (Date.now() - this.lastDiscoveryAt > 30_000) { this.invalidateAll(); }
            this.startBackgroundDiscovery();

            // Stream fresh results; only repaint when the set genuinely grows.
            const pickerPaths = new Set<string>(confirmedPaths);
            const onFreshBatch = (paths: string[]) => {
                const prev = pickerPaths.size;
                paths.forEach(p => pickerPaths.add(p));
                if (pickerPaths.size !== prev) { repaint(Array.from(pickerPaths)); }
            };

            const promises = [this.pathPromise, this.condaPromise, this.workspacePromise, this.homePromise]
                .filter((p): p is Promise<string[]> => p !== undefined);
            promises.forEach(p => p.then(onFreshBatch).catch(() => {}));

            // Mark done + persist cache when all locators finish.
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
                const pickerDisposables: vscode.Disposable[] = [];
                const cleanup = () => pickerDisposables.forEach(d => d.dispose());
                pickerDisposables.push(
                    quickPick.onDidAccept(() => {
                        resolve(quickPick.selectedItems[0]);
                        quickPick.hide();
                        cleanup();
                    }),
                    quickPick.onDidHide(() => {
                        resolve(undefined);
                        cleanup();
                    }),
                );
            });

            if (!choice || choice.env === 'manual' || choice.env === 'browse') {
                this.updateStatusBar();
                if (choice?.env === 'manual')  { await this.handleManualEntry(); }
                else if (choice?.env === 'browse') { await this.handleFileBrowse(); }
                return;
            }

            this.jacPath = choice.env;
            this.invalidateAll();
            // Do NOT clear cachedPaths — the env list is still valid, only the active selection changed.
            await this.context.globalState.update('jacEnvPath', choice.env);
            this.startBackgroundDiscovery();
            this.updateStatusBar();
            await this.restartLanguageServer();
        } catch (error: any) {
            this.updateStatusBar();
            vscode.window.showErrorMessage(`Error finding Jac environments: ${error.message || error}`);
        }
    }


    private async handleManualEntry(): Promise<void> {
        const result = await showManualPathEntry(p => validateJacExecutable(p));
        if (!result)             { return; }
        if (result === 'browse') { return this.handleFileBrowse(); } // user chose 'Browse' from the error retry dialog
        await this.applySelectedPath(result);
    }

    private async handleFileBrowse(): Promise<void> {
        const result = await showFileBrowser(p => validateJacExecutable(p));
        if (!result)             { return; }
        if (result === 'manual') { return this.handleManualEntry(); } // user chose 'Enter manually' from the error retry dialog
        await this.applySelectedPath(result);
    }

    private async applySelectedPath(jacPath: string): Promise<void> {
        this.jacPath = jacPath;
        await this.context.globalState.update('jacEnvPath', jacPath);
        this.updateStatusBar();
        await this.restartLanguageServer();
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
            // LSP already running — just restart with the new env
            try { await lspManager.restart(); }
            catch (error: any) { vscode.window.showErrorMessage(`Failed to restart language server: ${error.message || error}`); }
        } else {
            // First-time start (e.g. user picked an env before LSP was created)
            try { await createAndStartLsp(this, this.context); }
            catch (error: any) { vscode.window.showErrorMessage(`Failed to start language server: ${error.message || error}`); }
        }
    }
}