/**
 * Integration Test Runner (VS Code Test Mode)
 * Launches VS Code with extension, fixture workspace, and Mocha tests
 */

import * as path from 'path';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function main() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');
		const extensionTestsPath = path.resolve(__dirname, './suite/index');
		const testWorkspacePath = path.resolve(__dirname, './fixtures/workspace');

		const vscodeExecutablePath = await downloadAndUnzipVSCode();
		const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

		console.log('Installing dependencies...');

		try {
			await execFileAsync(cli, [...args, '--install-extension', 'ms-python.python']);
			console.log('✓ Dependencies installed\n');
		} catch (err) {
			console.warn('⚠️ Extension installation failed:', (err as Error).message);
		}

		console.log('📋 Starting integration tests');
		console.log(`   Extension: ${extensionDevelopmentPath}`);
		console.log(`   Workspace: ${testWorkspacePath}\n`);

		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			vscodeExecutablePath,
			launchArgs: [
				testWorkspacePath,
				'--disable-workspace-trust',
				'--no-sandbox',
				'--disable-gpu',
			],
		});
		

		console.log('✓ Tests completed successfully');
	} catch (err) {
		console.error('❌ Failed to run tests:', err);
		process.exit(1);
	}
}

main();