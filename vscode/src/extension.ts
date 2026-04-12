import * as vscode from 'vscode';
import { PanelManager } from './webview/PanelManager';
import { SuperAskTool } from './tools/superAskTool';

let panelManager: PanelManager;
export let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Super Ask');
  context.subscriptions.push(outputChannel);

  panelManager = new PanelManager(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'superAsk.feedbackView',
      panelManager,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const tool = new SuperAskTool(panelManager);
  context.subscriptions.push(
    vscode.lm.registerTool('super-ask_feedback', tool)
  );

  context.subscriptions.push({ dispose: () => panelManager.dispose() });
}

export function deactivate() {
  panelManager?.dispose();
}
