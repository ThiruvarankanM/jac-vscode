/*
 * Jest tests for EnvManager class in a VSCode extension.
 */

import { EnvManager } from '../environment/manager';

import * as vscode from 'vscode';
import * as envDetection from '../utils/envDetection';
import { getLspManager } from '../extension';


// Inline mock for vscode-languageclient
jest.mock('vscode-languageclient/node', () => {
  return {
    LanguageClient: class {
      start = jest.fn();
      stop = jest.fn();
      dispose = jest.fn();
    },
    LanguageClientOptions: jest.fn(),
    ServerOptions: jest.fn(),
  };
});


// Mock the vscode module to simulate VSCode API behavior
jest.mock('vscode', () => {
  const statusBarItem = {
    show: jest.fn(),
    hide: jest.fn(),
    text: '',
    tooltip: '',
    command: undefined,
  };

  return {
    window: {
      createStatusBarItem: () => statusBarItem,
      showWarningMessage: jest.fn(),
      showInformationMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      showQuickPick: jest.fn(),
      showInputBox: jest.fn(),
      showOpenDialog: jest.fn(),
    },
    commands: {
      executeCommand: jest.fn(),
    },
    env: {
      openExternal: jest.fn(),
    },
    Uri: {
      parse: jest.fn((str: string) => ({ fsPath: str, toString: () => str })),
      file: jest.fn((str: string) => ({ fsPath: str, toString: () => str })),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    workspace: {
      workspaceFolders: [
        { uri: { fsPath: '/mock/workspace' } }
      ],
    },
  };
});

jest.mock('../utils/envDetection', () => ({
  findPythonEnvsWithJac: jest.fn(),
  validateJacExecutable: jest.fn(),
}));

// Mock the LspManager class
const mockLspManager = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  restart: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn().mockReturnValue(undefined),
};

// Mock the extension module
jest.mock('../extension', () => ({
  getLspManager: jest.fn(() => mockLspManager),
}));


