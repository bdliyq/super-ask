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

  // 通道 1: LM Tool（Copilot 专属，Cursor 中安全跳过）
  try {
    if (typeof vscode.lm?.registerTool === 'function') {
      const tool = new SuperAskTool(panelManager);
      context.subscriptions.push(
        vscode.lm.registerTool('super-ask_feedback', tool)
      );
      outputChannel.appendLine('[LM Tool] Registered super-ask_feedback');
    } else {
      outputChannel.appendLine('[LM Tool] vscode.lm not available');
    }
  } catch (err) {
    outputChannel.appendLine('[LM Tool] Registration failed: ' + err);
  }

  // TODO: 通道 2: HTTP Server（通用，服务 Cursor/Codex/Cline 等）
  // 实现见 agent.md 第 10 节设计方案

  context.subscriptions.push({ dispose: () => panelManager.dispose() });
}

export function deactivate() {
  panelManager?.dispose();
}
