import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import diff from 'highlight.js/lib/languages/diff';
import shell from 'highlight.js/lib/languages/shell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('zsh', bash);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('docker', dockerfile);

export interface FeedbackRequest {
  invocationId: string;
  chatSessionId: string;
  title?: string;
  summary: string;
  question: string;
}

interface PendingSession {
  invocationId: string;
  chatSessionId: string;
  resolve: (feedback: string) => void;
  reject: (err: Error) => void;
}

interface HistoryEntry {
  invocationId: string;
  summary: string;
  question: string;
  feedback: string | null;
  timestamp: number;
  feedbackTimestamp: number | null;
}

interface TabInfo {
  chatSessionId: string;
  title: string;
  history: HistoryEntry[];
  createdAt: number;
}

/**
 * Manages WebView panel lifecycle, pending sessions and tab routing.
 *
 * Tabs persist after feedback submission. Each tab maintains full interaction history.
 *
 * Routing:
 * - invocationId (unique per invoke) -> precise Promise resolution
 * - chatSessionId (shared within a chat) -> tab grouping for the same task
 */
export class PanelManager implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pendingSessions = new Map<string, PendingSession>();
  private tabs = new Map<string, TabInfo>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {
    marked.use(
      markedHighlight({
        highlight(code: string, lang: string) {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return hljs.highlightAuto(code).value;
        },
      }),
    );

    const renderer = new marked.Renderer();
    const originalLinkRenderer = renderer.link.bind(renderer);
    renderer.link = function (token) {
      const html = originalLinkRenderer(token);
      return html.replace('<a ', '<a target="_blank" rel="noopener" ');
    };
    marked.setOptions({
      gfm: true,
      breaks: true,
      renderer,
    });
  }

  private renderMarkdownToHtml(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      undefined,
      this.disposables
    );

    webviewView.onDidDispose(() => {
      this.view = undefined;
    }, undefined, this.disposables);
  }

  async requestFeedback(
    req: Omit<FeedbackRequest, 'invocationId'> & { invocationId?: string },
    token: vscode.CancellationToken
  ): Promise<string> {
    const invocationId = req.invocationId || crypto.randomUUID();
    const chatSessionId = req.chatSessionId || crypto.randomUUID();

    const historyEntry: HistoryEntry = {
      invocationId,
      summary: req.summary,
      question: req.question,
      feedback: null,
      timestamp: Date.now(),
      feedbackTimestamp: null,
    };

    if (this.tabs.has(chatSessionId)) {
      const tab = this.tabs.get(chatSessionId)!;
      tab.history.push(historyEntry);
      if (req.title) {
        tab.title = req.title;
      }
    } else {
      this.tabs.set(chatSessionId, {
        chatSessionId,
        title: req.title || this.extractTitle(req.summary),
        history: [historyEntry],
        createdAt: Date.now(),
      });
    }

    const promise = new Promise<string>((resolve, reject) => {
      this.pendingSessions.set(invocationId, {
        invocationId,
        chatSessionId,
        resolve,
        reject,
      });

      const cancellationListener = token.onCancellationRequested(() => {
        this.pendingSessions.delete(invocationId);
        historyEntry.feedback = '[Cancelled]';
        this.syncWebview();
        reject(new Error('Cancelled by user'));
      });
      this.disposables.push(cancellationListener);
    });

    this.revealView();
    this.syncWebview();
    this.focusTab(chatSessionId);

    return promise;
  }

  private revealView() {
    if (this.view) {
      this.view.show(true);
    } else {
      vscode.commands.executeCommand('superAsk.feedbackView.focus');
    }
  }

  private handleWebviewMessage(msg: { type: string; invocationId?: string; feedback?: string; chatSessionId?: string; title?: string }) {
    if (msg.type === 'tabSwitched' && msg.title) {
      if (this.view) {
        this.view.title = msg.title;
      }
    } else if (msg.type === 'submit' && msg.invocationId && msg.feedback !== undefined) {
      const session = this.pendingSessions.get(msg.invocationId);
      if (session) {
        const tab = this.tabs.get(session.chatSessionId);
        if (tab) {
          const entry = tab.history.find((h) => h.invocationId === msg.invocationId);
          if (entry) {
            entry.feedback = msg.feedback;
            entry.feedbackTimestamp = Date.now();
          }
        }

        session.resolve(msg.feedback);
        this.pendingSessions.delete(msg.invocationId);
        this.syncWebview();
      }
    } else if (msg.type === 'ready') {
      this.syncWebview();
    }
  }

  /**
   * Syncs full tab data (including history) to the WebView.
   * Tabs are always preserved regardless of pending state changes.
   */
  private syncWebview() {
    if (!this.view) return;

    const tabsData = Array.from(this.tabs.values()).map((tab) => {
      const lastEntry = tab.history[tab.history.length - 1];
      const hasPending = lastEntry && lastEntry.feedback === null
        && this.pendingSessions.has(lastEntry.invocationId);

      return {
        chatSessionId: tab.chatSessionId,
        title: tab.title,
        hasPending,
        pendingInvocationId: hasPending ? lastEntry.invocationId : null,
        history: tab.history.map((h) => ({
          invocationId: h.invocationId,
          summaryHtml: this.renderMarkdownToHtml(h.summary),
          questionHtml: this.renderMarkdownToHtml(h.question),
          feedback: h.feedback,
          feedbackHtml: h.feedback ? this.renderMarkdownToHtml(h.feedback) : null,
          timestamp: h.timestamp,
          feedbackTimestamp: h.feedbackTimestamp,
        })),
        createdAt: tab.createdAt,
      };
    });

    this.view.webview.postMessage({ type: 'update', tabs: tabsData });
  }

  private focusTab(chatSessionId: string) {
    if (!this.view) return;
    const tab = this.tabs.get(chatSessionId);
    if (tab) {
      this.view.title = tab.title;
    }
    this.view.webview.postMessage({ type: 'focusTab', chatSessionId });
  }

  private extractTitle(summary: string): string {
    const firstLine = summary.split('\n')[0]
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    return firstLine.length > 30 ? firstLine.substring(0, 30) + '...' : firstLine;
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomUUID().replace(/-/g, '');

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Super Ask</title>
  <style>
    :root {
      --radius: 6px;
      --gap: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Tab bar ── */
    .tab-bar {
      display: flex;
      gap: 2px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-widget-border));
      padding: 0 8px;
      min-height: 36px;
      align-items: stretch;
      overflow-x: auto;
      flex-shrink: 0;
    }
    .tab-bar::-webkit-scrollbar { height: 3px; }

    .tab-item {
      display: flex;
      align-items: center;
      padding: 0 12px;
      cursor: pointer;
      white-space: nowrap;
      font-size: 12px;
      border-bottom: 2px solid transparent;
      color: var(--vscode-tab-inactiveForeground);
      background: transparent;
      transition: color 0.15s, border-color 0.15s;
      gap: 6px;
    }
    .tab-item:hover { color: var(--vscode-tab-activeForeground); }
    .tab-item.active {
      color: var(--vscode-tab-activeForeground);
      border-bottom-color: var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder));
    }
    .tab-badge {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
      flex-shrink: 0;
    }

    /* ── Main content area ── */
    .content-area {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--gap);
    }
    .content-inner {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
      padding-bottom: 8px;
    }
    .empty-state {
      height: 100%;
      display: flex; align-items: center; justify-content: center;
      color: var(--vscode-descriptionForeground); font-style: italic;
    }

    /* ── History entry ── */
    .history-entry {
      border: 1px solid var(--vscode-widget-border);
      border-radius: var(--radius);
      flex-shrink: 0;
    }
    .history-entry.completed { opacity: 0.75; }
    .history-entry.pending { border-color: var(--vscode-focusBorder); }

    .entry-header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px var(--gap);
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-widget-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .entry-status {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .entry-status.pending { background: var(--vscode-notificationsInfoIcon-foreground, #3794ff); }
    .entry-status.done { background: var(--vscode-testing-iconPassed, #73c991); }
    .entry-status.cancelled { background: var(--vscode-testing-iconFailed, #f14c4c); }

    .entry-body { padding: var(--gap); }

    /* ── Markdown content (shared by summary-card and question-text) ── */
    .markdown-body {
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      margin-top: 0.8em; margin-bottom: 0.4em;
      color: var(--vscode-foreground);
    }
    .markdown-body h1 { font-size: 1.3em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 0.3em; }
    .markdown-body h2 { font-size: 1.15em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 0.2em; }
    .markdown-body h3 { font-size: 1.05em; }
    .markdown-body h4 { font-size: 1em; }
    .markdown-body code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px; border-radius: 3px;
      font-family: var(--vscode-editor-font-family); font-size: 0.9em;
    }
    .markdown-body pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px; border-radius: var(--radius);
      overflow-x: auto; margin: 0.5em 0;
    }
    .markdown-body pre code { background: none; padding: 0; display: block; white-space: pre; }
    .markdown-body ul, .markdown-body ol { padding-left: 1.5em; margin: 0.3em 0; }
    .markdown-body li { margin: 0.15em 0; }
    .markdown-body li > ul, .markdown-body li > ol { margin: 0.1em 0; }
    .markdown-body p { margin: 0.4em 0; }
    .markdown-body a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
      padding: 4px 12px;
      margin: 0.5em 0;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background, transparent);
    }
    .markdown-body blockquote p { margin: 0.2em 0; }
    .markdown-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.5em 0;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--vscode-widget-border);
      padding: 4px 8px;
      text-align: left;
    }
    .markdown-body th {
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      font-weight: 600;
    }
    .markdown-body hr {
      border: none;
      border-top: 1px solid var(--vscode-widget-border);
      margin: 0.8em 0;
    }
    .markdown-body img { max-width: 100%; }
    .markdown-body strong { font-weight: 600; }
    .markdown-body > *:first-child { margin-top: 0; }
    .markdown-body > *:last-child { margin-bottom: 0; }

    /* ── Task list (GFM checkboxes) ── */
    .markdown-body ul.contains-task-list,
    .markdown-body .task-list-item { list-style: none; }
    .markdown-body ul.contains-task-list { padding-left: 0.5em; }
    .markdown-body .task-list-item input[type="checkbox"] {
      margin-right: 6px;
      vertical-align: middle;
      pointer-events: none;
    }

    /* ── Code syntax highlighting (VSCode theme-aware) ── */
    .hljs { color: var(--vscode-editor-foreground); }
    body.vscode-dark .hljs-comment, body.vscode-dark .hljs-quote { color: #6a9955; font-style: italic; }
    body.vscode-dark .hljs-keyword, body.vscode-dark .hljs-selector-tag, body.vscode-dark .hljs-literal { color: #569cd6; }
    body.vscode-dark .hljs-string, body.vscode-dark .hljs-addition { color: #ce9178; }
    body.vscode-dark .hljs-number { color: #b5cea8; }
    body.vscode-dark .hljs-built_in { color: #4ec9b0; }
    body.vscode-dark .hljs-type, body.vscode-dark .hljs-class .hljs-title { color: #4ec9b0; }
    body.vscode-dark .hljs-title.function_, body.vscode-dark .hljs-function .hljs-title { color: #dcdcaa; }
    body.vscode-dark .hljs-variable, body.vscode-dark .hljs-attr { color: #9cdcfe; }
    body.vscode-dark .hljs-meta, body.vscode-dark .hljs-meta .hljs-keyword { color: #c586c0; }
    body.vscode-dark .hljs-deletion { color: #ce9178; text-decoration: line-through; }
    body.vscode-dark .hljs-regexp { color: #d16969; }
    body.vscode-dark .hljs-symbol { color: #b5cea8; }
    body.vscode-dark .hljs-tag { color: #569cd6; }
    body.vscode-dark .hljs-name { color: #4ec9b0; }
    body.vscode-dark .hljs-selector-class, body.vscode-dark .hljs-selector-id { color: #d7ba7d; }

    body.vscode-light .hljs-comment, body.vscode-light .hljs-quote { color: #008000; font-style: italic; }
    body.vscode-light .hljs-keyword, body.vscode-light .hljs-selector-tag, body.vscode-light .hljs-literal { color: #0000ff; }
    body.vscode-light .hljs-string, body.vscode-light .hljs-addition { color: #a31515; }
    body.vscode-light .hljs-number { color: #098658; }
    body.vscode-light .hljs-built_in { color: #267f99; }
    body.vscode-light .hljs-type, body.vscode-light .hljs-class .hljs-title { color: #267f99; }
    body.vscode-light .hljs-title.function_, body.vscode-light .hljs-function .hljs-title { color: #795e26; }
    body.vscode-light .hljs-variable, body.vscode-light .hljs-attr { color: #001080; }
    body.vscode-light .hljs-meta, body.vscode-light .hljs-meta .hljs-keyword { color: #af00db; }
    body.vscode-light .hljs-deletion { color: #a31515; text-decoration: line-through; }
    body.vscode-light .hljs-regexp { color: #811f3f; }
    body.vscode-light .hljs-symbol { color: #098658; }
    body.vscode-light .hljs-tag { color: #800000; }
    body.vscode-light .hljs-name { color: #267f99; }
    body.vscode-light .hljs-selector-class, body.vscode-light .hljs-selector-id { color: #800000; }

    /* ── Question ── */
    .question-card {
      background: var(--vscode-inputValidation-infoBackground, rgba(55,148,255,0.1));
      border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder));
      border-radius: var(--radius);
      padding: 8px var(--gap);
      margin-top: 8px;
    }
    .question-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground); margin-bottom: 4px;
    }
    .question-text { line-height: 1.5; word-wrap: break-word; overflow-wrap: break-word; }

    /* ── Submitted feedback (history) ── */
    .feedback-record {
      background: var(--vscode-diffEditor-insertedTextBackground, rgba(115,201,145,0.1));
      border: 1px solid var(--vscode-diffEditor-insertedLineBackground, rgba(115,201,145,0.3));
      border-radius: var(--radius);
      padding: 8px var(--gap);
      margin-top: 8px;
    }
    .feedback-record-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground); margin-bottom: 4px;
    }
    .feedback-record-text {
      line-height: 1.5;
      word-wrap: break-word; overflow-wrap: break-word;
    }

    /* ── Separator ── */
    .entry-divider {
      border: none;
      border-top: 1px dashed var(--vscode-widget-border);
      margin: 4px 0;
    }

    /* ── Bottom feedback area ── */
    .feedback-area {
      flex-shrink: 0;
      border-top: 1px solid var(--vscode-widget-border);
      padding: var(--gap);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      display: flex; flex-direction: column; gap: 8px;
    }
    .quick-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .quick-btn {
      padding: 4px 10px; font-size: 12px;
      border-radius: var(--radius);
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-widget-border));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer; transition: background 0.15s;
    }
    .quick-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .feedback-input {
      width: 100%; min-height: 60px; max-height: 150px; resize: vertical;
      padding: 8px;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: var(--radius); outline: none;
    }
    .feedback-input:focus { border-color: var(--vscode-focusBorder); }
    .feedback-input::placeholder { color: var(--vscode-input-placeholderForeground); }

    .submit-row { display: flex; justify-content: flex-end; }
    .submit-btn {
      padding: 6px 16px; font-size: 13px; border-radius: var(--radius); border: none;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      cursor: pointer; font-weight: 500; transition: background 0.15s;
    }
    .submit-btn:hover { background: var(--vscode-button-hoverBackground); }
    .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="tab-bar" id="tabBar"></div>
  <div class="content-area" id="contentArea">
    <div class="empty-state">Waiting for AI to call Super Ask...</div>
  </div>
  <div class="feedback-area" id="feedbackArea" style="display: none;">
    <div class="quick-actions" id="quickActions">
      <button class="quick-btn" data-text="Confirmed, continue">✓ Confirm & Continue</button>
      <button class="quick-btn" data-text="Confirmed, please commit">✓ Confirm & Commit</button>
      <button class="quick-btn" data-text="Needs changes:\\n">✎ Needs Changes</button>
    </div>
    <textarea class="feedback-input" id="feedbackInput" placeholder="Enter your feedback... (Ctrl+Enter to submit)"></textarea>
    <div class="submit-row">
      <button class="submit-btn" id="submitBtn" disabled>Submit</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let tabs = [];
    let activeTabId = null;

    const tabBar = document.getElementById('tabBar');
    const contentArea = document.getElementById('contentArea');
    const feedbackArea = document.getElementById('feedbackArea');
    const feedbackInput = document.getElementById('feedbackInput');
    const submitBtn = document.getElementById('submitBtn');

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function formatTime(ts) {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
    }

    function renderTabs() {
      tabBar.innerHTML = '';
      tabs.forEach(function(tab) {
        const el = document.createElement('div');
        el.className = 'tab-item' + (tab.chatSessionId === activeTabId ? ' active' : '');
        el.innerHTML =
          (tab.hasPending ? '<span class="tab-badge"></span>' : '') +
          '<span>' + escapeHtml(tab.title || 'Untitled Task') + '</span>';
        el.onclick = function() { switchTab(tab.chatSessionId); };
        tabBar.appendChild(el);
      });
    }

    function renderContent() {
      const tab = tabs.find(function(t) { return t.chatSessionId === activeTabId; });
      if (!tab || !tab.history || tab.history.length === 0) {
        contentArea.innerHTML = '<div class="empty-state">Waiting for AI to call Super Ask...</div>';
        feedbackArea.style.display = 'none';
        submitBtn.dataset.invocationId = '';
        return;
      }

      let html = '<div class="content-inner">';
      tab.history.forEach(function(entry, idx) {
        const isPending = entry.feedback === null;
        const isCancelled = entry.feedback === '[Cancelled]';
        const statusClass = isPending ? 'pending' : (isCancelled ? 'cancelled' : 'done');
        const statusLabel = isPending ? 'Awaiting' : (isCancelled ? 'Cancelled' : 'Replied');
        const entryClass = isPending ? 'pending' : 'completed';

        html += '<div class="history-entry ' + entryClass + '">';
        var feedbackTimeStr = entry.feedbackTimestamp ? ' → replied ' + formatTime(entry.feedbackTimestamp) : '';
        html += '<div class="entry-header">';
        html += '<span class="entry-status ' + statusClass + '"></span>';
        html += '<span>#' + (idx + 1) + ' · asked ' + formatTime(entry.timestamp) + feedbackTimeStr + ' · ' + statusLabel + '</span>';
        html += '</div>';
        html += '<div class="entry-body">';
        html += '<div class="summary-card markdown-body">' + (entry.summaryHtml || '') + '</div>';
        html += '<div class="question-card">';
        html += '<div class="question-label">Question</div>';
        html += '<div class="question-text markdown-body">' + (entry.questionHtml || '') + '</div>';
        html += '</div>';

        if (entry.feedback !== null && !isPending) {
          html += '<div class="feedback-record">';
          html += '<div class="feedback-record-label">Your Feedback</div>';
          html += '<div class="feedback-record-text markdown-body">' + (entry.feedbackHtml || escapeHtml(entry.feedback)) + '</div>';
          html += '</div>';
        }

        html += '</div></div>';
      });
      html += '</div>';

      contentArea.innerHTML = html;

      if (tab.hasPending && tab.pendingInvocationId) {
        feedbackArea.style.display = 'flex';
        submitBtn.dataset.invocationId = tab.pendingInvocationId;
        feedbackInput.value = '';
      } else {
        feedbackArea.style.display = 'none';
        submitBtn.dataset.invocationId = '';
      }
      updateSubmitState();

      requestAnimationFrame(function() {
        contentArea.scrollTop = contentArea.scrollHeight;
        if (tab.hasPending && tab.pendingInvocationId) {
          feedbackInput.focus();
        }
      });
    }

    function switchTab(chatSessionId) {
      activeTabId = chatSessionId;
      var tab = tabs.find(function(t) { return t.chatSessionId === chatSessionId; });
      if (tab) {
        vscode.postMessage({ type: 'tabSwitched', chatSessionId: chatSessionId, title: tab.title });
      }
      renderTabs();
      renderContent();
    }

    function updateSubmitState() {
      submitBtn.disabled = !feedbackInput.value.trim() || !submitBtn.dataset.invocationId;
    }

    document.getElementById('quickActions').addEventListener('click', function(e) {
      var btn = e.target.closest('.quick-btn');
      if (!btn) return;
      var text = btn.dataset.text;
      if (text.endsWith('\\n')) {
        feedbackInput.value = text;
        feedbackInput.focus();
        feedbackInput.setSelectionRange(text.length, text.length);
      } else {
        feedbackInput.value = text;
        submitFeedback();
      }
      updateSubmitState();
    });

    feedbackInput.addEventListener('input', updateSubmitState);
    feedbackInput.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitFeedback();
      }
    });
    submitBtn.addEventListener('click', submitFeedback);

    function submitFeedback() {
      var feedback = feedbackInput.value.trim();
      var invocationId = submitBtn.dataset.invocationId;
      if (!feedback || !invocationId) return;
      vscode.postMessage({ type: 'submit', invocationId: invocationId, feedback: feedback });
      feedbackInput.value = '';
      updateSubmitState();
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'update') {
        tabs = msg.tabs || [];
        if (!tabs.find(function(t) { return t.chatSessionId === activeTabId; }) && tabs.length > 0) {
          activeTabId = tabs[0].chatSessionId;
        }
        if (tabs.length === 0) activeTabId = null;
        renderTabs();
        renderContent();
      } else if (msg.type === 'focusTab') {
        switchTab(msg.chatSessionId);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.pendingSessions.clear();
    this.tabs.clear();
  }
}
