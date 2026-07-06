import * as vscode from 'vscode';
import { ClaudeBackend } from './backends/claude';
import { RunOptions } from './types';
import * as fs from 'fs';
import * as path from 'path';

let lastSessionId: string | undefined;

class MusterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'muster.chat';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'send':
          await this._handleSend(data.text, data.continueLast || false, webviewView.webview);
          break;
        case 'newSession':
          lastSessionId = undefined;
          webviewView.webview.postMessage({ type: 'sessionReset' });
          break;
      }
    });
  }

  private async _handleSend(text: string, continueLast: boolean, webview: vscode.Webview) {
    const backend = new ClaudeBackend();
    const options: RunOptions = {
      prompt: text,
    };

    if (continueLast && lastSessionId) {
      options.resumeId = lastSessionId;
    }

    // Try to load from workspace file if no in-memory
    if (!options.resumeId) {
      const wsSession = this._loadSessionId();
      if (wsSession) {
        options.resumeId = wsSession;
      }
    }

    webview.postMessage({ type: 'start', prompt: text, resume: !!options.resumeId });

    try {
      for await (const event of backend.run(options)) {
        webview.postMessage({ type: 'event', event });

        if (event.type === 'sessionStarted' && event.sessionId) {
          lastSessionId = event.sessionId;
          this._saveSessionId(event.sessionId);
        }

        // Try to extract from any event that has it (fallback)
        if (!lastSessionId && (event as any).session_id) {
          lastSessionId = (event as any).session_id;
          this._saveSessionId(lastSessionId);
        }
      }
    } catch (err: any) {
      webview.postMessage({ type: 'error', message: err.message || String(err) });
    }

    webview.postMessage({ type: 'done' });
  }

  private _loadSessionId(): string | undefined {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return undefined;
    const file = path.join(wsFolder.uri.fsPath, '.muster-sessions.json');
    if (!fs.existsSync(file)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data['claude'];
    } catch {
      return undefined;
    }
  }

  private _saveSessionId(id: string | undefined) {
    if (!id) return;
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;
    const file = path.join(wsFolder.uri.fsPath, '.muster-sessions.json');
    let data: any = {};
    if (fs.existsSync(file)) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    }
    data['claude'] = id;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muster</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; }
    #output { white-space: pre-wrap; border: 1px solid #444; padding: 8px; min-height: 200px; margin-bottom: 10px; background: var(--vscode-editor-background); }
    .thinking { color: #888; font-style: italic; }
    .tool { background: #2a2a2a; padding: 4px; margin: 4px 0; }
    input, button { padding: 6px; margin: 4px 0; }
    #input { width: 70%; }
  </style>
</head>
<body>
  <div>
    <input id="input" placeholder="Enter prompt... (Enter to send)" />
    <button id="send">Send</button>
    <button id="continue">Continue Last</button>
    <button id="new">New Session</button>
  </div>
  <div id="output"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const output = document.getElementById('output');
    const input = document.getElementById('input');

    function addLine(text, cls = '') {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = text;
      output.appendChild(div);
      output.scrollTop = output.scrollHeight;
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'start') {
        output.innerHTML = '';
        addLine('> ' + msg.prompt, 'user');
        if (msg.resume) addLine('[continuing session]', 'thinking');
      } else if (msg.type === 'event') {
        const e = msg.event;
        if (e.type === 'assistantDelta') {
          const last = output.lastChild;
          if (last && last.className === 'assistant') {
            last.textContent += e.content;
          } else {
            const d = document.createElement('div');
            d.className = 'assistant';
            d.textContent = e.content;
            output.appendChild(d);
          }
        } else if (e.type === 'reasoningDelta') {
          addLine('Thinking: ' + e.content, 'thinking');
        } else if (e.type === 'toolStarted') {
          addLine('Tool: ' + e.name, 'tool');
        } else if (e.type === 'toolCompleted') {
          addLine('Tool done: ' + (e.output ? e.output.substring(0,100) : ''), 'tool');
        } else if (e.type === 'error') {
          addLine('Error: ' + e.message, 'error');
        }
        output.scrollTop = output.scrollHeight;
      } else if (msg.type === 'done') {
        addLine('[done]', 'thinking');
      } else if (msg.type === 'error') {
        addLine('Error: ' + msg.message);
      } else if (msg.type === 'sessionReset') {
        output.innerHTML = '<div>New session started.</div>';
      }
    });

    document.getElementById('send').addEventListener('click', () => {
      const text = input.value.trim();
      if (text) {
        vscode.postMessage({ type: 'send', text, continueLast: false });
        input.value = '';
      }
    });

    document.getElementById('continue').addEventListener('click', () => {
      const text = input.value.trim() || 'continue';
      vscode.postMessage({ type: 'send', text, continueLast: true });
      input.value = '';
    });

    document.getElementById('new').addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('send').click();
      }
    });

    input.focus();
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new MusterChatProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MusterChatProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muster.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.muster');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muster.sendToClaude', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: 'Prompt for Claude' });
      if (!prompt) return;

      const panel = vscode.window.createWebviewPanel(
        'tleClaudeQuick',
        'Claude Quick',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      panel.webview.html = `<html><body>
        <pre id="out" style="white-space:pre-wrap; font-family: monospace;"></pre>
        <script>
          const vscode = acquireVsCodeApi();
          window.addEventListener('message', e => {
            const msg = e.data;
            const out = document.getElementById('out');
            if (msg.type === 'event') {
              const ev = msg.event;
              if (ev.type === 'assistantDelta') {
                out.textContent += ev.content;
              } else if (ev.type === 'error') {
                out.textContent += '\\n[ERROR] ' + ev.message;
              } else if (ev.type === 'turnCompleted') {
                out.textContent += '\\n[done]';
              }
            }
          });
        </script>
      </body></html>`;

      const backend = new ClaudeBackend();
      const opts: RunOptions = { prompt };

      // load last session ID if possible
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        const f = path.join(ws.uri.fsPath, '.muster-sessions.json');
        if (fs.existsSync(f)) {
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.claude) opts.resumeId = d.claude;
          } catch {}
        }
      }

      for await (const ev of backend.run(opts)) {
        panel.webview.postMessage({ type: 'event', event: ev });
        if (ev.type === 'sessionStarted' && ev.sessionId) {
          if (ws) {
            const f = path.join(ws.uri.fsPath, '.muster-sessions.json');
            let data: any = {};
            if (fs.existsSync(f)) { try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
            data.claude = ev.sessionId;
            fs.writeFileSync(f, JSON.stringify(data, null, 2));
          }
        }
      }
    })
  );
}

export function deactivate() {}
