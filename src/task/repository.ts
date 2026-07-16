import type { TaskStore } from './store';
import type {
  CancelRequest,
  MusterTask,
  OperationLedgerEntry,
  PersistedReasoning,
  PersistedToolCall,
  SendReceipt,
  TaskDependency,
  TaskMessage,
  TaskStoreFile,
  TaskTurn,
  TurnInput,
  TurnStatus,
} from './types';
import { isMutatingTask, normalizedWritePaths } from './resources';
import { canPromoteTurn } from './scheduler';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { isTerminalLifecycle } from './transitions';
import { TRUNCATION_MARKER } from './retention';
import type { DbClient } from './sqlite/client';
import type { SqlStatement, SqlValue } from './sqlite/rpc';

/** Small page contract shared by the transitional adapters. Cursor encoding is
 * intentionally deferred to Phase 4, where transcript sort keys are finalized. */
export interface RepositoryPageRequest {
  limit?: number;
}

/** Cursor page returned by repository consumers. */
export interface RepositoryPage<T> {
  items: readonly T[];
  nextCursor?: string;
}

export type RepositoryTranscriptItem =
  | { id: string; kind: 'user' | 'assistant'; content: string; turnId?: string; order?: number; state?: TaskMessage['state']; createdAt?: string }
  | { id: string; kind: 'tool'; turnId: string; order: number; content: Record<string, unknown>; createdAt?: string }
  | { id: string; kind: 'reasoning'; turnId: string; content: string; createdAt?: string };

export interface TranscriptPage {
  items: readonly RepositoryTranscriptItem[];
  beforeCursor?: string;
  hasMoreBefore: boolean;
  workspaceRevision: number;
}

export interface RepositoryWorkspace {
  id: string;
  identityKey: string;
  displayName: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface RepositoryWorkspaceLocation {
  workspaceId: string;
  canonicalUri: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type RepositoryCommand =
  | {
      kind: 'upsertWorkspace'; workspaceId: string; identityKey: string;
      displayName: string; createdAt: string; lastOpenedAt: string;
    }
  | {
      kind: 'recordWorkspaceLocation'; workspaceId: string; canonicalUri: string;
      firstSeenAt: string; lastSeenAt: string;
    }
  | { kind: 'createTask'; workspaceId: string; task: MusterTask }
  /** Host create-and-run boundary: root, initial user message, first queued turn
   * and optional client receipt must become visible together. */
  | {
      kind: 'createRootAndInitialTurn'; workspaceId: string; task: MusterTask;
      message: TaskMessage; turn: TaskTurn; receipt?: SendReceipt;
    }
  | {
      /**
       * Host send/FIFO reservation boundary. The caller derives the next task
       * state from its transition rules, while the repository checks the prior
       * task revision and persists the task/message/turn/receipt together.
       */
      kind: 'enqueueMessageTurn'; workspaceId: string; expectedTaskRevision: number;
      maxTurnsPerTask: number; task: MusterTask; message: TaskMessage; turn: TaskTurn;
      receipt?: SendReceipt;
    }
  | {
      /** Retry allocation has no new user message, but task epoch/revision and
       * its queued retry turn must still commit together. */
      kind: 'retryTurn'; workspaceId: string; expectedTaskRevision: number;
      maxTurnsPerTask: number; task: MusterTask; turn: TaskTurn;
    }
  | { kind: 'upsertTask'; workspaceId: string; task: MusterTask }
  | { kind: 'deleteTask'; workspaceId: string; taskId: string }
  | { kind: 'createTurn'; workspaceId: string; turn: TaskTurn }
  | { kind: 'upsertTurn'; workspaceId: string; turn: TaskTurn }
  /** Replace a live turn only when its status/runtime binding still matches.
   * Used for dispatch markers, observed sessions and timeout fences. */
  | {
      kind: 'replaceLiveTurn'; workspaceId: string; turn: TaskTurn;
      expectedStatuses: readonly Extract<TurnStatus, 'running' | 'waiting_user'>[];
      expectedRuntimeEpoch?: number;
    }
  | {
      kind: 'recordAsk'; workspaceId: string; turn: TaskTurn;
      expectedRuntimeEpoch?: number;
    }
  | {
      kind: 'answerAsk'; workspaceId: string; turn: TaskTurn;
      expectedRuntimeEpoch?: number;
    }
  | { kind: 'deleteTurn'; workspaceId: string; turnId: string }
  | { kind: 'editQueuedMessage'; workspaceId: string; taskId: string; turnId: string; content: string }
  | { kind: 'deleteQueuedTurnAndMessages'; workspaceId: string; taskId: string; turnId: string }
  | { kind: 'clearQueuedTurnHold'; workspaceId: string; taskId: string; turnId: string }
  | { kind: 'appendMessage'; workspaceId: string; message: TaskMessage }
  | { kind: 'upsertMessage'; workspaceId: string; message: TaskMessage; updatedAt?: string }
  | { kind: 'deleteMessage'; workspaceId: string; messageId: string }
  | {
      kind: 'appendTranscriptBatch'; workspaceId: string; taskId: string;
      messages?: readonly TaskMessage[];
      toolCalls?: readonly PersistedToolCall[];
      reasoning?: readonly PersistedReasoning[];
    }
  | { kind: 'putOperation'; workspaceId: string; ledgerKey: string; entry: OperationLedgerEntry; createdAt: string }
  | {
      /** Insert once under the worker transaction; same key/fingerprint replays,
       * a different fingerprint is rejected without overwriting the first result. */
      kind: 'claimOperation'; workspaceId: string; ledgerKey: string;
      entry: OperationLedgerEntry; createdAt: string;
    }
  | { kind: 'deleteOperationsForTurn'; workspaceId: string; turnId: string }
  | { kind: 'putCancelRequest'; workspaceId: string; turnId: string; request: CancelRequest }
  | { kind: 'deleteCancelRequest'; workspaceId: string; turnId: string }
  | { kind: 'putSendReceipt'; workspaceId: string; receipt: SendReceipt }
  | { kind: 'deleteSendReceipt'; workspaceId: string; clientRequestId: string }
  | {
      /**
       * Final database-side scheduler gate. Callers may do richer readiness
       * projection first, but this command atomically enforces all contention
       * invariants (FIFO, limits, session and workspace resource claims).
       */
      kind: 'claimTurn'; workspaceId: string; turnId: string; startedAt: string;
      rootTaskId: string; maxConcurrentTurns: number; maxConcurrentPerRoot: number;
      maxConcurrentPerBackend: number; sessionId?: string; resourceKeys: readonly string[];
    }
  | {
      /**
       * The only transition that makes a queued turn dispatchable.  The engine
       * prepares the immutable prompt/input snapshot outside the transaction,
       * then this command re-checks scheduler eligibility while atomically
       * writing that snapshot, assigning its bound messages and taking the
       * session/resource claims.  No backend side effect may happen before a
       * successful result from this command.
       */
      kind: 'prepareDispatch'; workspaceId: string; expectedTaskRevision: number;
      task: MusterTask; turn: TaskTurn; messages: readonly TaskMessage[];
      startedAt: string; rootTaskId: string; maxConcurrentTurns: number;
      maxConcurrentPerRoot: number; maxConcurrentPerBackend: number;
      sessionId?: string; resourceKeys: readonly string[];
    }
  | { kind: 'promoteTurn'; workspaceId: string; turnId: string; startedAt: string }
  | {
      kind: 'settleTurn'; workspaceId: string; turnId: string;
      status: Extract<TurnStatus, 'succeeded' | 'failed' | 'interrupted' | 'cancelled'>;
      finishedAt: string; error?: string;
    }
  | {
      /** Atomic terminal transition plus the scheduler-visible side effects
       * derived by the engine (task result, held/retry turns and transcript
       * completion). Claim release is part of the same transaction. */
      kind: 'settleTurnAndApplyEffects'; workspaceId: string; expectedTaskRevision: number;
      task: MusterTask; turn: TaskTurn;
      expectedStatuses: readonly Extract<TurnStatus, 'running' | 'waiting_user'>[];
      relatedTurns: readonly TaskTurn[]; messages: readonly TaskMessage[];
    }
  | {
      /** Row-level retention; terminal tasks prune old turn chains, open tasks
       * only truncate settled rendered output. */
      kind: 'applyRetention'; workspaceId: string; taskId: string; keepLatestTurns: number;
      maxStoredOutputChars?: number;
    };

export interface RepositoryCommandResult {
  ok: true;
  changed?: boolean;
  /** A non-secret, UI-safe denial reason for a conditional command. */
  reason?: string;
  /** Present for operation-idempotency replay/claim commands. */
  operation?: OperationLedgerEntry;
  conflict?: boolean;
  /** Queue mutation result fields; absent for unrelated commands. */
  messageId?: string;
  deletedMessageIds?: readonly string[];
}

/**
 * Read-side boundary for task data.
 *
 * Phase 2 deliberately starts with queries only. Mutation commands are added as
 * named transactional operations once the JSON and SQLite implementations share
 * the same contract; callers must not receive a mutable store envelope.
 */
export interface TaskRepository {
  getWorkspace(): Promise<RepositoryWorkspace | undefined>;
  listWorkspaceLocations(): Promise<readonly RepositoryWorkspaceLocation[]>;
  getTask(taskId: string): Promise<MusterTask | undefined>;
  listTasks(workspaceId: string): Promise<readonly MusterTask[]>;
  listRootTasks(workspaceId: string, page?: RepositoryPageRequest): Promise<RepositoryPage<MusterTask>>;
  listSubtree(rootTaskId: string): Promise<readonly MusterTask[]>;
  getTurn(turnId: string): Promise<TaskTurn | undefined>;
  listTurns(taskId: string): Promise<readonly TaskTurn[]>;
  listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]>;
  listMessages(taskId: string): Promise<readonly TaskMessage[]>;
  listToolCalls(taskId: string): Promise<readonly PersistedToolCall[]>;
  listReasoning(taskId: string): Promise<readonly PersistedReasoning[]>;
  getOperation(ledgerKey: string): Promise<OperationLedgerEntry | undefined>;
  getCancelRequest(turnId: string): Promise<CancelRequest | undefined>;
  getSendReceipt(clientRequestId: string): Promise<SendReceipt | undefined>;
  getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage>;
  execute(command: RepositoryCommand): Promise<RepositoryCommandResult>;
  /** Compatibility-only export/migration view; never expose this to mutation code. */
  readEnvelopeForMigration(): Promise<Readonly<TaskStoreFile>>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Keep the host's first-send invariant in one place.  This command has no
 * partial-success form: a root task is either born with its first user message,
 * queued turn and receipt, or none of those rows is visible.
 */
function validateRootInitialTurn(
  command: Extract<RepositoryCommand, { kind: 'createRootAndInitialTurn' }>,
): string | undefined {
  const { task, message, turn, receipt } = command;
  if (task.parentId !== null) return 'initial task must be a root';
  if (message.taskId !== task.id) return 'initial message task mismatch';
  if (turn.taskId !== task.id) return 'initial turn task mismatch';
  if (!turn.inputs.some((input) => input.kind === 'message' && input.messageId === message.id)) {
    return 'initial turn must reference the initial message';
  }
  if (receipt && (receipt.taskId !== task.id || receipt.messageId !== message.id || receipt.turnId !== turn.id)) {
    return 'initial receipt references a different aggregate';
  }
  return undefined;
}

function validateEnqueueMessageTurn(
  command: Extract<RepositoryCommand, { kind: 'enqueueMessageTurn' }>,
): string | undefined {
  const { task, message, turn, receipt } = command;
  if (!Number.isInteger(command.maxTurnsPerTask) || command.maxTurnsPerTask < 1) {
    return 'max turns per task must be a positive integer';
  }
  if (message.taskId !== task.id) return 'queued message task mismatch';
  if (turn.taskId !== task.id) return 'queued turn task mismatch';
  if (!turn.inputs.some((input) => input.kind === 'message' && input.messageId === message.id)) {
    return 'queued turn must reference the queued message';
  }
  if (receipt && (receipt.taskId !== task.id || receipt.messageId !== message.id || receipt.turnId !== turn.id)) {
    return 'queued receipt references a different aggregate';
  }
  return undefined;
}

function validateRetryTurn(
  command: Extract<RepositoryCommand, { kind: 'retryTurn' }>,
): string | undefined {
  if (!Number.isInteger(command.maxTurnsPerTask) || command.maxTurnsPerTask < 1) {
    return 'max turns per task must be a positive integer';
  }
  if (command.turn.taskId !== command.task.id) return 'retry turn task mismatch';
  if (!command.turn.retryOf) return 'retry turn must reference an earlier turn';
  if ((command.turn.executionEpoch ?? 1) !== (command.task.executionEpoch ?? 1)) {
    return 'retry turn execution epoch mismatch';
  }
  return undefined;
}

function validatePrepareDispatch(
  command: Extract<RepositoryCommand, { kind: 'prepareDispatch' }>,
): string | undefined {
  if (command.turn.taskId !== command.task.id) return 'dispatch task/turn mismatch';
  if (!['queued', 'running', 'failed'].includes(command.turn.status)) {
    return 'dispatch turn has an unsupported status';
  }
  if (!Number.isInteger(command.expectedTaskRevision) || command.expectedTaskRevision < 0) {
    return 'dispatch expected task revision is invalid';
  }
  for (const message of command.messages) {
    if (message.taskId !== command.task.id) return 'dispatch message task mismatch';
    if (message.turnId !== command.turn.id) return 'dispatch message turn mismatch';
  }
  return undefined;
}

function truncateRetentionContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/** Keep the newest turns, then include every retry ancestor so a retained retry
 * is never left pointing at a deleted predecessor. */
function retainedTurnIds(turns: readonly TaskTurn[], keepLatestTurns: number): Set<string> {
  const keep = new Set(
    [...turns]
      .sort((a, b) => b.sequence - a.sequence || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, Math.floor(keepLatestTurns)))
      .map((turn) => turn.id),
  );
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const pending = [...keep];
  while (pending.length > 0) {
    const turn = byId.get(pending.pop()!);
    if (turn?.retryOf && !keep.has(turn.retryOf) && byId.has(turn.retryOf)) {
      keep.add(turn.retryOf);
      pending.push(turn.retryOf);
    }
  }
  return keep;
}

/** True when `candidateId` is a child/grandchild of `ancestorId`. Cycles are
 * treated as non-descendant after the first repeated node, matching the SQLite
 * recursive CTE's UNION de-duplication. */
function isDescendantOf(
  tasks: Readonly<Record<string, MusterTask>>,
  candidateId: string,
  ancestorId: string,
): boolean {
  const seen = new Set<string>();
  let current = tasks[candidateId];
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) return true;
    current = tasks[current.parentId];
  }
  return false;
}

/**
 * Compatibility adapter over the current JSON TaskStore.
 *
 * Returning cloned values makes accidental mutation fail closed: changing a DTO
 * returned by a repository query cannot silently mutate TaskStore's in-memory file.
 */
export class JsonTaskRepository implements TaskRepository {
  /** JSON stores are currently one-workspace-per-file; SQLite adds explicit workspace IDs. */
  constructor(private readonly store: TaskStore, private readonly workspaceId?: string) {}

  async getWorkspace(): Promise<RepositoryWorkspace | undefined> {
    // JSON stores predate the workspace registry. Returning undefined makes this
    // limitation explicit instead of manufacturing an unstable identity.
    return undefined;
  }

  async listWorkspaceLocations(): Promise<readonly RepositoryWorkspaceLocation[]> {
    return [];
  }

  async getTask(taskId: string): Promise<MusterTask | undefined> {
    const task = this.store.getFile().tasks[taskId];
    return task ? clone(task) : undefined;
  }

