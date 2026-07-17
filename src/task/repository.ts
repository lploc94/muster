import type {
  CancelRequest,
  MusterTask,
  OperationLedgerEntry,
  PersistedReasoning,
  PersistedToolCall,
  SendReceipt,
  TaskDependency,
  TaskMessage,
  RuntimeClaim,
  TaskTurn,
  TurnInput,
  TurnDisposition,
  TurnStatus,
} from './types';
import { isMutatingTask, normalizedWritePaths } from './resources';
import { canPromoteTurn } from './scheduler';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { isTerminalLifecycle, isTerminalTurn } from './transitions';
import { TRUNCATION_MARKER } from './retention';
import type { DbClient } from './sqlite/client';
import type { SqlStatement, SqlValue } from './sqlite/rpc';
import {
  ASSISTANT_ORDERING_FALLBACK,
  KIND_RANK,
  REASONING_ORDERING,
  UNBOUND_TURN_SEQUENCE,
  USER_ORDERING_FALLBACK,
  type TranscriptSortKey,
} from './transcript-order';
import {
  decodeTranscriptCursor,
  encodeTranscriptCursor,
} from './transcript-cursor';

/** Small page contract shared by the transitional adapters. Transcript keyset
 * pagination and its opaque cursor are implemented in P4-W3 (see
 * ./transcript-cursor and ./transcript-order). */
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

export interface RepositoryOperationEntry {
  ledgerKey: string;
  entry: OperationLedgerEntry;
}

export interface RepositoryCancelEntry {
  turnId: string;
  request: CancelRequest;
}

/**
 * Shared payload for the named graph commands. Graph tools prepare their
 * transition against a read projection, then submit only the rows they
 * created/changed. The public discriminant is deliberately domain-specific so
 * an audit can map every mutation to the coordinator operation that owns it;
 * the adapters may share one private row-transaction implementation.
 */
export type GraphCommandKind =
  | 'createChildTask'
  | 'delegateChildTask'
  | 'createChildTaskBatch'
  | 'delegateChildTaskBatch'
  | 'releaseChildTasks'
  | 'continueChildTask'
  | 'cancelChildTasks'
  | 'interruptChildTask'
  | 'cancelChildTask'
  | 'setChildTaskLifecycle'
  | 'waitForChildTasks'
  | 'completeGraphTask'
  | 'failGraphTask'
  | 'askParent'
  | 'answerChildQuestion'
  | 'consumeCancelRequest';

export interface GraphCommandPayload {
  workspaceId: string;
  /** Existing task revisions that must still match before the mutation. */
  expectedTasks: readonly { id: string; revision: number }[];
  /** Existing live-turn fences (status/runtime epoch) required by the mutation. */
  expectedTurns?: readonly { id: string; status: TurnStatus; runtimeEpoch?: number }[];
  /** Rows that must be inserted; all other supplied rows are revision-fenced upserts. */
  insertTaskIds?: readonly string[];
  tasks: readonly MusterTask[];
  insertTurnIds?: readonly string[];
  turns: readonly TaskTurn[];
  insertMessageIds?: readonly string[];
  messages?: readonly TaskMessage[];
  deleteTaskIds?: readonly string[];
  deleteTurnIds?: readonly string[];
  deleteMessageIds?: readonly string[];
  deleteOperationKeys?: readonly string[];
  operation?: { ledgerKey: string; entry: OperationLedgerEntry; createdAt: string };
  cancelRequests?: readonly { turnId: string; request: CancelRequest }[];
  deleteCancelRequestTurnIds?: readonly string[];
  deleteRuntimeClaimTurnIds?: readonly string[];
  expectedRuntimeClaims?: readonly { turnId: string; ownerId: string }[];
  expectedCancelRequests?: readonly { turnId: string; kind: CancelRequest['kind']; opId: string }[];
  deleteSessionClaimTurnIds?: readonly string[];
  deleteResourceClaimTurnIds?: readonly string[];
}

export type GraphCommand = GraphCommandPayload & { kind: GraphCommandKind };

export type RepositoryCommand =
  | GraphCommand
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
  | {
      /** Queue/start/continue boundary without a user message. */
      kind: 'queueTaskTurn'; workspaceId: string; expectedTaskRevision: number;
      maxTurnsPerTask: number; task: MusterTask; turn: TaskTurn;
    }
  | {
      /** Post-settlement FIFO drain: update the task and create all derived
       * continuation turns in one revision-fenced transaction. */
      kind: 'drainPendingSends'; workspaceId: string; expectedTaskRevision: number;
      maxTurnsPerTask: number; task: MusterTask; turns: readonly TaskTurn[]; messages?: readonly TaskMessage[];
    }
  | {
      /** Readiness attention marker guarded by the current task revision. */
      kind: 'setTaskAttention'; workspaceId: string; expectedTaskRevision: number;
      task: MusterTask;
    }
  | {
      /** Idempotent disposition-repair allocation and attention escalation. */
      kind: 'enqueueDispositionRepair'; workspaceId: string; expectedTaskRevision: number;
      maxTurnsPerTask: number; task: MusterTask; turn?: TaskTurn; message?: TaskMessage;
    }
  | {
      /** Atomically supersede a task runtime binding and preempt/retag its
       * current turns behind task/turn ownership fences. */
      kind: 'requestRuntimeHandoff'; workspaceId: string; taskId: string;
      expectedTaskRevision: number; task: MusterTask; turns: readonly TaskTurn[];
      expectedTurns: readonly { id: string; status: TurnStatus; runtimeEpoch?: number }[];
      cancelRequests?: readonly { turnId: string; request: CancelRequest }[];
    }
  | {
      /** Stage one disposition on a live turn behind a status/runtime fence. */
      kind: 'stageDisposition'; workspaceId: string; turnId: string; opId: string;
      turn: TaskTurn; expectedStatuses: readonly Extract<TurnStatus, 'running' | 'waiting_user'>[];
      expectedDisposition?: TurnDisposition;
      expectedRuntimeEpoch?: number;
    }
  | {
      /** Atomically seal one task and settle/cancel its related turns. */
      kind: 'applyTaskLifecycle'; workspaceId: string; taskId: string;
      expectedTaskRevision: number; task: MusterTask; turns: readonly TaskTurn[];
      expectedTurns?: readonly { id: string; status: TurnStatus; runtimeEpoch?: number }[];
      cancelRequests?: readonly { turnId: string; request: CancelRequest }[];
    }
  | {
      /** Atomically apply a user lifecycle cascade to a task subtree. */
      kind: 'cascadeTaskLifecycle'; workspaceId: string; rootTaskId: string;
      mode: 'skip' | 'cancel';
      expectedTasks: readonly { id: string; revision: number }[];
      tasks: readonly MusterTask[]; turns: readonly TaskTurn[];
      expectedTurns?: readonly { id: string; status: TurnStatus; runtimeEpoch?: number }[];
      cancelRequests?: readonly { turnId: string; request: CancelRequest }[];
    }
  | {
      /** Reconcile a child wait and optionally create its continuation turn. */
      kind: 'resolveChildWait'; workspaceId: string; taskId: string;
      expectedTaskRevision: number; task: MusterTask; turn?: TaskTurn;
    }
  | {
      /** Seal a dependency-policy terminal and its live/queued turn atomically. */
      kind: 'applyDependencyTerminal'; workspaceId: string; taskId: string;
      expectedTaskRevision: number; task: MusterTask; turn?: TaskTurn;
    }
  | {
      /** Propagate dependency terminal outcomes for a batch of affected tasks. */
      kind: 'applyDependencyTerminals'; workspaceId: string;
      expectedTasks: readonly { id: string; revision: number }[];
      mutations: readonly { taskId: string; task: MusterTask; turn?: TaskTurn }[];
    }
  | {
      /** Reload recovery for one orphan live turn, including queued follow-up holds. */
      kind: 'reconcileOrphanTurn'; workspaceId: string; taskId: string;
      expectedTaskRevision: number; expectedTurnStatus: Extract<TurnStatus, 'running' | 'waiting_user'>;
      task: MusterTask; turn: TaskTurn; heldTurns: readonly TaskTurn[];
    }
  | {
      /** Persist bounded verdict-remediation changes as one named batch. */
      kind: 'applyVerdictRemediation'; workspaceId: string;
      expectedTaskRevisions: readonly { id: string; revision: number }[];
      tasks: readonly MusterTask[]; turns: readonly TaskTurn[];
      messages: readonly TaskMessage[]; deletedTaskIds?: readonly string[];
    }
  | { kind: 'upsertTask'; workspaceId: string; task: MusterTask }
  | { kind: 'deleteTask'; workspaceId: string; taskId: string }
  /** Atomically remove every idle/terminal root except the focused root. */
  | { kind: 'clearHistory'; workspaceId: string; preserveRootTaskId?: string }
  /** Atomically remove one complete root subtree when every member is idle/terminal. */
  | {
      kind: 'deleteTaskSubtreeIfIdle'; workspaceId: string; rootTaskId: string;
      preserveRootTaskId?: string;
    }
  /** Host rename boundary with an optimistic task-revision fence. */
  | {
      kind: 'renameTask'; workspaceId: string; taskId: string; goal: string;
      expectedTaskRevision?: number; updatedAt: string;
    }
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
  | {
      /** Repository-owned runtime ownership fence. Claim/reclaim is conditional
       * on the row being absent, expired, or already owned by this owner. */
      kind: 'claimRuntime'; workspaceId: string; turnId: string; ownerId: string;
      claimedAt: string; heartbeatAt: string; expiresAt: string;
    }
  | {
      kind: 'heartbeatRuntime'; workspaceId: string; turnId: string; ownerId: string;
      heartbeatAt: string; expiresAt: string;
    }
  | {
      kind: 'releaseRuntime'; workspaceId: string; turnId: string; ownerId?: string;
    }
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
    }
  /** Stable host-facing name for the retention policy command. */
  | {
      kind: 'applyRetentionPolicy'; workspaceId: string; taskId: string; keepLatestTurns: number;
      maxStoredOutputChars?: number;
    };

