import * as vscode from 'vscode';
import { AskBridge } from './bridge/ask-bridge';
import type { Question } from './bridge/ask-bridge';
import { PermissionBridge } from './bridge/permission-bridge';
import type { PermissionRequest } from './bridge/permission-bridge';
import { CredentialRegistry } from './bridge/credentials';
import { MusterBridgeServer } from './bridge/server';
import { makeBackend } from './backends/index';
import {
  disposeSharedAcpClient,
  isAskLikeForm,
  setAcpDebugLogger,
  setElicitationController,
  setPermissionController,
  setQuestionController,
} from './backends/acp-client';
import type {
  ElicitationController,
  PermissionController,
  QuestionController,
} from './backends/acp-client';
import { ElicitationBridge } from './bridge/elicitation-bridge';
import type { PermissionAuditEntry, PermissionMode } from './backends/permission-policy';
import {
  buildSnapshot,
  projectTaskSummary,
  type PendingAskOverlay,
  type TaskSnapshot,
  type TranscriptItem,
} from './host/snapshot';
import {
  buildRetentionSettingsSnapshot,
  handleRetentionSettingUpdateAction,
  type RetentionSettingSnapshot,
} from './host/retention-settings';
import { detectAvailableBackends, installAugmentedPath } from './host/backend-availability';
import {
  parseComposerSelection,
  readComposerSelection,
  writeComposerSelection,
} from './host/composer-selection';
import { pickWorkspaceFileMentionPath } from './host/workspace-files';
import { resolveDroppedFileMention } from './host/file-mentions';
import { routeSendLiveInput } from './host/live-input';
import { routeDeleteQueuedTurn, routeEditQueuedTurn } from './host/queued-turn-mutations';
import { routeExportTask } from './host/task-export-route';
import { importDroppedFileBytes } from './host/import-dropped-file';
import { PresentationManager } from './host/presentation-manager';
import {
  createPresentationPanelFactory,
  createPresentationPanelSerializer,
  type PresentationHost,
} from './host/presentation-panel-adapter';
import { PresentationToolRouter } from './host/presentation-tool-router';
import { createPresentationChatLink } from './host/presentation-chat-link';
import { enumerateModels, type BackendModels } from './backends/model-catalog';
import { SESSION_MIGRATION_MARKER, migrateLegacySessions } from './task/migration-sessions';
import { applyRetention, retentionChanged, type RetentionConfig } from './task/retention';
import { TaskEngine, type EngineEvent, viewStatusFromDraft } from './task/engine';
import { TaskStore, computeAffectedTaskIds, type CommitResult } from './task/store';
import { isTerminalLifecycle } from './task/transitions';
import { resolveWorkspaceCwd } from './task/workspace-cwd';
import type { TaskStoreFile } from './task/types';
import * as fs from 'fs';
import * as path from 'path';

let askBridge: AskBridge | undefined;
let elicitationBridge: ElicitationBridge | undefined;
let permissionBridge: PermissionBridge | undefined;
let permissionAuditChannel: vscode.OutputChannel | undefined;
let elicitationDebugChannel: vscode.OutputChannel | undefined;
let credentialRegistry: CredentialRegistry | undefined;
let bridgeServer: MusterBridgeServer | undefined;
let taskEngine: TaskEngine | undefined;
let taskStore: TaskStore | undefined;
let storePath: string | undefined;
let workspaceRoot: string | undefined;
let presentationManager: PresentationManager | undefined;
let lastObservedRevision = 0;
let lastObservedFile: TaskStoreFile | undefined;
const activePendingAsks = new Map<string, PendingAskOverlay>();

