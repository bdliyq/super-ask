import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { PanelManager } from '../webview/PanelManager';
import { outputChannel } from '../extension';

export interface ISuperAskInput {
  title?: string;
  chatSessionId?: string;
  summary: string;
  question: string;
}

/**
 * super-ask Language Model Tool
 *
 * Tool for AI to report progress and await user feedback.
 * Dual-ID routing (invocationId + chatSessionId) ensures correct message delivery across sessions.
 */
export class SuperAskTool implements vscode.LanguageModelTool<ISuperAskInput> {
  constructor(private readonly panelManager: PanelManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ISuperAskInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { title, summary, question, chatSessionId: inputSessionId } = options.input;

    const invocationId = crypto.randomUUID();
    const chatSessionId = inputSessionId || crypto.randomUUID();

    outputChannel.appendLine(`[invoke] input.chatSessionId="${inputSessionId ?? '(undefined)'}" → resolved="${chatSessionId}"`);
    outputChannel.appendLine(`[invoke] input.title="${title ?? '(undefined)'}"`);
    outputChannel.appendLine(`[invoke] invocationId="${invocationId}"`);
    outputChannel.appendLine(`[invoke] input keys: ${JSON.stringify(Object.keys(options.input))}`);
    outputChannel.appendLine(`[invoke] raw input: ${JSON.stringify(options.input)}`);

    const feedback = await this.panelManager.requestFeedback(
      { invocationId, chatSessionId, title, summary, question },
      token
    );

    const resultText = [
      `[chatSessionId=${chatSessionId}]`,
      '',
      'User feedback:',
      feedback,
      '',
      '使用`#superAsk`回复我',
    ].join('\n');

    outputChannel.appendLine(`[invoke] returning chatSessionId="${chatSessionId}" in result`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(resultText),
    ]);
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ISuperAskInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const question = options.input.question || 'AI is requesting your feedback';
    return {
      invocationMessage: `Awaiting user feedback: ${question}`,
    };
  }
}
