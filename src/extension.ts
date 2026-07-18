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
  peekSharedAcpClient,
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
import { SKILL_TRIGGER_PREFIX, skillPrefixForBackend } from './backends/skill-prefix';
import { discoverSkillNames } from './host/skill-discovery';
import { ElicitationBridge } from './bridge/elicitation-bridge';
import type { PermissionAuditEntry, PermissionMode } from './backends/permission-policy';
import {
  type PendingAskOverlay,
  type TranscriptItem,
} from './host/snapshot';
import { buildRepositorySnapshot } from './host/repository-snapshot';
import {
  buildWorkspacePatchBatch,
  localCommitNeedsTranscriptRecovery,
  projectWorkspacePatches,
} from './host/workspace-patch';
import { WorkspaceRevisionPoller } from './host/workspace-revision-poller';
import {
  reconcileExternalWorkspaceChanges,
  reconcileInterleavedLocalCommit,
} from './host/external-workspace-reconciler';
import {
  UAT_COMMANDS,
  appendMessage,
  createTaskWithMessage,
  deleteMessage,
  enqueueFollowUp,
  isUatModeEnabled,
  markSendOutboxRejected,
  promoteFollowUp,
  putPresentation,
  putSendOutbox,
  readDurableSurfaces,
  readRedactedDbIdentity,
  type UatHostState,
} from './host/uat-commands';
import type { RepositoryCommitContext } from './task/repository-projection';
import {
  buildRetentionSettingsSnapshot,
  handleRetentionSettingUpdateAction,
  type RuntimeStorageSettingsSnapshot,
  type RuntimeStorageSettingId,
} from './host/retention-settings';
import {
  TASK_TYPES_CONFIG_KEY,
  TASK_TYPES_CONFIG_SECTION,
  buildTaskTypesSettingsSnapshot,
  handleTaskTypesSettingsUpdateAction,
  loadTaskTypeRegistry,
  pickExplicitTaskTypesValue,
} from './host/task-types-config';
import {
  buildPermissionSettingsSnapshot,
  handlePermissionSettingsUpdateAction,
} from './host/permission-settings';
import { detectAvailableBackends, installAugmentedPath } from './host/backend-availability';
import {
  parseComposerSelection,
  readComposerSelection,
  writeComposerSelection,
} from './host/composer-selection';
import { pickWorkspaceFileMentionPath } from './host/workspace-files';
import { resolveDroppedFileMention } from './host/file-mentions';
import { parseHostSendRequest, type HostSendRequest } from './host/send-request';
import {
  isFileMentionDirectorySymlink,
  listFileMentionSuggestions,
  type FileMentionSuggestionsRequest,
} from './host/file-mention-suggestions';
import {
  routeDeleteQueuedTurn,
  routeEditQueuedTurn,
} from './host/queued-turn-mutations';
import { routeExportTask } from './host/task-export-route';
import { routeRuntimeHandoff } from './host/runtime-handoff-route';
import { routeLoadTranscriptPage } from './host/transcript-page-route';
import { importDroppedFileBytes } from './host/import-dropped-file';
import { PresentationManager } from './host/presentation-manager';
import {
  createPresentationPanelFactory,
  createPresentationPanelSerializer,
  type PresentationHost,
} from './host/presentation-panel-adapter';
import { PresentationToolRouter } from './host/presentation-tool-router';
import { createPresentationChatLink } from './host/presentation-chat-link';
import {
  clampPresentationMarkdown,
  isCanonicalInsideRoot,
  presentationIdFromFolderAndRelativePath,
  resolveUnderSource,
  resolveWorkspaceMarkdownPath,
  splitMarkdownHref,
  titleFromMarkdownPath,
} from './host/markdown-file-presentation';
import { enumerateModels, type BackendModels } from './backends/model-catalog';
import { type RetentionConfig } from './task/retention';
import { TaskEngine, type EngineEvent } from './task/engine';
import type { HostEnvironmentSnapshot } from './task/host-context';
import type { TaskReadPort } from './task/store-port';
import { SqliteTaskRepository, type TaskRepository } from './task/repository';
import { DbClient, resolveWorkerPath } from './task/sqlite/client';
import { probeNodeSqlite } from './task/sqlite/probe';
import type { SqliteErrorCode } from './task/sqlite/errors';
import {
  diagnoseSqliteError,
  redactedDiagnosticLogFields,
  recoveryGuidanceFor,
} from './task/sqlite/diagnostics';
import { applyTerminalStorageQuiesce } from './host/terminal-storage-coordinator';
import { createTerminalStorageLifecycle } from './host/terminal-storage-lifecycle';


/** Activation fail-closed error: safe message only, no path/SQL/content. */
class MusterSqliteActivationError extends Error {
  constructor(
    readonly code: SqliteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MusterSqliteActivationError';
  }
}
import { WorkspaceRegistry } from './task/sqlite/workspace-registry';
import { resolveWorkspaceIdentity, type WorkspaceContext } from './task/sqlite/workspace-identity';
import { isTerminalLifecycle } from './task/transitions';
import { resolveWorkspaceCwd } from './task/workspace-cwd';
import type { TaskStoreFile } from './task/types';
import { runLimitMs } from './task/execution-policy';
import { USER_INTERACTION_TIMEOUT_MS } from './host/interaction-timeouts';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let askBridge: AskBridge | undefined;
let elicitationBridge: ElicitationBridge | undefined;
let permissionBridge: PermissionBridge | undefined;
let permissionAuditChannel: vscode.OutputChannel | undefined;
let elicitationDebugChannel: vscode.OutputChannel | undefined;
/** Visible Output channel for picker/handoff diagnostics (View → Output → Muster Debug). */
let musterDebugChannel: vscode.OutputChannel | undefined;
let credentialRegistry: CredentialRegistry | undefined;
let bridgeServer: MusterBridgeServer | undefined;
let taskEngine: TaskEngine | undefined;
let taskStore: TaskReadPort | undefined;
let taskRepository: TaskRepository | undefined;
let workspaceRoot: string | undefined;
/** SQLite is the only task storage source. */
let sqliteClient: DbClient | undefined;
let sqliteWorkspaceId: string | undefined;
/** Production chat provider (always tracked; UAT may also alias it). */
let chatProvider: MusterChatProvider | undefined;
/** Live UAT host surface (non-production Extension Host + MUSTER_UAT_MODE=1). */
let uatChatProvider: MusterChatProvider | undefined;

/** Shared host-env cache for first-turn inject + get_host_context (W1). */
let hostEnvCache: HostEnvironmentSnapshot | undefined;
let hostEnvPrepare: Promise<void> | undefined;

function writeHostEnvCache(partial: {
  availableBackends?: string[];
  models?: Record<string, BackendModels>;
}): void {
  const cwd = resolveTaskCwd();
  const trusted = vscode.workspace.isTrusted;
  hostEnvCache = {
    cwd,
    trusted,
    availableBackends: partial.availableBackends ?? hostEnvCache?.availableBackends ?? [],
    models: partial.models
      ? Object.fromEntries(
          Object.entries(partial.models).map(([k, v]) => [
            k,
            {
              ...(v.current !== undefined ? { current: v.current } : {}),
              options: v.options.map((o) => ({ value: o.value, name: o.name })),
            },
          ]),
        )
      : (hostEnvCache?.models ?? {}),
  };
}

async function prepareHostEnvironment(): Promise<void> {
  if (!hostEnvPrepare) {
    hostEnvPrepare = (async () => {
      try {
        const backends = await detectAvailableBackends();
        writeHostEnvCache({ availableBackends: backends });
        const models = await enumerateModels(backends, resolveTaskCwd());
        writeHostEnvCache({ availableBackends: backends, models });
      } catch {
        // leave cache partial/empty; engine synthesizes minimal
      }
    })();
  }
  await hostEnvPrepare;
}

function getHostEnvironment(): HostEnvironmentSnapshot | undefined {
  if (!hostEnvCache) return undefined;
  return {
    ...hostEnvCache,
    trusted: vscode.workspace.isTrusted,
  };
}

/**
 * Unmerged raw muster.taskTypes for a folder (or workspace).
 * Uses inspect() so workspace `{}` overrides package defaults (get() merges objects).
 */
function readExplicitTaskTypesRaw(cwd?: string): unknown {
  const resource =
    typeof cwd === 'string' && cwd.length > 0 ? vscode.Uri.file(cwd) : undefined;
  const cfg = vscode.workspace.getConfiguration(TASK_TYPES_CONFIG_SECTION, resource);
  const inspected = cfg.inspect(TASK_TYPES_CONFIG_KEY);
  if (!inspected) return undefined;
  return pickExplicitTaskTypesValue(inspected);
}

/** Live resource-scoped muster.taskTypes for caller cwd (or workspace default). */
function getTaskTypeRegistry(cwd?: string) {
  return loadTaskTypeRegistry((folderCwd) => readExplicitTaskTypesRaw(folderCwd), cwd);
}
let presentationManager: PresentationManager | undefined;
const activePendingAsks = new Map<string, PendingAskOverlay>();

function ensureMusterDebugChannel(): vscode.OutputChannel {
  if (!musterDebugChannel) {
    musterDebugChannel = vscode.window.createOutputChannel('Muster Debug');
  }
  return musterDebugChannel;
}