function debugElicitation(event: string, details: Record<string, unknown> = {}): void {
  try {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${event} ${JSON.stringify(details)}`;
    elicitationDebugChannel?.appendLine(line);
    // Mirror to the Extension Host Debug Console for launch/F5 workflows.
    // Keep a stable prefix so users can filter the otherwise noisy console.
    console.info(`[muster][elicitation-debug] ${line}`);
  } catch {
    // Debug logging must not affect the live protocol path.
  }
}

/**
 * Host copy of the webview wire protocol version. The source of truth is
 * PROTOCOL_VERSION in webview/src/lib/protocol.ts; the host cannot import that
 * module because its graph has browser-only side effects (acquireVsCodeApi runs
 * at import time), so the value is duplicated here. Keep the two in sync: the
 * version is stamped on the bootstrap `snapshot` message, and a mismatch is
 * surfaced in the webview as a visible "reload the window" banner.
 */
const PROTOCOL_VERSION = 4;

/** How long a permission prompt waits for a webview decision before safe-denying. */
const PERMISSION_PROMPT_TIMEOUT_MS = 120_000;
/** Reject oversized inbound webview identifiers/option ids (defense-in-depth). */
const MAX_ID_CHARS = 256;

/** Read the live permission mode from settings (never frozen at connect time). */
function getPermissionMode(): PermissionMode {
  const mode = vscode.workspace.getConfiguration('muster.permissions').get<string>('mode', 'ask');
  return mode === 'allow' || mode === 'readonly' ? mode : 'ask';
}

/** Backends the webview may request. Mirrors the composer's select options. */
const WEBVIEW_BACKENDS = new Set(['claude', 'grok', 'kiro', 'codex', 'opencode']);
const MAX_MESSAGE_CHARS = 100_000;
const MAX_FREE_TEXT_CHARS = 10_000;
const MAX_LINK_CHARS = 4096;

const presentationHost: PresentationHost = {
  joinPath: (...parts) => vscode.Uri.joinPath(parts[0] as vscode.Uri, ...(parts.slice(1) as string[])),
  createPanel: (viewType, title, showOptions, options) =>
    vscode.window.createWebviewPanel(
      viewType,
      title,
      showOptions as { viewColumn: vscode.ViewColumn; preserveFocus?: boolean },
      options as vscode.WebviewPanelOptions & vscode.WebviewOptions,
    ),
  openExternal: (uri) => vscode.env.openExternal(uri as vscode.Uri),
  parseUri: (value) => vscode.Uri.parse(value, true),
  besideColumn: vscode.ViewColumn.Beside,
};

/** Validate the inbound ask-answer payload shape from the webview. */
function isValidAskAnswers(
  value: unknown,
): value is Record<string, { selected: string[]; freeText: string | null }> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const e = entry as { selected?: unknown; freeText?: unknown };
    if (!Array.isArray(e.selected) || !e.selected.every((s) => typeof s === 'string')) {
      return false;
    }
    if (!(e.freeText === null || typeof e.freeText === 'string')) {
      return false;
    }
    if (typeof e.freeText === 'string' && e.freeText.length > MAX_FREE_TEXT_CHARS) {
      return false;
    }
  }
  return true;
}

function readRetentionSettingsSnapshot(): RetentionSettingSnapshot {
  const config = vscode.workspace.getConfiguration('muster.retention');
  return buildRetentionSettingsSnapshot((key) => config.get(key));
}

function getRetentionConfig(): RetentionConfig {
  const snapshot = readRetentionSettingsSnapshot();
  return {
    maxTurnsPerTask:
      snapshot.settings.find((setting) => setting.id === 'maxTurnsPerTask')?.value ?? 200,
    maxStoredOutputChars:
      snapshot.settings.find((setting) => setting.id === 'maxStoredOutputChars')?.value ?? 200_000,
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
    draft.toolCalls = pruned.toolCalls ?? {};
    draft.reasoning = pruned.reasoning ?? {};
    return { ok: true };
  });
}

/**
 * True when any record belonging to `taskId` differs between `previous` and `file`,
 * including additions AND deletions (a record present in one snapshot but absent in
 * the other). Used to decide whether a focused snapshot must be re-posted.
 */
function taskRecordsChanged(
  previous: TaskStoreFile,
  file: TaskStoreFile,
  taskId: string,
): boolean {
  const differs = <T extends { taskId: string }>(
    prevMap: Record<string, T> | undefined,
    nextMap: Record<string, T> | undefined,
  ): boolean => {
    const prev = prevMap ?? {};
    const next = nextMap ?? {};
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const p = prev[key];
      const n = next[key];
      if (p?.taskId !== taskId && n?.taskId !== taskId) {
        continue;
      }
      if (JSON.stringify(p) !== JSON.stringify(n)) {
        return true;
      }
    }
    return false;
  };
  return (
    differs(previous.messages, file.messages) ||
    differs(previous.toolCalls, file.toolCalls) ||
    differs(previous.reasoning, file.reasoning) ||
    differs(previous.turns, file.turns)
  );
}

class MusterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'muster.chat';
  private _view?: vscode.WebviewView;
  /** In-flight/cached detection of which backend CLIs are callable (computed once). */
  private availableBackendsPromise?: Promise<string[]>;
  /** In-flight/cached per-backend model enumeration (computed once). */
  private availableModelsPromise?: Promise<Record<string, BackendModels>>;
  focusedTaskId?: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _globalState: vscode.Memento,
  ) {}

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

  private postSettingsSnapshot(): void {
    try {
      this.post({ type: 'settingsSnapshot', snapshot: readRetentionSettingsSnapshot() });
    } catch {
      this.post({
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          code: 'unknownSetting',
          message: 'Unable to load retention settings.',
        },
      });
    }
  }

  private async handleUpdateSetting(data: unknown): Promise<void> {
    const messages = await handleRetentionSettingUpdateAction(
      vscode.workspace.getConfiguration('muster.retention'),
      data,
      vscode.ConfigurationTarget.Workspace,
    );
    for (const message of messages) {
      this.post(message);
    }
  }

  private workspaceMentionForUri(uri: vscode.Uri): string | undefined {
    const fsPath = uri.fsPath;
    if (!fsPath) return undefined;

    if (workspaceRoot) {
      const relative = path.relative(workspaceRoot, fsPath);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.replace(/\\/g, '/');
      }
    }

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      const relative = path.relative(folder.uri.fsPath, fsPath);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.replace(/\\/g, '/');
      }
    }

    return undefined;
  }

  private uriFromDroppedCandidate(candidate: string): vscode.Uri | undefined {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('#')) return undefined;

    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        const uri = vscode.Uri.parse(trimmed);
        if (uri.scheme === 'file' || uri.scheme === 'vscode-remote') {
          return uri;
        }
      }
    } catch {
      // Fall back to path handling below.
    }

    if (path.isAbsolute(trimmed)) {
      return vscode.Uri.file(trimmed);
    }

    if (workspaceRoot) {
      const candidatePath = path.resolve(workspaceRoot, trimmed);
      if (fs.existsSync(candidatePath)) {
        return vscode.Uri.file(candidatePath);
      }
    }

    return undefined;
  }

  private async handlePickFile(): Promise<void> {
    const defaultUri = workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri,
      openLabel: 'Add file to chat',
    });
    const uri = picked?.[0];
    if (!uri) return;

    const mentionPath = this.workspaceMentionForUri(uri);
    if (!mentionPath) {
      this.postCommandError('Only workspace files can be added to chat.');
      return;
    }
    this.postFilePicked(mentionPath);
  }

  /** Notify webview of a file mention: full `path` for LLM, short display name for chips. */
  private postFilePicked(resolvePath: string, displayName?: string): void {
    const base = displayName?.trim() || resolvePath.replace(/\\/g, '/').split('/').pop() || resolvePath;
    this.post({ type: 'filePicked', path: resolvePath, displayName: base });
  }

  private async handleBrowseWorkspaceFiles(): Promise<void> {
    try {
      const result = await pickWorkspaceFileMentionPath({
        workspaceFolders: vscode.workspace.workspaceFolders,
        findFiles: (include, exclude, maxResults) => vscode.workspace.findFiles(include, exclude, maxResults),
        showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
      });

      switch (result.type) {
        case 'picked':
          this.postFilePicked(result.path);
          return;
        case 'cancelled':
          return;
        case 'noWorkspace':
          this.postCommandError('Open a workspace to browse files.');
          return;
        case 'noFiles':
          this.postCommandError('No workspace files found to add to chat.');
          return;
        default: {
          const _exhaustive: never = result;
          return _exhaustive;
        }
      }
    } catch {
      this.postCommandError('Unable to browse workspace files.');
    }
  }

  private async handleResolveFileDrop(candidates: unknown): Promise<void> {
    const result = await resolveDroppedFileMention(candidates, {
      workspaceFolders: vscode.workspace.workspaceFolders,
      parseUri: (value) => vscode.Uri.parse(value, true),
      fileUri: (value) => vscode.Uri.file(value),
      joinPath: (base, value) => vscode.Uri.joinPath(base as vscode.Uri, value),
      stat: (uri) => vscode.workspace.fs.stat(uri as vscode.Uri),
    });
    if (result.ok) {
      this.postFilePicked(result.path);
    } else {
      this.postCommandError(result.message);
    }
  }

  /**
   * Persist a Finder/OS drop that the webview could read as bytes but not as a
   * path (sandbox). Returns an absolute temp path so the LLM can open the file.
   */
  private handleImportDroppedFile(name: unknown, data: unknown): void {
    if (typeof name !== 'string' || !name.trim()) {
      this.postCommandError('Dropped file is missing a name.');
      return;
    }
    let bytes: Uint8Array | undefined;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (Array.isArray(data) && data.every((n) => typeof n === 'number')) {
      bytes = Uint8Array.from(data);
    }
    if (!bytes) {
      this.postCommandError('Dropped file data is missing.');
      return;
    }
    const result = importDroppedFileBytes(name, bytes);
    if (result.ok) {
      // UI shows original name; LLM gets absolute temp path via expand-on-send.
      this.postFilePicked(result.path, name.trim());
    } else {
      this.postCommandError(result.message);
    }
  }

  /**
   * Detect (once, cached) which backend CLIs are installed on this machine and
   * tell the webview so its picker only offers callable backends. If detection
   * fails we stay silent — the webview then fails open and shows all backends.
   */
  private async postAvailableBackends(): Promise<void> {
    try {
      // Cache the in-flight promise so a concurrent panel-open + `listBackends`
      // don't run detection twice.
      this.availableBackendsPromise ??= detectAvailableBackends();
      const backends = await this.availableBackendsPromise;
      this.post({ type: 'backendsAvailable', backends });
    } catch {
      // Detection failed — drop the cached rejection so a later request retries;
      // the webview meanwhile fails open and shows all backends.
      this.availableBackendsPromise = undefined;
    }
  }

  /** Push host-persisted last-used backend/model so the picker survives restarts. */
  private postComposerSelection(): void {
    const selection = readComposerSelection(this._globalState);
    if (!selection) return;
    this.post({
      type: 'composerSelection',
      backend: selection.backend,
      model: selection.model,
    });
  }

  private handleSetComposerSelection(data: { backend?: unknown; model?: unknown }): void {
    const selection = parseComposerSelection({
      backend: data.backend,
      model: data.model === undefined ? null : data.model,
    });
    if (!selection) return;
    void writeComposerSelection(this._globalState, selection);
  }

  /**
   * Enumerate each installed backend's models (via a throwaway ACP session) and
   * send them to the webview for the grouped model picker.
   *
   * Posts progressive updates as each backend settles (so the picker fills in
   * without waiting for the slowest CLI). An empty final result is not cached
   * forever — the next request retries. Failures stay fail-open (plain backend
   * labels) with a console warning.
   */
  private async postAvailableModels(): Promise<void> {
    if (this.availableModelsPromise) {
      // Already enumerating / done — re-post whatever we have when it finishes.
      try {
        const models = await this.availableModelsPromise;
        if (Object.keys(models).length > 0) {
          this.post({ type: 'modelsAvailable', models });
        }
      } catch {
        this.availableModelsPromise = undefined;
      }
      return;
    }

    this.availableModelsPromise = (async () => {
      const backends = await (this.availableBackendsPromise ??= detectAvailableBackends());
      console.info(`Muster: enumerating models for backends: ${backends.join(', ') || '(none)'}`);
      const models = await enumerateModels(backends, resolveTaskCwd(), (partial) => {
        this.post({ type: 'modelsAvailable', models: partial });
      });
      console.info(
        `Muster: model catalog ready for ${Object.keys(models).join(', ') || '(no model options)'}`,
      );
      return models;
    })();

    try {
      const models = await this.availableModelsPromise;
      this.post({ type: 'modelsAvailable', models });
      // Empty catalog: drop cache so a later listModels can retry (transient ACP failures).
      if (Object.keys(models).length === 0) {
        this.availableModelsPromise = undefined;
      }
    } catch (err) {
      console.warn('Muster: model enumeration failed:', err instanceof Error ? err.message : err);
      this.availableModelsPromise = undefined;
    }
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
        // Turn left the FIFO queue — project its user message(s) into chat now.
        // Snapshot rebuild also includes them; append is idempotent by message id.
        if (event.taskId === this.focusedTaskId && taskStore) {
          const turn = taskStore.getFile().turns[event.turnId];
          if (turn) {
            for (const input of turn.inputs) {
              if (input.kind !== 'message') continue;
              const item = this.transcriptItemFromMessage(input.messageId);
              if (item) {
                this.post({
                  type: 'transcriptAppend',
                  taskId: event.taskId,
                  item: { ...item, turnId: event.turnId },
                });
              }
            }
          }
        }
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
      if (taskRecordsChanged(previous, file, this.focusedTaskId)) {
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
    // Union-key diff (deletion-aware): a task is affected when any of its
    // tasks/turns/messages/toolCalls/reasoning records was added, changed, OR removed.
    const affected = computeAffectedTaskIds(previous, file);
    this.reprojectChanged(file, affected, previous);
  }

  focusTask(taskId: string): void {
    this.focusedTaskId = taskId;
    this.postSnapshot(taskId);
  }

  postSnapshot(focusedTaskId?: string): void {
    if (!taskStore) {
      return;
    }
    const focus = focusedTaskId ?? this.focusedTaskId;
    const snapshot: TaskSnapshot = buildSnapshot(taskStore, focus, activePendingAsks);
    // Stamp the wire version on the bootstrap message so the webview can detect
    // host<->webview drift once (and show a reload banner) instead of silently
    // dropping mismatched messages.
    this.post({ type: 'snapshot', protocolVersion: PROTOCOL_VERSION, ...snapshot });
    this.replayPendingElicitations();
    if (focus) {
      this.focusedTaskId = focus;
    }
    this.seedObservation(taskStore.getFile());
  }

  /** Replay durable elicitation prompts after snapshot / webview resolve. */
  replayPendingElicitations(): void {
    if (!elicitationBridge || !this._view) return;
    for (const prompt of elicitationBridge.listPending()) {
      if ('fields' in prompt) {
        this.post({
          type: 'elicitationFormPending',
          promptId: prompt.promptId,
          sessionId: prompt.sessionId,
          toolCallId: prompt.toolCallId,
          message: prompt.message,
          fields: prompt.fields,
          required: prompt.required,
          askLike: prompt.askLike,
        });
      } else {
        this.post({
          type: 'elicitationUrlPending',
          promptId: prompt.promptId,
          elicitationId: prompt.elicitationId,
          sessionId: prompt.sessionId,
          url: prompt.url,
          message: prompt.message,
        });
      }
    }
    for (const oob of elicitationBridge.listOob()) {
      // Reconstruct full URL card then mark waiting (webview map may be empty).
      this.post({
        type: 'elicitationUrlPending',
        promptId: oob.promptId,
        elicitationId: oob.elicitationId,
        url: oob.url,
        message: oob.message,
      });
      this.post({
        type: 'elicitationUrlWaiting',
        promptId: oob.promptId,
        elicitationId: oob.elicitationId,
        message: oob.message,
      });
    }
  }

  private handleOpenLink(url: unknown): void {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_LINK_CHARS) {
      this.postCommandError('invalid link');
      return;
    }
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(url, true);
    } catch {
      this.postCommandError('invalid link');
      return;
    }
    const scheme = parsed.scheme.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
      this.postCommandError('link scheme not allowed');
      return;
    }
    void vscode.env.openExternal(parsed);
  }

  /**
   * A task is removable only if it is idle or terminal (not actively working)
   * and it is not the currently focused task. Removability is derived from the
   * fresh `draft` (via viewStatusFromDraft) so the check is consistent with the
   * exact bytes a commit is about to write — see the guard-inside-commit note on
   * handleDeleteTask/handleClearHistory.
   */
  private isDraftTaskRemovable(draft: TaskStoreFile, id: string, focus: string | undefined): boolean {
    if (id === focus) return false;
    const viewStatus = viewStatusFromDraft(draft, id);
    return (
      viewStatus === 'idle' ||
      viewStatus === 'succeeded' ||
      viewStatus === 'failed' ||
      viewStatus === 'cancelled' ||
      viewStatus === 'skipped'
    );
  }

  /** Index children by parent id so whole subtrees can be inspected. */
  private buildChildrenIndex(tasks: TaskStoreFile['tasks']): Map<string, string[]> {
    const childrenOf = new Map<string, string[]>();
    for (const t of Object.values(tasks)) {
      if (t.parentId) {
        const list = childrenOf.get(t.parentId);
        if (list) list.push(t.id);
        else childrenOf.set(t.parentId, [t.id]);
      }
    }
    return childrenOf;
  }

  /**
   * Return every task id in the subtree rooted at `rootId` IF every task in it
   * is removable; otherwise null. A root can be idle/terminal while a delegated
   * child is still queued/running, and deleting the subtree would otherwise nuke
   * that in-flight work — so the whole subtree must be clear before removal.
   */
  private removableSubtree(
    draft: TaskStoreFile,
    rootId: string,
    childrenOf: Map<string, string[]>,
    focus: string | undefined,
  ): string[] | null {
    const subtree: string[] = [];
    const stack: string[] = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      subtree.push(id);
      if (!this.isDraftTaskRemovable(draft, id, focus)) return null;
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }
    return subtree;
  }

  /**
   * Mutate `draft` in place: delete the given task ids and their
   * turns/messages/toolCalls/reasoning. Called from inside a `commit` callback
   * (operations/cancelRequests are turn-keyed or ledger; safe to leave).
   */
  private applyTaskDeletion(draft: TaskStoreFile, ids: Iterable<string>): void {
    const idSet = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
    for (const id of idSet) {
      delete draft.tasks[id];
      for (const turnId of Object.keys(draft.turns)) {
        if (draft.turns[turnId].taskId === id) delete draft.turns[turnId];
      }
      for (const msgId of Object.keys(draft.messages)) {
        if (draft.messages[msgId].taskId === id) delete draft.messages[msgId];
      }
      if (draft.toolCalls) {
        for (const key of Object.keys(draft.toolCalls)) {
          if (draft.toolCalls[key].taskId === id) delete draft.toolCalls[key];
        }
      }
      if (draft.reasoning) {
        for (const key of Object.keys(draft.reasoning)) {
          if (draft.reasoning[key].taskId === id) delete draft.reasoning[key];
        }
      }
    }
    // ensure optionals exist
    draft.operations = draft.operations ?? {};
    draft.cancelRequests = draft.cancelRequests ?? {};
  }

  /** Surface a failed commit as a command error. Returns true when it failed. */
  private reportCommitFailure(result: CommitResult): boolean {
    if (result.ok) return false;
    this.postCommandError(result.detail ?? `store ${result.reason}`);
    return true;
  }

  private handleClearHistory(): void {
    if (!taskStore) {
      this.postCommandError('task store not ready');
      return;
    }
    const focus = this.focusedTaskId;
    let focusRemoved = false;
    // Compute removable subtrees INSIDE the commit against the fresh `draft` that
    // commit re-reads under the store lock. Deciding on the pre-commit snapshot
    // would be TOCTOU-unsafe: another window could add a delegated descendant or
    // flip a task to running between the check and the write, orphaning the child
    // or deleting active work.
    const result = taskStore.commit((draft) => {
      const childrenOf = this.buildChildrenIndex(draft.tasks);
      const toRemove = new Set<string>();
      for (const task of Object.values(draft.tasks)) {
        if (task.parentId !== null) continue;
        const subtree = this.removableSubtree(draft, task.id, childrenOf, focus);
        if (subtree) for (const id of subtree) toRemove.add(id);
      }
      if (toRemove.size === 0) return { ok: true }; // nothing removable — no-op
      this.applyTaskDeletion(draft, toRemove);
      if (focus && toRemove.has(focus)) focusRemoved = true;
      return { ok: true };
    });
    if (this.reportCommitFailure(result)) return;
    if (focusRemoved) this.focusedTaskId = undefined;
    this.postSnapshot(this.focusedTaskId);
  }

  /** Delete a single top-level task (and its whole subtree) from history. */
  private handleDeleteTask(taskId: string): void {
    if (!taskStore) {
      this.postCommandError('task store not ready');
      return;
    }
    const focus = this.focusedTaskId;
    let focusRemoved = false;
    // Validate + delete atomically against the fresh `draft` (see handleClearHistory).
    const result = taskStore.commit((draft) => {
      const task = draft.tasks[taskId];
      if (!task) return { ok: true }; // already gone — no-op
      if (task.parentId !== null) return { ok: false, reason: 'Only top-level tasks can be deleted.' };
      const childrenOf = this.buildChildrenIndex(draft.tasks);
      const subtree = this.removableSubtree(draft, taskId, childrenOf, focus);
      if (!subtree) {
        return { ok: false, reason: 'Cannot delete a task while it or a subtask is still running.' };
      }
      this.applyTaskDeletion(draft, subtree);
      if (focus && subtree.includes(focus)) focusRemoved = true;
      return { ok: true };
    });
    if (this.reportCommitFailure(result)) return;
    if (focusRemoved) this.focusedTaskId = undefined;
    this.postSnapshot(this.focusedTaskId);
  }

  /** Rename a task by replacing its goal (the display label). */
  private handleRenameTask(taskId: string, goal: string): void {
    if (!taskStore) {
      this.postCommandError('task store not ready');
      return;
    }
    const trimmed = goal.trim();
    if (!trimmed) {
      this.postCommandError('Task name cannot be empty.');
      return;
    }
    const capped = trimmed.length > MAX_MESSAGE_CHARS ? trimmed.slice(0, MAX_MESSAGE_CHARS) : trimmed;
    const result = taskStore.commit((draft) => {
      const t = draft.tasks[taskId];
      if (!t) return { ok: true }; // gone — no-op
      t.goal = capped;
      return { ok: true };
    });
    if (this.reportCommitFailure(result)) return;
    this.postSnapshot(this.focusedTaskId);
  }

  /**
   * Export one task as Markdown via native Save As. Read-only store access;
   * never mutates task-store state. Cancel is intentionally silent.
   */
  private async handleExportTask(data: unknown): Promise<void> {
    if (!taskStore) {
      this.postCommandError('task store not ready');
      return;
    }
    const store = taskStore;
    const outcome = await routeExportTask(data, {
      getStoreFile: () => store.getFile(),
      showSaveDialog: async ({ defaultFileName }) => {
        const defaultUri = workspaceRoot
          ? vscode.Uri.file(path.join(workspaceRoot, defaultFileName))
          : vscode.Uri.file(defaultFileName);
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { Markdown: ['md'] },
          saveLabel: 'Export',
        });
        // vscode.Uri satisfies TaskExportUri (fsPath/path); absolute paths never leave the route.
        return uri;
      },
      writeFile: async (uri, content) => {
        await vscode.workspace.fs.writeFile(uri as vscode.Uri, content);
      },
      exportedAt: new Date().toISOString(),
    });
    if (outcome.kind === 'cancel') {
      return;
    }
    for (const message of outcome.messages) {
      this.post(message);
    }
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
    /** Expanded mention paths for the agent; defaults to `text`. */
    llmText?: string;
    backend?: string;
    model?: string;
    continuationOf?: string;
    clientRequestId?: string;
  }): Promise<void> {
    const clientRequestId =
      typeof data.clientRequestId === 'string' && data.clientRequestId.trim()
        ? data.clientRequestId.trim()
        : undefined;
    if (!taskEngine || !taskStore) {
      if (clientRequestId) {
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: 'task engine not ready',
          code: 'store',
        });
      } else {
        this.postCommandError('task engine not ready');
      }
      return;
    }
    if (data.backend !== undefined && !WEBVIEW_BACKENDS.has(data.backend)) {
      if (clientRequestId) {
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: 'unknown backend',
          code: 'validation',
        });
      } else {
        this.postCommandError('unknown backend', data.taskId);
      }
      return;
    }
    // `text` = user-visible (display-name chips). `llmText` = agent payload when expanded.
    const text = data.text?.trim();
    if (!text) {
      if (clientRequestId) {
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: 'message cannot be empty',
          code: 'validation',
        });
      } else {
        this.postCommandError('message cannot be empty', data.taskId);
      }
      return;
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      if (clientRequestId) {
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: 'message too long',
          code: 'validation',
        });
      } else {
        this.postCommandError('message too long', data.taskId);
      }
      return;
    }
    const llmText =
      typeof data.llmText === 'string' && data.llmText.trim() ? data.llmText.trim() : text;
    if (llmText.length > MAX_MESSAGE_CHARS) {
      if (clientRequestId) {
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: 'message too long',
          code: 'validation',
        });
      } else {
        this.postCommandError('message too long', data.taskId);
      }
      return;
    }

    if (!data.taskId) {
      if (data.continuationOf) {
        const continuationError = this.validateContinuationOf(data.continuationOf);
        if (continuationError) {
          if (clientRequestId) {
            this.post({
              type: 'sendRejected',
              clientRequestId,
              reason: continuationError,
              code: 'validation',
            });
          } else {
            this.postCommandError(continuationError);
          }
          return;
        }
      }

      // Goal from display text so task titles stay short (not absolute temp paths).
      const shortGoal = text.length <= 30 ? text : text.slice(0, 30).trim() + '…';
      const resolvedBackend = data.backend ?? 'claude';
      const resolvedModel =
        typeof data.model === 'string' && data.model ? data.model : undefined;
      // DEBUG: temporary — remove after diagnosing grok→claude draft send.
      console.info('[muster][host-send]', {
        inboundBackend: data.backend,
        inboundModel: data.model,
        resolvedBackend,
        resolvedModel: resolvedModel ?? null,
        usedDefaultBackend: data.backend === undefined,
      });

      const result = taskEngine.startNewTask({
        goal: shortGoal,
        message: text,
        agentMessage: llmText !== text ? llmText : undefined,
        backend: resolvedBackend,
        model: resolvedModel,
        continuationOf: data.continuationOf,
        // Capture the workspace cwd at task-creation time so every turn (and any
        // delegated child) runs in the right directory instead of process.cwd().
        cwd: resolveTaskCwd(),
        clientRequestId,
      });
      if (!result.ok) {
        if (clientRequestId) {
          const code = /conflict/i.test(result.reason)
            ? 'conflict'
            : /capacity|maxTurns|turn cap/i.test(result.reason)
              ? 'capacity'
              : 'unknown';
          this.post({
            type: 'sendRejected',
            clientRequestId,
            reason: result.reason,
            code,
          });
        } else {
          this.postCommandError(result.reason);
        }
        return;
      }
      console.info('[muster][host-send] task created', {
        taskId: result.value.taskId,
        backend: resolvedBackend,
        model: resolvedModel ?? null,
      });
      this.focusedTaskId = result.value.taskId;
      if (clientRequestId) {
        this.post({
          type: 'sendAccepted',
          clientRequestId,
          taskId: result.value.taskId,
          messageId: result.value.messageId,
          turnId: result.value.turnId,
        });
      }
      this.postSnapshot(result.value.taskId);
      return;
    }

    const result = taskEngine.send(data.taskId, text, {
      agentContent: llmText !== text ? llmText : undefined,
      clientRequestId,
    });
    if (!result.ok) {
      if (clientRequestId) {
        const code = /conflict/i.test(result.reason)
          ? 'conflict'
          : /capacity|maxTurns|turn cap/i.test(result.reason)
            ? 'capacity'
            : 'unknown';
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: result.reason,
          code,
        });
      } else {
        this.postCommandError(result.reason, data.taskId);
      }
      return;
    }
    if (clientRequestId && result.value.messageId) {
      this.post({
        type: 'sendAccepted',
        clientRequestId,
        taskId: data.taskId,
        messageId: result.value.messageId,
        turnId: result.value.turnId,
      });
    }
    // Only project into chat when the turn is not a FIFO follow-up still sitting
    // in the queue. Queued messages appear in the queue panel only; they enter
    // chat when the turn promotes to running (snapshot rebuild).
    if (data.taskId === this.focusedTaskId && this.shouldAppendSendToTranscript(result.value.turnId)) {
      const item = this.transcriptItemFromMessage(result.value.messageId);
      if (item) {
        this.post({ type: 'transcriptAppend', taskId: data.taskId, item });
      }
    }
  }

  /**
   * True when a newly created turn should appear in chat immediately.
   * Queued FIFO follow-ups stay out of chat (queue panel + snapshot.previewText only)
   * until the turn promotes to running (turnStart / snapshot rebuild).
   */
  private shouldAppendSendToTranscript(turnId: string | undefined): boolean {
    if (!turnId || !taskStore) {
      return false;
    }
    const turn = taskStore.getFile().turns[turnId];
    return Boolean(turn && turn.status !== 'queued');
  }

  /**
   * Stale edit/delete when a follow-up already started is an expected race (drain),
   * not a hard command failure. Refresh projection quietly; surface real errors.
   */
  private handleQueuedMutationOutcome(
    message: string,
    taskId: string | undefined,
    turnId: unknown,
  ): void {
    const stale =
      /not queued|not found|already dispatched|is not pending/i.test(message) ||
      (typeof turnId === 'string' &&
        !!taskStore &&
        (() => {
          const turn = taskStore.getFile().turns[turnId];
          return !!turn && turn.status !== 'queued';
        })());
    if (stale) {
      this.postSnapshot(taskId ?? this.focusedTaskId);
      return;
    }
    this.postCommandError(message, taskId);
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
      if (data?.type === 'submitAsk' || data?.type === 'cancelAsk' || data?.type === 'submitElicitation') {
        debugElicitation('host.webview_message', {
          type: data.type,
          taskId: data.taskId,
          turnId: data.turnId,
          askId: data.askId,
          promptId: data.promptId,
          action: data.action,
          answerIndexes:
            data.answers && typeof data.answers === 'object' ? Object.keys(data.answers) : undefined,
          contentKeys:
            data.content && typeof data.content === 'object' ? Object.keys(data.content) : undefined,
        });
      }
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
            const sessionId = turn.observedSessionId;
            const result = taskEngine.interruptTurn(data.turnId);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
            } else if (sessionId) {
              elicitationBridge?.cancelForSession(sessionId);
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
            const reuseOriginalInputs = data.reuseOriginalInputs === true;
            // Explicit original-input replay may omit instruction (reuses prior inputs).
            const effectiveInstruction =
              instruction || (reuseOriginalInputs ? 'Run again' : '');
            if (!effectiveInstruction) {
              this.postCommandError('retryTurn requires a non-empty instruction', data.taskId);
              break;
            }
            if (effectiveInstruction.length > MAX_MESSAGE_CHARS) {
              this.postCommandError('instruction too long', data.taskId);
              break;
            }
            const turn = taskStore.getFile().turns[data.turnId];
            if (!turn || turn.taskId !== data.taskId) {
              this.postCommandError('turn does not belong to task', data.taskId);
              break;
            }
            const result = taskEngine.retryTurn(data.turnId, effectiveInstruction, {
              reuseOriginalInputs,
            });
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
            if (instruction.length > MAX_MESSAGE_CHARS) {
              this.postCommandError('instruction too long', data.taskId);
              break;
            }
            const result = taskEngine.continueTaskWithMessage(data.taskId, instruction);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
              break;
            }
            if (
              data.taskId === this.focusedTaskId &&
              this.shouldAppendSendToTranscript(result.value.turnId)
            ) {
              const item = this.transcriptItemFromMessage(result.value.messageId);
              if (item) {
                this.post({ type: 'transcriptAppend', taskId: data.taskId, item });
              }
            }
          }
          break;
        case 'sendLiveInput': {
          // Interrupt & send (cut & continue): reserve follow-up first, then
          // interrupt the live turn if a local handle exists. Never concurrent
          // backend.sendLiveInput / liveInputResult banner.
          const engine = taskEngine;
          if (!engine) {
            this.postCommandError('task engine not ready');
            break;
          }
          const instruction =
            typeof data.instruction === 'string' ? data.instruction.trim() : '';
          const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
          if (!taskId) {
            this.postCommandError('sendLiveInput requires taskId');
            break;
          }
          if (!instruction) {
            this.postCommandError('message cannot be empty', taskId);
            break;
          }
          if (instruction.length > MAX_MESSAGE_CHARS) {
            this.postCommandError('instruction too long', taskId);
            break;
          }
          const result = engine.interruptAndSend(taskId, instruction);
          if (!result.ok) {
            this.postCommandError(result.reason, taskId);
            break;
          }
          this.postSnapshot(taskId);
          break;
        }
        case 'editQueuedTurn': {
          // R013: edit undispatched queued follow-up by turn identity.
          // Validate + engine.editQueuedTurn only; never continueTask fallthrough.
          const engine = taskEngine;
          const outcome = routeEditQueuedTurn(data, {
            engineReady: Boolean(engine),
            editQueuedTurn: (taskId, turnId, content) => {
              if (!engine) {
                return { ok: false, reason: 'task engine not ready' };
              }
              return engine.editQueuedTurn(taskId, turnId, content);
            },
          });
          if (outcome.kind === 'error') {
            this.handleQueuedMutationOutcome(outcome.message, outcome.taskId, data?.turnId);
          } else {
            // Always reproject so queue panel / previewText stay authoritative.
            this.postSnapshot(outcome.taskId ?? this.focusedTaskId);
          }
          break;
        }
        case 'deleteQueuedTurn': {
          // R013: remove undispatched queued follow-up by turn identity.
          // Validate + engine.deleteQueuedTurn only; never cancelProcess.
          const engine = taskEngine;
          const outcome = routeDeleteQueuedTurn(data, {
            engineReady: Boolean(engine),
            deleteQueuedTurn: (taskId, turnId) => {
              if (!engine) {
                return { ok: false, reason: 'task engine not ready' };
              }
              return engine.deleteQueuedTurn(taskId, turnId);
            },
          });
          if (outcome.kind === 'error') {
            this.handleQueuedMutationOutcome(outcome.message, outcome.taskId, data?.turnId);
          } else {
            this.postSnapshot(outcome.taskId ?? this.focusedTaskId);
          }
          break;
        }
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
        case 'setTaskLifecycle': {
          if (!taskEngine) {
            this.postCommandError('task engine not ready');
            break;
          }
          if (typeof data.taskId !== 'string') {
            this.postCommandError('setTaskLifecycle requires taskId');
            break;
          }
          const lifecycle = data.lifecycle;
          if (
            lifecycle !== 'open' &&
            lifecycle !== 'succeeded' &&
            lifecycle !== 'failed' &&
            lifecycle !== 'cancelled' &&
            lifecycle !== 'skipped'
          ) {
            this.postCommandError('setTaskLifecycle requires a valid lifecycle', data.taskId);
            break;
          }
          // Cancel/skip cascade to descendants; other seals are single-task (user menu).
          // setTaskLifecycle routes 'skipped' → skipTask and 'cancelled' is handled here.
          const result =
            lifecycle === 'cancelled'
              ? taskEngine.cancelTask(data.taskId)
              : taskEngine.setTaskLifecycle(data.taskId, lifecycle, {
                  result: typeof data.result === 'string' ? data.result : undefined,
                  error: typeof data.error === 'string' ? data.error : undefined,
                });
          if (!result.ok) {
            this.postCommandError(result.reason, data.taskId);
          } else {
            // Clear any RFD form/url prompts tied to this task's live session.
            const live = Object.values(taskStore?.getFile().turns ?? {}).find(
              (t) =>
                t.taskId === data.taskId &&
                (t.status === 'running' || t.status === 'waiting_user' || t.status === 'cancelled'),
            );
            const sessionId = live?.observedSessionId;
            if (sessionId) elicitationBridge?.cancelForSession(sessionId);
            this.postSnapshot(this.focusedTaskId ?? data.taskId);
          }
          break;
        }
        case 'submitAsk':
          if (
            typeof data.taskId === 'string' &&
            typeof data.turnId === 'string' &&
            typeof data.askId === 'string' &&
            isValidAskAnswers(data.answers)
          ) {
            const turn = taskStore?.getFile().turns[data.turnId];
            if (!turn || turn.taskId !== data.taskId) {
              const message = 'turn does not belong to task';
              this.postCommandError(message, data.taskId);
              this.post({
                type: 'askSubmissionResult',
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                ok: false,
                message,
              });
              break;
            }
            const result = taskEngine?.submitAskAnswer(
              { taskId: data.taskId, turnId: data.turnId, askId: data.askId },
              data.answers,
            );
            if (!result || !result.ok) {
              const message = result?.reason ?? 'task engine unavailable';
              debugElicitation('host.ask_submit_rejected', {
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                message,
              });
              this.postCommandError(message, data.taskId);
              this.post({
                type: 'askSubmissionResult',
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                ok: false,
                message,
              });
            } else {
              debugElicitation('host.ask_submit_accepted', {
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
              });
              this.post({
                type: 'askSubmissionResult',
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                ok: true,
              });
            }
          } else {
            const message = 'invalid ask answer payload';
            this.postCommandError(message);
            if (
              typeof data.taskId === 'string' &&
              typeof data.turnId === 'string' &&
              typeof data.askId === 'string'
            ) {
              this.post({
                type: 'askSubmissionResult',
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                ok: false,
                message,
              });
            }
          }
          break;
        case 'submitElicitation': {
          if (typeof data.promptId !== 'string' || typeof data.action !== 'string') {
            const message = 'invalid elicitation submission';
            this.postCommandError(message);
            if (typeof data.promptId === 'string') {
              this.post({
                type: 'elicitationSubmissionResult',
                promptId: data.promptId,
                ok: false,
                message,
              });
            }
            break;
          }
          const action = data.action as 'accept' | 'decline' | 'cancel';
          if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
            const message = 'invalid elicitation action';
            this.postCommandError(message);
            this.post({
              type: 'elicitationSubmissionResult',
              promptId: data.promptId,
              ok: false,
              message,
            });
            break;
          }
          let content =
            data.content && typeof data.content === 'object' && !Array.isArray(data.content)
              ? (data.content as Record<string, unknown>)
              : undefined;
          // Host-side form validation before accept (keep card open on failure).
          if (action === 'accept' && elicitationBridge) {
            const form = elicitationBridge.peekForm(data.promptId);
            if (form) {
              const { validateFormValues } = await import('./backends/elicitation');
              const check = validateFormValues(form, content ?? {});
              if (!check.ok) {
                debugElicitation('host.elicitation_validation_rejected', {
                  promptId: data.promptId,
                  message: check.message,
                });
                this.postCommandError(check.message);
                this.post({
                  type: 'elicitationSubmissionResult',
                  promptId: data.promptId,
                  ok: false,
                  message: check.message,
                });
                break;
              }
            }
          }
          if (!elicitationBridge?.submit(data.promptId, { action, content })) {
            const message = 'no matching pending elicitation';
            debugElicitation('host.elicitation_submit_rejected', {
              promptId: data.promptId,
              action,
              message,
            });
            this.postCommandError(message);
            this.post({
              type: 'elicitationSubmissionResult',
              promptId: data.promptId,
              ok: false,
              message,
            });
            break;
          }
          debugElicitation('host.elicitation_submit_accepted', {
            promptId: data.promptId,
            action,
            contentKeys: content ? Object.keys(content) : [],
          });
          this.post({ type: 'elicitationSubmissionResult', promptId: data.promptId, ok: true });
          // URL consent accept → open external after user confirmed.
          if (action === 'accept') {
            const waiting = elicitationBridge.listOob().find((e) => e.promptId === data.promptId);
            if (waiting?.url) {
              try {
                await vscode.env.openExternal(vscode.Uri.parse(waiting.url));
              } catch {
                // best-effort open
              }
            }
          }
          break;
        }
        case 'cancelAsk':
          if (
            typeof data.taskId === 'string' &&
            typeof data.turnId === 'string' &&
            typeof data.askId === 'string'
          ) {
            const result = taskEngine?.cancelAskTurn({
              taskId: data.taskId,
              turnId: data.turnId,
              askId: data.askId,
            });
            if (!result || !result.ok) {
              const message = result?.reason ?? 'task engine unavailable';
              this.postCommandError(message, data.taskId);
              this.post({
                type: 'askSubmissionResult',
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                ok: false,
                message,
              });
            } else {
              this.post({
                type: 'askSubmissionResult',
                taskId: data.taskId,
                turnId: data.turnId,
                askId: data.askId,
                ok: true,
              });
            }
          }
          break;
        case 'submitPermission': {
          if (
            typeof data.permissionId !== 'string' ||
            typeof data.optionId !== 'string' ||
            typeof data.remember !== 'boolean' ||
            data.permissionId.length === 0 ||
            data.permissionId.length > MAX_ID_CHARS ||
            data.optionId.length === 0 ||
            data.optionId.length > MAX_ID_CHARS
          ) {
            this.postCommandError('invalid permission submission');
            break;
          }
          // The id must be a currently-pending prompt, and the optionId must be
          // one the agent actually offered for it — never trust an arbitrary id.
          const pending = permissionBridge?.peek(data.permissionId);
          if (!pending) {
            this.postCommandError('no such pending permission');
            break;
          }
          if (!pending.options.some((o) => o.optionId === data.optionId)) {
            this.postCommandError('permission option not offered');
            break;
          }
          permissionBridge?.submit(data.permissionId, {
            optionId: data.optionId,
            remember: data.remember,
          });
          break;
        }
        case 'cancelPermission': {
          if (typeof data.permissionId !== 'string' || data.permissionId.length > MAX_ID_CHARS) {
            break;
          }
          permissionBridge?.cancel(data.permissionId);
          break;
        }
        case 'pickFile':
          await this.handlePickFile();
          break;
        case 'browseWorkspaceFiles':
          await this.handleBrowseWorkspaceFiles();
          break;
        case 'resolveFileDrop':
          await this.handleResolveFileDrop(data.candidates);
          break;
        case 'importDroppedFile':
          this.handleImportDroppedFile(data.name, data.data);
          break;
        case 'openLink':
          this.handleOpenLink(data.url);
          break;
        case 'clearHistory':
          this.handleClearHistory();
          break;
        case 'deleteTask':
          if (typeof data.taskId === 'string') {
            this.handleDeleteTask(data.taskId);
          }
          break;
        case 'renameTask':
          if (typeof data.taskId === 'string' && typeof data.goal === 'string') {
            this.handleRenameTask(data.taskId, data.goal);
          }
          break;
        case 'exportTask':
          await this.handleExportTask(data);
          break;
        case 'blurTask':
          // Webview returned to the task list; drop the host-side focus so a
          // later snapshot (e.g. after Clear history) doesn't re-open a stale chat.
          this.focusedTaskId = undefined;
          break;
        case 'requestSettings':
          this.postSettingsSnapshot();
          break;
        case 'updateSetting':
          await this.handleUpdateSetting(data);
          break;
        case 'listBackends':
          void this.postAvailableBackends();
          break;
        case 'listModels':
          void this.postAvailableModels();
          break;
        case 'setComposerSelection':
          this.handleSetComposerSelection(data);
          break;
        default:
          // Unknown inbound type: log instead of silently ignoring. This surfaces
          // host<->webview protocol drift (e.g. a newer webview sending a message
          // type this host build predates) rather than dropping it without a trace.
          console.warn(`Muster: ignoring unknown webview message type ${String(data?.type)}`);
      }
    });

    // Do not auto-focus on open — entry UI shows previous tasks list (per redesign)
    // User selects from list or New task to enter chat.
    this.postSnapshot(this.focusedTaskId);
    // Tell the webview which backends are actually installed so its picker only
    // offers callable ones (the webview also requests this on mount).
    void this.postAvailableBackends();
    // Prefetch model catalog so New task can show [Backend] Model options promptly.
    void this.postAvailableModels();
    // Restore last-used backend/model from globalState (survives full restarts).
    // Posted after availability so the webview can re-apply preference once the
    // picker list is known; applyHostComposerSelection does not require it.
    this.postComposerSelection();
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

/**
 * Resolve the workspace directory a new task's agent should run in. Multi-root
 * aware via {@link resolveWorkspaceCwd}: the folder holding the active editor
 * file wins, else the first workspace folder. Falls back to process.cwd() when
 * no folder is open (matching every ACP adapter's own fallback).
 */
function resolveTaskCwd(): string {
  const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  return resolveWorkspaceCwd(folders, activeFile) ?? process.cwd();
}

export async function activate(context: vscode.ExtensionContext) {
  // Patch PATH from the login shell BEFORE anything spawns a backend CLI, so a
  // GUI-launched editor (minimal PATH) can both detect and actually run the CLIs.
  await installAugmentedPath();

  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  workspaceRoot = wsFolder?.uri.fsPath;
  storePath = wsFolder
    ? path.join(wsFolder.uri.fsPath, '.muster-tasks.json')
    : path.join(context.globalStorageUri.fsPath, '.muster-tasks.json');

  // Ensure the store's parent directory exists before any store/lock IO. Without
  // a workspace folder the path falls back to globalStorage, which VS Code does not
  // create eagerly — otherwise lock creation fails with ENOENT and surfaces as the
  // misleading "could not acquire store lock".
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  runSessionMigration(context, workspaceRoot);

  const provider = new MusterChatProvider(context.extensionUri, context.globalState);
  const revealLinkedChat = async (ownerTaskId: string): Promise<boolean> => {
    if (!taskStore) return false;
    const reveal = createPresentationChatLink(
      taskStore,
      { executeCommand: (command) => vscode.commands.executeCommand(command) },
      provider,
    );
    return (await reveal(ownerTaskId)).ok;
  };
  presentationManager = new PresentationManager(
    createPresentationPanelFactory(presentationHost, context.extensionUri, revealLinkedChat),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(
      'muster.presentation',
      createPresentationPanelSerializer(presentationHost, context.extensionUri, presentationManager, revealLinkedChat),
    ),
  );
  context.subscriptions.push({
    dispose: () => {
      presentationManager?.dispose();
      presentationManager = undefined;
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MusterChatProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muster.openChat', () =>
      vscode.commands.executeCommand('workbench.view.extension.muster'),
    ),
  );

  try {
    elicitationDebugChannel = vscode.window.createOutputChannel('Muster Elicitation Debug');
    context.subscriptions.push(elicitationDebugChannel);
    setAcpDebugLogger((event, details) => debugElicitation(`acp.${event}`, details));
    debugElicitation('debug.enabled', { protocolVersion: PROTOCOL_VERSION });

    askBridge = new AskBridge({
      onRegister: (ref, questions) => {
        debugElicitation('host.ask_registered', {
          taskId: ref.taskId,
          turnId: ref.turnId,
          askId: ref.askId,
          questionCount: questions.length,
          webviewReady: !!provider['_view'],
        });
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

    // Permission approval gate: prompts route to a webview card; the audit log
    // records every allow/deny decision.
    permissionAuditChannel = vscode.window.createOutputChannel('Muster Permissions');
    context.subscriptions.push(permissionAuditChannel);
    permissionBridge = new PermissionBridge({
      onRegister: (permissionId, request: PermissionRequest) => {
        provider['_view']?.webview.postMessage({
          type: 'permissionPending',
          sessionId: request.sessionId,
          permissionId,
          title: request.title,
          kind: request.kind,
          classification: request.classification,
          options: request.options.map((o) => ({
            optionId: o.optionId,
            name: o.name ?? o.optionId,
            kind: o.kind,
          })),
        });
      },
      onResolve: (permissionId) => {
        provider['_view']?.webview.postMessage({ type: 'permissionCleared', permissionId });
      },
    });
    const bridge = permissionBridge;
    const auditChannel = permissionAuditChannel;
    const permissionController: PermissionController = {
      // Read live each call — AcpClient is a shared singleton constructed once,
      // so the mode must NOT be frozen at first connect.
      mode: () => getPermissionMode(),
      isAllowlisted: (sessionId, key) => bridge.isAllowlisted(sessionId, key),
      remember: (sessionId, key) => bridge.remember(sessionId, key),
      audit: (entry: PermissionAuditEntry) => {
        bridge.recordAudit(entry);
        auditChannel.appendLine(
          `${entry.at} ${entry.decision.toUpperCase()} [${entry.source}] ` +
            `session=${entry.sessionId} class=${entry.classification} ` +
            `kind=${entry.kind} title=${JSON.stringify(entry.title)}`,
        );
      },
      prompt: (req) =>
        bridge.register(
          bridge.generatePermissionId(),
          {
            sessionId: req.sessionId,
            title: req.title,
            kind: req.kind,
            classification: req.classification,
            options: req.options,
          },
          PERMISSION_PROMPT_TIMEOUT_MS,
        ),
    };
    setPermissionController(permissionController);

    // Grok vendor ask_user_question → AskBridge + askPending (separate from RFD).
    const questionController: QuestionController = {
      prompt: async (req) => {
        debugElicitation('host.grok_prompt_start', {
          sessionId: req.sessionId,
          questionCount: req.questions.length,
        });
        const engine = taskEngine;
        if (!engine) {
          debugElicitation('host.grok_prompt_cancelled', { reason: 'task engine unavailable' });
          return { outcome: 'cancelled' };
        }
        const registered = engine.registerAgentAsk(req.sessionId, req.questions, 120_000);
        if (!registered.ok) {
          debugElicitation('host.grok_prompt_cancelled', { reason: registered.reason });
          return { outcome: 'cancelled' };
        }
        debugElicitation('host.grok_prompt_waiting', registered.ref);
        try {
          const answers = await registered.promise;
          debugElicitation('host.grok_prompt_resolved', {
            ...registered.ref,
            answeredIndexes: Object.keys(answers),
          });
          return { outcome: 'accepted', answers };
        } catch (error) {
          debugElicitation('host.grok_prompt_cancelled', {
            ...registered.ref,
            reason: error instanceof Error ? error.message : String(error),
          });
          return { outcome: 'cancelled' };
        }
      },
    };
    setQuestionController(questionController);

    // RFD elicitation (form + url) — single owner ElicitationBridge.
    elicitationBridge = new ElicitationBridge({
      onRegister: (kind, prompt) => {
        debugElicitation('host.elicitation_registered', {
          kind,
          promptId: prompt.promptId,
          sessionId: prompt.sessionId,
          webviewReady: !!provider['_view'],
          fieldKeys: 'fields' in prompt ? prompt.fields.map((field) => field.key) : undefined,
        });
        if (kind === 'form') {
          const form = prompt as import('./bridge/elicitation-bridge').PendingFormPrompt;
          provider['_view']?.webview.postMessage({
            type: 'elicitationFormPending',
            promptId: form.promptId,
            sessionId: form.sessionId,
            toolCallId: form.toolCallId,
            message: form.message,
            fields: form.fields,
            required: form.required,
            askLike: form.askLike,
          });
          return;
        }
        const url = prompt as import('./bridge/elicitation-bridge').PendingUrlConsent;
        provider['_view']?.webview.postMessage({
          type: 'elicitationUrlPending',
          promptId: url.promptId,
          elicitationId: url.elicitationId,
          sessionId: url.sessionId,
          url: url.url,
          message: url.message,
        });
      },
      onWaiting: (entry) => {
        provider['_view']?.webview.postMessage({
          type: 'elicitationUrlWaiting',
          promptId: entry.promptId,
          elicitationId: entry.elicitationId,
          message: entry.message,
        });
      },
      onClear: (promptId) => {
        debugElicitation('host.elicitation_cleared', { promptId });
        provider['_view']?.webview.postMessage({ type: 'elicitationCleared', promptId });
      },
    });
    const eBridge = elicitationBridge;
    const elicitationController: ElicitationController = {
      clientKey: 'muster-acp',
      promptForm: async (form, clientKey) => {
        const key = clientKey || 'muster-acp';
        const askLike = isAskLikeForm(form);
        const { promptId, promise } = eBridge.registerForm(key, form, askLike, 120_000);
        debugElicitation('host.elicitation_waiting', {
          promptId,
          clientKey: key,
          sessionId: form.sessionId,
          askLike,
        });
        let waitTurnId: string | undefined;
        if (form.sessionId && taskEngine) {
          waitTurnId = taskEngine.beginElicitationWait(form.sessionId, promptId)?.turnId;
        }
        try {
          const result = await promise;
          debugElicitation('host.elicitation_resolved', {
            promptId,
            action: result.action,
            contentKeys: result.content ? Object.keys(result.content) : [],
          });
          // Soft resume only if engine still owns this wait (hard clear drops tokens first).
          if (waitTurnId && taskEngine) {
            taskEngine.endElicitationWait(waitTurnId, promptId);
          }
          return result;
        } catch {
          if (waitTurnId && taskEngine) {
            taskEngine.endElicitationWait(waitTurnId, promptId);
          }
          return { action: 'cancel' as const };
        }
      },
      promptUrl: async (urlReq, clientKey) => {
        const key = clientKey || 'muster-acp';
        const { promise } = eBridge.registerUrl(key, urlReq, 120_000);
        try {
          return await promise;
        } catch {
          return { action: 'cancel' as const };
        }
      },
      onUrlComplete: (clientKey, elicitationId) => {
        eBridge.complete(clientKey, elicitationId);
      },
    };
    setElicitationController(elicitationController);

    credentialRegistry = new CredentialRegistry();
    const engineToolHandler = {
      handleToolCall: async (
        ctx: import('./bridge/credentials').CredentialContext,
        tool: string,
        command: import('./task/coordinator-tools').ToolCommand,
      ) => {
        if (!taskEngine) {
          return { ok: false as const, error: 'task engine not ready' };
        }
        return taskEngine.handleToolCall(ctx, tool, command);
      },
    };
    bridgeServer = new MusterBridgeServer({
      credentials: credentialRegistry,
      toolHandler: new PresentationToolRouter(engineToolHandler, presentationManager),
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

    if (taskStore.isCorrupt()) {
      // The store could not be read (corrupt or written by a newer version). It is
      // preserved and never overwritten; run in recovery mode instead of bricking.
      const info = taskStore.getRecoveryInfo();
      void vscode.window.showWarningMessage(
        `Muster: the task store could not be read. Your data is preserved at ${
          info?.backupPath ?? 'a .corrupt backup'
        }. Muster is in recovery mode and will not overwrite it — remove or repair the file to resume.`,
      );
    }

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
        elicitationBridge?.cancelAll();
        setPermissionController(null);
        setQuestionController(null);
        setElicitationController(null);
        setAcpDebugLogger(null);
        permissionBridge?.cancelAll();
        credentialRegistry?.revokeAll();
      },
    });
  } catch (error) {
    void bridgeServer?.close();
    askBridge?.cancelAll('init failed');
    elicitationBridge?.cancelAll();
    setPermissionController(null);
    setQuestionController(null);
    setElicitationController(null);
    setAcpDebugLogger(null);
    permissionBridge?.cancelAll();
    credentialRegistry?.revokeAll();
    bridgeServer = undefined;
    askBridge = undefined;
    elicitationBridge = undefined;
    permissionBridge = undefined;
    credentialRegistry = undefined;
    taskEngine = undefined;
    taskStore = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Muster task engine disabled: ${message}`);
  }
}

export function deactivate() {
  presentationManager?.dispose();
  presentationManager = undefined;
  askBridge?.cancelAll('deactivate');
  elicitationBridge?.cancelAll();
  setPermissionController(null);
  setQuestionController(null);
  setElicitationController(null);
  setAcpDebugLogger(null);
  permissionBridge?.cancelAll();
  credentialRegistry?.revokeAll();
  void bridgeServer?.close();
  disposeSharedAcpClient();
}