  async listTasks(workspaceId: string): Promise<readonly MusterTask[]> {
    if (this.workspaceId !== undefined && this.workspaceId !== workspaceId) return [];
    return Object.values(this.store.getFile().tasks)
      .map((task) => clone(task));
  }

  async listRootTasks(workspaceId: string, page: RepositoryPageRequest = {}): Promise<RepositoryPage<MusterTask>> {
    const tasks = (await this.listTasks(workspaceId)).filter((task) => task.parentId === null);
    return { items: tasks.slice(0, normalizeLimit(page.limit)) };
  }

  async listSubtree(rootTaskId: string): Promise<readonly MusterTask[]> {
    const all = Object.values(this.store.getFile().tasks);
    const result: MusterTask[] = [];
    const pending = [rootTaskId];
    while (pending.length > 0) {
      const id = pending.shift()!;
      const task = all.find((candidate) => candidate.id === id);
      if (!task || result.some((candidate) => candidate.id === task.id)) continue;
      result.push(clone(task));
      for (const child of all) {
        if (child.parentId === id) pending.push(child.id);
      }
    }
    return result;
  }

  async listTurns(taskId: string): Promise<readonly TaskTurn[]> {
    return Object.values(this.store.getFile().turns)
      .filter((turn) => turn.taskId === taskId)
      .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt))
      .map((turn) => clone(turn));
  }

  async getTurn(turnId: string): Promise<TaskTurn | undefined> {
    const turn = this.store.getFile().turns[turnId];
    return turn ? clone(turn) : undefined;
  }

  async listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]> {
    return (await this.listTurns(taskId)).filter((turn) => turn.status === 'queued');
  }

  async listMessages(taskId: string): Promise<readonly TaskMessage[]> {
    return Object.values(this.store.getFile().messages)
      .filter((message) => message.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((message) => clone(message));
  }

  async listToolCalls(taskId: string): Promise<readonly PersistedToolCall[]> {
    return Object.values(this.store.getFile().toolCalls ?? {})
      .filter((tool) => tool.taskId === taskId)
      .sort((a, b) => a.turnId.localeCompare(b.turnId) || a.order - b.order || a.id.localeCompare(b.id))
      .map((tool) => clone(tool));
  }

  async listReasoning(taskId: string): Promise<readonly PersistedReasoning[]> {
    return Object.values(this.store.getFile().reasoning ?? {})
      .filter((reasoning) => reasoning.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((reasoning) => clone(reasoning));
  }

  async getOperation(ledgerKey: string): Promise<OperationLedgerEntry | undefined> {
    const entry = this.store.getFile().operations?.[ledgerKey];
    return entry ? clone(entry) : undefined;
  }

  async getCancelRequest(turnId: string): Promise<CancelRequest | undefined> {
    const request = this.store.getFile().cancelRequests?.[turnId];
    return request ? clone(request) : undefined;
  }

  async getSendReceipt(clientRequestId: string): Promise<SendReceipt | undefined> {
    const receipt = this.store.getFile().sendReceipts?.[clientRequestId];
    return receipt ? clone(receipt) : undefined;
  }

  async getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage> {
    const file = this.store.getFile();
    const items = composeTranscript(
      Object.values(file.turns).filter((turn) => turn.taskId === taskId),
      Object.values(file.messages).filter((message) => message.taskId === taskId),
      Object.values(file.toolCalls ?? {}).filter((tool) => tool.taskId === taskId),
      Object.values(file.reasoning ?? {}).filter((reasoning) => reasoning.taskId === taskId),
    );
    return pageTranscript(items, Object.values(file.turns).filter((turn) => turn.taskId === taskId), cursor, limit, file.revision);
  }

  async readEnvelopeForMigration(): Promise<Readonly<TaskStoreFile>> {
    return clone(this.store.getFile());
  }

  async execute(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (this.workspaceId !== undefined && this.workspaceId !== command.workspaceId) {
      throw new Error('repository workspace mismatch');
    }
    let changed = false;
    let operation: OperationLedgerEntry | undefined;
    let messageId: string | undefined;
    let deletedMessageIds: string[] | undefined;
    const result = this.store.commit((draft) => {
      switch (command.kind) {
        case 'upsertWorkspace':
        case 'recordWorkspaceLocation':
          // A legacy JSON file is intrinsically scoped to its one workspace.
          // The compatibility adapter has nowhere durable to put registry data,
          // but accepting these commands keeps its domain contract useful while
          // cutover remains SQLite-only.
          return { ok: true };
        case 'createTask':
          if (draft.tasks[command.task.id]) return { ok: false, reason: 'task already exists' };
          draft.tasks[command.task.id] = clone(command.task);
          changed = true;
          return { ok: true };
        case 'createRootAndInitialTurn': {
          const invalid = validateRootInitialTurn(command);
          if (invalid) return { ok: false, reason: invalid };
          if (draft.tasks[command.task.id]) return { ok: false, reason: 'task already exists' };
          if (draft.turns[command.turn.id]) return { ok: false, reason: 'turn already exists' };
          if (draft.messages[command.message.id]) return { ok: false, reason: 'message already exists' };
          if (command.receipt && draft.sendReceipts?.[command.receipt.clientRequestId]) {
            return { ok: false, reason: 'send receipt already exists' };
          }
          draft.tasks[command.task.id] = clone(command.task);
          draft.turns[command.turn.id] = clone(command.turn);
          draft.messages[command.message.id] = clone(command.message);
          if (command.receipt) {
            draft.sendReceipts = draft.sendReceipts ?? {};
            draft.sendReceipts[command.receipt.clientRequestId] = clone(command.receipt);
          }
          changed = true;
          return { ok: true };
        }
        case 'enqueueMessageTurn': {
          const invalid = validateEnqueueMessageTurn(command);
          if (invalid) return { ok: false, reason: invalid };
          const current = draft.tasks[command.task.id];
          if (!current) return { ok: false, reason: 'task not found' };
          if (current.revision !== command.expectedTaskRevision) return { ok: false, reason: 'task changed; retry' };
          if (draft.turns[command.turn.id]) return { ok: false, reason: 'turn already exists' };
          if (draft.messages[command.message.id]) return { ok: false, reason: 'message already exists' };
          if (command.receipt && draft.sendReceipts?.[command.receipt.clientRequestId]) {
            return { ok: false, reason: 'send receipt already exists' };
          }
          const epoch = command.task.executionEpoch ?? 1;
          const cap = Math.min(command.maxTurnsPerTask, current.executionPolicy.maxTurns);
          const slotsUsed = Object.values(draft.turns).filter(
            (candidate) => candidate.taskId === current.id && (candidate.executionEpoch ?? 1) === epoch,
          ).length;
          if (slotsUsed >= cap) return { ok: false, reason: 'max turns per task exceeded' };
          if ((command.turn.executionEpoch ?? 1) !== (command.task.executionEpoch ?? 1)) {
            return { ok: false, reason: 'queued turn execution epoch mismatch' };
          }
          draft.tasks[command.task.id] = clone(command.task);
          draft.turns[command.turn.id] = clone(command.turn);
          draft.messages[command.message.id] = clone(command.message);
          if (command.receipt) {
            draft.sendReceipts = draft.sendReceipts ?? {};
            draft.sendReceipts[command.receipt.clientRequestId] = clone(command.receipt);
          }
          changed = true;
          return { ok: true };
        }
        case 'retryTurn': {
          const invalid = validateRetryTurn(command);
          if (invalid) return { ok: false, reason: invalid };
          const current = draft.tasks[command.task.id];
          if (!current) return { ok: false, reason: 'task not found' };
          if (current.revision !== command.expectedTaskRevision) return { ok: false, reason: 'task changed; retry' };
          if (draft.turns[command.turn.id]) return { ok: false, reason: 'turn already exists' };
          const epoch = command.task.executionEpoch ?? 1;
          const cap = Math.min(command.maxTurnsPerTask, current.executionPolicy.maxTurns);
          const slotsUsed = Object.values(draft.turns).filter(
            (candidate) => candidate.taskId === current.id && (candidate.executionEpoch ?? 1) === epoch,
          ).length;
          if (slotsUsed >= cap) return { ok: false, reason: 'max turns per task exceeded' };
          draft.tasks[command.task.id] = clone(command.task);
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        }
        case 'upsertTask':
          draft.tasks[command.task.id] = clone(command.task);
          changed = true;
          return { ok: true };
        case 'deleteTask':
          if (!draft.tasks[command.taskId]) return { ok: true };
          // JSON compatibility preserves the database cascade semantics.
          for (const [id, task] of Object.entries(draft.tasks)) {
            if (task.id === command.taskId || isDescendantOf(draft.tasks, task.id, command.taskId)) {
              delete draft.tasks[id];
              for (const [turnId, turn] of Object.entries(draft.turns)) {
                if (turn.taskId === task.id) delete draft.turns[turnId];
              }
              for (const [messageId, message] of Object.entries(draft.messages)) {
                if (message.taskId === task.id) delete draft.messages[messageId];
              }
              for (const [toolId, tool] of Object.entries(draft.toolCalls ?? {})) {
                if (tool.taskId === task.id) delete draft.toolCalls?.[toolId];
              }
              for (const [reasoningId, reasoning] of Object.entries(draft.reasoning ?? {})) {
                if (reasoning.taskId === task.id) delete draft.reasoning?.[reasoningId];
              }
            }
          }
          changed = true;
          return { ok: true };
        case 'createTurn':
          if (draft.turns[command.turn.id]) return { ok: false, reason: 'turn already exists' };
          if (!draft.tasks[command.turn.taskId]) return { ok: false, reason: 'task not found' };
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        case 'upsertTurn':
          if (!draft.tasks[command.turn.taskId]) return { ok: false, reason: 'task not found' };
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        case 'replaceLiveTurn': {
          if (command.expectedStatuses.length === 0) return { ok: false, reason: 'expected live status required' };
          const existing = draft.turns[command.turn.id];
          const task = existing ? draft.tasks[existing.taskId] : undefined;
          if (!existing || !task || !command.expectedStatuses.includes(existing.status as never)) {
            return { ok: false, reason: 'turn is no longer live' };
          }
          if (
            command.expectedRuntimeEpoch !== undefined &&
            (existing.runtimeEpoch ?? 1) !== command.expectedRuntimeEpoch ||
            command.expectedRuntimeEpoch !== undefined &&
            (task.runtimeEpoch ?? 1) !== command.expectedRuntimeEpoch
          ) {
            return { ok: false, reason: 'runtime binding was superseded' };
          }
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        }
        case 'recordAsk': {
          const existing = draft.turns[command.turn.id];
          const task = existing ? draft.tasks[existing.taskId] : undefined;
          if (!existing || !task || (existing.status !== 'running' && existing.status !== 'waiting_user')) {
            return { ok: false, reason: 'turn is no longer live' };
          }
          if (command.expectedRuntimeEpoch !== undefined && (task.runtimeEpoch ?? 1) !== command.expectedRuntimeEpoch) {
            return { ok: false, reason: 'runtime binding was superseded' };
          }
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        }
        case 'answerAsk': {
          const existing = draft.turns[command.turn.id];
          const task = existing ? draft.tasks[existing.taskId] : undefined;
          if (!existing || !task || existing.status !== 'waiting_user') {
            return { ok: false, reason: 'turn is not waiting for user' };
          }
          if (command.expectedRuntimeEpoch !== undefined && (task.runtimeEpoch ?? 1) !== command.expectedRuntimeEpoch) {
            return { ok: false, reason: 'runtime binding was superseded' };
          }
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        }
        case 'deleteTurn':
          if (!draft.turns[command.turnId]) return { ok: true };
          delete draft.turns[command.turnId];
          for (const [messageId, message] of Object.entries(draft.messages)) {
            if (message.turnId === command.turnId) delete draft.messages[messageId];
          }
          for (const [toolId, tool] of Object.entries(draft.toolCalls ?? {})) {
            if (tool.turnId === command.turnId) delete draft.toolCalls?.[toolId];
          }
          delete draft.reasoning?.[command.turnId];
          delete draft.cancelRequests?.[command.turnId];
          for (const ledgerKey of Object.keys(draft.operations ?? {})) {
            if (ledgerKey.startsWith(`${command.turnId}:`)) delete draft.operations?.[ledgerKey];
          }
          changed = true;
          return { ok: true };
        case 'editQueuedMessage': {
          const turn = draft.turns[command.turnId];
          if (!turn) return { ok: false, reason: 'turn not found' };
          if (turn.taskId !== command.taskId) return { ok: false, reason: 'turn does not belong to task' };
          if (turn.status !== 'queued') return { ok: false, reason: 'turn is not queued' };
          const inputMessageIds = turn.inputs
            .filter((input): input is Extract<TurnInput, { kind: 'message' }> => input.kind === 'message')
            .map((input) => input.messageId);
          if (inputMessageIds.length === 0) return { ok: false, reason: 'message not found' };
          for (const id of inputMessageIds) {
            const message = draft.messages[id];
            if (!message || message.taskId !== command.taskId || message.role !== 'user' || message.state !== 'pending') {
              return { ok: false, reason: 'message is not pending' };
            }
          }
          const target = draft.messages[inputMessageIds[0]!];
          const { agentContent: _staleAgentContent, ...rest } = target!;
          void _staleAgentContent;
          draft.messages[inputMessageIds[0]!] = { ...rest, content: command.content };
          messageId = inputMessageIds[0]!;
          changed = true;
          return { ok: true };
        }
        case 'deleteQueuedTurnAndMessages': {
          const turn = draft.turns[command.turnId];
          if (!turn) return { ok: false, reason: 'turn not found' };
          if (turn.taskId !== command.taskId) return { ok: false, reason: 'turn does not belong to task' };
          if (turn.status !== 'queued') return { ok: false, reason: 'turn is not queued' };
          const messageIds = turn.inputs
            .filter((input): input is Extract<TurnInput, { kind: 'message' }> => input.kind === 'message')
            .map((input) => input.messageId);
          for (const id of messageIds) {
            const message = draft.messages[id];
            if (!message || message.taskId !== command.taskId || message.role !== 'user' || message.state !== 'pending') {
              return { ok: false, reason: 'message is not pending' };
            }
          }
          for (const id of messageIds) delete draft.messages[id];
          delete draft.turns[turn.id];
          deletedMessageIds = messageIds;
          changed = true;
          return { ok: true };
        }
        case 'clearQueuedTurnHold': {
          const turn = draft.turns[command.turnId];
          if (!turn) return { ok: false, reason: 'turn not found' };
          if (turn.taskId !== command.taskId) return { ok: false, reason: 'turn does not belong to task' };
          if (turn.status !== 'queued') return { ok: false, reason: 'turn is not queued' };
          if (!turn.holdAutoPromote) return { ok: true };
          const { holdAutoPromote: _hold, ...rest } = turn;
          void _hold;
          draft.turns[turn.id] = rest;
          changed = true;
          return { ok: true };
        }
        case 'appendMessage':
          if (draft.messages[command.message.id]) return { ok: false, reason: 'message already exists' };
          if (!draft.tasks[command.message.taskId]) return { ok: false, reason: 'task not found' };
          draft.messages[command.message.id] = clone(command.message);
          changed = true;
          return { ok: true };
        case 'upsertMessage':
          if (!draft.tasks[command.message.taskId]) return { ok: false, reason: 'task not found' };
          draft.messages[command.message.id] = clone(command.message);
          changed = true;
          return { ok: true };
        case 'deleteMessage':
          if (draft.messages[command.messageId]) {
            delete draft.messages[command.messageId];
            changed = true;
          }
          return { ok: true };
        case 'appendTranscriptBatch': {
          if (!draft.tasks[command.taskId]) return { ok: false, reason: 'task not found' };
          for (const message of command.messages ?? []) {
            if (message.taskId !== command.taskId) return { ok: false, reason: 'message task mismatch' };
            draft.messages[message.id] = clone(message);
          }
          draft.toolCalls = draft.toolCalls ?? {};
          for (const tool of command.toolCalls ?? []) {
            if (tool.taskId !== command.taskId) return { ok: false, reason: 'tool call task mismatch' };
            draft.toolCalls[tool.id] = clone(tool);
          }
          draft.reasoning = draft.reasoning ?? {};
          for (const reasoning of command.reasoning ?? []) {
            if (reasoning.taskId !== command.taskId) return { ok: false, reason: 'reasoning task mismatch' };
            draft.reasoning[reasoning.id] = clone(reasoning);
          }
          changed = (command.messages?.length ?? 0) + (command.toolCalls?.length ?? 0) + (command.reasoning?.length ?? 0) > 0;
          return { ok: true };
        }
        case 'putOperation':
          draft.operations = draft.operations ?? {};
          draft.operations[command.ledgerKey] = clone(command.entry);
          changed = true;
          return { ok: true };
        case 'claimOperation': {
          draft.operations = draft.operations ?? {};
          const existing = draft.operations[command.ledgerKey];
          if (existing) {
            operation = clone(existing);
            if (existing.fingerprint !== command.entry.fingerprint) {
              return { ok: false, reason: 'operation fingerprint conflict' };
            }
            return { ok: true };
          }
          draft.operations[command.ledgerKey] = clone(command.entry);
          operation = clone(command.entry);
          changed = true;
          return { ok: true };
        }
        case 'deleteOperationsForTurn': {
          let deleted = false;
          for (const key of Object.keys(draft.operations ?? {})) {
            if (key.startsWith(`${command.turnId}:`)) {
              delete draft.operations?.[key];
              deleted = true;
            }
          }
          changed = deleted;
          return { ok: true };
        }
        case 'putCancelRequest':
          if (!draft.turns[command.turnId]) return { ok: false, reason: 'turn not found' };
          draft.cancelRequests = draft.cancelRequests ?? {};
          draft.cancelRequests[command.turnId] = clone(command.request);
          changed = true;
          return { ok: true };
        case 'deleteCancelRequest':
          if (draft.cancelRequests?.[command.turnId]) {
            delete draft.cancelRequests[command.turnId];
            changed = true;
          }
          return { ok: true };
        case 'putSendReceipt':
          draft.sendReceipts = draft.sendReceipts ?? {};
          draft.sendReceipts[command.receipt.clientRequestId] = clone(command.receipt);
          changed = true;
          return { ok: true };
        case 'deleteSendReceipt':
          if (draft.sendReceipts?.[command.clientRequestId]) {
            delete draft.sendReceipts[command.clientRequestId];
            changed = true;
          }
          return { ok: true };
        case 'claimTurn': {
          const check = canPromoteTurn(draft, command.turnId, {
            ...DEFAULT_RESOURCE_LIMITS,
            maxConcurrentTurns: command.maxConcurrentTurns,
            maxConcurrentPerRoot: command.maxConcurrentPerRoot,
            maxConcurrentPerBackend: command.maxConcurrentPerBackend,
          });
          if (!check.ok) return { ok: false, reason: check.reason };
          const turn = draft.turns[command.turnId]!;
          draft.turns[command.turnId] = { ...turn, status: 'running', startedAt: command.startedAt };
          changed = true;
          return { ok: true };
        }
        case 'prepareDispatch': {
          const invalid = validatePrepareDispatch(command);
          if (invalid) return { ok: false, reason: invalid };
          const currentTask = draft.tasks[command.task.id];
          const currentTurn = draft.turns[command.turn.id];
          if (!currentTask || !currentTurn) return { ok: false, reason: 'task or turn not found' };
          if (currentTask.revision !== command.expectedTaskRevision) {
            return { ok: false, reason: 'task changed before dispatch' };
          }
          if (currentTurn.status !== 'queued') return { ok: false, reason: 'turn is no longer queued' };
          if (command.turn.status === 'running') {
            const check = canPromoteTurn(draft, command.turn.id, {
              ...DEFAULT_RESOURCE_LIMITS,
              maxConcurrentTurns: command.maxConcurrentTurns,
              maxConcurrentPerRoot: command.maxConcurrentPerRoot,
              maxConcurrentPerBackend: command.maxConcurrentPerBackend,
            });
            if (!check.ok) return { ok: false, reason: check.reason };
          }
          draft.tasks[command.task.id] = clone(command.task);
          draft.turns[command.turn.id] = clone(command.turn);
          for (const message of command.messages) {
            draft.messages[message.id] = clone(message);
          }
          changed = true;
          return { ok: true };
        }
        case 'promoteTurn': {
          const turn = draft.turns[command.turnId];
          if (!turn || turn.status !== 'queued') return { ok: true };
          turn.status = 'running';
          turn.startedAt = command.startedAt;
          changed = true;
          return { ok: true };
        }
        case 'applyRetention': {
          const task = draft.tasks[command.taskId];
          if (!task) return { ok: true };
          if (isTerminalLifecycle(task.lifecycle)) {
            const turns = Object.values(draft.turns).filter((turn) => turn.taskId === task.id);
            const keep = retainedTurnIds(turns, command.keepLatestTurns);
            const retained = turns.filter((turn) => !keep.has(turn.id));
            const dropped = new Set(retained.map((turn) => turn.id));
            for (const turn of retained) {
              delete draft.turns[turn.id];
              for (const [messageId, message] of Object.entries(draft.messages)) {
                if (message.turnId === turn.id) delete draft.messages[messageId];
              }
              for (const [toolId, tool] of Object.entries(draft.toolCalls ?? {})) {
                if (tool.turnId === turn.id) delete draft.toolCalls?.[toolId];
              }
              delete draft.reasoning?.[turn.id];
              delete draft.cancelRequests?.[turn.id];
              for (const key of Object.keys(draft.operations ?? {})) {
                if (key.startsWith(`${turn.id}:`)) delete draft.operations?.[key];
              }
            }
            // User messages do not necessarily have turnId, so remove only rows
            // no retained turn still references through its input list.
            const referencedMessages = new Set(
              Object.values(draft.turns)
                .filter((turn) => turn.taskId === task.id)
                .flatMap((turn) => turn.inputs)
                .filter((input): input is Extract<TurnInput, { kind: 'message' }> => input.kind === 'message')
                .map((input) => input.messageId),
            );
            for (const [messageId, message] of Object.entries(draft.messages)) {
              if (message.taskId === task.id && !message.turnId && !referencedMessages.has(messageId)) {
                delete draft.messages[messageId];
              }
            }
            changed = dropped.size > 0;
            return { ok: true };
          }
          const maxChars = Math.max(0, Math.floor(command.maxStoredOutputChars ?? Number.MAX_SAFE_INTEGER));
          for (const message of Object.values(draft.messages)) {
            if (message.taskId === task.id && message.role === 'assistant' && message.state === 'complete') {
              const content = truncateRetentionContent(message.content, maxChars);
              if (content !== message.content) {
                draft.messages[message.id] = { ...message, content };
                changed = true;
              }
            }
          }
          for (const tool of Object.values(draft.toolCalls ?? {})) {
            if (tool.taskId === task.id && typeof tool.output === 'string') {
              const output = truncateRetentionContent(tool.output, maxChars);
              if (output !== tool.output) {
                draft.toolCalls![tool.id] = { ...tool, output };
                changed = true;
              }
            }
          }
          for (const reasoning of Object.values(draft.reasoning ?? {})) {
            if (reasoning.taskId === task.id) {
              const content = truncateRetentionContent(reasoning.content, maxChars);
              if (content !== reasoning.content) {
                draft.reasoning![reasoning.id] = { ...reasoning, content };
                changed = true;
              }
            }
          }
          return { ok: true };
        }
        case 'settleTurn': {
          const turn = draft.turns[command.turnId];
          if (!turn || (turn.status !== 'running' && turn.status !== 'waiting_user')) return { ok: true };
          turn.status = command.status;
          turn.finishedAt = command.finishedAt;
          turn.error = command.error;
          changed = true;
          return { ok: true };
        }
        case 'settleTurnAndApplyEffects': {
          if (command.expectedStatuses.length === 0) return { ok: false, reason: 'expected live status required' };
          const current = draft.turns[command.turn.id];
          const currentTask = current ? draft.tasks[current.taskId] : undefined;
          if (!current || !currentTask || !command.expectedStatuses.includes(current.status as never)) {
            return { ok: false, reason: 'turn is no longer live' };
          }
          if (currentTask.revision !== command.expectedTaskRevision) {
            return { ok: false, reason: 'task changed before settlement' };
          }
          draft.tasks[command.task.id] = clone(command.task);
          draft.turns[command.turn.id] = clone(command.turn);
          for (const turn of command.relatedTurns) draft.turns[turn.id] = clone(turn);
          for (const message of command.messages) draft.messages[message.id] = clone(message);
          delete draft.cancelRequests?.[command.turn.id];
          changed = true;
          return { ok: true };
        }
        default: {
          const _exhaustive: never = command;
          return _exhaustive;
        }
      }
    });
    if (!result.ok) {
      if (result.reason === 'rejected') {
        return {
          ok: true,
          changed: false,
          reason: result.detail ?? 'repository command rejected',
          ...(command.kind === 'claimOperation' ? { conflict: true, operation } : {}),
        };
      }
      throw new Error(result.detail ?? 'repository command rejected');
    }
    return {
      ok: true,
      changed,
      ...(command.kind === 'claimOperation' && operation ? { operation } : {}),
      ...(messageId ? { messageId } : {}),
      ...(deletedMessageIds ? { deletedMessageIds } : {}),
    };
  }
}

/** SQLite row-level implementation. Every write is a short worker-owned
 * transaction; stream writes update only the affected rows. */
export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async getWorkspace(): Promise<RepositoryWorkspace | undefined> {
    const row = await this.db.get<WorkspaceRow>(
      `SELECT id, identity_key, display_name, created_at, last_opened_at
         FROM workspaces WHERE id = ?`,
      [this.workspaceId],
    );
    return row ? decodeWorkspace(row) : undefined;
  }

  async listWorkspaceLocations(): Promise<readonly RepositoryWorkspaceLocation[]> {
    const rows = await this.db.all<WorkspaceLocationRow>(
      `SELECT workspace_id, canonical_uri, first_seen_at, last_seen_at
         FROM workspace_locations WHERE workspace_id = ? ORDER BY canonical_uri`,
      [this.workspaceId],
    );
    return rows.map(decodeWorkspaceLocation);
  }

  private async hydrateTasks(rows: readonly TaskRow[]): Promise<MusterTask[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const dependencies = await this.db.all<DependencyRow>(
      `SELECT task_id, dependency_task_id, required_outcome, on_unsatisfied, required_verdict
         FROM task_dependencies
        WHERE workspace_id = ? AND task_id IN (${placeholders(ids.length)})
        ORDER BY task_id, dependency_task_id`,
      [this.workspaceId, ...ids],
    );
    const byTask = new Map<string, TaskDependency[]>();
    for (const dependency of dependencies) {
      const list = byTask.get(dependency.task_id) ?? [];
      list.push(decodeDependency(dependency));
      byTask.set(dependency.task_id, list);
    }
    return rows.map((row) => decodeTask(row, byTask.get(row.id)));
  }

  private async hydrateTurns(rows: readonly TurnRow[]): Promise<TaskTurn[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const inputRows = await this.db.all<TurnInputRow>(
      `SELECT turn_id, ordering, kind, payload_json
         FROM turn_inputs
        WHERE workspace_id = ? AND turn_id IN (${placeholders(ids.length)})
        ORDER BY turn_id, ordering`,
      [this.workspaceId, ...ids],
    );
    const byTurn = new Map<string, TurnInput[]>();
    for (const input of inputRows) {
      const list = byTurn.get(input.turn_id) ?? [];
      list.push(decodeTurnInput(input));
      byTurn.set(input.turn_id, list);
    }
    return rows.map((row) => decodeTurn(row, byTurn.get(row.id)));
  }

  async getTask(taskId: string): Promise<MusterTask | undefined> {
    const row = await this.db.get<TaskRow>(taskSelect('WHERE workspace_id = ? AND id = ?'), [this.workspaceId, taskId]);
    return row ? (await this.hydrateTasks([row]))[0] : undefined;
  }

  async listTasks(workspaceId: string): Promise<readonly MusterTask[]> {
    if (workspaceId !== this.workspaceId) return [];
    const rows = await this.db.all<TaskRow>(`${taskSelect('WHERE workspace_id = ?')} ORDER BY created_at, id`, [workspaceId]);
    return this.hydrateTasks(rows);
  }

  async listRootTasks(workspaceId: string, page: RepositoryPageRequest = {}): Promise<RepositoryPage<MusterTask>> {
    if (workspaceId !== this.workspaceId) return { items: [] };
    const rows = await this.db.all<TaskRow>(
      `${taskSelect('WHERE workspace_id = ? AND parent_id IS NULL')} ORDER BY created_at, id LIMIT ?`,
      [workspaceId, normalizeLimit(page.limit)],
    );
    return { items: await this.hydrateTasks(rows) };
  }

  async listSubtree(rootTaskId: string): Promise<readonly MusterTask[]> {
    const rows = await this.db.all<TaskRow>(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE workspace_id = ? AND id = ?
         UNION
         SELECT child.id FROM tasks child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = ?
       )
       SELECT t.id, t.workspace_id, t.parent_id, t.role, t.lifecycle, t.release_state, t.goal, t.backend,
              t.model, t.revision, t.created_at, t.updated_at, t.payload_json
         FROM tasks t JOIN subtree s ON s.id = t.id
        WHERE t.workspace_id = ?
        ORDER BY t.created_at, t.id`,
      [this.workspaceId, rootTaskId, this.workspaceId, this.workspaceId],
    );
    return this.hydrateTasks(rows);
  }

  async listTurns(taskId: string): Promise<readonly TaskTurn[]> {
    const rows = await this.db.all<TurnRow>(
      `${turnSelect('WHERE workspace_id = ? AND task_id = ?')} ORDER BY sequence, created_at, id`,
      [this.workspaceId, taskId],
    );
    return this.hydrateTurns(rows);
  }

  async getTurn(turnId: string): Promise<TaskTurn | undefined> {
    const row = await this.db.get<TurnRow>(
      turnSelect('WHERE workspace_id = ? AND id = ?'),
      [this.workspaceId, turnId],
    );
    return row ? (await this.hydrateTurns([row]))[0] : undefined;
  }

  async listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]> {
    const rows = await this.db.all<TurnRow>(
      `${turnSelect("WHERE workspace_id = ? AND task_id = ? AND status = 'queued'")} ORDER BY sequence, created_at, id`,
      [this.workspaceId, taskId],
    );
    return this.hydrateTurns(rows);
  }

  async listMessages(taskId: string): Promise<readonly TaskMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `${messageSelect('WHERE workspace_id = ? AND task_id = ?')} ORDER BY created_at, id`,
      [this.workspaceId, taskId],
    );
    return rows.map(decodeMessage);
  }

  async listToolCalls(taskId: string): Promise<readonly PersistedToolCall[]> {
    const rows = await this.db.all<ToolRow>(
      `SELECT id, task_id, turn_id, tool_call_id, ordering, status, name, payload_json, created_at, updated_at
         FROM tool_calls WHERE workspace_id = ? AND task_id = ? ORDER BY turn_id, ordering, id`,
      [this.workspaceId, taskId],
    );
    return rows.map(decodeToolCall);
  }

  async listReasoning(taskId: string): Promise<readonly PersistedReasoning[]> {
    const rows = await this.db.all<ReasoningRow>(
      `SELECT id, task_id, turn_id, content, created_at, updated_at
         FROM reasoning_segments WHERE workspace_id = ? AND task_id = ? ORDER BY created_at, id`,
      [this.workspaceId, taskId],
    );
    return rows.map(decodeReasoning);
  }

  async getOperation(ledgerKey: string): Promise<OperationLedgerEntry | undefined> {
    const row = await this.db.get<OperationRow>(
      'SELECT ledger_key, fingerprint, result_json FROM operations WHERE workspace_id = ? AND ledger_key = ?',
      [this.workspaceId, ledgerKey],
    );
    return row ? decodeOperation(row) : undefined;
  }

  async getCancelRequest(turnId: string): Promise<CancelRequest | undefined> {
    const row = await this.db.get<CancelRow>(
      `SELECT turn_id, kind, op_id, requested_by, requested_at, payload_json
         FROM turn_cancel_requests WHERE workspace_id = ? AND turn_id = ?`,
      [this.workspaceId, turnId],
    );
    return row ? decodeCancelRequest(row) : undefined;
  }

  async getSendReceipt(clientRequestId: string): Promise<SendReceipt | undefined> {
    const row = await this.db.get<ReceiptRow>(
      `SELECT client_request_id, fingerprint, task_id, message_id, turn_id, created_at
         FROM send_receipts WHERE workspace_id = ? AND client_request_id = ?`,
      [this.workspaceId, clientRequestId],
    );
    return row ? decodeReceipt(row) : undefined;
  }

  async getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage> {
    const [turns, messages, tools, reasoning, revisionRow] = await Promise.all([
      this.listTurns(taskId),
      this.listMessages(taskId),
      this.db.all<ToolRow>(
        `SELECT id, task_id, turn_id, tool_call_id, ordering, status, name, payload_json, created_at, updated_at
           FROM tool_calls WHERE workspace_id = ? AND task_id = ?`,
        [this.workspaceId, taskId],
      ),
      this.db.all<ReasoningRow>(
        `SELECT id, task_id, turn_id, content, created_at, updated_at
           FROM reasoning_segments WHERE workspace_id = ? AND task_id = ?`,
        [this.workspaceId, taskId],
      ),
      this.db.get<{ revision: number }>('SELECT revision FROM workspace_revisions WHERE workspace_id = ?', [this.workspaceId]),
    ]);
    const parsedReasoning = reasoning.map(decodeReasoning);
    return pageTranscript(
      composeTranscript(turns, messages, tools.map(decodeToolCall), parsedReasoning),
      turns,
      cursor,
      limit,
      revisionRow?.revision ?? 0,
    );
  }

  async readEnvelopeForMigration(): Promise<Readonly<TaskStoreFile>> {
    const [tasks, turnRows, messageRows, toolRows, reasoningRows, operationRows, cancelRows, receiptRows, revisionRow] = await Promise.all([
      this.listTasks(this.workspaceId),
      this.db.all<TurnRow>(`${turnSelect('WHERE workspace_id = ?')} ORDER BY task_id, sequence, created_at, id`, [this.workspaceId]),
      this.db.all<MessageRow>(`${messageSelect('WHERE workspace_id = ?')} ORDER BY created_at, id`, [this.workspaceId]),
      this.db.all<ToolRow>(
        `SELECT id, task_id, turn_id, tool_call_id, ordering, status, name, payload_json, created_at, updated_at
           FROM tool_calls WHERE workspace_id = ?`, [this.workspaceId],
      ),
      this.db.all<ReasoningRow>(
        `SELECT id, task_id, turn_id, content, created_at, updated_at
           FROM reasoning_segments WHERE workspace_id = ?`, [this.workspaceId],
      ),
      this.db.all<OperationRow>(
        'SELECT ledger_key, fingerprint, result_json FROM operations WHERE workspace_id = ?', [this.workspaceId],
      ),
      this.db.all<CancelRow>(
        `SELECT turn_id, kind, op_id, requested_by, requested_at, payload_json
           FROM turn_cancel_requests WHERE workspace_id = ?`, [this.workspaceId],
      ),
      this.db.all<ReceiptRow>(
        `SELECT client_request_id, fingerprint, task_id, message_id, turn_id, created_at
           FROM send_receipts WHERE workspace_id = ?`, [this.workspaceId],
      ),
      this.db.get<{ revision: number }>('SELECT revision FROM workspace_revisions WHERE workspace_id = ?', [this.workspaceId]),
    ]);
    const turns = await this.hydrateTurns(turnRows);
    const file: TaskStoreFile = {
      schemaVersion: 6,
      revision: revisionRow?.revision ?? 0,
      tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
      turns: Object.fromEntries(turns.map((turn) => [turn.id, turn])),
      messages: Object.fromEntries(messageRows.map((message) => {
        const dto = decodeMessage(message);
        return [dto.id, dto];
      })),
      operations: Object.fromEntries(operationRows.map((row) => [row.ledger_key, decodeOperation(row)])),
      cancelRequests: Object.fromEntries(cancelRows.map((row) => [row.turn_id, decodeCancelRequest(row)])),
      toolCalls: Object.fromEntries(toolRows.map((row) => {
        const dto = decodeToolCall(row);
        return [dto.id, dto];
      })),
      reasoning: Object.fromEntries(reasoningRows.map((row) => {
        const dto = decodeReasoning(row);
        return [dto.id, dto];
      })),
      sendReceipts: Object.fromEntries(receiptRows.map((row) => {
        const dto = decodeReceipt(row);
        return [dto.clientRequestId, dto];
      })),
    };
    return file;
  }

  private async write(
    statements: readonly SqlStatement[],
    changed: readonly ChangeRecord[],
    at: string,
  ): Promise<readonly import('./sqlite/rpc').RunResult[]> {
    return this.db.transaction([...statements, ...revisionStatements(this.workspaceId, changed, at)]);
  }

  /**
   * Conditional commands (claim/promote/delete/retention) must not create a
   * revision/feed event when their guarded first statement changes no rows. The
   * revision insert immediately follows that statement so SQLite's changes()
   * refers to exactly the guard, while all remaining statements stay in the
   * same worker transaction.
   */
  private async writeIfFirstChanged(
    first: SqlStatement,
    rest: readonly SqlStatement[],
    change: ChangeRecord | readonly ChangeRecord[],
    at: string,
  ): Promise<readonly import('./sqlite/rpc').RunResult[]> {
    return this.db.transaction([
      first,
      ...conditionalRevisionStatements(this.workspaceId, change, at),
      ...rest,
    ], { abortIfFirstUnchanged: true });
  }

  async execute(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (command.workspaceId !== this.workspaceId) throw new Error('repository workspace mismatch');
    switch (command.kind) {
      case 'upsertWorkspace': {
        await this.write([workspaceStatement(command)], [{ kind: 'workspace', id: command.workspaceId, change: 'upsert' }], command.lastOpenedAt);
        return { ok: true, changed: true };
      }
      case 'recordWorkspaceLocation': {
        await this.write([workspaceLocationStatement(command)], [{ kind: 'workspace_location', id: command.canonicalUri, change: 'upsert' }], command.lastSeenAt);
        return { ok: true, changed: true };
      }
      case 'createTask':
        return this.writeTask(command.task, false);
      case 'createRootAndInitialTurn':
        return this.createRootAndInitialTurn(command);
      case 'enqueueMessageTurn':
        return this.enqueueMessageTurn(command);
      case 'retryTurn':
        return this.retryTurn(command);
      case 'upsertTask':
        return this.writeTask(command.task, true);
      case 'deleteTask': {
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM tasks WHERE workspace_id = ? AND id = ?', params: [this.workspaceId, command.taskId] }, [],
          { kind: 'task', id: command.taskId, change: 'delete' }, new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'createTurn':
        return this.writeTurn(command.turn, false);
      case 'upsertTurn':
        return this.writeTurn(command.turn, true);
      case 'replaceLiveTurn':
        return this.replaceLiveTurn(command);
      case 'recordAsk':
        return this.replaceLiveTurn({
          kind: 'replaceLiveTurn', workspaceId: command.workspaceId, turn: command.turn,
          expectedStatuses: ['running', 'waiting_user'],
          expectedRuntimeEpoch: command.expectedRuntimeEpoch,
        });
      case 'answerAsk':
        return this.replaceLiveTurn({
          kind: 'replaceLiveTurn', workspaceId: command.workspaceId, turn: command.turn,
          expectedStatuses: ['waiting_user'],
          expectedRuntimeEpoch: command.expectedRuntimeEpoch,
        });
      case 'deleteTurn': {
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM turns WHERE workspace_id = ? AND id = ?', params: [this.workspaceId, command.turnId] }, [],
          { kind: 'turn', id: command.turnId, change: 'delete' }, new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'editQueuedMessage':
        return this.editQueuedMessage(command);
      case 'deleteQueuedTurnAndMessages':
        return this.deleteQueuedTurnAndMessages(command);
      case 'clearQueuedTurnHold':
        return this.clearQueuedTurnHold(command);
      case 'appendMessage': {
        const results = await this.write([messageStatement(this.workspaceId, command.message, false)], [{ kind: 'message', id: command.message.id, taskId: command.message.taskId, change: 'insert' }], command.message.createdAt);
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'upsertMessage': {
        await this.write([messageStatement(this.workspaceId, command.message, true, command.updatedAt)], [{ kind: 'message', id: command.message.id, taskId: command.message.taskId, change: 'upsert' }], command.updatedAt ?? command.message.createdAt);
        return { ok: true, changed: true };
      }
      case 'deleteMessage': {
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM messages WHERE workspace_id = ? AND id = ?', params: [this.workspaceId, command.messageId] }, [],
          { kind: 'message', id: command.messageId, change: 'delete' }, new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'appendTranscriptBatch': {
        const statements: SqlStatement[] = [];
        const changes: ChangeRecord[] = [];
        for (const message of command.messages ?? []) {
          if (message.taskId !== command.taskId) throw new Error('message task mismatch');
          statements.push(messageStatement(this.workspaceId, message, true));
          changes.push({ kind: 'message', id: message.id, taskId: command.taskId, change: 'upsert' });
        }
        for (const tool of command.toolCalls ?? []) {
          if (tool.taskId !== command.taskId) throw new Error('tool call task mismatch');
          statements.push(toolCallStatement(this.workspaceId, tool));
          changes.push({ kind: 'tool_call', id: tool.id, taskId: command.taskId, change: 'upsert' });
        }
        for (const reasoning of command.reasoning ?? []) {
          if (reasoning.taskId !== command.taskId) throw new Error('reasoning task mismatch');
          statements.push(reasoningStatement(this.workspaceId, reasoning));
          changes.push({ kind: 'reasoning', id: reasoning.id, taskId: command.taskId, change: 'upsert' });
        }
        if (statements.length === 0) return { ok: true, changed: false };
        await this.write(statements, changes, newestTranscriptTime(command));
        return { ok: true, changed: true };
      }
      case 'putOperation': {
        await this.write([operationStatement(this.workspaceId, command)], [{ kind: 'operation', id: command.ledgerKey, change: 'upsert' }], command.createdAt);
        return { ok: true, changed: true };
      }
      case 'claimOperation':
        return this.claimOperation(command);
      case 'deleteOperationsForTurn': {
        const results = await this.writeIfFirstChanged(
          { sql: `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`, params: [this.workspaceId, `${escapeGlob(command.turnId)}:*`] }, [],
          { kind: 'operation', id: command.turnId, change: 'delete' }, new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'putCancelRequest': {
        const results = await this.writeIfFirstChanged(
          cancelRequestStatement(this.workspaceId, command), [],
          { kind: 'cancel_request', id: command.turnId, change: 'upsert' }, command.request.at,
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'deleteCancelRequest': {
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM turn_cancel_requests WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turnId] }, [],
          { kind: 'cancel_request', id: command.turnId, change: 'delete' }, new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'putSendReceipt': {
        await this.write([sendReceiptStatement(this.workspaceId, command.receipt)], [{ kind: 'send_receipt', id: command.receipt.clientRequestId, taskId: command.receipt.taskId, change: 'upsert' }], command.receipt.createdAt);
        return { ok: true, changed: true };
      }
      case 'deleteSendReceipt': {
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM send_receipts WHERE workspace_id = ? AND client_request_id = ?', params: [this.workspaceId, command.clientRequestId] }, [],
          { kind: 'send_receipt', id: command.clientRequestId, change: 'delete' }, new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'promoteTurn':
        return this.promote(command.turnId, command.startedAt);
      case 'claimTurn':
        return this.claim(command);
      case 'prepareDispatch':
        return this.prepareDispatch(command);
      case 'settleTurn':
        return this.settle(command);
      case 'settleTurnAndApplyEffects':
        return this.settleTurnAndApplyEffects(command);
      case 'applyRetention':
        return this.applyRetention(command);
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  private async writeTask(task: MusterTask, upsert: boolean): Promise<RepositoryCommandResult> {
    const statements: SqlStatement[] = [taskStatement(this.workspaceId, task, upsert)];
    if (upsert) {
      statements.push({ sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, task.id] });
    }
    for (const dependency of task.dependencies) statements.push(dependencyStatement(this.workspaceId, task.id, dependency));
    const results = await this.write(statements, [{ kind: 'task', id: task.id, change: upsert ? 'upsert' : 'insert' }], task.updatedAt);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async queuedTurnWithPendingMessages(taskId: string, turnId: string): Promise<
    { ok: true; turn: TaskTurn; messageIds: string[] } | { ok: false; reason: string }
  > {
    const turn = (await this.listTurns(taskId)).find((candidate) => candidate.id === turnId);
    if (!turn) {
      const anyTask = await this.db.get<{ task_id: string }>(
        'SELECT task_id FROM turns WHERE workspace_id = ? AND id = ?', [this.workspaceId, turnId],
      );
      return { ok: false, reason: anyTask ? 'turn does not belong to task' : 'turn not found' };
    }
    if (turn.status !== 'queued') return { ok: false, reason: 'turn is not queued' };
    const messageIds = turn.inputs
      .filter((input): input is Extract<TurnInput, { kind: 'message' }> => input.kind === 'message')
      .map((input) => input.messageId);
    if (messageIds.length === 0) return { ok: false, reason: 'message not found' };
    const messages = new Map((await this.listMessages(taskId)).map((message) => [message.id, message]));
    for (const messageId of messageIds) {
      const message = messages.get(messageId);
      if (!message || message.role !== 'user' || message.state !== 'pending') {
        return { ok: false, reason: 'message is not pending' };
      }
    }
    return { ok: true, turn, messageIds };
  }

  private async editQueuedMessage(
    command: Extract<RepositoryCommand, { kind: 'editQueuedMessage' }>,
  ): Promise<RepositoryCommandResult> {
    const prepared = await this.queuedTurnWithPendingMessages(command.taskId, command.turnId);
    if (!prepared.ok) return { ok: true, changed: false, reason: prepared.reason };
    const messageId = prepared.messageIds[0]!;
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE messages
               SET content = ?, payload_json = json_remove(payload_json, '$.agentContent')
             WHERE workspace_id = ? AND id = ? AND task_id = ? AND role = 'user' AND state = 'pending'
               AND EXISTS (
                 SELECT 1 FROM turns
                  WHERE workspace_id = ? AND id = ? AND task_id = ? AND status = 'queued'
               )`,
        params: [command.content, this.workspaceId, messageId, command.taskId,
          this.workspaceId, command.turnId, command.taskId],
      }, [],
      { kind: 'message', id: messageId, taskId: command.taskId, change: 'edit' },
      new Date().toISOString(),
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) > 0 ? { messageId } : { reason: 'turn is no longer queued' }),
    };
  }

  private async deleteQueuedTurnAndMessages(
    command: Extract<RepositoryCommand, { kind: 'deleteQueuedTurnAndMessages' }>,
  ): Promise<RepositoryCommandResult> {
    const prepared = await this.queuedTurnWithPendingMessages(command.taskId, command.turnId);
    if (!prepared.ok) return { ok: true, changed: false, reason: prepared.reason };
    const results = await this.writeIfFirstChanged(
      {
        sql: `DELETE FROM turns
               WHERE workspace_id = ? AND id = ? AND task_id = ? AND status = 'queued'
                 AND NOT EXISTS (
                   SELECT 1 FROM turn_inputs i
                    LEFT JOIN messages m ON m.workspace_id = i.workspace_id
                      AND m.id = json_extract(i.payload_json, '$.messageId')
                    WHERE i.workspace_id = ? AND i.turn_id = ? AND i.kind = 'message'
                      AND (m.id IS NULL OR m.task_id <> ? OR m.role <> 'user' OR m.state <> 'pending')
                 )`,
        params: [this.workspaceId, command.turnId, command.taskId, this.workspaceId, command.turnId, command.taskId],
      },
      prepared.messageIds.map((messageId) => ({
        sql: 'DELETE FROM messages WHERE workspace_id = ? AND id = ? AND task_id = ? AND role = ? AND state = ?',
        params: [this.workspaceId, messageId, command.taskId, 'user', 'pending'],
      })),
      [
        { kind: 'turn', id: command.turnId, taskId: command.taskId, change: 'delete' },
        ...prepared.messageIds.map((messageId) => ({ kind: 'message' as const, id: messageId, taskId: command.taskId, change: 'delete' })),
      ],
      new Date().toISOString(),
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) > 0
        ? { deletedMessageIds: prepared.messageIds }
        : { reason: 'turn is no longer queued' }),
    };
  }

  private async clearQueuedTurnHold(
    command: Extract<RepositoryCommand, { kind: 'clearQueuedTurnHold' }>,
  ): Promise<RepositoryCommandResult> {
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE turns SET payload_json = json_remove(payload_json, '$.holdAutoPromote')
               WHERE workspace_id = ? AND id = ? AND task_id = ? AND status = 'queued'
                 AND COALESCE(json_extract(payload_json, '$.holdAutoPromote'), 0) = 1`,
        params: [this.workspaceId, command.turnId, command.taskId],
      }, [],
      { kind: 'turn', id: command.turnId, taskId: command.taskId, change: 'clear_hold' },
      new Date().toISOString(),
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is not a held queued turn' } : {}),
    };
  }

  private async createRootAndInitialTurn(
    command: Extract<RepositoryCommand, { kind: 'createRootAndInitialTurn' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateRootInitialTurn(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const statements: SqlStatement[] = [taskStatement(this.workspaceId, command.task, false)];
    for (const dependency of command.task.dependencies) {
      statements.push(dependencyStatement(this.workspaceId, command.task.id, dependency));
    }
    statements.push(
      turnStatement(this.workspaceId, command.turn, false),
      messageStatement(this.workspaceId, command.message, false),
    );
    command.turn.inputs.forEach((input, ordering) => {
      statements.push(turnInputStatement(this.workspaceId, command.turn.id, ordering, input));
    });
    if (command.receipt) statements.push(sendReceiptStatement(this.workspaceId, command.receipt));
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'insert' },
      { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'insert' },
      { kind: 'message', id: command.message.id, taskId: command.task.id, change: 'insert' },
      ...(command.receipt
        ? [{ kind: 'send_receipt' as const, id: command.receipt.clientRequestId, taskId: command.task.id, change: 'insert' as const }]
        : []),
    ];
    const results = await this.write(statements, changes, command.turn.createdAt);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async enqueueMessageTurn(
    command: Extract<RepositoryCommand, { kind: 'enqueueMessageTurn' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateEnqueueMessageTurn(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const statements: SqlStatement[] = [];
    // The guarded task write is deliberately first. `writeIfFirstChanged()` asks
    // the worker to roll back before touching any dependent row on a stale task
    // revision or a saturated current execution epoch.
    const guard = guardedTaskUpdateStatement(
      this.workspaceId,
      command.task,
      command.expectedTaskRevision,
      command.maxTurnsPerTask,
    );
    statements.push({ sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, command.task.id] });
    for (const dependency of command.task.dependencies) {
      statements.push(dependencyStatement(this.workspaceId, command.task.id, dependency));
    }
    statements.push(
      turnStatement(this.workspaceId, command.turn, false),
      messageStatement(this.workspaceId, command.message, false),
    );
    command.turn.inputs.forEach((input, ordering) => {
      statements.push(turnInputStatement(this.workspaceId, command.turn.id, ordering, input));
    });
    if (command.receipt) statements.push(sendReceiptStatement(this.workspaceId, command.receipt));
    const results = await this.writeIfFirstChanged(
      guard,
      statements,
      { kind: 'task', id: command.task.id, change: 'enqueue' },
      command.turn.createdAt,
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed or max turns per task exceeded; retry' } : {}),
    };
  }

  private async retryTurn(
    command: Extract<RepositoryCommand, { kind: 'retryTurn' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateRetryTurn(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const rest: SqlStatement[] = [
      { sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, command.task.id] },
      ...command.task.dependencies.map((dependency) => dependencyStatement(this.workspaceId, command.task.id, dependency)),
      turnStatement(this.workspaceId, command.turn, false),
      ...command.turn.inputs.map((input, ordering) => turnInputStatement(this.workspaceId, command.turn.id, ordering, input)),
    ];
    const results = await this.writeIfFirstChanged(
      guardedTaskUpdateStatement(
        this.workspaceId,
        command.task,
        command.expectedTaskRevision,
        command.maxTurnsPerTask,
      ),
      rest,
      [
        { kind: 'task', id: command.task.id, change: 'retry' },
        { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'insert' },
      ],
      command.turn.createdAt,
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed or max turns per task exceeded; retry' } : {}),
    };
  }

  private async claimOperation(
    command: Extract<RepositoryCommand, { kind: 'claimOperation' }>,
  ): Promise<RepositoryCommandResult> {
    // `changes()` is evaluated immediately after the INSERT/DO NOTHING. This
    // makes both revision and change_log conditional, so a replay is a true
    // read-only operation rather than a misleading workspace update.
    const results = await this.db.transaction([
      {
        sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
              VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
        params: [this.workspaceId, command.ledgerKey, command.entry.fingerprint,
          encodePayload({ result: command.entry.result }), command.createdAt],
      },
      {
        sql: `INSERT INTO workspace_revisions (workspace_id, revision)
              SELECT ?, 1 WHERE changes() > 0
              ON CONFLICT(workspace_id) DO UPDATE SET revision = workspace_revisions.revision + 1`,
        params: [this.workspaceId],
      },
      {
        sql: `INSERT INTO change_log (workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)
              SELECT ?, revision, 'operation', ?, NULL, 'insert', ?
                FROM workspace_revisions WHERE workspace_id = ? AND changes() > 0`,
        params: [this.workspaceId, command.ledgerKey, command.createdAt, this.workspaceId],
      },
    ]);
    const inserted = (results[0]?.changes ?? 0) > 0;
    const row = await this.db.get<OperationRow>(
      'SELECT ledger_key, fingerprint, result_json FROM operations WHERE workspace_id = ? AND ledger_key = ?',
      [this.workspaceId, command.ledgerKey],
    );
    if (!row) throw new Error('operation claim disappeared after transaction');
    const operation = decodeOperation(row);
    if (operation.fingerprint !== command.entry.fingerprint) {
      return { ok: true, changed: false, conflict: true, reason: 'operation fingerprint conflict', operation };
    }
    return { ok: true, changed: inserted, operation };
  }

  private async writeTurn(turn: TaskTurn, upsert: boolean): Promise<RepositoryCommandResult> {
    const statements: SqlStatement[] = [turnStatement(this.workspaceId, turn, upsert)];
    if (upsert) statements.push({ sql: 'DELETE FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turn.id] });
    for (const [ordering, input] of turn.inputs.entries()) statements.push(turnInputStatement(this.workspaceId, turn.id, ordering, input));
    const results = await this.write(statements, [{ kind: 'turn', id: turn.id, taskId: turn.taskId, change: upsert ? 'upsert' : 'insert' }], turn.finishedAt ?? turn.startedAt ?? turn.createdAt);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async replaceLiveTurn(
    command: Extract<RepositoryCommand, { kind: 'replaceLiveTurn' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.expectedStatuses.length === 0) {
      return { ok: true, changed: false, reason: 'expected live status required' };
    }
    const results = await this.writeIfFirstChanged(
      guardedLiveTurnReplaceStatement(this.workspaceId, command),
      [],
      { kind: 'turn', id: command.turn.id, taskId: command.turn.taskId, change: 'activity' },
      command.turn.finishedAt ?? command.turn.startedAt ?? command.turn.createdAt,
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is no longer live' } : {}),
    };
  }

  private async promote(turnId: string, startedAt: string): Promise<RepositoryCommandResult> {
    const results = await this.writeIfFirstChanged(
      { sql: `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ? AND status = 'queued'`, params: [startedAt, this.workspaceId, turnId] }, [],
      { kind: 'turn', id: turnId, change: 'promote' }, startedAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async claim(command: Extract<RepositoryCommand, { kind: 'claimTurn' }>): Promise<RepositoryCommandResult> {
    const update = claimTurnStatement(this.workspaceId, command);
    const rest: SqlStatement[] = [];
    if (command.sessionId) rest.push(sessionClaimStatement(this.workspaceId, command.turnId, command.sessionId, command.startedAt));
    for (const key of command.resourceKeys) rest.push(resourceClaimStatement(this.workspaceId, command.turnId, key, command.startedAt));
    const results = await this.writeIfFirstChanged(update, rest, { kind: 'turn', id: command.turnId, change: 'promote' }, command.startedAt);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is no longer eligible' } : {}) };
  }

  private async prepareDispatch(
    command: Extract<RepositoryCommand, { kind: 'prepareDispatch' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validatePrepareDispatch(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const claims = command.turn.status === 'running';
    const rest: SqlStatement[] = [
      // The guard claim/update is first. Everything below is rolled back if
      // eligibility or the expected task revision changed after the engine
      // froze its prompt/input snapshot.
      ...(claims ? [taskStatement(this.workspaceId, command.task, true)] : []),
      { sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, command.task.id] },
      ...command.task.dependencies.map((dependency) => dependencyStatement(this.workspaceId, command.task.id, dependency)),
      turnStatement(this.workspaceId, command.turn, true),
      { sql: 'DELETE FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turn.id] },
      ...command.turn.inputs.map((input, ordering) => turnInputStatement(this.workspaceId, command.turn.id, ordering, input)),
      ...command.messages.map((message) => messageStatement(this.workspaceId, message, true)),
      ...(claims && command.sessionId
        ? [sessionClaimStatement(this.workspaceId, command.turn.id, command.sessionId, command.startedAt)]
        : []),
      ...(claims
        ? command.resourceKeys.map((key) => resourceClaimStatement(this.workspaceId, command.turn.id, key, command.startedAt))
        : []),
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'prepare_dispatch' },
      { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'promote' },
      ...command.messages.map((message) => ({
        kind: 'message' as const, id: message.id, taskId: command.task.id, change: 'assign',
      })),
    ];
    const results = await this.writeIfFirstChanged(
      claims
        ? claimTurnStatement(this.workspaceId, command)
        : guardedDispatchTaskUpdateStatement(this.workspaceId, command),
      rest,
      changes,
      command.startedAt,
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is no longer eligible' } : {}),
    };
  }

  private async settle(command: Extract<RepositoryCommand, { kind: 'settleTurn' }>): Promise<RepositoryCommandResult> {
    const payloadExpression = command.error === undefined
      ? "json_remove(payload_json, '$.error')"
      : "json_set(payload_json, '$.error', ?)";
    const params: SqlValue[] = command.error === undefined
      ? [command.status, command.finishedAt, this.workspaceId, command.turnId]
      : [command.status, command.finishedAt, command.error, this.workspaceId, command.turnId];
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE turns SET status = ?, settled_at = ?, payload_json = ${payloadExpression}
               WHERE workspace_id = ? AND id = ? AND status IN ('running', 'waiting_user')`, params,
      }, [
      { sql: 'DELETE FROM session_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turnId] },
      { sql: 'DELETE FROM resource_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turnId] },
    ], { kind: 'turn', id: command.turnId, change: 'settle' }, command.finishedAt);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async settleTurnAndApplyEffects(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.expectedStatuses.length === 0) {
      return { ok: true, changed: false, reason: 'expected live status required' };
    }
    const rest: SqlStatement[] = [
      taskStatement(this.workspaceId, command.task, true),
      ...command.relatedTurns.flatMap((turn) => [
        turnStatement(this.workspaceId, turn, true),
        { sql: 'DELETE FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turn.id] },
        ...turn.inputs.map((input, ordering) => turnInputStatement(this.workspaceId, turn.id, ordering, input)),
      ]),
      ...command.messages.map((message) => messageStatement(this.workspaceId, message, true)),
      { sql: 'DELETE FROM session_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turn.id] },
      { sql: 'DELETE FROM resource_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turn.id] },
      { sql: 'DELETE FROM turn_cancel_requests WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turn.id] },
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'settle' },
      { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'settle' },
      ...command.relatedTurns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'effect' })),
      ...command.messages.map((message) => ({ kind: 'message' as const, id: message.id, taskId: message.taskId, change: 'complete' })),
    ];
    const results = await this.writeIfFirstChanged(
      guardedSettleTurnStatement(this.workspaceId, command),
      rest,
      changes,
      command.turn.finishedAt ?? new Date().toISOString(),
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is no longer live' } : {}),
    };
  }

  private async applyRetention(command: Extract<RepositoryCommand, { kind: 'applyRetention' }>): Promise<RepositoryCommandResult> {
    const task = await this.getTask(command.taskId);
    if (!task) return { ok: true, changed: false };
    if (isTerminalLifecycle(task.lifecycle)) {
      const turns = await this.listTurns(task.id);
      const keep = retainedTurnIds(turns, command.keepLatestTurns);
      const drop = turns.filter((turn) => !keep.has(turn.id)).map((turn) => turn.id);
      if (drop.length === 0) return { ok: true, changed: false };
      const rest: SqlStatement[] = [
        // Turn-bound messages/tool calls/reasoning/cancel + claim rows cascade
        // through FK. User rows only have an input reference, so clean up the
        // ones no remaining turn references after that cascade.
        {
          sql: `DELETE FROM messages
                 WHERE workspace_id = ? AND task_id = ? AND turn_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM turn_inputs i
                      WHERE i.workspace_id = messages.workspace_id
                        AND i.kind = 'message'
                        AND json_extract(i.payload_json, '$.messageId') = messages.id
                   )`,
          params: [this.workspaceId, task.id],
        },
        ...drop.map((turnId) => ({
          sql: 'DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?',
          params: [this.workspaceId, `${escapeGlob(turnId)}:*`],
        })),
      ];
      const results = await this.writeIfFirstChanged(
        {
          sql: `DELETE FROM turns
                 WHERE workspace_id = ? AND task_id = ? AND id IN (${placeholders(drop.length)})
                   AND EXISTS (
                     SELECT 1 FROM tasks
                      WHERE workspace_id = ? AND id = ?
                        AND lifecycle IN ('succeeded', 'failed', 'cancelled', 'skipped')
                   )`,
          params: [this.workspaceId, task.id, ...drop, this.workspaceId, task.id],
        },
        rest,
        { kind: 'turn', id: task.id, taskId: task.id, change: 'retention' },
        new Date().toISOString(),
      );
      return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
    }

    const maxChars = Math.max(0, Math.floor(command.maxStoredOutputChars ?? Number.MAX_SAFE_INTEGER));
    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];
    for (const message of await this.listMessages(task.id)) {
      if (message.role !== 'assistant' || message.state !== 'complete') continue;
      const content = truncateRetentionContent(message.content, maxChars);
      if (content === message.content) continue;
      statements.push({
        sql: 'UPDATE messages SET content = ? WHERE workspace_id = ? AND id = ? AND content = ?',
        params: [content, this.workspaceId, message.id, message.content],
      });
      changes.push({ kind: 'message', id: message.id, taskId: task.id, change: 'truncate' });
    }
    for (const tool of await this.listToolCalls(task.id)) {
      if (typeof tool.output !== 'string') continue;
      const output = truncateRetentionContent(tool.output, maxChars);
      if (output === tool.output) continue;
      statements.push(toolCallStatement(this.workspaceId, { ...tool, output }));
      changes.push({ kind: 'tool_call', id: tool.id, taskId: task.id, change: 'truncate' });
    }
    for (const reasoning of await this.listReasoning(task.id)) {
      const content = truncateRetentionContent(reasoning.content, maxChars);
      if (content === reasoning.content) continue;
      statements.push({
        sql: 'UPDATE reasoning_segments SET content = ? WHERE workspace_id = ? AND id = ? AND content = ?',
        params: [content, this.workspaceId, reasoning.id, reasoning.content],
      });
      changes.push({ kind: 'reasoning', id: reasoning.id, taskId: task.id, change: 'truncate' });
    }
    if (statements.length === 0) return { ok: true, changed: false };
    await this.write(statements, changes, new Date().toISOString());
    return { ok: true, changed: true };
  }
}

