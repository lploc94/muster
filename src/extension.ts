import * as vscode from 'vscode';
import { AskBridge } from './bridge/ask-bridge';
import type { Question } from './bridge/ask-bridge';
import { CredentialRegistry } from './bridge/credentials';
import { MusterBridgeServer } from './bridge/server';
import { makeBackend } from './backends/index';
import { disposeSharedAcpClient } from './backends/acp-client';
import {
  buildSnapshot,
  projectTaskSummary,
  type PendingAskOverlay,
  type TaskSnapshot,
  type TranscriptItem,
} from './host/snapshot';
import { SESSION_MIGRATION_MARKER, migrateLegacySessions } from './task/migration-sessions';
import { applyRetention, retentionChanged, type RetentionConfig } from './task/retention';
import { TaskEngine, type EngineEvent } from './task/engine';
import { TaskStore } from './task/store';
import { isTerminalLifecycle } from './task/transitions';
import type { TaskStoreFile } from './task/types';
import * as fs from 'fs';
import * as path from 'path';

let askBridge: AskBridge | undefined;
let credentialRegistry: CredentialRegistry | undefined;
let bridgeServer: MusterBridgeServer | undefined;
let taskEngine: TaskEngine | undefined;
let taskStore: TaskStore | undefined;
let storePath: string | undefined;
let workspaceRoot: string | undefined;
let lastObservedRevision = 0;
let lastObservedFile: TaskStoreFile | undefined;
const activePendingAsks = new Map<string, PendingAskOverlay>();

function getRetentionConfig(): RetentionConfig {
  const config = vscode.workspace.getConfiguration('muster.retention');
  return {
    maxTurnsPerTask: config.get<number>('maxTurnsPerTask', 200),
    maxStoredOutputChars: config.get<number>('maxStoredOutputChars', 200_000),
  };
}

function runSessionMigration(context: vscode.ExtensionContext, wsRoot?: string): void {
  if (!wsRoot) {
    return;
  }
  const result = migrateLegacySessions(wsRoot);
  if (result.action !== 'none') {
    void context.workspaceState.update(SESSION_MIGRATION_MARKER, true);
    if (result.message) {
      void vscode.window.showInformationMessage(result.message);
    }
  }
}

function applyRetentionToStore(store: TaskStore): void {
  const config = getRetentionConfig();
  const before = store.getFile();
  const pruned = applyRetention(before, config);
  if (!retentionChanged(before, pruned)) {
    return;
  }
  store.commit((draft) => {
    draft.tasks = pruned.tasks;
    draft.turns = pruned.turns;
    draft.messages = pruned.messages;
    draft.operations = pruned.operations;
    draft.cancelRequests = pruned.cancelRequests;
    return { ok: true };
  });
}

class MusterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'muster.chat';

  private _view?: vscode.WebviewView;
  focusedTaskId?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  private post(message: unknown): void {
    try {
      this._view?.webview.postMessage(message);
    } catch {
      // best-effort
    }
  }

  private postCommandError(message: string, taskId?: string): void {
    this.post({ type: 'commandError', taskId, message });
  }

  forwardTurnEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'turnStart':
        this.post({
          type: 'turnStart',
          taskId: event.taskId,
          turnId: event.turnId,
          trigger: event.trigger,
        });
        break;
      case 'event':
        this.post({
          type: 'event',
          taskId: event.taskId,
          turnId: event.turnId,
          event: event.event,
        });
        break;
      case 'turnDone':
        this.post({ type: 'turnDone', taskId: event.taskId, turnId: event.turnId });
        break;
      case 'turnError':
        this.post({
          type: 'turnError',
          taskId: event.taskId,
          turnId: event.turnId,
          message: event.message,
        });
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private seedObservation(file: TaskStoreFile): void {
    lastObservedRevision = file.revision;
    lastObservedFile = JSON.parse(JSON.stringify(file)) as TaskStoreFile;
  }

  reprojectChanged(file: TaskStoreFile, affectedTaskIds: string[], before?: TaskStoreFile): void {
    const previous = before ?? lastObservedFile;
    if (!previous) {
      this.seedObservation(file);
      return;
    }

    for (const taskId of affectedTaskIds) {
      const patch = projectTaskSummary(file, taskId);
      if (!patch) {
        continue;
      }
      this.post({
        type: 'taskUpdated',
        taskId,
        storeRevision: file.revision,
        patch,
      });
    }

    for (const turnId of Object.keys(file.turns)) {
      const prevTurn = previous.turns[turnId];
      const nextTurn = file.turns[turnId];
      if (prevTurn?.status === 'waiting_user' && nextTurn && nextTurn.status !== 'waiting_user') {
        const overlay = [...activePendingAsks.values()].find((entry) => entry.turnId === turnId);
        if (overlay) {
          activePendingAsks.delete(overlay.taskId);
          this.post({
            type: 'askCleared',
            taskId: overlay.taskId,
            turnId: overlay.turnId,
            askId: overlay.askId,
          });
        }
      }
    }

    lastObservedRevision = file.revision;
    lastObservedFile = JSON.parse(JSON.stringify(file)) as TaskStoreFile;

    if (this._view?.visible && this.focusedTaskId && affectedTaskIds.includes(this.focusedTaskId)) {
      const transcriptChanged = Object.values(file.messages).some((message) => {
        if (message.taskId !== this.focusedTaskId) {
          return false;
        }
        const prev = previous.messages[message.id];
        return JSON.stringify(prev) !== JSON.stringify(message);
      });
      const activeTurnChanged = Object.keys(file.turns).some((turnId) => {
        const prev = previous.turns[turnId];
        const next = file.turns[turnId];
        if (!next || next.taskId !== this.focusedTaskId) {
          return false;
        }
        return JSON.stringify(prev) !== JSON.stringify(next);
      });
      if (transcriptChanged || activeTurnChanged) {
        this.postSnapshot();
      }
    }
  }

  handleExternalStoreChange(): void {
    if (!taskStore) {
      return;
    }
    taskStore.reload();
    const file = taskStore.getFile();
    if (file.revision <= lastObservedRevision) {
      return;
    }
    const previous = lastObservedFile;
    if (!previous) {
      this.seedObservation(file);
      return;
    }
    const affected = new Set<string>();
    for (const taskId of Object.keys(file.tasks)) {
      if (JSON.stringify(previous.tasks[taskId]) !== JSON.stringify(file.tasks[taskId])) {
        affected.add(taskId);
      }
    }
    for (const turn of Object.values(file.turns)) {
      if (JSON.stringify(previous.turns[turn.id]) !== JSON.stringify(turn)) {
        affected.add(turn.taskId);
      }
    }
    for (const message of Object.values(file.messages)) {
      if (JSON.stringify(previous.messages[message.id]) !== JSON.stringify(message)) {
        affected.add(message.taskId);
      }
    }
    this.reprojectChanged(file, [...affected], previous);
  }

  postSnapshot(focusedTaskId?: string): void {
    if (!taskStore) {
      return;
    }
    const focus = focusedTaskId ?? this.focusedTaskId;
    const snapshot: TaskSnapshot = buildSnapshot(taskStore, focus, activePendingAsks);
    this.post({ type: 'snapshot', ...snapshot });
    if (focus) {
      this.focusedTaskId = focus;
    }
    this.seedObservation(taskStore.getFile());
  }

  private transcriptItemFromMessage(messageId: string): TranscriptItem | undefined {
    if (!taskStore) {
      return undefined;
    }
    const message = taskStore.getFile().messages[messageId];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      return undefined;
    }
    return {
      id: message.id,
      kind: message.role as 'user' | 'assistant',
      content: message.content,
    };
  }

  private validateContinuationOf(taskId: string): string | undefined {
    if (!taskStore) {
      return 'task engine not ready';
    }
    const task = taskStore.getTask(taskId);
    if (!task) {
      return 'continuation task not found';
    }
    if (!isTerminalLifecycle(task.lifecycle)) {
      return 'continuationOf must reference a terminal task';
    }
    return undefined;
  }

  private async handleSend(data: {
    taskId?: string;
    text: string;
    backend?: string;
    continuationOf?: string;
  }): Promise<void> {
    if (!taskEngine || !taskStore) {
      this.postCommandError('task engine not ready');
      return;
    }
    const text = data.text?.trim();
    if (!text) {
      this.postCommandError('message cannot be empty', data.taskId);
      return;
    }

    if (!data.taskId) {
      if (data.continuationOf) {
        const continuationError = this.validateContinuationOf(data.continuationOf);
        if (continuationError) {
          this.postCommandError(continuationError);
          return;
        }
      }
      const result = taskEngine.startNewTask({
        goal: text,
        backend: data.backend ?? 'claude',
        continuationOf: data.continuationOf,
      });
      if (!result.ok) {
        this.postCommandError(result.reason);
        return;
      }
      this.focusedTaskId = result.value.taskId;
      this.postSnapshot(result.value.taskId);
      return;
    }

    const result = taskEngine.send(data.taskId, text);
    if (!result.ok) {
      this.postCommandError(result.reason, data.taskId);
      return;
    }
    if (data.taskId === this.focusedTaskId) {
      const item = this.transcriptItemFromMessage(result.value.messageId);
      if (item) {
        this.post({ type: 'transcriptAppend', taskId: data.taskId, item });
      }
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postSnapshot(this.focusedTaskId);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data?.type) {
        case 'send':
          await this.handleSend(data);
          break;
        case 'newTask':
          this.focusedTaskId = undefined;
          this.postSnapshot(undefined);
          break;
        case 'focusTask':
          if (typeof data.taskId === 'string') {
            this.focusedTaskId = data.taskId;
            this.postSnapshot(data.taskId);
          }
          break;
        case 'hydrateSubtree':
          if (typeof data.taskId === 'string') {
            this.focusedTaskId = data.taskId;
            this.postSnapshot(data.taskId);
          }
          break;
        case 'cancelTurn':
          if (!taskEngine || !taskStore) {
            this.postCommandError('task engine not ready');
            break;
          }
          if (typeof data.taskId !== 'string' || typeof data.turnId !== 'string') {
            this.postCommandError('cancelTurn requires taskId and turnId');
            break;
          }
          {
            const turn = taskStore.getFile().turns[data.turnId];
            if (!turn || turn.taskId !== data.taskId) {
              this.postCommandError('turn does not belong to task', data.taskId);
              break;
            }
            const result = taskEngine.interruptTurn(data.turnId);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
            }
          }
          break;
        case 'retryTurn':
          if (!taskEngine || !taskStore) {
            this.postCommandError('task engine not ready');
            break;
          }
          if (typeof data.taskId !== 'string' || typeof data.turnId !== 'string') {
            this.postCommandError('retryTurn requires taskId and turnId');
            break;
          }
          {
            const instruction = typeof data.instruction === 'string' ? data.instruction.trim() : '';
            if (!instruction) {
              this.postCommandError('retryTurn requires a non-empty instruction', data.taskId);
              break;
            }
            const turn = taskStore.getFile().turns[data.turnId];
            if (!turn || turn.taskId !== data.taskId) {
              this.postCommandError('turn does not belong to task', data.taskId);
              break;
            }
            const result = taskEngine.retryTurn(data.turnId, instruction);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
            }
          }
          break;
        case 'continueTask':
          if (!taskEngine) {
            this.postCommandError('task engine not ready');
            break;
          }
          if (typeof data.taskId !== 'string') {
            this.postCommandError('continueTask requires taskId');
            break;
          }
          {
            const instruction = typeof data.instruction === 'string' ? data.instruction.trim() : '';
            if (!instruction) {
              this.postCommandError('continueTask requires a non-empty instruction', data.taskId);
              break;
            }
            const result = taskEngine.continueTaskWithMessage(data.taskId, instruction);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
              break;
            }
            if (data.taskId === this.focusedTaskId) {
              const item = this.transcriptItemFromMessage(result.value.messageId);
              if (item) {
                this.post({ type: 'transcriptAppend', taskId: data.taskId, item });
              }
            }
          }
          break;
        case 'resumeQueuedTurn':
          if (!taskEngine || !taskStore) {
            this.postCommandError('task engine not ready');
            break;
          }
          if (typeof data.taskId !== 'string' || typeof data.turnId !== 'string') {
            this.postCommandError('resumeQueuedTurn requires taskId and turnId');
            break;
          }
          {
            const turn = taskStore.getFile().turns[data.turnId];
            if (!turn || turn.taskId !== data.taskId) {
              this.postCommandError('turn does not belong to task', data.taskId);
              break;
            }
            const result = taskEngine.resumeQueuedTurn(data.turnId);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
            }
          }
          break;
        case 'submitAsk':
          if (
            typeof data.taskId === 'string' &&
            typeof data.turnId === 'string' &&
            typeof data.askId === 'string' &&
            data.answers
          ) {
            taskEngine?.submitAskAnswer(
              { taskId: data.taskId, turnId: data.turnId, askId: data.askId },
              data.answers,
            );
          }
          break;
        case 'cancelAsk':
          if (
            typeof data.taskId === 'string' &&
            typeof data.turnId === 'string' &&
            typeof data.askId === 'string'
          ) {
            taskEngine?.cancelAskTurn({
              taskId: data.taskId,
              turnId: data.turnId,
              askId: data.askId,
            });
          }
          break;
      }
    });

    if (!this.focusedTaskId && taskStore) {
      const roots = Object.values(taskStore.getFile().tasks).filter((task) => task.parentId === null);
      this.focusedTaskId = roots[0]?.id;
    }
    this.postSnapshot(this.focusedTaskId);
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

