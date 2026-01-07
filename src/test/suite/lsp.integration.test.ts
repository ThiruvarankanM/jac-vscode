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