type ChangeKind =
  | 'workspace' | 'workspace_location' | 'task' | 'turn' | 'message'
  | 'tool_call' | 'reasoning' | 'operation' | 'cancel_request' | 'send_receipt';

interface ChangeRecord {
  kind: ChangeKind;
  id: string;
  taskId?: string;
  change: string;
}

function placeholders(count: number): string {
  if (!Number.isInteger(count) || count < 1) throw new Error('placeholder count must be positive');
  return Array.from({ length: count }, () => '?').join(',');
}

function taskSelect(where: string): string {
  return `SELECT t.id, t.workspace_id, t.parent_id, t.role, t.lifecycle, t.release_state, t.goal, t.backend,
                 t.model, t.revision, t.created_at, t.updated_at, t.payload_json
            FROM tasks t ${where}`;
}

function turnSelect(where: string): string {
  return `SELECT id, workspace_id, task_id, sequence, status, trigger, created_at,
                 started_at, settled_at, payload_json FROM turns ${where}`;
}

function messageSelect(where: string): string {
  return `SELECT id, workspace_id, task_id, turn_id, role, state, ordering, content,
                 created_at, updated_at, payload_json FROM messages ${where}`;
}

function encodePayload(value: Record<string, unknown>): string {
  return JSON.stringify({ payloadVersion: 1, ...value });
}