export function isGraphCommand(command: RepositoryCommand): command is GraphCommand {
  return command.kind === 'createChildTask' || command.kind === 'delegateChildTask' ||
    command.kind === 'createChildTaskBatch' || command.kind === 'delegateChildTaskBatch' ||
    command.kind === 'releaseChildTasks' || command.kind === 'continueChildTask' ||
    command.kind === 'cancelChildTasks' || command.kind === 'interruptChildTask' ||
    command.kind === 'cancelChildTask' || command.kind === 'setChildTaskLifecycle' ||
    command.kind === 'waitForChildTasks' || command.kind === 'completeGraphTask' ||
    command.kind === 'failGraphTask' || command.kind === 'askParent' ||
    command.kind === 'answerChildQuestion' || command.kind === 'consumeCancelRequest';
}

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
 * Callers receive focused queries and named transactional commands, never a
 * mutable full-workspace envelope.
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
  listTurnsForTasks(taskIds: readonly string[]): Promise<readonly TaskTurn[]>;
  /**
   * Bounded activity projection for tree/root summaries. It includes every
   * queued/live turn plus the latest terminal turn per task; callers that need
   * a complete transcript must use listTurns(taskId) or getTranscriptPage().
   */
  listTurnActivityForTasks(taskIds: readonly string[]): Promise<readonly TaskTurn[]>;
  listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]>;
  listMessages(taskId: string): Promise<readonly TaskMessage[]>;
  listToolCalls(taskId: string): Promise<readonly PersistedToolCall[]>;
  listReasoning(taskId: string): Promise<readonly PersistedReasoning[]>;
  getOperation(ledgerKey: string): Promise<OperationLedgerEntry | undefined>;
  /** Coordination rows needed to recover live graph turns after host reload. */
  listOperationsForTurns(turnIds: readonly string[]): Promise<readonly RepositoryOperationEntry[]>;
  getCancelRequest(turnId: string): Promise<CancelRequest | undefined>;
  listCancelRequests(): Promise<readonly RepositoryCancelEntry[]>;
  getRuntimeClaim(turnId: string): Promise<RuntimeClaim | undefined>;
  listRuntimeClaims(): Promise<readonly RuntimeClaim[]>;
  getSendReceipt(clientRequestId: string): Promise<SendReceipt | undefined>;
  getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage>;
  /** Current workspace revision. */
  getWorkspaceRevision(): Promise<number>;
  execute(command: RepositoryCommand): Promise<RepositoryCommandResult>;
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

function validateQueueTaskTurn(
  command: Extract<RepositoryCommand, { kind: 'queueTaskTurn' }>,
): string | undefined {
  if (!Number.isInteger(command.maxTurnsPerTask) || command.maxTurnsPerTask < 1) {
    return 'max turns per task must be a positive integer';
  }
  if (command.turn.taskId !== command.task.id) return 'queued turn task mismatch';
  if (command.turn.status !== 'queued') return 'queued turn must be queued';
  if ((command.turn.executionEpoch ?? 1) !== (command.task.executionEpoch ?? 1)) {
    return 'queued turn execution epoch mismatch';
  }
  return undefined;
}

function validateLifecycleTask(
  command: Extract<RepositoryCommand, { kind: 'applyTaskLifecycle' | 'cascadeTaskLifecycle' }>,
): string | undefined {
  const tasks: readonly MusterTask[] = command.kind === 'applyTaskLifecycle' ? [command.task] : command.tasks;
  if (tasks.length === 0) return 'lifecycle command requires at least one task';
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return 'lifecycle command contains duplicate tasks';
  for (const task of tasks) {
    if (task.id.length === 0) return 'lifecycle task id is empty';
    if (task.parentId === task.id) return 'lifecycle task cannot parent itself';
  }
  for (const turn of command.turns) {
    if (!tasks.some((task) => task.id === turn.taskId)) return 'lifecycle turn task is outside aggregate';
  }
  return undefined;
}

function validateAggregateTaskChanges(
  tasks: readonly MusterTask[],
  turns: readonly TaskTurn[],
  messages: readonly TaskMessage[] = [],
): string | undefined {
  const taskIds = new Set(tasks.map((task) => task.id));
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return 'aggregate contains duplicate tasks';
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) return 'aggregate contains duplicate turns';
  if (new Set(messages.map((message) => message.id)).size !== messages.length) return 'aggregate contains duplicate messages';
  if (turns.some((turn) => !taskIds.has(turn.taskId))) return 'aggregate turn task mismatch';
  if (messages.some((message) => !taskIds.has(message.taskId))) return 'aggregate message task mismatch';
  return undefined;
}

function validateGraphCommand(command: GraphCommand): string | undefined {
  const taskIds = new Set(command.tasks.map((task) => task.id));
  const turnIds = new Set(command.turns.map((turn) => turn.id));
  const messageIds = new Set((command.messages ?? []).map((message) => message.id));
  if (taskIds.size !== command.tasks.length) return 'graph command contains duplicate tasks';
  if (turnIds.size !== command.turns.length) return 'graph command contains duplicate turns';
  if (messageIds.size !== (command.messages ?? []).length) return 'graph command contains duplicate messages';
  const insertTasks = new Set(command.insertTaskIds ?? []);
  const insertTurns = new Set(command.insertTurnIds ?? []);
  const insertMessages = new Set(command.insertMessageIds ?? []);
  for (const id of insertTasks) if (!taskIds.has(id)) return `graph insert task missing row: ${id}`;
  for (const id of insertTurns) if (!turnIds.has(id)) return `graph insert turn missing row: ${id}`;
  for (const id of insertMessages) if (!messageIds.has(id)) return `graph insert message missing row: ${id}`;
  const expected = new Set(command.expectedTasks.map((entry) => entry.id));
  if (expected.size !== command.expectedTasks.length) return 'graph command contains duplicate task fences';
  const expectedTurns = new Set((command.expectedTurns ?? []).map((entry) => entry.id));
  if (expectedTurns.size !== (command.expectedTurns ?? []).length) return 'graph command contains duplicate turn fences';
  for (const task of command.tasks) {
    if (task.parentId === task.id) return 'graph task cannot parent itself';
    if (task.parentId && !taskIds.has(task.parentId)) {
      // Existing parents need not be part of the bounded write set; the adapter
      // checks the FK/query fence before applying the row.
    }
    for (const dependency of task.dependencies) {
      if (dependency.taskId === task.id) return 'graph task cannot depend on itself';
    }
  }
  for (const turn of command.turns) {
    for (const input of turn.inputs) {
      if (input.kind === 'message' && !messageIds.has(input.messageId)) {
        // A pre-existing message is valid; the adapter verifies it belongs to
        // the same task when the row is present.
      }
    }
  }
  for (const message of command.messages ?? []) {
    if (message.turnId && !turnIds.has(message.turnId)) {
      // Existing turn references are valid for an upsert; SQLite FK enforces it.
    }
  }
  if (command.operation && command.operation.ledgerKey.length === 0) return 'graph operation key is empty';
  if (command.kind === 'consumeCancelRequest' &&
      ((command.expectedRuntimeClaims?.length ?? 0) === 0 ||
       (command.expectedCancelRequests?.length ?? 0) === 0)) {
    return 'cancel consumer requires runtime/request ownership fences';
  }
  return undefined;
}

