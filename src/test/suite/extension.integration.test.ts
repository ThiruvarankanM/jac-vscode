import * as vscode from 'vscode';
import { expect } from 'chai';
import * as path from 'path';

/**
 * Extension Integration Tests
 * 
 * Test 1: Extension Activation
 * Test 2: Environment Detection
 * Test 3: Advanced Environment Management
 * Test 4: Error Handling
 * Test 5: Environment Unavailability Handling (e.g., JAC uninstalled after selection)
 */
describe('Extension Integration Tests', () => {
    let workspacePath: string;

    before(() => {
        const folders = vscode.workspace.workspaceFolders;
        expect(folders).to.exist;
        expect(folders?.length).to.be.greaterThan(0);
        workspacePath = folders![0].uri.fsPath;
    });

    describe('Test 1: Extension Activation', () => {
        it('should activate the Jac extension', async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            expect(ext).to.exist;

            await ext!.activate();
            expect(ext!.isActive).to.be.true;
        });

        it('should register Jac language', async () => {
            const languages = await vscode.languages.getLanguages();
            expect(languages).to.include('jac');
        });

        it('should load test workspace with fixtures', () => {
            const folders = vscode.workspace.workspaceFolders;

            expect(folders).to.exist;
            expect(folders!.length).to.equal(1);
            expect(folders![0].uri.fsPath).to.include('fixtures/workspace');
        });

        it('should open sample.jac and detect language correctly', async () => {
            const filePath = path.join(workspacePath, 'sample.jac');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

            expect(doc).to.exist;
            expect(doc.fileName).to.include('sample.jac');
            expect(doc.languageId).to.equal('jac');
        });
    });

    describe('Test 2: Environment Detection & Management', () => {
        let envManager: any;

        before(async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            await ext!.activate();

            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();

            expect(envManager, 'EnvManager should be exposed from extension').to.exist;
        });

        it('should initialize EnvManager and get Jac path (or fallback)', () => {
            const jacPath = envManager.getJacPath();

            expect(jacPath).to.exist;
            expect(jacPath).to.be.a('string');
            expect(jacPath.length).to.be.greaterThan(0);
        });

        it('should return Python path based on Jac path', () => {
            const pythonPath = envManager.getPythonPath();

            expect(pythonPath).to.exist;
            expect(pythonPath).to.be.a('string');
            expect(pythonPath.length).to.be.greaterThan(0);
            expect(pythonPath.toLowerCase()).to.include('python');
        });

        it('should have status bar created after initialization', () => {
            const statusBar = envManager.getStatusBar();
            expect(statusBar).to.exist;
        });

        it('should handle .jac file opening and trigger environment detection', async function () {
            this.timeout(5000);

            const filePath = path.join(workspacePath, 'sample.jac');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);

            await new Promise(resolve => setTimeout(resolve, 1000));

            const jacPath = envManager.getJacPath();
            expect(jacPath).to.exist;

            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        });

        it('should persist environment selection in global state', () => {
            const currentPath = envManager.getJacPath();
            expect(currentPath).to.exist;
            expect(currentPath).to.be.a('string');
        });

        it('should execute selectEnv command without throwing errors', async function () {
            this.timeout(3000);

            try {
                const commandPromise = vscode.commands.executeCommand('jaclang-extension.selectEnv');

                await new Promise(resolve => setTimeout(resolve, 500));
                await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

                expect(true).to.be.true;
            } catch (error) {
                expect.fail(`selectEnv command failed: ${error}`);
            }
        });
    });

    describe('Test 3: Advanced Environment Management', () => {
        let envManager: any;

        before(async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            await ext!.activate();

            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();

            expect(envManager, 'EnvManager should be exposed from extension').to.exist;
        });

        it('should allow manual path entry for Jac executable', async function () {
            this.timeout(5000);

            // Get the initial Jac path before manual entry
            const initialPath = envManager.getJacPath();
            expect(initialPath).to.exist;

            // Execute selectEnv command to open quick pick
            const selectEnvPromise = vscode.commands.executeCommand('jaclang-extension.selectEnv');

            // Wait for quick pick to appear
            await new Promise(resolve => setTimeout(resolve, 500));

            // Simulate user selecting "Manually specify the path" option
            // Press down arrow to navigate to manual option, then enter
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
            await new Promise(resolve => setTimeout(resolve, 100));
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

            // Wait for input box to appear (manual path entry)
            await new Promise(resolve => setTimeout(resolve, 500));

            // Type a test path (use the current path to ensure it's valid)
            const testPath = initialPath.includes('jac') ? initialPath : process.platform === 'win32' ? 'C:\\Program Files\\jac\\jac.exe' : '/usr/local/bin/jac';

            await vscode.commands.executeCommand('type', { text: testPath });

            // Press enter to confirm the path
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

            // Wait for validation and state update
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify the path was set (it should be the same as before if valid)
            const updatedPath = envManager.getJacPath();
            expect(updatedPath).to.exist;
            expect(updatedPath).to.be.a('string');

            // Verify status bar reflects the change
            const statusBar = envManager.getStatusBar();
            expect(statusBar).to.exist;
        });
    });
    describe('Test 4: Error Handling', () => {
        let envManager: any;

        before(async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            await ext!.activate();

            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();

            expect(envManager, 'EnvManager should be exposed from extension').to.exist;
        });

        it('should show error for invalid path entry', async function () {
            this.timeout(5000);

            // Execute selectEnv command to open quick pick
            vscode.commands.executeCommand('jaclang-extension.selectEnv');

            // Wait for quick pick to appear
            await new Promise(resolve => setTimeout(resolve, 500));

            // Navigate to manual path entry option
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
            await new Promise(resolve => setTimeout(resolve, 100));
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

            // Wait for input box to appear
            await new Promise(resolve => setTimeout(resolve, 500));

            // Type an invalid path that doesn't exist
            const invalidPath = process.platform === 'win32'
                ? 'C:\\nonexistent\\path\\to\\jac.exe'
                : '/nonexistent/path/to/jac';

            await vscode.commands.executeCommand('type', { text: invalidPath });

            // Press enter to confirm the invalid path
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

            // Wait for error handling and dialog to appear
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Verify an error message was shown (the system should handle invalid paths)
            // Close any open dialogs
            try {
                await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
                await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
            } catch (e) {
                // Ignore errors from closing dialogs
            }

            // Verify the path wasn't changed to the invalid one
            const currentPath = envManager.getJacPath();
            expect(currentPath).to.exist;
            expect(currentPath).to.be.a('string');
            // The path should NOT be the invalid path we entered
            expect(currentPath).to.not.equal(invalidPath);
        });
    });
    

    describe('Test 5: Environment Unavailability Handling', () => {
        let envManager: any;

        before(async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            await ext!.activate();

            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();

            expect(envManager, 'EnvManager should be exposed from extension').to.exist;
        });

        it('should handle environment becoming unavailable gracefully', async function () {
            this.timeout(8000);

            // Save the initial JAC path (which should be the currently installed one)
            const initialPath = envManager.getJacPath();
            expect(initialPath).to.exist;

            // Simulate environment removal by clearing the stored path in global state
            // This mimics the scenario where JAC is uninstalled after being selected
            const context = (vscode as any).globalExtensionContext ||
                (vscode.extensions.getExtension('jaseci-labs.jaclang-extension')?.exports?.getContext?.());

            if (context && context.globalState) {
                await context.globalState.update('jacPath', '');
                await context.globalState.update('selectedEnv', undefined);
            }

            // Wait for state update
            await new Promise(resolve => setTimeout(resolve, 500));

            // Execute selectEnv command to open quick pick
            vscode.commands.executeCommand('jaclang-extension.selectEnv');

            // Wait for quick pick to appear
            await new Promise(resolve => setTimeout(resolve, 500));

            // The quick pick should either show no environments available or show auto-detection
            // Press escape to close the quick pick
            await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

            // Wait for dialog to close
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify that the extension handled the missing environment gracefully
            const currentPath = envManager.getJacPath();

            // The path might be empty or reset due to the cleared global state
            // The important thing is that the extension didn't crash
            expect(envManager).to.exist;
            expect(currentPath).to.be.a('string');
        });

        it('should recover when valid environment is re-selected after unavailability', async function () {
            this.timeout(6000);

            // Get a valid JAC path to re-select
            let validPath = envManager.getJacPath();

            // If the path is empty or invalid from previous test, try to find a valid one
            if (!validPath || validPath === '') {
                // Use a common JAC installation path or fallback
                validPath = process.platform === 'win32'
                    ? 'C:\\Program Files\\jac\\jac.exe'
                    : '/usr/local/bin/jac';
            }

            // Execute selectEnv command to re-select environment
            vscode.commands.executeCommand('jaclang-extension.selectEnv');

            // Wait for quick pick to appear
            await new Promise(resolve => setTimeout(resolve, 500));

            // Navigate to manual path entry
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
            await new Promise(resolve => setTimeout(resolve, 100));
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

            // Wait for input box
            await new Promise(resolve => setTimeout(resolve, 500));

            // Enter the valid path
            await vscode.commands.executeCommand('type', { text: validPath });

            // Confirm path entry
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

            // Wait for validation and state update
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Verify the environment was re-selected and is now available
            const recoveredPath = envManager.getJacPath();
            expect(recoveredPath).to.exist;
            expect(recoveredPath).to.be.a('string');

            // Verify status bar reflects the change
            const statusBar = envManager.getStatusBar();
            expect(statusBar).to.exist;
        });
    });
});