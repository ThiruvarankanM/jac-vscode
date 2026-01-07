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