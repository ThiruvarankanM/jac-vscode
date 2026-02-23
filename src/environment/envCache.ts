import * as fs from 'fs/promises';
import * as path from 'path';

// Saves and loads jac executable paths to disk so VS Code remembers them
// between restarts. On the second open the QuickPick shows results instantly
// because the list is read from this file before any scan runs.
//
// File: globalStorageUri/jac-env-cache.json  (a plain JSON array of paths)
// If the file is missing or broken the extension just runs a fresh scan.
//
// Same idea as Python extension: src/client/environmentKnownCache.ts
export class EnvCache {
    private readonly filePath: string;

    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, 'jac-env-cache.json');
    }

    // Reads saved paths from disk. Returns undefined if file doesn't exist yet or is broken.
    // Example (2nd VS Code open):
    //   load() → ["/home/user/.venv/bin/jac", "/usr/local/bin/jac"]
    // Example (1st ever open, file not created yet):
    //   load() → undefined  (extension runs a fresh scan instead)
    async load(): Promise<string[] | undefined> {
        try {
            const raw = await fs.readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? (parsed as string[]) : undefined;
        } catch { return undefined; }
    }

    // Writes paths to disk. Called after the last (slowest) locator finishes
    // so the saved list is as complete as possible for the next session.
    // Safe to fail — the extension works fine without a cache.
    // Example:
    //   save(["/home/user/.venv/bin/jac", "/usr/local/bin/jac"])
    //   → writes to jac-env-cache.json:
    //     ["/home/user/.venv/bin/jac", "/usr/local/bin/jac"]
    async save(paths: string[]): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(paths), 'utf-8');
        } catch { /* non-fatal */ }
    }
}
