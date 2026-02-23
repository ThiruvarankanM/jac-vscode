import * as fs from 'fs/promises';
import * as path from 'path';

// Reads the installed jaclang version for a given jac executable.
// Walks to the venv root then scans site-packages looking for a
// "jaclang-X.Y.Z.dist-info" folder — no file read needed, ~1 ms.
// Returns undefined if the version cannot be determined (e.g. global install
// in an unusual location).
export async function getJacVersion(jacPath: string): Promise<string | undefined> {
    try {
        // /path/to/.venv/bin/jac   → envRoot = /path/to/.venv
        // /usr/local/bin/jac       → envRoot = /usr/local
        const envRoot = path.dirname(path.dirname(jacPath));
        const libDir  = path.join(envRoot, 'lib');

        let libEntries: string[];
        try { libEntries = await fs.readdir(libDir); }
        catch { return undefined; }

        // Look inside lib/python3.x/site-packages for jaclang-*.dist-info
        for (const libEntry of libEntries.filter(e => e.startsWith('python'))) {
            try {
                const sitePackages = path.join(libDir, libEntry, 'site-packages');
                const siteEntries  = await fs.readdir(sitePackages);
                const distInfoDir  = siteEntries.find(
                    entry => entry.startsWith('jaclang-') && entry.endsWith('.dist-info')
                );
                if (distInfoDir) {
                    // "jaclang-0.11.0.dist-info" → "0.11.0"
                    return distInfoDir.slice('jaclang-'.length, -'.dist-info'.length);
                }
            } catch { continue; }
        }
        return undefined;
    } catch { return undefined; }
}

// Compares two version strings like "0.11.0" vs "0.9.2".
// Returns positive if a > b, negative if a < b, 0 if equal.
export function compareJacVersions(a: string, b: string): number {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (diff !== 0) { return diff; }
    }
    return 0;
}
