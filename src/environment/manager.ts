import * as vscode from 'vscode';
import * as path from 'path';
import { findInPath, findInCondaEnvs, findInWorkspace, findInHome, validateJacExecutable } from '../utils/envDetection';
import { getJacVersion, compareJacVersions } from '../utils/envVersion';
import { getLspManager, createAndStartLsp } from '../extension';
import { EnvCache } from './envCache';

export class EnvManager {
    private context: vscode.ExtensionContext;
    private statusBar: vscode.StatusBarItem;
    private jacPath: string | undefined;

    // All jac paths found so far by the four locators combined.
    // undefined = locators haven't run yet. [] = ran but found nothing.
    private cachedPaths: string[] | undefined;

    // One promise per locator, started in the constructor so scanning happens
    // in the background while the extension loads. By the time the user opens
    // the QuickPick the results are usually already available.
    // Same idea as Python extension:
    //   src/client/pythonEnvironments/base/locators/common/nativePythonFinder.ts
    private pathPromise:      Promise<string[]> | undefined;  // $PATH search
    private condaPromise:     Promise<string[]> | undefined;  // conda envs
    private workspacePromise: Promise<string[]> | undefined;  // workspace venvs
    private homePromise:      Promise<string[]> | undefined;  // ~/.virtualenvs etc.

    private readonly cache: EnvCache;

    // When the current scan started (ms). Used to decide whether to reuse
    // the running promises or start a fresh scan when the user opens the picker.
    private lastDiscoveryAt = 0;

    // The highest-version jac path found after background version reads complete.
    private recommendedPath: string | undefined;

    // Resolves when all locators + version reads are done.
    // Awaited by autoSelectOnStartup so it applies the best env only once the
    // full picture is known — same idea as Python ext's refreshPromise.
    private recommendedPromise: Promise<void> | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'jaclang-extension.selectEnv';
        context.subscriptions.push(this.statusBar);

        this.cache = new EnvCache(context.globalStorageUri.fsPath);