function debugMuster(event: string, details: Record<string, unknown> = {}): void {
  try {
    const channel = ensureMusterDebugChannel();
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${event} ${JSON.stringify(details)}`;
    channel.appendLine(line);
    console.info(line);
  } catch {
    // best-effort
  }
}

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
const PROTOCOL_VERSION = 9;

/** How long a permission prompt waits for a webview decision before safe-denying. */
const PERMISSION_PROMPT_TIMEOUT_MS = USER_INTERACTION_TIMEOUT_MS;
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

function readRetentionSettingsSnapshot(): RuntimeStorageSettingsSnapshot {
  return buildRetentionSettingsSnapshot((key) => runtimeStorageConfiguration().get(key));
}

function explicitConfigurationValue<T>(
  inspected: ReturnType<vscode.WorkspaceConfiguration['inspect']> | undefined,
): T | undefined {
  return inspected?.workspaceFolderValue as T | undefined ??
    inspected?.workspaceValue as T | undefined ??
    inspected?.globalValue as T | undefined;
}

function readRetainedTurnsValue(): unknown {
  const config = vscode.workspace.getConfiguration('muster.retention');
  return explicitConfigurationValue<number>(config.inspect('maxRetainedTurnsPerTask')) ??
    config.get('maxRetainedTurnsPerTask');
}

function runtimeStorageConfiguration() {
  return {
    get(key: RuntimeStorageSettingId): unknown {
      if (key === 'runLimit') {
        return vscode.workspace.getConfiguration('muster.execution').get('runLimit');
      }
      if (key === 'maxRetainedTurnsPerTask') return readRetainedTurnsValue();
      return vscode.workspace.getConfiguration('muster.retention').get('maxStoredOutputChars');
    },
    async update(key: RuntimeStorageSettingId, value: number | string, target: unknown): Promise<void> {
      const configuration = key === 'runLimit'
        ? vscode.workspace.getConfiguration('muster.execution')
        : vscode.workspace.getConfiguration('muster.retention');
      await configuration.update(key, value, target as vscode.ConfigurationTarget);
    },
  };
}

function getRetentionConfig(): RetentionConfig {
  const snapshot = readRetentionSettingsSnapshot();
  return {
    maxTurnsPerTask:
      Number(snapshot.settings.find((setting) => setting.id === 'maxRetainedTurnsPerTask')?.value ?? 200),
    maxStoredOutputChars:
      Number(snapshot.settings.find((setting) => setting.id === 'maxStoredOutputChars')?.value ?? 200_000),
  };
}

let retentionInFlight: Promise<void> | undefined;

function repositoryWorkspaceId(): string {
  if (!sqliteWorkspaceId) {
    throw new Error('SQLite workspace is not ready');
  }
  return sqliteWorkspaceId;
}

/** Apply retention through named repository commands; never rewrite the host envelope. */
async function applyRetentionToRepository(repository: TaskRepository): Promise<void> {
  const config = getRetentionConfig();
  const tasks = await repository.listTasks(repositoryWorkspaceId());
  for (const task of tasks) {
    await repository.execute({
      kind: 'applyRetentionPolicy',
      workspaceId: repositoryWorkspaceId(),
      taskId: task.id,
      keepLatestTurns: config.maxTurnsPerTask,
      maxStoredOutputChars: config.maxStoredOutputChars,
    });
  }
}

function scheduleRetention(): void {
  const repository = taskRepository;
  if (!repository || retentionInFlight) return;
  retentionInFlight = applyRetentionToRepository(repository)
    .catch(() => {
      // Retention is maintenance; a failed pass must not interrupt a user turn.
    })
    .finally(() => {
      retentionInFlight = undefined;
    });
}

class MusterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'muster.chat';
  private _view?: vscode.WebviewView;
  /** In-flight/cached detection of which backend CLIs are callable (computed once). */
  private availableBackendsPromise?: Promise<string[]>;
  /** In-flight/cached per-backend model enumeration (computed once). */
  private availableModelsPromise?: Promise<Record<string, BackendModels>>;
  /** Discards stale async repository snapshots when focus/commits race. */
  private snapshotGeneration = 0;
  focusedTaskId?: string;
  /**
   * Host mirror of focused transcript entity IDs (bootstrap page + older pages +
   * published patches). Used to choose transcriptItemsAppended vs transcriptItemPatched.
   */
  private knownTranscriptIds = new Set<string>();
  /**
   * Highest workspace revision this host has published (local patches) or
   * recovered to (snapshot). Poller never re-applies at or below this cursor.
   */
  private appliedWorkspaceRevision = 0;
  private revisionPoller: WorkspaceRevisionPoller | undefined;
  private windowFocused = true;
  /** Headless live-UAT override; never enabled in production Extension Hosts. */
  private uatFocusGateOverridden = false;
  /** Count of external-feed gap/delete recoveries, exposed only by the UAT gate. */
  private externalRecoveryCount = 0;
  /** Polling starts only after the current view/focus has an authoritative snapshot. */
  private pollingReady = false;
  private windowStateSub: vscode.Disposable | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
  ) {}

  private post(message: unknown): void {
    try {
      this._view?.webview.postMessage(message);
    } catch {
      // best-effort
    }
  }

  /**
   * Central post-commit publisher: one workspacePatchBatch per changed revision
   * after SQLite commit + projection refresh. Empty patches still advance revision.
   */
  async publishAfterCommit(ctx: RepositoryCommitContext): Promise<void> {
    const after = ctx.projection.getFile();
    if (!this._view?.visible || !this.pollingReady) {
      // This revision is durable but was not published. Do not advance the wire
      // cursor: visibility/focus hydration must successfully deliver an
      // authoritative bounded snapshot before the UI is considered caught up.
      return;
    }
    const trackPatches = (patches: ReturnType<typeof projectWorkspacePatches>): void => {
      for (const patch of patches) {
        if (patch.type === 'transcriptItemsAppended') {
          for (const item of patch.items) this.knownTranscriptIds.add(item.id);
        } else if (patch.type === 'transcriptItemPatched') {
          this.knownTranscriptIds.add(patch.item.id);
        } else if (patch.type === 'transcriptItemsRemoved') {
          for (const itemId of patch.itemIds) this.knownTranscriptIds.delete(itemId);
        } else if (patch.type === 'taskRemoved' && patch.taskId === this.focusedTaskId) {
          this.knownTranscriptIds.clear();
        }
      }
    };

    // A peer can commit immediately before this local transaction. The local
    // bounded refresh then observes the final workspace revision while touching
    // only its own aggregate. Drain the missing feed range before publishing so
    // the projection/cursor cannot skip the peer task forever.
    const interleavedResult = taskRepository
      ? await reconcileInterleavedLocalCommit({
        repository: taskRepository,
        projection: ctx.projection,
        afterRevision: ctx.previousRevision,
        previousRevision: ctx.previousRevision,
        focusedTaskId: this.focusedTaskId,
        knownTranscriptIds: this.knownTranscriptIds,
        beforeProjection: ctx.beforeFile,
      })
      : undefined;
    if (interleavedResult) {
      if (interleavedResult.kind === 'batches') {
        for (const batch of interleavedResult.batches) {
          if (batch.revision <= this.appliedWorkspaceRevision) continue;
          trackPatches(batch.patches);
          this.post(batch);
          this.appliedWorkspaceRevision = batch.revision;
        }
      } else {
        this.externalRecoveryCount += 1;
        await this.postSnapshotAsync(this.focusedTaskId);
      }
    } else if (localCommitNeedsTranscriptRecovery({
      command: ctx.command,
      result: ctx.result,
      focusedTaskId: this.focusedTaskId,
      knownTranscriptIds: this.knownTranscriptIds,
    })) {
      await this.postSnapshotAsync(this.focusedTaskId);
    } else {
      const patches = projectWorkspacePatches({
        command: ctx.command,
        result: ctx.result,
        before: ctx.beforeFile as TaskStoreFile,
        after,
        focusedTaskId: this.focusedTaskId,
        knownTranscriptIds: this.knownTranscriptIds,
      });
      trackPatches(patches);
      this.post(buildWorkspacePatchBatch(after.revision, patches));
      if (after.revision > this.appliedWorkspaceRevision) {
        this.appliedWorkspaceRevision = after.revision;
      }
    }

    // Ask-clear side channel when a waiting_user turn leaves that state.
    const previous = ctx.beforeFile;
    for (const turnId of Object.keys(after.turns)) {
      const prevTurn = previous.turns[turnId];
      const nextTurn = after.turns[turnId];
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
      runtimeStorageConfiguration(),
      data,
      vscode.ConfigurationTarget.Workspace,
    );
    for (const message of messages) {
      this.post(message);
    }
  }

  private readTaskTypesRaw(): unknown {
    return readExplicitTaskTypesRaw();
  }

  private postTaskTypesSettingsSnapshot(): void {
    try {
      this.post({
        type: 'taskTypesSettingsSnapshot',
        snapshot: buildTaskTypesSettingsSnapshot(() => this.readTaskTypesRaw()),
      });
    } catch {
      this.post({
        type: 'taskTypesSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to load task type settings.',
        },
      });
    }
  }

  private async handleUpdateTaskTypes(data: unknown): Promise<void> {
    const payload =
      typeof data === 'object' && data !== null && 'types' in data
        ? { types: (data as { types: unknown }).types }
        : data;
    const messages = await handleTaskTypesSettingsUpdateAction(
      {
        update: (key, value, target) =>
          vscode.workspace
            .getConfiguration(TASK_TYPES_CONFIG_SECTION)
            .update(key, value, target as vscode.ConfigurationTarget),
      },
      payload,
      vscode.ConfigurationTarget.Workspace,
      () => this.readTaskTypesRaw(),
    );
    for (const message of messages) {
      this.post(message);
    }
  }

  private postPermissionSettingsSnapshot(): void {
    try {
      this.post({
        type: 'permissionSettingsSnapshot',
        snapshot: buildPermissionSettingsSnapshot((key) =>
          vscode.workspace.getConfiguration('muster.permissions').get(key),
        ),
      });
    } catch {
      this.post({
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
        },
      });
    }
  }

  private async handleUpdatePermissionSettings(data: unknown): Promise<void> {
    const payload =
      typeof data === 'object' && data !== null && 'mode' in data
        ? { mode: (data as { mode: unknown }).mode }
        : data;
    const messages = await handlePermissionSettingsUpdateAction(
      {
        get: (key) => vscode.workspace.getConfiguration('muster.permissions').get(key),
        update: (key, value, target) =>
          vscode.workspace
            .getConfiguration('muster.permissions')
            .update(key, value, target as vscode.ConfigurationTarget),
      },
      payload,
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
        showQuickPick: (items, options) =>
          vscode.window.showQuickPick(
            items.map((item) => ({
              label: item.label,
              uri: item.uri,
              iconId: item.iconId,
              iconPath: new vscode.ThemeIcon(item.iconId),
            })),
            options,
          ),
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

  /**
   * Current-directory @ autocomplete (M011 S01).
   * Derives cwd from the existing task or draft workspace context — never from
   * a webview-supplied path. Posts a bounded relative-only response keyed by
   * requestId. Diagnostics log request id / scope / code only (no cwd, paths,
   * or file contents).
   */
  private async handleRequestFileMentionSuggestions(data: unknown): Promise<void> {
    const payload =
      data && typeof data === 'object'
        ? (data as {
            requestId?: unknown;
            taskId?: unknown;
            parentDepth?: unknown;
            relativeQuery?: unknown;
          })
        : {};

    const requestId =
      typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
    const taskId =
      typeof payload.taskId === 'string' && payload.taskId.trim().length > 0
        ? payload.taskId.trim()
        : undefined;

    const request: FileMentionSuggestionsRequest = {
      requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
      parentDepth: typeof payload.parentDepth === 'number' ? payload.parentDepth : -1,
      relativeQuery: typeof payload.relativeQuery === 'string' ? payload.relativeQuery : '',
      ...(taskId !== undefined ? { taskId } : {}),
    };

    try {
      const result = await listFileMentionSuggestions(request, {
        resolveCwd: (scope) => {
          if (scope.taskId) {
            const task = taskStore?.getTask(scope.taskId);
            if (task?.cwd && task.cwd.trim().length > 0) {
              return task.cwd;
            }
            // Known task without cwd still falls back to draft workspace cwd.
            // Missing task id is treated the same — host owns the path.
          }
          return resolveTaskCwd();
        },
        readDirectory: async (dirPath) => {
          const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
          return entries;
        },
        // Refuse to follow directory symlinks when refining under a scope so
        // nested relativeQuery segments cannot escape the selected tree.
        isDirectorySymlink: isFileMentionDirectorySymlink,
      });

      if (result.ok) {
        debugMuster('host.file_mention_suggestions', {
          requestId: result.requestId,
          taskId: taskId ?? null,
          parentDepth: result.parentDepth,
          itemCount: result.items.length,
          outcome: 'ok',
        });
        this.post({
          type: 'fileMentionSuggestions',
          ok: true,
          requestId: result.requestId,
          parentDepth: result.parentDepth,
          relativeQuery: result.relativeQuery,
          items: result.items,
        });
        return;
      }

      debugMuster('host.file_mention_suggestions', {
        requestId: result.requestId || requestId || null,
        taskId: taskId ?? null,
        parentDepth: request.parentDepth,
        outcome: 'error',
        code: result.code,
      });
      this.post({
        type: 'fileMentionSuggestions',
        ok: false,
        requestId: result.requestId || requestId || 'invalid',
        code: result.code,
      });
    } catch {
      debugMuster('host.file_mention_suggestions', {
        requestId: requestId || null,
        taskId: taskId ?? null,
        outcome: 'error',
        code: 'listingFailed',
      });
      this.post({
        type: 'fileMentionSuggestions',
        ok: false,
        requestId: requestId || 'invalid',
        code: 'listingFailed',
      });
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
      writeHostEnvCache({ availableBackends: backends });
      this.post({ type: 'backendsAvailable', backends });
    } catch {
      // Detection failed — drop the cached rejection so a later request retries;
      // the webview meanwhile fails open and shows all backends.
      this.availableBackendsPromise = undefined;
    }
  }

  /**
   * Answer a `listSkills` request with the uniform composer trigger prefix and the
   * backend's discovered skills. The trigger prefix is ALWAYS `/`, identical for
   * every backend: the picker UX is normalized to `/` and the host translates to
   * the per-backend wire prefix (`$` for Codex) at injection time — so this is the
   * TRIGGER/display prefix, NOT `skillPrefixForBackend` (the injection prefix).
   * NOT cached: skills are re-discovered on every request (a cheap disk scan);
   * `prefix` is ALWAYS returned so the trigger char works even when `skills` is
   * empty (cold cache → graceful inline-text degrade).
   */
  private postAvailableSkills(backend: string): void {
    if (typeof backend !== 'string' || !backend) return;
    const prefix = SKILL_TRIGGER_PREFIX;
    // Discover skills from disk (.claude/skills, .codex/skills, ...) so the picker
    // works cold and lists only real skills — the ACP advertised set is polluted
    // with built-in slash commands and only populates after a session has run.
    const skills = discoverSkillNames(backend, resolveTaskCwd(), os.homedir());
    this.post({ type: 'skillsAvailable', backend, prefix, skills });
  }

  /** Push Settings-backed last-used backend/model so the picker survives restarts. */
  postComposerSelection(): void {
    const selection = readComposerSelection({
      get: (key) => vscode.workspace.getConfiguration().get(key),
      update: (key, value, target) =>
        vscode.workspace.getConfiguration().update(key, value, target as vscode.ConfigurationTarget),
    });
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
    void writeComposerSelection(
      {
        get: (key) => vscode.workspace.getConfiguration().get(key),
        update: (key, value, target) =>
          vscode.workspace
            .getConfiguration()
            .update(key, value, target as vscode.ConfigurationTarget),
      },
      selection,
      vscode.ConfigurationTarget.Global,
    );
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
      writeHostEnvCache({ models });
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
        // Durable promote of queued user messages is published via workspace
        // patches from prepareDispatch/replaceLiveTurn post-commit.
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

  focusTask(taskId: string): void {
    void this.transitionFocus(taskId);
  }

  /**
   * Flush the previous focused stream (if any), then swap focus/known ids and
   * post a bounded snapshot. Shared by protocol handlers and presentation links.
   */
  private async transitionFocus(nextFocus: string | undefined): Promise<void> {
    const previous = this.focusedTaskId;
    if (previous && previous !== nextFocus && taskEngine) {
      try {
        await taskEngine.flushPendingTranscriptForTask(previous);
      } catch {
        // Best-effort durable flush before handoff.
      }
    }
    this.focusedTaskId = nextFocus;
    this.knownTranscriptIds.clear();
    await this.hydrateSnapshotAndResumePolling(nextFocus);
  }

  postSnapshot(focusedTaskId?: string, retryAttempt = 0): void {
    void this.hydrateSnapshotAndResumePolling(focusedTaskId, retryAttempt);
  }

  /**
   * Stop peer patches while a focus/visibility snapshot is in flight. This keeps
   * first activation and focus transitions from receiving revision batches
   * against an unhydrated or previous-task reducer state.
   */
  private async hydrateSnapshotAndResumePolling(
    focusedTaskId?: string,
    retryAttempt = 0,
  ): Promise<boolean> {
    this.pollingReady = false;
    this.revisionPoller?.stop();
    const hydrated = await this.postSnapshotAsync(focusedTaskId, retryAttempt);
    if (!hydrated) return false;
    this.pollingReady = true;
    if (this._view?.visible && this.windowFocused) {
      this.revisionPoller?.start();
    }
    return true;
  }

  /**
   * Awaitable snapshot for poller recovery paths. Resolves after the snapshot is
   * posted (or retries are exhausted) so lastDataVersion is not committed early.
   */
  private postSnapshotAsync(focusedTaskId?: string, retryAttempt = 0): Promise<boolean> {
    if (!taskRepository) {
      return Promise.resolve(false);
    }
    // Caller is responsible for flushing the previous focus when switching.
    // Prefer explicit arg; fall back to current host focus (after transitionFocus).
    const focus = focusedTaskId ?? this.focusedTaskId;
    const generation = ++this.snapshotGeneration;
    return buildRepositorySnapshot(taskRepository, repositoryWorkspaceId(), focus, activePendingAsks).then(async (projection) => {
      if (generation !== this.snapshotGeneration) return false;
      // A local commit may have completed after the snapshot's final read but
      // before this continuation ran. Never post an older snapshot after its
      // patch; rebuild in write order so the webview revision cannot regress.
      const projectedRevision = taskStore?.getFile().revision;
      if (
        projectedRevision !== undefined &&
        projection.snapshot.storeRevision < projectedRevision
      ) {
        if (retryAttempt < 3) {
          return this.postSnapshotAsync(focus, retryAttempt + 1);
        }
        this.postCommandError('Unable to load task snapshot.');
        return false;
      }
      // Stamp the wire version on the bootstrap message so the webview can detect
      // host<->webview drift once (and show a reload banner) instead of silently
      // dropping mismatched messages.
      this.post({ type: 'snapshot', protocolVersion: PROTOCOL_VERSION, ...projection.snapshot });
      this.replayPendingElicitations();
      // The repository normalizes a deleted/stale requested focus to no-focus.
      // Mirror the accepted snapshot, never the stale request argument.
      this.focusedTaskId = projection.snapshot.focusedTaskId;
      // Seed known transcript ids from the bounded focus page only.
      this.knownTranscriptIds = new Set(
        (projection.snapshot.transcript ?? []).map((item) => item.id),
      );
      // Recovery/bootstrap cursor: poller continues from the accepted snapshot.
      if (projection.snapshot.storeRevision > this.appliedWorkspaceRevision) {
        this.appliedWorkspaceRevision = projection.snapshot.storeRevision;
      }
      return true;
    }).catch(async () => {
      if (generation !== this.snapshotGeneration) return false;
      if (retryAttempt < 3) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25 * (retryAttempt + 1));
        });
        if (generation === this.snapshotGeneration) {
          return this.postSnapshotAsync(focus, retryAttempt + 1);
        }
        return false;
      }
      this.postCommandError('Unable to load task snapshot.');
      return false;
    });
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
    // Workspace markdown → presentation tab (not browser / text editor).
    if (this.tryOpenWorkspaceMarkdownPresentation(url)) {
      return;
    }
    // Absolute local .md outside workspace folders → open in editor.
    if (this.tryOpenLocalMarkdownFile(url)) {
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

  /** Open absolute filesystem .md path (e.g. worker cwd outside workspace root). */
  private tryOpenLocalMarkdownFile(url: string): boolean {
    const trimmed = url.trim();
    if (!/\.(md|markdown|mdx)$/i.test(trimmed.split(/[?#]/)[0] ?? '')) return false;
    let fsPath = trimmed;
    if (/^file:/i.test(trimmed)) {
      try {
        fsPath = vscode.Uri.parse(trimmed).fsPath;
      } catch {
        return false;
      }
    }
    const isAbs =
      fsPath.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(fsPath) ||
      fsPath.startsWith('\\\\');
    if (!isAbs) return false;
    try {
      if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isFile()) {
        this.postCommandError('Markdown file not found.');
        return true;
      }
    } catch {
      this.postCommandError('Could not open markdown file.');
      return true;
    }
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath));
    return true;
  }

  /**
   * If `url` is a workspace-relative or file: path to `.md`/`.markdown`/`.mdx`,
   * read it and open/reveal a presentation panel. Returns true when handled
   * (success or user-visible failure).
   */
  private tryOpenWorkspaceMarkdownPresentation(url: string): boolean {
    const folders =
      vscode.workspace.workspaceFolders?.map((f) => ({
        fsPath: f.uri.fsPath,
        uri: f.uri.toString(),
      })) ?? [];
    const target = resolveWorkspaceMarkdownPath(url, folders);
    if (!target) return false;

    if (!presentationManager) {
      this.postCommandError('Presentation is not available.');
      return true;
    }

    const file = taskStore?.getFile();
    const focused = this.focusedTaskId ? file?.tasks[this.focusedTaskId] : undefined;
    let rootTask = focused;
    if (focused && file) {
      let cur = focused;
      while (cur.parentId) {
        const parent = file.tasks[cur.parentId];
        if (!parent) break;
        cur = parent;
      }
      rootTask = cur;
    }
    // Fail closed: only real root coordinators may own review panels.
    if (!rootTask || rootTask.role !== 'coordinator' || rootTask.parentId !== null) {
      void vscode.workspace.openTextDocument(target.absolutePath).then(
        (doc) => vscode.window.showTextDocument(doc, { preview: true }),
        () => this.postCommandError('Could not open markdown file.'),
      );
      return true;
    }
    const rootId = rootTask.id;
    const ownerTaskId = rootTask.id;

    let markdown: string;
    try {
      markdown = fs.readFileSync(target.absolutePath, 'utf8');
    } catch {
      this.postCommandError('Could not read markdown file.');
      return true;
    }
    if (!markdown.trim()) {
      this.postCommandError('Markdown file is empty.');
      return true;
    }
    markdown = clampPresentationMarkdown(markdown);

    void presentationManager
      .openWorkspaceDocument(rootId, {
        presentationId: target.presentationId,
        ownerTaskId,
        title: target.title,
        markdown,
        kind: 'document',
        sourcePath: target.sourcePath,
        sourceFolderUri: target.sourceFolderUri,
      })
      .then((result) => {
        if (!result.ok) {
          this.postCommandError('Could not open presentation.');
        }
      })
      .catch(() => {
        this.postCommandError('Could not open presentation.');
      });
    return true;
  }

  private async handleClearHistory(): Promise<void> {
    const repository = taskRepository;
    if (!repository) {
      this.postCommandError('task store not ready');
      return;
    }
    const focus = this.focusedTaskId;
    let preserveRootTaskId: string | undefined;
    if (focus) {
      const tasks = await repository.listTasks(repositoryWorkspaceId());
      const byId = new Map(tasks.map((task) => [task.id, task]));
      let current = byId.get(focus);
      const seen = new Set<string>();
      while (current?.parentId && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parentId);
      }
      preserveRootTaskId = current?.id;
    }
    const result = await repository.execute({
      kind: 'clearHistory',
      workspaceId: repositoryWorkspaceId(),
      ...(preserveRootTaskId ? { preserveRootTaskId } : {}),
    });
    if (result.reason && !result.changed) {
      this.postCommandError(result.reason);
      return;
    }
    if (focus && !(await repository.getTask(focus))) {
      this.focusedTaskId = undefined;
      this.knownTranscriptIds.clear();
      // Focus invalidation after destructive clear — bounded no-focus snapshot.
      this.postSnapshot(undefined);
      return;
    }
    // Ordinary clearHistory results publish via onAfterCommit patches.
  }

  /** Delete a single top-level task (and its whole subtree) through the repository. */
  private async handleDeleteTask(taskId: string): Promise<void> {
    const repository = taskRepository;
    if (!repository) {
      this.postCommandError('task store not ready');
      return;
    }
    const focus = this.focusedTaskId;
    let preserveRootTaskId: string | undefined;
    if (focus) {
      const tasks = await repository.listTasks(repositoryWorkspaceId());
      const byId = new Map(tasks.map((task) => [task.id, task]));
      let current = byId.get(focus);
      const seen = new Set<string>();
      while (current?.parentId && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parentId);
      }
      preserveRootTaskId = current?.id;
    }
    const result = await repository.execute({
      kind: 'deleteTaskSubtreeIfIdle',
      workspaceId: repositoryWorkspaceId(),
      rootTaskId: taskId,
      ...(preserveRootTaskId ? { preserveRootTaskId } : {}),
    });
    if (result.reason && !result.changed) {
      this.postCommandError(result.reason, taskId);
      return;
    }
    if (focus && !(await repository.getTask(focus))) {
      this.focusedTaskId = undefined;
      this.knownTranscriptIds.clear();
      this.postSnapshot(undefined);
      return;
    }
    // Ordinary delete results publish via onAfterCommit patches.
  }

  /** Rename a task by replacing its goal (the display label). */
  private async handleRenameTask(taskId: string, goal: string): Promise<void> {
    const repository = taskRepository;
    if (!repository) {
      this.postCommandError('task store not ready');
      return;
    }
    const trimmed = goal.trim();
    if (!trimmed) {
      this.postCommandError('Task name cannot be empty.');
      return;
    }
    const capped = trimmed.length > MAX_MESSAGE_CHARS ? trimmed.slice(0, MAX_MESSAGE_CHARS) : trimmed;
    const current = await repository.getTask(taskId);
    if (!current) return;
    const result = await repository.execute({
      kind: 'renameTask',
      workspaceId: repositoryWorkspaceId(),
      taskId,
      goal: capped,
      expectedTaskRevision: current.revision,
      updatedAt: new Date().toISOString(),
    });
    if (result.reason && !result.changed) {
      this.postCommandError(result.reason, taskId);
      return;
    }
    // Rename publishes taskUpserted via onAfterCommit.
  }

  /**
   * Host-orchestrated runtime model/backend switch for an existing idle task.
   * Pure route validates the inbound request and atomically commits the new
   * binding + continuation cutoff. No hidden model turn runs during the click.
   */
  private async handleRequestRuntimeHandoff(data: unknown): Promise<void> {
    debugMuster('handoff.host_received', {
      data: typeof data === 'object' && data ? data : { raw: String(data) },
    });
    if (!taskEngine || !taskStore) {
      debugMuster('handoff.engine_not_ready', {});
      this.postCommandError('task engine not ready');
      return;
    }
    const engine = taskEngine;
    const store = taskStore;
    const outcome = await routeRuntimeHandoff(data, {
      getTask: (taskId) => {
        const task = store.getTask(taskId);
        if (!task) return undefined;
        // Labels only for same-binding refusal — never session ids.
        return task.model
          ? { backend: task.backend, model: task.model }
          : { backend: task.backend };
      },
      requestRuntimeHandoff: async (params) => {
        debugMuster('handoff.engine_request', params as unknown as Record<string, unknown>);
        const result = await engine.requestRuntimeHandoff(params);
        debugMuster(
          'handoff.engine_request_result',
          result.ok
            ? {
                ok: true,
                operationId: result.value.operationId,
                boundBackend: result.value.boundBackend,
                boundModel: result.value.boundModel,
                switchedAt: result.value.switchedAt,
              }
            : { ok: false, reason: result.reason },
        );
        return result;
      },
    });
    debugMuster('handoff.route_outcome', {
      kind: outcome.kind,
      taskId: 'taskId' in outcome ? outcome.taskId : undefined,
      messages: outcome.messages.map((m) => m.message),
    });
    for (const message of outcome.messages) {
      this.post(message);
    }
    // Handoff binding updates publish via onAfterCommit patches (no full snapshot).
  }

  /**
   * Create the multi-window revision poller once. Polling runs only while the
   * webview is visible and the VS Code window is focused.
   */
  private ensureRevisionPoller(): void {
    if (this.revisionPoller) return;
    this.revisionPoller = new WorkspaceRevisionPoller({
      getStorageDataVersion: async () => {
        if (!taskRepository) throw new Error('repository unavailable');
        return taskRepository.getStorageDataVersion();
      },
      getWorkspaceRevision: async () => {
        if (!taskRepository) throw new Error('repository unavailable');
        return taskRepository.getWorkspaceRevision();
      },
      getAppliedRevision: () => this.appliedWorkspaceRevision,
      isActive: () => Boolean(this._view?.visible) && this.windowFocused && this.pollingReady,
      onExternalRevisions: async ({ afterRevision, currentRevision }) => {
        await this.reconcileExternalRevisions(afterRevision, currentRevision);
      },
      onRecovery: async () => {
        await this.postSnapshotAsync(this.focusedTaskId);
      },
    });
  }

  /**
   * Apply peer revisions through the change feed under the same write-order
   * barrier as local execute→publish so patches cannot interleave mid-batch.
   */
  private async reconcileExternalRevisions(
    afterRevision: number,
    _currentRevision: number,
  ): Promise<void> {
    if (!taskRepository || !taskEngine) return;
    if (afterRevision < this.appliedWorkspaceRevision) {
      afterRevision = this.appliedWorkspaceRevision;
    }
    const projection = taskEngine.getProjection();
    if (!projection) {
      await this.postSnapshotAsync(this.focusedTaskId);
      return;
    }
    const run = async (): Promise<void> => {
      const result = await reconcileExternalWorkspaceChanges({
        repository: taskRepository!,
        projection,
        afterRevision,
        focusedTaskId: this.focusedTaskId,
        knownTranscriptIds: this.knownTranscriptIds,
      });
      if (result.kind === 'gap' || result.kind === 'recovery') {
        this.externalRecoveryCount += 1;
        await this.postSnapshotAsync(this.focusedTaskId);
        return;
      }
      if (!this._view?.visible || !this.pollingReady) {
        // No patch was delivered. Visibility recovery owns cursor advancement.
        return;
      }
      for (const batch of result.batches) {
        if (batch.revision <= this.appliedWorkspaceRevision) continue;
        for (const patch of batch.patches) {
          if (patch.type === 'transcriptItemsAppended') {
            for (const item of patch.items) this.knownTranscriptIds.add(item.id);
          } else if (patch.type === 'transcriptItemPatched') {
            this.knownTranscriptIds.add(patch.item.id);
          } else if (patch.type === 'transcriptItemsRemoved') {
            for (const itemId of patch.itemIds) this.knownTranscriptIds.delete(itemId);
          } else if (patch.type === 'taskRemoved' && patch.taskId === this.focusedTaskId) {
            this.knownTranscriptIds.clear();
          }
        }
        this.post(batch);
        this.appliedWorkspaceRevision = batch.revision;
      }
      if (result.appliedRevision > this.appliedWorkspaceRevision) {
        this.appliedWorkspaceRevision = result.appliedRevision;
      }
    };
    if (typeof taskRepository.runConsistentRead === 'function') {
      await taskRepository.runConsistentRead(run);
    } else {
      await run();
    }
  }

  disposeRevisionPoller(): void {
    this.revisionPoller?.dispose();
    this.revisionPoller = undefined;
    this.pollingReady = false;
    this.windowStateSub?.dispose();
    this.windowStateSub = undefined;
  }

  /** Keep both independent Electron processes polling while CI cannot focus both. */
  forcePollingActiveForUat(): UatHostState {
    this.uatFocusGateOverridden = true;
    this.windowFocused = true;
    if (this._view?.visible && this.pollingReady) {
      this.revisionPoller?.start();
    }
    return this.hostStateForUat();
  }

  /** Read only the real engine projection/poller state; never query SQLite here. */
  hostStateForUat(): UatHostState {
    const file = taskEngine?.getProjection()?.getFile();
    const taskIds = Object.keys(file?.tasks ?? {}).sort();
    const messageIdsByTask: Record<string, string[]> = Object.fromEntries(
      taskIds.map((taskId) => [taskId, []]),
    );
    const queuedTurnIdsByTask: Record<string, string[]> = Object.fromEntries(
      taskIds.map((taskId) => [taskId, []]),
    );
    for (const message of Object.values(file?.messages ?? {})) {
      (messageIdsByTask[message.taskId] ??= []).push(message.id);
    }
    for (const turn of Object.values(file?.turns ?? {})) {
      if (turn.status === 'queued') {
        (queuedTurnIdsByTask[turn.taskId] ??= []).push(turn.id);
      }
    }
    for (const ids of Object.values(messageIdsByTask)) ids.sort();
    for (const ids of Object.values(queuedTurnIdsByTask)) ids.sort();
    return {
      projectionRevision: file?.revision ?? 0,
      appliedWorkspaceRevision: this.appliedWorkspaceRevision,
      taskIds,
      messageIdsByTask,
      queuedTurnIdsByTask,
      knownTranscriptIds: [...this.knownTranscriptIds].sort(),
      ...(this.focusedTaskId ? { focusedTaskId: this.focusedTaskId } : {}),
      viewResolved: Boolean(this._view),
      viewVisible: Boolean(this._view?.visible),
      pollingReady: this.pollingReady,
      pollCount: this.revisionPoller?.getPollCount() ?? 0,
      externalRecoveryCount: this.externalRecoveryCount,
      focusGateOverridden: this.uatFocusGateOverridden,
    };
  }

  async focusTaskForUat(taskId: string | undefined): Promise<UatHostState> {
    await this.transitionFocus(taskId);
    return this.hostStateForUat();
  }

  /** Exercise the production loadTranscriptPage route against a real focused view. */
  async loadOlderTranscriptForUat(taskId: string, limit = 2): Promise<{
    latestIds: string[];
    olderIds: string[];
    hasMoreBeforeLatest: boolean;
    hasMoreBeforeOlder: boolean;
    workspaceRevision: number;
  }> {
    if (!taskRepository) throw new Error('UAT repository unavailable');
    const latest = await taskRepository.getTranscriptPage(taskId, undefined, limit);
    if (!latest.beforeCursor) {
      return {
        latestIds: latest.items.map((item) => item.id),
        olderIds: [],
        hasMoreBeforeLatest: latest.hasMoreBefore,
        hasMoreBeforeOlder: false,
        workspaceRevision: latest.workspaceRevision,
      };
    }
    const repository = taskRepository;
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'uat-live-older-page',
        taskId,
        beforeCursor: latest.beforeCursor,
      },
      {
        getFocused: () => ({
          taskId: this.focusedTaskId,
          generation: this.snapshotGeneration,
        }),
        getTask: (id) => repository.getTask(id),
        getTranscriptPage: (id, beforeCursor, pageLimit) =>
          repository.getTranscriptPage(id, beforeCursor, pageLimit),
      },
    );
    if (outcome.kind !== 'message') {
      throw new Error('UAT transcript route failed: silent');
    }
    if (!outcome.message.ok) {
      throw new Error(`UAT transcript route failed: ${outcome.message.code}`);
    }
    this.post(outcome.message);
    for (const item of outcome.message.items) this.knownTranscriptIds.add(item.id);
    return {
      latestIds: latest.items.map((item) => item.id),
      olderIds: outcome.message.items.map((item) => item.id),
      hasMoreBeforeLatest: latest.hasMoreBefore,
      hasMoreBeforeOlder: outcome.message.transcriptPage.hasMoreBefore,
      workspaceRevision: outcome.message.transcriptPage.workspaceRevision,
    };
  }

  /**
   * Protocol v8 recovery: webview observed a revision gap/invariant failure.
   * Validate exact keys and return a bounded snapshot. Protocol mismatch still
   * requires Reload Window and is not handled here.
   */
  private handleRequestWorkspaceRecovery(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;
    if (msg.type !== 'requestWorkspaceRecovery') return;
    const keys = Object.keys(msg);
    const allowed = new Set(['type', 'taskId', 'currentRevision', 'observedRevision']);
    if (keys.some((k) => !allowed.has(k))) return;
    if (
      typeof msg.currentRevision !== 'number' ||
      !Number.isFinite(msg.currentRevision) ||
      !Number.isSafeInteger(msg.currentRevision) ||
      msg.currentRevision < 0
    ) {
      return;
    }
    if (
      typeof msg.observedRevision !== 'number' ||
      !Number.isFinite(msg.observedRevision) ||
      !Number.isSafeInteger(msg.observedRevision) ||
      msg.observedRevision < 0
    ) {
      return;
    }
    if (msg.taskId !== undefined) {
      if (typeof msg.taskId !== 'string' || msg.taskId.length === 0 || msg.taskId.length > 512) {
        return;
      }
      if (msg.taskId.includes('\0')) return;
    }
    const focus =
      typeof msg.taskId === 'string' && msg.taskId.length > 0
        ? msg.taskId
        : this.focusedTaskId;
    this.postSnapshot(focus);
  }

  /**
   * Load one bounded older transcript page for the focused task (protocol v7).
   * Valid failures post transcriptPageResult with fixed codes — never commandError.
   */
  private async handleLoadTranscriptPage(data: unknown): Promise<void> {
    if (!taskRepository) {
      // Repository not ready is unavailable (not taskNotFound). getTask throws so
      // the pure route maps the failure after safe correlation validation.
      const outcome = await routeLoadTranscriptPage(data, {
        getFocused: () => ({
          taskId: this.focusedTaskId,
          generation: this.snapshotGeneration,
        }),
        getTask: async () => {
          throw new Error('task repository not ready');
        },
        getTranscriptPage: async () => {
          throw new Error('task repository not ready');
        },
      });
      if (outcome.kind === 'message') this.post(outcome.message);
      return;
    }
    const repository = taskRepository;
    const outcome = await routeLoadTranscriptPage(data, {
      getFocused: () => ({
        taskId: this.focusedTaskId,
        generation: this.snapshotGeneration,
      }),
      getTask: (taskId: string) => repository.getTask(taskId),
      getTranscriptPage: (taskId: string, beforeCursor: string, limit: number) =>
        repository.getTranscriptPage(taskId, beforeCursor, limit),
    });
    if (outcome.kind === 'message') {
      this.post(outcome.message);
      if (
        outcome.message.type === 'transcriptPageResult' &&
        outcome.message.ok === true &&
        outcome.message.taskId === this.focusedTaskId
      ) {
        for (const item of outcome.message.items) {
          this.knownTranscriptIds.add(item.id);
        }
      }
    }
  }

  /**
   * Export one task as Markdown via native Save As. Read-only store access;
   * never mutates task-store state. Cancel is intentionally silent.
   */
  private async handleExportTask(data: unknown): Promise<void> {
    if (!taskRepository) {
      this.postCommandError('task store not ready');
      return;
    }
    const outcome = await routeExportTask(data, {
      getRepository: () => taskRepository!,
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

  private async handleSend(data: HostSendRequest): Promise<void> {
    const clientRequestId =
      typeof data.clientRequestId === 'string' && data.clientRequestId.trim()
        ? data.clientRequestId.trim()
        : undefined;
    if (!taskEngine || !taskStore || !taskRepository) {
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
    // Durable outbox before processing so crash/reload can restore the draft.
    // Full control-flow for queue-only failure path uses durableQueueSend via
    // runDurableHostSend when we need schedule/ACK isolation; for the main
    // handleSend we still put outbox first then continue into engine below.
    if (clientRequestId && taskRepository) {
      const now = new Date().toISOString();
      const entry = {
        clientRequestId,
        status: 'pending' as const,
        ...(data.taskId ? { taskId: data.taskId } : {}),
        payload: {
          version: 1 as const,
          text,
          ...(typeof data.llmText === 'string' && data.llmText.trim()
            ? { llmText: data.llmText.trim() }
            : {}),
          ...(Array.isArray(data.mentionBindings) ? { mentionBindings: data.mentionBindings } : {}),
          ...(Array.isArray(data.skills) ? { skills: data.skills } : {}),
          ...(typeof data.backend === 'string' ? { backend: data.backend } : {}),
          ...(typeof data.model === 'string' ? { model: data.model } : {}),
          ...(typeof data.continuationOf === 'string'
            ? { continuationOf: data.continuationOf }
            : {}),
        },
        createdAt: now,
        updatedAt: now,
      };
      try {
        await taskRepository.execute({
          kind: 'putSendOutbox',
          workspaceId: repositoryWorkspaceId(),
          entry,
        });
      } catch {
        this.post({
          type: 'sendRejected',
          clientRequestId,
          taskId: data.taskId,
          reason: 'unable to durably queue send',
          code: 'store',
        });
        return;
      }
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      if (clientRequestId) {
        await this.rejectDurableOutbox(clientRequestId);
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
        await this.rejectDurableOutbox(clientRequestId);
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
            await this.rejectDurableOutbox(clientRequestId);
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
      const result = await taskEngine.startNewTask({
        goal: shortGoal,
        message: text,
        agentMessage: llmText !== text ? llmText : undefined,
        backend: resolvedBackend,
        model: resolvedModel,
        continuationOf: data.continuationOf,
        // Skills are first-turn-only; startNewTask ignores them for continuations.
        ...(Array.isArray(data.skills) && data.skills.length ? { skills: data.skills } : {}),
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
          await this.rejectDurableOutbox(clientRequestId);
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
      this.focusedTaskId = result.value.taskId;
      if (clientRequestId) {
        await this.clearDurableOutbox(clientRequestId);
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

    // Existing task: if the composer picker asked for a different backend/model,
    // atomically switch first, then send on the rebound binding. This covers
    // cases where picker change did not fire requestRuntimeHandoff beforehand.
    const existing = taskStore.getTask(data.taskId);
    if (existing && data.backend && WEBVIEW_BACKENDS.has(data.backend)) {
      const targetModel =
        typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined;
      const currentModel =
        typeof existing.model === 'string' && existing.model.trim()
          ? existing.model.trim()
          : undefined;
      const bindingDiffers =
        existing.backend !== data.backend || currentModel !== targetModel;
      if (bindingDiffers) {
        await this.handleRequestRuntimeHandoff({
          type: 'requestRuntimeHandoff',
          taskId: data.taskId,
          targetBackend: data.backend,
          ...(targetModel ? { targetModel } : {}),
        });
        const after = taskStore.getTask(data.taskId);
        const afterModel =
          typeof after?.model === 'string' && after.model.trim()
            ? after.model.trim()
            : undefined;
        if (!after || after.backend !== data.backend || afterModel !== targetModel) {
          const reason =
            'Model switch did not commit; message was not sent on the previous backend.';
          if (clientRequestId) {
            await this.rejectDurableOutbox(clientRequestId);
            this.post({
              type: 'sendRejected',
              clientRequestId,
              taskId: data.taskId,
              reason,
              code: 'unknown',
            });
          } else {
            this.postCommandError(reason, data.taskId);
          }
          return;
        }
      }
    }

    const result = await taskEngine.sendAsync(data.taskId, text, {
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
        await this.rejectDurableOutbox(clientRequestId);
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
      // Receipt is already durable. Attempt outbox cleanup before ACK; if SQLite
      // cleanup is transiently unavailable, reload replay de-dupes by receipt and
      // retries the same delete without creating a second message.
      await this.clearDurableOutbox(clientRequestId);
      this.post({
        type: 'sendAccepted',
        clientRequestId,
        taskId: data.taskId,
        messageId: result.value.messageId,
        turnId: result.value.turnId,
      });
    }
    // Transcript/queue/activity publish via onAfterCommit workspacePatchBatch.
  }

  /** Mark durable outbox rejected after put — every reject path after durable put. */
  private async rejectDurableOutbox(clientRequestId: string): Promise<void> {
    if (!taskRepository) return;
    try {
      await taskRepository.execute({
        kind: 'markSendOutboxRejected',
        workspaceId: repositoryWorkspaceId(),
        clientRequestId,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // still surface rejection to webview
    }
  }

  /** Delete durable outbox after successful send (new-task and existing-task). */
  private async clearDurableOutbox(clientRequestId: string): Promise<void> {
    if (!taskRepository) return;
    try {
      await taskRepository.execute({
        kind: 'deleteSendOutbox',
        workspaceId: repositoryWorkspaceId(),
        clientRequestId,
      });
    } catch {
      // Keep outbox so reload can de-dupe via send receipt + clientRequestId.
    }
  }

  /** Push durable SQLite outbox entries so webview can restore drafts after reload. */
  private async postSendOutboxSnapshot(): Promise<void> {
    if (!taskRepository) return;
    try {
      const entries = await taskRepository.listSendOutbox();
      this.post({
        type: 'sendOutboxSnapshot',
        entries: entries.map((entry) => ({
          clientRequestId: entry.clientRequestId,
          status: entry.status,
          taskId: entry.taskId,
          text: entry.payload.text,
          llmText: entry.payload.llmText,
          mentionBindings: entry.payload.mentionBindings,
          skills: entry.payload.skills,
          backend: entry.payload.backend,
          model: entry.payload.model,
          continuationOf: entry.payload.continuationOf,
          createdAt: Date.parse(entry.createdAt) || Date.now(),
        })),
      });
    } catch {
      // best-effort restore
    }
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
      // Race with drain: durable state already published via patches if changed.
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
    this.windowFocused = vscode.window.state.focused;
    this.pollingReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    this.ensureRevisionPoller();
    this.windowStateSub?.dispose();
    this.windowStateSub = vscode.window.onDidChangeWindowState((state) => {
      this.windowFocused = this.uatFocusGateOverridden || state.focused;
      if (this.windowFocused && webviewView.visible && this.pollingReady) {
        this.revisionPoller?.start();
      } else if (!this.windowFocused) {
        this.revisionPoller?.stop();
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Snapshot delivery establishes the cursor for every local/external
        // revision missed while hidden. Start polling only after that recovery
        // completes so patches cannot race ahead of the authoritative hydrate.
        void this.hydrateSnapshotAndResumePolling(this.focusedTaskId);
      } else {
        this.pollingReady = false;
        this.revisionPoller?.stop();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      if (data?.type === 'debugLog') {
        debugMuster(
          typeof data.event === 'string' ? data.event : 'webview.debug',
          data.details && typeof data.details === 'object'
            ? (data.details as Record<string, unknown>)
            : { details: data.details },
        );
        return;
      }
      if (
        data?.type === 'requestRuntimeHandoff' ||
        data?.type === 'send' ||
        data?.type === 'listModels'
      ) {
        debugMuster('host.webview_message', {
          type: data?.type,
          taskId: data?.taskId,
          targetBackend: data?.targetBackend,
          targetModel: data?.targetModel,
          backend: data?.backend,
          model: data?.model,
        });
      }
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
        case 'send': {
          const parsed = parseHostSendRequest(data);
          if (!parsed.ok) {
            if (parsed.clientRequestId) {
              this.post({
                type: 'sendRejected',
                clientRequestId: parsed.clientRequestId,
                ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
                reason: 'invalid send request',
                code: 'validation',
              });
            } else {
              this.postCommandError('invalid send request');
            }
            break;
          }
          await this.handleSend(parsed.value);
          break;
        }
        case 'newTask':
          await this.transitionFocus(undefined);
          break;
        case 'focusTask':
          if (typeof data.taskId === 'string') {
            await this.transitionFocus(data.taskId);
          }
          break;
        case 'hydrateSubtree':
          if (typeof data.taskId === 'string') {
            await this.transitionFocus(data.taskId);
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
            const result = await taskEngine.interruptTurnAsync(data.turnId);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
            } else if (sessionId) {
              elicitationBridge?.cancelForSession(sessionId);
            }
          }
          break;
        case 'retryTurn':
          if (!taskEngine) {
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
            const result = await taskEngine.retryTurnAsync(data.taskId, data.turnId, effectiveInstruction, {
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
            const result = await taskEngine.sendAsync(data.taskId, instruction);
            if (!result.ok) {
              this.postCommandError(result.reason, data.taskId);
              break;
            }
            // Transcript/queue publish via onAfterCommit workspacePatchBatch.
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
          const result = await engine.interruptAndSendAsync(taskId, instruction);
          if (!result.ok) {
            this.postCommandError(result.reason, taskId);
            break;
          }
          // Queue/activity publish via onAfterCommit.
          break;
        }
        case 'editQueuedTurn': {
          // R013: edit undispatched queued follow-up by turn identity.
          // Validate + engine.editQueuedTurn only; never continueTask fallthrough.
          const engine = taskEngine;
          const outcome = await routeEditQueuedTurn(data, {
            engineReady: Boolean(engine),
            editQueuedTurn: async (taskId, turnId, content) => {
              if (!engine) {
                return { ok: false, reason: 'task engine not ready' };
              }
              return engine.editQueuedTurnAsync(taskId, turnId, content);
            },
          });
          if (outcome.kind === 'error') {
            this.handleQueuedMutationOutcome(outcome.message, outcome.taskId, data?.turnId);
          }
          // Success: queuedTurnsChanged via onAfterCommit.
          break;
        }
        case 'deleteQueuedTurn': {
          // R013: remove undispatched queued follow-up by turn identity.
          // Validate + engine.deleteQueuedTurn only; never cancelProcess.
          const engine = taskEngine;
          const outcome = await routeDeleteQueuedTurn(data, {
            engineReady: Boolean(engine),
            deleteQueuedTurn: async (taskId, turnId) => {
              if (!engine) {
                return { ok: false, reason: 'task engine not ready' };
              }
              return engine.deleteQueuedTurnAsync(taskId, turnId);
            },
          });
          if (outcome.kind === 'error') {
            this.handleQueuedMutationOutcome(outcome.message, outcome.taskId, data?.turnId);
          }
          // Success: queuedTurnsChanged via onAfterCommit.
          break;
        }
        case 'resumeQueuedTurn':
          if (!taskEngine) {
            this.postCommandError('task engine not ready');
            break;
          }
          if (typeof data.taskId !== 'string' || typeof data.turnId !== 'string') {
            this.postCommandError('resumeQueuedTurn requires taskId and turnId');
            break;
          }
          {
            const result = await taskEngine.resumeQueuedTurnAsync(data.taskId, data.turnId);
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
              ? await taskEngine.cancelTaskAsync(data.taskId)
              : await taskEngine.setTaskLifecycleAsync(data.taskId, lifecycle, {
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
            // Lifecycle patches publish via onAfterCommit.
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
            const result = taskEngine ? await taskEngine.submitAskAnswer(
              { taskId: data.taskId, turnId: data.turnId, askId: data.askId },
              data.answers,
            ) : undefined;
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
            const result = taskEngine ? await taskEngine.cancelAskTurn({
              taskId: data.taskId,
              turnId: data.turnId,
              askId: data.askId,
            }) : undefined;
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
        case 'requestFileMentionSuggestions':
          await this.handleRequestFileMentionSuggestions(data);
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
          await this.handleClearHistory();
          break;
        case 'deleteTask':
          if (typeof data.taskId === 'string') {
            await this.handleDeleteTask(data.taskId);
          }
          break;
        case 'renameTask':
          if (typeof data.taskId === 'string' && typeof data.goal === 'string') {
            await this.handleRenameTask(data.taskId, data.goal);
          }
          break;
        case 'exportTask':
          await this.handleExportTask(data);
          break;
        case 'loadTranscriptPage':
          await this.handleLoadTranscriptPage(data);
          break;
        case 'requestWorkspaceRecovery':
          this.handleRequestWorkspaceRecovery(data);
          break;
        case 'requestRuntimeHandoff':
          await this.handleRequestRuntimeHandoff(data);
          break;
        case 'blurTask': {
          // Webview returned to the task list; flush then drop host-side focus so a
          // later snapshot (e.g. after Clear history) doesn't re-open a stale chat.
          const previous = this.focusedTaskId;
          if (previous && taskEngine) {
            try {
              await taskEngine.flushPendingTranscriptForTask(previous);
            } catch {
              // best-effort
            }
          }
          this.focusedTaskId = undefined;
          this.knownTranscriptIds.clear();
          break;
        }
        case 'requestSettings':
          this.postSettingsSnapshot();
          this.postTaskTypesSettingsSnapshot();
          this.postPermissionSettingsSnapshot();
          break;
        case 'updateSetting':
          await this.handleUpdateSetting(data);
          break;
        case 'requestTaskTypesSettings':
          this.postTaskTypesSettingsSnapshot();
          break;
        case 'updateTaskTypes':
          await this.handleUpdateTaskTypes(data);
          break;
        case 'requestPermissionSettings':
          this.postPermissionSettingsSnapshot();
          break;
        case 'updatePermissionSettings':
          await this.handleUpdatePermissionSettings(data);
          break;
        case 'listBackends':
          void this.postAvailableBackends();
          break;
        case 'listSkills':
          this.postAvailableSkills((data as { backend: string }).backend);
          break;
        case 'listModels':
          void this.postAvailableModels();
          break;
        case 'setComposerSelection':
          this.handleSetComposerSelection(data);
          break;
        case 'ackSendOutbox': {
          const keys =
            typeof data === 'object' && data !== null && !Array.isArray(data)
              ? Object.keys(data as Record<string, unknown>)
              : [];
          const rawId = (data as { clientRequestId?: unknown })?.clientRequestId;
          const id =
            keys.length === 2 &&
            keys.includes('type') &&
            keys.includes('clientRequestId') &&
            typeof rawId === 'string' &&
            rawId.length <= MAX_ID_CHARS &&
            /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(rawId)
              ? rawId
              : '';
          if (id && taskRepository) {
            void taskRepository.execute({
              kind: 'deleteSendOutbox',
              workspaceId: repositoryWorkspaceId(),
              clientRequestId: id,
            });
          }
          break;
        }
        default:
          // Unknown inbound type: log instead of silently ignoring. This surfaces
          // host<->webview protocol drift (e.g. a newer webview sending a message
          // type this host build predates) rather than dropping it without a trace.
          console.warn(`Muster: ignoring unknown webview message type ${String(data?.type)}`);
      }
    });

    // Do not auto-focus on open — entry UI shows previous tasks list (per redesign)
    // User selects from list or New task to enter chat.
    // Outbox must hydrate before snapshot so pending replay after snapshot sees rows.
    void (async () => {
      await this.postSendOutboxSnapshot();
      await this.hydrateSnapshotAndResumePolling(this.focusedTaskId);
    })();
    // Tell the webview which backends are actually installed so its picker only
    // offers callable ones (the webview also requests this on mount).
    void this.postAvailableBackends();
    // Prefetch model catalog so New task can show [Backend] Model options promptly.
    void this.postAvailableModels();
    // Restore last-used backend/model from VS Code Settings (survives restarts).
    this.postComposerSelection();
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const dist = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets');
    // Cache-bust CSS/JS by the built asset's mtime. The resource filenames carry no
    // content hash, so the webview URL is byte-identical across reloads — VS Code's
    // webview resource cache then keeps serving the PREVIOUS build's stylesheet even
    // after a rebuild + reload, until the whole dev host is torn down. A per-content
    // version query changes the URL only when the asset actually changes, forcing a
    // fresh fetch then and letting the cache stay warm otherwise.
    const version = (file: vscode.Uri): string => {
      try {
        return String(Math.trunc(fs.statSync(file.fsPath).mtimeMs));
      } catch {
        return '0';
      }
    };
    const scriptFile = vscode.Uri.joinPath(dist, 'index.js');
    const styleFile = vscode.Uri.joinPath(dist, 'index.css');
    const scriptUri = `${webview.asWebviewUri(scriptFile)}?v=${version(scriptFile)}`;
    const styleUri = `${webview.asWebviewUri(styleFile)}?v=${version(styleFile)}`;
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

/** Adapt VS Code's workspace shape to the pure registry identity contract. */
function resolveCurrentWorkspaceIdentity(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFileUri = vscode.workspace.workspaceFile?.toString();
  const workspaceContext: WorkspaceContext =
    folders.length === 0
      ? {
          kind: 'empty',
          // VS Code does not expose a stable profile UUID here. globalStorageUri
          // is profile+extension-host scoped by contract, and its URI is stable
          // across empty-window activations in that scope.
          profileAuthority: `${vscode.env.remoteName ?? 'local'}:${context.globalStorageUri.toString()}`,
        }
      : folders.length === 1 && !workspaceFileUri
        ? { kind: 'single-root', folderUri: folders[0]!.uri.toString() }
        : {
            kind: 'multi-root',
            ...(workspaceFileUri ? { workspaceFileUri } : {}),
            folderUris: folders.map((folder) => folder.uri.toString()),
          };
  return resolveWorkspaceIdentity(workspaceContext);
}

export async function activate(context: vscode.ExtensionContext) {
  const liveUatEnabled = isUatModeEnabled(
    context.extensionMode === vscode.ExtensionMode.Production,
  );
  // Patch PATH from the login shell BEFORE anything spawns a backend CLI, so a
  // GUI-launched editor (minimal PATH) can both detect and actually run the CLIs.
  await installAugmentedPath();

  // SQLite is the only writable source. A host that advertises our minimum VS Code
  // version but omits node:sqlite cannot safely activate the task engine.
  const sqliteProbe = probeNodeSqlite();
  if (!sqliteProbe.available) {
    debugMuster('sqlite.probe.unavailable', { reason: sqliteProbe.reason });
    const message = `Muster requires node:sqlite in the VS Code extension host: ${sqliteProbe.reason}`;
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }

  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  workspaceRoot = wsFolder?.uri.fsPath;
  const terminalLifecycle = createTerminalStorageLifecycle({
    diagnose: diagnoseSqliteError,
    redactedLogFields: redactedDiagnosticLogFields,
    log: debugMuster,
    quiesce: () => {
      applyTerminalStorageQuiesce({
        productionProvider: chatProvider,
        uatProvider: uatChatProvider,
        engine: taskEngine,
        clearHostRefs: () => {
          taskEngine = undefined;
          taskStore = undefined;
          taskRepository = undefined;
          sqliteClient = undefined;
          sqliteWorkspaceId = undefined;
        },
      });
    },
    closeDoomed: async (doomed) => {
      await (doomed as DbClient | undefined)?.close();
    },
    showError: async (message, action) => {
      if (action) {
        return vscode.window.showErrorMessage(message, action);
      }
      void vscode.window.showErrorMessage(message);
      return undefined;
    },
    revealStorage: async () => {
      await vscode.commands.executeCommand('revealFileInOS', context.globalStorageUri);
    },
    guidanceFor: recoveryGuidanceFor,
  });

  const candidate = new DbClient({
    workerPath: resolveWorkerPath(),
    onTerminalStorageError: (err) => {
      // Capture before synchronous quiesce clears sqliteClient. During open the
      // activation catch closes `candidate`; at runtime the captured client is
      // closed by the shared exactly-once report.
      const doomed = sqliteClient;
      void terminalLifecycle.handleTerminalSignal(err, doomed);
    },
  });
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    await candidate.open(path.join(context.globalStorageUri.fsPath, 'muster.sqlite3'));
    const workspace = await new WorkspaceRegistry(candidate).getOrCreate(
      resolveCurrentWorkspaceIdentity(context),
      new Date().toISOString(),
    );
    sqliteClient = candidate;
    sqliteWorkspaceId = workspace.id;
    terminalLifecycle.markActivationReady();
    debugMuster('sqlite.registry.ready', { workspaceId: workspace.id });
    context.subscriptions.push({
      dispose: () => {
        const current = sqliteClient;
        sqliteClient = undefined;
        sqliteWorkspaceId = undefined;
        void current?.close();
      },
    });
  } catch (error) {
    // Single activation report: callback may have stored a terminal error first.
    const reportError = terminalLifecycle.takePendingActivationError() ?? error;
    await terminalLifecycle.reportOnce(reportError, {
      operation: 'open',
      doomed: candidate,
      showUi: true,
    });
    const diagnostic = diagnoseSqliteError(reportError, 'open');
    // Fail closed: do not start engine/scheduler/poller/writer on partial state.
    throw new MusterSqliteActivationError(diagnostic.code, diagnostic.message);
  }

  const provider = new MusterChatProvider(context.extensionUri);
  chatProvider = provider;
  if (liveUatEnabled) {
    uatChatProvider = provider;
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('muster.composerSelection')) {
        provider.postComposerSelection();
      }
    }),
  );
  context.subscriptions.push({
    dispose: () => provider.disposeRevisionPoller(),
  });
  const revealLinkedChat = async (ownerTaskId: string): Promise<boolean> => {
    if (!taskStore) return false;
    const reveal = createPresentationChatLink(
      taskStore,
      { executeCommand: (command) => vscode.commands.executeCommand(command) },
      provider,
    );
    return (await reveal(ownerTaskId)).ok;
  };

  const openPresentationSource = async (document: {
    sourcePath?: string;
    sourceFolderUri?: string;
  }): Promise<void> => {
    if (!document.sourcePath || !document.sourceFolderUri) return;
    const folder = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.toString() === document.sourceFolderUri,
    );
    if (!folder) {
      void vscode.window.showErrorMessage('Source folder is no longer in the workspace.');
      return;
    }
    const abs = path.join(folder.uri.fsPath, document.sourcePath);
    try {
      const realFile = fs.realpathSync(abs);
      const realRoot = fs.realpathSync(folder.uri.fsPath);
      if (!isCanonicalInsideRoot(realFile, realRoot)) {
        void vscode.window.showErrorMessage('Source path is outside the workspace folder.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(realFile);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      void vscode.window.showErrorMessage('Could not open source file.');
    }
  };

  const openWorkspaceMarkdownFromPresentation = async (
    href: string,
    origin: {
      rootId: string;
      document: {
        ownerTaskId: string;
        sourcePath?: string;
        sourceFolderUri?: string;
      };
    },
  ): Promise<void> => {
    if (!presentationManager) return;
    const { path: hrefPath, fragment } = splitMarkdownHref(href);
    let targetAbs: string | undefined;
    let targetId: string | undefined;
    let title: string | undefined;
    let sourcePath: string | undefined;
    let sourceFolderUri: string | undefined;

    if (origin.document.sourceFolderUri) {
      const folder = vscode.workspace.workspaceFolders?.find(
        (f) => f.uri.toString() === origin.document.sourceFolderUri,
      );
      if (!folder) {
        void vscode.window.showErrorMessage('Origin folder is no longer in the workspace.');
        return;
      }
      const resolved = resolveUnderSource(
        hrefPath,
        origin.document.sourcePath,
        origin.document.sourceFolderUri,
        folder.uri.fsPath,
      );
      if (!resolved) {
        void vscode.window.showErrorMessage('Could not resolve markdown link.');
        return;
      }
      try {
        const realFile = fs.realpathSync(resolved.absolutePath);
        const realRoot = fs.realpathSync(folder.uri.fsPath);
        if (!isCanonicalInsideRoot(realFile, realRoot)) {
          void vscode.window.showErrorMessage('Link target is outside the workspace folder.');
          return;
        }
        targetAbs = realFile;
        sourcePath = resolved.relativePath;
        sourceFolderUri = origin.document.sourceFolderUri;
        targetId = presentationIdFromFolderAndRelativePath(sourceFolderUri, sourcePath);
        title = titleFromMarkdownPath(targetAbs);
      } catch {
        void vscode.window.showErrorMessage('Could not open markdown link.');
        return;
      }
    } else {
      // Generated artifact without bound source: reject relative links; absolute
      // (file:/drive) must uniquely match exactly one workspace folder after realpath.
      const trimmedHref = hrefPath.trim();
      const isRelative =
        !/^file:/i.test(trimmedHref) &&
        !/^[A-Za-z]:[\\/]/.test(trimmedHref) &&
        !trimmedHref.startsWith('\\\\');
      // Leading `/` without file: is workspace-relative protocol → reject without source bind.
      if (isRelative || (trimmedHref.startsWith('/') && !/^file:/i.test(trimmedHref))) {
        void vscode.window.showErrorMessage(
          'Relative markdown links require a workspace-backed presentation source.',
        );
        return;
      }
      const folders =
        vscode.workspace.workspaceFolders?.map((f) => ({
          fsPath: f.uri.fsPath,
          uri: f.uri.toString(),
        })) ?? [];
      const matches: Array<{
        absolutePath: string;
        sourcePath: string;
        sourceFolderUri: string;
        presentationId: string;
        title: string;
      }> = [];
      for (const f of folders) {
        const target = resolveWorkspaceMarkdownPath(hrefPath, [f]);
        if (!target) continue;
        try {
          const realFile = fs.realpathSync(target.absolutePath);
          const realRoot = fs.realpathSync(f.fsPath);
          if (!isCanonicalInsideRoot(realFile, realRoot)) continue;
          matches.push({
            absolutePath: realFile,
            sourcePath: target.sourcePath,
            sourceFolderUri: target.sourceFolderUri,
            presentationId: target.presentationId,
            title: target.title,
          });
        } catch {
          // skip unreadable
        }
      }
      if (matches.length !== 1) {
        void vscode.window.showErrorMessage('Could not uniquely resolve markdown link.');
        return;
      }
      const only = matches[0];
      targetAbs = only.absolutePath;
      sourcePath = only.sourcePath;
      sourceFolderUri = only.sourceFolderUri;
      targetId = only.presentationId;
      title = only.title;
    }

    let markdown: string;
    try {
      markdown = clampPresentationMarkdown(fs.readFileSync(targetAbs!, 'utf8'));
    } catch {
      void vscode.window.showErrorMessage('Could not read markdown file.');
      return;
    }
    if (!markdown.trim()) {
      void vscode.window.showErrorMessage('Markdown file is empty.');
      return;
    }

    const result = await presentationManager.openWorkspaceDocument(origin.rootId, {
      presentationId: targetId!,
      ownerTaskId: origin.document.ownerTaskId,
      title: title!,
      markdown,
      kind: 'document',
      sourcePath,
      sourceFolderUri,
    });
    if (!result.ok) {
      void vscode.window.showErrorMessage('Could not open presentation.');
      return;
    }
    if (fragment) {
      presentationManager.navigateFragment(origin.rootId, targetId!, fragment);
    }
  };

  const presentationHandlers = {
    revealLinkedChat,
    openPresentationSource,
    openWorkspaceMarkdown: openWorkspaceMarkdownFromPresentation,
  };

  presentationManager = new PresentationManager(
    createPresentationPanelFactory(presentationHost, context.extensionUri, presentationHandlers),
  );
  presentationManager.setOwnerResolver((ownerTaskId) => {
    const file = taskStore?.getFile();
    const task = file?.tasks[ownerTaskId];
    if (!task) return undefined;
    let cur = task;
    while (cur.parentId) {
      const parent = file!.tasks[cur.parentId];
      if (!parent) break;
      cur = parent;
    }
    if (cur.role === 'coordinator' && cur.parentId === null) return cur.id;
    return undefined;
  });
  // Wire SQLite document store after engine load (below); provisional no-op until then.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(
      'muster.presentation',
      createPresentationPanelSerializer(
        presentationHost,
        context.extensionUri,
        presentationManager,
        presentationHandlers,
      ),
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

  if (liveUatEnabled) {
    registerLiveUatCommands(context);
  }

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
        const registered = await engine.registerAgentAsk(
          req.sessionId,
          req.questions,
          USER_INTERACTION_TIMEOUT_MS,
        );
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
        // Gate before UI register so non-root workers never surface to the user.
        if (form.sessionId && taskEngine && !taskEngine.mayDirectAskUser(form.sessionId)) {
          debugElicitation('host.elicitation_denied_non_root', {
            sessionId: form.sessionId,
          });
          return { action: 'cancel' as const };
        }
        const askLike = isAskLikeForm(form);
        const { promptId, promise } = eBridge.registerForm(
          key,
          form,
          askLike,
          USER_INTERACTION_TIMEOUT_MS,
        );
        debugElicitation('host.elicitation_waiting', {
          promptId,
          clientKey: key,
          sessionId: form.sessionId,
          askLike,
        });
        let waitTurnId: string | undefined;
        if (form.sessionId && taskEngine) {
          waitTurnId = (await taskEngine.beginElicitationWait(form.sessionId, promptId))?.turnId;
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
            await taskEngine.endElicitationWait(waitTurnId, promptId);
          }
          return result;
        } catch {
          if (waitTurnId && taskEngine) {
            await taskEngine.endElicitationWait(waitTurnId, promptId);
          }
          return { action: 'cancel' as const };
        }
      },
      promptUrl: async (urlReq, clientKey) => {
        const key = clientKey || 'muster-acp';
        if (urlReq.sessionId && taskEngine && !taskEngine.mayDirectAskUser(urlReq.sessionId)) {
          return { action: 'cancel' as const };
        }
        const { promise } = eBridge.registerUrl(key, urlReq, USER_INTERACTION_TIMEOUT_MS);
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

    const sqliteRepository = new SqliteTaskRepository(candidate, repositoryWorkspaceId());
    taskEngine = await TaskEngine.loadAsync({
      repository: sqliteRepository,
      workspaceId: repositoryWorkspaceId(),
      makeBackend,
      askBridge,
      credentialRegistry,
      bridgePort: port,
      getRunLimitMs: () =>
        runLimitMs(vscode.workspace.getConfiguration('muster.execution').get('runLimit')),
      isWorkspaceTrusted: () => vscode.workspace.isTrusted,
      // Host execution of a task's verification commands is OFF unless the USER
      // explicitly enables it — commands become host-authorized, not agent-triggerable.
      // Resolved LIVE per settle (callback), so toggling the setting OFF revokes host
      // execution immediately without a reload (verify-gate-loop ISSUE 13).
      allowHostVerification: () =>
        vscode.workspace
          .getConfiguration('muster')
          .get<boolean>('verification.hostRun', false),
      prepareHostEnvironment,
      getHostEnvironment,
      workspaceFolder: resolveTaskCwd(),
      getTaskTypeRegistry,
      // ACP skill invocation: read-only peek at the shared client's advertised
      // command set (keyed by backend id == AcpAgentConfig.key). Never spawns.
      getAdvertisedCommands: (backend: string) =>
        peekSharedAcpClient(backend)?.getAdvertisedCommands(),
      // Per-backend skill invocation prefix (`/` default, `$` for Codex). Kept in
      // backends/ so task/ never imports it; supplied to the engine via DI.
      getSkillPrefix: (backend: string) => skillPrefixForBackend(backend),
      onAfterCommit: (ctx) => provider.publishAfterCommit(ctx),
      emit: (event) => {
        try {
          provider.forwardTurnEvent(event);
        } catch {
          // best-effort streaming
        }
      },
    });
    // Share the engine's write-through projection wrapper with host commands so
    // every successful repository mutation is visible to synchronous UI selectors.
    taskStore = taskEngine.getReadModel();
    taskRepository = taskEngine.getRepository();
    presentationManager?.setDocumentStore({
      getPresentation: async (rootId, presentationId) => {
        const row = await taskRepository!.getPresentation(rootId, presentationId);
        if (!row) return undefined;
        return {
          presentationId: row.presentationId,
          ownerTaskId: row.ownerTaskId,
          revision: row.revision,
          title: row.title,
          markdown: row.markdown,
          ...(row.kind ? { kind: row.kind as 'plan' | 'spec' | 'document' } : {}),
          ...(row.summary ? { summary: row.summary } : {}),
          ...(row.changeSummary ? { changeSummary: row.changeSummary } : {}),
          ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}),
          ...(row.sourceFolderUri ? { sourceFolderUri: row.sourceFolderUri } : {}),
          ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
        };
      },
      putPresentation: async (document) => {
        const result = await taskRepository!.execute({
          kind: 'putPresentation',
          workspaceId: repositoryWorkspaceId(),
          document: {
            presentationId: document.presentationId,
            ownerTaskId: document.ownerTaskId,
            rootId: document.rootId,
            revision: document.revision,
            title: document.title,
            markdown: document.markdown,
            updatedAt: document.updatedAt,
            ...(document.summary ? { summary: document.summary } : {}),
            ...(document.changeSummary ? { changeSummary: document.changeSummary } : {}),
            ...(document.kind ? { kind: document.kind } : {}),
            ...(document.sourcePath ? { sourcePath: document.sourcePath } : {}),
            ...(document.sourceFolderUri ? { sourceFolderUri: document.sourceFolderUri } : {}),
          },
        });
        return result.changed === true;
      },
      commitPresentationOperation: async ({ operationKey, fingerprint, document }) => {
        const result = await taskRepository!.execute({
          kind: 'commitPresentationOperation',
          workspaceId: repositoryWorkspaceId(),
          operationKey,
          fingerprint,
          document: {
            presentationId: document.presentationId,
            ownerTaskId: document.ownerTaskId,
            rootId: document.rootId,
            revision: document.revision,
            title: document.title,
            markdown: document.markdown,
            updatedAt: document.updatedAt,
            ...(document.summary ? { summary: document.summary } : {}),
            ...(document.changeSummary ? { changeSummary: document.changeSummary } : {}),
            ...(document.kind ? { kind: document.kind } : {}),
            ...(document.sourcePath ? { sourcePath: document.sourcePath } : {}),
            ...(document.sourceFolderUri ? { sourceFolderUri: document.sourceFolderUri } : {}),
          },
        });
        if (!result.presentationStatus) {
          throw new Error('presentation commit returned no status');
        }
        return result.presentationStatus;
      },
    });
    scheduleRetention();
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        try {
          taskEngine?.onWorkspaceTrustGranted();
        } catch {
          // best-effort
        }
      }),
    );

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
    taskRepository = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Muster task engine disabled: ${message}`);
  }
}

