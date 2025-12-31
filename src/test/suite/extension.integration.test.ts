import * as vscode from 'vscode';
import { expect } from 'chai';
import * as path from 'path';

describe('Extension Integration Tests', () => {
    let workspacePath: string;

    // Initialize workspace path for all tests
    before(() => {
        const folders = vscode.workspace.workspaceFolders;
        expect(folders).to.exist;
        expect(folders?.length).to.be.greaterThan(0);
        workspacePath = folders![0].uri.fsPath;
    });

    /* 
       Test Group 1: Extension Activation
       Verify VS Code extension infrastructure is properly set up,
       including activation, language registration, workspace loading,
       and opening of a sample .jac file.
    */
    describe('Test 1: Extension Activation', () => {

        // Verify extension can be loaded and activated in VS Code
        it('should activate the Jac extension', async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            expect(ext).to.exist;

            await ext!.activate();
            expect(ext!.isActive).to.be.true;
        });

        // Verify VS Code recognizes 'jac' as a supported language
        it('should register Jac language', async () => {
            const languages = await vscode.languages.getLanguages();
            expect(languages).to.include('jac');
        });

        // Verify test workspace with sample files is properly opened
        it('should load test workspace with fixtures', () => {
            expect(workspacePath).to.include('fixtures/workspace');
        });

        // Verify sample.jac file is recognized as a JAC file
        it('should open sample.jac and detect language correctly', async () => {
            const filePath = path.join(workspacePath, 'sample.jac');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

            expect(doc).to.exist;
            expect(doc.fileName).to.include('sample.jac');
            expect(doc.languageId).to.equal('jac');
        });
    });

    /* 
       Test Group 2: Environment Detection & Management
       Verify JAC environment detection, Python path resolution, 
       status bar creation, and handling of .jac file opening and 
       environment selection commands.
    */
    describe('Test 2: Environment Detection & Management', () => {
        let envManager: any;

        // Initialize extension and retrieve EnvManager instance for tests
        before(async () => {
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            await ext!.activate();

            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();

            expect(envManager, 'EnvManager should be exposed from extension').to.exist;
        });

        afterEach(async () => {
            // Clean up open editors after each test
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        });

        // Verify EnvManager initializes and provides valid JAC path
        it('should initialize EnvManager and get Jac path (or fallback)', () => {
            const jacPath = envManager.getJacPath();

            expect(jacPath).to.exist;
            expect(jacPath).to.be.a('string');
            expect(jacPath.length).to.be.greaterThan(0);
        });

        // Verify EnvManager correctly resolves Python executable path from JAC environment
        it('should return Python path based on Jac path', () => {
            const pythonPath = envManager.getPythonPath();

            expect(pythonPath).to.exist;
            expect(pythonPath).to.be.a('string');
            expect(pythonPath.length).to.be.greaterThan(0);
            expect(pythonPath.toLowerCase()).to.include('python');
        });

        // Verify VS Code status bar is created for displaying environment information
        it('should have status bar created after initialization', () => {
            const statusBar = envManager.getStatusBar();
            expect(statusBar).to.exist;
        });

        // Verify opening a JAC file works without errors
        it('should handle .jac file opening and trigger environment detection', async () => {
            const filePath = path.join(workspacePath, 'sample.jac');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        });

        // Verify selectEnv command executes successfully and handles environment selection UI
        it('should execute selectEnv command without throwing errors', async () => {
            try {
                await vscode.commands.executeCommand('jaclang-extension.selectEnv');
                await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
            } catch (error) {
                expect.fail(`selectEnv command failed: ${error}`);
            }
        });
    });
});