describe('EnvManager (Jest)', () => {
  let context: any;
  let envManager: EnvManager;
  let onLspNeeded: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset LSP manager mock
    mockLspManager.start.mockClear();
    mockLspManager.stop.mockClear();
    mockLspManager.restart.mockClear();
    mockLspManager.getClient.mockClear();

    context = {
      globalState: {
        get: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [],
    };

    // Create callback once for all tests
    onLspNeeded = jest.fn().mockResolvedValue(undefined);
    envManager = new EnvManager(context, onLspNeeded);
  });

  /**
   * TEST 1: Default fallback behavior when no env is configured
   */
  test('should fallback to jac in PATH if no saved env', () => {
    // Call the method that should return the Jac executable path
    const path = envManager.getJacPath();

    // Verify it returns the appropriate platform-specific default
    expect(path).toBe(process.platform === 'win32' ? 'jac.exe' : 'jac');
  });

  /**
   * TEST 2: Status bar updates when environment is set
   */
  test('should update status bar when jacPath is set', () => {

    (envManager as any).jacPath = '/usr/local/bin/jac';

    envManager.updateStatusBar();
    expect((envManager as any).statusBar.text).toContain('$(check) Jac (Global)');
  });

  /**
   * TEST 3: Manual path entry - successful validation
   */
  test('should accept manual path if validate passes', async () => {
    (getLspManager as jest.Mock).mockReturnValue(undefined);

    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(true);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/fake/jac');

    // Execute the manual path entry workflow
    await (envManager as any).handleManualPathEntry();

    expect(envDetection.validateJacExecutable).toHaveBeenCalledWith('/fake/jac');
    expect(context.globalState.update).toHaveBeenCalledWith('jacEnvPath', '/fake/jac');
    // first message: set env
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Jac environment set to: /fake/jac'
    );
    expect(onLspNeeded).toHaveBeenCalledTimes(1);
  });

  /**
   * TEST 4: Manual path entry - validation failure and retry
   */
  test('should reject invalid manual path and retry', async () => {

    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(false);
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('/bad/jac') // first try
      .mockResolvedValueOnce(undefined); // user cancels on retry

    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Retry');

    await (envManager as any).handleManualPathEntry();

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
  });

  /**
   * TEST 5: Successful environment selection from auto-detected environments
   */
  test('should prompt environment selection when envs found', async () => {
    (getLspManager as jest.Mock).mockReturnValue(undefined);

    (envDetection.findPythonEnvsWithJac as jest.Mock).mockResolvedValue(['/path/to/jac']);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      env: '/path/to/jac',
      label: 'Jac (MyEnv)',
      description: '/path/to/jac',
    });

    // Execute the environment selection workflow
    await envManager.promptEnvironmentSelection();

    expect(context.globalState.update).toHaveBeenCalledWith('jacEnvPath', '/path/to/jac');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Selected Jac environment: Jac (MyEnv)',
      { detail: 'Path: /path/to/jac' }
    );

    expect(onLspNeeded).toHaveBeenCalledTimes(1);

  });

  /**
   * TEST 6: Warning when no environments found, QuickPick still shown
   */
  test('should show warning when no envs are found and still show QuickPick', async () => {

    (envDetection.findPythonEnvsWithJac as jest.Mock).mockResolvedValue([]);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined); // user cancels

    await envManager.promptEnvironmentSelection();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'No Jac environments found. You can install Jac, or select a Jac executable manually.',
      'Install Jac Now'
    );

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(context.globalState.update).not.toHaveBeenCalled();
  });

  /**
   * TEST 7: Initialization with saved environment path
   */
  test('should initialize with saved environment path', async () => {

    context.globalState.get.mockReturnValue('/saved/jac/path');
    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(true);

    await envManager.init();

    expect(envDetection.validateJacExecutable).toHaveBeenCalledWith('/saved/jac/path');
    expect((envManager as any).statusBar.text).toContain('Jac');
  });

  /**
   * TEST 8: User cancels environment selection dialog 
   */
  test('should handle user cancellation of environment selection', async () => {

    (envDetection.findPythonEnvsWithJac as jest.Mock).mockResolvedValue(['/path/to/jac']);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

    await envManager.promptEnvironmentSelection();

    expect(context.globalState.update).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  /**
   * TEST 9: QuickPick env selection, LSP exists -> restart (no callback)
   */
  test("restarts LSP when manager exists and does NOT call onLspNeeded", async () => {
    (envDetection.findPythonEnvsWithJac as jest.Mock).mockResolvedValue([
      "/path/to/jac",
    ]);

    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      env: "/path/to/jac",
      label: "Jac (SomeEnv)",
      description: "/path/to/jac",
    });

    (getLspManager as jest.Mock).mockReturnValue(mockLspManager);

    // Reset onLspNeeded for this test
    onLspNeeded.mockClear();

    await envManager.promptEnvironmentSelection();

    expect(mockLspManager.restart).toHaveBeenCalledTimes(1);
    expect(onLspNeeded).not.toHaveBeenCalled();
  });

  /**
   * TEST 10: Manual path success, LSP exists -> restart (no callback)
   */
  test("manual path success restarts LSP if manager exists (no onLspNeeded)", async () => {
    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(true);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue("/manual/jac");

    (getLspManager as jest.Mock).mockReturnValue(mockLspManager);

    onLspNeeded.mockClear();

    await (envManager as any).handleManualPathEntry();

    expect(context.globalState.update).toHaveBeenCalledWith("jacEnvPath", "/manual/jac");
    expect(mockLspManager.restart).toHaveBeenCalledTimes(1);
    expect(onLspNeeded).not.toHaveBeenCalled();
  });


  /**
   * TEST 11: File browser success, LSP missing -> call callback
   */
  test("file browser success calls onLspNeeded if LSP is missing", async () => {

    (getLspManager as jest.Mock).mockReturnValue(undefined);

    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(true);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([
      { fsPath: "/browser/jac" },
    ]);

    await (envManager as any).handleFileBrowser();

    expect(context.globalState.update).toHaveBeenCalledWith("jacEnvPath", "/browser/jac");
    expect(onLspNeeded).toHaveBeenCalledTimes(1);
  });

  /**
   * TEST 12: File browser success, LSP exists -> restart (no callback)
   */
  test("file browser success restarts LSP if manager exists (no onLspNeeded)", async () => {

    (getLspManager as jest.Mock).mockReturnValue(mockLspManager);

    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(true);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([
      { fsPath: "/browser/jac" },
    ]);

    onLspNeeded.mockClear();

    await (envManager as any).handleFileBrowser();

    expect(context.globalState.update).toHaveBeenCalledWith("jacEnvPath", "/browser/jac");
    expect(mockLspManager.restart).toHaveBeenCalledTimes(1);
    expect(onLspNeeded).not.toHaveBeenCalled();
  });


  /**
   * TEST 13: Invalid saved env during init -> clear state (no callback)
   */
  test("invalid saved env in init clears jacEnvPath and does NOT call onLspNeeded", async () => {
    context.globalState.get.mockReturnValue("/invalid/jac");
    (envDetection.validateJacExecutable as jest.Mock).mockResolvedValue(false);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    onLspNeeded.mockClear();

    await envManager.init();

    expect(context.globalState.update).toHaveBeenCalledWith("jacEnvPath", undefined);
    expect(onLspNeeded).not.toHaveBeenCalled();
  });

});