export async function activate(context: vscode.ExtensionContext) {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  workspaceRoot = wsFolder?.uri.fsPath;
  storePath = wsFolder
    ? path.join(wsFolder.uri.fsPath, '.muster-tasks.json')
    : path.join(context.globalStorageUri.fsPath, '.muster-tasks.json');

  runSessionMigration(context, workspaceRoot);

  const provider = new MusterChatProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MusterChatProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muster.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.muster');
    }),
  );

  try {
    askBridge = new AskBridge({
      onRegister: (ref, questions) => {
        activePendingAsks.set(ref.taskId, {
          taskId: ref.taskId,
          turnId: ref.turnId,
          askId: ref.askId,
          questions,
        });
        provider['_view']?.webview.postMessage({
          type: 'askPending',
          taskId: ref.taskId,
          turnId: ref.turnId,
          askId: ref.askId,
          questions,
        });
      },
    });
    credentialRegistry = new CredentialRegistry();
    bridgeServer = new MusterBridgeServer({
      credentials: credentialRegistry,
      toolHandler: {
        handleToolCall: async (ctx, _tool, args) => {
          if (!taskEngine) {
            return { ok: false, error: 'task engine not ready' };
          }
          return taskEngine.handleToolCall(ctx, _tool, args as import('./task/coordinator-tools').ToolCommand);
        },
      },
    });
    const { port } = await bridgeServer.listen();

    taskStore = TaskStore.load({
      filePath: storePath,
      onCommit: (file, affectedTaskIds) => {
        try {
          provider.reprojectChanged(file, affectedTaskIds);
          applyRetentionToStore(taskStore!);
        } catch {
          // best-effort projection
        }
      },
    });
    applyRetentionToStore(taskStore);
    lastObservedFile = JSON.parse(JSON.stringify(taskStore.getFile())) as TaskStoreFile;
    lastObservedRevision = taskStore.getFile().revision;

    taskEngine = TaskEngine.load({
      store: taskStore,
      makeBackend,
      askBridge,
      credentialRegistry,
      bridgePort: port,
      emit: (event) => {
        try {
          provider.forwardTurnEvent(event);
        } catch {
          // best-effort streaming
        }
      },
    });

    if (storePath) {
      const storeDir = path.dirname(storePath);
      const storeFileName = path.basename(storePath);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(storeDir, storeFileName),
      );
      const onStoreChange = () => provider.handleExternalStoreChange();
      watcher.onDidChange(onStoreChange);
      watcher.onDidCreate(onStoreChange);
      context.subscriptions.push(watcher);
    }

    context.subscriptions.push({
      dispose: () => {
        void bridgeServer?.close();
        askBridge?.cancelAll('deactivate');
        credentialRegistry?.revokeAll();
      },
    });
  } catch (error) {
    void bridgeServer?.close();
    askBridge?.cancelAll('init failed');
    credentialRegistry?.revokeAll();
    bridgeServer = undefined;
    askBridge = undefined;
    credentialRegistry = undefined;
    taskEngine = undefined;
    taskStore = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Muster task engine disabled: ${message}`);
  }
}

export function deactivate() {
  askBridge?.cancelAll('deactivate');
  credentialRegistry?.revokeAll();
  void bridgeServer?.close();
  disposeSharedAcpClient();
}