function taskPayload(task: MusterTask): string {
  const {
    id: _id, parentId: _parentId, role: _role, lifecycle: _lifecycle,
    releaseState: _releaseState, goal: _goal, backend: _backend, model: _model,
    revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
    dependencies: _dependencies,
    ...payload
  } = task;
  void _id; void _parentId; void _role; void _lifecycle; void _releaseState;
  void _goal; void _backend; void _model; void _revision; void _createdAt;
  void _updatedAt; void _dependencies;
  return encodePayload(payload);
}

function turnPayload(turn: TaskTurn): string {
  const {
    id: _id, taskId: _taskId, sequence: _sequence, status: _status, trigger: _trigger,
    createdAt: _createdAt, startedAt: _startedAt, finishedAt: _finishedAt, inputs: _inputs,
    ...payload
  } = turn;
  void _id; void _taskId; void _sequence; void _status; void _trigger;
  void _createdAt; void _startedAt; void _finishedAt; void _inputs;
  return encodePayload(payload);
}

function messagePayload(message: TaskMessage): string {
  const {
    id: _id, taskId: _taskId, turnId: _turnId, role: _role, state: _state,
    content: _content, order: _order, createdAt: _createdAt, ...payload
  } = message;
  void _id; void _taskId; void _turnId; void _role; void _state; void _content;
  void _order; void _createdAt;
  return encodePayload(payload);
}