function graphOperationConflict(
  existing: OperationLedgerEntry | undefined,
  command: GraphCommand,
): RepositoryCommandResult | undefined {
  if (!existing || !command.operation) return undefined;
  if (existing.fingerprint !== command.operation.entry.fingerprint) {
    return { ok: true, changed: false, reason: 'opId conflict: different arguments', conflict: true, operation: existing };
  }
  return { ok: true, changed: false, operation: existing };
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

/** SQLite-backed repository for one workspace in the shared global database. */
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
    return rows.map((row) => decodeTask(row, byTask.get(row.id) ?? []));
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
    return rows.map((row) => decodeTurn(row, byTurn.get(row.id) ?? []));
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

  async listTurnsForTasks(taskIds: readonly string[]): Promise<readonly TaskTurn[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.db.all<TurnRow>(
      `${turnSelect(`WHERE workspace_id = ? AND task_id IN (${placeholders(taskIds.length)})`)} ORDER BY task_id, sequence, created_at, id`,
      [this.workspaceId, ...taskIds],
    );
    return this.hydrateTurns(rows);
  }

  async listTurnActivityForTasks(taskIds: readonly string[]): Promise<readonly TaskTurn[]> {
    if (taskIds.length === 0) return [];
    const ids = placeholders(taskIds.length);
    const rows = await this.db.all<TurnRow>(
      `${turnSelect(`WHERE workspace_id = ? AND task_id IN (${ids}) AND (
          status IN ('queued', 'running', 'waiting_user') OR
          (status IN ('succeeded', 'failed', 'interrupted', 'cancelled') AND
           NOT EXISTS (
             SELECT 1 FROM turns newer
              WHERE newer.workspace_id = turns.workspace_id
                AND newer.task_id = turns.task_id
                AND newer.status IN ('succeeded', 'failed', 'interrupted', 'cancelled')
                AND (newer.sequence > turns.sequence OR
                     (newer.sequence = turns.sequence AND newer.created_at > turns.created_at) OR
                     (newer.sequence = turns.sequence AND newer.created_at = turns.created_at AND newer.id > turns.id))
           ))
        )`)} ORDER BY task_id, sequence, created_at, id`,
      [this.workspaceId, ...taskIds],
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

  async listOperationsForTurns(turnIds: readonly string[]): Promise<readonly RepositoryOperationEntry[]> {
    if (turnIds.length === 0) return [];
    const predicates = turnIds.map(() => 'ledger_key GLOB ?').join(' OR ');
    const rows = await this.db.all<OperationRow>(
      `SELECT ledger_key, fingerprint, result_json FROM operations
        WHERE workspace_id = ? AND (${predicates}) ORDER BY ledger_key`,
      [this.workspaceId, ...turnIds.map((turnId) => `${escapeGlob(turnId)}:*`)],
    );
    return rows.map((row) => ({ ledgerKey: row.ledger_key, entry: decodeOperation(row) }));
  }

  async getCancelRequest(turnId: string): Promise<CancelRequest | undefined> {
    const row = await this.db.get<CancelRow>(
      `SELECT turn_id, kind, op_id, requested_by, requested_at, payload_json
         FROM turn_cancel_requests WHERE workspace_id = ? AND turn_id = ?`,
      [this.workspaceId, turnId],
    );
    return row ? decodeCancelRequest(row) : undefined;
  }

  async listCancelRequests(): Promise<readonly RepositoryCancelEntry[]> {
    const rows = await this.db.all<CancelRow>(
      `SELECT turn_id, kind, op_id, requested_by, requested_at, payload_json
         FROM turn_cancel_requests WHERE workspace_id = ? ORDER BY turn_id`,
      [this.workspaceId],
    );
    return rows.map((row) => ({ turnId: row.turn_id, request: decodeCancelRequest(row) }));
  }

  async getRuntimeClaim(turnId: string): Promise<RuntimeClaim | undefined> {
    const row = await this.db.get<RuntimeClaimRow>(
      `SELECT turn_id, owner_id, claimed_at, heartbeat_at, expires_at
         FROM runtime_claims WHERE workspace_id = ? AND turn_id = ?`,
      [this.workspaceId, turnId],
    );
    return row ? decodeRuntimeClaim(row) : undefined;
  }

  async listRuntimeClaims(): Promise<readonly RuntimeClaim[]> {
    const rows = await this.db.all<RuntimeClaimRow>(
      `SELECT turn_id, owner_id, claimed_at, heartbeat_at, expires_at
         FROM runtime_claims WHERE workspace_id = ? ORDER BY turn_id`,
      [this.workspaceId],
    );
    return rows.map(decodeRuntimeClaim);
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
    const bounded = normalizeLimit(limit);
    const scope = { workspaceId: this.workspaceId, taskId };
    // A cursor is decoded/validated up front so an invalid one fails before any SQL,
    // and its key components enter the query only as bound parameters (never interpolated).
    const cursorKey = cursor === undefined ? undefined : decodeTranscriptCursor(cursor, scope);

    // Single read snapshot: one statement selects both the revision and the page, so
    // transcript rows and workspaceRevision are read consistently. The revision is
    // carried via a `rev` CTE cross-joined to the page so it survives an empty page
    // (LEFT JOIN yields one sentinel row with NULL entity columns + the revision).
    // Parameter order mirrors the `?` placeholders in transcriptPageSql, top to bottom:
    const params: SqlValue[] = [this.workspaceId]; // rev CTE
    params.push(this.workspaceId, taskId); // task_turns CTE (scopes every branch)
    params.push(this.workspaceId, taskId); // user branch WHERE
    params.push(this.workspaceId); // user branch queued-visibility EXISTS
    params.push(this.workspaceId, taskId); // assistant branch WHERE
    // reasoning & tool branches drive off task_turns — no additional bound params.
    // Keyset compares against the NORMALIZED sort column (sort_ordering), the same
    // column the ORDER BY uses; cursorKey.ordering already carries the normalized value.
    const keysetPredicate = cursorKey
      ? `WHERE (turn_sequence, kind_rank, sort_ordering, created_at, entity_id) < (?, ?, ?, ?, ?)`
      : '';
    if (cursorKey) {
      params.push(cursorKey.turnSequence, cursorKey.kindRank, cursorKey.ordering, cursorKey.createdAt, cursorKey.entityId);
    }
    params.push(bounded + 1); // limit + 1: the extra row only decides hasMoreBefore.

    const rows = await this.db.all<TranscriptPageRow>(transcriptPageSql(keysetPredicate), params);
    const revision = rows[0]?.revision ?? 0;
    // Drop the sentinel (empty-page) row; keep only real transcript rows, newest-first.
    const realRows = rows.filter((row): row is TranscriptPageRow & { entity_id: string } => row.entity_id !== null);
    const hasMoreBefore = realRows.length > bounded;
    // Decode at most `bounded` items; the limit+1 row is never materialized as a DTO.
    const pageDesc = realRows.slice(0, bounded);
    const oldestInPage = pageDesc[pageDesc.length - 1];
    const items = pageDesc.map(decodeTranscriptRow).reverse(); // reverse → ascending render order

    return {
      items,
      ...(hasMoreBefore && oldestInPage
        ? { beforeCursor: encodeTranscriptCursor(scope, transcriptRowKey(oldestInPage)) }
        : {}),
      hasMoreBefore,
      workspaceRevision: revision,
    };
  }

  async getWorkspaceRevision(): Promise<number> {
    const row = await this.db.get<{ revision: number }>(
      'SELECT revision FROM workspace_revisions WHERE workspace_id = ?',
      [this.workspaceId],
    );
    return row?.revision ?? 0;
  }

  private async write(
    statements: readonly SqlStatement[],
    changed: readonly ChangeRecord[],
    at: string,
  ): Promise<readonly import('./sqlite/rpc').RunResult[]> {
    return this.db.transaction([...statements, ...revisionStatements(this.workspaceId, changed, at)]);
  }

  private async renameTask(
    command: Extract<RepositoryCommand, { kind: 'renameTask' }>,
  ): Promise<RepositoryCommandResult> {
    const revisionPredicate = command.expectedTaskRevision === undefined ? '' : ' AND revision = ?';
    const params: SqlValue[] = [
      command.goal,
      command.updatedAt,
      this.workspaceId,
      command.taskId,
      ...(command.expectedTaskRevision === undefined ? [] : [command.expectedTaskRevision]),
    ];
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE tasks
                 SET goal = ?, updated_at = ?, revision = revision + 1
               WHERE workspace_id = ? AND id = ?${revisionPredicate}`,
        params,
      },
      [],
      { kind: 'task', id: command.taskId, change: 'rename' },
      command.updatedAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return {
      ok: true,
      changed,
      ...(changed ? {} : { reason: 'task changed or no longer exists' }),
    };
  }

  private async applyGraphCommand(
    command: GraphCommand,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateGraphCommand(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };

    const statements: SqlStatement[] = [];
    const abortIfUnchangedAt: number[] = [];
    const changes: ChangeRecord[] = [];
    const insertTasks = new Set(command.insertTaskIds ?? []);
    const insertTurns = new Set(command.insertTurnIds ?? []);
    const insertMessages = new Set(command.insertMessageIds ?? []);

    if (command.operation) {
      statements.push(graphOperationClaimStatement(this.workspaceId, command.operation));
      abortIfUnchangedAt.push(0);
    }
    if (command.expectedTasks.length > 0) {
      const index = statements.length;
      statements.push(taskRevisionGuardStatement(this.workspaceId, command.expectedTasks));
      abortIfUnchangedAt.push(index);
    }
    // Task revision and live-turn epoch/status are independent fences. Graph
    // commands commonly carry both (notably cancel consumption); checking only
    // the task fence would let a stale worker settle a superseded turn.
    if (command.expectedTurns && command.expectedTurns.length > 0) {
      const index = statements.length;
      statements.push(graphTurnFenceStatement(this.workspaceId, command.expectedTurns));
      abortIfUnchangedAt.push(index);
    }
    if (command.expectedRuntimeClaims && command.expectedRuntimeClaims.length > 0) {
      const index = statements.length;
      statements.push(graphRuntimeClaimFenceStatement(this.workspaceId, command.expectedRuntimeClaims));
      abortIfUnchangedAt.push(index);
    }
    if (command.expectedCancelRequests && command.expectedCancelRequests.length > 0) {
      const index = statements.length;
      statements.push(graphCancelRequestFenceStatement(this.workspaceId, command.expectedCancelRequests));
      abortIfUnchangedAt.push(index);
    }

    // Delete dependent rows before parent rows. Foreign-key cascades handle
    // turn-bound artifacts, while explicit message deletes cover turn-less
    // user messages.
    for (const messageId of command.deleteMessageIds ?? []) {
      statements.push({
        sql: 'DELETE FROM messages WHERE workspace_id = ? AND id = ?',
        params: [this.workspaceId, messageId],
      });
      changes.push({ kind: 'message', id: messageId, change: 'delete' });
    }
    for (const turnId of command.deleteTurnIds ?? []) {
      statements.push({
        sql: 'DELETE FROM turns WHERE workspace_id = ? AND id = ?',
        params: [this.workspaceId, turnId],
      });
      changes.push({ kind: 'turn', id: turnId, change: 'delete' });
    }
    for (const taskId of command.deleteTaskIds ?? []) {
      statements.push({
        sql: 'DELETE FROM tasks WHERE workspace_id = ? AND id = ?',
        params: [this.workspaceId, taskId],
      });
      changes.push({ kind: 'task', id: taskId, change: 'delete' });
    }

    // Insert/update task rows first, then dependencies. This allows sibling
    // dependencies in one batch to reference a task inserted later in the
    // caller's deterministic list.
    for (const task of command.tasks) {
      statements.push(taskStatement(this.workspaceId, task, !insertTasks.has(task.id)));
      changes.push({ kind: 'task', id: task.id, change: insertTasks.has(task.id) ? 'insert' : 'update' });
    }
    for (const task of command.tasks) {
      statements.push({ sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, task.id] });
      for (const dependency of task.dependencies) {
        statements.push(dependencyStatement(this.workspaceId, task.id, dependency));
      }
    }

    // Turns precede message rows because messages may carry a turn FK; inputs
    // are inserted after the turn row and before messages.
    for (const turn of command.turns) {
      statements.push(turnStatement(this.workspaceId, turn, !insertTurns.has(turn.id)));
      changes.push({ kind: 'turn', id: turn.id, taskId: turn.taskId, change: insertTurns.has(turn.id) ? 'insert' : 'update' });
    }
    for (const turn of command.turns) {
      statements.push({ sql: 'DELETE FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turn.id] });
      for (const input of turn.inputs) {
        statements.push(turnInputStatement(this.workspaceId, turn.id, turn.inputs.indexOf(input), input));
      }
    }
    for (const message of command.messages ?? []) {
      statements.push(messageStatement(this.workspaceId, message, !insertMessages.has(message.id)));
      changes.push({ kind: 'message', id: message.id, taskId: message.taskId, change: insertMessages.has(message.id) ? 'insert' : 'update' });
    }
    for (const entry of command.cancelRequests ?? []) {
      statements.push(cancelRequestStatement(this.workspaceId, { kind: 'putCancelRequest', workspaceId: this.workspaceId, turnId: entry.turnId, request: entry.request }));
      changes.push({ kind: 'cancel_request', id: entry.turnId, change: 'upsert' });
    }
    for (const turnId of command.deleteCancelRequestTurnIds ?? []) {
      statements.push({ sql: 'DELETE FROM turn_cancel_requests WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turnId] });
      changes.push({ kind: 'cancel_request', id: turnId, change: 'delete' });
    }
    for (const turnId of command.deleteRuntimeClaimTurnIds ?? []) {
      statements.push({ sql: 'DELETE FROM runtime_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turnId] });
      changes.push({ kind: 'runtime_claim', id: turnId, change: 'delete' });
    }
    for (const ledgerKey of command.deleteOperationKeys ?? []) {
      statements.push({ sql: 'DELETE FROM operations WHERE workspace_id = ? AND ledger_key = ?', params: [this.workspaceId, ledgerKey] });
      changes.push({ kind: 'operation', id: ledgerKey, change: 'delete' });
    }
    for (const turnId of command.deleteSessionClaimTurnIds ?? []) {
      statements.push({ sql: 'DELETE FROM session_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turnId] });
      changes.push({ kind: 'runtime_claim', id: `${turnId}:session`, change: 'release' });
    }
    for (const turnId of command.deleteResourceClaimTurnIds ?? []) {
      statements.push({ sql: 'DELETE FROM resource_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, turnId] });
      changes.push({ kind: 'runtime_claim', id: `${turnId}:resource`, change: 'release' });
    }
    if (command.operation) {
      changes.push({ kind: 'operation', id: command.operation.ledgerKey, change: 'insert' });
    }

    // A graph command with no row work is a valid replay/no-op but must not
    // manufacture a workspace revision. Operation claims still make it safe to
    // return the prior result under contention.
    const uniqueChanges = [...new Map(changes.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values()];
    const at = command.operation?.createdAt ?? command.tasks[0]?.updatedAt ?? new Date().toISOString();
    if (uniqueChanges.length > 0) {
      statements.push(...revisionStatements(this.workspaceId, uniqueChanges, at));
    }

    let results: readonly import('./sqlite/rpc').RunResult[];
    try {
      results = await this.db.transaction(statements, {
        abortIfUnchangedAt: abortIfUnchangedAt.length > 0 ? abortIfUnchangedAt : undefined,
      });
    } catch (error) {
      // Do not leak SQL/row payloads through the repository boundary. The
      // caller can retry a stale graph or surface a stable validation reason.
      const message = error instanceof Error ? error.message : String(error);
      if (/constraint|unique|foreign key/i.test(message)) {
        return { ok: true, changed: false, reason: 'graph command rejected' };
      }
      throw error;
    }

    if (command.operation && results[0]?.changes === 0) {
      const existing = await this.getOperation(command.operation.ledgerKey);
      if (existing && existing.fingerprint === command.operation.entry.fingerprint) {
        return { ok: true, changed: false, operation: existing };
      }
      if (existing) {
        return { ok: true, changed: false, reason: 'opId conflict: different arguments', conflict: true, operation: existing };
      }
      return { ok: true, changed: false, reason: 'task changed; retry' };
    }
    for (const index of abortIfUnchangedAt) {
      if (index === 0 && command.operation) continue;
      if (results[index]?.changes === 0) {
        return { ok: true, changed: false, reason: 'graph ownership fence changed; retry' };
      }
    }
    const guardIndex = command.operation ? 1 : 0;
    if (command.expectedTasks.length > 0 && results[guardIndex]?.changes === 0) {
      return { ok: true, changed: false, reason: 'task changed; retry' };
    }
    return {
      ok: true,
      changed: uniqueChanges.length > 0,
      ...(command.operation ? { operation: command.operation.entry } : {}),
    };
  }

  /**
   * Delete one or all top-level roots only when every task in each candidate
   * subtree is currently removable. The recursive CTE and the live/queued/
   * dependency predicates execute inside the same IMMEDIATE transaction as the
   * DELETE, so a late child or turn cannot be orphaned by a stale host read.
   */
  private async deleteTaskRootsIfIdle(
    command:
      | Extract<RepositoryCommand, { kind: 'clearHistory' }>
      | Extract<RepositoryCommand, { kind: 'deleteTaskSubtreeIfIdle' }>,
  ): Promise<RepositoryCommandResult> {
    const isSingle = command.kind === 'deleteTaskSubtreeIfIdle';
    if (isSingle) {
      const root = await this.db.get<{ parent_id: string | null }>(
        'SELECT parent_id FROM tasks WHERE workspace_id = ? AND id = ?',
        [this.workspaceId, command.rootTaskId],
      );
      if (!root) return { ok: true, changed: false };
      if (root.parent_id !== null) {
        return { ok: true, changed: false, reason: 'Only top-level tasks can be deleted.' };
      }
      if (command.preserveRootTaskId === command.rootTaskId) {
        return { ok: true, changed: false, reason: 'Cannot delete the focused task.' };
      }
    }
    const rootFilter = isSingle ? 'AND id = ?' : '';
    const rootParams: SqlValue[] = isSingle ? [command.rootTaskId] : [];
    const preserve = command.preserveRootTaskId ?? null;
    const sql = `WITH RECURSIVE candidate(id, root_id) AS (
          SELECT id, id
            FROM tasks
           WHERE workspace_id = ? AND parent_id IS NULL
             ${rootFilter}
             AND (? IS NULL OR id <> ?)
          UNION
          SELECT child.id, candidate.root_id
            FROM tasks child
            JOIN candidate ON child.parent_id = candidate.id
           WHERE child.workspace_id = ?
        ), blocked(root_id) AS (
          SELECT DISTINCT candidate.root_id
            FROM candidate
            JOIN tasks task ON task.workspace_id = ? AND task.id = candidate.id
           WHERE EXISTS (
                   SELECT 1 FROM turns live
                    WHERE live.workspace_id = task.workspace_id
                      AND live.task_id = task.id
                      AND live.status IN ('running', 'waiting_user')
                 )
              OR EXISTS (
                   SELECT 1 FROM turns queued
                    WHERE queued.workspace_id = task.workspace_id
                      AND queued.task_id = task.id
                      AND queued.status = 'queued'
                 )
              OR (
                   task.lifecycle = 'open' AND (
                     json_extract(task.payload_json, '$.wait.kind') IS NOT NULL
                     OR json_extract(task.payload_json, '$.outcomeProposal') IS NOT NULL
                     OR EXISTS (
                          SELECT 1
                            FROM task_dependencies dependency
                            LEFT JOIN tasks producer
                              ON producer.workspace_id = dependency.workspace_id
                             AND producer.id = dependency.dependency_task_id
                           WHERE dependency.workspace_id = task.workspace_id
                             AND dependency.task_id = task.id
                             AND NOT (
                               ((dependency.required_outcome = 'succeeded' AND producer.lifecycle = 'succeeded')
                                 OR (dependency.required_outcome = 'settled' AND producer.lifecycle IN ('succeeded','failed','cancelled','skipped')))
                               AND (dependency.required_verdict IS NULL
                                 OR json_extract(producer.payload_json, '$.taskResult.verdict.status') = 'pass')
                             )
                        )
                     OR EXISTS (
                          SELECT 1
                            FROM turns latest
                           WHERE latest.workspace_id = task.workspace_id
                             AND latest.task_id = task.id
                             AND latest.status IN ('failed', 'interrupted')
                             AND NOT EXISTS (
                                  SELECT 1 FROM turns newer
                                   WHERE newer.workspace_id = latest.workspace_id
                                     AND newer.task_id = latest.task_id
                                     AND (newer.sequence > latest.sequence OR
                                          (newer.sequence = latest.sequence AND newer.id > latest.id))
                                )
                        )
                   )
                 )
        )
        DELETE FROM tasks
         WHERE workspace_id = ?
           AND id IN (
             SELECT candidate.id FROM candidate
              WHERE candidate.root_id NOT IN (SELECT root_id FROM blocked)
           )`;
    const params: SqlValue[] = [
      this.workspaceId,
      ...rootParams,
      preserve,
      preserve,
      this.workspaceId,
      this.workspaceId,
      this.workspaceId,
    ];
    const change: ChangeRecord = {
      kind: 'task',
      id: isSingle ? command.rootTaskId : this.workspaceId,
      change: isSingle ? 'delete_subtree' : 'clear_history',
    };
    const results = await this.writeIfFirstChanged(
      { sql, params },
      [],
      change,
      new Date().toISOString(),
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return {
      ok: true,
      changed,
      ...(!changed && isSingle
        ? { reason: 'Cannot delete a task while it or a subtask is still active.' }
        : {}),
    };
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
      case 'createChildTask':
      case 'delegateChildTask':
      case 'createChildTaskBatch':
      case 'delegateChildTaskBatch':
      case 'releaseChildTasks':
      case 'continueChildTask':
      case 'cancelChildTasks':
      case 'interruptChildTask':
      case 'cancelChildTask':
      case 'setChildTaskLifecycle':
      case 'waitForChildTasks':
      case 'completeGraphTask':
      case 'failGraphTask':
      case 'askParent':
      case 'answerChildQuestion':
      case 'consumeCancelRequest':
        return this.applyGraphCommand(command);
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
      case 'queueTaskTurn':
        return this.queueTaskTurn(command);
      case 'drainPendingSends':
        return this.drainPendingSends(command);
      case 'setTaskAttention':
        return this.setTaskAttention(command);
      case 'enqueueDispositionRepair':
        return this.enqueueDispositionRepair(command);
      case 'requestRuntimeHandoff':
        return this.requestRuntimeHandoff(command);
      case 'stageDisposition':
        return this.stageDisposition(command);
      case 'applyTaskLifecycle':
        return this.applyTaskLifecycle(command);
      case 'cascadeTaskLifecycle':
        return this.cascadeTaskLifecycle(command);
      case 'resolveChildWait':
        return this.resolveChildWait(command);
      case 'applyDependencyTerminal':
        return this.applyDependencyTerminal(command);
      case 'applyDependencyTerminals':
        return this.applyDependencyTerminals(command);
      case 'reconcileOrphanTurn':
        return this.reconcileOrphanTurn(command);
      case 'applyVerdictRemediation':
        return this.applyVerdictRemediation(command);
      case 'upsertTask':
        return this.writeTask(command.task, true);
      case 'clearHistory':
        return this.deleteTaskRootsIfIdle(command);
      case 'deleteTaskSubtreeIfIdle':
        return this.deleteTaskRootsIfIdle(command);
      case 'renameTask':
        return this.renameTask(command);
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
      case 'claimRuntime':
        return this.claimRuntime(command);
      case 'heartbeatRuntime':
        return this.heartbeatRuntime(command);
      case 'releaseRuntime':
        return this.releaseRuntime(command);
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
      case 'applyRetentionPolicy':
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

  private async queueTaskTurn(
    command: Extract<RepositoryCommand, { kind: 'queueTaskTurn' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateQueueTaskTurn(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const rest: SqlStatement[] = [
      { sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, command.task.id] },
      ...command.task.dependencies.map((dependency) => dependencyStatement(this.workspaceId, command.task.id, dependency)),
      turnStatement(this.workspaceId, command.turn, false),
      ...command.turn.inputs.map((input, ordering) => turnInputStatement(this.workspaceId, command.turn.id, ordering, input)),
    ];
    const results = await this.writeIfFirstChanged(
      guardedTaskUpdateStatement(this.workspaceId, command.task, command.expectedTaskRevision, command.maxTurnsPerTask),
      rest,
      [
        { kind: 'task', id: command.task.id, change: 'queue' },
        { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'insert' },
      ],
      command.turn.createdAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'task changed or max turns per task exceeded; retry' }) };
  }

  private async drainPendingSends(
    command: Extract<RepositoryCommand, { kind: 'drainPendingSends' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.turns.some((turn) => turn.taskId !== command.task.id || turn.status !== 'queued')) {
      return { ok: true, changed: false, reason: 'continuation turn is invalid' };
    }
    const rest: SqlStatement[] = [
      { sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [this.workspaceId, command.task.id] },
      ...command.task.dependencies.map((dependency) => dependencyStatement(this.workspaceId, command.task.id, dependency)),
      ...command.turns.flatMap((turn) => [
        turnStatement(this.workspaceId, turn, false),
        ...turn.inputs.map((input, ordering) => turnInputStatement(this.workspaceId, turn.id, ordering, input)),
      ]),
      ...(command.messages ?? []).map((message) => messageStatement(this.workspaceId, message, true)),
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'drain_pending_sends' },
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'continuation' })),
      ...(command.messages ?? []).map((message) => ({ kind: 'message' as const, id: message.id, taskId: message.taskId, change: 'assign' })),
    ];
    const results = await this.writeIfFirstChanged(
      guardedTaskUpdateStatement(this.workspaceId, command.task, command.expectedTaskRevision, command.maxTurnsPerTask),
      rest,
      changes,
      command.task.updatedAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'task changed; retry' }) };
  }

  private async setTaskAttention(
    command: Extract<RepositoryCommand, { kind: 'setTaskAttention' }>,
  ): Promise<RepositoryCommandResult> {
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE tasks SET parent_id=?, role=?, lifecycle=?, release_state=?, goal=?, backend=?, model=?,
                revision=?, created_at=?, updated_at=?, payload_json=?
              WHERE workspace_id=? AND id=? AND revision=?`,
        params: [command.task.parentId, command.task.role, command.task.lifecycle,
          command.task.releaseState, command.task.goal, command.task.backend,
          command.task.model ?? null, command.task.revision, command.task.createdAt,
          command.task.updatedAt, taskPayload(command.task), this.workspaceId,
          command.task.id, command.expectedTaskRevision],
      },
      [],
      { kind: 'task', id: command.task.id, change: 'attention' },
      command.task.updatedAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'task changed; retry' }) };
  }

  private async enqueueDispositionRepair(
    command: Extract<RepositoryCommand, { kind: 'enqueueDispositionRepair' }>,
  ): Promise<RepositoryCommandResult> {
    const rest: SqlStatement[] = [];
    if (command.turn) {
      rest.push(turnStatement(this.workspaceId, command.turn, false));
      rest.push(...command.turn.inputs.map((input, ordering) => turnInputStatement(this.workspaceId, command.turn!.id, ordering, input)));
    }
    if (command.message) rest.push(messageStatement(this.workspaceId, command.message, false));
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'disposition_repair' },
      ...(command.turn ? [{ kind: 'turn' as const, id: command.turn.id, taskId: command.turn.taskId, change: 'disposition_repair' }] : []),
      ...(command.message ? [{ kind: 'message' as const, id: command.message.id, taskId: command.message.taskId, change: 'disposition_repair' }] : []),
    ];
    const results = await this.writeIfFirstChanged(
      guardedTaskUpdateStatement(this.workspaceId, command.task, command.expectedTaskRevision, command.maxTurnsPerTask),
      rest,
      changes,
      command.task.updatedAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'task changed or repair already exists' }) };
  }

  private async requestRuntimeHandoff(
    command: Extract<RepositoryCommand, { kind: 'requestRuntimeHandoff' }>,
  ): Promise<RepositoryCommandResult> {
    const fence = appendTurnFence(
      'UPDATE tasks SET updated_at = updated_at WHERE workspace_id = ? AND id = ? AND revision = ?',
      [this.workspaceId, command.taskId, command.expectedTaskRevision],
      this.workspaceId,
      command.expectedTurns,
    );
    const rest: SqlStatement[] = [
      ...taskMutationStatements(this.workspaceId, command.task),
      ...command.turns.flatMap((turn) => turnMutationStatements(this.workspaceId, turn)),
      ...(command.cancelRequests ?? []).map((entry) => cancelRequestStatement(this.workspaceId, {
        kind: 'putCancelRequest', workspaceId: this.workspaceId, turnId: entry.turnId, request: entry.request,
      })),
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.taskId, change: 'runtime_handoff' },
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'runtime_handoff' })),
      ...(command.cancelRequests ?? []).map((entry) => ({ kind: 'cancel_request' as const, id: entry.turnId, change: 'runtime_handoff' })),
    ];
    const results = await this.writeIfFirstChanged(
      { sql: fence.sql, params: fence.params }, rest, changes, command.task.updatedAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'task or turn changed; retry' }) };
  }

  private async stageDisposition(
    command: Extract<RepositoryCommand, { kind: 'stageDisposition' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.expectedStatuses.length === 0) return { ok: true, changed: false, reason: 'expected live status required' };
    if (command.expectedDisposition !== undefined && JSON.stringify(command.expectedDisposition) !== JSON.stringify(command.turn.disposition)) {
      return { ok: true, changed: false, reason: 'disposition already staged' };
    }
    const results = await this.writeIfFirstChanged(
      guardedStageDispositionStatement(this.workspaceId, command),
      [],
      { kind: 'turn', id: command.turnId, taskId: command.turn.taskId, change: 'stage_disposition' },
      command.turn.startedAt ?? command.turn.createdAt,
    );
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is no longer live' } : {}),
    };
  }

  private async applyTaskLifecycle(
    command: Extract<RepositoryCommand, { kind: 'applyTaskLifecycle' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateLifecycleTask(command);
    if (invalid || command.task.id !== command.taskId) return { ok: true, changed: false, reason: invalid ?? 'lifecycle task id mismatch' };
    const rest: SqlStatement[] = [
      ...taskMutationStatements(this.workspaceId, command.task),
      ...command.turns.flatMap((turn) => turnMutationStatements(this.workspaceId, turn)),
      ...(command.cancelRequests ?? []).map((entry) => cancelRequestStatement(this.workspaceId, {
        kind: 'putCancelRequest', workspaceId: this.workspaceId, turnId: entry.turnId, request: entry.request,
      })),
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'lifecycle' },
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'lifecycle' })),
      ...(command.cancelRequests ?? []).map((entry) => ({ kind: 'cancel_request' as const, id: entry.turnId, change: 'put' })),
    ];
    const lifecycleGuard = appendTurnFence(
      `UPDATE tasks SET updated_at = updated_at
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
      [this.workspaceId, command.taskId, command.expectedTaskRevision],
      this.workspaceId,
      command.expectedTurns,
    );
    const results = await this.writeIfFirstChanged(
      { sql: lifecycleGuard.sql, params: lifecycleGuard.params },
      rest,
      changes,
      command.task.updatedAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed; retry' } : {}) };
  }

  private async cascadeTaskLifecycle(
    command: Extract<RepositoryCommand, { kind: 'cascadeTaskLifecycle' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateLifecycleTask(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const rest: SqlStatement[] = [
      ...command.tasks.flatMap((task) => taskMutationStatements(this.workspaceId, task)),
      ...command.turns.flatMap((turn) => turnMutationStatements(this.workspaceId, turn)),
      ...(command.cancelRequests ?? []).map((entry) => cancelRequestStatement(this.workspaceId, {
        kind: 'putCancelRequest', workspaceId: this.workspaceId, turnId: entry.turnId, request: entry.request,
      })),
    ];
    const changes: ChangeRecord[] = [
      ...command.tasks.map((task) => ({ kind: 'task' as const, id: task.id, change: `cascade_${command.mode}` })),
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: `cascade_${command.mode}` })),
      ...(command.cancelRequests ?? []).map((entry) => ({ kind: 'cancel_request' as const, id: entry.turnId, change: 'put' })),
    ];
    const cascadeGuard = taskRevisionGuardStatement(this.workspaceId, command.expectedTasks);
    const fencedCascade = appendTurnFence(cascadeGuard.sql, cascadeGuard.params ?? [], this.workspaceId, command.expectedTurns);
    const results = await this.writeIfFirstChanged(
      { sql: fencedCascade.sql, params: fencedCascade.params },
      rest,
      changes,
      command.tasks[0]?.updatedAt ?? new Date().toISOString(),
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed; retry' } : {}) };
  }

  private async resolveChildWait(
    command: Extract<RepositoryCommand, { kind: 'resolveChildWait' }>,
  ): Promise<RepositoryCommandResult> {
    return this.applyTaskAndOptionalTurn(command, 'child_wait');
  }

  private async applyDependencyTerminal(
    command: Extract<RepositoryCommand, { kind: 'applyDependencyTerminal' }>,
  ): Promise<RepositoryCommandResult> {
    return this.applyTaskAndOptionalTurn(command, 'dependency_terminal');
  }

  private async applyDependencyTerminals(
    command: Extract<RepositoryCommand, { kind: 'applyDependencyTerminals' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.mutations.length === 0 || command.expectedTasks.length === 0) return { ok: true, changed: false };
    const rest: SqlStatement[] = [];
    for (const mutation of command.mutations) {
      rest.push(...taskMutationStatements(this.workspaceId, mutation.task));
      if (mutation.turn) rest.push(...turnMutationStatements(this.workspaceId, mutation.turn));
    }
    const changes: ChangeRecord[] = command.mutations.flatMap((mutation) => [
      { kind: 'task' as const, id: mutation.taskId, change: 'dependency_terminal' },
      ...(mutation.turn ? [{ kind: 'turn' as const, id: mutation.turn.id, taskId: mutation.turn.taskId, change: 'dependency_terminal' }] : []),
    ]);
    const results = await this.writeIfFirstChanged(
      taskRevisionGuardStatement(this.workspaceId, command.expectedTasks),
      rest,
      changes,
      command.mutations[0]!.task.updatedAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed; retry' } : {}) };
  }

  private async applyTaskAndOptionalTurn(
    command:
      | Extract<RepositoryCommand, { kind: 'resolveChildWait' }>
      | Extract<RepositoryCommand, { kind: 'applyDependencyTerminal' }>,
    change: string,
  ): Promise<RepositoryCommandResult> {
    const rest: SqlStatement[] = [
      ...taskMutationStatements(this.workspaceId, command.task),
      ...(command.turn ? turnMutationStatements(this.workspaceId, command.turn) : []),
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change },
      ...(command.turn ? [{ kind: 'turn' as const, id: command.turn.id, taskId: command.turn.taskId, change }] : []),
    ];
    const results = await this.writeIfFirstChanged(
      { sql: 'UPDATE tasks SET updated_at = updated_at WHERE workspace_id = ? AND id = ? AND revision = ?', params: [this.workspaceId, command.taskId, command.expectedTaskRevision] },
      rest,
      changes,
      command.task.updatedAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed; retry' } : {}) };
  }

  private async reconcileOrphanTurn(
    command: Extract<RepositoryCommand, { kind: 'reconcileOrphanTurn' }>,
  ): Promise<RepositoryCommandResult> {
    const rest: SqlStatement[] = [
      ...taskMutationStatements(this.workspaceId, command.task),
      ...turnMutationStatements(this.workspaceId, command.turn),
      ...command.heldTurns.flatMap((turn) => turnMutationStatements(this.workspaceId, turn)),
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'reload_reconcile' },
      { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'reload_reconcile' },
      ...command.heldTurns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'hold_follow_up' })),
    ];
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE tasks SET updated_at = updated_at
               WHERE workspace_id = ? AND id = ? AND revision = ?
                 AND EXISTS (SELECT 1 FROM turns WHERE workspace_id = ? AND id = ? AND status = ?)`,
        params: [this.workspaceId, command.taskId, command.expectedTaskRevision, this.workspaceId, command.turn.id, command.expectedTurnStatus],
      },
      rest,
      changes,
      command.turn.finishedAt ?? command.turn.createdAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'orphan state changed; retry' } : {}) };
  }

  private async applyVerdictRemediation(
    command: Extract<RepositoryCommand, { kind: 'applyVerdictRemediation' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateAggregateTaskChanges(command.tasks, command.turns, command.messages);
    if (invalid || command.expectedTaskRevisions.length === 0) {
      return { ok: true, changed: false, reason: invalid ?? 'remediation revision guard is empty' };
    }
    const rest: SqlStatement[] = [];
    for (const id of command.deletedTaskIds ?? []) {
      rest.push({ sql: 'DELETE FROM tasks WHERE workspace_id = ? AND id = ?', params: [this.workspaceId, id] });
    }
    for (const task of command.tasks) rest.push(...taskMutationStatements(this.workspaceId, task));
    for (const turn of command.turns) rest.push(...turnMutationStatements(this.workspaceId, turn));
    for (const message of command.messages) rest.push(messageStatement(this.workspaceId, message, true));
    const changes: ChangeRecord[] = [
      ...command.deletedTaskIds?.map((id) => ({ kind: 'task' as const, id, change: 'delete_remediation' })) ?? [],
      ...command.tasks.map((task) => ({ kind: 'task' as const, id: task.id, change: 'verdict_remediation' })),
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'verdict_remediation' })),
      ...command.messages.map((message) => ({ kind: 'message' as const, id: message.id, taskId: message.taskId, change: 'verdict_remediation' })),
    ];
    const results = await this.writeIfFirstChanged(
      taskRevisionGuardStatement(this.workspaceId, command.expectedTaskRevisions),
      rest,
      changes,
      command.tasks[0]?.updatedAt ?? new Date().toISOString(),
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed; retry' } : {}) };
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

  private async claimRuntime(
    command: Extract<RepositoryCommand, { kind: 'claimRuntime' }>,
  ): Promise<RepositoryCommandResult> {
    const results = await this.writeIfFirstChanged(
      {
        sql: `INSERT INTO runtime_claims
                (workspace_id, turn_id, owner_id, claimed_at, heartbeat_at, expires_at)
              SELECT ?, id, ?, ?, ?, ? FROM turns
               WHERE workspace_id = ? AND id = ?
              ON CONFLICT(workspace_id, turn_id) DO UPDATE SET
                owner_id = excluded.owner_id,
                claimed_at = CASE WHEN runtime_claims.owner_id = excluded.owner_id
                                  THEN runtime_claims.claimed_at ELSE excluded.claimed_at END,
                heartbeat_at = excluded.heartbeat_at,
                expires_at = excluded.expires_at
               WHERE runtime_claims.owner_id = excluded.owner_id
                  OR runtime_claims.expires_at <= excluded.claimed_at`,
        params: [this.workspaceId, command.ownerId, command.claimedAt, command.heartbeatAt,
          command.expiresAt, this.workspaceId, command.turnId],
      },
      [],
      { kind: 'runtime_claim', id: command.turnId, change: 'claim' },
      command.heartbeatAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'runtime claim is owned by another worker or turn is missing' }) };
  }

  private async heartbeatRuntime(
    command: Extract<RepositoryCommand, { kind: 'heartbeatRuntime' }>,
  ): Promise<RepositoryCommandResult> {
    const results = await this.writeIfFirstChanged(
      {
        sql: `UPDATE runtime_claims
                 SET heartbeat_at = ?, expires_at = ?
               WHERE workspace_id = ? AND turn_id = ? AND owner_id = ?
                 AND expires_at > ?`,
        params: [command.heartbeatAt, command.expiresAt, this.workspaceId, command.turnId,
          command.ownerId, command.heartbeatAt],
      },
      [],
      { kind: 'runtime_claim', id: command.turnId, change: 'heartbeat' },
      command.heartbeatAt,
    );
    const changed = (results[0]?.changes ?? 0) > 0;
    return { ok: true, changed, ...(changed ? {} : { reason: 'runtime claim owner mismatch or expired' }) };
  }

  private async releaseRuntime(
    command: Extract<RepositoryCommand, { kind: 'releaseRuntime' }>,
  ): Promise<RepositoryCommandResult> {
    const ownerPredicate = command.ownerId === undefined ? '' : ' AND owner_id = ?';
    const params: SqlValue[] = [this.workspaceId, command.turnId,
      ...(command.ownerId === undefined ? [] : [command.ownerId])];
    const results = await this.writeIfFirstChanged(
      { sql: `DELETE FROM runtime_claims WHERE workspace_id = ? AND turn_id = ?${ownerPredicate}`, params },
      [],
      { kind: 'runtime_claim', id: command.turnId, change: 'release' },
      new Date().toISOString(),
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
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
      { sql: 'DELETE FROM runtime_claims WHERE workspace_id = ? AND turn_id = ?', params: [this.workspaceId, command.turn.id] },
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

  private async applyRetention(
    command:
      | Extract<RepositoryCommand, { kind: 'applyRetention' }>
      | Extract<RepositoryCommand, { kind: 'applyRetentionPolicy' }>,
  ): Promise<RepositoryCommandResult> {
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
    // An open task may have a live turn while retention runs in another
    // window. Only settled turns are eligible: trimming reasoning or a tool
    // result that is still streaming would corrupt the active transcript just
    // as surely as deleting the row.
    const settledTurnIds = new Set(
      (await this.listTurns(task.id))
        .filter((turn) => isTerminalTurn(turn.status))
        .map((turn) => turn.id),
    );
    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];
    for (const message of await this.listMessages(task.id)) {
      if (message.role !== 'assistant' || message.state !== 'complete' ||
        !message.turnId || !settledTurnIds.has(message.turnId)) continue;
      const content = truncateRetentionContent(message.content, maxChars);
      if (content === message.content) continue;
      statements.push({
        sql: 'UPDATE messages SET content = ? WHERE workspace_id = ? AND id = ? AND content = ?',
        params: [content, this.workspaceId, message.id, message.content],
      });
      changes.push({ kind: 'message', id: message.id, taskId: task.id, change: 'truncate' });
    }
    for (const tool of await this.listToolCalls(task.id)) {
      if (!settledTurnIds.has(tool.turnId) || typeof tool.output !== 'string') continue;
      const output = truncateRetentionContent(tool.output, maxChars);
      if (output === tool.output) continue;
      statements.push(toolCallStatement(this.workspaceId, { ...tool, output }));
      changes.push({ kind: 'tool_call', id: tool.id, taskId: task.id, change: 'truncate' });
    }
    for (const reasoning of await this.listReasoning(task.id)) {
      if (!settledTurnIds.has(reasoning.turnId)) continue;
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
  | 'tool_call' | 'reasoning' | 'operation' | 'cancel_request' | 'send_receipt'
  | 'runtime_claim';

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
    params: [task.id, workspaceId, task.parentId, task.role, task.lifecycle, task.releaseState,
      task.goal, task.backend, task.model ?? null, task.revision, task.createdAt, task.updatedAt,
      taskPayload(task)],
  };
}

function taskMutationStatements(workspaceId: string, task: MusterTask): SqlStatement[] {
  return [
    taskStatement(workspaceId, task, true),
    { sql: 'DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?', params: [workspaceId, task.id] },
    ...task.dependencies.map((dependency) => dependencyStatement(workspaceId, task.id, dependency)),
  ];
}

function turnMutationStatements(workspaceId: string, turn: TaskTurn): SqlStatement[] {
  return [
    turnStatement(workspaceId, turn, true),
    { sql: 'DELETE FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', params: [workspaceId, turn.id] },
    ...turn.inputs.map((input, ordering) => turnInputStatement(workspaceId, turn.id, ordering, input)),
  ];
}

function taskRevisionGuardStatement(
  workspaceId: string,
  expected: readonly { id: string; revision: number }[],
): SqlStatement {
  if (expected.length === 0) {
    throw new Error('task revision guard requires at least one task');
  }
  const first = expected[0]!;
  const mismatch = expected
    .map(() => '(checked.id = ? AND checked.revision <> ?)')
    .join(' OR ');
  const mismatchParams = expected.flatMap((entry) => [entry.id, entry.revision] as SqlValue[]);
  const ids = placeholders(expected.length);
  return {
    sql: `UPDATE tasks SET updated_at = updated_at
           WHERE workspace_id = ? AND id = ? AND revision = ?
             AND (SELECT COUNT(*) FROM tasks present
                    WHERE present.workspace_id = ? AND present.id IN (${ids})) = ?
             AND NOT EXISTS (
                   SELECT 1 FROM tasks checked
                    WHERE checked.workspace_id = ? AND (${mismatch})
             )`,
    params: [
      workspaceId, first.id, first.revision,
      workspaceId, ...expected.map((entry) => entry.id), expected.length,
      workspaceId, ...mismatchParams,
    ],
  };
}

function appendTurnFence(
  baseSql: string,
  baseParams: SqlValue[],
  workspaceId: string,
  expectedTurns: readonly { id: string; status: TurnStatus; runtimeEpoch?: number }[] | undefined,
): { sql: string; params: SqlValue[] } {
  if (!expectedTurns || expectedTurns.length === 0) return { sql: baseSql, params: baseParams };
  const mismatch = expectedTurns.map((entry) =>
    entry.runtimeEpoch === undefined
      ? '(checked_turn.id = ? AND checked_turn.status <> ?)'
      : `(checked_turn.id = ? AND (checked_turn.status <> ? OR COALESCE(json_extract(checked_turn.payload_json, '$.runtimeEpoch'), 1) <> ?))`,
  ).join(' OR ');
  const mismatchParams = expectedTurns.flatMap((entry) =>
    entry.runtimeEpoch === undefined
      ? [entry.id, entry.status] as SqlValue[]
      : [entry.id, entry.status, entry.runtimeEpoch] as SqlValue[],
  );
  const ids = placeholders(expectedTurns.length);
  return {
    sql: `${baseSql}
      AND (SELECT COUNT(*) FROM turns present_turn
             WHERE present_turn.workspace_id = ? AND present_turn.id IN (${ids})) = ?
      AND NOT EXISTS (
            SELECT 1 FROM turns checked_turn
             WHERE checked_turn.workspace_id = ? AND (${mismatch})
          )`,
    params: [
      ...baseParams,
      workspaceId, ...expectedTurns.map((entry) => entry.id), expectedTurns.length,
      workspaceId, ...mismatchParams,
    ],
  };
}

/**
 * Optimistic task update used by the FIFO enqueue command. The turn-cap
 * predicate is evaluated while the IMMEDIATE transaction owns the write lock,
 * so two extension hosts cannot both reserve the final slot of an execution
 * epoch. `turns.payload_json` owns executionEpoch in the current schema.
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
      task.parentId, task.role, task.lifecycle, task.releaseState, task.goal, task.backend,
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
      task.parentId, task.role, task.lifecycle, task.releaseState, task.goal, task.backend,
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

function guardedStageDispositionStatement(
  workspaceId: string,
  command: Extract<RepositoryCommand, { kind: 'stageDisposition' }>,
): SqlStatement {
  const dispositionPredicate = command.expectedDisposition === undefined
    ? (command.turn.disposition === undefined
      ? ` AND json_extract(payload_json, '$.disposition') IS NULL`
      : ` AND (json_extract(payload_json, '$.disposition') IS NULL OR json_extract(payload_json, '$.disposition') = json(?))`)
    : ` AND json_extract(payload_json, '$.disposition') = json(?)`;
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
           WHERE workspace_id=? AND id=? AND status IN (${placeholders(command.expectedStatuses.length)})${dispositionPredicate}${epochPredicate}`,
    params: [
      command.turn.taskId, command.turn.sequence, command.turn.status, command.turn.trigger, command.turn.createdAt,
      command.turn.startedAt ?? null, command.turn.finishedAt ?? null, turnPayload(command.turn), workspaceId, command.turnId,
      ...command.expectedStatuses,
      ...(command.turn.disposition === undefined || command.expectedDisposition !== undefined ? [] : [JSON.stringify(command.turn.disposition)]),
      ...(command.expectedDisposition === undefined ? [] : [JSON.stringify(command.expectedDisposition)]),
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

function graphOperationClaimStatement(
  workspaceId: string,
  operation: NonNullable<GraphCommand['operation']>,
): SqlStatement {
  return {
    sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
          VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
    params: [workspaceId, operation.ledgerKey, operation.entry.fingerprint,
      encodePayload({ result: operation.entry.result }), operation.createdAt],
  };
}

function graphTurnFenceStatement(
  workspaceId: string,
  expected: readonly { id: string; status: TurnStatus; runtimeEpoch?: number }[],
): SqlStatement {
  if (expected.length === 0) throw new Error('turn fence requires at least one turn');
  const mismatch = expected.map((entry) => entry.runtimeEpoch === undefined
    ? '(checked.id = ? AND checked.status <> ?)'
    : `(checked.id = ? AND (checked.status <> ? OR COALESCE(json_extract(checked.payload_json, '$.runtimeEpoch'), 1) <> ?))`).join(' OR ');
  const mismatchParams = expected.flatMap((entry) => entry.runtimeEpoch === undefined
    ? [entry.id, entry.status] as SqlValue[]
    : [entry.id, entry.status, entry.runtimeEpoch] as SqlValue[]);
  return {
    sql: `UPDATE turns SET payload_json = payload_json
           WHERE workspace_id = ? AND id = ? AND status = ?
             AND (SELECT COUNT(*) FROM turns present WHERE present.workspace_id = ? AND present.id IN (${placeholders(expected.length)})) = ?
             AND NOT EXISTS (SELECT 1 FROM turns checked WHERE checked.workspace_id = ? AND (${mismatch}))`,
    params: [workspaceId, expected[0]!.id, expected[0]!.status,
      workspaceId, ...expected.map((entry) => entry.id), expected.length,
      workspaceId, ...mismatchParams],
  };
}

function graphRuntimeClaimFenceStatement(
  workspaceId: string,
  expected: readonly { turnId: string; ownerId: string }[],
): SqlStatement {
  if (expected.length === 0) throw new Error('runtime claim fence requires at least one claim');
  const mismatch = expected.map(() => '(checked.turn_id = ? AND checked.owner_id <> ?)').join(' OR ');
  const mismatchParams = expected.flatMap((entry) => [entry.turnId, entry.ownerId] as SqlValue[]);
  return {
    sql: `UPDATE runtime_claims SET heartbeat_at = heartbeat_at
           WHERE workspace_id = ? AND turn_id = ? AND owner_id = ?
             AND (SELECT COUNT(*) FROM runtime_claims present WHERE present.workspace_id = ? AND present.turn_id IN (${placeholders(expected.length)})) = ?
             AND NOT EXISTS (SELECT 1 FROM runtime_claims checked WHERE checked.workspace_id = ? AND (${mismatch}))`,
    params: [workspaceId, expected[0]!.turnId, expected[0]!.ownerId,
      workspaceId, ...expected.map((entry) => entry.turnId), expected.length,
      workspaceId, ...mismatchParams],
  };
}

function graphCancelRequestFenceStatement(
  workspaceId: string,
  expected: readonly { turnId: string; kind: CancelRequest['kind']; opId: string }[],
): SqlStatement {
  if (expected.length === 0) throw new Error('cancel request fence requires at least one request');
  const mismatch = expected.map(() => '(checked.turn_id = ? AND (checked.kind <> ? OR checked.op_id <> ?))').join(' OR ');
  const mismatchParams = expected.flatMap((entry) => [entry.turnId, entry.kind, entry.opId] as SqlValue[]);
  return {
    sql: `UPDATE turn_cancel_requests SET requested_at = requested_at
           WHERE workspace_id = ? AND turn_id = ? AND kind = ? AND op_id = ?
             AND (SELECT COUNT(*) FROM turn_cancel_requests present WHERE present.workspace_id = ? AND present.turn_id IN (${placeholders(expected.length)})) = ?
             AND NOT EXISTS (SELECT 1 FROM turn_cancel_requests checked WHERE checked.workspace_id = ? AND (${mismatch}))`,
    params: [workspaceId, expected[0]!.turnId, expected[0]!.kind, expected[0]!.opId,
      workspaceId, ...expected.map((entry) => entry.turnId), expected.length,
      workspaceId, ...mismatchParams],
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
    sql: `WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT candidate.id, candidate.parent_id
              FROM turns candidate_turn
              JOIN tasks candidate
                ON candidate.workspace_id = candidate_turn.workspace_id
               AND candidate.id = candidate_turn.task_id
             WHERE candidate_turn.workspace_id = ? AND candidate_turn.id = ?
            UNION
            SELECT parent.id, parent.parent_id
              FROM tasks parent JOIN ancestors child ON parent.id = child.parent_id
             WHERE parent.workspace_id = ?
          ), owning_root(id) AS (
            SELECT id FROM ancestors WHERE parent_id IS NULL LIMIT 1
          ), root_tree(id) AS (
            SELECT id FROM owning_root
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
                            AND candidate.release_state = 'released'
                            AND COALESCE(json_extract(turns.payload_json, '$.runtimeEpoch'), 1) =
                                COALESCE(json_extract(candidate.payload_json, '$.runtimeEpoch'), 1)
                            AND json_extract(candidate.payload_json, '$.wait.kind') IS NOT 'external'
                            AND (
                              json_extract(candidate.payload_json, '$.wait.kind') IS NULL OR
                              json_extract(candidate.payload_json, '$.wait.kind') IS NOT 'children' OR
                              (turns.trigger = 'engine' AND (turns.id LIKE '%parent-q-%' OR turns.id LIKE '%-attention'))
                            )
                            AND NOT EXISTS (
                              SELECT 1 FROM json_each(candidate.payload_json, '$.inputBindings') binding
                               WHERE COALESCE(json_extract(binding.value, '$.required'), 1) <> 0
                                 AND NOT EXISTS (
                                   SELECT 1 FROM tasks producer
                                    WHERE producer.workspace_id = candidate.workspace_id
                                      AND producer.id = json_extract(binding.value, '$.fromTaskId')
                                      AND json_extract(producer.payload_json, '$.taskResult.summary') IS NOT NULL
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
    params: [workspaceId, turnId, workspaceId, workspaceId, command.startedAt, workspaceId, turnId,
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
  release_state: string;
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

interface RuntimeClaimRow {
  turn_id: string;
  owner_id: string;
  claimed_at: string;
  heartbeat_at: string;
  expires_at: string;
}

interface ReceiptRow {
  client_request_id: string;
  fingerprint: string;
  task_id: string;
  message_id: string;
  turn_id: string;
  created_at: string;
}

/**
 * One row of the keyset page query. Columns are shared across the four UNION
 * branches; a `revision`-only sentinel row (all entity columns NULL) is emitted
 * when the page is empty so the workspace revision is always readable.
 */
interface TranscriptPageRow {
  revision: number;
  entity_id: string | null;
  kind: string | null;
  turn_id: string | null;
  turn_sequence: number | null;
  kind_rank: number | null;
  /** Normalized ordering used for sort/keyset/cursor (never null on a real row). */
  sort_ordering: number | null;
  /** Raw source ordering: nullable for user/assistant, tool's own counter, NULL for reasoning. */
  ordering: number | null;
  created_at: string | null;
  content: string | null;
  payload_json: string | null;
  status: string | null;
  name: string | null;
  tool_call_id: string | null;
  state: string | null;
}

/**
 * Canonical keyset page query (P4-W3). One statement — hence one implicit read
 * snapshot — selects the workspace revision and a `limit + 1` newest-first window
 * of transcript items across four UNION ALL branches (user message, reasoning,
 * assistant message, tool call). The sort key and per-kind ranks/orderings mirror
 * `buildTranscript()` via the shared constants in ./transcript-order.
 *
 * User messages carry no `turn_id`; they bind to a turn through `turn_inputs`
 * (kind='message', messageId in payload_json). A user message whose bound turn is
 * still `queued` is hidden unless that turn is the sole, user-triggered opening
 * turn — matching the projector's queued-visibility rule.
 *
 * `keysetPredicate` is either empty (latest page) or a strict `<` tuple comparison
 * bound to the cursor key (older page). All cursor components arrive as bound
 * parameters; nothing is interpolated.
 */
export function transcriptPageSql(keysetPredicate: string): string {
  const userOrdering = `COALESCE(m.ordering, ${USER_ORDERING_FALLBACK})`;
  const assistantOrdering = `COALESCE(m.ordering, ${ASSISTANT_ORDERING_FALLBACK})`;
  return `
WITH rev AS (
  SELECT COALESCE((SELECT revision FROM workspace_revisions WHERE workspace_id = ?), 0) AS revision
),
-- Scope every branch to this task's turns up front (idx_turns_task_sequence). MATERIALIZED
-- stops SQLite from flattening this CTE back into each branch (which would let the planner
-- reorder joins and seek reasoning/tool/turn_inputs by workspace_id alone — scanning every
-- row of that table for the workspace). Materialized once, it is a tiny bounded row source
-- that the CROSS JOINs below use as the outer driver so each detail table is sought per turn.
task_turns AS MATERIALIZED (
  SELECT id, sequence, status, trigger, workspace_id
  FROM turns
  WHERE workspace_id = ? AND task_id = ?
),
turn_count AS (
  SELECT COUNT(*) AS n FROM task_turns
),
-- Resolve each user message's owning turn via turn_inputs, last-write-wins by turn
-- sequence then input ordering — parity with the projector's msgTurn map, which
-- overwrites in ascending turn order so the highest-sequence binding survives.
input_bindings AS (
  SELECT message_id, turn_id FROM (
    SELECT
      json_extract(ti.payload_json, '$.messageId') AS message_id,
      ti.turn_id AS turn_id,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(ti.payload_json, '$.messageId')
        ORDER BY tt.sequence DESC, ti.ordering DESC
      ) AS rn
    -- CROSS JOIN pins task_turns as the outer loop: SQLite will not reorder it to drive
    -- from turn_inputs (workspace_id alone), so each binding is sought by (workspace_id, turn_id).
    FROM task_turns tt
    CROSS JOIN turn_inputs ti
      ON ti.workspace_id = tt.workspace_id AND ti.turn_id = tt.id AND ti.kind = 'message'
  )
  WHERE rn = 1
),
items AS (
  -- User messages: bind turn via direct turn_id or turn_inputs. Unbound messages
  -- (no turn_id, no binding) stay visible at turn_sequence = -1; queued follow-ups
  -- hide unless this is the sole opening user turn.
  SELECT
    m.id AS entity_id, 'user' AS kind, bt.id AS turn_id,
    COALESCE(bt.sequence, ${UNBOUND_TURN_SEQUENCE}) AS turn_sequence,
    ${KIND_RANK.user} AS kind_rank,
    ${userOrdering} AS sort_ordering, m.ordering AS ordering,
    m.created_at AS created_at, m.content AS content, m.payload_json AS payload_json,
    NULL AS status, NULL AS name, NULL AS tool_call_id, m.state AS state
  FROM messages m
  LEFT JOIN input_bindings ib ON ib.message_id = m.id
  LEFT JOIN task_turns bt ON bt.id = COALESCE(m.turn_id, ib.turn_id)
  WHERE m.workspace_id = ? AND m.task_id = ? AND m.role = 'user'
    AND (
      bt.id IS NULL                       -- unbound: always visible
      OR bt.status <> 'queued'            -- resolved / running: visible
      OR (                                 -- queued: only the sole opening user turn
        bt.trigger = 'user'
        AND (SELECT n FROM turn_count) = 1
        AND EXISTS (
          SELECT 1 FROM turn_inputs ti2
          WHERE ti2.workspace_id = ? AND ti2.turn_id = bt.id AND ti2.kind = 'message'
        )
      )
    )

  UNION ALL

  -- Assistant messages: carry a direct turn_id; scoped to this task's turns.
  SELECT
    m.id, 'assistant', at.id,
    COALESCE(at.sequence, ${UNBOUND_TURN_SEQUENCE}),
    ${KIND_RANK.assistant},
    ${assistantOrdering}, m.ordering,
    m.created_at, m.content, m.payload_json,
    NULL, NULL, NULL, m.state
  FROM messages m
  LEFT JOIN task_turns at ON at.id = m.turn_id
  WHERE m.workspace_id = ? AND m.task_id = ? AND m.role = 'assistant'

  UNION ALL

  -- Reasoning: CROSS JOIN pins task_turns as the driver so each turn's reasoning is
  -- sought by (workspace_id, turn_id) via idx_reasoning_turn_order — never a workspace scan.
  SELECT
    r.id, 'reasoning', r.turn_id,
    rt.sequence,
    ${KIND_RANK.reasoning}, ${REASONING_ORDERING}, NULL,
    r.created_at, r.content, NULL,
    NULL, NULL, NULL, NULL
  FROM task_turns rt
  CROSS JOIN reasoning_segments r ON r.workspace_id = rt.workspace_id AND r.turn_id = rt.id

  UNION ALL

  -- Tool calls: CROSS JOIN pins task_turns as the driver so each turn's tool calls are
  -- sought by (workspace_id, turn_id) via idx_tool_calls_turn_order — never a workspace scan.
  SELECT
    tc.id, 'tool', tc.turn_id,
    tt.sequence,
    ${KIND_RANK.tool}, tc.ordering, tc.ordering,
    tc.created_at, NULL, tc.payload_json,
    tc.status, tc.name, tc.tool_call_id, NULL
  FROM task_turns tt
  CROSS JOIN tool_calls tc ON tc.workspace_id = tt.workspace_id AND tc.turn_id = tt.id
),
page AS (
  SELECT * FROM items
  ${keysetPredicate}
  ORDER BY turn_sequence DESC, kind_rank DESC, sort_ordering DESC, created_at DESC, entity_id DESC
  LIMIT ?
)
SELECT rev.revision AS revision, page.entity_id AS entity_id, page.kind AS kind, page.turn_id AS turn_id,
       page.turn_sequence AS turn_sequence, page.kind_rank AS kind_rank,
       page.sort_ordering AS sort_ordering, page.ordering AS ordering,
       page.created_at AS created_at, page.content AS content, page.payload_json AS payload_json,
       page.status AS status, page.name AS name, page.tool_call_id AS tool_call_id, page.state AS state
  FROM rev LEFT JOIN page ON 1 = 1
  ORDER BY page.turn_sequence DESC, page.kind_rank DESC, page.sort_ordering DESC,
           page.created_at DESC, page.entity_id DESC
`;
}

/** Recover the canonical sort key from a page row (used to mint `beforeCursor`). */
function transcriptRowKey(row: TranscriptPageRow & { entity_id: string }): TranscriptSortKey {
  return {
    turnSequence: row.turn_sequence ?? UNBOUND_TURN_SEQUENCE,
    kindRank: row.kind_rank ?? 0,
    // Mint the cursor from the NORMALIZED ordering (matches ORDER BY + keyset), not
    // the raw source column which is nullable for user/assistant messages.
    ordering: row.sort_ordering ?? 0,
    createdAt: row.created_at ?? '',
    entityId: row.entity_id,
  };
}

/** Decode one non-sentinel page row into a repository transcript item. */
function decodeTranscriptRow(row: TranscriptPageRow & { entity_id: string }): RepositoryTranscriptItem {
  const createdAt = row.created_at ?? undefined;
  if (row.kind === 'user' || row.kind === 'assistant') {
    return {
      id: row.entity_id,
      kind: row.kind,
      content: row.content ?? '',
      ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
      ...(row.ordering !== null ? { order: row.ordering } : {}),
      ...(row.state !== null ? { state: row.state as TaskMessage['state'] } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
  if (row.kind === 'reasoning') {
    return {
      id: row.entity_id,
      kind: 'reasoning',
      turnId: row.turn_id ?? '',
      content: row.content ?? '',
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
  // Tool call: content object is composed from promoted columns + payload_json.
  const payload = row.payload_json ? parsePayload(row.payload_json, 'tool call') : {};
  delete payload.payloadVersion;
  return {
    id: row.entity_id,
    kind: 'tool',
    turnId: row.turn_id ?? '',
    order: row.ordering ?? 0,
    content: {
      ...payload,
      ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.status !== null ? { status: row.status } : {}),
    },
    ...(createdAt !== undefined ? { createdAt } : {}),
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
  if (object.payloadVersion !== 1) {
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

/** Hydrate promoted columns over a validated current-version payload. */
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

function decodeTask(row: TaskRow, dependencies: readonly TaskDependency[]): MusterTask {
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
    releaseState: oneOf(row.release_state, ['draft', 'released'] as const, 'release_state', 'task'),
    dependencies,
  };
  delete task.payloadVersion;
  if (!Array.isArray(task.capabilities) || !task.executionPolicy || typeof task.executionPolicy !== 'object') {
    throw new Error('invalid task row in SQLite store: missing domain payload fields');
  }
  return task as unknown as MusterTask;
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

function decodeTurn(row: TurnRow, inputs: readonly TurnInput[]): TaskTurn {
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
    inputs,
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
  if (!encoded.result || typeof encoded.result !== 'object' || Array.isArray(encoded.result)) {
    throw new Error('invalid operation row in SQLite store: result must be object');
  }
  const result = encoded.result as Record<string, unknown>;
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

function decodeRuntimeClaim(row: RuntimeClaimRow): RuntimeClaim {
  return {
    turnId: requiredString(row.turn_id, 'turn_id', 'runtime claim'),
    ownerId: requiredString(row.owner_id, 'owner_id', 'runtime claim'),
    claimedAt: requiredString(row.claimed_at, 'claimed_at', 'runtime claim'),
    heartbeatAt: requiredString(row.heartbeat_at, 'heartbeat_at', 'runtime claim'),
    expiresAt: requiredString(row.expires_at, 'expires_at', 'runtime claim'),
  };
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
