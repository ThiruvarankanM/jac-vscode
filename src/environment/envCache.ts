import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Manages the persistent on-disk cache of known `jac` executable paths.
 * Written to the extension's global storage so it survives VS Code restarts.
 */
export class EnvCache {
    private readonly filePath: string;

    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, 'jac-env-cache.json');
    }

    /** Absolute path to the cache file (for display / diagnostics). */
    get diskPath(): string { return this.filePath; }

    /** Reads and parses the cache. Returns `undefined` on first run or parse error. */
    async load(): Promise<string[] | undefined> {
        try {
            const rawJson = await fs.readFile(this.filePath, 'utf-8');
            const parsed  = JSON.parse(rawJson);
            return Array.isArray(parsed) ? (parsed as string[]) : undefined;
        } catch { return undefined; }
    }

    /** Persists the given paths. Non-fatal — extension works without a cache. */
    async save(paths: string[]): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(paths), 'utf-8');
        } catch { /* non-fatal */ }
    }
}