function toolCallPayload(tool: PersistedToolCall): string {
  const {
    id: _id, taskId: _taskId, turnId: _turnId, toolCallId: _toolCallId,
    order: _order, status: _status, name: _name, createdAt: _createdAt,
    updatedAt: _updatedAt, ...payload
  } = tool;
  void _id; void _taskId; void _turnId; void _toolCallId; void _order; void _status;
  void _name; void _createdAt; void _updatedAt;
  return encodePayload(payload);
}

function taskStatement(workspaceId: string, task: MusterTask, upsert: boolean): SqlStatement {
  const suffix = upsert
    ? ` ON CONFLICT(workspace_id, id) DO UPDATE SET
          parent_id=excluded.parent_id, role=excluded.role, lifecycle=excluded.lifecycle,
          release_state=excluded.release_state, goal=excluded.goal, backend=excluded.backend,
          model=excluded.model, revision=excluded.revision, created_at=excluded.created_at,
          updated_at=excluded.updated_at, payload_json=excluded.payload_json`
    : '';
  return {
    sql: `INSERT INTO tasks
          (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
           revision, created_at, updated_at, payload_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)${suffix}`,
    params: [task.id, workspaceId, task.parentId, task.role, task.lifecycle, task.releaseState ?? null,
      task.goal, task.backend, task.model ?? null, task.revision, task.createdAt, task.updatedAt,
      taskPayload(task)],
  };
}

