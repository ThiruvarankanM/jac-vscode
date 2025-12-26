import * as vscode from 'vscode';
import { EnvManager } from './environment/manager';
import { registerAllCommands } from './commands';
import { setupVisualDebuggerWebview } from './webview/visualDebugger';
import { LspManager } from './lsp/lsp_manager';

let lspManager: LspManager | undefined;

export function getLspManager(): LspManager | undefined {
    return lspManager;
}

// Create and start LSP Manager if not already running
export async function createAndStartLsp(envManager: EnvManager, context: vscode.ExtensionContext): Promise<void> {
    if (!lspManager) {
        try {
            lspManager = new LspManager(envManager);
            await lspManager.start();
            context.subscriptions.push({
                dispose: () => lspManager?.stop()
            });
        } catch (error) {
            lspManager = undefined;
            throw error;
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        const envManager = new EnvManager(context);
        registerAllCommands(context, envManager);
        await envManager.init();

        setupVisualDebuggerWebview(context);

        // Only start LSP if valid environment exists
        if (envManager.getJacPath() !== 'jac' && envManager.getJacPath() !== 'jac.exe') {
            try {
                await createAndStartLsp(envManager, context);
            } catch (error) {
                console.error('LSP failed to start during activation:', error);
                vscode.window.showWarningMessage(
                    'Jac Language Server failed to start. Select Environment to retry.'
                );
            }
        } else {
            console.log('No Jac environment detected at startup. LSP will start when you select an environment.');
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to activate Jac extension: ${error}`);
        console.error('Extension activation error:', error);
    }
}

export function deactivate(): Thenable<void> | undefined {
    return lspManager?.stop();
}
