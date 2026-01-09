/**
 * Integration Test Runner (VS Code Test Mode)
 * Launches VS Code with extension, fixture workspace, and Mocha tests
 */

import * as path from 'path';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { isWSL, findPythonExtension, copyExtension, execAsync, execFileAsync } from './platformHelper';

async function main() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');
		const extensionTestsPath = path.resolve(__dirname, './suite/index');
		const testWorkspacePath = path.resolve(__dirname, './fixtures/workspace');
		const extensionsDir = path.resolve(__dirname, '../../.vscode-test/extensions');
		const userDataDir = path.resolve(__dirname, '../../.vscode-test/user-data');

		const vscodeExecutablePath = await downloadAndUnzipVSCode();
		const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

		console.log('Installing dependencies...');

		const wslMode = isWSL();
		if (wslMode) {
			const pythonExtDir = await findPythonExtension();
			if (pythonExtDir) {
				await copyExtension(pythonExtDir, extensionsDir);
				console.log('✓ Python extension copied\n');
			} else {
				try {
					await execAsync(`${cli} --user-data-dir ${userDataDir} --extensions-dir ${extensionsDir} --install-extension ms-python.python`);
					console.log('✓ Dependencies installed\n');
				} catch (err) {
					console.warn('⚠️ Could not install Python extension automatically, test may fail\n');
				}
			}
		} else {
			try {
				await execFileAsync(cli, [...args, '--install-extension', 'ms-python.python']);
				console.log('✓ Dependencies installed\n');
			} catch (err) {
				console.warn('⚠️ Extension installation failed:', (err as Error).message);
			}
		}

		console.log('📋 Starting integration tests');
		console.log(`   Extension: ${extensionDevelopmentPath}`);
		console.log(`   Workspace: ${testWorkspacePath}\n`);

		const launchArgs = [
			testWorkspacePath,
			'--disable-workspace-trust',
			'--no-sandbox',
		];

		if (wslMode) {
			launchArgs.push('--user-data-dir', userDataDir, '--extensions-dir', extensionsDir);
		}

		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			vscodeExecutablePath,
			launchArgs,
		});


		console.log('✓ Tests completed successfully');
	} catch (err) {
		console.error('❌ Failed to run tests:', err);
		process.exit(1);
	}
}

main();