/**
 * Live two-window UAT command surface. activate() calls this only for a
 * non-production Extension Host with MUSTER_UAT_MODE=1.
 */
function registerLiveUatCommands(context: vscode.ExtensionContext): void {
  const requireRepo = (): { repository: TaskRepository; workspaceId: string } => {
    if (!taskRepository || !sqliteWorkspaceId) {
      throw new Error('UAT repository unavailable');
    }
    return { repository: taskRepository, workspaceId: sqliteWorkspaceId };
  };

  const requireClient = (): DbClient => {
    if (!sqliteClient) {
      throw new Error('UAT sqlite client unavailable');
    }
    return sqliteClient;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(UAT_COMMANDS.ping, async () => {
      const extension = vscode.extensions.getExtension('tlelabs.muster');
      return {
        ok: true,
        role: process.env.MUSTER_UAT_ROLE ?? 'unknown',
        vscodeVersion: vscode.version,
        nodeVersion: process.versions.node,
        extensionActive: Boolean(extension?.isActive),
        sessionId: vscode.env.sessionId,
        remoteName: vscode.env.remoteName ?? 'desktop',
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
      };
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.identity, async () => {
      const { repository } = requireRepo();
      const client = requireClient();
      const dbPath = path.join(context.globalStorageUri.fsPath, 'muster.sqlite3');
      const { createHash } = await import('node:crypto');
      return readRedactedDbIdentity(
        repository,
        dbPath,
        (p) => {
          const stat = fs.statSync(p);
          return {
            size: stat.size,
            physicalIdentity: `${fs.realpathSync(p)}|${stat.dev}|${stat.ino}`,
          };
        },
        (input) => createHash('sha256').update(input).digest('hex').slice(0, 16),
        {
          pragma: (name) => client.pragma(name),
          get: <T>(sql: string, params?: unknown[]) =>
            client.get<T>(sql, params as never),
        },
      );
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.createTaskWithMessage, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return createTaskWithMessage(repository, workspaceId, args);
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.appendMessage, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return appendMessage(repository, workspaceId, args);
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.enqueueFollowUp, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return enqueueFollowUp(repository, workspaceId, args);
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.promoteFollowUp, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return promoteFollowUp(repository, workspaceId, String(args.turnId));
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.deleteMessage, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return deleteMessage(repository, workspaceId, String(args.messageId));
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.putSendOutbox, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return putSendOutbox(repository, workspaceId, args);
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.markSendOutboxRejected, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return markSendOutboxRejected(repository, workspaceId, String(args.clientRequestId));
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.putPresentation, async (args) => {
      const { repository, workspaceId } = requireRepo();
      return putPresentation(repository, workspaceId, args);
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.hostState, async () => {
      if (!uatChatProvider) {
        throw new Error('UAT chat provider unavailable');
      }
      return uatChatProvider.hostStateForUat();
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.forcePollingActive, async () => {
      if (!uatChatProvider) {
        throw new Error('UAT chat provider unavailable');
      }
      return uatChatProvider.forcePollingActiveForUat();
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.loadOlderTranscript, async (args) => {
      if (!uatChatProvider) {
        throw new Error('UAT chat provider unavailable');
      }
      return uatChatProvider.loadOlderTranscriptForUat(
        String(args.taskId),
        typeof args?.limit === 'number' ? args.limit : 2,
      );
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.focusTask, async (args) => {
      if (!uatChatProvider) {
        throw new Error('UAT chat provider unavailable');
      }
      const taskId =
        args?.taskId === null || args?.taskId === undefined
          ? undefined
          : String(args.taskId);
      return uatChatProvider.focusTaskForUat(taskId);
    }),
    vscode.commands.registerCommand(UAT_COMMANDS.readDurableSurfaces, async (args) => {
      const { repository } = requireRepo();
      return readDurableSurfaces(repository, {
        rootId: String(args.rootId),
        presentationId: String(args.presentationId),
      });
    }),
  );
}

export async function deactivate(): Promise<void> {
  try {
    await taskEngine?.shutdown();
  } catch {
    // Stream failures are already routed through durable turn settlement.
  }
  // provider is module-scoped only via registration; poller is stopped via
  // subscriptions. Clear repository so any late poll exits cleanly.
  taskRepository = undefined;
  try {
    chatProvider?.disposeRevisionPoller();
  } catch {
    // best-effort
  }
  chatProvider = undefined;
  uatChatProvider = undefined;
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
  musterDebugChannel?.dispose();
  musterDebugChannel = undefined;
}
