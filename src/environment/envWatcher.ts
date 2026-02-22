import * as vscode from 'vscode';
import * as path from 'path';
import { getKnownPaths } from '../utils/platformPaths';

export type EnvWatcherCallbacks = {
    /** Called ~1 s after a new `jac` binary appears on disk. */
    onJacCreated: (jacPath: string) => void;
    /** Called immediately when a `jac` binary is removed from disk. */
    onJacDeleted: (jacPath: string) => void;
    /** Called when conda's `environments.txt` changes (should trigger a debounced re-scan). */
    onCondaChanged: () => void;
};

/**
 * Watches the file system for `jac` binary changes across all known
 * environment locations: workspace folders, home venv stores, pyenv/uv
 * Python installs, conda, and every $PATH directory.
 *
 * Inspired by the VS Code Python extension's `pythonBinariesWatcher.ts`:
 * watching the executable directly avoids false positives and means
 * `uri.fsPath` is a ready-to-use absolute path.
 */
export class EnvWatcher {

    // Deep glob — any depth, any env name (workspace + Python install dirs)
    private static readonly JAC_GLOB =
        process.platform === 'win32' ? '**/Scripts/jac.exe' : '**/bin/jac';

    // Shallow glob — one level deep (flat venv stores: poetry, pipenv, uv tools, pipx…)
    private static readonly HOME_JAC_GLOB =
        process.platform === 'win32' ? '*/Scripts/jac.exe' : '*/bin/jac';

    private disposables: vscode.Disposable[] = [];

    constructor(private readonly callbacks: EnvWatcherCallbacks) {}

    /**
     * Registers all FS watchers. Safe to call multiple times —
     * disposes existing watchers before setting up fresh ones.
     */
    start(): void {
        this.dispose();
        this.watchWorkspaceFolders();
        this.watchHomeDirectories();
        this.watchPathDirectories();
    }

    // ── Workspace folders ──────────────────────────────────────────────────

    private watchWorkspaceFolders(): void {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            // Deep glob — catches jac added to PRE-EXISTING envs at any depth.
            this.addBinaryWatcher(new vscode.RelativePattern(folder, EnvWatcher.JAC_GLOB));

            // Shallow pyvenv.cfg watcher — `*/pyvenv.cfg` watches ONE level deep
            // in the workspace root, which is an EXISTING directory.  FSEvents
            // fires reliably here (no new-directory latency) and fires as soon as
            // `python -m venv .venv` finishes, well before `pip install jaclang`.
            // We then create a pinpoint watcher for that specific venv's bin/jac,
            // which is also in an existing directory — so it fires the instant pip
            // drops the binary, regardless of the deep-glob latency.
            const cfgW = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, '*/pyvenv.cfg')
            );
            this.disposables.push(
                cfgW,
                cfgW.onDidCreate(uri => this.watchNewVenvForJac(path.dirname(uri.fsPath))),
            );
        }
    }

    /**
     * Called when pyvenv.cfg appears one level inside the workspace root.
     * At this point bin/ already exists (created by `python -m venv`).
     * Creates a pinpoint watcher for jac inside that specific venv's bin dir
     * so it fires the instant pip drops the binary.
     * Self-cleans after the first hit or after 1 hour (leak guard).
     */
    private watchNewVenvForJac(venvDir: string): void {
        const subDir = process.platform === 'win32' ? 'Scripts' : 'bin';
        const jacExe = process.platform === 'win32' ? 'jac.exe' : 'jac';
        const binUri = vscode.Uri.file(path.join(venvDir, subDir));

        const w = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(binUri, jacExe)
        );

        const cleanup = () => {
            clearTimeout(guard);
            w.dispose();
        };
        const guard = setTimeout(cleanup, 60 * 60 * 1000); // 1-hour leak guard

        this.disposables.push(w, { dispose: cleanup });

        w.onDidCreate(uri => {
            cleanup();
            this.callbacks.onJacCreated(uri.fsPath);
        });
    }

    // ── Home directories ───────────────────────────────────────────────────

    private watchHomeDirectories(): void {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) { return; }

        const { venvManagerDirs, toolsDirs, pythonInstallDirs } = getKnownPaths(homeDir);

        // One-level watch — flat venv stores (virtualenvwrapper, poetry, pipenv, uv tools, pipx…)
        for (const dir of [...venvManagerDirs, ...toolsDirs]) {
            this.addBinaryWatcher(
                new vscode.RelativePattern(vscode.Uri.file(dir), EnvWatcher.HOME_JAC_GLOB)
            );
        }

        // Deep watch — Python install dirs (pyenv versions, uv python).
        // JAC_GLOB catches both direct installs and pyenv-virtualenv nested envs.
        for (const dir of pythonInstallDirs) {
            this.addBinaryWatcher(
                new vscode.RelativePattern(vscode.Uri.file(dir), EnvWatcher.JAC_GLOB)
            );
        }

        // Conda: environments.txt is rewritten whenever a conda env is created/removed.
        const condaW = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.file(path.join(homeDir, '.conda')),
                'environments.txt'
            )
        );
        this.disposables.push(
            condaW,
            condaW.onDidCreate(() => this.callbacks.onCondaChanged()),
            condaW.onDidChange(() => this.callbacks.onCondaChanged()),
        );
    }

    // ── $PATH directories ──────────────────────────────────────────────────

    private watchPathDirectories(): void {
        const jacExe   = process.platform === 'win32' ? 'jac.exe' : 'jac';
        const pathDirs = [...new Set((process.env.PATH ?? '').split(path.delimiter).filter(Boolean))];
        for (const dir of pathDirs) {
            this.addBinaryWatcher(
                new vscode.RelativePattern(vscode.Uri.file(dir), jacExe)
            );
        }
    }

    // ── Shared helper ──────────────────────────────────────────────────────

    private addBinaryWatcher(pattern: vscode.RelativePattern): void {
        const w = vscode.workspace.createFileSystemWatcher(pattern);
        this.disposables.push(
            w,
            w.onDidCreate(uri => this.callbacks.onJacCreated(uri.fsPath)),
            w.onDidDelete(uri => this.callbacks.onJacDeleted(uri.fsPath)),
        );
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
