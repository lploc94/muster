import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ClaudeBackend } from './backends/claude';
import { makeBackend } from './backends/index';
import { RunOptions } from './types';
import * as fs from 'fs';
import * as path from 'path';

interface BackendSessionState {
  lastSessionId?: string;
  suppressFileResume?: boolean;
}

const backendSessions = new Map<string, BackendSessionState>();

function getBackendState(backend: string): BackendSessionState {
  let state = backendSessions.get(backend);
  if (!state) {
    state = {};
    backendSessions.set(backend, state);
  }
  return state;
}

class MusterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'muster.chat';

  private _view?: vscode.WebviewView;
  private _currentRun?: { runId: string; controller: AbortController };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data?.type) {
        case 'send':
          await this._handleSend(
            data.text,
            data.backend || 'claude',
            data.continueLast || false,
            webviewView.webview,
          );
          break;
        case 'cancelTurn':
          this._currentRun?.controller.abort();
          break;
        case 'newSession': {
          const run = this._currentRun;
          this._currentRun = undefined;
          run?.controller.abort();
          const backend = data.backend || 'claude';
          const state = getBackendState(backend);
          state.lastSessionId = undefined;
          state.suppressFileResume = true;
          this._clearSessionId(backend);
          webviewView.webview.postMessage({ type: 'sessionReset' });
          break;
        }
      }
    });
  }

  private async _handleSend(
    text: string,
    backendName: string,
    _continueLast: boolean,
    webview: vscode.Webview,
  ) {
    if (this._currentRun) {
      return;
    }

    const runId = randomUUID();
    const controller = new AbortController();
    this._currentRun = { runId, controller };

    const backend = makeBackend(backendName);
    const state = getBackendState(backend.name);
    const options: RunOptions = { prompt: text, signal: controller.signal };

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) {
      options.cwd = wsFolder.uri.fsPath;
    }

    if (state.lastSessionId) {
      options.resumeId = state.lastSessionId;
    } else if (!state.suppressFileResume) {
      const wsSession = this._loadSessionId(backend.name);
      if (wsSession) options.resumeId = wsSession;
    }
    state.suppressFileResume = false;

    let stagedSessionId: string | undefined;

    webview.postMessage({
      type: 'turnStart',
      runId,
      prompt: text,
      backend: backend.name,
      resume: !!options.resumeId,
    });

    try {
      for await (const event of backend.run(options)) {
        if (this._currentRun?.runId !== runId) break;

        webview.postMessage({ type: 'event', runId, event });

        if (event.type === 'sessionStarted' && event.sessionId) {
          stagedSessionId = event.sessionId;
        } else if (event.type === 'turnCompleted') {
          if (stagedSessionId && this._currentRun?.runId === runId) {
            state.lastSessionId = stagedSessionId;
            this._saveSessionId(backend.name, stagedSessionId);
          }
        }
      }
      if (this._currentRun?.runId === runId) {
        webview.postMessage({ type: 'turnDone', runId });
      }
    } catch (err: any) {
      webview.postMessage({ type: 'turnError', runId, message: err?.message ?? String(err) });
    } finally {
      if (this._currentRun?.runId === runId) this._currentRun = undefined;
    }
  }

  private _loadSessionId(backend: string): string | undefined {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return undefined;
    const file = path.join(wsFolder.uri.fsPath, '.muster-sessions.json');
    if (!fs.existsSync(file)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data[backend];
    } catch {
      return undefined;
    }
  }

  private _saveSessionId(backend: string, id: string | undefined) {
    if (!id) return;
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;
    const file = path.join(wsFolder.uri.fsPath, '.muster-sessions.json');
    let data: any = {};
    if (fs.existsSync(file)) {
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
    }
    data[backend] = id;
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {
      // Best-effort persistence — a read-only/failed FS must not abort the turn.
    }
  }

  private _clearSessionId(backend: string) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;
    const file = path.join(wsFolder.uri.fsPath, '.muster-sessions.json');
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete data[backend];
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {}
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const dist = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'index.css'));
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Muster</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new MusterChatProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MusterChatProvider.viewType, provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muster.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.muster');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muster.sendToClaude', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: 'Prompt for Claude' });
      if (!prompt) return;

      const panel = vscode.window.createWebviewPanel(
        'tleClaudeQuick',
        'Claude Quick',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
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

      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        opts.cwd = ws.uri.fsPath;
        const f = path.join(ws.uri.fsPath, '.muster-sessions.json');
        if (fs.existsSync(f)) {
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.claude) opts.resumeId = d.claude;
          } catch {}
        }
      }

      let stagedSessionId: string | undefined;
      for await (const ev of backend.run(opts)) {
        panel.webview.postMessage({ type: 'event', event: ev });
        if (ev.type === 'sessionStarted' && ev.sessionId) {
          stagedSessionId = ev.sessionId;
        } else if (ev.type === 'turnCompleted' && stagedSessionId && ws) {
          const f = path.join(ws.uri.fsPath, '.muster-sessions.json');
          let data: any = {};
          if (fs.existsSync(f)) {
            try {
              data = JSON.parse(fs.readFileSync(f, 'utf8'));
            } catch {}
          }
          data.claude = stagedSessionId;
          fs.writeFileSync(f, JSON.stringify(data, null, 2));
        }
      }
    }),
  );
}

export function deactivate() {}