        // Start scanning for jac environments immediately while the extension
        // loads, so results are ready before the user opens the QuickPick.
        // Same as Python extension (nativePythonFinder.ts) which starts
        // scanning in its constructor before activate() awaits it.
        this.startBackgroundDiscovery();
    }


    // Loads the previously selected env from storage, restores the cache from disk,
    // and validates the saved path is still on disk. If no env is selected yet,
    // fires autoSelectOnStartup() in the background to pick the best one silently.
    // Called once by activate() after the constructor.
    async init() {
        this.jacPath = this.context.globalState.get<string>('jacEnvPath');

        const loaded = await this.cache.load();
        if (loaded) { this.cachedPaths = loaded; }

        this.updateStatusBar();
        await this.validateAndClearIfInvalid();

        if (!this.jacPath) {
            // Fire-and-forget: wait for locators + version reads, then silently
            // apply the highest-version env — same as Python ext's autoSelectInterpreter.
            // Never blocks the QuickPick or extension startup.
            void this.autoSelectOnStartup();
        }

        this.updateStatusBar();
    }

    // Waits for all locators and version reads to settle, then silently applies
    // the highest-version env. If the user picks manually before this resolves,
    // the jacPath check acts as a cancellation guard — nothing happens.
    // If no envs are found at all, shows an install prompt.
    // Example:
    //   locators finish → recommendedPath = "~/.venv2/bin/jac" (highest version)
    //   → silently sets jacPath, updates status bar, restarts LSP
    //
    //   user already picked manually before this resolves
    //   → this.jacPath is set → returns immediately, does nothing
    //
    //   locators finish → nothing found
    //   → shows "No Jac environment found." with Install / Enter Path buttons
    private async autoSelectOnStartup(): Promise<void> {
        await this.recommendedPromise;

        if (this.jacPath) { return; } // user already picked — nothing to do

        const best = this.recommendedPath ?? this.cachedPaths?.[0];
        if (!best) {
            // No envs found at all — tell the user to install Jac.
            const action = await vscode.window.showWarningMessage(
                'No Jac environment found.',
                'Install Jac',
                'Enter Path Manually'
            );
            if (action === 'Install Jac') {
                vscode.env.openExternal(vscode.Uri.parse('https://www.jac-lang.org/learn/installation/'));
            } else if (action === 'Enter Path Manually') {
                await this.handleManualPathEntry();
            }
            return;
        }

        // Silently apply the highest-version env.
        this.jacPath = best;
        await this.context.globalState.update('jacEnvPath', best);
        this.updateStatusBar();
        await this.restartLanguageServer();
    }

    // Starts all four locators at the same time. Each one updates cachedPaths
    // as soon as it finishes so the QuickPick can show results as they arrive.
    //
    // If a scan is already in progress (pathPromise is set), skip — reuse
    // the existing promises. Call invalidateAll() first to force a new scan.
    //
    // seenPaths starts empty every time so deleted envs are never carried over.
    // Only paths that exist on disk right now end up in cachedPaths.
    //
    // Same approach as Python extension:
    //   src/client/pythonEnvironments/base/locators/common/nativePythonFinder.ts
    //
    // Example (timeline):
    //   t=0ms  → all 4 locators start in parallel
    //   t=5ms  → findInPath() finishes   → cachedPaths = ["/usr/local/bin/jac"]
    //   t=8ms  → findInWorkspace() done  → cachedPaths = ["/usr/local/bin/jac", ".venv/bin/jac"]
    //   t=12ms → findInCondaEnvs() done  → cachedPaths = [..., "conda/envs/base/bin/jac"]
    //   t=20ms → findInHome() done       → cache saved to disk, versions read, recommendedPath set
    private startBackgroundDiscovery(): void {
        if (this.pathPromise) { return; } // already running — reuse in-progress promises
        this.lastDiscoveryAt = Date.now();
        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [process.cwd()];

        this.pathPromise      = findInPath();
        this.condaPromise     = findInCondaEnvs();
        this.workspacePromise = Promise.all(workspaceRoots.map(root => findInWorkspace(root)))
            .then(all => Array.from(new Set(all.flat())));
        this.homePromise      = findInHome();

        const seenPaths = new Set<string>(); // start fresh — don't carry stale/deleted entries forward
        const merge = (paths: string[]) => {
            paths.forEach(jacPath => seenPaths.add(jacPath));
            this.cachedPaths = Array.from(seenPaths);
        };
        this.pathPromise.then(merge).catch(() => {});
        this.condaPromise.then(merge).catch(() => {});
        this.workspacePromise.then(merge).catch(() => {});
        // Save to disk only after the home locator finishes (it's the slowest)
        // so the file contains the most complete list for the next session.
        // recommendedPromise resolves after versions are read — autoSelectOnStartup awaits it.
        this.recommendedPromise = this.homePromise.then(async (paths) => {
            merge(paths);
            void this.cache.save(this.cachedPaths!);
            // Read versions from folder names (~1 ms each, no subprocess).
            // Pick the highest as recommendedPath.
            const allPaths = this.cachedPaths ?? [];
            const versions = await Promise.all(allPaths.map(jacPath => getJacVersion(jacPath)));
            let highestVersion: string | undefined;
            allPaths.forEach((envPath, i) => {
                const version = versions[i];
                if (version && (!highestVersion || compareJacVersions(version, highestVersion) > 0)) {
                    highestVersion = version;
                    this.recommendedPath = envPath;
                }
            });
        }).catch(() => {});
    }

    // Clears the locator promises so the next startBackgroundDiscovery() call
    // runs a completely fresh scan instead of reusing the old results.
    // Called when the user picks an env, when a deleted env is detected,
    // or when the last scan is older than 30 seconds.
    // Example:
    //   pathPromise = <finished Promise>  ← startBackgroundDiscovery() would skip
    //   invalidateAll()                   ← sets all promises to undefined
    //   startBackgroundDiscovery()        ← now runs a fresh scan
    private invalidateAll(): void {
        this.pathPromise      = undefined;
        this.condaPromise     = undefined;
        this.workspacePromise = undefined;
        this.homePromise      = undefined;
        this.recommendedPromise = undefined;
    }

    // Returns the selected jac executable path.
    // Falls back to the bare name "jac" / "jac.exe" if no env is selected,
    // so callers (LSP, terminal) can still attempt to run jac from PATH.
    getJacPath(): string {
        if (this.jacPath) return this.jacPath;
        return process.platform === 'win32' ? 'jac.exe' : 'jac';
    }

    // Returns the python executable sitting next to the selected jac binary.
    // jac and python live in the same bin/ (or Scripts/) folder inside a venv,
    // so replacing the filename gives us the right interpreter automatically.
    // Falls back to the bare name "python" / "python.exe" if no env is selected.
    getPythonPath(): string {
        if (this.jacPath) {
            const jacDir = path.dirname(this.jacPath);
            const pythonExecutable = process.platform === 'win32' ? 'python.exe' : 'python';
            return path.join(jacDir, pythonExecutable);
        }
        return process.platform === 'win32' ? 'python.exe' : 'python';
    }

    getStatusBar(): vscode.StatusBarItem {
        return this.statusBar;
    }

    // Checks that the saved jac path still exists on disk.
    // If the venv was deleted since last session, clears the selection
    // so the extension doesn't try to start the LSP with a missing binary.
    private async validateAndClearIfInvalid(): Promise<void> {
        if (this.jacPath && !(await validateJacExecutable(this.jacPath))) {
            this.jacPath = undefined;
            await this.context.globalState.update('jacEnvPath', undefined);
            this.updateStatusBar();
        }
    }

    // Parses a jac executable path into a human-readable env name and type.
    // Used by both the picker rows and the picker title.
    // Example:
    //   parseEnvPath("/usr/local/bin/jac")               → { envName: '',       envType: 'Global' }
    //   parseEnvPath("~/miniconda3/envs/myenv/bin/jac")  → { envName: 'myenv',  envType: 'Conda'  }
    //   parseEnvPath("/home/user/project/.venv/bin/jac") → { envName: '.venv',  envType: 'Venv'   }
    //   parseEnvPath("/home/user/project/myenv/bin/jac") → { envName: 'myenv',  envType: 'Venv'   }
    private parseEnvPath(env: string): { envName: string; envType: string } {
        const pathDirs = process.env.PATH?.split(path.delimiter) || [];
        const isGlobal = env === 'jac' || env === 'jac.exe' ||
            pathDirs.some(dir => path.join(dir, path.basename(env)) === env);

        if (isGlobal) { return { envName: '', envType: 'Global' }; }
        if (env.includes('conda') || env.includes('miniconda') || env.includes('anaconda')) {
            const condaMatch = env.match(/envs[\/\\]([^\/\\]+)/);
            return { envName: condaMatch ? condaMatch[1] : '', envType: 'Conda' };
        }
        const venvMatch = env.match(/([^\/\\]*(?:\.?venv|virtualenv)[^\/\\]*)/);
        if (venvMatch) { return { envName: venvMatch[1], envType: 'Venv' }; }
        const parent = path.basename(path.dirname(env));
        const envName = (parent === 'Scripts' || parent === 'bin')
            ? path.basename(path.dirname(path.dirname(env)))
            : parent;
        return { envName, envType: 'Venv' };
    }

    // Builds one picker row — single line:
    //   Label:       "$(check) Jac 0.11.0 (.venv2)"
    //   Description: "~/Documents/Test/.venv2/bin/jac  ·  Venv"
    // Example:
    //   buildEnvItem("/home/user/project/.venv2/bin/jac", "0.11.0", true)
    //   → { label: "$(check) Jac 0.11.0 (.venv2)",
    //       description: "~/project/.venv2/bin/jac  ·  Venv",
    //       env: "/home/user/project/.venv2/bin/jac" }
    //
    //   buildEnvItem("/usr/local/bin/jac", undefined, false)
    //   → { label: "Jac",
    //       description: "/usr/local/bin/jac  ·  Global",
    //       env: "/usr/local/bin/jac" }
    private buildEnvItem(env: string, version?: string, active?: boolean): vscode.QuickPickItem & { env: string } {
        const { envName, envType } = this.parseEnvPath(env);
        const versionStr  = version ? `Jac ${version}` : 'Jac';
        const namePart    = envName ? ` (${envName})` : '';
        const label       = `${active ? '$(check) ' : ''}${versionStr}${namePart}`;
        const description = `${this.formatPathForDisplay(env)}  ·  ${envType}`;
        return { label, description, env };
    }

    // Opens the QuickPick immediately and streams results in as locators finish.
    // Items are arranged in sections separated by VS Code's native separators:
    //
    //   ── Currently Active ──  the selected env (shown if a path is set)
    //   ── Recommended ──────  highest-version env (shown once versions are read)
    //   [all others, sorted by version descending]
    //   ── Add ──────────────  Enter path + Browse (always at the bottom)
    //
    // The $(check) icon marks the currently active env so the user always
    // knows what's selected without hunting through the list.
    async promptEnvironmentSelection() {
        try {
            // Items can be selectable env rows OR non-selectable separators.
            // Separators carry no env field; VS Code prevents selecting them.
            type EnvItem = vscode.QuickPickItem & { env: string };
            type AnyItem = vscode.QuickPickItem & { env?: string };

            const addItems: EnvItem[] = [
                { label: '$(add) Enter interpreter path...', description: 'Manually specify the path to a Jac executable', env: 'manual' },
                { label: '$(folder-opened) Find...',         description: 'Browse for Jac executable using file picker',  env: 'browse'  },
            ];

            const sep = (label: string): AnyItem =>
                ({ label, kind: vscode.QuickPickItemKind.Separator });

            const quickPick = vscode.window.createQuickPick<AnyItem>();
            quickPick.title              = this.buildPickerTitle();
            quickPick.placeholder        = 'Searching for Jac environments...';
            quickPick.matchOnDescription = true;
            quickPick.ignoreFocusOut     = true;
            quickPick.busy               = true;
            quickPick.show();

            // Validate active path without blocking the picker open.
            this.validateAndClearIfInvalid().then(() => this.updateStatusBar());

            // versionMap and recommendedPath are filled after all locators settle.
            // The picker shows env rows immediately and repaints once versions arrive.
            const versionMap = new Map<string, string>(); // jacPath → "X.Y.Z"
            let recommendedPath: string | undefined;
            let pickerDisposed = false;

            // Rebuilds the full grouped item list from the current set of paths.
            // Called on every new batch and again after version reads complete.
            const repaint = (paths: string[]) => {
                if (pickerDisposed) { return; }

                // Sort by version descending so newest floats to the top of Installed.
                // Envs with no version yet go after versioned ones, then alphabetically.
                const sorted = [...paths].sort((pathA, pathB) => {
                    const versionA = versionMap.get(pathA);
                    const versionB = versionMap.get(pathB);
                    if (versionA && versionB) { return compareJacVersions(versionB, versionA); }
                    if (versionA) { return -1; }
                    if (versionB) { return  1; }
                    return pathA.localeCompare(pathB);
                });

                const items: AnyItem[] = [];

                // Active section — always first, shows the currently selected env.
                // Excluded from Recommended/Installed below to avoid duplication.
                if (this.jacPath && paths.includes(this.jacPath)) {
                    items.push(sep('Currently Active'));
                    items.push(this.buildEnvItem(
                        this.jacPath,
                        versionMap.get(this.jacPath),
                        true,
                    ));
                }

                // Recommended section — highest version, only shown once versions are read.
                if (recommendedPath && recommendedPath !== this.jacPath) {
                    items.push(sep('Recommended'));
                    items.push(this.buildEnvItem(
                        recommendedPath,
                        versionMap.get(recommendedPath),
                        false,
                    ));
                }

                // Remaining envs — sorted by version desc, no section label needed.
                const otherPaths = sorted.filter(envPath => envPath !== recommendedPath && envPath !== this.jacPath);
                for (const envPath of otherPaths) {
                    items.push(this.buildEnvItem(envPath, versionMap.get(envPath), false));
                }

                // Add section — always last so it never distracts.
                items.push(sep('Add'));
                items.push(...addItems);

                quickPick.items = items;
            };

            // Show cached paths immediately (each validated with fs.access, ~1 ms).
            // Stale entries (deleted venvs) are removed before display.
            const confirmedPaths = this.cachedPaths
                ? (await Promise.all(this.cachedPaths.map(async cachedPath => (await validateJacExecutable(cachedPath)) ? cachedPath : null)))
                    .filter((cachedPath): cachedPath is string => cachedPath !== null)
                : [];
            if (this.cachedPaths && confirmedPaths.length !== this.cachedPaths.length) {
                this.cachedPaths = confirmedPaths;
                void this.cache.save(confirmedPaths);
                // Stale paths found — force fresh discovery so old locator results
                // don't re-add the deleted envs in onFreshBatch below.
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
                paths.forEach(jacPath => pickerPaths.add(jacPath));
                if (pickerPaths.size !== prev) { repaint(Array.from(pickerPaths)); }
            };
            const locatorPromises = [this.pathPromise, this.condaPromise, this.workspacePromise, this.homePromise]
                .filter((locator): locator is Promise<string[]> => locator !== undefined);
            locatorPromises.forEach(locator => locator.then(onFreshBatch).catch(() => {}));

            // Once all locators settle: persist cache, read versions (~1 ms each,
            // folder-name only — no subprocess), repaint with version labels +
            // Recommended section. Runs entirely after the picker is already visible.
            Promise.allSettled(locatorPromises).then(async () => {
                const finalPaths = Array.from(pickerPaths);
                this.cachedPaths = finalPaths;
                void this.cache.save(finalPaths);
                quickPick.busy = false;
                quickPick.placeholder = finalPaths.length > 0
                    ? `${finalPaths.length} environment${finalPaths.length > 1 ? 's' : ''} found`
                    : 'No Jac environments detected';

                const versionResults = await Promise.all(
                    finalPaths.map(envPath => getJacVersion(envPath))
                );

                let highestVersion: string | undefined;
                finalPaths.forEach((envPath, i) => {
                    const version = versionResults[i];
                    if (version) {
                        versionMap.set(envPath, version);
                        if (!highestVersion || compareJacVersions(version, highestVersion) > 0) {
                            highestVersion = version;
                            recommendedPath = envPath;
                        }
                    }
                });

                // Update title to show current env version now that we know it.
                quickPick.title = this.buildPickerTitle(versionMap.get(this.jacPath ?? ''));

                if (versionMap.size > 0) { repaint(finalPaths); }
            });

            const choice = await new Promise<AnyItem | undefined>(resolve => {
                const subs: vscode.Disposable[] = [];
                const cleanup = () => { pickerDisposed = true; subs.forEach(d => d.dispose()); };
                subs.push(
                    quickPick.onDidAccept(() => { resolve(quickPick.selectedItems[0]); quickPick.hide(); cleanup(); }),
                    quickPick.onDidHide(()   => { resolve(undefined); cleanup(); }),
                );
            });

            // Separators have no env field — treat a separator click as a dismiss.
            const envChoice = choice?.env ? (choice as EnvItem) : undefined;

            if (!envChoice || envChoice.env === 'manual' || envChoice.env === 'browse') {
                this.updateStatusBar();
                if (envChoice?.env === 'manual') { await this.handleManualPathEntry(); }
                else if (envChoice?.env === 'browse') { await this.handleFileBrowser(); }
                return;
            }

            this.jacPath = envChoice.env;
            this.invalidateAll();
            await this.context.globalState.update('jacEnvPath', envChoice.env);
            this.startBackgroundDiscovery();
            this.updateStatusBar();
            await this.restartLanguageServer();
        } catch (error: any) {
            this.updateStatusBar();
            vscode.window.showErrorMessage(`Error finding Jac environments: ${error.message || error}`);
        }
    }

    // Builds the picker title. If the active env is known, shows its version and name.
    // Example:
    //   buildPickerTitle()          → "Jac Environment"           (no env selected yet)
    //   buildPickerTitle("0.11.0")  → "Jac Environment  ·  currently: 0.11.0 (.venv2)"
    //   buildPickerTitle()          → "Jac Environment  ·  currently: (.venv2)"  (version not read yet)
    private buildPickerTitle(activeVersion?: string): string {
        if (!this.jacPath) { return 'Jac Environment'; }
        const { envName }  = this.parseEnvPath(this.jacPath);
        const versionPart  = activeVersion ? ` ${activeVersion}` : '';
        const namePart     = envName ? ` (${envName})` : '';
        return `Jac Environment  ·  currently:${versionPart}${namePart}`;
    }


    // Shows an input box where the user can type the full path to a jac binary.
    // Expands ~ to the home directory, then validates the file exists on disk.
    // On success: saves the path, updates the status bar, restarts the LSP.
    // On failure: offers Retry (try typing again) or Browse (open file picker).
    private async handleManualPathEntry() {
        const manualPath = await vscode.window.showInputBox({
            prompt: "Enter the path to the Jac executable",
            placeHolder: "/path/to/jac or C:\\path\\to\\jac.exe",
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return "Path cannot be empty";
                }
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

            if (await validateJacExecutable(normalizedPath)) {
                this.jacPath = normalizedPath;
                await this.context.globalState.update('jacEnvPath', normalizedPath);
                this.updateStatusBar();

                const { envName } = this.parseEnvPath(normalizedPath);
                vscode.window.showInformationMessage(
                    `Jac environment set to: ${envName || this.formatPathForDisplay(normalizedPath)}`
                );

                await this.restartLanguageServer();
            } else {
                const retry = await vscode.window.showErrorMessage(
                    'Invalid Jac executable.',
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

    // Opens a native file picker so the user can browse to a jac binary.
    // On success: saves the path, updates the status bar, restarts the LSP.
    // On failure: offers Try Again (open picker again) or Enter Path Manually.
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

            if (await validateJacExecutable(selectedPath)) {
                this.jacPath = selectedPath;
                await this.context.globalState.update('jacEnvPath', selectedPath);
                this.updateStatusBar();

                const { envName } = this.parseEnvPath(selectedPath);
                vscode.window.showInformationMessage(
                    `Jac environment set to: ${envName || this.formatPathForDisplay(selectedPath)}`
                );

                await this.restartLanguageServer();
            } else {
                const retry = await vscode.window.showErrorMessage(
                    'Not a valid Jac executable.',
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


    // Shortens a path for display in the picker description.
    // Rule 1 — replace the home directory prefix with ~:
    //   /home/user/project/.venv/bin/jac  →  ~/project/.venv/bin/jac
    // Rule 2 — if the path is still longer than 6 segments, collapse the middle:
    //   /very/long/deeply/nested/path/to/env/bin/jac  →  /very/long/.../env/bin/jac
    private formatPathForDisplay(envPath: string): string {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';

        if (homeDir && envPath.startsWith(homeDir)) {
            return envPath.replace(homeDir, '~');
        }

        const pathParts = envPath.split(path.sep);
        if (pathParts.length > 6) {
            const start = pathParts.slice(0, 2).join(path.sep);
            const end = pathParts.slice(-3).join(path.sep);
            return `${start}${path.sep}...${path.sep}${end}`;
        }

        return envPath;
    }

    // Updates the status bar item to reflect the currently selected env.
    // Shows "$(check) Jac" (or "Jac (Global)") when an env is set,
    // or "$(warning) Jac: No Env" when nothing is selected.
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

    // Restarts the LSP so it picks up the newly selected jac binary.
    // If the LSP is already running, stops it then starts it again.
    // If it was never started (e.g. no valid env existed at activation),
    // creates and starts it for the first time.
    private async restartLanguageServer(): Promise<void> {
        const lspManager = getLspManager();
        if (lspManager) {
            try {
                await lspManager.restart();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to restart language server: ${error.message || error}`);
            }
        } else {
            try {
                await createAndStartLsp(this, this.context);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to start language server: ${error.message || error}`);
            }
        }
    }
}