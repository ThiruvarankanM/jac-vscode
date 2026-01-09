/**
 * Platform Helper Functions
 * Platform-specific utilities for handling Python extension installation across WSL, macOS, and GitHub Actions
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export function isWSL(): boolean {
	try {
		const releaseFile = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
		return releaseFile.includes('microsoft') || releaseFile.includes('wsl');
	} catch {
		return false;
	}
}

export async function findPythonExtension(): Promise<string | null> {
	try {
		const homeDir = process.env.HOME || os.homedir();
		const systemExtensionsDir = path.join(homeDir, '.vscode-server/extensions');
		if (!fs.existsSync(systemExtensionsDir)) {
			return null;
		}
		const extensions = fs.readdirSync(systemExtensionsDir);
		const pythonExt = extensions.find(ext => ext.startsWith('ms-python.python-'));
		return pythonExt ? path.join(systemExtensionsDir, pythonExt) : null;
	} catch {
		return null;
	}
}

export async function copyExtension(source: string, destDir: string): Promise<void> {
	const extName = path.basename(source);
	const dest = path.join(destDir, extName);
	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}
	await execAsync(`cp -r "${source}" "${dest}"`);
}

export { execAsync, execFileAsync };
