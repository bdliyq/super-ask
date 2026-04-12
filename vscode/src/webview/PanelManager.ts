import * as vscode from 'vscode';
import * as crypto from 'crypto';

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
export class PanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private pendingSessions = new Map<string, PendingSession>();
  private tabs = new Map<string, TabInfo>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

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

    this.ensurePanelVisible();
    this.syncWebview();
    this.focusTab(chatSessionId);

    return promise;
  }

  private ensurePanelVisible() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'superAskFeedback',
      'Super Ask',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
        ],
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panel.webview.html = this.getWebviewHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      for (const [, session] of this.pendingSessions) {
        session.reject(new Error('WebView panel was closed'));
      }
      this.pendingSessions.clear();
    }, undefined, this.disposables);
  }

  private handleWebviewMessage(msg: { type: string; invocationId?: string; feedback?: string; chatSessionId?: string; title?: string }) {
    if (msg.type === 'tabSwitched' && msg.title && this.panel) {
      this.panel.title = `Super Ask · ${msg.title}`;
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
    if (!this.panel) return;

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
          summary: h.summary,
          question: h.question,
          feedback: h.feedback,
          timestamp: h.timestamp,
          feedbackTimestamp: h.feedbackTimestamp,
        })),
        createdAt: tab.createdAt,
      };
    });

    this.panel.webview.postMessage({ type: 'update', tabs: tabsData });
  }

  private focusTab(chatSessionId: string) {
    if (!this.panel) return;
    const tab = this.tabs.get(chatSessionId);
    if (tab) {
      this.panel.title = `Super Ask · ${tab.title}`;
    }
    this.panel.webview.postMessage({ type: 'focusTab', chatSessionId });
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
<html lang="zh-CN">
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

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      height: 100vh;
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
      overflow: hidden;
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

    /* ── Report card ── */
    .summary-card {
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .summary-card h1, .summary-card h2, .summary-card h3 {
      margin-top: 0.5em; margin-bottom: 0.3em;
      color: var(--vscode-foreground);
    }
    .summary-card h1 { font-size: 1.3em; }
    .summary-card h2 { font-size: 1.15em; }
    .summary-card h3 { font-size: 1.05em; }
    .summary-card code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px; border-radius: 3px;
      font-family: var(--vscode-editor-font-family); font-size: 0.9em;
    }
    .summary-card pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px; border-radius: var(--radius);
      overflow-x: auto; margin: 0.5em 0;
    }
    .summary-card pre code { background: none; padding: 0; }
    .summary-card ul, .summary-card ol { padding-left: 1.5em; margin: 0.3em 0; }
    .summary-card p { margin: 0.4em 0; }

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
      white-space: pre-wrap; line-height: 1.5;
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
      width: 100%; min-height: 80px; max-height: 200px; resize: vertical;
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

    function renderMarkdown(text) {
      if (!text) return '';
      let html = text
        .replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
        .replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>')
        .replace(/^(?!<[hluop]|<li)(.+)$/gm, '<p>$1</p>');
      html = html.replace(/(<li>.*?<\\/li>\\n?)+/gs, function(m) { return '<ul>' + m + '</ul>'; });
      return html;
    }

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
        html += '<div class="summary-card">' + renderMarkdown(entry.summary) + '</div>';
        html += '<div class="question-card">';
        html += '<div class="question-label">Question</div>';
        html += '<div class="question-text">' + escapeHtml(entry.question) + '</div>';
        html += '</div>';

        if (entry.feedback !== null && !isPending) {
          html += '<div class="feedback-record">';
          html += '<div class="feedback-record-label">Your Feedback</div>';
          html += '<div class="feedback-record-text">' + escapeHtml(entry.feedback) + '</div>';
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
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.pendingSessions.clear();
    this.tabs.clear();
  }
}
