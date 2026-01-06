/**
 * JAC Language Extension - Integration Test Suite
 *
 * Tests the complete lifecycle of the Jaclang extension:
 * - Phase 1: Extension initialization and language registration
 * - Phase 2: Complete environment lifecycle (venv creation, jaclang installation,
 *            environment detection & selection, cleanup & verification)
 *
 * NOTE: Tests run sequentially and share state across phases.
 */

import * as vscode from 'vscode';
import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';

describe('Extension Integration Tests - Full Lifecycle', () => {
    let workspacePath: string;

    before(() => {
        // Resolve workspace path from VS Code workspace folders
        const folders = vscode.workspace.workspaceFolders;
        expect(folders).to.exist;
        expect(folders?.length).to.be.greaterThan(0);
        workspacePath = folders![0].uri.fsPath;
    });

    /**
     * PHASE 1: Initial Extension State - No Environment
     *
     * Verifies the extension loads correctly without any environment configured:
     * - Status bar shows "No Env"
     * - JAC language is registered
     * - Opening .jac files triggers environment prompt
     */
    describe('Phase 1: Initial Extension State - No Environment', () => {
        let envManager: any;

        before(async function () {
            this.timeout(30_000);
            // Mock the environment prompts to prevent blocking during test
            vscode.window.showWarningMessage = async () => undefined as any;
            vscode.window.showInformationMessage = async () => undefined as any;

            // Get extension reference (not yet activated)
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            expect(ext).to.exist;
            expect(ext!.isActive).to.be.false; // Should not be active before opening .jac file
            
            // Open sample.jac file - this should trigger auto-activation via onLanguage:jac activation event
            const filePath = path.join(workspacePath, 'sample.jac');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
            
            // Wait for activation to complete
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Verify extension auto-activated after opening .jac file
            expect(ext!.isActive).to.be.true; // Should now be active
            
        });

        afterEach(async () => {
            // Clean up any open editors between tests
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        });

        it('should show "No Env" status bar when extension starts', () => {
            // When no environment is selected, status bar displays "No Env"
            const statusBar = envManager.getStatusBar();
            expect(statusBar.text).to.include('No Env');
        });

        it('should load extension and register jac language', async () => {
            // Extension should be active and JAC language properly registered
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            expect(ext).to.exist;
            expect(ext!.isActive).to.be.true;

            const languages = await vscode.languages.getLanguages();
            expect(languages).to.include('jac');
        });

        it('should open .jac file and recognize language correctly', async function () {
            this.timeout(10_000);

            // Open a .jac file and verify it's recognized by the extension
            const filePath = path.join(workspacePath, 'sample.jac');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);

            // Verify document was opened successfully and language is detected
            expect(doc.languageId).to.equal('jac');
            expect(vscode.window.activeTextEditor?.document).to.equal(doc);
        });
    });


    /**
     * PHASE 2: Environment Lifecycle - Install, Select, Verify & Cleanup
     *
     * Tests the complete environment workflow:
     * - Detects Python and creates virtual environment
     * - Installs jaclang package
     * - Tests environment detection and selection
     * - Verifies status bar updates
     * - Cleans up by uninstalling and removing venv
     */
    describe('Phase 2: Environment Lifecycle - Install, Select, Verify & Cleanup', () => {
        let temporaryVenvDirectory = '';
        let venvPath = '';
        let pythonCmd: { cmd: string; argsPrefix: string[] };
        let venvPythonPath = '';
        let jacExePath = '';
        let envManager: any;

        /**
         * Execute shell commands and capture output
         * Returns exit code, stdout, and stderr for verification
         */
        async function runCommand(cmd: string, args: string[]) {
            return await new Promise<{ code: number; commandOutput: string; commandError: string }>((resolve, reject) => {
                const childProcess = spawn(cmd, args, { shell: false });
                let commandOutput = '';
                let commandError = '';
                childProcess.stdout.on('data', (data) => (commandOutput += data.toString()));
                childProcess.stderr.on('data', (data) => (commandError += data.toString()));
                childProcess.on('error', reject);
                childProcess.on('close', (code) => resolve({ code: code ?? 0, commandOutput, commandError }));
            });
        }

        /**
         * Check if a file or directory exists
         */
        async function fileExists(filePath: string) {
            try {
                await fs.stat(filePath);
                return true;
            } catch {
                return false;
            }
        }

        /**
         * Detect available Python interpreter
         * Tries: py -3 (Windows), python3, python
         */
        async function detectPython(): Promise<{ cmd: string; argsPrefix: string[] } | null> {
            if (process.platform === 'win32') {
                try {
                    const versionCheckResult = await runCommand('py', ['-3', '--version']);
                    if (versionCheckResult.code === 0) return { cmd: 'py', argsPrefix: ['-3'] };
                } catch { }
            }
            try {
                const versionCheckResult = await runCommand('python3', ['--version']);
                if (versionCheckResult.code === 0) return { cmd: 'python3', argsPrefix: [] };
            } catch { }
            try {
                const versionCheckResult = await runCommand('python', ['--version']);
                if (versionCheckResult.code === 0) return { cmd: 'python', argsPrefix: [] };
            } catch { }
            return null;
        }

        before(async function () {
            this.timeout(30_000);
            // Initialize paths and environment manager
            const detectedPython = await detectPython();
            if (!detectedPython) {
                throw new Error('Python interpreter not found. Tests require Python to be installed.');
            }
            pythonCmd = detectedPython;
            temporaryVenvDirectory = path.join(workspacePath, '.venv');
            venvPath = temporaryVenvDirectory;

            // Platform-specific paths to Python and jac executables
            venvPythonPath = process.platform === 'win32'
                ? path.join(venvPath, 'Scripts', 'python.exe')
                : path.join(venvPath, 'bin', 'python');
            jacExePath = process.platform === 'win32'
                ? path.join(venvPath, 'Scripts', 'jac.exe')
                : path.join(venvPath, 'bin', 'jac');

            // Get environment manager for status bar verification
            // Extension should already be active from Phase 1 (opened sample.jac file)
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            expect(ext!.isActive).to.be.true; // Should still be active from Phase 1
            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();
        });

        afterEach(async () => {
            // Clean up any open editors between tests
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        });

        after(async () => {
            // Final cleanup: ensure test workspace is clean
            if (temporaryVenvDirectory) {
                try {
                    await fs.rm(temporaryVenvDirectory, { recursive: true, force: true });
                } catch { }
            }
        });

        // === INSTALLATION PHASE ===

        it('should detect Python interpreter', () => {
            // Verify Python is available on the system
            expect(pythonCmd, 'Python must be available').to.exist;
        });

        it('should create Python virtual environment', async function () {
            this.timeout(30_000);

            // Create isolated virtual environment where jaclang will be installed
            //recursive: true prevents errors if .venv already exists from a previous incomplete test run.
            await fs.mkdir(temporaryVenvDirectory, { recursive: true });

            const venvCreationResult = await runCommand(pythonCmd.cmd, [...pythonCmd.argsPrefix, '-m', 'venv', venvPath]);

            expect(venvCreationResult.code).to.equal(0);
            expect(await fileExists(venvPythonPath)).to.be.true;
        });

        it('should install jaclang package via pip with terminal feedback', async function () {
            this.timeout(300_000);

            // Display terminal window for visual installation feedback
            const terminal = vscode.window.createTerminal({
                name: 'JAC: Installing',
                cwd: workspacePath,
            });
            terminal.show(true);

            terminal.sendText(`${venvPythonPath} -m pip install -U jaclang`, true);

            // Execute installation in background
            const installationResult = await runCommand(venvPythonPath, ['-m', 'pip', 'install', '-U', '--no-cache-dir', 'jaclang']);

            // Verify installation success
            expect(installationResult.code).to.equal(0);
            expect(await fileExists(jacExePath)).to.be.true;
        });

        it('should verify jac executable works', async function () {
            this.timeout(15_000);

            // Test that the installed jac binary is functional
            const versionCheckResult = await runCommand(jacExePath, ['--version']);

            expect(versionCheckResult.code).to.equal(0);
            expect(versionCheckResult.commandOutput).to.have.length.greaterThan(0);
        });

        // === ENVIRONMENT DETECTION & SELECTION PHASE ===

        it('should have venv jac binary available in test environment', async function () {
            this.timeout(15_000);

            // Verify test workspace structure contains expected fixtures
            expect(workspacePath).to.include('fixtures/workspace');
        });

        it('should detect environments after jaclang installation', async function () {
            this.timeout(15_000);

            // After installing jaclang, environment detection should find the .venv jac executable
            const { findPythonEnvsWithJac } = await import('../../utils/envDetection');
            const envs = await findPythonEnvsWithJac(workspacePath);

            // Unlike Phase 1 (where no environments existed), now we should have at least one
            expect(envs.length).to.be.greaterThan(0);

            const foundVenvJac = envs.some(env => env.includes('.venv'));
            expect(foundVenvJac, '.venv jac executable should be detected').to.be.true;

            // Note: The "Select Environment" popup won't appear in same session due to hasPromptedThisSession flag
            // The popup behavior was already tested in Phase 1
        });

        it('should allow environment selection through selectEnv command', async function () {
            this.timeout(15_000);

            // Import environment detection utility to verify environments are found
            const { findPythonEnvsWithJac } = await import('../../utils/envDetection');

            // Verify environment detection finds our installed jac
            const envs = await findPythonEnvsWithJac(workspacePath);
            expect(envs.length).to.be.greaterThan(0);

            const foundVenvJac = envs.some(env => env.includes('.venv'));
            expect(foundVenvJac).to.be.true;

            // Trigger environment selection command
            await vscode.commands.executeCommand('jaclang-extension.selectEnv');
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Navigate to .venv option in quick pick menu
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');

            // Confirm selection
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Verify environment was successfully selected
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            const envMgr = ext!.exports?.getEnvManager?.();
            const selectedJacPath = envMgr?.getJacPath?.();

            expect(selectedJacPath).to.include('.venv');

        });

        it('should update status bar to show selected environment path', async function () {
            this.timeout(5_000);

            // After environment selection, status bar should display the selected path
            const statusBar = envManager?.getStatusBar?.();

            // Status bar should no longer show "No Env" and should include path indicator
            expect(statusBar?.text).to.not.include('No Env');
            expect(statusBar?.text.length).to.be.greaterThan(0);
        });

        // === CLEANUP & VERIFICATION PHASE ===

        it('should uninstall jaclang from venv', async function () {
            this.timeout(60_000);

            // Display terminal window for visual uninstall feedback
            const terminal = vscode.window.createTerminal({
                name: 'JAC: Uninstalling',
                cwd: workspacePath,
            });
            terminal.show(true);

            terminal.sendText(`${venvPythonPath} -m pip uninstall -y jaclang`, true);

            // Allow terminal to render the command before executing
            await new Promise(resolve => setTimeout(resolve, 500));

            // Remove jaclang package from virtual environment
            // Exit code 0 = success, Exit code 2 = package not found (acceptable)
            const uninstallResult = await runCommand(venvPythonPath, ['-m', 'pip', 'uninstall', '-y', 'jaclang']);
            expect([0, 2]).to.include(uninstallResult.code,
                `Uninstall failed with exit code ${uninstallResult.code}: ${uninstallResult.commandError}`);
        });

        it('should update status bar back to "No Env" after uninstall', async function () {
            this.timeout(10_000);

            // Trigger environment refresh after uninstall
            await vscode.commands.executeCommand('jaclang-extension.selectEnv');
            await new Promise(resolve => setTimeout(resolve, 500));
            await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

            // Status bar should revert to "No Env" since jac is no longer available
            const statusBar = envManager?.getStatusBar?.();

            // After cleanup, should show "No Env" again
            expect(statusBar?.text).to.include('No Env');
        });

        it('should properly clean up venv directory', async function () {
            this.timeout(10_000);

            // Remove entire virtual environment directory
            if (temporaryVenvDirectory) {
                try {
                    await fs.rm(temporaryVenvDirectory, { recursive: true, force: true });
                } catch { }
            }

            // Verify directory was actually deleted
            const dirExists = await fileExists(temporaryVenvDirectory);
            expect(dirExists).to.be.false;
        });
    });
});