/**
 * Optimistic task update used by the FIFO enqueue command. The turn-cap
 * predicate is evaluated while the IMMEDIATE transaction owns the write lock,
 * so two extension hosts cannot both reserve the final slot of an execution
 * epoch. `turns.payload_json` still owns executionEpoch until that small field
 * is promoted in a later schema migration.
 */
function guardedTaskUpdateStatement(
  workspaceId: string,
  task: MusterTask,
  expectedRevision: number,
  maxTurnsPerTask: number,
): SqlStatement {
  const epoch = task.executionEpoch ?? 1;
  const cap = Math.min(maxTurnsPerTask, task.executionPolicy.maxTurns);
  return {
    sql: `UPDATE tasks SET parent_id=?, role=?, lifecycle=?, release_state=?, goal=?, backend=?, model=?,
             revision=?, created_at=?, updated_at=?, payload_json=?
           WHERE workspace_id=? AND id=? AND revision=?
             AND (
               SELECT COUNT(*) FROM turns queued_epoch
                WHERE queued_epoch.workspace_id = tasks.workspace_id
                  AND queued_epoch.task_id = tasks.id
                  AND COALESCE(json_extract(queued_epoch.payload_json, '$.executionEpoch'), 1) = ?
             ) < ?`,
    params: [
      task.parentId, task.role, task.lifecycle, task.releaseState ?? null, task.goal, task.backend,
      task.model ?? null, task.revision, task.createdAt, task.updatedAt, taskPayload(task), workspaceId,
      task.id, expectedRevision, epoch, cap,
    ],
  };
}

/**
 * Guard the non-running outcomes of prepareDispatch (blocked input pin or
 * prompt-budget failure).  These outcomes must still be serialized against the
 * task revision and an unchanged queued turn, but intentionally do not acquire
 * scheduler claims because no backend prompt will be sent.
 */
function guardedDispatchTaskUpdateStatement(
  workspaceId: string,
  command: Extract<RepositoryCommand, { kind: 'prepareDispatch' }>,
): SqlStatement {
  const task = command.task;
  return {
    sql: `UPDATE tasks SET parent_id=?, role=?, lifecycle=?, release_state=?, goal=?, backend=?, model=?,
             revision=?, created_at=?, updated_at=?, payload_json=?
           WHERE workspace_id=? AND id=? AND revision=?
             AND EXISTS (
               SELECT 1 FROM turns
                WHERE workspace_id = ? AND id = ? AND task_id = ? AND status = 'queued'
             )`,
    params: [
      task.parentId, task.role, task.lifecycle, task.releaseState ?? null, task.goal, task.backend,
      task.model ?? null, task.revision, task.createdAt, task.updatedAt, taskPayload(task), workspaceId,
      task.id, command.expectedTaskRevision, workspaceId, command.turn.id, task.id,
    ],
  };
}

function dependencyStatement(workspaceId: string, taskId: string, dependency: TaskDependency): SqlStatement {
  return {
    sql: `INSERT INTO task_dependencies
          (workspace_id, task_id, dependency_task_id, required_outcome, on_unsatisfied, required_verdict)
          VALUES (?,?,?,?,?,?)`,
    params: [workspaceId, taskId, dependency.taskId, dependency.requiredOutcome, dependency.onUnsatisfied,
      dependency.requiredVerdict ?? null],
  };
}

function turnStatement(workspaceId: string, turn: TaskTurn, upsert: boolean): SqlStatement {
  const suffix = upsert
    ? ` ON CONFLICT(workspace_id, id) DO UPDATE SET
          task_id=excluded.task_id, sequence=excluded.sequence, status=excluded.status,
          trigger=excluded.trigger, created_at=excluded.created_at, started_at=excluded.started_at,
          settled_at=excluded.settled_at, payload_json=excluded.payload_json`
    : '';
  return {
    sql: `INSERT INTO turns
          (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)${suffix}`,
    params: [turn.id, workspaceId, turn.taskId, turn.sequence, turn.status, turn.trigger, turn.createdAt,
      turn.startedAt ?? null, turn.finishedAt ?? null, turnPayload(turn)],
  };
}

/** Conditional row update for live-turn activity.  It deliberately preserves
 * turn_inputs (which are immutable once dispatch starts) and fences against a
 * runtime handoff that lands between an event read and its persistence. */
function guardedLiveTurnReplaceStatement(
  workspaceId: string,
  command: Extract<RepositoryCommand, { kind: 'replaceLiveTurn' }>,
): SqlStatement {
  const turn = command.turn;
  const statuses = command.expectedStatuses;
  const epochPredicate = command.expectedRuntimeEpoch === undefined
    ? ''
    : ` AND EXISTS (
          SELECT 1 FROM tasks task
           WHERE task.workspace_id = turns.workspace_id AND task.id = turns.task_id
             AND COALESCE(json_extract(task.payload_json, '$.runtimeEpoch'), 1) = ?
        )`;
  return {
    sql: `UPDATE turns
             SET task_id=?, sequence=?, status=?, trigger=?, created_at=?, started_at=?, settled_at=?, payload_json=?
           WHERE workspace_id=? AND id=? AND status IN (${placeholders(statuses.length)})${epochPredicate}`,
    params: [
      turn.taskId, turn.sequence, turn.status, turn.trigger, turn.createdAt, turn.startedAt ?? null,
      turn.finishedAt ?? null, turnPayload(turn), workspaceId, turn.id, ...statuses,
      ...(command.expectedRuntimeEpoch === undefined ? [] : [command.expectedRuntimeEpoch]),
    ],
  };
}

/** First statement for the compound settlement command. It writes the terminal
 * target turn only when the task revision, live status and runtime epoch still
 * match; every task/message/retry side effect follows in the same transaction. */
function guardedSettleTurnStatement(
  workspaceId: string,
  command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
): SqlStatement {
  const turn = command.turn;
  const epoch = turn.runtimeEpoch ?? 1;
  return {
    sql: `UPDATE turns
             SET task_id=?, sequence=?, status=?, trigger=?, created_at=?, started_at=?, settled_at=?, payload_json=?
           WHERE workspace_id=? AND id=? AND status IN (${placeholders(command.expectedStatuses.length)})
             AND EXISTS (
               SELECT 1 FROM tasks task
                WHERE task.workspace_id = turns.workspace_id AND task.id = turns.task_id
                  AND task.revision = ?
                  AND COALESCE(json_extract(task.payload_json, '$.runtimeEpoch'), 1) = ?
             )`,
    params: [
      turn.taskId, turn.sequence, turn.status, turn.trigger, turn.createdAt, turn.startedAt ?? null,
      turn.finishedAt ?? null, turnPayload(turn), workspaceId, turn.id, ...command.expectedStatuses,
      command.expectedTaskRevision, epoch,
    ],
  };
}

function turnInputStatement(workspaceId: string, turnId: string, ordering: number, input: TurnInput): SqlStatement {
  return {
    sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
          VALUES (?,?,?,?,?)`,
    params: [workspaceId, turnId, ordering, input.kind, encodePayload(input)],
  };
}

function messageStatement(workspaceId: string, message: TaskMessage, upsert: boolean, updatedAt?: string): SqlStatement {
  const suffix = upsert
    ? ` ON CONFLICT(workspace_id, id) DO UPDATE SET
          task_id=excluded.task_id, turn_id=excluded.turn_id, role=excluded.role,
          state=excluded.state, ordering=excluded.ordering, content=excluded.content,
          created_at=excluded.created_at, updated_at=excluded.updated_at, payload_json=excluded.payload_json`
    : '';
  return {
    sql: `INSERT INTO messages
          (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)${suffix}`,
    params: [message.id, workspaceId, message.taskId, message.turnId ?? null, message.role,
      message.state, message.order ?? null, message.content, message.createdAt, updatedAt ?? null,
      messagePayload(message)],
  };
}

function toolCallStatement(workspaceId: string, tool: PersistedToolCall): SqlStatement {
  return {
    sql: `INSERT INTO tool_calls
          (id, workspace_id, task_id, turn_id, tool_call_id, ordering, status, name, payload_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id, id) DO UPDATE SET task_id=excluded.task_id, turn_id=excluded.turn_id,
            tool_call_id=excluded.tool_call_id, ordering=excluded.ordering, status=excluded.status,
            name=excluded.name, payload_json=excluded.payload_json, created_at=excluded.created_at,
            updated_at=excluded.updated_at`,
    params: [tool.id, workspaceId, tool.taskId, tool.turnId, tool.toolCallId, tool.order, tool.status,
      tool.name, toolCallPayload(tool), tool.createdAt, tool.updatedAt],
  };
}

function reasoningStatement(workspaceId: string, reasoning: PersistedReasoning): SqlStatement {
  return {
    sql: `INSERT INTO reasoning_segments
          (id, workspace_id, task_id, turn_id, ordering, content, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id, id) DO UPDATE SET task_id=excluded.task_id, turn_id=excluded.turn_id,
            ordering=excluded.ordering, content=excluded.content, created_at=excluded.created_at,
            updated_at=excluded.updated_at`,
    params: [reasoning.id, workspaceId, reasoning.taskId, reasoning.turnId, 0, reasoning.content,
      reasoning.createdAt, reasoning.updatedAt],
  };
}

function workspaceStatement(command: Extract<RepositoryCommand, { kind: 'upsertWorkspace' }>): SqlStatement {
  return {
    sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
          VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity_key=excluded.identity_key,
          display_name=excluded.display_name, last_opened_at=excluded.last_opened_at`,
    params: [command.workspaceId, command.identityKey, command.displayName, command.createdAt, command.lastOpenedAt],
  };
}

function workspaceLocationStatement(command: Extract<RepositoryCommand, { kind: 'recordWorkspaceLocation' }>): SqlStatement {
  return {
    sql: `INSERT INTO workspace_locations (workspace_id, canonical_uri, first_seen_at, last_seen_at)
          VALUES (?,?,?,?) ON CONFLICT(workspace_id, canonical_uri) DO UPDATE SET
          last_seen_at=excluded.last_seen_at`,
    params: [command.workspaceId, command.canonicalUri, command.firstSeenAt, command.lastSeenAt],
  };
}

