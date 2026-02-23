import * as fs from 'fs/promises';
import * as path from 'path';

// Persistent on-disk JSON cache of known jac executable paths.
// Survives VS Code restarts — on second open, QuickPick is instant.
// Non-fatal: missing/corrupt cache just falls back to fresh discovery.
//
// Cache file:
//   globalStorageUri/
//   |__ jac-env-cache.json   <-- JSON array of absolute jac paths
//
// Refer to Python's `environmentKnownCache.ts` for the equivalent.
export class EnvCache {
    private readonly filePath: string;

    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, 'jac-env-cache.json');
    }

    // Reads the cache. Returns undefined on first run or parse error.
    async load(): Promise<string[] | undefined> {
        try {
            const raw = await fs.readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? (parsed as string[]) : undefined;
        } catch { return undefined; }
    }

    // Writes paths to disk. Non-fatal if the write fails.
    async save(paths: string[]): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(paths), 'utf-8');
        } catch { /* non-fatal */ }
    }
}
