/**
 * JAC Language Extension - LSP Integration Test Suite
 *
 * Tests Language Server Protocol (LSP) specific functionality:
 *
 * Test Group 1: LSP Initialization and Startup
 *   - LSP manager availability
 *   - Output channel creation and logging
 *
 * Test Group 2: LSP Features (Code Intelligence)
 *   - Diagnostics: Error/warning detection for invalid JAC syntax
 *   - Hover: Hover information display for node definitions
 */

import * as vscode from 'vscode';
import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileExists } from './testUtils';

describe('LSP Integration Tests - Language Server Protocol', () => {
    let workspacePath: string;
    let lspManager: any;
    let envManager: any;

    before(() => {
        // Resolve workspace path from VS Code workspace folders
        const folders = vscode.workspace.workspaceFolders;
        expect(folders).to.exist;
        expect(folders?.length).to.be.greaterThan(0);
        workspacePath = folders![0].uri.fsPath;
    });

    /**
     * Test Group 1: LSP Initialization and Startup
     *
     * Tests that LSP starts correctly when jac environment is available
     * and provides access to the output channel.
     */

    describe('Test Group 1: LSP Initialization and Startup', () => {
        before(async () => {
            // Get extension and managers (extension already activated in environment tests)
            const ext = vscode.extensions.getExtension('jaseci-labs.jaclang-extension');
            const exports = ext!.exports;
            envManager = exports?.getEnvManager?.();
            lspManager = exports?.getLspManager?.();
            expect(envManager, 'EnvManager should be exposed').to.exist;
        });

        afterEach(async () => {
            // Clean up any open editors between tests
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        });

        it('should have LSP manager available when environment is valid', async function () {
            this.timeout(15_000);

            // LSP manager should be available (single phase check)
            expect(lspManager).to.exist;
        });

        it('should create and display LSP output channel', async function () {
            this.timeout(10_000);

            // Get the LSP client which uses the output channel
            const client = lspManager?.getClient?.();
            expect(client).to.exist;

            // Verify LSP infrastructure is initialized
            // Output channel is created in lsp_manager.ts during start()
            expect(client?.outputChannel).to.exist;
            expect(client?.outputChannel?.name).to.include('Jac Language Server');
        });
    });

       /**
     * Test Group 2: LSP Features (Code Intelligence)
     *
     * Tests LSP-specific code intelligence features:
     * - Diagnostics detection
     * - Hover information
     */

     describe('Test Group 2: LSP Features (Code Intelligence)', () => {
        let testJacFile: string;

        before(async function () {
            this.timeout(40000);
            // Create a test JAC file with INVALID syntax for LSP to catch errors
            testJacFile = path.join(workspacePath, 'syntax.jac');

            const jacCode = `node Bus{
    has bus_type: str:
    has bus_id: str:
}`;
            await fs.writeFile(testJacFile, jacCode);

            // Give LSP extra time to fully initialize before diagnostics/hover tests
            // LSP needs time to analyze the workspace after environment is set
            await new Promise(resolve => setTimeout(resolve, 20000));
        });

         afterEach(async () => {
            // Close all editors between tests
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        });