function operationStatement(workspaceId: string, command: Extract<RepositoryCommand, { kind: 'putOperation' }>): SqlStatement {
  return {
    sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
          VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, ledger_key) DO UPDATE SET
          fingerprint=excluded.fingerprint, result_json=excluded.result_json, created_at=excluded.created_at`,
    params: [workspaceId, command.ledgerKey, command.entry.fingerprint,
      encodePayload({ result: command.entry.result }), command.createdAt],
  };
}

function cancelRequestStatement(workspaceId: string, command: Extract<RepositoryCommand, { kind: 'putCancelRequest' }>): SqlStatement {
  const request = command.request;
  return {
    sql: `INSERT INTO turn_cancel_requests
          (workspace_id, turn_id, task_id, kind, op_id, requested_by, requested_at, payload_json)
          SELECT ?, id, task_id, ?, ?, ?, ?, ? FROM turns
           WHERE workspace_id = ? AND id = ?
          ON CONFLICT(workspace_id, turn_id) DO UPDATE SET kind=excluded.kind, op_id=excluded.op_id,
          requested_by=excluded.requested_by, requested_at=excluded.requested_at, payload_json=excluded.payload_json`,
    params: [workspaceId, request.kind, request.opId, request.by, request.at,
      encodePayload({ sealedBy: request.sealedBy, reason: request.reason }), workspaceId, command.turnId],
  };
}

function sendReceiptStatement(workspaceId: string, receipt: SendReceipt): SqlStatement {
  return {
    sql: `INSERT INTO send_receipts
          (workspace_id, client_request_id, fingerprint, task_id, message_id, turn_id, created_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id, client_request_id) DO UPDATE SET
          fingerprint=excluded.fingerprint, task_id=excluded.task_id, message_id=excluded.message_id,
          turn_id=excluded.turn_id, created_at=excluded.created_at`,
    params: [workspaceId, receipt.clientRequestId, receipt.fingerprint, receipt.taskId, receipt.messageId,
      receipt.turnId, receipt.createdAt],
  };
}

function revisionStatements(workspaceId: string, changes: readonly ChangeRecord[], at: string): SqlStatement[] {
  if (changes.length === 0) return [];
  return [
    {
      sql: `INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, 1)
            ON CONFLICT(workspace_id) DO UPDATE SET revision = workspace_revisions.revision + 1`,
      params: [workspaceId],
    },
    ...changes.map((change) => ({
      sql: `INSERT INTO change_log (workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)
            SELECT ?, revision, ?, ?, ?, ?, ? FROM workspace_revisions WHERE workspace_id = ?`,
      params: [workspaceId, change.kind, change.id, change.taskId ?? null, change.change, at, workspaceId],
    })),
  ];
}

/**
 * `changes()` refers to the immediately preceding statement. This helper is
 * deliberately used only directly after a guarded primary mutation, before any
 * cleanup statement can overwrite that signal.
 */
function conditionalRevisionStatements(
  workspaceId: string,
  change: ChangeRecord | readonly ChangeRecord[],
  at: string,
): SqlStatement[] {
  const changes = Array.isArray(change) ? change : [change];
  if (changes.length === 0) return [];
  return [
    {
      sql: `INSERT INTO workspace_revisions (workspace_id, revision)
            SELECT ?, 1 WHERE changes() > 0
            ON CONFLICT(workspace_id) DO UPDATE SET revision = workspace_revisions.revision + 1`,
      params: [workspaceId],
    },
    ...changes.map((entry) => ({
      sql: `INSERT INTO change_log (workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)
            SELECT ?, revision, ?, ?, ?, ?, ?
              FROM workspace_revisions WHERE workspace_id = ? AND changes() > 0`,
      params: [workspaceId, entry.kind, entry.id, entry.taskId ?? null, entry.change, at, workspaceId],
    })),
  ];
}

function newestTranscriptTime(command: Extract<RepositoryCommand, { kind: 'appendTranscriptBatch' }>): string {
  const times = [
    ...(command.messages ?? []).map((value) => value.createdAt),
    ...(command.toolCalls ?? []).map((value) => value.updatedAt),
    ...(command.reasoning ?? []).map((value) => value.updatedAt),
  ];
  return times.sort().at(-1) ?? new Date().toISOString();
}

function escapeGlob(value: string): string {
  return value.replace(/[\[\]*?]/g, '[$&]');
}

/** Canonical claim keys for a task; used by the scheduler adapter before it
 * issues the final worker-owned `claimTurn` command. */
export function deriveResourceClaimKeys(task: MusterTask): string[] {
  if (!isMutatingTask(task)) return [];
  const keys = new Set<string>();
  const paths = normalizedWritePaths(task.brief);
  const git = task.claimsGit === true || task.brief?.kind === 'implement';
  if (git) keys.add('git');
  if (paths.length === 0) keys.add('unscoped');
  for (const path of paths) keys.add(`path:${path}`);
  return [...keys].sort();
}

type ClaimTurnCommand = Extract<RepositoryCommand, { kind: 'claimTurn' | 'prepareDispatch' }>;

function claimTurnStatement(
  workspaceId: string,
  command: ClaimTurnCommand,
): SqlStatement {
  const turnId = command.kind === 'prepareDispatch' ? command.turn.id : command.turnId;
  const resource = claimResourcePredicate(workspaceId, command.resourceKeys);
  const sessionPredicate = command.sessionId
    ? `AND NOT EXISTS (SELECT 1 FROM session_claims sc WHERE sc.workspace_id = ? AND sc.session_id = ?)`
    : '';
  const sessionParams: SqlValue[] = command.sessionId ? [workspaceId, command.sessionId] : [];
  const revisionPredicate = command.kind === 'prepareDispatch'
    ? 'AND candidate.revision = ?'
    : '';
  const revisionParams: SqlValue[] = command.kind === 'prepareDispatch'
    ? [command.expectedTaskRevision]
    : [];
  return {
    sql: `WITH RECURSIVE root_tree(id) AS (
            SELECT id FROM tasks WHERE workspace_id = ? AND id = ?
            UNION
            SELECT child.id FROM tasks child JOIN root_tree parent ON child.parent_id = parent.id
             WHERE child.workspace_id = ?
          )
          UPDATE turns
             SET status = 'running', started_at = ?
           WHERE workspace_id = ? AND id = ? AND status = 'queued'
             AND EXISTS (SELECT 1 FROM tasks candidate
                          WHERE candidate.workspace_id = turns.workspace_id AND candidate.id = turns.task_id
                            ${revisionPredicate}
                            AND candidate.lifecycle = 'open'
                            AND COALESCE(candidate.release_state, 'released') = 'released'
                            AND COALESCE(json_extract(turns.payload_json, '$.runtimeEpoch'), 1) =
                                COALESCE(json_extract(candidate.payload_json, '$.runtimeEpoch'), 1)
                            AND json_extract(candidate.payload_json, '$.wait.kind') IS NOT 'external'
                            AND (
                              json_extract(candidate.payload_json, '$.wait.kind') IS NULL OR
                              json_extract(candidate.payload_json, '$.wait.kind') IS NOT 'children' OR
                              (turns.trigger = 'engine' AND (turns.id LIKE '%parent-q-%' OR turns.id LIKE '%-attention'))
                            )
                            AND NOT (
                              COALESCE(json_extract(candidate.payload_json, '$.handoff.version'), 0) = 1 AND
                              json_extract(candidate.payload_json, '$.handoff.phase') IN
                                ('requested', 'exporting_context', 'summarizing_source', 'preparing_receiver', 'transferring')
                            )
                            AND NOT EXISTS (
                              SELECT 1 FROM json_each(candidate.payload_json, '$.inputBindings') binding
                               WHERE COALESCE(json_extract(binding.value, '$.required'), 1) <> 0
                                 AND NOT EXISTS (
                                   SELECT 1 FROM tasks producer
                                    WHERE producer.workspace_id = candidate.workspace_id
                                      AND producer.id = json_extract(binding.value, '$.fromTaskId')
                                      AND (
                                        json_extract(producer.payload_json, '$.taskResult.summary') IS NOT NULL OR
                                        json_extract(producer.payload_json, '$.result') IS NOT NULL
                                      )
                                 )
                            ))
             AND NOT EXISTS (SELECT 1 FROM turns same_task
                              WHERE same_task.workspace_id = turns.workspace_id AND same_task.task_id = turns.task_id
                                AND same_task.id <> turns.id AND same_task.status IN ('running', 'waiting_user'))
             AND NOT EXISTS (SELECT 1 FROM turns earlier
                              WHERE earlier.workspace_id = turns.workspace_id AND earlier.task_id = turns.task_id
                                AND earlier.id <> turns.id AND earlier.status = 'queued'
                                AND COALESCE(json_extract(earlier.payload_json, '$.holdAutoPromote'), 0) <> 1
                                AND (earlier.sequence < turns.sequence OR (earlier.sequence = turns.sequence AND
                                     (earlier.created_at < turns.created_at OR (earlier.created_at = turns.created_at AND earlier.id < turns.id)))))
             AND NOT EXISTS (SELECT 1 FROM task_dependencies dep
                              JOIN tasks producer ON producer.workspace_id = dep.workspace_id AND producer.id = dep.dependency_task_id
                              WHERE dep.workspace_id = turns.workspace_id AND dep.task_id = turns.task_id
                                AND NOT (((dep.required_outcome = 'succeeded' AND producer.lifecycle = 'succeeded') OR
                                  (dep.required_outcome = 'settled' AND producer.lifecycle IN ('succeeded','failed','cancelled','skipped')))
                                  AND (dep.required_verdict IS NULL OR json_extract(producer.payload_json, '$.taskResult.verdict.status') = 'pass')))
             AND (SELECT COUNT(*) FROM turns live WHERE live.workspace_id = turns.workspace_id
                    AND live.status IN ('running', 'waiting_user')) < ?
             AND (SELECT COUNT(*) FROM turns live WHERE live.workspace_id = turns.workspace_id
                    AND live.status IN ('running', 'waiting_user') AND live.task_id IN (SELECT id FROM root_tree)) < ?
             AND (SELECT COUNT(*) FROM turns live JOIN tasks live_task
                    ON live_task.workspace_id = live.workspace_id AND live_task.id = live.task_id
                    WHERE live.workspace_id = turns.workspace_id AND live.status IN ('running', 'waiting_user')
                      AND live_task.backend = (SELECT backend FROM tasks WHERE workspace_id = turns.workspace_id AND id = turns.task_id)) < ?
             ${sessionPredicate}
             ${resource.sql}`,
    params: [workspaceId, command.rootTaskId, workspaceId, command.startedAt, workspaceId, turnId,
      ...revisionParams, command.maxConcurrentTurns, command.maxConcurrentPerRoot, command.maxConcurrentPerBackend,
      ...sessionParams, ...resource.params],
  };
}

function claimResourcePredicate(workspaceId: string, resourceKeys: readonly string[]): { sql: string; params: SqlValue[] } {
  if (resourceKeys.length === 0) return { sql: '', params: [] };
  const conditions: string[] = ["rc.resource_key = 'unscoped'"];
  const params: SqlValue[] = [];
  for (const key of resourceKeys) {
    if (key === 'unscoped') {
      // An unscoped mutator conflicts with every currently claimed resource.
      conditions.push('1 = 1');
      continue;
    }
    if (key === 'git') {
      conditions.push("rc.resource_key = 'git'");
      continue;
    }
    conditions.push("(rc.resource_key = ? OR rc.resource_key LIKE (? || '/%') OR ? LIKE (rc.resource_key || '/%'))");
    params.push(key, key, key);
  }
  return {
    sql: `AND NOT EXISTS (SELECT 1 FROM resource_claims rc WHERE rc.workspace_id = ? AND (${conditions.join(' OR ')}))`,
    params: [workspaceId, ...params],
  };
}

function sessionClaimStatement(workspaceId: string, turnId: string, sessionId: string, claimedAt: string): SqlStatement {
  return {
    sql: `INSERT INTO session_claims (workspace_id, session_id, turn_id, claimed_at)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM turns WHERE workspace_id = ? AND id = ? AND status = 'running' AND started_at = ?)`,
    params: [workspaceId, sessionId, turnId, claimedAt, workspaceId, turnId, claimedAt],
  };
}

function resourceClaimStatement(workspaceId: string, turnId: string, resourceKey: string, claimedAt: string): SqlStatement {
  return {
    sql: `INSERT INTO resource_claims (workspace_id, resource_key, task_id, turn_id, claimed_at)
          SELECT ?, ?, task_id, id, ? FROM turns
           WHERE workspace_id = ? AND id = ? AND status = 'running' AND started_at = ?`,
    params: [workspaceId, resourceKey, claimedAt, workspaceId, turnId, claimedAt],
  };
}

interface TaskRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  role: string;
  lifecycle: string;
  release_state: string | null;
  goal: string;
  backend: string;
  model: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  payload_json: string;
}

interface WorkspaceRow {
  id: string;
  identity_key: string;
  display_name: string;
  created_at: string;
  last_opened_at: string;
}

interface WorkspaceLocationRow {
  workspace_id: string;
  canonical_uri: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface TurnRow {
  id: string;
  workspace_id: string;
  task_id: string;
  sequence: number;
  status: string;
  trigger: string;
  created_at: string;
  started_at: string | null;
  settled_at: string | null;
  payload_json: string;
}

interface MessageRow {
  id: string;
  workspace_id: string;
  task_id: string;
  turn_id: string | null;
  role: string;
  state: string;
  ordering: number | null;
  content: string;
  created_at: string;
  updated_at: string | null;
  payload_json: string;
}

interface DependencyRow {
  task_id: string;
  dependency_task_id: string;
  required_outcome: string;
  on_unsatisfied: string;
  required_verdict: string | null;
}

interface TurnInputRow {
  turn_id: string;
  ordering: number;
  kind: string;
  payload_json: string;
}

interface ToolRow {
  id: string;
  task_id: string;
  turn_id: string;
  tool_call_id: string;
  ordering: number;
  status: string;
  name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface ReasoningRow {
  id: string;
  task_id: string;
  turn_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  ledger_key: string;
  fingerprint: string;
  result_json: string;
}

interface CancelRow {
  turn_id: string;
  kind: string;
  op_id: string;
  requested_by: string;
  requested_at: string;
  payload_json: string;
}

interface ReceiptRow {
  client_request_id: string;
  fingerprint: string;
  task_id: string;
  message_id: string;
  turn_id: string;
  created_at: string;
}

interface TranscriptEntry {
  item: RepositoryTranscriptItem;
  seq: number;
  order: number;
  createdAt: string;
  id: string;
}

function composeTranscript(
  turns: readonly TaskTurn[],
  messages: readonly TaskMessage[],
  toolCalls: readonly PersistedToolCall[],
  reasoning: readonly PersistedReasoning[],
): RepositoryTranscriptItem[] {
  const orderedTurns = [...turns].sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seqOf = new Map(orderedTurns.map((turn) => [turn.id, turn.sequence]));
  const msgTurn = new Map<string, string>();
  for (const turn of orderedTurns) {
    for (const input of turn.inputs) {
      if (input.kind === 'message') msgTurn.set(input.messageId, turn.id);
    }
  }
  const entries: TranscriptEntry[] = [];
  const openingQueued = orderedTurns.length === 1 && orderedTurns[0]?.status === 'queued' && orderedTurns[0].trigger === 'user';
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const turnId = message.role === 'assistant' ? message.turnId : (message.turnId ?? msgTurn.get(message.id));
    const boundTurn = turnId ? orderedTurns.find((turn) => turn.id === turnId) : undefined;
    if (message.role === 'user' && boundTurn?.status === 'queued' && !openingQueued) continue;
    entries.push({
      item: { id: message.id, kind: message.role, content: message.content, turnId, order: message.order, state: message.state, createdAt: message.createdAt },
      seq: turnId && seqOf.has(turnId) ? seqOf.get(turnId)! : -1,
      order: message.role === 'assistant' ? (message.order ?? 0) : (message.order ?? -2),
      createdAt: message.createdAt,
      id: message.id,
    });
  }
  for (const tool of toolCalls) {
    if (!seqOf.has(tool.turnId)) continue;
    entries.push({
      item: {
        id: tool.id, kind: 'tool', turnId: tool.turnId, order: tool.order,
        content: { toolCallId: tool.toolCallId, name: tool.name, toolKind: tool.kind, status: tool.status,
          input: tool.input, output: tool.output, error: tool.error }, createdAt: tool.createdAt,
      },
      seq: seqOf.get(tool.turnId)!, order: tool.order, createdAt: tool.createdAt, id: tool.id,
    });
  }
  for (const item of reasoning) {
    if (!seqOf.has(item.turnId)) continue;
    entries.push({ item: { id: item.id, kind: 'reasoning', turnId: item.turnId, content: item.content, createdAt: item.createdAt },
      seq: seqOf.get(item.turnId)!, order: -1, createdAt: item.createdAt, id: item.id });
  }
  entries.sort((a, b) => a.seq - b.seq || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return entries.map((entry) => entry.item);
}

function transcriptKey(item: RepositoryTranscriptItem, turns: readonly TaskTurn[]): string {
  const turnId = 'turnId' in item ? item.turnId : undefined;
  const seq = turnId ? turns.find((turn) => turn.id === turnId)?.sequence ?? -1 : -1;
  const order = 'order' in item ? item.order : -1;
  return `${seq}\u0000${order}\u0000${item.createdAt ?? ''}\u0000${item.id}`;
}

function encodeTranscriptCursor(item: RepositoryTranscriptItem, turns: readonly TaskTurn[]): string {
  return `v1.${Buffer.from(transcriptKey(item, turns), 'utf8').toString('base64url')}`;
}

function decodeTranscriptCursor(cursor: string): string {
  try {
    if (!cursor.startsWith('v1.')) throw new Error('invalid version');
    const decoded = Buffer.from(cursor.slice(3), 'base64url').toString('utf8');
    if (!decoded.includes('\u0000')) throw new Error('invalid');
    return decoded;
  } catch {
    throw new Error('invalid transcript cursor');
  }
}

function pageTranscript(items: readonly RepositoryTranscriptItem[], turns: readonly TaskTurn[], cursor: string | undefined, limit: number | undefined, revision: number): TranscriptPage {
  const bounded = normalizeLimit(limit);
  // Items are already in canonical order. Cursor points at the newest item on
  // the previous page; older pages therefore select strictly smaller keys.
  const cursorKey = cursor ? decodeTranscriptCursor(cursor) : undefined;
  const cursorId = cursorKey?.split('\u0000').pop();
  const start = cursorId
    ? items.findIndex((item) => item.id === cursorId)
    : items.length;
  if (cursorId && start < 0) {
    throw new Error('transcript cursor is no longer valid');
  }
  const end = cursorKey ? start : items.length;
  const from = Math.max(0, end - bounded);
  const page = items.slice(from, end);
  const hasMoreBefore = from > 0;
  return {
    items: page,
    ...(hasMoreBefore && page[0] ? { beforeCursor: encodeTranscriptCursor(page[0], turns) } : {}),
    hasMoreBefore,
    workspaceRevision: revision,
  };
}

function parsePayload(raw: string, kind: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${kind} payload in SQLite store`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid ${kind} payload in SQLite store: expected object`);
  }
  const object = parsed as Record<string, unknown>;
  if (object.payloadVersion !== undefined && object.payloadVersion !== 1) {
    throw new Error(`invalid ${kind} payload in SQLite store: unsupported payloadVersion`);
  }
  return object;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

function requiredString(value: unknown, field: string, kind: string): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid ${kind} row in SQLite store: ${field} must be a string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string, kind: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${kind} row in SQLite store: ${field} must be a number`);
  }
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, kind: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${kind} row in SQLite store: ${field} has unsupported value`);
  }
  return value as T;
}

/**
 * Hydrate promoted columns over the compatibility payload. This is intentional:
 * query/state columns are the SQLite source of truth, while payload_json carries
 * the low-query fields. It also lets Phase 2 read rows produced by the legacy
 * JSON importer before the Phase 3 payload codec removes duplicated fields.
 */
function decodeWorkspace(row: WorkspaceRow): RepositoryWorkspace {
  return {
    id: requiredString(row.id, 'id', 'workspace'),
    identityKey: requiredString(row.identity_key, 'identity_key', 'workspace'),
    displayName: requiredString(row.display_name, 'display_name', 'workspace'),
    createdAt: requiredString(row.created_at, 'created_at', 'workspace'),
    lastOpenedAt: requiredString(row.last_opened_at, 'last_opened_at', 'workspace'),
  };
}

function decodeWorkspaceLocation(row: WorkspaceLocationRow): RepositoryWorkspaceLocation {
  return {
    workspaceId: requiredString(row.workspace_id, 'workspace_id', 'workspace location'),
    canonicalUri: requiredString(row.canonical_uri, 'canonical_uri', 'workspace location'),
    firstSeenAt: requiredString(row.first_seen_at, 'first_seen_at', 'workspace location'),
    lastSeenAt: requiredString(row.last_seen_at, 'last_seen_at', 'workspace location'),
  };
}

function decodeDependency(row: DependencyRow): TaskDependency {
  return {
    taskId: requiredString(row.dependency_task_id, 'dependency_task_id', 'task dependency'),
    requiredOutcome: oneOf(row.required_outcome, ['succeeded', 'settled'] as const, 'required_outcome', 'task dependency'),
    onUnsatisfied: oneOf(row.on_unsatisfied, ['block', 'fail', 'skip'] as const, 'on_unsatisfied', 'task dependency'),
    ...(row.required_verdict === null
      ? {}
      : { requiredVerdict: oneOf(row.required_verdict, ['pass'] as const, 'required_verdict', 'task dependency') }),
  };
}

function legacyDependencies(payload: Record<string, unknown>): TaskDependency[] {
  if (payload.dependencies === undefined) return [];
  if (!Array.isArray(payload.dependencies)) {
    throw new Error('invalid task row in SQLite store: dependencies must be an array');
  }
  return payload.dependencies.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid task row in SQLite store: dependency must be an object');
    }
    const row = value as Record<string, unknown>;
    return {
      taskId: requiredString(row.taskId, 'dependencies.taskId', 'task'),
      requiredOutcome: oneOf(requiredString(row.requiredOutcome, 'dependencies.requiredOutcome', 'task'), ['succeeded', 'settled'] as const, 'dependencies.requiredOutcome', 'task'),
      onUnsatisfied: oneOf(requiredString(row.onUnsatisfied, 'dependencies.onUnsatisfied', 'task'), ['block', 'fail', 'skip'] as const, 'dependencies.onUnsatisfied', 'task'),
      ...(row.requiredVerdict === undefined ? {} : { requiredVerdict: oneOf(requiredString(row.requiredVerdict, 'dependencies.requiredVerdict', 'task'), ['pass'] as const, 'dependencies.requiredVerdict', 'task') }),
    };
  });
}

function decodeTask(row: TaskRow, dependencies?: readonly TaskDependency[]): MusterTask {
  const payload = parsePayload(row.payload_json, 'task');
  const task: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'task'),
    parentId: row.parent_id,
    role: oneOf(row.role, ['coordinator', 'worker'] as const, 'role', 'task'),
    lifecycle: oneOf(row.lifecycle, ['open', 'succeeded', 'failed', 'cancelled', 'skipped'] as const, 'lifecycle', 'task'),
    goal: requiredString(row.goal, 'goal', 'task'),
    backend: requiredString(row.backend, 'backend', 'task'),
    revision: requiredNumber(row.revision, 'revision', 'task'),
    createdAt: requiredString(row.created_at, 'created_at', 'task'),
    updatedAt: requiredString(row.updated_at, 'updated_at', 'task'),
    ...(row.model === null ? { model: undefined } : { model: row.model }),
    ...(row.release_state === null ? { releaseState: undefined } : { releaseState: row.release_state }),
    dependencies: dependencies ?? legacyDependencies(payload),
  };
  delete task.payloadVersion;
  if (!Array.isArray(task.capabilities) || !task.executionPolicy || typeof task.executionPolicy !== 'object') {
    throw new Error('invalid task row in SQLite store: missing domain payload fields');
  }
  return task as unknown as MusterTask;
}

function legacyTurnInputs(payload: Record<string, unknown>): TurnInput[] {
  if (payload.inputs === undefined) return [];
  if (!Array.isArray(payload.inputs)) {
    throw new Error('invalid turn row in SQLite store: inputs must be an array');
  }
  return payload.inputs.map((input) => decodeTurnInputValue(input));
}

function decodeTurnInputValue(value: unknown): TurnInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid turn input row in SQLite store: expected object');
  }
  const input = value as Record<string, unknown>;
  const kind = requiredString(input.kind, 'kind', 'turn input');
  switch (kind) {
    case 'message':
      return { kind, messageId: requiredString(input.messageId, 'messageId', 'turn input') };
    case 'child_results': {
      if (!Array.isArray(input.taskIds) || !input.taskIds.every((id) => typeof id === 'string')) {
        throw new Error('invalid turn input row in SQLite store: taskIds must be string array');
      }
      return { kind, taskIds: [...input.taskIds] };
    }
    case 'recovery':
      return {
        kind,
        interruptedTurnId: requiredString(input.interruptedTurnId, 'interruptedTurnId', 'turn input'),
        instruction: requiredString(input.instruction, 'instruction', 'turn input'),
      };
    default:
      throw new Error('invalid turn input row in SQLite store: unsupported kind');
  }
}

function decodeTurnInput(row: TurnInputRow): TurnInput {
  const payload = parsePayload(row.payload_json, 'turn input');
  const input = decodeTurnInputValue(payload);
  if (input.kind !== row.kind) {
    throw new Error('invalid turn input row in SQLite store: kind mismatch');
  }
  return input;
}

function decodeTurn(row: TurnRow, inputs?: readonly TurnInput[]): TaskTurn {
  const payload = parsePayload(row.payload_json, 'turn');
  const turn: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'turn'),
    taskId: requiredString(row.task_id, 'task_id', 'turn'),
    sequence: requiredNumber(row.sequence, 'sequence', 'turn'),
    status: oneOf(row.status, ['queued', 'running', 'waiting_user', 'succeeded', 'failed', 'interrupted', 'cancelled'] as const, 'status', 'turn'),
    trigger: oneOf(row.trigger, ['user', 'engine', 'retry'] as const, 'trigger', 'turn'),
    createdAt: requiredString(row.created_at, 'created_at', 'turn'),
    ...(row.started_at === null ? { startedAt: undefined } : { startedAt: row.started_at }),
    ...(row.settled_at === null ? { finishedAt: undefined } : { finishedAt: row.settled_at }),
    inputs: inputs ?? legacyTurnInputs(payload),
  };
  delete turn.payloadVersion;
  return turn as unknown as TaskTurn;
}

function decodeMessage(row: MessageRow): TaskMessage {
  const payload = parsePayload(row.payload_json, 'message');
  const message: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'message'),
    taskId: requiredString(row.task_id, 'task_id', 'message'),
    role: oneOf(row.role, ['user', 'assistant', 'system'] as const, 'role', 'message'),
    state: oneOf(row.state, ['pending', 'assigned', 'complete', 'partial'] as const, 'state', 'message'),
    content: requiredString(row.content, 'content', 'message'),
    createdAt: requiredString(row.created_at, 'created_at', 'message'),
    ...(row.turn_id === null ? { turnId: undefined } : { turnId: row.turn_id }),
    ...(row.ordering === null ? { order: undefined } : { order: row.ordering }),
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
  };
  delete message.payloadVersion;
  return message as unknown as TaskMessage;
}

function decodeToolCall(row: ToolRow): PersistedToolCall {
  const payload = parsePayload(row.payload_json, 'tool call');
  const tool: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'tool call'),
    taskId: requiredString(row.task_id, 'task_id', 'tool call'),
    turnId: requiredString(row.turn_id, 'turn_id', 'tool call'),
    toolCallId: requiredString(row.tool_call_id, 'tool_call_id', 'tool call'),
    order: requiredNumber(row.ordering, 'ordering', 'tool call'),
    status: oneOf(row.status, ['running', 'success', 'error'] as const, 'status', 'tool call'),
    name: requiredString(row.name, 'name', 'tool call'),
    createdAt: requiredString(row.created_at, 'created_at', 'tool call'),
    updatedAt: requiredString(row.updated_at, 'updated_at', 'tool call'),
  };
  delete tool.payloadVersion;
  return tool as unknown as PersistedToolCall;
}

function decodeReasoning(row: ReasoningRow): PersistedReasoning {
  return {
    id: requiredString(row.id, 'id', 'reasoning'),
    taskId: requiredString(row.task_id, 'task_id', 'reasoning'),
    turnId: requiredString(row.turn_id, 'turn_id', 'reasoning'),
    content: requiredString(row.content, 'content', 'reasoning'),
    createdAt: requiredString(row.created_at, 'created_at', 'reasoning'),
    updatedAt: requiredString(row.updated_at, 'updated_at', 'reasoning'),
  };
}

function decodeOperation(row: OperationRow): OperationLedgerEntry {
  const encoded = parsePayload(row.result_json, 'operation result');
  // v1 Phase-3 rows carry `{ payloadVersion, result }`; tolerate the brief
  // Phase-2 compatibility form where result_json itself was the OpResult.
  const result = encoded.payloadVersion === 1
    ? (() => {
        if (!encoded.result || typeof encoded.result !== 'object' || Array.isArray(encoded.result)) {
          throw new Error('invalid operation row in SQLite store: result must be object');
        }
        return encoded.result as Record<string, unknown>;
      })()
    : encoded;
  if (typeof result.ok !== 'boolean') {
    throw new Error('invalid operation row in SQLite store: result.ok must be boolean');
  }
  return {
    fingerprint: requiredString(row.fingerprint, 'fingerprint', 'operation'),
    result: {
      ok: result.ok,
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.error === undefined ? {} : { error: requiredString(result.error, 'error', 'operation') }),
    },
  };
}

function decodeCancelRequest(row: CancelRow): CancelRequest {
  const payload = parsePayload(row.payload_json, 'cancel request');
  const request: CancelRequest = {
    kind: oneOf(row.kind, ['interrupt', 'cancel'] as const, 'kind', 'cancel request'),
    by: requiredString(row.requested_by, 'requested_by', 'cancel request'),
    opId: requiredString(row.op_id, 'op_id', 'cancel request'),
    at: requiredString(row.requested_at, 'requested_at', 'cancel request'),
  };
  if (payload.sealedBy !== undefined) request.sealedBy = payload.sealedBy as CancelRequest['sealedBy'];
  if (payload.reason !== undefined) request.reason = requiredString(payload.reason, 'reason', 'cancel request');
  return request;
}

function decodeReceipt(row: ReceiptRow): SendReceipt {
  return {
    clientRequestId: requiredString(row.client_request_id, 'client_request_id', 'send receipt'),
    fingerprint: requiredString(row.fingerprint, 'fingerprint', 'send receipt'),
    taskId: requiredString(row.task_id, 'task_id', 'send receipt'),
    messageId: requiredString(row.message_id, 'message_id', 'send receipt'),
    turnId: requiredString(row.turn_id, 'turn_id', 'send receipt'),
    createdAt: requiredString(row.created_at, 'created_at', 'send receipt'),
  };
}
