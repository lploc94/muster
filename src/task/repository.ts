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
import {
  decodeStoredTopologyJson,
  DEFAULT_WORKFLOW_POLICY,
  defineWorkflowConflict,
  defineWorkflowCreated,
  defineWorkflowInvalid,
  defineWorkflowLedgerKey,
  defineWorkflowReplay,
  formatWorkflowEntryAggregate,
  startWorkflowConflict,
  startWorkflowCreated,
  startWorkflowInvalid,
  startWorkflowLedgerKey,
  startWorkflowReplay,
  validateDefineWorkflow,
  validateStartWorkflow,
  entryNodeIds,
  deriveNodeActivationIdentities,
  deriveNextContributionMessageId,
  deriveProducerArtifactId,
  deriveProducerArtifactRevision,
  deriveFeedbackRoundId,
  deriveFeedbackRequestMessageId,
  deriveFeedbackRequestActivationId,
  deriveFeedbackResponseMessageId,
  deriveFeedbackTargetId,
  deriveFeedbackTargetTurnId,
  deriveFeedbackTargetMessageId,
  deriveFeedbackResumeTurnId,
  deriveFeedbackResumeMessageId,
  deriveFeedbackResumeActivationId,
  deriveRunClosureFenceId,
  workflowRunAttentionCode,
  workflowRunTerminalStatusForReason,
  boundWorkflowFailReason,
  type WorkflowFailReasonCode,
  outgoingEdge,
  consumerInputRefsInDefinitionOrder,
  terminalNodeId,
  maximumWorkflowEntryAggregateBytes,
  deriveChildInvocationFenceId,
  deriveChildReturnFenceId,
  deriveChildContinuationId,
  deriveCallerReturnGateId,
  deriveCallerResumeTurnId,
  deriveCallerReturnMessageId,
  deriveChildStartIdempotencyKey,
  stableId,
  validateInvokeChildEntryBindings,
  type DefineWorkflowResult,
  type StartWorkflowResult,
  type WorkflowDefinitionV1,
  type WorkflowPolicyV1,
} from './workflow';
import type { WorkflowTaskStatusProjection } from './workflow-types';
import { durableDispositionClaim, type DurableDispositionClaim } from './disposition-claim';
import { isMutatingTask, normalizedWritePaths } from './resources';
import { canPromoteTurn } from './scheduler';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import {
  LIVE_TURN_STATUSES,
  isTerminalLifecycle, isTerminalTurn
} from './transitions';
import { TRUNCATION_MARKER } from './retention';
import type { RunResult, SqlStatement, SqlValue } from './sqlite/rpc';
import { CHANGE_FEED_RETAIN_REVISIONS } from './sqlite/schema';
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
  | 'workflowNextGraphTask'
  | 'workflowPrevGraphTask'
  | 'workflowFailGraphTask'
  | 'invokeChildGraphTask'
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
  dispositionClaim?: DurableDispositionClaim;
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
  | {
      kind: 'putSendOutbox';
      workspaceId: string;
      entry: SendOutboxEntry;
    }
  | {
      kind: 'markSendOutboxRejected';
      workspaceId: string;
      clientRequestId: string;
      updatedAt: string;
    }
  | {
      kind: 'deleteSendOutbox';
      workspaceId: string;
      clientRequestId: string;
    }
  | {
      kind: 'putPresentation';
      workspaceId: string;
      document: PresentationRecord;
    }
  | {
      /** Immutable one-node workflow definition claim + insert (M018 S01). */
      kind: 'defineWorkflowVersion';
      workspaceId: string;
      definitionId: string;
      version: number;
      name: string;
      topology: unknown;
      entryContracts?: unknown;
      policy?: WorkflowPolicyV1;
      ownerRootTaskId?: string;
      publicOperation?: {
        ledgerKey: string;
        fingerprint: string;
      };
      createdAt: string;
    }
  | {
      /**
       * Idempotent compound start for a frozen one-node definition (M018 S01).
       * Claims startIdempotencyKey, then inserts run/node/gate/artifact/task/
       * aggregate message + exactly one queued entry turn in one transaction.
       */
      kind: 'startWorkflowRun';
      workspaceId: string;
      definitionId: string;
      version: number;
      startIdempotencyKey: string;
      createdAt: string;
      goal?: string;
      backend?: string;
      entryInputs?: readonly {
        entryNodeId: string;
        inputRef: string;
        kind: string;
        value: string;
      }[];
      ownerRootTaskId?: string;
      callerTaskId?: string;
      callerTurnId?: string;
      effectivePolicy?: WorkflowPolicyV1;
      publicOperation?: {
        ledgerKey: string;
        fingerprint: string;
      };
    }
  | {
      /** Close every running workflow whose frozen absolute deadline has elapsed. */
      kind: 'reapWorkflowTimeouts'; workspaceId: string; now: string;
    }
  | {
      /** Explicitly queue a new execution for one failed/interrupted logical activation. */
      kind: 'recoverWorkflowActivation'; workspaceId: string;
      runId: string; activationId: string; failedTurnId: string;
      recoveryOperationId: string; fingerprint: string; instruction: string;
      expectedActivationStatus: 'failed' | 'interrupted'; createdAt: string;
    }
  | {
      /** Atomic durable coordinator idempotency claim + presentation commit. */
      kind: 'commitPresentationOperation';
      workspaceId: string;
      operationKey: string;
      fingerprint: string;
      document: PresentationRecord;
    }
  | {
      kind: 'deletePresentation';
      workspaceId: string;
      rootId: string;
      presentationId: string;
    }
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
    command.kind === 'failGraphTask' || command.kind === 'workflowNextGraphTask' ||
    command.kind === 'workflowPrevGraphTask' ||
    command.kind === 'workflowFailGraphTask' ||
    command.kind === 'invokeChildGraphTask' ||
    command.kind === 'askParent' ||
    command.kind === 'answerChildQuestion' || command.kind === 'consumeCancelRequest';
}

export interface RepositoryCommandResult {
  /**
   * True for applied/replayed commands; false for fail-closed domain conflicts
   * (e.g. define/start workflow fingerprint or validation failures).
   */
  ok: boolean;
  changed?: boolean;
  /** A non-secret, UI-safe denial reason for a conditional command. */
  reason?: string;
  /** Present for operation-idempotency replay/claim commands. */
  operation?: OperationLedgerEntry;
  conflict?: boolean;
  /** Queue mutation result fields; absent for unrelated commands. */
  messageId?: string;
  deletedMessageIds?: readonly string[];
  presentationStatus?:
    | 'committed'
    | 'idempotent'
    | 'op_conflict'
    | 'stale_revision'
    | 'owner_mismatch';
}

export type WorkflowTransactionalCommand = Extract<
  RepositoryCommand,
  {
    kind:
      | GraphCommand['kind']
      | 'stageDisposition'
      | 'applyTaskLifecycle'
      | 'cascadeTaskLifecycle'
      | 'defineWorkflowVersion'
      | 'startWorkflowRun'
      | 'reapWorkflowTimeouts'
      | 'recoverWorkflowActivation'
      | 'settleTurnAndApplyEffects';
  }
>;

export function isWorkflowTransactionalCommand(
  command: RepositoryCommand,
): command is WorkflowTransactionalCommand {
  return isGraphCommand(command) || [
    'stageDisposition',
    'applyTaskLifecycle',
    'cascadeTaskLifecycle',
    'defineWorkflowVersion',
    'startWorkflowRun',
    'reapWorkflowTimeouts',
    'recoverWorkflowActivation',
    'settleTurnAndApplyEffects',
  ].includes(command.kind);
}

export interface RepositoryDatabase {
  all<T = unknown>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  transaction(
    statements: SqlStatement[],
    options?: { abortIfFirstUnchanged?: boolean; abortIfUnchangedAt?: number[] },
  ): Promise<RunResult[]>;
  pragma(pragma: string): Promise<number>;
  executeWorkflowMutation?(
    command: WorkflowTransactionalCommand,
    changeFeedRetainRevisions: number,
  ): Promise<RepositoryCommandResult>;
}

type WorkflowTurnReservation = {
  runId: string;
  taskId: string;
  count: number;
};

type WorkflowRunReservation = {
  runId: string;
  count: number;
};

type WorkflowEffectPlan = {
  statements: SqlStatement[];
  changes: ChangeRecord[];
  feedbackRoundReservations?: WorkflowRunReservation[];
  turnReservations?: WorkflowTurnReservation[];
  conflictReason?: string;
};

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
  /**
   * Batched task hydration by id for external feed reconciliation.
   * One SQL query for the whole set — never N+1 getTask RPCs.
   */
  listTasksByIds(taskIds: readonly string[]): Promise<readonly MusterTask[]>;
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
  /**
   * Bounded input-message projection: user/assistant messages bound as inputs of
   * queued/running/waiting_user turns for the given tasks. This is the only
   * transcript content the runtime projection may hold — it powers queued
   * previews and the turn-start user bubble without loading full history.
   */
  listActiveTurnInputMessages(taskIds: readonly string[]): Promise<readonly TaskMessage[]>;
  /**
   * Count turns for a task within an execution epoch, restricted to the given
   * statuses (default: all). Turn-cap enforcement uses this so a bounded
   * projection that omits historical terminal turns cannot undercount slots.
   */
  countTurnsForTaskEpoch(
    taskId: string,
    executionEpoch: number,
    statuses?: readonly TaskTurn['status'][],
  ): Promise<number>;
  /**
   * Highest turn sequence for a task (0 if none). Used by bootstrap reconcile
   * to allocate the next sequence without hydrating full turn history.
   */
  getMaxTurnSequence(taskId: string): Promise<number>;
  /**
   * Depth of the `retryOf` chain ending at `turnId` (0 when the turn has no
   * predecessor). Recursive CTE — O(depth), never loads the task's full history.
   */
  countRetryDepth(turnId: string): Promise<number>;
  /**
   * Engine-triggered turns after `afterSequence` whose inputs include
   * `child_results`. Bounded (small LIMIT) — used by child-wait reconcile to
   * detect an already-queued continuation without full history.
   */
  listEngineChildResultsAfter(
    taskId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<readonly TaskTurn[]>;
  listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]>;
  listMessages(taskId: string): Promise<readonly TaskMessage[]>;
  listToolCalls(taskId: string): Promise<readonly PersistedToolCall[]>;
  listReasoning(taskId: string): Promise<readonly PersistedReasoning[]>;
  /**
   * Bounded entity hydration by id for external feed reconciliation. One query
   * per entity kind — never N+1 and never full-task transcript list.
   */
  listMessagesByIds(ids: readonly string[]): Promise<readonly TaskMessage[]>;
  listToolCallsByIds(ids: readonly string[]): Promise<readonly PersistedToolCall[]>;
  listReasoningByIds(ids: readonly string[]): Promise<readonly PersistedReasoning[]>;
  getOperation(ledgerKey: string): Promise<OperationLedgerEntry | undefined>;
  /** Coordination rows needed to recover live graph turns after host reload. */
  listOperationsForTurns(turnIds: readonly string[]): Promise<readonly RepositoryOperationEntry[]>;
  getCancelRequest(turnId: string): Promise<CancelRequest | undefined>;
  /**
   * Batched cancel-request projection for the given turn ids (one SQL query).
   * Empty input → []. Used by the bounded runtime projection so refresh never
   * fans out to per-turn getCancelRequest RPCs.
   */
  listCancelRequestsForTurns(turnIds: readonly string[]): Promise<readonly RepositoryCancelEntry[]>;
  getRuntimeClaim(turnId: string): Promise<RuntimeClaim | undefined>;
  /**
   * Batched runtime-claim projection for the given turn ids (one SQL query).
   * Empty input → []. Same no-N+1 contract as listCancelRequestsForTurns.
   */
  listRuntimeClaimsForTurns(turnIds: readonly string[]): Promise<readonly RuntimeClaim[]>;
  getSendReceipt(clientRequestId: string): Promise<SendReceipt | undefined>;
  listSendOutbox(limit?: number): Promise<readonly SendOutboxEntry[]>;
  getSendOutbox(clientRequestId: string): Promise<SendOutboxEntry | undefined>;
  getPresentation(rootId: string, presentationId: string): Promise<PresentationRecord | undefined>;
  getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage>;
  /** Current workspace revision. */
  getWorkspaceRevision(): Promise<number>;
  /**
   * SQLite `PRAGMA data_version` via the named repository boundary. Host/webview
   * code must not issue this pragma directly.
   */
  getStorageDataVersion(): Promise<number>;
  /**
   * Bounded change feed since a revision boundary. Cursor is a revision, never a
   * row offset. Returns explicit `gap` when the requested range is pruned.
   */
  getWorkspaceChangesSince(afterRevision: number, limit?: number): Promise<WorkspaceChangeFeedResult>;
  /**
   * M018 S07: bounded workflow status for a task bound to a workflow node.
   * Relational read of nodes → runs → gates/activations/rounds/continuations.
   * Returns undefined when the task is not bound to a workflow node.
   * Never includes topology, prompts, artifact bodies, secrets, or absolute paths.
   */
  getWorkflowStatusForTask(taskId: string): Promise<WorkflowTaskStatusProjection | undefined>;
  /** Load and revalidate one frozen workflow definition for host-policy checks. */
  getWorkflowDefinition(
    definitionId: string,
    version: number,
  ): Promise<WorkflowDefinitionV1 | undefined>;
  /** Frozen effective policy for an already-claimed scoped start replay. */
  getWorkflowStartPolicy(input: {
    ownerRootTaskId: string;
    callerTaskId: string;
    definitionId: string;
    version: number;
    startIdempotencyKey: string;
  }): Promise<WorkflowPolicyV1 | undefined>;
  /**
   * Optional local-host read barrier supplied by the projection wrapper. The
   * callback runs between complete execute→refresh→publish lifecycles, so a
   * multi-query bounded snapshot cannot interleave with this host's writes.
   * Raw repositories omit it; callers must still verify revision stability.
   */
  runConsistentRead?<T>(read: () => Promise<T>): Promise<T>;
  execute(command: RepositoryCommand): Promise<RepositoryCommandResult>;
}

/** Strict versioned send-outbox payload (P4-W11). Bound field sizes; no freeform blobs. */
export const SEND_OUTBOX_PAYLOAD_VERSION = 1;
export const SEND_OUTBOX_MAX_ENTRIES = 32;
export const SEND_OUTBOX_TEXT_MAX = 100_000;
export const SEND_OUTBOX_SKILLS_MAX = 8;
export const SEND_OUTBOX_MENTION_BINDINGS_MAX = 64;
export const SEND_OUTBOX_PATH_MAX = 4096;

export interface SendOutboxPayloadV1 {
  version: typeof SEND_OUTBOX_PAYLOAD_VERSION;
  text: string;
  llmText?: string;
  mentionBindings?: Array<[string, string]>;
  skills?: string[];
  backend?: string;
  model?: string;
  continuationOf?: string;
}

export interface SendOutboxEntry {
  clientRequestId: string;
  status: 'pending' | 'rejected';
  taskId?: string;
  payload: SendOutboxPayloadV1;
  createdAt: string;
  updatedAt: string;
}

export interface PresentationRecord {
  presentationId: string;
  ownerTaskId: string;
  rootId: string;
  revision: number;
  title: string;
  markdown: string;
  summary?: string;
  changeSummary?: string;
  kind?: string;
  sourcePath?: string;
  sourceFolderUri?: string;
  updatedAt: string;
}

/** Metadata-only change-feed entity kinds (no content/path/payload). */
export const WORKSPACE_CHANGE_ENTITY_KINDS = [
  'workspace',
  'workspace_location',
  'task',
  'turn',
  'message',
  'tool_call',
  'reasoning',
  'operation',
  'cancel_request',
  'send_receipt',
  'runtime_claim',
  'send_outbox',
  'presentation',
] as const;

export type WorkspaceChangeEntityKind = (typeof WORKSPACE_CHANGE_ENTITY_KINDS)[number];

export interface WorkspaceChangeMetadata {
  entityKind: WorkspaceChangeEntityKind;
  entityId: string;
  taskId?: string;
  changeKind: string;
}

export type WorkspaceChangeFeedResult =
  | {
      kind: 'changes';
      requestedAfterRevision: number;
      currentRevision: number;
      retainedFromRevision: number;
      revisions: Array<{
        revision: number;
        changes: WorkspaceChangeMetadata[];
      }>;
      hasMore: boolean;
    }
  | {
      kind: 'gap';
      requestedAfterRevision: number;
      currentRevision: number;
      retainedFromRevision: number;
    };

export class InvalidWorkspaceChangeFeedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkspaceChangeFeedRequestError';
  }
}

export class CorruptWorkspaceChangeFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptWorkspaceChangeFeedError';
  }
}

export class WorkspaceChangeFeedOverflowError extends Error {
  constructor() {
    super('workspace change feed revision exceeds the bounded metadata page');
    this.name = 'WorkspaceChangeFeedOverflowError';
  }
}

export interface SqliteTaskRepositoryOptions {
  /**
   * Production default is {@link CHANGE_FEED_RETAIN_REVISIONS}. Tests may inject a
   * smaller bound; this is constructor-local and never global mutable state.
   */
  changeFeedRetainRevisions?: number;
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
  if (command.dispositionClaim) {
    const turn = command.turns.find((candidate) => candidate.id === command.dispositionClaim?.turnId);
    if (!turn?.disposition || turn.taskId !== command.dispositionClaim.taskId) {
      return 'graph disposition claim does not match turn';
    }
    const expected = durableDispositionClaim({
      turnId: turn.id,
      taskId: turn.taskId,
      runtimeEpoch: turn.runtimeEpoch,
      opId: command.dispositionClaim.opId,
      disposition: turn.disposition,
    });
    if (
      expected.fingerprint !== command.dispositionClaim.fingerprint ||
      expected.family !== command.dispositionClaim.family ||
      expected.kind !== command.dispositionClaim.kind
    ) {
      return 'graph disposition claim fingerprint mismatch';
    }
  }
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
  private readonly changeFeedRetainRevisions: number;

  constructor(
    private readonly db: RepositoryDatabase,
    private readonly workspaceId: string,
    options: SqliteTaskRepositoryOptions = {},
  ) {
    const retain = options.changeFeedRetainRevisions ?? CHANGE_FEED_RETAIN_REVISIONS;
    if (!Number.isSafeInteger(retain) || retain < 1) {
      throw new Error('changeFeedRetainRevisions must be a positive safe integer');
    }
    this.changeFeedRetainRevisions = retain;
  }

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
    const bindings = await this.db.all<SessionBindingRow>(
      `SELECT task_id, runtime_epoch, backend, session_id
         FROM task_session_bindings
        WHERE workspace_id = ? AND active = 1
          AND task_id IN (${placeholders(ids.length)})`,
      [this.workspaceId, ...ids],
    );
    const bindingByTask = new Map(bindings.map((binding) => [binding.task_id, binding]));
    return rows.map((row) => {
      const task = decodeTask(row, byTask.get(row.id) ?? []);
      const binding = bindingByTask.get(row.id);
      if (!binding) {
        if (task.committedSessionId) throw new Error('task session binding missing');
        return task;
      }
      if (
        binding.backend !== task.backend ||
        binding.runtime_epoch !== (task.runtimeEpoch ?? 1) ||
        (task.committedSessionId !== undefined && task.committedSessionId !== binding.session_id)
      ) {
        throw new Error('task session binding mismatch');
      }
      return { ...task, committedSessionId: binding.session_id };
    });
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
    const activations = await this.db.all<{
      execution_turn_id: string;
      run_id: string;
      activation_id: string;
      node_id: string;
      activation_kind: NonNullable<TaskTurn['workflowActivation']>['kind'];
      activation_status: NonNullable<TaskTurn['workflowActivation']>['activationStatus'];
      run_status: NonNullable<TaskTurn['workflowActivation']>['runStatus'];
      is_terminal: number;
      has_direct_dependencies: number;
      has_open_feedback_round: number;
      has_pending_continuation: number;
      has_inherited_feedback_response: number;
    }>(
      `SELECT activation.execution_turn_id,
              activation.run_id,
              activation.activation_id,
              activation.node_id,
              activation.kind AS activation_kind,
              activation.status AS activation_status,
              run.status AS run_status,
              definition_node.is_terminal,
              EXISTS (
                SELECT 1
                  FROM workflow_dependency_gates gate_row
                  JOIN workflow_gate_bindings binding
                    ON binding.workspace_id = gate_row.workspace_id
                   AND binding.run_id = gate_row.run_id
                   AND binding.gate_id = gate_row.gate_id
                 WHERE gate_row.workspace_id = activation.workspace_id
                   AND gate_row.run_id = activation.run_id
                   AND gate_row.consumer_node_id = activation.node_id
                   AND binding.producer_node_id IS NOT NULL
              ) AS has_direct_dependencies,
              EXISTS (
                SELECT 1 FROM workflow_feedback_rounds round_row
                 WHERE round_row.workspace_id = activation.workspace_id
                   AND round_row.run_id = activation.run_id
                   AND round_row.status = 'open'
              ) AS has_open_feedback_round,
               EXISTS (
                 SELECT 1 FROM workflow_continuations continuation
                 WHERE continuation.workspace_id = activation.workspace_id
                   AND continuation.run_id = activation.run_id
                    AND continuation.status = 'pending'
               ) AS has_pending_continuation,
               CASE
                 WHEN activation.kind = 'feedback_request' THEN 1
                 WHEN activation.kind = 'feedback_resume'
                  AND activation.inherited_feedback_round_id IS NOT NULL
                  AND activation.inherited_feedback_target_node_id IS NOT NULL THEN 1
                 ELSE 0
               END AS has_inherited_feedback_response
         FROM workflow_activations activation
         JOIN workflow_runs run
           ON run.workspace_id = activation.workspace_id
          AND run.run_id = activation.run_id
         JOIN workflow_definition_nodes definition_node
           ON definition_node.workspace_id = run.workspace_id
          AND definition_node.definition_id = run.definition_id
          AND definition_node.definition_version = run.definition_version
          AND definition_node.node_id = activation.node_id
        WHERE activation.workspace_id = ?
          AND activation.execution_turn_id IN (${placeholders(ids.length)})`,
      [this.workspaceId, ...ids],
    );
    const activationByTurn = new Map(
      activations.map((activation) => [activation.execution_turn_id, activation]),
    );
    const authorityWaits = await this.db.all<{
      turn_id: string;
      has_open_feedback_round: number;
      has_pending_continuation: number;
    }>(
      `SELECT candidate.id AS turn_id,
              EXISTS (
                SELECT 1 FROM workflow_feedback_rounds round_row
                 WHERE round_row.workspace_id = candidate.workspace_id
                   AND round_row.requester_task_id = candidate.task_id
                   AND round_row.status IN ('open', 'satisfied')
              ) AS has_open_feedback_round,
              EXISTS (
                SELECT 1 FROM workflow_continuations continuation
                 WHERE continuation.workspace_id = candidate.workspace_id
                   AND continuation.caller_task_id = candidate.task_id
                   AND continuation.status IN ('pending', 'resolved')
              ) AS has_pending_continuation
         FROM turns candidate
        WHERE candidate.workspace_id = ?
          AND candidate.id IN (${placeholders(ids.length)})`,
      [this.workspaceId, ...ids],
    );
    const authorityWaitByTurn = new Map(
      authorityWaits.map((wait) => [wait.turn_id, wait]),
    );
    return rows.map((row) => {
      const turn = decodeTurn(row, byTurn.get(row.id) ?? []);
      const activation = activationByTurn.get(row.id);
      const wait = authorityWaitByTurn.get(row.id);
      return {
        ...turn,
        ...(activation
          ? {
              workflowActivation: {
                runId: activation.run_id,
                activationId: activation.activation_id,
                nodeId: activation.node_id,
              kind: activation.activation_kind,
              runStatus: activation.run_status,
              activationStatus: activation.activation_status,
              isTerminalNode: activation.is_terminal === 1,
              hasDirectDependencies: activation.has_direct_dependencies === 1,
              hasOpenFeedbackRound: activation.has_open_feedback_round === 1,
                hasPendingContinuation: activation.has_pending_continuation === 1,
                hasInheritedFeedbackResponse: activation.has_inherited_feedback_response === 1,
              },
            }
          : {}),
        ...(wait && (wait.has_open_feedback_round === 1 || wait.has_pending_continuation === 1)
          ? {
              workflowWait: {
                hasOpenFeedbackRound: wait.has_open_feedback_round === 1,
                hasPendingContinuation: wait.has_pending_continuation === 1,
              },
            }
          : {}),
      };
    });
  }

  async getTask(taskId: string): Promise<MusterTask | undefined> {
    const row = await this.db.get<TaskRow>(taskSelect('WHERE workspace_id = ? AND id = ?'), [this.workspaceId, taskId]);
    return row ? (await this.hydrateTasks([row]))[0] : undefined;
  }

  async listTasksByIds(taskIds: readonly string[]): Promise<readonly MusterTask[]> {
    if (taskIds.length === 0) return [];
    const uniqueIds = [...new Set(taskIds)];
    const rows = await this.db.all<TaskRow>(
      `${taskSelect(`WHERE workspace_id = ? AND id IN (${placeholders(uniqueIds.length)})`)}
       ORDER BY created_at, id`,
      [this.workspaceId, ...uniqueIds],
    );
    return this.hydrateTasks(rows);
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

  async listActiveTurnInputMessages(taskIds: readonly string[]): Promise<readonly TaskMessage[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.db.all<MessageRow>(
      activeTurnInputMessagesSql(taskIds.length),
      [this.workspaceId, ...taskIds, ...taskIds],
    );
    return rows.map(decodeMessage);
  }

  async countTurnsForTaskEpoch(
    taskId: string,
    executionEpoch: number,
    statuses?: readonly TaskTurn['status'][],
  ): Promise<number> {
    const statusFilter =
      statuses && statuses.length > 0
        ? ` AND status IN (${placeholders(statuses.length)})`
        : '';
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM turns
         WHERE workspace_id = ? AND task_id = ?
           AND COALESCE(json_extract(payload_json, '$.executionEpoch'), 1) = ?${statusFilter}`,
      [this.workspaceId, taskId, executionEpoch, ...(statuses ?? [])],
    );
    return row?.count ?? 0;
  }

  async getMaxTurnSequence(taskId: string): Promise<number> {
    const row = await this.db.get<{ max_seq: number | null }>(
      `SELECT MAX(sequence) AS max_seq FROM turns WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, taskId],
    );
    return row?.max_seq ?? 0;
  }

  async countRetryDepth(turnId: string): Promise<number> {
    // Walk retryOf predecessors via recursive CTE; depth is chain length, not
    // including the seed turn itself (parity with retryCountOf).
    const row = await this.db.get<{ depth: number }>(
      `WITH RECURSIVE chain(id, depth, retry_of) AS (
         SELECT id, 0, json_extract(payload_json, '$.retryOf')
           FROM turns WHERE workspace_id = ? AND id = ?
         UNION ALL
         SELECT t.id, chain.depth + 1, json_extract(t.payload_json, '$.retryOf')
           FROM chain
           JOIN turns t ON t.workspace_id = ? AND t.id = chain.retry_of
          WHERE chain.retry_of IS NOT NULL AND chain.depth < 64
       )
       SELECT COALESCE(MAX(depth), 0) AS depth FROM chain`,
      [this.workspaceId, turnId, this.workspaceId],
    );
    return row?.depth ?? 0;
  }

  async listEngineChildResultsAfter(
    taskId: string,
    afterSequence: number,
    limit = 32,
  ): Promise<readonly TaskTurn[]> {
    const bounded = Math.max(1, Math.min(limit, 64));
    const rows = await this.db.all<TurnRow>(
      `${turnSelect(`WHERE workspace_id = ? AND task_id = ?
          AND trigger = 'engine'
          AND sequence > ?
          AND id NOT GLOB '*-attention'
          AND EXISTS (
            SELECT 1 FROM turn_inputs ti
             WHERE ti.workspace_id = turns.workspace_id
               AND ti.turn_id = turns.id
               AND ti.kind = 'child_results'
          )`)}
       ORDER BY sequence, created_at, id
       LIMIT ?`,
      [this.workspaceId, taskId, afterSequence, bounded],
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

  async listMessagesByIds(ids: readonly string[]): Promise<readonly TaskMessage[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.all<MessageRow>(
      `${messageSelect(`WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})`)}
       ORDER BY created_at, id`,
      [this.workspaceId, ...ids],
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

  async listToolCallsByIds(ids: readonly string[]): Promise<readonly PersistedToolCall[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.all<ToolRow>(
      `SELECT id, task_id, turn_id, tool_call_id, ordering, status, name, payload_json, created_at, updated_at
         FROM tool_calls
        WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})
        ORDER BY turn_id, ordering, id`,
      [this.workspaceId, ...ids],
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

  async listReasoningByIds(ids: readonly string[]): Promise<readonly PersistedReasoning[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.all<ReasoningRow>(
      `SELECT id, task_id, turn_id, content, created_at, updated_at
         FROM reasoning_segments
        WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})
        ORDER BY created_at, id`,
      [this.workspaceId, ...ids],
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

  async listCancelRequestsForTurns(
    turnIds: readonly string[],
  ): Promise<readonly RepositoryCancelEntry[]> {
    if (turnIds.length === 0) return [];
    const rows = await this.db.all<CancelRow>(
      `SELECT turn_id, kind, op_id, requested_by, requested_at, payload_json
         FROM turn_cancel_requests
        WHERE workspace_id = ? AND turn_id IN (${placeholders(turnIds.length)})
        ORDER BY turn_id`,
      [this.workspaceId, ...turnIds],
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

  async listRuntimeClaimsForTurns(turnIds: readonly string[]): Promise<readonly RuntimeClaim[]> {
    if (turnIds.length === 0) return [];
    const rows = await this.db.all<RuntimeClaimRow>(
      `SELECT turn_id, owner_id, claimed_at, heartbeat_at, expires_at
         FROM runtime_claims
        WHERE workspace_id = ? AND turn_id IN (${placeholders(turnIds.length)})
        ORDER BY turn_id`,
      [this.workspaceId, ...turnIds],
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

  async listSendOutbox(limit = SEND_OUTBOX_MAX_ENTRIES): Promise<readonly SendOutboxEntry[]> {
    const capped = Math.min(
      SEND_OUTBOX_MAX_ENTRIES,
      Number.isSafeInteger(limit) && limit > 0 ? limit : SEND_OUTBOX_MAX_ENTRIES,
    );
    const rows = await this.db.all<SendOutboxRow>(
      `SELECT client_request_id, status, task_id, payload_json, created_at, updated_at
         FROM send_outbox
        WHERE workspace_id = ?
        ORDER BY created_at ASC, client_request_id ASC
        LIMIT ?`,
      [this.workspaceId, capped],
    );
    return rows.map(decodeSendOutboxRow);
  }

  async getSendOutbox(clientRequestId: string): Promise<SendOutboxEntry | undefined> {
    const row = await this.db.get<SendOutboxRow>(
      `SELECT client_request_id, status, task_id, payload_json, created_at, updated_at
         FROM send_outbox
        WHERE workspace_id = ? AND client_request_id = ?`,
      [this.workspaceId, clientRequestId],
    );
    return row ? decodeSendOutboxRow(row) : undefined;
  }

  async getPresentation(rootId: string, presentationId: string): Promise<PresentationRecord | undefined> {
    const row = await this.db.get<PresentationRow>(
      `SELECT presentation_id, owner_task_id, root_id, revision, title, markdown, payload_json, updated_at
         FROM presentations
        WHERE workspace_id = ? AND root_id = ? AND presentation_id = ?`,
      [this.workspaceId, rootId, presentationId],
    );
    return row ? decodePresentationRow(row) : undefined;
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

  async getStorageDataVersion(): Promise<number> {
    return this.db.pragma('data_version');
  }

  async getWorkspaceChangesSince(
    afterRevision: number,
    limit?: number,
  ): Promise<WorkspaceChangeFeedResult> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new InvalidWorkspaceChangeFeedRequestError(
        'afterRevision must be a non-negative safe integer',
      );
    }
    const pageLimit = limit === undefined ? DEFAULT_CHANGE_FEED_PAGE_LIMIT : limit;
    if (
      !Number.isSafeInteger(pageLimit) ||
      pageLimit < 1 ||
      pageLimit > MAX_CHANGE_FEED_PAGE_REVISIONS
    ) {
      throw new InvalidWorkspaceChangeFeedRequestError(
        `limit must be a safe integer between 1 and ${MAX_CHANGE_FEED_PAGE_REVISIONS}`,
      );
    }

    /*
     * One statement is essential here. Reading revision, watermark, revision ids,
     * and metadata through separate RPCs lets another WAL writer prune/append
     * between reads, manufacturing a false gap or corruption result. The CTEs all
     * share one SQLite read snapshot. Host materialization is bounded both by
     * revision count and by metadata rows; an oversized single revision fails into
     * bounded snapshot recovery instead of allocating an unbounded JS array.
     */
    const rows = await this.db.all<ChangeFeedQueryRow>(
      `WITH state AS MATERIALIZED (
         SELECT COALESCE((SELECT revision
                            FROM workspace_revisions
                           WHERE workspace_id = ?), 0) AS current_revision,
                COALESCE((SELECT retained_from_revision
                            FROM change_feed_watermarks
                           WHERE workspace_id = ?), 1) AS retained_from_revision
       ),
       candidate_revisions AS MATERIALIZED (
         SELECT DISTINCT cl.revision
           FROM change_log cl
           CROSS JOIN state s
          WHERE cl.workspace_id = ?
            AND cl.revision > ?
            AND cl.revision <= s.current_revision
            AND ? + 1 >= s.retained_from_revision
          ORDER BY cl.revision ASC
          LIMIT ?
       ),
       page_revisions AS MATERIALIZED (
         SELECT revision
           FROM candidate_revisions
          ORDER BY revision ASC
          LIMIT ?
       ),
       page_rows AS MATERIALIZED (
         SELECT cl.revision, cl.entity_kind, cl.entity_id, cl.task_id, cl.change_kind
           FROM change_log cl
           CROSS JOIN page_revisions pr
          WHERE cl.workspace_id = ?
            AND cl.revision = pr.revision
          ORDER BY cl.revision ASC, cl.entity_kind ASC, cl.entity_id ASC
          LIMIT ?
       )
       SELECT s.current_revision,
              s.retained_from_revision,
              (SELECT COUNT(*) FROM candidate_revisions) AS candidate_revision_count,
              pr.revision AS page_revision,
              p.revision,
              p.entity_kind,
              p.entity_id,
              p.task_id,
              p.change_kind
         FROM state s
         LEFT JOIN page_revisions pr ON 1 = 1
         LEFT JOIN page_rows p ON p.revision = pr.revision
        ORDER BY pr.revision ASC, p.entity_kind ASC, p.entity_id ASC`,
      [
        this.workspaceId,
        this.workspaceId,
        this.workspaceId,
        afterRevision,
        afterRevision,
        pageLimit + 1,
        pageLimit,
        this.workspaceId,
        MAX_CHANGE_FEED_METADATA_ROWS + 1,
      ],
    );
    const state = rows[0];
    if (
      !state ||
      !Number.isSafeInteger(state.current_revision) ||
      state.current_revision < 0 ||
      !Number.isSafeInteger(state.retained_from_revision) ||
      state.retained_from_revision < 1
    ) {
      throw new CorruptWorkspaceChangeFeedError('change feed state is invalid');
    }
    const currentRevision = state.current_revision;
    const retainedFromRevision = state.retained_from_revision;
    if (afterRevision > currentRevision) {
      throw new InvalidWorkspaceChangeFeedRequestError(
        `afterRevision ${afterRevision} is ahead of currentRevision ${currentRevision}`,
      );
    }
    if (afterRevision + 1 < retainedFromRevision) {
      return {
        kind: 'gap',
        requestedAfterRevision: afterRevision,
        currentRevision,
        retainedFromRevision,
      };
    }

    if (afterRevision === currentRevision) {
      return {
        kind: 'changes',
        requestedAfterRevision: afterRevision,
        currentRevision,
        retainedFromRevision,
        revisions: [],
        hasMore: false,
      };
    }

    const candidateRevisionCount = state.candidate_revision_count;
    if (
      !Number.isSafeInteger(candidateRevisionCount) ||
      candidateRevisionCount < 0 ||
      candidateRevisionCount > pageLimit + 1
    ) {
      throw new CorruptWorkspaceChangeFeedError('change feed revision count is invalid');
    }
    const hasMore = candidateRevisionCount > pageLimit;
    const pageRevisions = [...new Set(
      rows
        .map((row) => row.page_revision)
        .filter((revision): revision is number => revision !== null),
    )];
    if (pageRevisions.length === 0) {
      // Contiguous durable revisions always write at least one metadata row.
      // Empty mid-range means the feed is corrupt or pruned without watermark.
      throw new CorruptWorkspaceChangeFeedError(
        `change feed missing revisions after ${afterRevision} up to ${currentRevision}`,
      );
    }

    const feedRows: ChangeLogRow[] = rows
      .filter((row): row is ChangeFeedQueryRow & {
        revision: number;
        entity_kind: string;
        entity_id: string;
        change_kind: string;
      } => row.revision !== null)
      .map((row) => ({
        revision: row.revision,
        entity_kind: row.entity_kind,
        entity_id: row.entity_id,
        task_id: row.task_id,
        change_kind: row.change_kind,
      }));
    if (feedRows.length > MAX_CHANGE_FEED_METADATA_ROWS) {
      throw new WorkspaceChangeFeedOverflowError();
    }
    // A page revision with no joined row can only mean page_rows hit its cap or
    // the feed is corrupt. Both require bounded recovery; never return partial.
    if (rows.some((row) => row.page_revision !== null && row.revision === null)) {
      throw new WorkspaceChangeFeedOverflowError();
    }

    const byRevision = new Map<number, WorkspaceChangeMetadata[]>();
    for (const revision of pageRevisions) byRevision.set(revision, []);
    for (const row of feedRows) {
      const entityKind = parseWorkspaceChangeEntityKind(row.entity_kind);
      if (!entityKind) {
        throw new CorruptWorkspaceChangeFeedError(
          `unknown change_log entity_kind ${JSON.stringify(row.entity_kind)}`,
        );
      }
      if (typeof row.entity_id !== 'string' || row.entity_id.length === 0) {
        throw new CorruptWorkspaceChangeFeedError('change_log entity_id missing');
      }
      if (typeof row.change_kind !== 'string' || row.change_kind.length === 0) {
        throw new CorruptWorkspaceChangeFeedError('change_log change_kind missing');
      }
      const bucket = byRevision.get(row.revision);
      if (!bucket) continue;
      bucket.push({
        entityKind,
        entityId: row.entity_id,
        ...(row.task_id ? { taskId: row.task_id } : {}),
        changeKind: row.change_kind,
      });
    }

    const revisions: Array<{ revision: number; changes: WorkspaceChangeMetadata[] }> = [];
    let expected = afterRevision + 1;
    for (const revision of pageRevisions) {
      if (revision !== expected) {
        throw new CorruptWorkspaceChangeFeedError(
          `change feed non-contiguous: expected revision ${expected}, got ${revision}`,
        );
      }
      const changes = byRevision.get(revision) ?? [];
      if (changes.length === 0) {
        throw new CorruptWorkspaceChangeFeedError(
          `change feed revision ${revision} has no metadata rows`,
        );
      }
      revisions.push({ revision, changes });
      expected += 1;
    }

    return {
      kind: 'changes',
      requestedAfterRevision: afterRevision,
      currentRevision,
      retainedFromRevision,
      revisions,
      hasMore,
    };
  }

  async getWorkflowDefinition(
    definitionId: string,
    version: number,
  ): Promise<WorkflowDefinitionV1 | undefined> {
    if (!definitionId || !Number.isInteger(version) || version < 1) return undefined;
    const row = await this.db.get<{
      name: string;
      topology_json: string;
      scope_kind: string;
      owner_root_task_id: string | null;
      fingerprint: string;
      policy_json: string;
      created_at: string;
    }>(
      `SELECT name, topology_json, scope_kind, owner_root_task_id,
              fingerprint, policy_json, created_at
         FROM workflow_definitions
        WHERE workspace_id = ? AND definition_id = ? AND version = ?`,
      [this.workspaceId, definitionId, version],
    );
    if (!row || (row.scope_kind !== 'workspace' && row.scope_kind !== 'root')) {
      return undefined;
    }
    const topology = decodeStoredTopologyJson(row.topology_json);
    if (!topology.ok) return undefined;
    const contracts = await this.db.all<{
      entry_node_id: string;
      input_ref: string;
      expected_artifact_kind: string;
    }>(
      `SELECT entry_node_id, input_ref, expected_artifact_kind
         FROM workflow_entry_contracts
        WHERE workspace_id = ? AND definition_id = ? AND definition_version = ?
        ORDER BY ordinal`,
      [this.workspaceId, definitionId, version],
    );
    let policy: unknown;
    try {
      policy = JSON.parse(row.policy_json);
    } catch {
      return undefined;
    }
    const validated = validateDefineWorkflow({
      definitionId,
      version,
      name: row.name,
      topology: topology.topology,
      entryContracts: contracts.map((contract) => ({
        entryNodeId: contract.entry_node_id,
        inputRef: contract.input_ref,
        expectedArtifactKind: contract.expected_artifact_kind,
      })),
      policy,
      scope: row.scope_kind === 'root'
        ? { kind: 'root', ownerRootTaskId: row.owner_root_task_id ?? '' }
        : { kind: 'workspace' },
      createdAt: row.created_at,
    });
    if (!validated.ok || validated.fingerprint !== row.fingerprint) return undefined;
    return validated.definition;
  }

  async getWorkflowStartPolicy(input: {
    ownerRootTaskId: string;
    callerTaskId: string;
    definitionId: string;
    version: number;
    startIdempotencyKey: string;
  }): Promise<WorkflowPolicyV1 | undefined> {
    const row = await this.db.get<{ policy_json: string }>(
      `SELECT run.policy_json
         FROM workflow_start_claims claim
         JOIN workflow_runs run
           ON run.workspace_id = claim.workspace_id
          AND run.run_id = claim.run_id
        WHERE claim.workspace_id = ?
          AND claim.owner_task_id = ?
          AND claim.caller_task_id = ?
          AND claim.definition_id = ?
          AND claim.definition_version = ?
          AND claim.idempotency_key = ?`,
      [
        this.workspaceId,
        input.ownerRootTaskId,
        input.callerTaskId,
        input.definitionId,
        input.version,
        input.startIdempotencyKey,
      ],
    );
    if (!row) return undefined;
    const definition = await this.getWorkflowDefinition(input.definitionId, input.version);
    if (!definition) return undefined;
    let policy: unknown;
    try {
      policy = JSON.parse(row.policy_json);
    } catch {
      return undefined;
    }
    const validated = validateDefineWorkflow({ ...definition, policy });
    return validated.ok ? validated.definition.policy : undefined;
  }

  /**
   * M018 S07: bounded workflow read projection for get_task_status.
   * Reads relational run, gate, activation, round, continuation, and integrity
   * state without topology, prompts, artifact bodies, or paths.
   */
  async getWorkflowStatusForTask(
    taskId: string,
  ): Promise<WorkflowTaskStatusProjection | undefined> {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return undefined;
    }
    const node = await this.db.get<{
      run_id: string;
      node_id: string;
    }>(
      `SELECT run_id, node_id FROM workflow_nodes
        WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, taskId],
    );
    if (!node || typeof node.run_id !== 'string' || typeof node.node_id !== 'string') {
      return undefined;
    }
    const run = await this.db.get<{
      run_id: string;
      definition_id: string;
      definition_version: number;
      status: string;
      origin: string;
      parent_run_id: string | null;
      max_feedback_rounds: number;
      max_turns_per_task: number;
      max_workflow_turns: number;
      max_children: number;
      max_depth: number;
      max_concurrency: number;
      max_aggregate_bytes: number;
      started_at: string | null;
      deadline_at: string | null;
      terminal_reason_code: string | null;
    }>(
      `SELECT run_id, definition_id, definition_version, status, origin, parent_run_id,
              max_feedback_rounds, max_turns_per_task, max_workflow_turns,
              max_children, max_depth, max_concurrency, max_aggregate_bytes,
              started_at, deadline_at, terminal_reason_code
         FROM workflow_runs
        WHERE workspace_id = ? AND run_id = ?`,
      [this.workspaceId, node.run_id],
    );
    if (!run) {
      return undefined;
    }

    const gateRows = await this.db.all<{
      gate_id: string;
      consumer_node_id: string;
      status: string;
      required: number;
      satisfied: number;
    }>(
      `SELECT g.gate_id AS gate_id,
              g.consumer_node_id AS consumer_node_id,
              g.status AS status,
              (SELECT COUNT(*) FROM workflow_gate_bindings b
                WHERE b.workspace_id = g.workspace_id
                  AND b.run_id = g.run_id
                  AND b.gate_id = g.gate_id) AS required,
              (SELECT COUNT(DISTINCT f.input_ref) FROM workflow_gate_fills f
                WHERE f.workspace_id = g.workspace_id
                  AND f.run_id = g.run_id
                  AND f.gate_id = g.gate_id) AS satisfied
         FROM workflow_dependency_gates g
        WHERE g.workspace_id = ? AND g.run_id = ?
        ORDER BY g.gate_id
        LIMIT 65`,
      [this.workspaceId, node.run_id],
    );

    const activationRows = await this.db.all<{
      activation_id: string;
      kind: string;
      status: string;
      primary_turn_id: string;
      execution_turn_id: string;
      source_gate_id: string | null;
      feedback_round_id: string | null;
      feedback_target_node_id: string | null;
      continuation_id: string | null;
      return_gate_id: string | null;
    }>(
      `SELECT activation_id, kind, status, primary_turn_id, execution_turn_id,
              source_gate_id, feedback_round_id, feedback_target_node_id,
              continuation_id, return_gate_id
         FROM workflow_activations
        WHERE workspace_id = ? AND run_id = ? AND node_id = ?
          AND status IN ('queued', 'running', 'failed', 'interrupted')
        ORDER BY CASE status
                   WHEN 'running' THEN 0
                   WHEN 'queued' THEN 1
                   WHEN 'interrupted' THEN 2
                   ELSE 3
                 END,
                 updated_at DESC, activation_id
        LIMIT 2`,
      [this.workspaceId, node.run_id, node.node_id],
    );

    const roundRows = await this.db.all<{
      round_id: string;
      status: string;
      join_mode: string;
      role: 'requester' | 'target';
      required: number;
      responded: number;
    }>(
      `SELECT round_row.round_id,
              round_row.status,
              round_row.join_mode,
              CASE WHEN round_row.requester_task_id = ? THEN 'requester' ELSE 'target' END AS role,
              (SELECT COUNT(*) FROM workflow_feedback_targets target
                WHERE target.workspace_id = round_row.workspace_id
                  AND target.run_id = round_row.run_id
                  AND target.round_id = round_row.round_id) AS required,
              (SELECT COUNT(*) FROM workflow_feedback_targets target
                WHERE target.workspace_id = round_row.workspace_id
                  AND target.run_id = round_row.run_id
                  AND target.round_id = round_row.round_id
                  AND target.status = 'responded') AS responded
         FROM workflow_feedback_rounds round_row
        WHERE round_row.workspace_id = ? AND round_row.run_id = ?
          AND round_row.status IN ('open', 'satisfied')
          AND (
            round_row.requester_task_id = ?
            OR EXISTS (
              SELECT 1 FROM workflow_activations activation
               WHERE activation.workspace_id = round_row.workspace_id
                 AND activation.run_id = round_row.run_id
                 AND activation.node_id = ?
                 AND activation.feedback_round_id = round_row.round_id
                 AND activation.status IN ('queued', 'running', 'failed', 'interrupted')
            )
          )
        ORDER BY round_row.created_at, round_row.round_id
        LIMIT 33`,
      [taskId, this.workspaceId, node.run_id, taskId, node.node_id],
    );

    const continuationRows = await this.db.all<{
      continuation_id: string;
      status: string;
      kind: string;
      child_run_id: string | null;
      outcome: string | null;
      reason_code: string | null;
    }>(
      `SELECT continuation_id, status, kind, child_run_id, outcome, reason_code
         FROM workflow_continuations
        WHERE workspace_id = ?
          AND (run_id = ? OR child_run_id = ?
            OR (caller_run_id = ? AND caller_task_id = ?))
        ORDER BY created_at, continuation_id
        LIMIT 65`,
      [this.workspaceId, node.run_id, node.run_id, node.run_id, taskId],
    );

    const liveState = await this.db.get<{
      live_gate: number;
      live_round: number;
      live_activation: number;
      live_continuation: number;
      live_return_gate: number;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM workflow_dependency_gates
                  WHERE workspace_id = ? AND run_id = ? AND status IN ('open', 'satisfied')) AS live_gate,
         EXISTS (SELECT 1 FROM workflow_feedback_rounds
                  WHERE workspace_id = ? AND run_id = ? AND status IN ('open', 'satisfied')) AS live_round,
         EXISTS (SELECT 1 FROM workflow_activations
                  WHERE workspace_id = ? AND run_id = ? AND status IN ('queued', 'running')) AS live_activation,
         EXISTS (SELECT 1 FROM workflow_continuations
                  WHERE workspace_id = ? AND (run_id = ? OR child_run_id = ?)
                    AND status IN ('pending', 'resolved')) AS live_continuation,
         EXISTS (SELECT 1 FROM workflow_return_gates
                  WHERE workspace_id = ?
                    AND (continuation_run_id = ? OR child_run_id = ?)
                    AND status IN ('open', 'satisfied')) AS live_return_gate`,
      [
        this.workspaceId, node.run_id,
        this.workspaceId, node.run_id,
        this.workspaceId, node.run_id,
        this.workspaceId, node.run_id, node.run_id,
        this.workspaceId, node.run_id, node.run_id,
      ],
    );

    const diagnostics: Array<{ code: string }> = [];
    const gatesTruncated = gateRows.length > 64;
    const roundsTruncated = roundRows.length > 32;
    const continuationsTruncated = continuationRows.length > 64;
    if (gatesTruncated) diagnostics.push({ code: 'workflow_gates_truncated' });
    if (roundsTruncated) diagnostics.push({ code: 'workflow_feedback_rounds_truncated' });
    if (continuationsTruncated) diagnostics.push({ code: 'workflow_continuations_truncated' });
    if (activationRows.length > 1) diagnostics.push({ code: 'multiple_recoverable_activations' });
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
    if (terminal && liveState?.live_gate === 1) diagnostics.push({ code: 'terminal_run_has_live_gate' });
    if (terminal && liveState?.live_round === 1) diagnostics.push({ code: 'terminal_run_has_live_round' });
    if (terminal && liveState?.live_activation === 1) diagnostics.push({ code: 'terminal_run_has_live_activation' });
    if (terminal && liveState?.live_continuation === 1) diagnostics.push({ code: 'terminal_run_has_live_continuation' });
    if (terminal && liveState?.live_return_gate === 1) diagnostics.push({ code: 'terminal_run_has_live_return_gate' });
    const terminalReason = run.terminal_reason_code;
    if (terminalReason !== null && !/^[a-z0-9_]{1,64}$/.test(terminalReason)) {
      diagnostics.push({ code: 'invalid_terminal_reason' });
    }

    const gates = gateRows.slice(0, 64).map((g) => ({
      gateId: g.gate_id,
      status: g.status,
      required: Number(g.required) || 0,
      satisfied: Number(g.satisfied) || 0,
    }));
    const activationRow = activationRows.length === 1 ? activationRows[0] : undefined;
    const activeGateRow = activationRow?.source_gate_id
      ? gateRows.find((gate) => gate.gate_id === activationRow.source_gate_id)
      : gateRows.find((gate) =>
          gate.consumer_node_id === node.node_id && (gate.status === 'open' || gate.status === 'satisfied'));

    const projection: WorkflowTaskStatusProjection = {
      runId: run.run_id,
      definitionId: run.definition_id,
      definitionVersion: Number(run.definition_version),
      runStatus: run.status,
      policy: {
        maxFeedbackRounds: Number(run.max_feedback_rounds) || 0,
        maxTurnsPerTask: Number(run.max_turns_per_task) || 0,
        maxWorkflowTurns: Number(run.max_workflow_turns) || 0,
        maxChildren: Number(run.max_children) || 0,
        maxDepth: Number(run.max_depth) || 0,
        maxConcurrency: Number(run.max_concurrency) || 0,
        maxAggregateBytes: Number(run.max_aggregate_bytes) || 0,
      },
      origin: run.origin,
      nodeId: node.node_id,
      gates,
      feedbackRounds: roundRows.slice(0, 32).map((round) => ({
        roundId: round.round_id,
        status: round.status,
        joinMode: round.join_mode,
        role: round.role,
        required: Number(round.required) || 0,
        responded: Number(round.responded) || 0,
      })),
      continuations: continuationRows.slice(0, 64).map((continuation) => ({
        continuationId: continuation.continuation_id,
        status: continuation.status,
        kind: continuation.kind,
        ...(continuation.child_run_id ? { childRunId: continuation.child_run_id } : {}),
        ...(continuation.outcome ? { outcome: continuation.outcome } : {}),
        ...(continuation.reason_code ? { reasonCode: continuation.reason_code } : {}),
      })),
      diagnostics: diagnostics.slice(0, 8),
    };
    if (run.started_at) projection.startedAt = run.started_at;
    if (run.deadline_at) projection.deadlineAt = run.deadline_at;
    if (terminalReason && /^[a-z0-9_]{1,64}$/.test(terminalReason)) {
      projection.terminalReason = terminalReason;
    }
    if (typeof run.parent_run_id === 'string' && run.parent_run_id.length > 0) {
      projection.parentRunId = run.parent_run_id;
    }
    if (activeGateRow) {
      projection.activeGate = {
        gateId: activeGateRow.gate_id,
        status: activeGateRow.status,
        required: Number(activeGateRow.required) || 0,
        satisfied: Number(activeGateRow.satisfied) || 0,
      };
    }
    if (activationRow) {
      projection.activation = {
        activationId: activationRow.activation_id,
        kind: activationRow.kind,
        status: activationRow.status,
        primaryTurnId: activationRow.primary_turn_id,
        executionTurnId: activationRow.execution_turn_id,
        ...(activationRow.source_gate_id ? { sourceGateId: activationRow.source_gate_id } : {}),
        ...(activationRow.feedback_round_id ? { feedbackRoundId: activationRow.feedback_round_id } : {}),
        ...(activationRow.feedback_target_node_id
          ? { feedbackTargetNodeId: activationRow.feedback_target_node_id }
          : {}),
        ...(activationRow.continuation_id ? { continuationId: activationRow.continuation_id } : {}),
        ...(activationRow.return_gate_id ? { returnGateId: activationRow.return_gate_id } : {}),
      };
    }
    return projection;
  }

  private async write(
    statements: readonly SqlStatement[],
    changed: readonly ChangeRecord[],
    at: string,
  ): Promise<readonly import('./sqlite/rpc').RunResult[]> {
    return this.db.transaction([
      ...statements,
      ...revisionStatements(this.workspaceId, changed, at, this.changeFeedRetainRevisions),
    ]);
  }

  private async commitPresentationOperation(
    command: Extract<RepositoryCommand, { kind: 'commitPresentationOperation' }>,
  ): Promise<RepositoryCommandResult> {
    validatePresentationRecord(command.document);
    if (!/^[a-f0-9]{64}$/.test(command.operationKey) || !/^[a-f0-9]{64}$/.test(command.fingerprint)) {
      throw new Error('presentation operation fingerprint invalid');
    }
    const document = command.document;
    const results = await this.db.transaction(
      [
        {
          sql: `INSERT INTO presentation_operations
                  (workspace_id, operation_key, root_id, presentation_id, fingerprint, created_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(workspace_id, operation_key) DO NOTHING`,
          params: [
            this.workspaceId,
            command.operationKey,
            document.rootId,
            document.presentationId,
            command.fingerprint,
            document.updatedAt,
          ],
        },
        presentationStatement(this.workspaceId, document, true),
        ...revisionStatements(
          this.workspaceId,
          [{
            kind: 'presentation',
            id: presentationFeedId(document.rootId, document.presentationId),
            taskId: document.ownerTaskId,
            change: 'upsert',
          }],
          document.updatedAt,
          this.changeFeedRetainRevisions,
        ),
      ],
      { abortIfFirstUnchanged: true, abortIfUnchangedAt: [1] },
    );

    if ((results[0]?.changes ?? 0) === 0) {
      const prior = await this.db.get<{
        root_id: string;
        presentation_id: string;
        fingerprint: string;
      }>(
        `SELECT root_id, presentation_id, fingerprint
           FROM presentation_operations
          WHERE workspace_id = ? AND operation_key = ?`,
        [this.workspaceId, command.operationKey],
      );
      if (!prior) throw new Error('presentation operation disappeared after claim');
      const idempotent =
        prior.root_id === document.rootId &&
        prior.presentation_id === document.presentationId &&
        prior.fingerprint === command.fingerprint;
      return {
        ok: true,
        changed: false,
        presentationStatus: idempotent ? 'idempotent' : 'op_conflict',
        ...(!idempotent ? { reason: 'presentation operation fingerprint conflict' } : {}),
      };
    }

    if ((results[1]?.changes ?? 0) === 0) {
      const existing = await this.getPresentation(document.rootId, document.presentationId);
      if (!existing) throw new Error('presentation commit guard rejected without existing row');
      const ownerMismatch = existing.ownerTaskId !== document.ownerTaskId;
      return {
        ok: true,
        changed: false,
        presentationStatus: ownerMismatch ? 'owner_mismatch' : 'stale_revision',
        reason: ownerMismatch ? 'presentation owner mismatch' : 'presentation revision is stale',
      };
    }

    return { ok: true, changed: true, presentationStatus: 'committed' };
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

    if (command.dispositionClaim) {
      const existing = await this.getDispositionClaim(command.dispositionClaim.turnId);
      if (existing) {
        if (existing.fingerprint !== command.dispositionClaim.fingerprint) {
          return {
            ok: true,
            changed: false,
            reason: 'turn already has a different disposition',
            conflict: true,
          };
        }
        if (command.operation) {
          const claimed = await this.claimOperation({
            kind: 'claimOperation',
            workspaceId: this.workspaceId,
            ledgerKey: command.operation.ledgerKey,
            entry: command.operation.entry,
            createdAt: command.operation.createdAt,
          });
          if (claimed.conflict) return claimed;
        }
        return {
          ok: true,
          changed: false,
          ...(command.operation ? { operation: command.operation.entry } : {}),
        };
      }
    }

    if (command.operation) {
      statements.push(graphOperationClaimStatement(this.workspaceId, command.operation));
      abortIfUnchangedAt.push(0);
    }
    if (command.dispositionClaim) {
      statements.push(
        dispositionClaimInsertStatement(
          this.workspaceId,
          command.dispositionClaim,
          command.operation?.createdAt,
        ),
      );
    }
    // revision/feed statements are appended after mutation assembly below.
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
    const cancellationAt = command.operation?.createdAt ?? command.tasks[0]?.updatedAt ?? new Date().toISOString();
    const cancelledWorkflowTasks = command.tasks
      .filter((task) => task.lifecycle === 'cancelled')
      .map((task) => task.id);
    const unavailableWorkflowTasks = command.tasks
      .filter((task) => task.lifecycle === 'failed' || task.lifecycle === 'skipped' || task.lifecycle === 'succeeded')
      .map((task) => task.id);
    if (cancelledWorkflowTasks.length > 0) {
      const closure = await this.planWorkflowClosureFromTasks({
        taskIds: cancelledWorkflowTasks,
        reasonCode: 'required_target_cancelled',
        at: cancellationAt,
      });
      statements.push(...closure.statements);
      changes.push(...closure.changes);
    }
    if (unavailableWorkflowTasks.length > 0) {
      const closure = await this.planWorkflowClosureFromTasks({
        taskIds: unavailableWorkflowTasks,
        reasonCode: 'required_target_unavailable',
        at: cancellationAt,
      });
      statements.push(...closure.statements);
      changes.push(...closure.changes);
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
      statements.push(...revisionStatements(
        this.workspaceId,
        uniqueChanges,
        at,
        this.changeFeedRetainRevisions,
      ));
    }

    let results: readonly import('./sqlite/rpc').RunResult[];
    try {
      results = await this.db.transaction(statements, {
        abortIfUnchangedAt: abortIfUnchangedAt.length > 0 ? abortIfUnchangedAt : undefined,
      });
    } catch (error) {
      // Do not leak SQL/row payloads through the repository boundary. The
      // caller can retry a stale graph or surface a stable validation reason.
      const detail = (error as { detail?: { code?: string; kind?: string }; code?: string })?.detail;
      const code = detail?.code ?? (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (
        code === 'constraint' ||
        code === 'capacity' ||
        message === 'constraint rejected' ||
        /constraint|unique|foreign key/i.test(message)
      ) {
        if (command.dispositionClaim) {
          const existing = await this.getDispositionClaim(command.dispositionClaim.turnId);
          if (existing?.fingerprint === command.dispositionClaim.fingerprint) {
            if (command.operation) {
              const claimed = await this.claimOperation({
                kind: 'claimOperation',
                workspaceId: this.workspaceId,
                ledgerKey: command.operation.ledgerKey,
                entry: command.operation.entry,
                createdAt: command.operation.createdAt,
              });
              if (claimed.conflict) return claimed;
            }
            return {
              ok: true,
              changed: false,
              ...(command.operation ? { operation: command.operation.entry } : {}),
            };
          }
          if (existing) {
            return {
              ok: true,
              changed: false,
              reason: 'turn already has a different disposition',
              conflict: true,
            };
          }
        }
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
    const guardIndex = (command.operation ? 1 : 0) + (command.dispositionClaim ? 1 : 0);
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
      ...conditionalRevisionStatements(
        this.workspaceId,
        change,
        at,
        this.changeFeedRetainRevisions,
      ),
      ...rest,
    ], { abortIfFirstUnchanged: true });
  }

  async execute(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (command.workspaceId !== this.workspaceId) throw new Error('repository workspace mismatch');
    if (this.db.executeWorkflowMutation && isWorkflowTransactionalCommand(command)) {
      return this.db.executeWorkflowMutation(command, this.changeFeedRetainRevisions);
    }
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
      case 'workflowNextGraphTask':
      case 'workflowPrevGraphTask':
      case 'workflowFailGraphTask':
      case 'invokeChildGraphTask':
      case 'askParent':
      case 'answerChildQuestion':
      case 'consumeCancelRequest':
        return this.applyGraphCommand(command);
      case 'upsertWorkspace': {
        await this.write([workspaceStatement(command)], [{ kind: 'workspace', id: command.workspaceId, change: 'upsert' }], command.lastOpenedAt);
        return { ok: true, changed: true };
      }
      case 'recordWorkspaceLocation': {
        // The feed is metadata-only. A canonical URI is user data/path, never an
        // entity id exposed to feed consumers; the workspace id is the opaque
        // invalidation key because locations are reconciled as one workspace set.
        await this.write(
          [workspaceLocationStatement(command)],
          [{ kind: 'workspace_location', id: command.workspaceId, change: 'upsert' }],
          command.lastSeenAt,
        );
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
        const taskId = await this.lookupTurnTaskId(command.turnId);
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM turns WHERE workspace_id = ? AND id = ?', params: [this.workspaceId, command.turnId] }, [],
          {
            kind: 'turn',
            id: command.turnId,
            ...(taskId ? { taskId } : {}),
            // FK cascades may remove transcript rows without individual feed
            // metadata, so peers must choose bounded recovery for this command.
            change: 'delete_cascade',
          },
          new Date().toISOString(),
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
        // Capture task_id before delete so feed metadata stays scoped for peers.
        const existing = await this.db.get<{ task_id: string }>(
          'SELECT task_id FROM messages WHERE workspace_id = ? AND id = ?',
          [this.workspaceId, command.messageId],
        );
        const results = await this.writeIfFirstChanged(
          { sql: 'DELETE FROM messages WHERE workspace_id = ? AND id = ?', params: [this.workspaceId, command.messageId] }, [],
          {
            kind: 'message',
            id: command.messageId,
            ...(existing?.task_id ? { taskId: existing.task_id } : {}),
            change: 'delete',
          },
          new Date().toISOString(),
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
      case 'defineWorkflowVersion':
        return this.defineWorkflowVersion(command);
      case 'startWorkflowRun':
        return this.startWorkflowRun(command);
      case 'reapWorkflowTimeouts':
        return this.reapWorkflowTimeouts(command);
      case 'recoverWorkflowActivation':
        return this.recoverWorkflowActivation(command);
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
      case 'putSendOutbox': {
        validateSendOutboxEntry(command.entry);
        await this.write(
          [sendOutboxStatement(this.workspaceId, command.entry)],
          [{
            kind: 'send_outbox',
            id: command.entry.clientRequestId,
            taskId: command.entry.taskId,
            change: 'upsert',
          }],
          command.entry.updatedAt,
        );
        return { ok: true, changed: true };
      }
      case 'markSendOutboxRejected': {
        const results = await this.writeIfFirstChanged(
          {
            sql: `UPDATE send_outbox
                     SET status = 'rejected', updated_at = ?
                   WHERE workspace_id = ? AND client_request_id = ? AND status = 'pending'`,
            params: [command.updatedAt, this.workspaceId, command.clientRequestId],
          },
          [],
          { kind: 'send_outbox', id: command.clientRequestId, change: 'reject' },
          command.updatedAt,
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'deleteSendOutbox': {
        const results = await this.writeIfFirstChanged(
          {
            sql: 'DELETE FROM send_outbox WHERE workspace_id = ? AND client_request_id = ?',
            params: [this.workspaceId, command.clientRequestId],
          },
          [],
          { kind: 'send_outbox', id: command.clientRequestId, change: 'delete' },
          new Date().toISOString(),
        );
        return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
      }
      case 'putPresentation': {
        validatePresentationRecord(command.document);
        const results = await this.writeIfFirstChanged(
          presentationStatement(this.workspaceId, command.document),
          [],
          {
            kind: 'presentation',
            id: presentationFeedId(command.document.rootId, command.document.presentationId),
            taskId: command.document.ownerTaskId,
            change: 'upsert',
          },
          command.document.updatedAt,
        );
        return {
          ok: true,
          changed: (results[0]?.changes ?? 0) > 0,
          ...((results[0]?.changes ?? 0) === 0 ? { reason: 'presentation revision or owner conflict' } : {}),
        };
      }
      case 'commitPresentationOperation':
        return this.commitPresentationOperation(command);
      case 'deletePresentation': {
        const results = await this.writeIfFirstChanged(
          {
            sql: 'DELETE FROM presentations WHERE workspace_id = ? AND root_id = ? AND presentation_id = ?',
            params: [this.workspaceId, command.rootId, command.presentationId],
          },
          [],
          {
            kind: 'presentation',
            id: presentationFeedId(command.rootId, command.presentationId),
            change: 'delete',
          },
          new Date().toISOString(),
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
      `UPDATE tasks SET updated_at = updated_at
        WHERE workspace_id = ? AND id = ? AND revision = ?
          AND NOT EXISTS (
            SELECT 1
              FROM workflow_nodes node
              JOIN workflow_runs run
                ON run.workspace_id = node.workspace_id
               AND run.run_id = node.run_id
             WHERE node.workspace_id = tasks.workspace_id
               AND node.task_id = tasks.id
               AND run.status = 'running'
          )`,
      [this.workspaceId, command.taskId, command.expectedTaskRevision],
      this.workspaceId,
      command.expectedTurns,
    );
    const rest: SqlStatement[] = [
      {
        sql: `UPDATE task_session_bindings
                 SET active = 0, cleared_at = ?
               WHERE workspace_id = ? AND task_id = ? AND active = 1`,
        params: [command.task.updatedAt, this.workspaceId, command.taskId],
      },
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
    const disposition = command.turn.disposition;
    if (!disposition) return { ok: true, changed: false, reason: 'disposition is required' };
    const claim = durableDispositionClaim({
      turnId: command.turnId,
      taskId: command.turn.taskId,
      runtimeEpoch: command.expectedRuntimeEpoch ?? command.turn.runtimeEpoch,
      opId: command.opId,
      disposition,
    });
    let results: readonly import('./sqlite/rpc').RunResult[];
    try {
      results = await this.writeIfFirstChanged(
        guardedStageDispositionStatement(this.workspaceId, command),
        [
          dispositionClaimInsertStatement(
            this.workspaceId,
            claim,
            command.turn.startedAt ?? command.turn.createdAt,
          ),
        ],
        { kind: 'turn', id: command.turnId, taskId: command.turn.taskId, change: 'stage_disposition' },
        command.turn.startedAt ?? command.turn.createdAt,
      );
    } catch (error) {
      const existing = await this.getDispositionClaim(command.turnId);
      if (existing?.fingerprint === claim.fingerprint) {
        return { ok: true, changed: false };
      }
      if (existing) {
        return {
          ok: true,
          changed: false,
          reason: 'turn already has a different disposition',
          conflict: true,
        };
      }
      throw error;
    }
    if ((results[0]?.changes ?? 0) === 0) {
      const existing = await this.getDispositionClaim(command.turnId);
      if (existing?.fingerprint === claim.fingerprint) {
        return { ok: true, changed: false };
      }
      if (existing) {
        return {
          ok: true,
          changed: false,
          reason: 'turn already has a different disposition',
          conflict: true,
        };
      }
      return {
        ok: true,
        changed: false,
        reason: claim.family === 'workflow'
          ? 'workflow disposition is not authorized for the current route'
          : 'turn is no longer live',
      };
    }
    return { ok: true, changed: true };
  }

  private async getDispositionClaim(turnId: string): Promise<{
    opId: string;
    fingerprint: string;
    status: string;
  } | undefined> {
    const row = await this.db.get<{ op_id: string; fingerprint: string; status: string }>(
      `SELECT op_id, fingerprint, status
         FROM turn_disposition_claims
        WHERE workspace_id = ? AND turn_id = ?`,
      [this.workspaceId, turnId],
    );
    return row
      ? { opId: row.op_id, fingerprint: row.fingerprint, status: row.status }
      : undefined;
  }

  private async applyTaskLifecycle(
    command: Extract<RepositoryCommand, { kind: 'applyTaskLifecycle' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateLifecycleTask(command);
    if (invalid || command.task.id !== command.taskId) return { ok: true, changed: false, reason: invalid ?? 'lifecycle task id mismatch' };
    const workflowClosure = isTerminalLifecycle(command.task.lifecycle)
      ? await this.planWorkflowClosureFromTasks({
          taskIds: [command.task.id],
          reasonCode: command.task.lifecycle === 'cancelled'
            ? 'required_target_cancelled'
            : 'required_target_unavailable',
          at: command.task.updatedAt,
        })
      : { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const rest: SqlStatement[] = [
      ...taskMutationStatements(this.workspaceId, command.task),
      ...command.turns.flatMap((turn) => turnMutationStatements(this.workspaceId, turn)),
      ...(command.cancelRequests ?? []).map((entry) => cancelRequestStatement(this.workspaceId, {
        kind: 'putCancelRequest', workspaceId: this.workspaceId, turnId: entry.turnId, request: entry.request,
      })),
      ...workflowClosure.statements,
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'lifecycle' },
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'lifecycle' })),
      ...(command.cancelRequests ?? []).map((entry) => ({ kind: 'cancel_request' as const, id: entry.turnId, change: 'put' })),
      ...workflowClosure.changes,
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
      [...new Map(changes.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values()],
      command.task.updatedAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0, ...((results[0]?.changes ?? 0) === 0 ? { reason: 'task changed; retry' } : {}) };
  }

  private async cascadeTaskLifecycle(
    command: Extract<RepositoryCommand, { kind: 'cascadeTaskLifecycle' }>,
  ): Promise<RepositoryCommandResult> {
    const invalid = validateLifecycleTask(command);
    if (invalid) return { ok: true, changed: false, reason: invalid };
    const workflowClosure = command.mode === 'cancel' || command.mode === 'skip'
      ? await this.planWorkflowClosureFromTasks({
          taskIds: command.tasks.map((task) => task.id),
          reasonCode: command.mode === 'cancel'
            ? 'required_target_cancelled'
            : 'required_target_unavailable',
          at: command.tasks[0]?.updatedAt ?? new Date().toISOString(),
        })
      : { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const rest: SqlStatement[] = [
      ...command.tasks.flatMap((task) => taskMutationStatements(this.workspaceId, task)),
      ...command.turns.flatMap((turn) => turnMutationStatements(this.workspaceId, turn)),
      ...(command.cancelRequests ?? []).map((entry) => cancelRequestStatement(this.workspaceId, {
        kind: 'putCancelRequest', workspaceId: this.workspaceId, turnId: entry.turnId, request: entry.request,
      })),
      ...workflowClosure.statements,
    ];
    const changes: ChangeRecord[] = [
      ...command.tasks.map((task) => ({ kind: 'task' as const, id: task.id, change: `cascade_${command.mode}` })),
      ...command.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: `cascade_${command.mode}` })),
      ...(command.cancelRequests ?? []).map((entry) => ({ kind: 'cancel_request' as const, id: entry.turnId, change: 'put' })),
      ...workflowClosure.changes,
    ];
    const cascadeGuard = taskRevisionGuardStatement(this.workspaceId, command.expectedTasks);
    const fencedCascade = appendTurnFence(cascadeGuard.sql, cascadeGuard.params ?? [], this.workspaceId, command.expectedTurns);
    const results = await this.writeIfFirstChanged(
      { sql: fencedCascade.sql, params: fencedCascade.params },
      rest,
      [...new Map(changes.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values()],
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

  /**
   * Persist an immutable one-node workflow definition.
   * First statement claims (definitionId,version)/fingerprint on the operations ledger;
   * rest inserts workflow_definitions. Same fingerprint replays; conflict fails closed.
   */
  private async defineWorkflowVersion(
    command: Extract<RepositoryCommand, { kind: 'defineWorkflowVersion' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.workspaceId !== this.workspaceId) {
      throw new Error('workspace mismatch');
    }
    const validated = validateDefineWorkflow({
      definitionId: command.definitionId,
      version: command.version,
      name: command.name,
      topology: command.topology,
      entryContracts: command.entryContracts ?? [],
      policy: command.policy ?? DEFAULT_WORKFLOW_POLICY,
      scope: command.ownerRootTaskId
        ? { kind: 'root', ownerRootTaskId: command.ownerRootTaskId }
        : { kind: 'workspace' },
      createdAt: command.createdAt,
    });
    if (!validated.ok) {
      const reason =
        validated.reason.includes('definitionId') ||
        validated.reason.includes('version') ||
        validated.reason.includes('name') ||
        validated.reason.includes('createdAt')
          ? 'invalid identity'
          : 'invalid topology';
      const shaped = defineWorkflowInvalid(reason);
      return {
        ok: false,
        changed: false,
        conflict: true,
        reason: shaped.reason,
        operation: {
          fingerprint: '',
          result: { ok: false, error: shaped.reason },
        },
      };
    }
    const { definition, fingerprint, topologyJson } = validated;
    const ledgerKey = defineWorkflowLedgerKey(
      definition.definitionId,
      definition.version,
      definition.scope.kind === 'root' ? definition.scope.ownerRootTaskId : undefined,
    );
    const resultPayload = defineWorkflowCreated(definition, fingerprint);
    // Claim first: INSERT OR IGNORE into operations. Zero changes → inspect existing fingerprint.
    const claimSql: SqlStatement = {
      sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
            SELECT ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM workflow_definitions definition
                WHERE definition.workspace_id = ?
                  AND definition.definition_id = ?
                  AND definition.version = ?
                  AND (
                    definition.scope_kind <> ?
                    OR definition.owner_root_task_id IS NOT ?
                  )
             )
            ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
      params: [
        this.workspaceId,
        ledgerKey,
        fingerprint,
        encodePayload({ result: { ok: true, data: resultPayload } }),
        definition.createdAt,
        this.workspaceId,
        definition.definitionId,
        definition.version,
        definition.scope.kind,
        definition.scope.kind === 'root' ? definition.scope.ownerRootTaskId : null,
      ],
    };
    const defSql = {
      sql: `INSERT INTO workflow_definitions (
              workspace_id, definition_id, version, name, entry_node_id, topology_json,
              scope_kind, owner_root_task_id, fingerprint, policy_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, definition_id, version) DO NOTHING`,
      params: [
        this.workspaceId,
        definition.definitionId,
        definition.version,
        definition.name,
        entryNodeIds(definition.topology)[0]!,
        topologyJson,
        definition.scope.kind,
        definition.scope.kind === 'root' ? definition.scope.ownerRootTaskId : null,
        fingerprint,
        JSON.stringify(definition.policy),
        definition.createdAt,
      ],
    };
    const terminalId = terminalNodeId(definition.topology);
    const normalizedTopologyStatements: SqlStatement[] = definition.topology.nodes.map(
      (node, ordinal) => ({
        sql: `INSERT INTO workflow_definition_nodes
              (workspace_id, definition_id, definition_version, node_id, ordinal,
               is_terminal, role, task_type, backend, model, capabilities_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(workspace_id, definition_id, definition_version, node_id) DO NOTHING`,
        params: [
          this.workspaceId,
          definition.definitionId,
          definition.version,
          node.nodeId,
          ordinal,
          node.nodeId === terminalId ? 1 : 0,
          node.role ?? null,
          node.taskType ?? null,
          node.backend ?? null,
          node.model ?? null,
          JSON.stringify(node.capabilities ?? []),
        ],
      }),
    );
    if (definition.topology.kind === 'graph_v1') {
      for (const [ordinal, edge] of definition.topology.edges.entries()) {
        normalizedTopologyStatements.push({
          sql: `INSERT INTO workflow_definition_edges
                (workspace_id, definition_id, definition_version, source_node_id,
                 destination_node_id, destination_input_ref, ordinal, expected_artifact_kind)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id, definition_id, definition_version, source_node_id)
                DO NOTHING`,
          params: [
            this.workspaceId,
            definition.definitionId,
            definition.version,
            edge.fromNodeId,
            edge.toNodeId,
            edge.inputRef,
            ordinal,
            edge.expectedArtifactKind ?? 'next_result',
          ],
        });
      }
    }
    for (const [ordinal, contract] of definition.entryContracts.entries()) {
      normalizedTopologyStatements.push({
        sql: `INSERT INTO workflow_entry_contracts
              (workspace_id, definition_id, definition_version, entry_node_id,
               input_ref, ordinal, expected_artifact_kind)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(workspace_id, definition_id, definition_version, entry_node_id, input_ref)
              DO NOTHING`,
        params: [
          this.workspaceId,
          definition.definitionId,
          definition.version,
          contract.entryNodeId,
          contract.inputRef,
          ordinal,
          contract.expectedArtifactKind,
        ],
      });
    }
    // Ensure workspace row exists for FK (same pattern as other creates).
    await this.db.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
      [this.workspaceId, this.workspaceId, this.workspaceId, definition.createdAt, definition.createdAt],
    );
    await this.db.run(
      `INSERT INTO workspace_revisions (workspace_id, revision)
       VALUES (?, 0) ON CONFLICT(workspace_id) DO NOTHING`,
      [this.workspaceId],
    );

    const publicClaimSql: SqlStatement | undefined = command.publicOperation
      ? {
          sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                SELECT ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (
                   SELECT 1 FROM operations
                    WHERE workspace_id = ? AND ledger_key = ? AND fingerprint <> ?
                 )
                   AND NOT EXISTS (
                     SELECT 1 FROM workflow_definitions definition
                      WHERE definition.workspace_id = ?
                        AND definition.definition_id = ?
                        AND definition.version = ?
                        AND (
                          definition.scope_kind <> ?
                          OR definition.owner_root_task_id IS NOT ?
                        )
                   )
                ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
          params: [
            this.workspaceId,
            command.publicOperation.ledgerKey,
            command.publicOperation.fingerprint,
            encodePayload({ result: { ok: true, data: resultPayload } }),
            definition.createdAt,
            this.workspaceId,
            ledgerKey,
            fingerprint,
            this.workspaceId,
            definition.definitionId,
            definition.version,
            definition.scope.kind,
            definition.scope.kind === 'root' ? definition.scope.ownerRootTaskId : null,
          ],
        }
      : undefined;
    const statements = [
      ...(publicClaimSql ? [publicClaimSql] : []),
      claimSql,
      defSql,
      ...normalizedTopologyStatements,
    ];
    const tx = await this.db.transaction(statements, {
      abortIfFirstUnchanged: publicClaimSql !== undefined,
    });
    const domainClaimIndex = publicClaimSql ? 1 : 0;
    if (publicClaimSql && (tx[0]?.changes ?? 0) === 0) {
      const existingPublic = await this.db.get<OperationRow>(
        `SELECT ledger_key, fingerprint, result_json FROM operations
          WHERE workspace_id = ? AND ledger_key = ?`,
        [this.workspaceId, command.publicOperation!.ledgerKey],
      );
      if (existingPublic) {
        const operation = decodeOperation(existingPublic);
        if (operation.fingerprint !== command.publicOperation!.fingerprint) {
          return {
            ok: false,
            changed: false,
            conflict: true,
            reason: 'operation fingerprint conflict',
            operation,
          };
        }
        return { ok: true, changed: false, operation };
      }
      const conflict = defineWorkflowConflict(definition.definitionId, definition.version);
      return {
        ok: false,
        changed: false,
        conflict: true,
        reason: conflict.reason,
        operation: { fingerprint, result: { ok: false, error: conflict.reason } },
      };
    }
    const claimChanges = tx[domainClaimIndex]?.changes ?? 0;
    if (claimChanges > 0) {
      // Fresh claim — definition insert should have landed (or already matched).
      return {
        ok: true,
        changed: true,
        operation: {
          fingerprint,
          result: { ok: true, data: resultPayload },
        },
      };
    }
    // Replay or conflict: read existing operation fingerprint.
    const existing = await this.db.get(
      `SELECT fingerprint, result_json FROM operations
        WHERE workspace_id = ? AND ledger_key = ?`,
      [this.workspaceId, ledgerKey],
    ) as { fingerprint?: string; result_json?: string } | null;
    if (!existing || typeof existing.fingerprint !== 'string') {
      const conflict = defineWorkflowConflict(definition.definitionId, definition.version);
      return {
        ok: false,
        changed: false,
        conflict: true,
        reason: conflict.reason,
        operation: { fingerprint, result: { ok: false, error: conflict.reason } },
      };
    }
    if (existing.fingerprint === fingerprint) {
      const replay = defineWorkflowReplay(definition, fingerprint);
      return {
        ok: true,
        changed: false,
        operation: {
          fingerprint,
          result: { ok: true, data: replay },
        },
      };
    }
    const conflict = defineWorkflowConflict(definition.definitionId, definition.version);
    return {
      ok: false,
      changed: false,
      conflict: true,
      reason: conflict.reason,
      operation: {
        fingerprint: existing.fingerprint,
        result: { ok: false, error: conflict.reason },
      },
    };
  }

  /**
   * Atomically start a frozen one-node workflow run.
   * First statement claims startIdempotencyKey on the operations ledger;
   * rest inserts run, node, satisfied entry gate, engine start artifact, entry
   * task, aggregate message, and exactly one queued activation turn.
   */
  private async startWorkflowRun(
    command: Extract<RepositoryCommand, { kind: 'startWorkflowRun' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.workspaceId !== this.workspaceId) {
      throw new Error('workspace mismatch');
    }

    const invalidStart = (
      reason: 'definition not found' | 'invalid start' | 'invalid identity',
    ): RepositoryCommandResult => {
      const shaped = startWorkflowInvalid(reason, command.definitionId, command.version);
      return {
        ok: false,
        changed: false,
        conflict: true,
        reason: shaped.reason,
        operation: { fingerprint: '', result: { ok: false, error: shaped.reason } },
      };
    };

    // Load and revalidate the complete immutable definition before allocating runtime rows.
    const defRow = await this.db.get(
      `SELECT definition_id, version, name, entry_node_id, topology_json, scope_kind,
              owner_root_task_id, fingerprint, policy_json, created_at
         FROM workflow_definitions
        WHERE workspace_id = ? AND definition_id = ? AND version = ?`,
      [this.workspaceId, command.definitionId, command.version],
    ) as {
      definition_id?: string;
      version?: number;
      name?: string;
      entry_node_id?: string;
      topology_json?: string;
      scope_kind?: string;
      owner_root_task_id?: string | null;
      fingerprint?: string;
      policy_json?: string;
      created_at?: string;
    } | null;

    if (!defRow || typeof defRow.topology_json !== 'string' || typeof defRow.entry_node_id !== 'string') {
      return invalidStart('definition not found');
    }

    const topology = decodeStoredTopologyJson(defRow.topology_json);
    const contractRows = await this.db.all(
      `SELECT entry_node_id, input_ref, expected_artifact_kind
         FROM workflow_entry_contracts
        WHERE workspace_id = ? AND definition_id = ? AND definition_version = ?
        ORDER BY ordinal`,
      [this.workspaceId, command.definitionId, command.version],
    ) as Array<{
      entry_node_id?: string;
      input_ref?: string;
      expected_artifact_kind?: string;
    }>;
    let storedPolicy: unknown;
    try {
      storedPolicy = typeof defRow.policy_json === 'string' ? JSON.parse(defRow.policy_json) : undefined;
    } catch {
      return invalidStart('invalid start');
    }
    if (
      !topology.ok ||
      typeof defRow.name !== 'string' ||
      typeof defRow.created_at !== 'string' ||
      typeof defRow.fingerprint !== 'string' ||
      (defRow.scope_kind !== 'workspace' && defRow.scope_kind !== 'root') ||
      contractRows.some((row) =>
        typeof row.entry_node_id !== 'string' ||
        typeof row.input_ref !== 'string' ||
        typeof row.expected_artifact_kind !== 'string')
    ) {
      return invalidStart('invalid start');
    }
    const storedDefinition = validateDefineWorkflow({
      definitionId: command.definitionId,
      version: command.version,
      name: defRow.name,
      topology: topology.topology,
      entryContracts: contractRows.map((row) => ({
        entryNodeId: row.entry_node_id!,
        inputRef: row.input_ref!,
        expectedArtifactKind: row.expected_artifact_kind!,
      })),
      policy: storedPolicy,
      scope: defRow.scope_kind === 'root'
        ? { kind: 'root', ownerRootTaskId: defRow.owner_root_task_id ?? '' }
        : { kind: 'workspace' },
      createdAt: defRow.created_at,
    });
    if (!storedDefinition.ok || storedDefinition.fingerprint !== defRow.fingerprint) {
      return invalidStart('invalid start');
    }
    if (
      storedDefinition.definition.scope.kind === 'root' &&
      command.ownerRootTaskId !== storedDefinition.definition.scope.ownerRootTaskId
    ) {
      return invalidStart('invalid identity');
    }

    let effectivePolicy = storedDefinition.definition.policy;
    if (command.effectivePolicy) {
      const numericPolicyKeys: Array<Exclude<keyof WorkflowPolicyV1, 'failWorkflow'>> = [
        'maxFeedbackRoundsPerRun',
        'maxTurnsPerTask',
        'maxWorkflowTurnsPerRun',
        'runTimeoutMs',
        'maxDepth',
        'maxTaskCount',
        'maxConcurrency',
        'maxInputsPerGate',
        'maxArtifactBytes',
        'maxAggregateBytes',
      ];
      if (
        command.effectivePolicy.failWorkflow !== effectivePolicy.failWorkflow ||
        numericPolicyKeys.some((key) => command.effectivePolicy![key] > effectivePolicy[key])
      ) {
        return invalidStart('invalid start');
      }
      const effectiveDefinition = validateDefineWorkflow({
        ...storedDefinition.definition,
        policy: command.effectivePolicy,
      });
      if (!effectiveDefinition.ok) return invalidStart('invalid start');
      effectivePolicy = effectiveDefinition.definition.policy;
    }

    const topo = storedDefinition.definition.topology;
    const startEntryNodeIds = entryNodeIds(topo);
    const allNodeIds = topo.nodes.map((n) => n.nodeId);
    if (
      startEntryNodeIds.length === 0 ||
      !startEntryNodeIds.includes(defRow.entry_node_id) ||
      (topo.kind === 'one_node_v1' && topo.entryNodeId !== defRow.entry_node_id)
    ) {
      return invalidStart('invalid start');
    }

    const goal = command.goal ?? defRow.name;
    const validated = validateStartWorkflow({
      definitionId: command.definitionId,
      version: command.version,
      startIdempotencyKey: command.startIdempotencyKey,
      createdAt: command.createdAt,
      entryNodeId: defRow.entry_node_id,
      entryNodeIds: startEntryNodeIds,
      allNodeIds,
      goal,
      backend: command.backend,
      entryInputs: command.entryInputs,
      entryContracts: storedDefinition.definition.entryContracts,
      policy: effectivePolicy,
      ownerRootTaskId: command.ownerRootTaskId,
      callerTaskId: command.callerTaskId,
      callerTurnId: command.callerTurnId,
    });
    if (!validated.ok) {
      return invalidStart(
        validated.reason.includes('definitionId') ||
        validated.reason.includes('version') ||
        validated.reason.includes('startIdempotencyKey') ||
        validated.reason.includes('createdAt') ||
        validated.reason.includes('caller authority')
          ? 'invalid identity'
          : 'invalid start',
      );
    }

    const { identities, fingerprint } = validated;
    if (identities.entries.length > validated.policy.maxWorkflowTurnsPerRun) {
      return invalidStart('invalid start');
    }
    const resultPayload = startWorkflowCreated(validated);
    const ledgerKey = startWorkflowLedgerKey(
      validated.startIdempotencyKey,
      validated.ownerRootTaskId && validated.callerTaskId
        ? {
            ownerRootTaskId: validated.ownerRootTaskId,
            callerTaskId: validated.callerTaskId,
            definitionId: validated.definitionId,
            version: validated.version,
          }
        : undefined,
    );

    const nodeById = new Map(topo.nodes.map((node) => [node.nodeId, node] as const));
    const entryByNode = new Map(identities.entries.map((e) => [e.nodeId, e]));
    const gateByNode = new Map(identities.nodeGates.map((g) => [g.nodeId, g.gateId]));
    const entryNodeSet = new Set(identities.entries.map((e) => e.nodeId));
    const inputByKey = new Map<string, (typeof validated.entryInputs)[number]>(
      validated.entryInputs.map((input) => [`${input.entryNodeId}\0${input.inputRef}`, input] as const),
    );
    const artifactByKey = new Map<string, (typeof identities.entryArtifacts)[number]>(
      identities.entryArtifacts.map((artifact) => [
        `${artifact.entryNodeId}\0${artifact.inputRef}`,
        artifact,
      ] as const),
    );
    const createdAtMs = Date.parse(validated.createdAt);
    if (!Number.isFinite(createdAtMs)) return invalidStart('invalid identity');
    const deadlineAt = new Date(createdAtMs + validated.policy.runTimeoutMs).toISOString();

    for (const entry of identities.entries) {
      const contracts = validated.entryContracts.filter((contract) => contract.entryNodeId === entry.nodeId);
      const aggregate = formatWorkflowEntryAggregate(contracts.map((contract) => ({
        inputRef: contract.inputRef,
        value: inputByKey.get(`${entry.nodeId}\0${contract.inputRef}`)!.value,
      })));
      if (Buffer.byteLength(aggregate, 'utf8') > validated.policy.maxAggregateBytes) {
        return invalidStart('invalid start');
      }
    }

    const domainClaim: SqlStatement = command.publicOperation
      ? {
          sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                SELECT ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (
                   SELECT 1 FROM operations
                    WHERE workspace_id = ? AND ledger_key = ? AND fingerprint <> ?
                 )
                ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
          params: [
            this.workspaceId,
            ledgerKey,
            fingerprint,
            encodePayload({ result: { ok: true, data: resultPayload } }),
            validated.createdAt,
            this.workspaceId,
            command.publicOperation.ledgerKey,
            command.publicOperation.fingerprint,
          ],
        }
      : {
          sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
          params: [
            this.workspaceId,
            ledgerKey,
            fingerprint,
            encodePayload({ result: { ok: true, data: resultPayload } }),
            validated.createdAt,
          ],
        };

    const claims: SqlStatement[] = command.publicOperation
      ? [
          domainClaim,
          {
            sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                  SELECT ?, ?, ?, ?, ?
                   WHERE NOT EXISTS (
                     SELECT 1 FROM operations
                      WHERE workspace_id = ? AND ledger_key = ? AND fingerprint <> ?
                   )
                     AND NOT EXISTS (
                       SELECT 1 FROM operations
                        WHERE workspace_id = ? AND ledger_key = ? AND fingerprint <> ?
                     )
                  ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
            params: [
              this.workspaceId,
              command.publicOperation.ledgerKey,
              command.publicOperation.fingerprint,
              encodePayload({ result: { ok: true, data: resultPayload } }),
              validated.createdAt,
              this.workspaceId,
              command.publicOperation.ledgerKey,
              command.publicOperation.fingerprint,
              this.workspaceId,
              ledgerKey,
              fingerprint,
            ],
          },
        ]
      : [domainClaim];

    const rest: SqlStatement[] = [
      {
        sql: `INSERT INTO workflow_runs (
                 workspace_id, run_id, definition_id, definition_version, status, origin,
                 parent_run_id, owner_root_task_id, caller_task_id, caller_turn_id,
                 continuation_id, policy_json, max_feedback_rounds, max_turns_per_task,
                  max_workflow_turns, max_children, max_depth, max_concurrency,
                  max_aggregate_bytes, feedback_rounds_reserved, workflow_turns_reserved,
                  children_reserved, started_at, deadline_at, created_at, updated_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(workspace_id, run_id) DO NOTHING`,
        params: [
          this.workspaceId,
          identities.runId,
          validated.definitionId,
          validated.version,
          'running',
          'top_level',
          null,
          validated.ownerRootTaskId ?? null,
          validated.callerTaskId ?? null,
          validated.callerTurnId ?? null,
          null,
          JSON.stringify(validated.policy),
          validated.policy.maxFeedbackRoundsPerRun,
          validated.policy.maxTurnsPerTask,
          validated.policy.maxWorkflowTurnsPerRun,
          validated.policy.maxTaskCount,
          validated.policy.maxDepth,
          validated.policy.maxConcurrency,
          validated.policy.maxAggregateBytes,
          0,
          identities.entries.length,
          0,
          validated.createdAt,
          deadlineAt,
          validated.createdAt,
          validated.createdAt,
        ],
      },
    ];

    if (validated.ownerRootTaskId && validated.callerTaskId && validated.callerTurnId) {
      rest.push({
        sql: `INSERT INTO workflow_start_claims (
                workspace_id, owner_task_id, caller_task_id, caller_turn_id,
                definition_id, definition_version, idempotency_key, fingerprint,
                run_id, created_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT DO NOTHING`,
        params: [
          this.workspaceId,
          validated.ownerRootTaskId,
          validated.callerTaskId,
          validated.callerTurnId,
          validated.definitionId,
          validated.version,
          validated.startIdempotencyKey,
          fingerprint,
          identities.runId,
          validated.createdAt,
        ],
      });
    }

    for (const entry of identities.entries) {
      const node = nodeById.get(entry.nodeId)!;
      const task: MusterTask = {
        id: entry.taskId,
        role: node.role ?? 'worker',
        lifecycle: 'open',
        releaseState: 'released',
        goal: validated.goal,
        parentId: validated.callerTaskId ?? null,
        dependencies: [],
        backend: node.backend ?? validated.backend,
        ...(node.model !== undefined ? { model: node.model } : {}),
        ...(node.taskType !== undefined ? { taskType: node.taskType } : {}),
        capabilities: [...(node.capabilities ?? [])] as MusterTask['capabilities'],
        executionPolicy: {
          maxTurns: validated.policy.maxTurnsPerTask,
          maxAutomaticRetries: 1,
          runTimeoutOverrideMs: validated.policy.runTimeoutMs,
        },
        revision: 0,
        createdAt: validated.createdAt,
        updatedAt: validated.createdAt,
        releasedAt: validated.createdAt,
      };
      rest.push(taskStatement(this.workspaceId, task, false));
    }

    for (const nodeGate of identities.nodeGates) {
      const isEntry = entryNodeSet.has(nodeGate.nodeId);
      const entry = entryByNode.get(nodeGate.nodeId);
      rest.push({
        sql: `INSERT INTO workflow_dependency_gates (
                workspace_id, run_id, gate_id, consumer_node_id, status,
                activation_id, reserved_turn_id, aggregate_message_id
              ) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, gate_id) DO NOTHING`,
        params: [
          this.workspaceId,
          identities.runId,
          nodeGate.gateId,
          nodeGate.nodeId,
          isEntry ? 'satisfied' : 'open',
          isEntry && entry ? entry.activationId : null,
          isEntry && entry ? entry.activationTurnId : null,
          isEntry && entry ? entry.messageId : null,
        ],
      });
      rest.push({
        sql: `INSERT INTO workflow_nodes (
                workspace_id, run_id, node_id, task_id, status
              ) VALUES (?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, node_id) DO NOTHING`,
        params: [
          this.workspaceId,
          identities.runId,
          nodeGate.nodeId,
          isEntry && entry ? entry.taskId : null,
          isEntry ? 'active' : 'pending',
        ],
      });
    }

    for (const entry of identities.entries) {
      const contracts = validated.entryContracts.filter((contract) => contract.entryNodeId === entry.nodeId);
      const bindings = contracts.length > 0
        ? contracts
        : [{ entryNodeId: entry.nodeId, inputRef: 'engine_start', expectedArtifactKind: 'engine_start' }];
      const aggregateContent = formatWorkflowEntryAggregate(contracts.map((contract) => ({
        inputRef: contract.inputRef,
        value: inputByKey.get(`${entry.nodeId}\0${contract.inputRef}`)!.value,
      })));
      const message: TaskMessage = {
        id: entry.messageId,
        taskId: entry.taskId,
        role: 'system',
        content: aggregateContent,
        state: 'assigned',
        turnId: entry.activationTurnId,
        createdAt: validated.createdAt,
      };
      const turn: TaskTurn = {
        id: entry.activationTurnId,
        taskId: entry.taskId,
        sequence: 1,
        status: 'queued',
        trigger: 'engine',
        inputs: [{ kind: 'message', messageId: entry.messageId }],
        createdAt: validated.createdAt,
      };
      for (const binding of bindings) {
        const key = `${entry.nodeId}\0${binding.inputRef}`;
        const artifact = artifactByKey.get(key)!;
        const input = inputByKey.get(key);
        rest.push(
          {
            sql: `INSERT INTO workflow_artifacts (
                    workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                    revision, kind, payload_json, created_at
                  ) VALUES (?,?,?,?,?,?,?,?,?)
                  ON CONFLICT DO NOTHING`,
            params: [
              this.workspaceId,
              identities.runId,
              artifact.artifactId,
              null,
              binding.inputRef,
              1,
              binding.expectedArtifactKind,
              input
                ? encodePayload({ value: input.value })
                : encodePayload({ kind: 'engine_start', schema: 1 }),
              validated.createdAt,
            ],
          },
          {
            sql: `INSERT INTO workflow_artifact_sources (
                    workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                    producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
                    producing_activation_id, caller_task_id, caller_turn_id,
                    engine_start_operation_key
                  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(workspace_id, run_id, artifact_id, artifact_revision) DO NOTHING`,
            params: [
              this.workspaceId,
              identities.runId,
              artifact.artifactId,
              1,
              input ? 'caller_turn' : 'engine_start',
              null,
              null,
              null,
              null,
              null,
              input ? validated.callerTaskId ?? null : null,
              input ? validated.callerTurnId ?? null : null,
              input ? null : ledgerKey,
            ],
          },
          {
            sql: `INSERT INTO workflow_gate_bindings (
                    workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind
                  ) VALUES (?,?,?,?,?,?)
                  ON CONFLICT(workspace_id, run_id, gate_id, input_ref) DO NOTHING`,
            params: [
              this.workspaceId,
              identities.runId,
              entry.gateId,
              binding.inputRef,
              null,
              binding.expectedArtifactKind,
            ],
          },
          {
            sql: `INSERT INTO workflow_gate_fills (
                    workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at
                  ) VALUES (?,?,?,?,?,?,?)
                  ON CONFLICT(workspace_id, run_id, gate_id, input_ref)
                  DO NOTHING`,
            params: [
              this.workspaceId,
              identities.runId,
              entry.gateId,
              binding.inputRef,
              artifact.artifactId,
              1,
              validated.createdAt,
            ],
          },
        );
      }
      rest.push(
        turnStatement(this.workspaceId, turn, false),
        messageStatement(this.workspaceId, message, false),
        turnInputStatement(
          this.workspaceId,
          turn.id,
          0,
          { kind: 'message', messageId: entry.messageId },
        ),
        {
          sql: `INSERT INTO workflow_activations (
                  workspace_id, run_id, activation_id, node_id, kind, status,
                  source_gate_id, feedback_round_id, feedback_target_node_id,
                  continuation_id, return_gate_id, inherited_feedback_round_id,
                  inherited_feedback_target_node_id, primary_turn_id, message_id,
                  execution_turn_id, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(workspace_id, run_id, activation_id) DO NOTHING`,
          params: [
            this.workspaceId,
            identities.runId,
            entry.activationId,
            entry.nodeId,
            'entry_start',
            'queued',
            entry.gateId,
            null,
            null,
            null,
            null,
            null,
            null,
            entry.activationTurnId,
            entry.messageId,
            entry.activationTurnId,
            validated.createdAt,
            validated.createdAt,
          ],
        },
      );
    }

    if (topo.kind === 'graph_v1') {
      for (const edge of topo.edges) {
        const gateId = gateByNode.get(edge.toNodeId);
        if (!gateId) continue;
        rest.push({
          sql: `INSERT INTO workflow_gate_bindings (
                  workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind
                ) VALUES (?,?,?,?,?,?)
                ON CONFLICT(workspace_id, run_id, gate_id, input_ref) DO NOTHING`,
          params: [
            this.workspaceId,
            identities.runId,
            gateId,
            edge.inputRef,
            edge.fromNodeId,
            edge.expectedArtifactKind ?? 'next_result',
          ],
        });
      }
    }

    await this.db.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
      [this.workspaceId, this.workspaceId, this.workspaceId, validated.createdAt, validated.createdAt],
    );
    await this.db.run(
      `INSERT INTO workspace_revisions (workspace_id, revision)
       VALUES (?, 0) ON CONFLICT(workspace_id) DO NOTHING`,
      [this.workspaceId],
    );

    const tx = await this.db.transaction([...claims, ...rest], {
      abortIfFirstUnchanged: true,
    });
    const claimChanges = tx[0]?.changes ?? 0;
    if (claimChanges > 0) {
      return {
        ok: true,
        changed: true,
        operation: {
          fingerprint,
          result: { ok: true, data: resultPayload },
        },
      };
    }

    const existing = await this.db.get(
      `SELECT fingerprint, result_json FROM operations
        WHERE workspace_id = ? AND ledger_key = ?`,
      [this.workspaceId, ledgerKey],
    ) as { fingerprint?: string; result_json?: string } | null;
    if (!existing || typeof existing.fingerprint !== 'string') {
      const conflict = startWorkflowConflict(validated.definitionId, validated.version);
      return {
        ok: false,
        changed: false,
        conflict: true,
        reason: conflict.reason,
        operation: { fingerprint, result: { ok: false, error: conflict.reason } },
      };
    }
    if (existing.fingerprint === fingerprint) {
      const replay = startWorkflowReplay(validated);
      return {
        ok: true,
        changed: false,
        operation: {
          fingerprint,
          result: { ok: true, data: replay },
        },
      };
    }
    const conflict = startWorkflowConflict(validated.definitionId, validated.version);
    return {
      ok: false,
      changed: false,
      conflict: true,
      reason: conflict.reason,
      operation: {
        fingerprint: existing.fingerprint,
        result: { ok: false, error: conflict.reason },
      },
    } as RepositoryCommandResult;
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
      ...conditionalRevisionStatements(
        this.workspaceId,
        { kind: 'operation', id: command.ledgerKey, change: 'insert' },
        command.createdAt,
        this.changeFeedRetainRevisions,
      ),
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
    const taskId = await this.lookupTurnTaskId(turnId);
    const results = await this.writeIfFirstChanged(
      { sql: `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ? AND status = 'queued'`, params: [startedAt, this.workspaceId, turnId] }, [],
      { kind: 'turn', id: turnId, ...(taskId ? { taskId } : {}), change: 'promote' }, startedAt,
    );
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async claim(command: Extract<RepositoryCommand, { kind: 'claimTurn' }>): Promise<RepositoryCommandResult> {
    const taskId = await this.lookupTurnTaskId(command.turnId);
    const update = claimTurnStatement(this.workspaceId, command);
    const rest: SqlStatement[] = [
      workflowActivationRunningStatement(this.workspaceId, command.turnId, command.startedAt),
    ];
    if (command.sessionId) rest.push(sessionClaimStatement(this.workspaceId, command.turnId, command.sessionId, command.startedAt));
    for (const key of command.resourceKeys) rest.push(resourceClaimStatement(this.workspaceId, command.turnId, key, command.startedAt));
    const results = await this.writeIfFirstChanged(
      update,
      rest,
      { kind: 'turn', id: command.turnId, ...(taskId ? { taskId } : {}), change: 'promote' },
      command.startedAt,
    );
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
      ...(claims
        ? [workflowActivationRunningStatement(this.workspaceId, command.turn.id, command.startedAt)]
        : []),
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
    const taskId = await this.lookupTurnTaskId(command.turnId);
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
      workflowActivationSettlementStatement(
        this.workspaceId,
        command.turnId,
        command.status,
        command.finishedAt,
      ),
      dispositionClaimSettlementStatement(
        this.workspaceId,
        command.turnId,
        command.status === 'succeeded' ? 'consumed' : 'discarded',
        command.finishedAt,
      ),
    ], {
      kind: 'turn',
      id: command.turnId,
      ...(taskId ? { taskId } : {}),
      change: 'settle',
    }, command.finishedAt);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async lookupTurnTaskId(turnId: string): Promise<string | undefined> {
    const row = await this.db.get<{ task_id: string }>(
      'SELECT task_id FROM turns WHERE workspace_id = ? AND id = ?',
      [this.workspaceId, turnId],
    );
    return row?.task_id;
  }

  private async settleTurnAndApplyEffects(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<RepositoryCommandResult> {
    if (command.expectedStatuses.length === 0) {
      return { ok: true, changed: false, reason: 'expected live status required' };
    }
    const dispositionClaimConflict = await this.validateSettlementDispositionClaim(command);
    if (dispositionClaimConflict) return dispositionClaimConflict;
    // M018 S05: workflow_fail / invalid-route / budget exhaustion close the run first.
    // M018 S04: feedback responses intercept workflow_next on a feedback turn before
    // the forward contribution path. PREV requests open a round; otherwise fall through
    // to the existing NEXT contribution planner.
    const failClosure = await this.planWorkflowFailFromSettle(command);
    // M018 S06: child invocation is mutually exclusive with feedback/next/prev.
    const childInvocation = failClosure.statements.length > 0
      ? { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] }
      : await this.planWorkflowChildInvocation(command);
    if (childInvocation.conflictReason) {
      return {
        ok: true,
        changed: false,
        conflict: true,
        reason: childInvocation.conflictReason,
      };
    }
    const feedbackResponse = (
      failClosure.statements.length > 0
      || childInvocation.statements.length > 0
    )
      ? { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] }
      : await this.planWorkflowFeedbackResponse(command);
    const prevRequest = (
      failClosure.statements.length > 0
      || childInvocation.statements.length > 0
      || feedbackResponse.statements.length > 0
    )
      ? { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] }
      : await this.planWorkflowPrevRequest(command);
    // M018 S06: terminal child NEXT returns to the caller before ordinary forward NEXT.
    const childReturn = (
      failClosure.statements.length > 0
      || childInvocation.statements.length > 0
      || feedbackResponse.statements.length > 0
      || prevRequest.statements.length > 0
    )
      ? { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] }
      : await this.planWorkflowChildReturn(command);
    const nextContribution = (
      failClosure.statements.length > 0
      || childInvocation.statements.length > 0
      || feedbackResponse.statements.length > 0
      || prevRequest.statements.length > 0
      || childReturn.statements.length > 0
    )
      ? { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] }
      : await this.planWorkflowNextContribution(command);
    const budgetedRoutePlans: WorkflowEffectPlan[] = [
      feedbackResponse,
      prevRequest,
      childReturn,
      nextContribution,
    ];
    const budget = await this.planWorkflowBudgetExhaustionIfNeeded(command, {
      feedbackRounds: budgetedRoutePlans.flatMap(
        (plan) => plan.feedbackRoundReservations ?? [],
      ),
      workflowTurns: budgetedRoutePlans.flatMap((plan) => plan.turnReservations ?? []),
    });
    const routeEffects = {
      statements: [
        ...failClosure.statements,
        ...childInvocation.statements,
        ...feedbackResponse.statements,
        ...prevRequest.statements,
        ...childReturn.statements,
        ...nextContribution.statements,
      ],
      changes: [
        ...failClosure.changes,
        ...childInvocation.changes,
        ...feedbackResponse.changes,
        ...prevRequest.changes,
        ...childReturn.changes,
        ...nextContribution.changes,
      ],
    };
    const workflowEffects = budget.exhausted
      ? { statements: budget.statements, changes: budget.changes }
      : {
          statements: [...budget.statements, ...routeEffects.statements],
          changes: [...budget.changes, ...routeEffects.changes],
        };
    const rest: SqlStatement[] = [
      taskStatement(this.workspaceId, command.task, true),
      ...sessionBindingStatements(
        this.workspaceId,
        command.task,
        command.turn.finishedAt ?? new Date().toISOString(),
      ),
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
      ...(command.turn.status === 'succeeded'
        ? workflowActivationSourceConsumptionStatements(
            this.workspaceId,
            command.turn.id,
            command.turn.finishedAt ?? new Date().toISOString(),
          )
        : []),
      workflowActivationSettlementStatement(
        this.workspaceId,
        command.turn.id,
        command.turn.status,
        command.turn.finishedAt ?? new Date().toISOString(),
      ),
      dispositionClaimSettlementStatement(
        this.workspaceId,
        command.turn.id,
        command.turn.status === 'succeeded' ? 'consumed' : 'discarded',
        command.turn.finishedAt ?? new Date().toISOString(),
      ),
      ...workflowEffects.statements,
    ];
    const changes: ChangeRecord[] = [
      { kind: 'task', id: command.task.id, change: 'settle' },
      { kind: 'turn', id: command.turn.id, taskId: command.task.id, change: 'settle' },
      ...command.relatedTurns.map((turn) => ({ kind: 'turn' as const, id: turn.id, taskId: turn.taskId, change: 'effect' })),
      ...command.messages.map((message) => ({ kind: 'message' as const, id: message.id, taskId: message.taskId, change: 'complete' })),
      ...workflowEffects.changes,
    ];
    const uniqueChanges = [
      ...new Map(changes.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values(),
    ];
    let results: readonly import('./sqlite/rpc').RunResult[];
    try {
      results = await this.writeIfFirstChanged(
        guardedSettleTurnStatement(this.workspaceId, command),
        rest,
        uniqueChanges,
        command.turn.finishedAt ?? new Date().toISOString(),
      );
    } catch (error) {
      if (command.task.committedSessionId) {
        const owner = await this.db.get<{ task_id: string }>(
          `SELECT task_id FROM session_owners
            WHERE workspace_id = ? AND backend = ? AND session_id = ?`,
          [this.workspaceId, command.task.backend, command.task.committedSessionId],
        );
        if (owner && owner.task_id !== command.task.id) {
          return {
            ok: true,
            changed: false,
            reason: 'backend session is already owned by another task',
            conflict: true,
          };
        }
      }
      throw error;
    }
    return {
      ok: true,
      changed: (results[0]?.changes ?? 0) > 0,
      ...((results[0]?.changes ?? 0) === 0 ? { reason: 'turn is no longer live' } : {}),
    };
  }

  private async validateSettlementDispositionClaim(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<RepositoryCommandResult | undefined> {
    const row = await this.db.get<{
      task_id: string;
      runtime_epoch: number;
      family: DurableDispositionClaim['family'];
      kind: DurableDispositionClaim['kind'];
      fingerprint: string;
      payload_json: string;
      status: 'staged' | 'consumed' | 'discarded';
    }>(
      `SELECT task_id, runtime_epoch, family, kind, fingerprint, payload_json, status
         FROM turn_disposition_claims
        WHERE workspace_id = ? AND turn_id = ?`,
      [this.workspaceId, command.turn.id],
    );
    const disposition = command.turn.disposition;
    if (!disposition) {
      if (command.turn.status === 'succeeded' && row?.status === 'staged') {
        return {
          ok: true,
          changed: false,
          conflict: true,
          reason: 'successful settlement is missing its staged disposition',
        };
      }
      return undefined;
    }
    const expected = durableDispositionClaim({
      turnId: command.turn.id,
      taskId: command.turn.taskId,
      runtimeEpoch: command.turn.runtimeEpoch,
      opId: '',
      disposition,
    });
    if (!row) {
      return {
        ok: true,
        changed: false,
        conflict: true,
        reason: 'settlement requires a durable staged disposition',
      };
    }
    const matches = row.task_id === expected.taskId
      && row.runtime_epoch === expected.runtimeEpoch
      && row.family === expected.family
      && row.kind === expected.kind
      && row.fingerprint === expected.fingerprint
      && row.payload_json === expected.payloadJson;
    if (!matches) {
      return {
        ok: true,
        changed: false,
        conflict: true,
        reason: 'settlement disposition does not match the durable claim',
      };
    }
    if (row.status !== 'staged') {
      return { ok: true, changed: false, reason: `disposition claim is already ${row.status}` };
    }
    return undefined;
  }

  /**
   * M018 S02 / §20.5–20.6: when a producer turn settles with staged workflow_next,
   * commit artifact + gate contribution in the same transaction. Partial fills
   * persist only; the final fill atomically closes the gate and queues one
   * deterministic aggregate activation turn. Never seals producer lifecycle.
   */
  // M018 S04: planWorkflowPrevRequest / planWorkflowFeedbackResponse run on this settle path
  // before planWorkflowNextContribution so feedback responses never take the forward path.
  private async planWorkflowNextContribution(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<WorkflowEffectPlan> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const disposition = command.turn.disposition;
    if (
      !disposition ||
      disposition.kind !== 'workflow_next' ||
      disposition.route !== undefined ||
      command.turn.status !== 'succeeded'
    ) {
      return empty;
    }

    const producerNode = await this.db.get<{ run_id: string; node_id: string }>(
      `SELECT run_id, node_id FROM workflow_nodes
        WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, command.task.id],
    );
    if (!producerNode || typeof producerNode.run_id !== 'string' || typeof producerNode.node_id !== 'string') {
      return empty;
    }

    const run = await this.db.get<{
      run_id: string;
      definition_id: string;
      definition_version: number;
      status: string;
    }>(
      `SELECT run_id, definition_id, definition_version, status FROM workflow_runs
        WHERE workspace_id = ? AND run_id = ?`,
      [this.workspaceId, producerNode.run_id],
    );
    if (!run || run.status !== 'running' || typeof run.definition_id !== 'string') {
      return empty;
    }

    const defRow = await this.db.get<{ topology_json: string }>(
      `SELECT topology_json FROM workflow_definitions
        WHERE workspace_id = ? AND definition_id = ? AND version = ?`,
      [this.workspaceId, run.definition_id, run.definition_version],
    );
    if (!defRow || typeof defRow.topology_json !== 'string') {
      return empty;
    }
    const topologyDecoded = decodeStoredTopologyJson(defRow.topology_json);
    if (!topologyDecoded.ok) {
      return empty;
    }
    const topology = topologyDecoded.topology;
    if (
      topology.kind === 'one_node_v1' &&
      topology.nodes[0]?.nodeId !== producerNode.node_id
    ) {
      return empty;
    }
    if (disposition.change === 'unchanged') {
      return this.planWorkflowFailClosure({
        runId: producerNode.run_id,
        reasonCode: 'invalid_route',
        reasonText: 'unchanged requires an exact feedback base artifact',
        at: command.turn.finishedAt ?? new Date().toISOString(),
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }
    const edge = topology.kind === 'graph_v1'
      ? outgoingEdge(topology, producerNode.node_id)
      : undefined;
    if (!edge) {
      const artifactId = deriveProducerArtifactId(producerNode.run_id, producerNode.node_id);
      const revision = 1;
      const finishedAt = command.turn.finishedAt ?? new Date().toISOString();
      const resultBody = typeof disposition.result === 'string' ? disposition.result : undefined;
      const fenceId = stableId('wfc', `${producerNode.run_id}\0terminal_next\0${command.turn.id}`);
      return {
        statements: [
          {
            sql: `UPDATE workflow_dependency_gates
                     SET status = 'consumed'
                   WHERE workspace_id = ? AND run_id = ?
                     AND consumer_node_id = ? AND status = 'satisfied'`,
            params: [this.workspaceId, producerNode.run_id, producerNode.node_id],
          },
          {
            sql: `INSERT INTO workflow_routed_messages (
                    workspace_id, run_id, message_id, source_node_id, destination_node_id,
                    kind, body_json, created_at
                  ) VALUES (?,?,?,?,?,?,?,?)
                  ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
            params: [
              this.workspaceId,
              producerNode.run_id,
              fenceId,
              producerNode.node_id,
              'engine',
              'terminal_next',
              encodePayload({ kind: 'terminal_next', sourceTurnId: command.turn.id, change: disposition.change }),
              finishedAt,
            ],
          },
          {
            sql: `INSERT INTO workflow_artifacts (
                    workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                    revision, kind, payload_json, created_at
                  ) VALUES (?,?,?,?,?,?,?,?,?)
                  ON CONFLICT DO NOTHING`,
            params: [
              this.workspaceId,
              producerNode.run_id,
              artifactId,
              producerNode.node_id,
              'next_result',
              revision,
              'next_result',
              encodePayload({ kind: 'next_result', schema: 1, change: disposition.change, producerNodeId: producerNode.node_id, sourceTurnId: command.turn.id, ...(resultBody !== undefined ? { result: resultBody } : {}) }),
              finishedAt,
            ],
          },
          workflowNodeArtifactSourceStatement({
            workspaceId: this.workspaceId,
            runId: producerNode.run_id,
            artifactId,
            artifactRevision: revision,
            nodeId: producerNode.node_id,
            taskId: command.task.id,
            turnId: command.turn.id,
          }),
          {
            sql: `UPDATE workflow_runs SET status = 'succeeded', updated_at = ?
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'`,
            params: [finishedAt, this.workspaceId, producerNode.run_id],
          },
        ],
        changes: [{ kind: 'task', id: command.task.id, change: 'effect' }],
      };
    }
    if (topology.kind !== 'graph_v1') return empty;

    const gate = await this.db.get<{ gate_id: string; status: string }>(
      `SELECT gate_id, status FROM workflow_dependency_gates
        WHERE workspace_id = ? AND run_id = ? AND consumer_node_id = ?`,
      [this.workspaceId, producerNode.run_id, edge.toNodeId],
    );
    if (!gate || typeof gate.gate_id !== 'string') {
      return empty;
    }

    const artifactId = deriveProducerArtifactId(producerNode.run_id, producerNode.node_id);
    // D050 / R027: contribution-scoped revision is deterministic (not priorMax+1).
    const revision = deriveProducerArtifactRevision(disposition.change);
    const contributionMessageId = deriveNextContributionMessageId(
      producerNode.run_id,
      gate.gate_id,
      edge.inputRef,
      producerNode.node_id,
    );
    // Durable workflow-run-scoped fence: redelivery after turn-ledger prune is a no-op.
    const existingRouted = await this.db.get<{ message_id: string }>(
      `SELECT message_id FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [this.workspaceId, producerNode.run_id, contributionMessageId],
    );
    if (existingRouted) {
      return empty;
    }
    const gateProgress = await this.db.get<{
      required: number;
      filled: number;
      current_filled: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM workflow_gate_bindings
           WHERE workspace_id = ? AND run_id = ? AND gate_id = ?) AS required,
         (SELECT COUNT(*) FROM workflow_gate_fills
           WHERE workspace_id = ? AND run_id = ? AND gate_id = ?) AS filled,
         (SELECT COUNT(*) FROM workflow_gate_fills
           WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND input_ref = ?) AS current_filled`,
      [
        this.workspaceId, producerNode.run_id, gate.gate_id,
        this.workspaceId, producerNode.run_id, gate.gate_id,
        this.workspaceId, producerNode.run_id, gate.gate_id, edge.inputRef,
      ],
    );
    const willSatisfyGate = gate.status === 'open'
      && Number(gateProgress?.current_filled) === 0
      && Number(gateProgress?.filled) + 1 >= Number(gateProgress?.required);
    const finishedAt = command.turn.finishedAt ?? new Date().toISOString();

    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];
    statements.push({
      sql: `UPDATE workflow_dependency_gates
               SET status = 'consumed'
             WHERE workspace_id = ? AND run_id = ?
               AND consumer_node_id = ? AND status = 'satisfied'`,
      params: [this.workspaceId, producerNode.run_id, producerNode.node_id],
    });

    // Fence row first in the statement list so a partial apply cannot leave fills
    // without the durable contribution identity (same transaction either way).
    const routedBody = encodePayload({
      kind: 'next_contribution',
      schema: 1,
      gateId: gate.gate_id,
      inputRef: edge.inputRef,
      producerNodeId: producerNode.node_id,
      consumerNodeId: edge.toNodeId,
      artifactId,
      artifactRevision: revision,
      change: disposition.change,
      // Identities only — never prompt/result bodies, paths, SQL, or credentials.
      sourceTurnId: command.turn.id,
    });
    statements.push({
      sql: `INSERT INTO workflow_routed_messages (
              workspace_id, run_id, message_id, source_node_id, destination_node_id,
              kind, body_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
      params: [
        this.workspaceId,
        producerNode.run_id,
        contributionMessageId,
        producerNode.node_id,
        edge.toNodeId,
        'next_contribution',
        routedBody,
        finishedAt,
      ],
    });

      const resultBody = typeof disposition.result === 'string' ? disposition.result : undefined;
    const artifactPayload = encodePayload({
      kind: 'next_result',
      schema: 1,
      change: disposition.change,
      producerNodeId: producerNode.node_id,
      sourceTurnId: command.turn.id,
      ...(resultBody !== undefined ? { result: resultBody } : {}),
    });
    statements.push({
      sql: `INSERT INTO workflow_artifacts (
              workspace_id, run_id, artifact_id, producer_node_id, logical_name,
              revision, kind, payload_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT DO NOTHING`,
      params: [
        this.workspaceId,
        producerNode.run_id,
        artifactId,
        producerNode.node_id,
        'next_result',
        revision,
        'next_result',
        artifactPayload,
        finishedAt,
      ],
    });
    statements.push(workflowNodeArtifactSourceStatement({
      workspaceId: this.workspaceId,
      runId: producerNode.run_id,
      artifactId,
      artifactRevision: revision,
      nodeId: producerNode.node_id,
      taskId: command.task.id,
      turnId: command.turn.id,
    }));

    statements.push({
      sql: `INSERT INTO workflow_gate_fills (
              workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at
            ) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, gate_id, input_ref)
            DO NOTHING`,
      params: [
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        edge.inputRef,
        artifactId,
        revision,
        finishedAt,
      ],
    });

    const aggregateClosureId = deriveRunClosureFenceId(producerNode.run_id, 'failed');
    statements.push({
      sql: `UPDATE workflow_runs
               SET terminal_reason_code = 'aggregate_too_large', closure_id = ?, updated_at = ?
             WHERE workspace_id = ? AND run_id = ? AND status = 'running'
               AND terminal_reason_code IS NULL
               AND EXISTS (
                 SELECT 1
                   FROM workflow_dependency_gates overflow_gate
                  WHERE overflow_gate.workspace_id = workflow_runs.workspace_id
                    AND overflow_gate.run_id = workflow_runs.run_id
                    AND overflow_gate.gate_id = ?
                    AND overflow_gate.status = 'open'
                    AND (
                      SELECT COUNT(DISTINCT input_ref) FROM workflow_gate_fills
                       WHERE workspace_id = overflow_gate.workspace_id
                         AND run_id = overflow_gate.run_id
                         AND gate_id = overflow_gate.gate_id
                    ) >= (
                      SELECT COUNT(*) FROM workflow_gate_bindings
                       WHERE workspace_id = overflow_gate.workspace_id
                         AND run_id = overflow_gate.run_id
                         AND gate_id = overflow_gate.gate_id
                    )
                    AND length(CAST(
                      '[workflow-aggregate] ' || COALESCE((
                        SELECT group_concat(ordered.value, ' ')
                          FROM (
                            SELECT binding.input_ref || '=' ||
                                   COALESCE(
                                     json_extract(artifact.payload_json, '$.result'),
                                     '[artifact ' || fill.artifact_id || '@' || fill.artifact_revision || ']'
                                   ) AS value
                              FROM workflow_gate_bindings binding
                              JOIN workflow_gate_fills fill
                                ON fill.workspace_id = binding.workspace_id
                               AND fill.run_id = binding.run_id
                               AND fill.gate_id = binding.gate_id
                               AND fill.input_ref = binding.input_ref
                              JOIN workflow_artifacts artifact
                                ON artifact.workspace_id = fill.workspace_id
                               AND artifact.run_id = fill.run_id
                               AND artifact.artifact_id = fill.artifact_id
                               AND artifact.revision = fill.artifact_revision
                              JOIN workflow_runs aggregate_run
                                ON aggregate_run.workspace_id = binding.workspace_id
                               AND aggregate_run.run_id = binding.run_id
                              LEFT JOIN workflow_definition_edges definition_edge
                                ON definition_edge.workspace_id = aggregate_run.workspace_id
                               AND definition_edge.definition_id = aggregate_run.definition_id
                               AND definition_edge.definition_version = aggregate_run.definition_version
                               AND definition_edge.source_node_id = binding.producer_node_id
                               AND definition_edge.destination_node_id = overflow_gate.consumer_node_id
                               AND definition_edge.destination_input_ref = binding.input_ref
                             WHERE binding.workspace_id = overflow_gate.workspace_id
                               AND binding.run_id = overflow_gate.run_id
                               AND binding.gate_id = overflow_gate.gate_id
                             ORDER BY COALESCE(definition_edge.ordinal, 2147483647), binding.input_ref
                          ) ordered
                      ), '') AS BLOB
                    )) > workflow_runs.max_aggregate_bytes
               )`,
      params: [aggregateClosureId, finishedAt, this.workspaceId, producerNode.run_id, gate.gate_id],
    });

    // Atomic open→satisfied only when all required inputRefs are filled (incl. this fill).
    statements.push({
      sql: `UPDATE workflow_dependency_gates
               SET status = 'satisfied'
             WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'open'
               AND (
                 SELECT COUNT(DISTINCT input_ref) FROM workflow_gate_fills
                  WHERE workspace_id = ? AND run_id = ? AND gate_id = ?
                ) >= (
                  SELECT COUNT(*) FROM workflow_gate_bindings
                   WHERE workspace_id = ? AND run_id = ? AND gate_id = ?
               )
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code IS NULL
                )`,
      params: [
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        producerNode.run_id,
      ],
    });
    statements.push(...workflowAggregateOverflowClosureStatements({
      workspaceId: this.workspaceId,
      runId: producerNode.run_id,
      closureId: aggregateClosureId,
      at: finishedAt,
    }));

    if (!willSatisfyGate) return { statements, changes };

    const activation = deriveNodeActivationIdentities(producerNode.run_id, edge.toNodeId);
    const consumerSpec = topology.nodes.find((n) => n.nodeId === edge.toNodeId);
    const consumerRole = consumerSpec?.role ?? 'worker';
    const taskPayloadJson = encodePayload({
      capabilities: [],
      executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
      releasedAt: finishedAt,
    });
    const turnPayloadJson = encodePayload({});
    const messagePayloadJson = encodePayload({});

    // Conditional activation: only when gate is satisfied; reserved ids make redelivery no-op.
    statements.push({
      sql: `INSERT INTO tasks (
              id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
              revision, created_at, updated_at, payload_json
            )
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_dependency_gates
                WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM tasks WHERE workspace_id = ? AND id = ?
             )`,
      params: [
        activation.taskId,
        this.workspaceId,
        null,
        consumerRole,
        'open',
        'released',
        command.task.goal,
        command.task.backend,
        null,
        0,
        finishedAt,
        finishedAt,
        taskPayloadJson,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        activation.taskId,
      ],
    });
    statements.push({
      sql: `UPDATE workflow_nodes
               SET task_id = ?, status = 'active'
             WHERE workspace_id = ? AND run_id = ? AND node_id = ?
               AND EXISTS (
                 SELECT 1 FROM workflow_dependency_gates
                  WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'satisfied'
               )
               AND (task_id IS NULL OR task_id = ?)`,
      params: [
        activation.taskId,
        this.workspaceId,
        producerNode.run_id,
        edge.toNodeId,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        activation.taskId,
      ],
    });
    statements.push({
      sql: `INSERT INTO turns (
              id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json
            )
            SELECT ?,?,?,?,?,?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_dependency_gates
                WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM turns WHERE workspace_id = ? AND id = ?
             )`,
      params: [
        activation.activationTurnId,
        this.workspaceId,
        activation.taskId,
        1,
        'queued',
        'engine',
        finishedAt,
        null,
        null,
        turnPayloadJson,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        activation.activationTurnId,
      ],
    });
    statements.push({
      sql: `INSERT INTO messages (
              id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json
            )
            SELECT ?,?,?,?,?,?,?,
                   '[workflow-aggregate] ' || COALESCE((
                     SELECT group_concat(ordered.value, ' ')
                       FROM (
                         SELECT binding.input_ref || '=' ||
                                COALESCE(
                                  json_extract(artifact.payload_json, '$.result'),
                                  '[artifact ' || fill.artifact_id || '@' || fill.artifact_revision || ']'
                                ) AS value
                           FROM workflow_gate_bindings binding
                           JOIN workflow_gate_fills fill
                             ON fill.workspace_id = binding.workspace_id
                            AND fill.run_id = binding.run_id
                            AND fill.gate_id = binding.gate_id
                            AND fill.input_ref = binding.input_ref
                           JOIN workflow_artifacts artifact
                             ON artifact.workspace_id = fill.workspace_id
                            AND artifact.run_id = fill.run_id
                            AND artifact.artifact_id = fill.artifact_id
                            AND artifact.revision = fill.artifact_revision
                           JOIN workflow_dependency_gates accumulator
                             ON accumulator.workspace_id = binding.workspace_id
                            AND accumulator.run_id = binding.run_id
                            AND accumulator.gate_id = binding.gate_id
                           JOIN workflow_runs aggregate_run
                             ON aggregate_run.workspace_id = binding.workspace_id
                            AND aggregate_run.run_id = binding.run_id
                           LEFT JOIN workflow_definition_edges definition_edge
                             ON definition_edge.workspace_id = aggregate_run.workspace_id
                            AND definition_edge.definition_id = aggregate_run.definition_id
                            AND definition_edge.definition_version = aggregate_run.definition_version
                            AND definition_edge.source_node_id = binding.producer_node_id
                            AND definition_edge.destination_node_id = accumulator.consumer_node_id
                            AND definition_edge.destination_input_ref = binding.input_ref
                          WHERE binding.workspace_id = ?
                            AND binding.run_id = ?
                            AND binding.gate_id = ?
                          ORDER BY COALESCE(definition_edge.ordinal, 2147483647), binding.input_ref
                       ) ordered
                   ), ''),
                   ?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_dependency_gates
                WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM messages WHERE workspace_id = ? AND id = ?
             )`,
      params: [
        activation.messageId,
        this.workspaceId,
        activation.taskId,
        activation.activationTurnId,
        'system',
        'assigned',
        null,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        finishedAt,
        null,
        messagePayloadJson,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        activation.messageId,
      ],
    });
    statements.push({
      sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
            SELECT ?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_dependency_gates
                WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM turn_inputs WHERE workspace_id = ? AND turn_id = ? AND ordering = 0
             )`,
      params: [
        this.workspaceId,
        activation.activationTurnId,
        0,
        'message',
        encodePayload({ kind: 'message', messageId: activation.messageId }),
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
        this.workspaceId,
        activation.activationTurnId,
      ],
    });
    statements.push({
      sql: `INSERT INTO workflow_activations (
              workspace_id, run_id, activation_id, node_id, kind, status,
              source_gate_id, feedback_round_id, feedback_target_node_id,
              continuation_id, return_gate_id, inherited_feedback_round_id,
              inherited_feedback_target_node_id, primary_turn_id, message_id,
              execution_turn_id, created_at, updated_at
            )
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_dependency_gates
                WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND status = 'satisfied'
             )
            ON CONFLICT(workspace_id, run_id, activation_id) DO NOTHING`,
      params: [
        this.workspaceId,
        producerNode.run_id,
        stableId('wfact', `${producerNode.run_id}\0dependency_gate\0${gate.gate_id}`),
        edge.toNodeId,
        'dependency_gate',
        'queued',
        gate.gate_id,
        null,
        null,
        null,
        null,
        null,
        null,
        activation.activationTurnId,
        activation.messageId,
        activation.activationTurnId,
        finishedAt,
        finishedAt,
        this.workspaceId,
        producerNode.run_id,
        gate.gate_id,
      ],
    });
    changes.push(
      { kind: 'task', id: activation.taskId, change: 'effect' },
      { kind: 'turn', id: activation.activationTurnId, taskId: activation.taskId, change: 'effect' },
      { kind: 'message', id: activation.messageId, taskId: activation.taskId, change: 'complete' },
    );

    return {
      statements,
      changes,
      turnReservations: [{ runId: producerNode.run_id, taskId: activation.taskId, count: 1 }],
    };
  }


  /**
   * M018 S04 / §20.7–20.8: when a consumer turn settles with staged workflow_prev,
   * resolve targets from the requester gate's frozen bindings, open one ALL-join
   * feedback round, append one deterministic feedback turn to each target FIFO,
   * and write durable feedback_request fences. Invalid/empty targets open nothing.
   * Never seals requester lifecycle.
   */
  private async planWorkflowPrevRequest(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<WorkflowEffectPlan> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const disposition = command.turn.disposition;
    if (
      !disposition ||
      disposition.kind !== 'workflow_prev' ||
      command.turn.status !== 'succeeded'
    ) {
      return empty;
    }

    const requesterNode = await this.db.get<{ run_id: string; node_id: string }>(
      `SELECT run_id, node_id FROM workflow_nodes
        WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, command.task.id],
    );
    if (!requesterNode || typeof requesterNode.run_id !== 'string' || typeof requesterNode.node_id !== 'string') {
      return empty;
    }

    const run = await this.db.get<{
      run_id: string;
      definition_id: string;
      definition_version: number;
      status: string;
    }>(
      `SELECT run_id, definition_id, definition_version, status FROM workflow_runs
        WHERE workspace_id = ? AND run_id = ?`,
      [this.workspaceId, requesterNode.run_id],
    );
    if (!run || run.status !== 'running' || typeof run.definition_id !== 'string') {
      return empty;
    }

    const defRow = await this.db.get<{ topology_json: string }>(
      `SELECT topology_json FROM workflow_definitions
        WHERE workspace_id = ? AND definition_id = ? AND version = ?`,
      [this.workspaceId, run.definition_id, run.definition_version],
    );
    if (!defRow || typeof defRow.topology_json !== 'string') {
      return empty;
    }
    const topologyDecoded = decodeStoredTopologyJson(defRow.topology_json);
    if (!topologyDecoded.ok) {
      return empty;
    }
    // M018 S05: non-graph topologies have no direct PREV producers — fail the run
    // (not silent empty). graph_v1 continues into gate/binding resolution below.
    if (topologyDecoded.topology.kind !== 'graph_v1') {
      return this.planWorkflowFailClosure({
        runId: requesterNode.run_id,
        reasonCode: 'invalid_route',
        at: command.turn.finishedAt ?? new Date().toISOString(),
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }
    const topology = topologyDecoded.topology;

    const gate = await this.db.get<{ gate_id: string; status: string }>(
      `SELECT gate_id, status FROM workflow_dependency_gates
        WHERE workspace_id = ? AND run_id = ? AND consumer_node_id = ?
          AND EXISTS (
            SELECT 1 FROM workflow_gate_bindings binding
             WHERE binding.workspace_id = workflow_dependency_gates.workspace_id
               AND binding.run_id = workflow_dependency_gates.run_id
               AND binding.gate_id = workflow_dependency_gates.gate_id
               AND binding.producer_node_id IS NOT NULL
          )
        ORDER BY gate_id
        LIMIT 1`,
      [this.workspaceId, requesterNode.run_id, requesterNode.node_id],
    );
    if (!gate || typeof gate.gate_id !== 'string') {
      // M018 S05: PREV with no requester gate is an invalid route.
      return this.planWorkflowFailClosure({
        runId: requesterNode.run_id,
        reasonCode: 'invalid_route',
        at: command.turn.finishedAt ?? new Date().toISOString(),
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }

    const bindings = await this.db.all<{
      input_ref: string;
      producer_node_id: string;
      required_kind: string;
    }>(
      `SELECT input_ref, producer_node_id, required_kind FROM workflow_gate_bindings
        WHERE workspace_id = ? AND run_id = ? AND gate_id = ?
        ORDER BY input_ref`,
      [this.workspaceId, requesterNode.run_id, gate.gate_id],
    );
    // Direct producers only — exclude engine_start entry bindings.
    const producerByInputRef = new Map<string, string>();
    for (const binding of bindings) {
      if (binding.required_kind === 'engine_start' || binding.input_ref === 'engine_start') continue;
      producerByInputRef.set(binding.input_ref, binding.producer_node_id);
    }
    if (producerByInputRef.size === 0) {
      // M018 S05: entry PREV with no direct producer route fails the run (not silent empty).
      return this.planWorkflowFailClosure({
        runId: requesterNode.run_id,
        reasonCode: 'invalid_route',
        at: command.turn.finishedAt ?? new Date().toISOString(),
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }

    let resolvedTargets: Array<{ nodeId: string; inputRef: string }> = [];
    if (disposition.targets === 'all') {
      // Frozen dependency declaration order (definition edge order), not binding lexical order.
      const orderedRefs = consumerInputRefsInDefinitionOrder(topology, requesterNode.node_id);
      const seen = new Set<string>();
      for (const ref of orderedRefs) {
        const producer = producerByInputRef.get(ref);
        if (!producer || seen.has(producer)) continue;
        seen.add(producer);
        resolvedTargets.push({ nodeId: producer, inputRef: ref });
      }
      // Any binding producer not present in definition edges still participates (stable fallback).
      for (const [inputRef, producer] of producerByInputRef) {
        if (!seen.has(producer)) {
          seen.add(producer);
          resolvedTargets.push({ nodeId: producer, inputRef });
        }
      }
    } else {
      const seen = new Set<string>();
      for (const inputRef of disposition.targets) {
        const producer = producerByInputRef.get(inputRef);
        if (!producer) {
          // M018 S05: unknown/foreign inputRef fails the run (not silent empty).
          return this.planWorkflowFailClosure({
            runId: requesterNode.run_id,
            reasonCode: 'invalid_route',
            at: command.turn.finishedAt ?? new Date().toISOString(),
            sourceTaskId: command.task.id,
            sourceTurnId: command.turn.id,
          });
        }
        if (!seen.has(producer)) {
          seen.add(producer);
          resolvedTargets.push({ nodeId: producer, inputRef });
        }
      }
      if (resolvedTargets.length === 0) {
        // M018 S05: empty targeted PREV set fails the run (not silent empty).
        return this.planWorkflowFailClosure({
          runId: requesterNode.run_id,
          reasonCode: 'invalid_route',
          at: command.turn.finishedAt ?? new Date().toISOString(),
          sourceTaskId: command.task.id,
          sourceTurnId: command.turn.id,
        });
      }
    }

    // Target task must already exist (activated producer); skip missing nodes fail-closed.
    const targetRows: Array<{ nodeId: string; inputRef: string; taskId: string }> = [];
    for (const target of resolvedTargets) {
      const row = await this.db.get<{ task_id: string | null }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
        [this.workspaceId, requesterNode.run_id, target.nodeId],
      );
      if (!row || typeof row.task_id !== 'string' || row.task_id.length === 0) {
        // M018 S05: required PREV target not activated → fail closure.
        return this.planWorkflowFailClosure({
          runId: requesterNode.run_id,
          reasonCode: 'invalid_route',
          at: command.turn.finishedAt ?? new Date().toISOString(),
          sourceTaskId: command.task.id,
          sourceTurnId: command.turn.id,
        });
      }
      targetRows.push({ ...target, taskId: row.task_id });
    }

    const roundId = deriveFeedbackRoundId(
      requesterNode.run_id,
      requesterNode.node_id,
      command.turn.id,
    );

    // Round-level redelivery fence: first feedback_request message id is enough to
    // detect that this requester turn already opened the round.
    const firstRequestId = deriveFeedbackRequestMessageId(
      requesterNode.run_id,
      roundId,
      targetRows[0]!.nodeId,
    );
    const existingRoundFence = await this.db.get<{ message_id: string }>(
      `SELECT message_id FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [this.workspaceId, requesterNode.run_id, firstRequestId],
    );
    if (existingRoundFence) {
      return empty;
    }

    const requesterActivation = await this.db.get<{
      activation_id: string;
      kind: string;
      feedback_round_id: string | null;
      feedback_target_node_id: string | null;
      inherited_feedback_round_id: string | null;
      inherited_feedback_target_node_id: string | null;
    }>(
      `SELECT activation_id, kind, feedback_round_id, feedback_target_node_id,
              inherited_feedback_round_id, inherited_feedback_target_node_id
         FROM workflow_activations
        WHERE workspace_id = ? AND run_id = ? AND node_id = ?
          AND execution_turn_id = ? AND status IN ('queued', 'running')`,
      [this.workspaceId, requesterNode.run_id, requesterNode.node_id, command.turn.id],
    );
    if (!requesterActivation) {
      return this.planWorkflowFailClosure({
        runId: requesterNode.run_id,
        reasonCode: 'invalid_route',
        at: command.turn.finishedAt ?? new Date().toISOString(),
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }

    let inheritedRoundId: string | null = null;
    let inheritedTargetId: string | null = null;
    if (
      requesterActivation.kind === 'feedback_request' &&
      requesterActivation.feedback_round_id &&
      requesterActivation.feedback_target_node_id
    ) {
      const target = await this.db.get<{ target_id: string | null }>(
        `SELECT target_id FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
            AND target_node_id = ? AND request_activation_id = ? AND status = 'pending'`,
        [
          this.workspaceId,
          requesterNode.run_id,
          requesterActivation.feedback_round_id,
          requesterActivation.feedback_target_node_id,
          requesterActivation.activation_id,
        ],
      );
      if (!target?.target_id) {
        return this.planWorkflowFailClosure({
          runId: requesterNode.run_id,
          reasonCode: 'invalid_route',
          at: command.turn.finishedAt ?? new Date().toISOString(),
          sourceTaskId: command.task.id,
          sourceTurnId: command.turn.id,
        });
      }
      inheritedRoundId = requesterActivation.feedback_round_id;
      inheritedTargetId = target.target_id;
    } else if (
      requesterActivation.kind === 'feedback_resume' &&
      requesterActivation.inherited_feedback_round_id &&
      requesterActivation.inherited_feedback_target_node_id
    ) {
      const target = await this.db.get<{ target_id: string | null }>(
        `SELECT target_id FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
            AND target_node_id = ? AND status = 'pending'`,
        [
          this.workspaceId,
          requesterNode.run_id,
          requesterActivation.inherited_feedback_round_id,
          requesterActivation.inherited_feedback_target_node_id,
        ],
      );
      if (!target?.target_id) {
        return this.planWorkflowFailClosure({
          runId: requesterNode.run_id,
          reasonCode: 'invalid_route',
          at: command.turn.finishedAt ?? new Date().toISOString(),
          sourceTaskId: command.task.id,
          sourceTurnId: command.turn.id,
        });
      }
      inheritedRoundId = requesterActivation.inherited_feedback_round_id;
      inheritedTargetId = target.target_id;
    }

    const openRound = await this.db.get<{ round_id: string }>(
      `SELECT round_id FROM workflow_feedback_rounds
        WHERE workspace_id = ? AND run_id = ? AND requester_node_id = ?
          AND status IN ('open', 'satisfied')
          AND NOT (status = 'satisfied' AND resume_turn_id = ?)
        LIMIT 1`,
      [this.workspaceId, requesterNode.run_id, requesterNode.node_id, command.turn.id],
    );
    if (openRound) return empty;

    const finishedAt = command.turn.finishedAt ?? new Date().toISOString();
    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];
    const turnPayloadJson = encodePayload({});
    const messagePayloadJson = encodePayload({});
    const resumeTurnId = deriveFeedbackResumeTurnId(requesterNode.run_id, roundId);
    const resumeActivationId = deriveFeedbackResumeActivationId(requesterNode.run_id, roundId);

    statements.push({
      sql: `INSERT INTO workflow_feedback_rounds (
              workspace_id, run_id, round_id, requester_node_id, requester_task_id,
              requester_turn_id, requester_activation_id, inherited_round_id,
              inherited_target_id, resume_activation_id, resume_turn_id,
              status, join_mode, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, round_id) DO NOTHING`,
      params: [
        this.workspaceId,
        requesterNode.run_id,
        roundId,
        requesterNode.node_id,
        command.task.id,
        command.turn.id,
        requesterActivation.activation_id,
        inheritedRoundId,
        inheritedTargetId,
        resumeActivationId,
        resumeTurnId,
        'open',
        'all',
        finishedAt,
        finishedAt,
      ],
    });

    for (const target of targetRows) {
      const targetId = deriveFeedbackTargetId(requesterNode.run_id, roundId, target.nodeId);
      const requestActivationId = deriveFeedbackRequestActivationId(
        requesterNode.run_id,
        roundId,
        target.nodeId,
      );
      const requestMessageId = deriveFeedbackRequestMessageId(
        requesterNode.run_id,
        roundId,
        target.nodeId,
      );
      const feedbackTurnId = deriveFeedbackTargetTurnId(
        requesterNode.run_id,
        roundId,
        target.nodeId,
      );
      const feedbackMessageId = deriveFeedbackTargetMessageId(
        requesterNode.run_id,
        roundId,
        target.nodeId,
      );
      const baseArtifactId = deriveProducerArtifactId(requesterNode.run_id, target.nodeId);
      const baseArtifact = await this.db.get<{ revision: number }>(
        `SELECT MAX(revision) AS revision FROM workflow_artifacts
           WHERE workspace_id = ? AND run_id = ? AND artifact_id = ?`,
        [this.workspaceId, requesterNode.run_id, baseArtifactId],
      );
      const baseArtifactRevision = baseArtifact?.revision ?? 1;

      // Pre-read max sequence so FIFO append is deterministic and never preemptive.
      const maxSeqRow = await this.db.get<{ max_seq: number | null }>(
        `SELECT MAX(sequence) AS max_seq FROM turns WHERE workspace_id = ? AND task_id = ?`,
        [this.workspaceId, target.taskId],
      );
      const nextSequence = (maxSeqRow?.max_seq ?? 0) + 1;

      const routedBody = encodePayload({
        kind: 'feedback_request',
        schema: 1,
        roundId,
        requesterNodeId: requesterNode.node_id,
        targetNodeId: target.nodeId,
        feedbackTurnId,
        feedbackMessageId,
        baseArtifactId,
        baseArtifactRevision,
        // Identities only — never note/prompt/result bodies, paths, SQL, or credentials.
        sourceTurnId: command.turn.id,
      });

      statements.push({
        sql: `INSERT INTO workflow_routed_messages (
                workspace_id, run_id, message_id, source_node_id, source_task_id,
                source_turn_id, destination_node_id, destination_task_id,
                feedback_round_id, feedback_target_id, kind, body_json, created_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
        params: [
          this.workspaceId,
          requesterNode.run_id,
          requestMessageId,
          requesterNode.node_id,
          command.task.id,
          command.turn.id,
          target.nodeId,
          target.taskId,
          roundId,
          targetId,
          'feedback_request',
          routedBody,
          finishedAt,
        ],
      });

      statements.push({
        sql: `INSERT INTO workflow_feedback_targets (
                workspace_id, run_id, round_id, target_node_id, target_id, input_ref,
                target_task_id, base_artifact_run_id, base_artifact_id,
                base_artifact_revision, request_activation_id, request_turn_id,
                request_message_id, status
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, round_id, target_node_id) DO NOTHING`,
        params: [
          this.workspaceId,
          requesterNode.run_id,
          roundId,
          target.nodeId,
          targetId,
          target.inputRef,
          target.taskId,
          requesterNode.run_id,
          baseArtifactId,
          baseArtifactRevision,
          requestActivationId,
          feedbackTurnId,
          feedbackMessageId,
          'pending',
        ],
      });

      const feedbackContent = `[workflow-feedback-request] round=${roundId} target=${target.nodeId}${disposition.note ? `\n[feedback]\n${disposition.note.slice(0, 4000)}` : ''}`;
      statements.push({
        sql: `INSERT INTO turns (
                id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json
              )
              SELECT ?,?,?,?,?,?,?,?,?,?
               WHERE NOT EXISTS (
                 SELECT 1 FROM turns WHERE workspace_id = ? AND id = ?
               )`,
        params: [
          feedbackTurnId,
          this.workspaceId,
          target.taskId,
          nextSequence,
          'queued',
          'engine',
          finishedAt,
          null,
          null,
          turnPayloadJson,
          this.workspaceId,
          feedbackTurnId,
        ],
      });
      statements.push({
        sql: `INSERT INTO messages (
                id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json
              )
              SELECT ?,?,?,?,?,?,?,?,?,?,?
               WHERE NOT EXISTS (
                 SELECT 1 FROM messages WHERE workspace_id = ? AND id = ?
               )`,
        params: [
          feedbackMessageId,
          this.workspaceId,
          target.taskId,
          feedbackTurnId,
          'system',
          'assigned',
          null,
          feedbackContent,
          finishedAt,
          null,
          messagePayloadJson,
          this.workspaceId,
          feedbackMessageId,
        ],
      });
      statements.push({
        sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
              SELECT ?,?,?,?,?
               WHERE NOT EXISTS (
                 SELECT 1 FROM turn_inputs WHERE workspace_id = ? AND turn_id = ? AND ordering = 0
               )`,
        params: [
          this.workspaceId,
          feedbackTurnId,
          0,
          'message',
          encodePayload({ kind: 'message', messageId: feedbackMessageId }),
          this.workspaceId,
          feedbackTurnId,
        ],
      });
      statements.push({
        sql: `INSERT INTO workflow_activations (
                workspace_id, run_id, activation_id, node_id, kind, status,
                source_gate_id, feedback_round_id, feedback_target_node_id,
                continuation_id, return_gate_id, inherited_feedback_round_id,
                inherited_feedback_target_node_id, primary_turn_id, message_id,
                execution_turn_id, created_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, activation_id) DO NOTHING`,
        params: [
          this.workspaceId,
          requesterNode.run_id,
          requestActivationId,
          target.nodeId,
          'feedback_request',
          'queued',
          null,
          roundId,
          target.nodeId,
          null,
          null,
          null,
          null,
          feedbackTurnId,
          feedbackMessageId,
          feedbackTurnId,
          finishedAt,
          finishedAt,
        ],
      });

      changes.push(
        { kind: 'turn', id: feedbackTurnId, taskId: target.taskId, change: 'effect' },
        { kind: 'message', id: feedbackMessageId, taskId: target.taskId, change: 'complete' },
      );
    }

    return {
      statements,
      changes,
      feedbackRoundReservations: [{ runId: requesterNode.run_id, count: 1 }],
      turnReservations: targetRows.map((target) => ({
        runId: requesterNode.run_id,
        taskId: target.taskId,
        count: 1,
      })),
    };
  }

  /**
   * M018 S04: when a target settles a feedback turn with workflow_next, record the
   * response fence, mark the target responded, and on the final ALL-join response
   * atomically satisfy the round and queue one ordered resume turn on the requester.
   * Partial responses leave the round open with no resume. Never seals lifecycle.
   */
  private async planWorkflowFeedbackResponse(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<WorkflowEffectPlan> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const disposition = command.turn.disposition;
    if (
      !disposition ||
      disposition.kind !== 'workflow_next' ||
      disposition.route !== undefined ||
      command.turn.status !== 'succeeded'
    ) {
      return empty;
    }

    const targetNode = await this.db.get<{ run_id: string; node_id: string }>(
      `SELECT run_id, node_id FROM workflow_nodes
        WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, command.task.id],
    );
    if (!targetNode || typeof targetNode.run_id !== 'string' || typeof targetNode.node_id !== 'string') {
      return empty;
    }

    const responseActivation = await this.db.get<{
      activation_id: string;
      kind: string;
      feedback_round_id: string | null;
      feedback_target_node_id: string | null;
      inherited_feedback_round_id: string | null;
      inherited_feedback_target_node_id: string | null;
      inherited_target_id: string | null;
    }>(
      `SELECT activation.activation_id, activation.kind, activation.feedback_round_id,
              activation.feedback_target_node_id, activation.inherited_feedback_round_id,
              activation.inherited_feedback_target_node_id, resume_round.inherited_target_id
         FROM workflow_activations activation
         LEFT JOIN workflow_feedback_rounds resume_round
           ON resume_round.workspace_id = activation.workspace_id
          AND resume_round.run_id = activation.run_id
          AND resume_round.round_id = activation.feedback_round_id
        WHERE activation.workspace_id = ? AND activation.run_id = ?
          AND activation.node_id = ? AND activation.execution_turn_id = ?`,
      [this.workspaceId, targetNode.run_id, targetNode.node_id, command.turn.id],
    );
    if (!responseActivation) return empty;

    const responseRoundId = responseActivation.kind === 'feedback_request'
      ? responseActivation.feedback_round_id
      : responseActivation.kind === 'feedback_resume'
        ? responseActivation.inherited_feedback_round_id
        : null;
    const responseTargetNodeId = responseActivation.kind === 'feedback_request'
      ? responseActivation.feedback_target_node_id
      : responseActivation.kind === 'feedback_resume'
        ? responseActivation.inherited_feedback_target_node_id
        : null;
    if (!responseRoundId || !responseTargetNodeId) return empty;

    const authority = await this.db.get<{
      target_id: string | null;
      request_activation_id: string | null;
      base_artifact_id: string | null;
      base_artifact_revision: number | null;
      status: string;
      round_status: string;
      requester_node_id: string;
      join_mode: string;
      inherited_round_id: string | null;
      inherited_target_id: string | null;
    }>(
      `SELECT target.target_id, target.request_activation_id, target.base_artifact_id,
              target.base_artifact_revision, target.status, round_row.status AS round_status,
              round_row.requester_node_id, round_row.join_mode,
              round_row.inherited_round_id, round_row.inherited_target_id
         FROM workflow_feedback_targets target
         JOIN workflow_feedback_rounds round_row
           ON round_row.workspace_id = target.workspace_id
          AND round_row.run_id = target.run_id
          AND round_row.round_id = target.round_id
        WHERE target.workspace_id = ? AND target.run_id = ?
          AND target.round_id = ? AND target.target_node_id = ?`,
      [this.workspaceId, targetNode.run_id, responseRoundId, responseTargetNodeId],
    );
    if (
      !authority?.target_id ||
      !authority.base_artifact_id ||
      authority.base_artifact_revision === null ||
      (
        responseActivation.kind === 'feedback_request'
          ? authority.request_activation_id !== responseActivation.activation_id
          : authority.target_id !== responseActivation.inherited_target_id
      )
    ) return empty;

    const matched = {
      roundId: responseRoundId,
      requesterNodeId: authority.requester_node_id,
      targetNodeId: responseTargetNodeId,
      targetId: authority.target_id,
      baseArtifactId: authority.base_artifact_id,
      baseArtifactRevision: authority.base_artifact_revision,
    };
    const round = {
      round_id: responseRoundId,
      status: authority.round_status,
      requester_node_id: authority.requester_node_id,
      join_mode: authority.join_mode,
      inherited_round_id: authority.inherited_round_id,
      inherited_target_id: authority.inherited_target_id,
    };

    const responseMessageId = deriveFeedbackResponseMessageId(
      targetNode.run_id,
      matched.roundId,
      matched.targetNodeId,
    );
    const existingResponse = await this.db.get<{ message_id: string }>(
      `SELECT message_id FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [this.workspaceId, targetNode.run_id, responseMessageId],
    );

    // Matched feedback turn: always suppress the forward NEXT path.
    // Redelivery or non-open rounds still insert the response fence with DO NOTHING.
    if (!round || round.status !== 'open' || authority.status !== 'pending' || existingResponse) {
      const finishedAtClosed = command.turn.finishedAt ?? new Date().toISOString();
      return {
        statements: [{
          sql: `INSERT INTO workflow_routed_messages (
                  workspace_id, run_id, message_id, source_node_id, destination_node_id,
                  kind, body_json, created_at
                ) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
          params: [
            this.workspaceId,
            targetNode.run_id,
            responseMessageId,
            matched.targetNodeId,
            matched.requesterNodeId,
            'feedback_response',
            encodePayload({
              kind: 'feedback_response',
              schema: 1,
              roundId: matched.roundId,
              targetNodeId: matched.targetNodeId,
              requesterNodeId: matched.requesterNodeId,
              sourceTurnId: command.turn.id,
            }),
            finishedAtClosed,
          ],
        }],
        changes: [],
      };
    }

    const finishedAt = command.turn.finishedAt ?? new Date().toISOString();
    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];
    const pendingTargets = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workflow_feedback_targets
        WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND status = 'pending'`,
      [this.workspaceId, targetNode.run_id, matched.roundId],
    );
    const willSatisfyRound = Number(pendingTargets?.count) === 1;

    // Response contribution: updated feedback creates a new immutable revision;
    // unchanged feedback points at the latest pinned revision.
    const artifactId = deriveProducerArtifactId(targetNode.run_id, matched.targetNodeId);
    if (disposition.change === 'unchanged' && artifactId !== matched.baseArtifactId) {
      return this.planWorkflowFailClosure({
        runId: targetNode.run_id,
        reasonCode: 'invalid_route',
        at: command.turn.finishedAt ?? new Date().toISOString(),
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }
    const latestArtifact = await this.db.get<{ revision: number }>(
      `SELECT MAX(revision) AS revision FROM workflow_artifacts
         WHERE workspace_id = ? AND run_id = ? AND artifact_id = ?`,
      [this.workspaceId, targetNode.run_id, artifactId],
    );
    const latestRevision = latestArtifact?.revision ?? 1;
    const revision = disposition.change === 'unchanged'
      ? matched.baseArtifactRevision
      : latestRevision + 1;
      const resultBody = typeof disposition.result === 'string' ? disposition.result : undefined;
    const artifactPayload = encodePayload({
      kind: 'next_result',
      schema: 1,
      change: disposition.change,
      producerNodeId: matched.targetNodeId,
      sourceTurnId: command.turn.id,
      feedbackRoundId: matched.roundId,
      ...(resultBody !== undefined ? { result: resultBody } : {}),
    });

    statements.push({
      sql: `INSERT INTO workflow_routed_messages (
              workspace_id, run_id, message_id, source_node_id, source_task_id,
              source_turn_id, destination_node_id, feedback_round_id,
              feedback_target_id, artifact_run_id, artifact_id, artifact_revision,
              kind, body_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
      params: [
        this.workspaceId,
        targetNode.run_id,
        responseMessageId,
        matched.targetNodeId,
        command.task.id,
        command.turn.id,
        matched.requesterNodeId,
        matched.roundId,
        matched.targetId,
        targetNode.run_id,
        artifactId,
        revision,
        'feedback_response',
        encodePayload({
          kind: 'feedback_response',
          schema: 1,
          roundId: matched.roundId,
          targetNodeId: matched.targetNodeId,
          requesterNodeId: matched.requesterNodeId,
          artifactId,
          artifactRevision: revision,
          sourceTurnId: command.turn.id,
        }),
        finishedAt,
      ],
    });

    if (disposition.change === 'updated') {
      statements.push({
      sql: `INSERT INTO workflow_artifacts (
              workspace_id, run_id, artifact_id, producer_node_id, logical_name,
              revision, kind, payload_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT DO NOTHING`,
      params: [
        this.workspaceId,
        targetNode.run_id,
        artifactId,
        matched.targetNodeId,
        'next_result',
        revision,
        'next_result',
        artifactPayload,
        finishedAt,
      ],
      });
      statements.push(workflowNodeArtifactSourceStatement({
        workspaceId: this.workspaceId,
        runId: targetNode.run_id,
        artifactId,
        artifactRevision: revision,
        nodeId: matched.targetNodeId,
        taskId: command.task.id,
        turnId: command.turn.id,
      }));
    }

    statements.push({
      sql: `UPDATE workflow_feedback_targets
               SET status = 'responded', response_turn_id = ?,
                   response_artifact_run_id = ?, response_artifact_id = ?,
                   response_artifact_revision = ?
             WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND target_node_id = ?
               AND status = 'pending'`,
      params: [
        command.turn.id,
        targetNode.run_id,
        artifactId,
        revision,
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
        matched.targetNodeId,
      ],
    });

    const aggregateClosureId = deriveRunClosureFenceId(targetNode.run_id, 'failed');
    statements.push({
      sql: `UPDATE workflow_runs
               SET terminal_reason_code = 'aggregate_too_large', closure_id = ?, updated_at = ?
             WHERE workspace_id = ? AND run_id = ? AND status = 'running'
               AND terminal_reason_code IS NULL
               AND EXISTS (
                 SELECT 1
                   FROM workflow_feedback_rounds overflow_round
                  WHERE overflow_round.workspace_id = workflow_runs.workspace_id
                    AND overflow_round.run_id = workflow_runs.run_id
                    AND overflow_round.round_id = ?
                    AND overflow_round.status = 'open'
                    AND NOT EXISTS (
                      SELECT 1 FROM workflow_feedback_targets
                       WHERE workspace_id = overflow_round.workspace_id
                         AND run_id = overflow_round.run_id
                         AND round_id = overflow_round.round_id
                         AND status != 'responded'
                    )
                    AND length(CAST(
                      '[workflow-feedback-resume] ' || COALESCE((
                        SELECT group_concat(ordered.value, ' ')
                          FROM (
                            SELECT binding.input_ref || '=' ||
                                   COALESCE(
                                     json_extract(artifact.payload_json, '$.result'),
                                     '[artifact ' || artifact.artifact_id || '@' || artifact.revision || ']'
                                   ) AS value
                              FROM workflow_dependency_gates requester_gate
                              JOIN workflow_gate_bindings binding
                                ON binding.workspace_id = requester_gate.workspace_id
                               AND binding.run_id = requester_gate.run_id
                               AND binding.gate_id = requester_gate.gate_id
                              JOIN workflow_feedback_targets target
                                ON target.workspace_id = requester_gate.workspace_id
                               AND target.run_id = requester_gate.run_id
                               AND target.round_id = overflow_round.round_id
                               AND target.target_node_id = binding.producer_node_id
                               JOIN workflow_artifacts artifact
                                 ON artifact.workspace_id = target.workspace_id
                                AND artifact.run_id = target.response_artifact_run_id
                                AND artifact.artifact_id = target.response_artifact_id
                                AND artifact.revision = target.response_artifact_revision
                              JOIN workflow_runs aggregate_run
                                ON aggregate_run.workspace_id = requester_gate.workspace_id
                               AND aggregate_run.run_id = requester_gate.run_id
                              LEFT JOIN workflow_definition_edges definition_edge
                                ON definition_edge.workspace_id = aggregate_run.workspace_id
                               AND definition_edge.definition_id = aggregate_run.definition_id
                               AND definition_edge.definition_version = aggregate_run.definition_version
                               AND definition_edge.source_node_id = binding.producer_node_id
                               AND definition_edge.destination_node_id = requester_gate.consumer_node_id
                               AND definition_edge.destination_input_ref = binding.input_ref
                             WHERE requester_gate.workspace_id = overflow_round.workspace_id
                               AND requester_gate.run_id = overflow_round.run_id
                               AND requester_gate.consumer_node_id = overflow_round.requester_node_id
                               AND binding.required_kind <> 'engine_start'
                             ORDER BY COALESCE(definition_edge.ordinal, 2147483647), binding.input_ref
                          ) ordered
                      ), '') AS BLOB
                    )) > workflow_runs.max_aggregate_bytes
               )`,
      params: [
        aggregateClosureId,
        finishedAt,
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
      ],
    });

    // Atomic open→satisfied only when every target has responded (incl. this one).
    // Exclude this target from the pending check so the UPDATE does not depend on
    // statement ordering within the same transaction.
    statements.push({
      sql: `UPDATE workflow_feedback_rounds
               SET status = 'satisfied'
             WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND status = 'open'
                AND NOT EXISTS (
                  SELECT 1 FROM workflow_feedback_targets
                   WHERE workspace_id = ? AND run_id = ? AND round_id = ?
                     AND status != 'responded'
                     AND target_node_id != ?
               )
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code IS NULL
                )`,
      params: [
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
        matched.targetNodeId,
        this.workspaceId,
        targetNode.run_id,
      ],
    });
    statements.push(...workflowAggregateOverflowClosureStatements({
      workspaceId: this.workspaceId,
      runId: targetNode.run_id,
      closureId: aggregateClosureId,
      at: finishedAt,
    }));

    if (!willSatisfyRound) return { statements, changes };

    const resumeTurnId = deriveFeedbackResumeTurnId(targetNode.run_id, matched.roundId);
    const resumeMessageId = deriveFeedbackResumeMessageId(targetNode.run_id, matched.roundId);
    const resumeActivationId = deriveFeedbackResumeActivationId(targetNode.run_id, matched.roundId);
    let inheritedTargetNodeId: string | null = null;
    if (round.inherited_round_id || round.inherited_target_id) {
      if (!round.inherited_round_id || !round.inherited_target_id) {
        return this.planWorkflowFailClosure({
          runId: targetNode.run_id,
          reasonCode: 'invalid_route',
          at: finishedAt,
          sourceTaskId: command.task.id,
          sourceTurnId: command.turn.id,
        });
      }
      const inheritedTarget = await this.db.get<{ target_node_id: string }>(
        `SELECT target_node_id FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND target_id = ?
            AND status = 'pending'`,
        [
          this.workspaceId,
          targetNode.run_id,
          round.inherited_round_id,
          round.inherited_target_id,
        ],
      );
      if (!inheritedTarget?.target_node_id) {
        return this.planWorkflowFailClosure({
          runId: targetNode.run_id,
          reasonCode: 'invalid_route',
          at: finishedAt,
          sourceTaskId: command.task.id,
          sourceTurnId: command.turn.id,
        });
      }
      inheritedTargetNodeId = inheritedTarget.target_node_id;
    }

    const requesterTask = await this.db.get<{ task_id: string | null }>(
      `SELECT task_id FROM workflow_nodes
        WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
      [this.workspaceId, targetNode.run_id, matched.requesterNodeId],
    );
    if (!requesterTask || typeof requesterTask.task_id !== 'string') {
      return { statements, changes };
    }
    const requesterTaskId = requesterTask.task_id;
    const maxSeqRow = await this.db.get<{ max_seq: number | null }>(
      `SELECT MAX(sequence) AS max_seq FROM turns WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, requesterTaskId],
    );
    const nextSequence = (maxSeqRow?.max_seq ?? 0) + 1;
    const turnPayloadJson = encodePayload({});
    const messagePayloadJson = encodePayload({});

    // Conditional resume: only when round is satisfied; reserved ids make redelivery no-op.
    statements.push({
      sql: `INSERT INTO turns (
              id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json
            )
            SELECT ?,?,?,?,?,?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_feedback_rounds
                WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM turns WHERE workspace_id = ? AND id = ?
             )`,
      params: [
        resumeTurnId,
        this.workspaceId,
        requesterTaskId,
        nextSequence,
        'queued',
        'engine',
        finishedAt,
        null,
        null,
        turnPayloadJson,
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
        this.workspaceId,
        resumeTurnId,
      ],
    });
    statements.push({
      sql: `INSERT INTO messages (
              id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json
            )
            SELECT ?,?,?,?,?,?,?,
                   '[workflow-feedback-resume] ' || COALESCE((
                     SELECT group_concat(ordered.value, ' ')
                       FROM (
                         SELECT binding.input_ref || '=' ||
                                COALESCE(
                                  json_extract(artifact.payload_json, '$.result'),
                                  '[artifact ' || artifact.artifact_id || '@' || artifact.revision || ']'
                                ) AS value
                           FROM workflow_dependency_gates requester_gate
                           JOIN workflow_gate_bindings binding
                             ON binding.workspace_id = requester_gate.workspace_id
                            AND binding.run_id = requester_gate.run_id
                            AND binding.gate_id = requester_gate.gate_id
                           JOIN workflow_feedback_targets target
                             ON target.workspace_id = requester_gate.workspace_id
                            AND target.run_id = requester_gate.run_id
                            AND target.round_id = ?
                            AND target.target_node_id = binding.producer_node_id
                            JOIN workflow_artifacts artifact
                              ON artifact.workspace_id = target.workspace_id
                             AND artifact.run_id = target.response_artifact_run_id
                             AND artifact.artifact_id = target.response_artifact_id
                             AND artifact.revision = target.response_artifact_revision
                           JOIN workflow_runs aggregate_run
                             ON aggregate_run.workspace_id = requester_gate.workspace_id
                            AND aggregate_run.run_id = requester_gate.run_id
                           LEFT JOIN workflow_definition_edges definition_edge
                             ON definition_edge.workspace_id = aggregate_run.workspace_id
                            AND definition_edge.definition_id = aggregate_run.definition_id
                            AND definition_edge.definition_version = aggregate_run.definition_version
                            AND definition_edge.source_node_id = binding.producer_node_id
                            AND definition_edge.destination_node_id = requester_gate.consumer_node_id
                            AND definition_edge.destination_input_ref = binding.input_ref
                          WHERE requester_gate.workspace_id = ?
                            AND requester_gate.run_id = ?
                            AND requester_gate.consumer_node_id = ?
                            AND binding.required_kind <> 'engine_start'
                          ORDER BY COALESCE(definition_edge.ordinal, 2147483647), binding.input_ref
                       ) ordered
                   ), ''),
                   ?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_feedback_rounds
                WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM messages WHERE workspace_id = ? AND id = ?
             )`,
      params: [
        resumeMessageId,
        this.workspaceId,
        requesterTaskId,
        resumeTurnId,
        'system',
        'assigned',
        null,
        matched.roundId,
        this.workspaceId,
        targetNode.run_id,
        matched.requesterNodeId,
        finishedAt,
        null,
        messagePayloadJson,
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
        this.workspaceId,
        resumeMessageId,
      ],
    });
    statements.push({
      sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
            SELECT ?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_feedback_rounds
                WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND status = 'satisfied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM turn_inputs WHERE workspace_id = ? AND turn_id = ? AND ordering = 0
             )`,
      params: [
        this.workspaceId,
        resumeTurnId,
        0,
        'message',
        encodePayload({ kind: 'message', messageId: resumeMessageId }),
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
        this.workspaceId,
        resumeTurnId,
      ],
    });
    statements.push({
      sql: `INSERT INTO workflow_activations (
              workspace_id, run_id, activation_id, node_id, kind, status,
              source_gate_id, feedback_round_id, feedback_target_node_id,
              continuation_id, return_gate_id, inherited_feedback_round_id,
              inherited_feedback_target_node_id, primary_turn_id, message_id,
              execution_turn_id, created_at, updated_at
            )
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
             WHERE EXISTS (
               SELECT 1 FROM workflow_feedback_rounds
                WHERE workspace_id = ? AND run_id = ? AND round_id = ? AND status = 'satisfied'
             )
            ON CONFLICT(workspace_id, run_id, activation_id) DO NOTHING`,
      params: [
        this.workspaceId,
        targetNode.run_id,
        resumeActivationId,
        matched.requesterNodeId,
        'feedback_resume',
        'queued',
        null,
        matched.roundId,
        null,
        null,
        null,
        round.inherited_round_id,
        inheritedTargetNodeId,
        resumeTurnId,
        resumeMessageId,
        resumeTurnId,
        finishedAt,
        finishedAt,
        this.workspaceId,
        targetNode.run_id,
        matched.roundId,
      ],
    });
    changes.push(
      { kind: 'turn', id: resumeTurnId, taskId: requesterTaskId, change: 'effect' },
      { kind: 'message', id: resumeMessageId, taskId: requesterTaskId, change: 'complete' },
    );

    return {
      statements,
      changes,
      turnReservations: [{ runId: targetNode.run_id, taskId: requesterTaskId, count: 1 }],
    };
  }

  /**
   * M018 S05 settle entry: workflow_fail disposition, invalid PREV routing, or
   * run_timeout termination each close the run via planWorkflowFailClosure.
   */

  /**
   * M018 S06: on successful settle with a child-workflow NEXT route, atomically start
   * a child run (origin='child', parent_run_id=caller), pin exact entry bindings,
   * record one pending continuation + caller return gate, and fence child_invocation.
   * Invalid/missing/foreign bindings abort with zero child rows.
   */
  private async planWorkflowChildInvocation(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<WorkflowEffectPlan> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const staged = command.turn.disposition;
    if (!staged || staged.kind !== 'workflow_next' || staged.route?.kind !== 'child_workflow') {
      return empty;
    }
    const disposition = staged.route;

    const finishedAt = command.turn.finishedAt ?? new Date().toISOString();
    const callerNode = await this.lookupWorkflowNodeForTask(command.task.id);
    const callerRun = callerNode ? await this.db.get<{
      definition_id: string;
      definition_version: number;
      owner_root_task_id: string | null;
      max_children: number;
      children_reserved: number;
    }>(
      `SELECT definition_id, definition_version, owner_root_task_id,
              max_children, children_reserved
         FROM workflow_runs
        WHERE workspace_id = ? AND run_id = ?`,
      [this.workspaceId, callerNode.runId],
    ) : undefined;
    if (callerNode) {
      if (!callerRun) return empty;
      const callerAuthority = await this.db.get<{ is_terminal: number }>(
        `SELECT definition_node.is_terminal
           FROM workflow_runs run
           JOIN workflow_definition_nodes definition_node
             ON definition_node.workspace_id = run.workspace_id
            AND definition_node.definition_id = run.definition_id
            AND definition_node.definition_version = run.definition_version
          WHERE run.workspace_id = ? AND run.run_id = ? AND definition_node.node_id = ?
            AND run.status = 'running'`,
        [this.workspaceId, callerNode.runId, callerNode.nodeId],
      );
      if (callerAuthority?.is_terminal !== 1) return empty;
      const openRound = await this.db.get<{ round_id: string }>(
        `SELECT round_id FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND status = 'open'
          LIMIT 1`,
        [this.workspaceId, callerNode.runId],
      );
      if (openRound) return empty;
    } else if (
      command.task.parentId !== null ||
      command.task.role !== 'coordinator' ||
      !command.task.capabilities.includes('create_child')
    ) {
      return empty;
    }

    const pendingContinuation = await this.db.get<{
      continuation_id: string;
      invocation_key: string | null;
      invocation_fingerprint: string | null;
    }>(
      callerNode
        ? `SELECT continuation_id, invocation_key, invocation_fingerprint
             FROM workflow_continuations
            WHERE workspace_id = ? AND run_id = ? AND status = 'pending'
            LIMIT 1`
        : `SELECT continuation_id, invocation_key, invocation_fingerprint
             FROM workflow_continuations
            WHERE workspace_id = ? AND caller_task_id = ? AND status = 'pending'
            LIMIT 1`,
      [this.workspaceId, callerNode?.runId ?? command.task.id],
    );
    const callerRunId = callerNode?.runId;
    const callerScopeId = callerRunId ?? stableId('wfcaller', command.task.id);
    const ownerRootTaskId = callerRun?.owner_root_task_id ?? command.task.id;

    const bindingCheck = validateInvokeChildEntryBindings(disposition.entryBindings);
    if (!bindingCheck.ok) return empty;

    const childIdempotencyKey = deriveChildStartIdempotencyKey({
      callerRunId: callerScopeId,
      callerTurnId: command.turn.id,
      childDefinitionId: disposition.childDefinitionId,
      childDefinitionVersion: disposition.childDefinitionVersion,
      childIdempotencyKey: disposition.childIdempotencyKey,
    });
    const fenceId = deriveChildInvocationFenceId(
      callerScopeId,
      disposition.childDefinitionId,
      disposition.childDefinitionVersion,
      childIdempotencyKey,
    );
    const childDef = await this.db.get<{
      topology_json: string;
      name: string;
      entry_node_id: string;
      scope_kind: 'workspace' | 'root';
      owner_root_task_id: string | null;
      policy_json: string;
      fingerprint: string;
      created_at: string;
    }>(
      `SELECT topology_json, name, entry_node_id, scope_kind, owner_root_task_id,
              policy_json, fingerprint, created_at
         FROM workflow_definitions
        WHERE workspace_id = ? AND definition_id = ? AND version = ?`,
      [
        this.workspaceId,
        disposition.childDefinitionId,
        disposition.childDefinitionVersion,
      ],
    );
    if (!childDef) return empty;

    const childTopologyDecoded = decodeStoredTopologyJson(childDef.topology_json);
    if (!childTopologyDecoded.ok) return empty;
    const childContracts = await this.db.all<{
      entry_node_id: string;
      input_ref: string;
      expected_artifact_kind: string;
    }>(
      `SELECT entry_node_id, input_ref, expected_artifact_kind
         FROM workflow_entry_contracts
        WHERE workspace_id = ? AND definition_id = ? AND definition_version = ?
        ORDER BY ordinal`,
      [this.workspaceId, disposition.childDefinitionId, disposition.childDefinitionVersion],
    );
    let childPolicy: unknown;
    try {
      childPolicy = JSON.parse(childDef.policy_json);
    } catch {
      return empty;
    }
    const childDefinition = validateDefineWorkflow({
      definitionId: disposition.childDefinitionId,
      version: disposition.childDefinitionVersion,
      name: childDef.name,
      topology: childTopologyDecoded.topology,
      entryContracts: childContracts.map((contract) => ({
        entryNodeId: contract.entry_node_id,
        inputRef: contract.input_ref,
        expectedArtifactKind: contract.expected_artifact_kind,
      })),
      policy: childPolicy,
      scope: childDef.scope_kind === 'root'
        ? { kind: 'root', ownerRootTaskId: childDef.owner_root_task_id ?? '' }
        : { kind: 'workspace' },
      createdAt: childDef.created_at,
    });
    if (!childDefinition.ok || childDefinition.fingerprint !== childDef.fingerprint) return empty;
    if (
      childDefinition.definition.scope.kind === 'root' &&
      childDefinition.definition.scope.ownerRootTaskId !== ownerRootTaskId
    ) return empty;
    let childEffectivePolicy = childDefinition.definition.policy;
    if (disposition.effectivePolicy) {
      const numericPolicyKeys: Array<Exclude<keyof WorkflowPolicyV1, 'failWorkflow'>> = [
        'maxFeedbackRoundsPerRun',
        'maxTurnsPerTask',
        'maxWorkflowTurnsPerRun',
        'runTimeoutMs',
        'maxDepth',
        'maxTaskCount',
        'maxConcurrency',
        'maxInputsPerGate',
        'maxArtifactBytes',
        'maxAggregateBytes',
      ];
      if (
        disposition.effectivePolicy.failWorkflow !== childEffectivePolicy.failWorkflow ||
        numericPolicyKeys.some((key) =>
          disposition.effectivePolicy![key] > childEffectivePolicy[key])
      ) return empty;
      const effectiveDefinition = validateDefineWorkflow({
        ...childDefinition.definition,
        policy: disposition.effectivePolicy,
      });
      if (!effectiveDefinition.ok) {
        const aggregateBoundExceeded = entryNodeIds(childDefinition.definition.topology).some(
          (entryNodeId) =>
            maximumWorkflowEntryAggregateBytes(
              childDefinition.definition.entryContracts.filter(
                (contract) => contract.entryNodeId === entryNodeId,
              ),
              disposition.effectivePolicy!.maxArtifactBytes,
            ) > disposition.effectivePolicy!.maxAggregateBytes,
        );
        if (aggregateBoundExceeded && callerRunId) {
          return this.planWorkflowFailClosure({
            runId: callerRunId,
            reasonCode: 'aggregate_too_large',
            at: finishedAt,
            sourceTaskId: command.task.id,
            sourceTurnId: command.turn.id,
          });
        }
        return empty;
      }
      childEffectivePolicy = effectiveDefinition.definition.policy;
    }
    const childTopology = childDefinition.definition.topology;

    const childEntryNodeIds = entryNodeIds(childTopology);
    const allChildNodeIds = childTopology.nodes.map((n) => n.nodeId);
    const primaryEntry = childEntryNodeIds[0] ?? childDef.entry_node_id;

    const childContractByKey = new Map(
      childDefinition.definition.entryContracts.map((contract) => [
        `${contract.entryNodeId}\0${contract.inputRef}`,
        contract,
      ] as const),
    );
    if (disposition.entryBindings.length !== childContractByKey.size) return empty;

    const pinnedFills: Array<{
      childEntryNodeId: string;
      inputRef: string;
      artifactRunId: string;
      artifactId: string;
      artifactRevision: number;
      producerNodeId: string;
      payloadJson: string;
      kind: string;
      logicalName: string;
    }> = [];

    for (const binding of disposition.entryBindings) {
      const contract = childContractByKey.get(
        `${binding.childEntryNodeId}\0${binding.inputRef}`,
      );
      if (!contract) return empty;
      const art = await this.db.get<{
        run_id: string;
        artifact_id: string;
        revision: number;
        producer_node_id: string;
        payload_json: string;
        kind: string;
        logical_name: string;
      }>(
        callerRunId
          ? `SELECT run_id, artifact_id, revision, producer_node_id, payload_json, kind, logical_name
               FROM workflow_artifacts
              WHERE workspace_id = ? AND run_id = ? AND artifact_id = ? AND revision = ?`
          : `SELECT artifact.run_id, artifact.artifact_id, artifact.revision,
                    artifact.producer_node_id, artifact.payload_json, artifact.kind,
                    artifact.logical_name
               FROM workflow_artifacts artifact
               JOIN workflow_artifact_sources source
                 ON source.workspace_id = artifact.workspace_id
                AND source.run_id = artifact.run_id
                AND source.artifact_id = artifact.artifact_id
                AND source.artifact_revision = artifact.revision
              WHERE artifact.workspace_id = ? AND artifact.artifact_id = ?
                AND artifact.revision = ?
                AND (
                  (source.source_kind = 'caller_turn'
                   AND source.caller_task_id = ? AND source.caller_turn_id = ?)
                  OR
                  (source.source_kind = 'workflow_node' AND source.producer_task_id = ?)
                )
              LIMIT 1`,
        callerRunId
          ? [this.workspaceId, callerRunId, binding.artifactId, binding.artifactRevision]
          : [
              this.workspaceId,
              binding.artifactId,
              binding.artifactRevision,
              command.task.id,
              command.turn.id,
              command.task.id,
            ],
      );
      if (!art || art.kind !== contract.expectedArtifactKind) return empty;
      pinnedFills.push({
        childEntryNodeId: binding.childEntryNodeId,
        inputRef: binding.inputRef,
        artifactRunId: art.run_id,
        artifactId: art.artifact_id,
        artifactRevision: art.revision,
        producerNodeId: art.producer_node_id,
        payloadJson: art.payload_json,
        kind: art.kind,
        logicalName: art.logical_name,
      });
    }

    const pinnedFillByKey = new Map(
      pinnedFills.map((pin) => [`${pin.childEntryNodeId}\0${pin.inputRef}`, pin] as const),
    );
    const aggregateByEntry = new Map<string, string>();
    for (const entryNodeId of childEntryNodeIds) {
      const contracts = childDefinition.definition.entryContracts.filter(
        (contract) => contract.entryNodeId === entryNodeId,
      );
      const values: Array<{ inputRef: string; value: string }> = [];
      for (const contract of contracts) {
        const pin = pinnedFillByKey.get(`${entryNodeId}\0${contract.inputRef}`);
        if (!pin) return empty;
        let payload: unknown;
        try {
          payload = JSON.parse(pin.payloadJson);
        } catch {
          return empty;
        }
        const value = payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>).value
          : undefined;
        values.push({
          inputRef: contract.inputRef,
          value: typeof value === 'string' ? value : pin.payloadJson,
        });
      }
      const aggregate = formatWorkflowEntryAggregate(values);
      if (
        values.some((value) =>
          Buffer.byteLength(value.value, 'utf8') > childEffectivePolicy.maxArtifactBytes)
        ||
        Buffer.byteLength(aggregate, 'utf8') >
        childEffectivePolicy.maxAggregateBytes
      ) {
        if (callerRunId) {
          return this.planWorkflowFailClosure({
            runId: callerRunId,
            reasonCode: 'aggregate_too_large',
            at: finishedAt,
            sourceTaskId: command.task.id,
            sourceTurnId: command.turn.id,
          });
        }
        return empty;
      }
      aggregateByEntry.set(entryNodeId, aggregate);
    }

    const validated = validateStartWorkflow({
      definitionId: disposition.childDefinitionId,
      version: disposition.childDefinitionVersion,
      startIdempotencyKey: childIdempotencyKey,
      createdAt: finishedAt,
      entryNodeId: primaryEntry,
      entryNodeIds: childEntryNodeIds,
      allNodeIds: allChildNodeIds,
      goal: childDef.name,
      backend: command.task.backend,
      policy: childEffectivePolicy,
    });
    if (!validated.ok) return empty;

    const { identities } = validated;
    if (identities.entries.length > childEffectivePolicy.maxWorkflowTurnsPerRun) {
      return callerRunId
        ? this.planWorkflowFailClosure({
            runId: callerRunId,
            reasonCode: 'turn_budget_exhausted',
            at: finishedAt,
            sourceTaskId: command.task.id,
            sourceTurnId: command.turn.id,
          })
        : empty;
    }
    if (callerRun && callerRun.children_reserved >= callerRun.max_children) {
      return this.planWorkflowFailClosure({
        runId: callerRunId!,
        reasonCode: 'turn_budget_exhausted',
        at: finishedAt,
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }
    const childRunId = identities.runId;
    const continuationId = deriveChildContinuationId(callerScopeId, childRunId);
    const returnGateId = deriveCallerReturnGateId(callerScopeId, childRunId);
    const continuationRunId = callerRunId ?? childRunId;
    const childCreatedAtMs = Date.parse(finishedAt);
    if (!Number.isFinite(childCreatedAtMs)) return empty;
    const childDeadlineAt = new Date(
      childCreatedAtMs + childEffectivePolicy.runTimeoutMs,
    ).toISOString();
    const invocationFingerprint = childInvocationFingerprint({
      callerScopeId,
      childDefinitionId: disposition.childDefinitionId,
      childDefinitionVersion: disposition.childDefinitionVersion,
      childIdempotencyKey,
      entryBindings: pinnedFills,
      effectivePolicy: childEffectivePolicy,
    });
    if (pendingContinuation) {
      if (pendingContinuation.invocation_key !== childIdempotencyKey) return empty;
      if (pendingContinuation.invocation_fingerprint !== invocationFingerprint) {
        return { ...empty, conflictReason: 'child invocation fingerprint conflict' };
      }
      return empty;
    }
    const existingInvocation = await this.db.get<{ invocation_fingerprint: string | null }>(
      `SELECT invocation_fingerprint FROM workflow_continuations
        WHERE workspace_id = ? AND run_id = ? AND continuation_id = ?`,
      [this.workspaceId, continuationRunId, continuationId],
    );
    if (existingInvocation) {
      if (existingInvocation.invocation_fingerprint !== invocationFingerprint) {
        return { ...empty, conflictReason: 'child invocation fingerprint conflict' };
      }
      return empty;
    }
    const existingFenceRunId = callerRunId ?? childRunId;
    const existingFence = await this.db.get<{ message_id: string }>(
      `SELECT message_id FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [this.workspaceId, existingFenceRunId, fenceId],
    );
    if (existingFence) return empty;

    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];

    if (callerRunId) {
      statements.push({
        sql: `UPDATE workflow_runs
                 SET children_reserved = children_reserved + 1, updated_at = ?
               WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                 AND children_reserved < max_children`,
        params: [finishedAt, this.workspaceId, callerRunId],
      });
    }

    const fenceBody = JSON.stringify({
      kind: 'child_invocation',
      callerRunId: callerRunId ?? null,
      callerNodeId: callerNode?.nodeId ?? null,
      callerTurnId: command.turn.id,
      childRunId,
      childDefinitionId: disposition.childDefinitionId,
      childDefinitionVersion: disposition.childDefinitionVersion,
      childIdempotencyKey,
      continuationId,
      returnGateId,
    });
    statements.push({
      sql: `INSERT INTO workflow_runs (
              workspace_id, run_id, definition_id, definition_version, status, origin,
              parent_run_id, owner_root_task_id, caller_task_id, caller_turn_id,
              continuation_id, policy_json, max_feedback_rounds, max_turns_per_task,
               max_workflow_turns, max_children, max_depth, max_concurrency,
               max_aggregate_bytes, feedback_rounds_reserved, workflow_turns_reserved,
               children_reserved, started_at, deadline_at, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id) DO NOTHING`,
      params: [
        this.workspaceId,
        childRunId,
        disposition.childDefinitionId,
        disposition.childDefinitionVersion,
        'running',
        'child',
        callerRunId ?? null,
        ownerRootTaskId,
        command.task.id,
        command.turn.id,
        continuationId,
        JSON.stringify(childEffectivePolicy),
        childEffectivePolicy.maxFeedbackRoundsPerRun,
        childEffectivePolicy.maxTurnsPerTask,
        childEffectivePolicy.maxWorkflowTurnsPerRun,
        childEffectivePolicy.maxTaskCount,
        childEffectivePolicy.maxDepth,
        childEffectivePolicy.maxConcurrency,
        childEffectivePolicy.maxAggregateBytes,
        0,
        identities.entries.length,
        0,
        finishedAt,
        childDeadlineAt,
        finishedAt,
        finishedAt,
      ],
    });
    statements.push({
      sql: `INSERT INTO workflow_routed_messages (
              workspace_id, run_id, message_id, source_node_id, destination_node_id,
              kind, body_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
      params: [
        this.workspaceId,
        existingFenceRunId,
        fenceId,
        callerNode?.nodeId ?? 'caller',
        callerNode?.nodeId ?? 'caller',
        'child_invocation',
        fenceBody,
        finishedAt,
      ],
    });

    const childNodeById = new Map(childTopology.nodes.map((node) => [node.nodeId, node] as const));
    const childEntryByNode = new Map(identities.entries.map((entry) => [entry.nodeId, entry] as const));
    for (const nodeGate of identities.nodeGates) {
      const isEntry = childEntryNodeIds.includes(nodeGate.nodeId);
      const entry = childEntryByNode.get(nodeGate.nodeId);
      statements.push({
        sql: `INSERT INTO workflow_dependency_gates (
                workspace_id, run_id, gate_id, consumer_node_id, status,
                activation_id, reserved_turn_id, aggregate_message_id
              ) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, gate_id) DO NOTHING`,
        params: [
          this.workspaceId,
          childRunId,
          nodeGate.gateId,
          nodeGate.nodeId,
          isEntry ? 'satisfied' : 'open',
          isEntry && entry ? entry.activationId : null,
          isEntry && entry ? entry.activationTurnId : null,
          isEntry && entry ? entry.messageId : null,
        ],
      });
    }

    if (childTopology.kind === 'graph_v1') {
      for (const edge of childTopology.edges) {
        const consumerGate = identities.nodeGates.find((g) => g.nodeId === edge.toNodeId);
        if (!consumerGate) continue;
        statements.push({
          sql: `INSERT INTO workflow_gate_bindings (
                  workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind
                ) VALUES (?,?,?,?,?,?)
                ON CONFLICT(workspace_id, run_id, gate_id, input_ref) DO NOTHING`,
          params: [
            this.workspaceId,
            childRunId,
            consumerGate.gateId,
            edge.inputRef,
            edge.fromNodeId,
            edge.expectedArtifactKind ?? 'next_result',
          ],
        });
      }
    }

    for (const entry of identities.entries) {
      const node = childNodeById.get(entry.nodeId);
      const task = {
        id: entry.taskId,
        role: node?.role ?? 'worker',
        lifecycle: 'open' as const,
        releaseState: 'released' as const,
        goal: validated.goal,
        parentId: command.task.id,
        dependencies: [],
        backend: node?.backend ?? validated.backend,
        ...(node?.model ? { model: node.model } : {}),
        ...(node?.taskType ? { taskType: node.taskType } : {}),
        capabilities: (node?.capabilities ?? []) as MusterTask['capabilities'],
        executionPolicy: {
          maxTurns: childEffectivePolicy.maxTurnsPerTask,
          maxAutomaticRetries: 1,
        },
        revision: 0,
        createdAt: finishedAt,
        updatedAt: finishedAt,
      };
      const turn = {
        id: entry.activationTurnId,
        taskId: entry.taskId,
        sequence: 0,
        trigger: 'engine' as const,
        status: 'queued' as const,
        inputs: [{ kind: 'message' as const, messageId: entry.messageId }],
        createdAt: finishedAt,
      };
      const message = {
        id: entry.messageId,
        taskId: entry.taskId,
        role: 'system' as const,
        content: aggregateByEntry.get(entry.nodeId) ?? '[workflow-entry]',
        state: 'assigned' as const,
        turnId: entry.activationTurnId,
        createdAt: finishedAt,
      };
      statements.push(taskStatement(this.workspaceId, task as any, false));
      statements.push(turnStatement(this.workspaceId, turn as any, false));
      statements.push(messageStatement(this.workspaceId, message as any, false));
      statements.push(
        turnInputStatement(this.workspaceId, turn.id, 0, {
          kind: 'message',
          messageId: entry.messageId,
        }),
      );
      statements.push({
        sql: `INSERT INTO workflow_nodes (
                workspace_id, run_id, node_id, task_id, status
              ) VALUES (?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, node_id) DO NOTHING`,
        params: [
          this.workspaceId,
          childRunId,
          entry.nodeId,
          entry.taskId,
          'active',
        ],
      });
      statements.push({
        sql: `INSERT INTO workflow_activations (
                workspace_id, run_id, activation_id, node_id, kind, status,
                source_gate_id, feedback_round_id, feedback_target_node_id,
                continuation_id, return_gate_id, inherited_feedback_round_id,
                inherited_feedback_target_node_id, primary_turn_id, message_id,
                execution_turn_id, created_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, activation_id) DO NOTHING`,
        params: [
          this.workspaceId,
          childRunId,
          entry.activationId,
          entry.nodeId,
          'entry_start',
          'queued',
          entry.gateId,
          null,
          null,
          null,
          null,
          null,
          null,
          entry.activationTurnId,
          entry.messageId,
          entry.activationTurnId,
          finishedAt,
          finishedAt,
        ],
      });
      changes.push(
        { kind: 'task', id: entry.taskId, change: 'insert' },
        { kind: 'turn', id: entry.activationTurnId, taskId: entry.taskId, change: 'insert' },
        { kind: 'message', id: entry.messageId, taskId: entry.taskId, change: 'complete' },
      );
    }

    for (const nodeGate of identities.nodeGates) {
      if (childEntryNodeIds.includes(nodeGate.nodeId)) continue;
      statements.push({
        sql: `INSERT INTO workflow_nodes (
                workspace_id, run_id, node_id, task_id, status
              ) VALUES (?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, node_id) DO NOTHING`,
        params: [this.workspaceId, childRunId, nodeGate.nodeId, null, 'pending'],
      });
    }

    for (const pin of pinnedFills) {
      const entryGate = childEntryByNode.get(pin.childEntryNodeId)?.gateId;
      if (!entryGate) return empty;
      const contract = childContractByKey.get(`${pin.childEntryNodeId}\0${pin.inputRef}`);
      if (!contract) return empty;
      statements.push({
        sql: `INSERT INTO workflow_gate_bindings (
                workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind
              ) VALUES (?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, gate_id, input_ref) DO NOTHING`,
        params: [
          this.workspaceId,
          childRunId,
          entryGate,
          pin.inputRef,
          null,
          contract.expectedArtifactKind,
        ],
      });
      statements.push({
        sql: `INSERT INTO workflow_gate_fills (
                workspace_id, run_id, gate_id, input_ref, artifact_run_id,
                artifact_id, artifact_revision, filled_at
              ) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, gate_id, input_ref)
              DO NOTHING`,
        params: [
          this.workspaceId,
          childRunId,
          entryGate,
          pin.inputRef,
          pin.artifactRunId,
          pin.artifactId,
          pin.artifactRevision,
          finishedAt,
        ],
      });
    }

    statements.push({
      sql: `INSERT INTO workflow_continuations (
              workspace_id, run_id, continuation_id, invocation_key, invocation_fingerprint,
              caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
              child_run_id, return_gate_id, kind, status, payload_json, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, continuation_id) DO NOTHING`,
      params: [
        this.workspaceId,
        continuationRunId,
        continuationId,
        childIdempotencyKey,
        invocationFingerprint,
        command.task.id,
        command.turn.id,
        callerRunId ?? null,
        callerNode?.nodeId ?? null,
        childRunId,
        returnGateId,
        'child_wait',
        'pending',
        JSON.stringify({
          childRunId,
          returnGateId,
          callerNodeId: callerNode?.nodeId,
          callerTaskId: command.task.id,
          childDefinitionId: disposition.childDefinitionId,
          childDefinitionVersion: disposition.childDefinitionVersion,
        }),
        finishedAt,
        finishedAt,
      ],
    });
    statements.push({
      sql: `INSERT INTO workflow_return_gates (
              workspace_id, return_gate_id, continuation_run_id, continuation_id,
              caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
              child_run_id, status, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)
            ON CONFLICT(workspace_id, return_gate_id) DO NOTHING`,
      params: [
        this.workspaceId,
        returnGateId,
        continuationRunId,
        continuationId,
        command.task.id,
        command.turn.id,
        callerRunId ?? null,
        callerNode?.nodeId ?? null,
        childRunId,
        finishedAt,
        finishedAt,
      ],
    });

    return { statements, changes };
  }

  /**
   * M018 S06: terminal child-node NEXT with a pending parent continuation resolves
   * that continuation once (child_return fence), fills the caller return gate, and
   * queues exactly one caller resume turn. Never seals child lifecycle.
   */
  private async planWorkflowChildReturn(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<WorkflowEffectPlan> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const disposition = command.turn.disposition;
    if (!disposition || disposition.kind !== 'workflow_next' || disposition.route !== undefined) {
      return empty;
    }

    const finishedAt = command.turn.finishedAt ?? new Date().toISOString();
    const childNode = await this.lookupWorkflowNodeForTask(command.task.id);
    if (!childNode) return empty;

    const childRun = await this.db.get<{
      origin: string;
      parent_run_id: string | null;
      definition_id: string;
      definition_version: number;
      status: string;
      max_aggregate_bytes: number;
    }>(
      `SELECT origin, parent_run_id, definition_id, definition_version, status, max_aggregate_bytes
         FROM workflow_runs
        WHERE workspace_id = ? AND run_id = ?`,
      [this.workspaceId, childNode.runId],
    );
    if (!childRun || childRun.origin !== 'child') {
      return empty;
    }
    if (childRun.status !== 'running') return empty;

    const def = await this.db.get<{ topology_json: string }>(
      `SELECT topology_json FROM workflow_definitions
        WHERE workspace_id = ? AND definition_id = ? AND version = ?`,
      [this.workspaceId, childRun.definition_id, childRun.definition_version],
    );
    if (!def) return empty;
    const topologyDecoded = decodeStoredTopologyJson(def.topology_json);
    if (!topologyDecoded.ok) return empty;
    const topology = topologyDecoded.topology;
    if (outgoingEdge(topology, childNode.nodeId)) {
      return empty;
    }
    try {
      if (terminalNodeId(topology) !== childNode.nodeId) return empty;
    } catch {
      // no forward edge already checked
    }

    const continuation = await this.db.get<{
      run_id: string;
      continuation_id: string;
      status: string;
      caller_task_id: string | null;
      caller_run_id: string | null;
      caller_node_id: string | null;
      return_gate_id: string | null;
    }>(
      `SELECT run_id, continuation_id, status, caller_task_id, caller_run_id,
              caller_node_id, return_gate_id
         FROM workflow_continuations
        WHERE workspace_id = ? AND child_run_id = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
      [this.workspaceId, childNode.runId],
    );
    if (!continuation) return empty;
    const callerRunId = continuation.caller_run_id ?? undefined;
    const callerScopeId = callerRunId ?? stableId('wfcaller', continuation.caller_task_id ?? 'missing');
    const routeRunId = callerRunId ?? childNode.runId;

    const returnFenceId = deriveChildReturnFenceId(childNode.runId);
    const existingFence = await this.db.get<{ message_id: string }>(
      `SELECT message_id FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [this.workspaceId, routeRunId, returnFenceId],
    );
    if (existingFence) return empty;

    const returnGateId =
      continuation.return_gate_id ?? deriveCallerReturnGateId(callerScopeId, childNode.runId);
    const resumeTurnId = deriveCallerResumeTurnId(callerScopeId, childNode.runId);
    const resumeMessageId = deriveCallerReturnMessageId(callerScopeId, childNode.runId);
    const callerTaskId = continuation.caller_task_id ?? undefined;
    if (!callerTaskId) return empty;
    const aggregatePolicyRun = callerRunId
      ? await this.db.get<{ max_aggregate_bytes: number }>(
          `SELECT max_aggregate_bytes FROM workflow_runs
            WHERE workspace_id = ? AND run_id = ?`,
          [this.workspaceId, callerRunId],
        )
      : childRun;
    if (!aggregatePolicyRun || !Number.isInteger(aggregatePolicyRun.max_aggregate_bytes)) {
      return empty;
    }
    const returnContent = `[workflow-child-return] childRunId=${childNode.runId} change=${disposition.change}\n${String(disposition.result ?? '')}`;
    if (Buffer.byteLength(returnContent, 'utf8') > aggregatePolicyRun.max_aggregate_bytes) {
      return this.planWorkflowFailClosure({
        runId: childNode.runId,
        reasonCode: 'aggregate_too_large',
        at: finishedAt,
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }

    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];

    statements.push({
      sql: `UPDATE workflow_continuations
              SET status = 'resolved',
                  outcome = 'succeeded',
                  result_artifact_run_id = ?,
                  result_artifact_id = ?,
                  result_artifact_revision = 1,
                  producing_turn_id = ?,
                  resolved_at = ?,
                  updated_at = ?,
                  payload_json = json_set(
                    COALESCE(payload_json, '{}'),
                    '$.resolvedAt', ?,
                    '$.resolvedByTurnId', ?,
                    '$.resolvedByNodeId', ?
                  )
            WHERE workspace_id = ? AND run_id = ? AND continuation_id = ?
              AND status = 'pending'`,
      params: [
        childNode.runId,
        stableChildReturnArtifactId(callerScopeId, childNode.runId),
        command.turn.id,
        finishedAt,
        finishedAt,
        finishedAt,
        command.turn.id,
        childNode.nodeId,
        this.workspaceId,
        continuation.run_id,
        continuation.continuation_id,
      ],
    });
    statements.push({
      sql: `UPDATE workflow_runs
               SET status = 'succeeded', updated_at = ?
             WHERE workspace_id = ? AND run_id = ? AND status = 'running'`,
      params: [finishedAt, this.workspaceId, childNode.runId],
    });

    const fenceBody = JSON.stringify({
      kind: 'child_return',
      childRunId: childNode.runId,
      parentRunId: callerRunId ?? null,
      continuationId: continuation.continuation_id,
      returnGateId,
      resumeTurnId,
      resumeMessageId,
      sourceTurnId: command.turn.id,
      change: disposition.change,
    });
    statements.push({
      sql: `INSERT INTO workflow_routed_messages (
              workspace_id, run_id, message_id, source_node_id, destination_node_id,
              kind, body_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
      params: [
        this.workspaceId,
        routeRunId,
        returnFenceId,
        childNode.nodeId,
        continuation.caller_node_id ?? 'caller',
        'child_return',
        fenceBody,
        finishedAt,
      ],
    });

    const returnArtifactId = stableChildReturnArtifactId(callerScopeId, childNode.runId);
    const returnPayload = JSON.stringify({
      kind: 'child_return',
      childRunId: childNode.runId,
      change: disposition.change,
      result: disposition.result ?? null,
      sourceTurnId: command.turn.id,
    });
    statements.push({
      sql: `INSERT INTO workflow_artifacts (
              workspace_id, run_id, artifact_id, producer_node_id, logical_name,
              revision, kind, payload_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT DO NOTHING`,
      params: [
        this.workspaceId,
        childNode.runId,
        returnArtifactId,
        childNode.nodeId,
        'child_return',
        1,
        'child_return',
        returnPayload,
        finishedAt,
      ],
    });
    statements.push(workflowNodeArtifactSourceStatement({
      workspaceId: this.workspaceId,
      runId: childNode.runId,
      artifactId: returnArtifactId,
      artifactRevision: 1,
      nodeId: childNode.nodeId,
      taskId: command.task.id,
      turnId: command.turn.id,
    }));
    const maxSeq = await this.db.get<{ max_seq: number | null }>(
      `SELECT MAX(sequence) AS max_seq FROM turns WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, callerTaskId],
    );
    const nextSeq = (maxSeq?.max_seq ?? -1) + 1;
    const resumeTurn = {
      id: resumeTurnId,
      taskId: callerTaskId,
      sequence: nextSeq,
      trigger: 'engine' as const,
      status: 'queued' as const,
      inputs: [{ kind: 'message' as const, messageId: resumeMessageId }],
      createdAt: finishedAt,
    };
    const resumeMessage = {
      id: resumeMessageId,
      taskId: callerTaskId,
      role: 'system' as const,
      content: returnContent,
      state: 'assigned' as const,
      turnId: resumeTurnId,
      createdAt: finishedAt,
    };
    statements.push(turnStatement(this.workspaceId, resumeTurn as any, false));
    statements.push(messageStatement(this.workspaceId, resumeMessage as any, false));
    statements.push(
      turnInputStatement(this.workspaceId, resumeTurnId, 0, {
        kind: 'message',
        messageId: resumeMessageId,
      }),
    );
    const returnActivationId = callerRunId && continuation.caller_node_id
      ? stableId('wfact', `${continuation.continuation_id}:return`)
      : undefined;
    if (returnActivationId && callerRunId && continuation.caller_node_id) {
      statements.push({
        sql: `INSERT INTO workflow_activations (
                workspace_id, run_id, activation_id, node_id, kind, status,
                source_gate_id, feedback_round_id, feedback_target_node_id,
                continuation_id, return_gate_id, inherited_feedback_round_id,
                inherited_feedback_target_node_id, primary_turn_id, message_id,
                execution_turn_id, created_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, activation_id) DO NOTHING`,
        params: [
          this.workspaceId,
          callerRunId,
          returnActivationId,
          continuation.caller_node_id,
          'child_return',
          'queued',
          null,
          null,
          null,
          continuation.continuation_id,
          returnGateId,
          null,
          null,
          resumeTurnId,
          resumeMessageId,
          resumeTurnId,
          finishedAt,
          finishedAt,
        ],
      });
    }
    statements.push({
      sql: `UPDATE workflow_return_gates
               SET status = 'satisfied', result_run_id = ?, result_artifact_id = ?,
                   result_artifact_revision = 1, return_activation_run_id = ?,
                   return_activation_id = ?, return_message_id = ?, execution_turn_id = ?,
                   updated_at = ?
             WHERE workspace_id = ? AND return_gate_id = ? AND status = 'open'`,
      params: [
        childNode.runId,
        returnArtifactId,
        returnActivationId ? callerRunId ?? null : null,
        returnActivationId ?? null,
        resumeMessageId,
        resumeTurnId,
        finishedAt,
        this.workspaceId,
        returnGateId,
      ],
    });
    changes.push(
      { kind: 'turn', id: resumeTurnId, taskId: callerTaskId, change: 'insert' },
      { kind: 'message', id: resumeMessageId, taskId: callerTaskId, change: 'complete' },
      { kind: 'task', id: callerTaskId, change: 'effect' },
    );

    return {
      statements,
      changes,
      ...(callerRunId
        ? { turnReservations: [{ runId: callerRunId, taskId: callerTaskId, count: 1 }] }
        : {}),
    };
  }

  private async planWorkflowFailFromSettle(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
  ): Promise<{ statements: SqlStatement[]; changes: ChangeRecord[] }> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const disposition = command.turn.disposition;
    const finishedAt = command.turn.finishedAt ?? new Date().toISOString();

    // Explicit workflow_fail disposition on a successful settle.
    if (
      disposition
      && disposition.kind === 'workflow_fail'
      && command.turn.status === 'succeeded'
    ) {
      const node = await this.lookupWorkflowNodeForTask(command.task.id);
      if (!node) return empty;
      return this.planWorkflowFailClosure({
        runId: node.runId,
        reasonCode: 'agent_fail',
        reasonText: boundWorkflowFailReason(disposition.reason),
        at: finishedAt,
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }

    if (
      disposition?.kind === 'workflow_next'
      && disposition.change === 'updated'
      && typeof disposition.result === 'string'
      && command.turn.status === 'succeeded'
    ) {
      const node = await this.lookupWorkflowNodeForTask(command.task.id);
      if (node) {
        const run = await this.db.get<{ max_artifact_bytes: number }>(
          `SELECT CAST(json_extract(policy_json, '$.maxArtifactBytes') AS INTEGER)
                    AS max_artifact_bytes
             FROM workflow_runs
            WHERE workspace_id = ? AND run_id = ? AND status = 'running'`,
          [this.workspaceId, node.runId],
        );
        if (
          run
          && Buffer.byteLength(disposition.result, 'utf8') > run.max_artifact_bytes
        ) {
          return this.planWorkflowFailClosure({
            runId: node.runId,
            reasonCode: 'aggregate_too_large',
            at: finishedAt,
            sourceTaskId: command.task.id,
            sourceTurnId: command.turn.id,
          });
        }
      }
    }

    // Run-timeout termination on a non-success settle still closes the workflow run.
    if (command.turn.termination?.kind === 'run_timeout') {
      const node = await this.lookupWorkflowNodeForTask(command.task.id);
      if (!node) return empty;
      return this.planWorkflowFailClosure({
        runId: node.runId,
        reasonCode: 'run_timeout',
        at: finishedAt,
        sourceTaskId: command.task.id,
        sourceTurnId: command.turn.id,
      });
    }

    return empty;
  }

  /**
   * M018 S05: reserve frozen feedback/turn capacity before creating an effect.
   * The configured maximum permits exactly that many units; the next reservation
   * closes the run without committing the successful route that requested it.
   */
  private async planWorkflowBudgetExhaustionIfNeeded(
    command: Extract<RepositoryCommand, { kind: 'settleTurnAndApplyEffects' }>,
    reservations: {
      feedbackRounds: WorkflowRunReservation[];
      workflowTurns: WorkflowTurnReservation[];
    },
  ): Promise<{ statements: SqlStatement[]; changes: ChangeRecord[]; exhausted: boolean }> {
    const empty = {
      statements: [] as SqlStatement[],
      changes: [] as ChangeRecord[],
      exhausted: false,
    };
    if (reservations.feedbackRounds.length === 0 && reservations.workflowTurns.length === 0) {
      return empty;
    }
    const feedbackByRun = sumWorkflowRunReservations(reservations.feedbackRounds);
    const turnsByRun = sumWorkflowRunReservations(
      reservations.workflowTurns.map(({ runId, count }) => ({ runId, count })),
    );
    const turnsByTask = sumWorkflowTurnReservations(reservations.workflowTurns);
    const runIds = [...new Set([...feedbackByRun.keys(), ...turnsByRun.keys()])].sort();
    const settlingNode = await this.lookupWorkflowNodeForTask(command.task.id);
    const at = command.turn.finishedAt ?? new Date().toISOString();
    const statements: SqlStatement[] = [];

    for (const runId of runIds) {
      const run = await this.db.get<{
        status: string;
        max_feedback_rounds: number;
        max_turns_per_task: number;
        max_workflow_turns: number;
        feedback_rounds_reserved: number;
        workflow_turns_reserved: number;
      }>(
        `SELECT status, max_feedback_rounds, max_turns_per_task, max_workflow_turns,
                feedback_rounds_reserved, workflow_turns_reserved
           FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        [this.workspaceId, runId],
      );
      if (!run || run.status !== 'running') continue;
      const feedbackRounds = feedbackByRun.get(runId) ?? 0;
      const workflowTurns = turnsByRun.get(runId) ?? 0;
      if (run.feedback_rounds_reserved + feedbackRounds > run.max_feedback_rounds) {
        const closure = await this.planWorkflowFailClosure({
          runId,
          reasonCode: 'feedback_budget_exhausted',
          at,
          ...(settlingNode?.runId === runId
            ? { sourceTaskId: command.task.id, sourceTurnId: command.turn.id }
            : {}),
        });
        return { ...closure, exhausted: true };
      }
      if (run.workflow_turns_reserved + workflowTurns > run.max_workflow_turns) {
        const closure = await this.planWorkflowFailClosure({
          runId,
          reasonCode: 'turn_budget_exhausted',
          at,
          ...(settlingNode?.runId === runId
            ? { sourceTaskId: command.task.id, sourceTurnId: command.turn.id }
            : {}),
        });
        return { ...closure, exhausted: true };
      }
      for (const reservation of turnsByTask.values()) {
        if (reservation.runId !== runId) continue;
        const count = await this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM turns WHERE workspace_id = ? AND task_id = ?`,
          [this.workspaceId, reservation.taskId],
        );
        if ((count?.count ?? 0) + reservation.count > run.max_turns_per_task) {
          const closure = await this.planWorkflowFailClosure({
            runId,
            reasonCode: 'turn_budget_exhausted',
            at,
            ...(settlingNode?.runId === runId
              ? { sourceTaskId: command.task.id, sourceTurnId: command.turn.id }
              : {}),
          });
          return { ...closure, exhausted: true };
        }
      }
      statements.push({
        sql: `UPDATE workflow_runs
                 SET feedback_rounds_reserved = feedback_rounds_reserved + ?,
                     workflow_turns_reserved = workflow_turns_reserved + ?,
                     updated_at = ?
               WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                 AND feedback_rounds_reserved + ? <= max_feedback_rounds
                 AND workflow_turns_reserved + ? <= max_workflow_turns`,
        params: [
          feedbackRounds,
          workflowTurns,
          at,
          this.workspaceId,
          runId,
          feedbackRounds,
          workflowTurns,
        ],
      });
    }
    return { statements, changes: [], exhausted: false };
  }

  private async lookupWorkflowNodeForTask(
    taskId: string,
  ): Promise<{ runId: string; nodeId: string } | undefined> {
    const row = await this.db.get<{ run_id: string; node_id: string }>(
      `SELECT run_id, node_id FROM workflow_nodes
        WHERE workspace_id = ? AND task_id = ?`,
      [this.workspaceId, taskId],
    );
    if (!row || typeof row.run_id !== 'string' || typeof row.node_id !== 'string') {
      return undefined;
    }
    return { runId: row.run_id, nodeId: row.node_id };
  }

  private async reapWorkflowTimeouts(
    command: Extract<RepositoryCommand, { kind: 'reapWorkflowTimeouts' }>,
  ): Promise<RepositoryCommandResult> {
    const expired = await this.db.all<{ run_id: string }>(
      `SELECT run_id FROM workflow_runs
        WHERE workspace_id = ? AND status = 'running'
          AND deadline_at IS NOT NULL AND deadline_at <= ?
        ORDER BY deadline_at, run_id`,
      [this.workspaceId, command.now],
    );
    if (expired.length === 0) return { ok: true, changed: false };
    const closure = await this.planWorkflowRecursiveClosure({
      runIds: expired.map((run) => run.run_id),
      reasonCode: 'run_timeout',
      at: command.now,
    });
    const [first, ...rest] = closure.statements;
    if (!first) return { ok: true, changed: false };
    const changes = [
      ...new Map(closure.changes.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values(),
    ];
    const results = await this.writeIfFirstChanged(first, rest, changes, command.now);
    return { ok: true, changed: (results[0]?.changes ?? 0) > 0 };
  }

  private async recoverWorkflowActivation(
    command: Extract<RepositoryCommand, { kind: 'recoverWorkflowActivation' }>,
  ): Promise<RepositoryCommandResult> {
    const operationId = command.recoveryOperationId.trim();
    const instruction = command.instruction.trim();
    if (
      !operationId || operationId.length > 256 || /[\u0000-\u001f\u007f]/.test(operationId)
      || !command.fingerprint || command.fingerprint.length > 4096
      || !instruction || Buffer.byteLength(instruction, 'utf8') > 4096
    ) {
      return { ok: true, changed: false, reason: 'invalid workflow recovery request' };
    }
    const oldTurn = await this.getTurn(command.failedTurnId);
    if (!oldTurn) return { ok: true, changed: false, reason: 'workflow activation is no longer recoverable' };
    const sequence = (await this.getMaxTurnSequence(oldTurn.taskId)) + 1;
    const turnId = stableId(
      'wftn',
      `${command.runId}\0activation_recovery\0${command.activationId}\0${operationId}`,
    );
    const ledgerKey = `${turnId}:workflow-recovery:${operationId}`;
    const turn: TaskTurn = {
      id: turnId,
      taskId: oldTurn.taskId,
      sequence,
      status: 'queued',
      trigger: 'retry',
      retryOf: oldTurn.id,
      inputs: [
        ...oldTurn.inputs,
        { kind: 'recovery', interruptedTurnId: oldTurn.id, instruction },
      ],
      createdAt: command.createdAt,
    };
    const result = { ok: true, data: { runId: command.runId, activationId: command.activationId, turnId } };
    const claim: SqlStatement = {
      sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
            SELECT ?, ?, ?, ?, ?
              FROM workflow_activations activation
              JOIN workflow_runs run
                ON run.workspace_id = activation.workspace_id AND run.run_id = activation.run_id
              JOIN workflow_nodes node
                ON node.workspace_id = activation.workspace_id
               AND node.run_id = activation.run_id AND node.node_id = activation.node_id
              JOIN turns source_turn
                ON source_turn.workspace_id = activation.workspace_id
               AND source_turn.id = activation.execution_turn_id
               AND source_turn.task_id = node.task_id
             WHERE activation.workspace_id = ? AND activation.run_id = ?
               AND activation.activation_id = ? AND activation.execution_turn_id = ?
               AND activation.status = ? AND source_turn.status = ?
               AND run.status = 'running'
               AND (run.deadline_at IS NULL OR run.deadline_at > ?)
                AND (SELECT COUNT(*) FROM turns task_turn
                       WHERE task_turn.workspace_id = source_turn.workspace_id
                         AND task_turn.task_id = source_turn.task_id) < run.max_turns_per_task
                AND run.workflow_turns_reserved < run.max_workflow_turns
               AND NOT EXISTS (
                 SELECT 1 FROM turns competing
                  WHERE competing.workspace_id = source_turn.workspace_id
                    AND competing.task_id = source_turn.task_id
                    AND competing.status IN ('queued', 'running', 'waiting_user')
               )
            ON CONFLICT(workspace_id, ledger_key) DO NOTHING`,
      params: [
        this.workspaceId,
        ledgerKey,
        command.fingerprint,
        encodePayload({ result }),
        command.createdAt,
        this.workspaceId,
        command.runId,
        command.activationId,
        command.failedTurnId,
        command.expectedActivationStatus,
        command.expectedActivationStatus,
        command.createdAt,
      ],
    };
    let results: readonly import('./sqlite/rpc').RunResult[];
    try {
      results = await this.writeIfFirstChanged(
        claim,
        [
          {
            sql: `UPDATE workflow_runs
                     SET workflow_turns_reserved = workflow_turns_reserved + 1,
                         updated_at = ?
                   WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                     AND workflow_turns_reserved < max_workflow_turns`,
            params: [command.createdAt, this.workspaceId, command.runId],
          },
          turnStatement(this.workspaceId, turn, false),
          ...turn.inputs.map((input, ordering) =>
            turnInputStatement(this.workspaceId, turn.id, ordering, input)),
          {
            sql: `UPDATE workflow_activations
                     SET status = 'queued', execution_turn_id = ?, updated_at = ?
                   WHERE workspace_id = ? AND run_id = ? AND activation_id = ?
                     AND execution_turn_id = ? AND status = ?`,
            params: [
              turn.id,
              command.createdAt,
              this.workspaceId,
              command.runId,
              command.activationId,
              command.failedTurnId,
              command.expectedActivationStatus,
            ],
          },
        ],
        [
          { kind: 'operation', id: ledgerKey, change: 'insert' },
          { kind: 'turn', id: turn.id, taskId: turn.taskId, change: 'insert' },
        ],
        command.createdAt,
      );
    } catch (error) {
      const winner = await this.db.get<{ status: string; execution_turn_id: string }>(
        `SELECT status, execution_turn_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ? AND activation_id = ?`,
        [this.workspaceId, command.runId, command.activationId],
      );
      if (
        winner?.status === 'queued'
        && winner.execution_turn_id !== command.failedTurnId
      ) {
        return { ok: true, changed: false, reason: 'workflow activation is no longer recoverable' };
      }
      throw error;
    }
    const inserted = (results[0]?.changes ?? 0) > 0;
    const row = await this.db.get<OperationRow>(
      `SELECT ledger_key, fingerprint, result_json FROM operations
        WHERE workspace_id = ? AND ledger_key = ?`,
      [this.workspaceId, ledgerKey],
    );
    if (!row) {
      return { ok: true, changed: false, reason: 'workflow activation is no longer recoverable' };
    }
    const operation = decodeOperation(row);
    if (operation.fingerprint !== command.fingerprint) {
      return {
        ok: true,
        changed: false,
        conflict: true,
        reason: 'operation fingerprint conflict',
        operation,
      };
    }
    return { ok: true, changed: inserted, operation };
  }

  private async planWorkflowClosureFromTasks(input: {
    taskIds: readonly string[];
    reasonCode: WorkflowFailReasonCode;
    at: string;
  }): Promise<{ statements: SqlStatement[]; changes: ChangeRecord[] }> {
    if (input.taskIds.length === 0) {
      return { statements: [], changes: [] };
    }
    const taskPlaceholders = input.taskIds.map(() => '?').join(',');
    const rows = await this.db.all<{ run_id: string }>(
      `SELECT DISTINCT node.run_id
         FROM workflow_nodes node
         JOIN workflow_runs run
           ON run.workspace_id = node.workspace_id AND run.run_id = node.run_id
        WHERE node.workspace_id = ? AND node.task_id IN (${taskPlaceholders})
          AND run.status = 'running'`,
      [this.workspaceId, ...input.taskIds],
    );
    return this.planWorkflowRecursiveClosure({
      runIds: rows.map((row) => row.run_id),
      reasonCode: input.reasonCode,
      at: input.at,
    });
  }

  /**
   * M018 §20.11: one transaction plan closes the complete caller/child run component,
   * its waits and activations, and every continuation boundary exactly once.
   */
  private async planWorkflowFailClosure(input: {
    runId: string;
    reasonCode: WorkflowFailReasonCode;
    reasonText?: string;
    at: string;
    sourceTaskId?: string;
    sourceTurnId?: string;
  }): Promise<{ statements: SqlStatement[]; changes: ChangeRecord[] }> {
    return this.planWorkflowRecursiveClosure({
      runIds: [input.runId],
      reasonCode: input.reasonCode,
      reasonText: input.reasonText,
      at: input.at,
      sourceTaskId: input.sourceTaskId,
      sourceTurnId: input.sourceTurnId,
    });
  }

  private async planWorkflowRecursiveClosure(input: {
    runIds: readonly string[];
    reasonCode: WorkflowFailReasonCode;
    reasonText?: string;
    at: string;
    sourceTaskId?: string;
    sourceTurnId?: string;
  }): Promise<{ statements: SqlStatement[]; changes: ChangeRecord[] }> {
    const empty = { statements: [] as SqlStatement[], changes: [] as ChangeRecord[] };
    const seedRunIds = [...new Set(input.runIds)].filter((runId) => runId.length > 0).sort();
    if (seedRunIds.length === 0) return empty;
    const seedPlaceholders = seedRunIds.map(() => '?').join(',');
    const runs = await this.db.all<{
      run_id: string;
      parent_run_id: string | null;
      owner_root_task_id: string | null;
      caller_task_id: string | null;
    }>(
      `WITH RECURSIVE
         ancestors(run_id) AS (
           SELECT run_id
             FROM workflow_runs
            WHERE workspace_id = ? AND run_id IN (${seedPlaceholders}) AND status = 'running'
           UNION
           SELECT parent.run_id
             FROM ancestors current
             JOIN workflow_runs child
               ON child.workspace_id = ? AND child.run_id = current.run_id
             JOIN workflow_runs parent
               ON parent.workspace_id = child.workspace_id AND parent.run_id = child.parent_run_id
            WHERE parent.status = 'running'
         ),
         related(run_id) AS (
           SELECT run_id FROM ancestors
           UNION
           SELECT child.run_id
             FROM related current
             JOIN workflow_runs child
               ON child.workspace_id = ? AND child.parent_run_id = current.run_id
            WHERE child.status = 'running'
         )
       SELECT run.run_id, run.parent_run_id, run.owner_root_task_id, run.caller_task_id
         FROM workflow_runs run
         JOIN related ON related.run_id = run.run_id
        WHERE run.workspace_id = ? AND run.status = 'running'
        ORDER BY run.created_at, run.run_id`,
      [this.workspaceId, ...seedRunIds, this.workspaceId, this.workspaceId, this.workspaceId],
    );
    if (runs.length === 0) return empty;

    const terminalStatus = workflowRunTerminalStatusForReason(input.reasonCode);
    const attentionCode = workflowRunAttentionCode(terminalStatus);
    const runIds = runs.map((run) => run.run_id);
    const runIdSet = new Set(runIds);
    const runPlaceholders = runIds.map(() => '?').join(',');
    const statements: SqlStatement[] = [];
    const changes: ChangeRecord[] = [];

    for (const run of runs) {
      const fenceId = deriveRunClosureFenceId(run.run_id, terminalStatus);
      statements.push({
        sql: `INSERT INTO workflow_routed_messages (
                workspace_id, run_id, message_id, source_node_id, destination_node_id,
                kind, body_json, created_at
              ) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id, run_id, message_id) DO NOTHING`,
        params: [
          this.workspaceId,
          run.run_id,
          fenceId,
          'engine',
          'engine',
          'run_closure',
          encodePayload({
            kind: 'run_closure',
            schema: 1,
            reasonCode: input.reasonCode,
            terminalStatus,
          }),
          input.at,
        ],
      });
    }

    statements.push(
      {
        sql: `UPDATE workflow_dependency_gates SET status = ?
               WHERE workspace_id = ? AND run_id IN (${runPlaceholders})
                 AND status IN ('open', 'satisfied')`,
        params: [terminalStatus, this.workspaceId, ...runIds],
      },
      {
        sql: `UPDATE workflow_feedback_rounds SET status = ?, updated_at = ?
               WHERE workspace_id = ? AND run_id IN (${runPlaceholders})
                 AND status IN ('open', 'satisfied')`,
        params: [terminalStatus, input.at, this.workspaceId, ...runIds],
      },
      {
        sql: `UPDATE workflow_activations SET status = ?, updated_at = ?
               WHERE workspace_id = ? AND run_id IN (${runPlaceholders})
                 AND status IN ('queued', 'running', 'failed', 'interrupted')`,
        params: [terminalStatus, input.at, this.workspaceId, ...runIds],
      },
      {
        sql: `UPDATE workflow_continuations
                 SET status = ?, outcome = ?, reason_code = ?,
                     result_artifact_run_id = NULL, result_artifact_id = NULL,
                     result_artifact_revision = NULL, producing_turn_id = NULL,
                     resolved_at = ?, updated_at = ?,
                     payload_json = json_set(
                       COALESCE(payload_json, '{}'),
                       '$.failedAt', ?, '$.reasonCode', ?, '$.terminalStatus', ?
                     )
               WHERE workspace_id = ? AND status IN ('pending', 'resolved')
                 AND (child_run_id IN (${runPlaceholders}) OR caller_run_id IN (${runPlaceholders}))`,
        params: [
          terminalStatus,
          terminalStatus,
          input.reasonCode,
          input.at,
          input.at,
          input.at,
          input.reasonCode,
          terminalStatus,
          this.workspaceId,
          ...runIds,
          ...runIds,
        ],
      },
      {
        sql: `UPDATE workflow_return_gates
                 SET status = ?, result_run_id = NULL, result_artifact_id = NULL,
                     result_artifact_revision = NULL, updated_at = ?
               WHERE workspace_id = ? AND status IN ('open', 'satisfied')
                 AND (child_run_id IN (${runPlaceholders}) OR caller_run_id IN (${runPlaceholders}))`,
        params: [terminalStatus, input.at, this.workspaceId, ...runIds, ...runIds],
      },
    );

    for (const run of runs) {
      statements.push({
        sql: `UPDATE workflow_runs
                SET status = ?, terminal_reason_code = ?, closure_id = ?, updated_at = ?
              WHERE workspace_id = ? AND run_id = ? AND status = 'running'`,
        params: [
          terminalStatus,
          input.reasonCode,
          deriveRunClosureFenceId(run.run_id, terminalStatus),
          input.at,
          this.workspaceId,
          run.run_id,
        ],
      });
    }

    const turns = await this.db.all<{ id: string; task_id: string; status: string }>(
      `SELECT turn.id, turn.task_id, turn.status
         FROM turns turn
         JOIN workflow_nodes node
           ON node.workspace_id = turn.workspace_id AND node.task_id = turn.task_id
        WHERE turn.workspace_id = ? AND node.run_id IN (${runPlaceholders})
          AND turn.status IN ('queued', 'running', 'waiting_user')`,
      [this.workspaceId, ...runIds],
    );
    const closureOpId = deriveRunClosureFenceId(runIds[0]!, terminalStatus);
    for (const turn of turns) {
      if (input.sourceTurnId && turn.id === input.sourceTurnId) continue;
      if (turn.status === 'queued') {
        statements.push({
          sql: `UPDATE turns SET status = 'cancelled', settled_at = ?
                 WHERE workspace_id = ? AND id = ? AND status = 'queued'`,
          params: [input.at, this.workspaceId, turn.id],
        });
        changes.push({ kind: 'turn', id: turn.id, taskId: turn.task_id, change: 'effect' });
      } else {
        statements.push(cancelRequestStatement(this.workspaceId, {
          kind: 'putCancelRequest',
          workspaceId: this.workspaceId,
          turnId: turn.id,
          request: {
            kind: 'interrupt',
            by: 'workflow_fail_closure',
            opId: closureOpId,
            at: input.at,
            reason: input.reasonCode,
          },
        }));
        changes.push({ kind: 'cancel_request', id: turn.id, change: 'put' });
      }
    }

    const outerRun = runs.find((run) => !run.parent_run_id || !runIdSet.has(run.parent_run_id)) ?? runs[0]!;
    let attentionTaskId = outerRun.owner_root_task_id ?? outerRun.caller_task_id ?? undefined;
    if (!attentionTaskId) {
      const node = await this.db.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
          ORDER BY node_id LIMIT 1`,
        [this.workspaceId, outerRun.run_id],
      );
      attentionTaskId = node?.task_id ?? input.sourceTaskId;
    }
    if (attentionTaskId) {
      const attentionMessage = (
        input.reasonText ? `${input.reasonCode}: ${input.reasonText}` : input.reasonCode
      ).slice(0, 512);
      statements.push({
        sql: `UPDATE tasks
                 SET payload_json = json_set(payload_json, '$.attention', json(?)),
                     updated_at = ?, revision = revision + 1
               WHERE workspace_id = ? AND id = ? AND lifecycle = 'open'`,
        params: [
          JSON.stringify({ code: attentionCode, message: attentionMessage, at: input.at }),
          input.at,
          this.workspaceId,
          attentionTaskId,
        ],
      });
      changes.push({ kind: 'task', id: attentionTaskId, change: 'effect' });
    }

    return { statements, changes };
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
          sql: `DELETE FROM operations
                 WHERE workspace_id = ? AND ledger_key GLOB ?
                   AND NOT EXISTS (
                     SELECT 1 FROM turns
                      WHERE workspace_id = operations.workspace_id AND id = ?
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM workflow_artifact_sources source
                      WHERE source.workspace_id = operations.workspace_id
                        AND source.engine_start_operation_key = operations.ledger_key
                   )`,
          params: [this.workspaceId, `${escapeGlob(turnId)}:*`, turnId],
        })),
      ];
      const results = await this.writeIfFirstChanged(
        {
          sql: `WITH retention_scope(workspace_id) AS (VALUES (?)),
                     prunable_runs(run_id) AS (
                       SELECT run.run_id
                         FROM retention_scope scope
                         JOIN workflow_runs run
                           ON run.workspace_id = scope.workspace_id
                        WHERE run.status IN ('succeeded', 'failed', 'cancelled')
                          AND NOT EXISTS (
                            SELECT 1 FROM workflow_runs child
                             WHERE child.workspace_id = run.workspace_id
                               AND child.parent_run_id = run.run_id
                          )
                          AND NOT EXISTS (
                            SELECT 1
                              FROM workflow_nodes node
                              JOIN tasks task
                                ON task.workspace_id = node.workspace_id
                               AND task.id = node.task_id
                             WHERE node.workspace_id = run.workspace_id
                               AND node.run_id = run.run_id
                               AND task.lifecycle NOT IN ('succeeded', 'failed', 'cancelled', 'skipped')
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM workflow_dependency_gates gate_row
                             WHERE gate_row.workspace_id = run.workspace_id
                               AND gate_row.run_id = run.run_id
                               AND gate_row.status IN ('open', 'satisfied')
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM workflow_feedback_rounds round_row
                             WHERE round_row.workspace_id = run.workspace_id
                               AND round_row.run_id = run.run_id
                               AND round_row.status IN ('open', 'satisfied')
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM workflow_activations activation
                             WHERE activation.workspace_id = run.workspace_id
                               AND activation.run_id = run.run_id
                               AND activation.status IN ('queued', 'running')
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM workflow_continuations continuation
                             WHERE continuation.workspace_id = run.workspace_id
                               AND (continuation.run_id = run.run_id OR continuation.child_run_id = run.run_id)
                               AND continuation.status IN ('pending', 'resolved')
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM workflow_return_gates return_gate
                             WHERE return_gate.workspace_id = run.workspace_id
                               AND (return_gate.continuation_run_id = run.run_id
                                 OR return_gate.child_run_id = run.run_id)
                               AND return_gate.status IN ('open', 'satisfied')
                          )
                     ),
                     pinned_turns(turn_id) AS (
                       SELECT candidate.id
                         FROM retention_scope scope
                         JOIN workflow_nodes node
                           ON node.workspace_id = scope.workspace_id
                         JOIN workflow_runs run
                           ON run.workspace_id = node.workspace_id
                          AND run.run_id = node.run_id
                         JOIN turns candidate
                           ON candidate.workspace_id = node.workspace_id
                          AND candidate.task_id = node.task_id
                        WHERE run.status = 'running'
                       UNION ALL
                       SELECT run.caller_turn_id
                         FROM retention_scope scope
                         JOIN workflow_runs run
                           ON run.workspace_id = scope.workspace_id
                        WHERE run.status = 'running'
                       UNION ALL
                       SELECT claim.caller_turn_id
                         FROM retention_scope scope
                         JOIN workflow_start_claims claim
                           ON claim.workspace_id = scope.workspace_id
                         JOIN workflow_runs run
                           ON run.workspace_id = claim.workspace_id
                          AND run.run_id = claim.run_id
                        WHERE run.status = 'running'
                       UNION ALL
                       SELECT activation.primary_turn_id
                         FROM retention_scope scope
                         JOIN workflow_activations activation
                           ON activation.workspace_id = scope.workspace_id
                        WHERE activation.status IN ('queued', 'running', 'failed', 'interrupted')
                           AND activation.run_id NOT IN (SELECT run_id FROM prunable_runs)
                       UNION ALL
                       SELECT activation.execution_turn_id
                         FROM retention_scope scope
                         JOIN workflow_activations activation
                           ON activation.workspace_id = scope.workspace_id
                        WHERE activation.status IN ('queued', 'running', 'failed', 'interrupted')
                           AND activation.run_id NOT IN (SELECT run_id FROM prunable_runs)
                       UNION ALL
                       SELECT gate.reserved_turn_id
                         FROM retention_scope scope
                         JOIN workflow_dependency_gates gate
                           ON gate.workspace_id = scope.workspace_id
                        WHERE gate.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT round_row.requester_turn_id
                         FROM retention_scope scope
                         JOIN workflow_feedback_rounds round_row
                           ON round_row.workspace_id = scope.workspace_id
                        WHERE round_row.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT round_row.resume_turn_id
                         FROM retention_scope scope
                         JOIN workflow_feedback_rounds round_row
                           ON round_row.workspace_id = scope.workspace_id
                        WHERE round_row.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT target.request_turn_id
                         FROM retention_scope scope
                         JOIN workflow_feedback_rounds round_row
                           ON round_row.workspace_id = scope.workspace_id
                         JOIN workflow_feedback_targets target
                           ON target.workspace_id = round_row.workspace_id
                          AND target.run_id = round_row.run_id
                          AND target.round_id = round_row.round_id
                        WHERE round_row.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT target.response_turn_id
                         FROM retention_scope scope
                         JOIN workflow_feedback_rounds round_row
                           ON round_row.workspace_id = scope.workspace_id
                         JOIN workflow_feedback_targets target
                           ON target.workspace_id = round_row.workspace_id
                          AND target.run_id = round_row.run_id
                          AND target.round_id = round_row.round_id
                        WHERE round_row.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT routed.source_turn_id
                         FROM retention_scope scope
                         JOIN workflow_routed_messages routed
                           ON routed.workspace_id = scope.workspace_id
                         JOIN workflow_runs run
                           ON run.workspace_id = routed.workspace_id
                          AND run.run_id = routed.run_id
                        WHERE run.status = 'running'
                       UNION ALL
                       SELECT continuation.caller_turn_id
                         FROM retention_scope scope
                         JOIN workflow_continuations continuation
                           ON continuation.workspace_id = scope.workspace_id
                        WHERE continuation.status IN ('pending', 'resolved')
                       UNION ALL
                       SELECT continuation.producing_turn_id
                         FROM retention_scope scope
                         JOIN workflow_continuations continuation
                           ON continuation.workspace_id = scope.workspace_id
                        WHERE continuation.status IN ('pending', 'resolved')
                       UNION ALL
                       SELECT return_gate.caller_turn_id
                         FROM retention_scope scope
                         JOIN workflow_return_gates return_gate
                           ON return_gate.workspace_id = scope.workspace_id
                        WHERE return_gate.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT return_gate.execution_turn_id
                         FROM retention_scope scope
                         JOIN workflow_return_gates return_gate
                           ON return_gate.workspace_id = scope.workspace_id
                        WHERE return_gate.status IN ('open', 'satisfied')
                       UNION ALL
                       SELECT source.producing_turn_id
                         FROM retention_scope scope
                         JOIN workflow_artifact_sources source
                           ON source.workspace_id = scope.workspace_id
                        WHERE source.run_id NOT IN (SELECT run_id FROM prunable_runs)
                       UNION ALL
                       SELECT source.caller_turn_id
                         FROM retention_scope scope
                         JOIN workflow_artifact_sources source
                           ON source.workspace_id = scope.workspace_id
                        WHERE source.run_id NOT IN (SELECT run_id FROM prunable_runs)
                       UNION ALL
                       SELECT claim.turn_id
                         FROM retention_scope scope
                         JOIN turn_disposition_claims claim
                           ON claim.workspace_id = scope.workspace_id
                        WHERE claim.status = 'staged'
                     )
                 DELETE FROM turns
                 WHERE workspace_id = ? AND task_id = ? AND id IN (${placeholders(drop.length)})
                   AND NOT EXISTS (
                     SELECT 1 FROM pinned_turns WHERE turn_id = turns.id
                   )
                    AND EXISTS (
                      SELECT 1 FROM tasks
                       WHERE workspace_id = ? AND id = ?
                         AND lifecycle IN ('succeeded', 'failed', 'cancelled', 'skipped')
                    )`,
          params: [this.workspaceId, this.workspaceId, task.id, ...drop, this.workspaceId, task.id],
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
  | 'runtime_claim' | 'send_outbox' | 'presentation';

interface SendOutboxRow {
  client_request_id: string;
  status: string;
  task_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface PresentationRow {
  presentation_id: string;
  owner_task_id: string;
  root_id: string;
  revision: number;
  title: string;
  markdown: string;
  payload_json: string;
  updated_at: string;
}

function validateSendOutboxEntry(entry: SendOutboxEntry): void {
  const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
  const payloadKeys = new Set([
    'version', 'text', 'llmText', 'mentionBindings', 'skills', 'backend', 'model', 'continuationOf',
  ]);
  if (
    !entry.clientRequestId ||
    entry.clientRequestId.length > 256 ||
    !stableId.test(entry.clientRequestId)
  ) {
    throw new Error('send outbox clientRequestId invalid');
  }
  if (entry.taskId !== undefined && (!entry.taskId || entry.taskId.length > 256 || !stableId.test(entry.taskId))) {
    throw new Error('send outbox taskId invalid');
  }
  if (entry.status !== 'pending' && entry.status !== 'rejected') {
    throw new Error('send outbox status invalid');
  }
  if (!Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))) {
    throw new Error('send outbox timestamp invalid');
  }
  const payload = entry.payload;
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => !payloadKeys.has(key)) ||
    payload.version !== SEND_OUTBOX_PAYLOAD_VERSION
  ) {
    throw new Error('send outbox payload version invalid');
  }
  if (
    typeof payload.text !== 'string' ||
    payload.text.length === 0 ||
    payload.text.length > SEND_OUTBOX_TEXT_MAX ||
    payload.text.includes('\0')
  ) {
    throw new Error('send outbox text invalid');
  }
  if (payload.llmText !== undefined) {
    if (
      typeof payload.llmText !== 'string' ||
      payload.llmText.length === 0 ||
      payload.llmText.length > SEND_OUTBOX_TEXT_MAX ||
      payload.llmText.includes('\0')
    ) {
      throw new Error('send outbox llmText invalid');
    }
  }
  if (payload.mentionBindings !== undefined) {
    const labels = new Set<string>();
    if (
      !Array.isArray(payload.mentionBindings) ||
      payload.mentionBindings.length > SEND_OUTBOX_MENTION_BINDINGS_MAX ||
      payload.mentionBindings.some((binding) =>
        !Array.isArray(binding) ||
        binding.length !== 2 ||
        typeof binding[0] !== 'string' ||
        binding[0].length === 0 ||
        binding[0].length > 512 ||
        /[\0\r\n]/.test(binding[0]) ||
        typeof binding[1] !== 'string' ||
        binding[1].length === 0 ||
        binding[1].length > SEND_OUTBOX_PATH_MAX ||
        /[\0\r\n]/.test(binding[1]) ||
        labels.has(binding[0]) ||
        !labels.add(binding[0])
      )
    ) {
      throw new Error('send outbox mention bindings invalid');
    }
  }
  if (payload.skills !== undefined) {
    const skills = new Set<string>();
    if (
      !Array.isArray(payload.skills) ||
      payload.skills.length > SEND_OUTBOX_SKILLS_MAX ||
      payload.skills.some((skill) =>
        typeof skill !== 'string' ||
        skill.length === 0 ||
        skill.length > 128 ||
        !stableId.test(skill) ||
        skills.has(skill) ||
        !skills.add(skill)
      )
    ) {
      throw new Error('send outbox skills invalid');
    }
  }
  if (
    payload.backend !== undefined &&
    (typeof payload.backend !== 'string' || !['claude', 'grok', 'kiro', 'codex', 'opencode'].includes(payload.backend))
  ) {
    throw new Error('send outbox backend invalid');
  }
  if (
    payload.model !== undefined &&
    (typeof payload.model !== 'string' || payload.model.length === 0 || payload.model.length > 512 || /[\0\r\n]/.test(payload.model))
  ) {
    throw new Error('send outbox model invalid');
  }
  if (
    payload.continuationOf !== undefined &&
    (typeof payload.continuationOf !== 'string' || payload.continuationOf.length > 256 || !stableId.test(payload.continuationOf))
  ) {
    throw new Error('send outbox continuation invalid');
  }
}

function validatePresentationRecord(doc: PresentationRecord): void {
  const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
  if (!doc.presentationId || doc.presentationId.length > 512 || !stableId.test(doc.presentationId)) {
    throw new Error('presentation id invalid');
  }
  if (
    !doc.ownerTaskId ||
    doc.ownerTaskId.length > 512 ||
    !stableId.test(doc.ownerTaskId) ||
    !doc.rootId ||
    doc.rootId.length > 512 ||
    !stableId.test(doc.rootId)
  ) {
    throw new Error('presentation owner/root invalid');
  }
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) {
    throw new Error('presentation revision invalid');
  }
  if (!doc.title || doc.title.length > 512 || doc.title.includes('\0')) {
    throw new Error('presentation title invalid');
  }
  if (!doc.markdown || doc.markdown.length > 100_000 || doc.markdown.includes('\0')) {
    throw new Error('presentation markdown invalid');
  }
  if (doc.kind !== undefined && !['plan', 'spec', 'document'].includes(doc.kind)) {
    throw new Error('presentation kind invalid');
  }
  if (doc.summary !== undefined && (!doc.summary || doc.summary.length > 600)) {
    throw new Error('presentation summary invalid');
  }
  if (doc.changeSummary !== undefined && (!doc.changeSummary || doc.changeSummary.length > 1000)) {
    throw new Error('presentation change summary invalid');
  }
  for (const value of [doc.sourcePath, doc.sourceFolderUri]) {
    if (value !== undefined && (!value || value.length > 4096 || value.includes('\0'))) {
      throw new Error('presentation source path invalid');
    }
  }
  if (!Number.isFinite(Date.parse(doc.updatedAt))) {
    throw new Error('presentation timestamp invalid');
  }
}

function sendOutboxStatement(workspaceId: string, entry: SendOutboxEntry): SqlStatement {
  return {
    sql: `INSERT INTO send_outbox
          (workspace_id, client_request_id, status, task_id, payload_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id, client_request_id) DO UPDATE SET
            status = excluded.status,
            task_id = excluded.task_id,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`,
    params: [
      workspaceId,
      entry.clientRequestId,
      entry.status,
      entry.taskId ?? null,
      JSON.stringify(entry.payload),
      entry.createdAt,
      entry.updatedAt,
    ],
  };
}

function presentationStatement(
  workspaceId: string,
  doc: PresentationRecord,
  onlyIfPreviousChanged = false,
): SqlStatement {
  const payload = {
    summary: doc.summary,
    changeSummary: doc.changeSummary,
    kind: doc.kind,
    sourcePath: doc.sourcePath,
    sourceFolderUri: doc.sourceFolderUri,
  };
  const values = onlyIfPreviousChanged
    ? 'SELECT ?,?,?,?,?,?,?,?,? WHERE changes() > 0'
    : 'VALUES (?,?,?,?,?,?,?,?,?)';
  return {
    sql: `INSERT INTO presentations
          (workspace_id, presentation_id, owner_task_id, root_id, revision, title, markdown, payload_json, updated_at)
          ${values}
          ON CONFLICT(workspace_id, root_id, presentation_id) DO UPDATE SET
            owner_task_id = excluded.owner_task_id,
            revision = excluded.revision,
            title = excluded.title,
            markdown = excluded.markdown,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
          WHERE presentations.owner_task_id = excluded.owner_task_id
            AND excluded.revision > presentations.revision`,
    params: [
      workspaceId,
      doc.presentationId,
      doc.ownerTaskId,
      doc.rootId,
      doc.revision,
      doc.title,
      doc.markdown,
      JSON.stringify(payload),
      doc.updatedAt,
    ],
  };
}

function presentationFeedId(rootId: string, presentationId: string): string {
  return `${rootId.length}:${rootId}${presentationId}`;
}

function decodeSendOutboxRow(row: SendOutboxRow): SendOutboxEntry {
  let payload: SendOutboxPayloadV1;
  try {
    payload = JSON.parse(row.payload_json) as SendOutboxPayloadV1;
  } catch {
    throw new Error('send outbox payload corrupt');
  }
  const entry: SendOutboxEntry = {
    clientRequestId: row.client_request_id,
    status: row.status as SendOutboxEntry['status'],
    ...(row.task_id ? { taskId: row.task_id } : {}),
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  validateSendOutboxEntry(entry);
  return entry;
}

function decodePresentationRow(row: PresentationRow): PresentationRecord {
  let extra: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    extra = parsed as Record<string, unknown>;
  } catch {
    throw new Error('presentation payload corrupt');
  }
  const allowed = new Set(['summary', 'changeSummary', 'kind', 'sourcePath', 'sourceFolderUri']);
  if (Object.keys(extra).some((key) => !allowed.has(key))) {
    throw new Error('presentation payload corrupt');
  }
  for (const key of allowed) {
    if (extra[key] !== undefined && typeof extra[key] !== 'string') {
      throw new Error('presentation payload corrupt');
    }
  }
  const document: PresentationRecord = {
    presentationId: row.presentation_id,
    ownerTaskId: row.owner_task_id,
    rootId: row.root_id,
    revision: row.revision,
    title: row.title,
    markdown: row.markdown,
    updatedAt: row.updated_at,
    ...(typeof extra.summary === 'string' ? { summary: extra.summary } : {}),
    ...(typeof extra.changeSummary === 'string' ? { changeSummary: extra.changeSummary } : {}),
    ...(typeof extra.kind === 'string' ? { kind: extra.kind } : {}),
    ...(typeof extra.sourcePath === 'string' ? { sourcePath: extra.sourcePath } : {}),
    ...(typeof extra.sourceFolderUri === 'string' ? { sourceFolderUri: extra.sourceFolderUri } : {}),
  };
  validatePresentationRecord(document);
  return document;
}

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

function messageSelect(where: string, alias?: string): string {
  const p = alias ? `${alias}.` : '';
  const from = alias ? `messages ${alias}` : 'messages';
  return `SELECT ${p}id, ${p}workspace_id, ${p}task_id, ${p}turn_id, ${p}role, ${p}state, ${p}ordering, ${p}content,
                 ${p}created_at, ${p}updated_at, ${p}payload_json FROM ${from} ${where}`;
}

/**
 * Bounded active-input SQL. Drive from task-scoped active turns first, seek
 * turn_inputs by (workspace_id, turn_id), then seek messages by primary key.
 * MATERIALIZE + CROSS JOIN keeps SQLite from reversing into a messages-history
 * scan. Exported for EXPLAIN QUERY PLAN tests.
 *
 * Params: [workspaceId, ...taskIds, workspaceId, ...taskIds]
 */
export function activeTurnInputMessagesSql(taskIdCount: number): string {
  const ids = placeholders(taskIdCount);
  return `WITH active_turns AS MATERIALIZED (
         SELECT workspace_id, id AS turn_id
           FROM turns
          WHERE workspace_id = ?
            AND task_id IN (${ids})
            AND status IN ('queued', 'running', 'waiting_user')
       ),
       active_message_ids AS MATERIALIZED (
         SELECT DISTINCT
                at.workspace_id AS workspace_id,
                json_extract(ti.payload_json, '$.messageId') AS message_id
           FROM active_turns at
           CROSS JOIN turn_inputs ti
          WHERE ti.workspace_id = at.workspace_id
            AND ti.turn_id = at.turn_id
            AND ti.kind = 'message'
            AND json_extract(ti.payload_json, '$.messageId') IS NOT NULL
       )
       SELECT m.id, m.workspace_id, m.task_id, m.turn_id, m.role, m.state, m.ordering, m.content,
              m.created_at, m.updated_at, m.payload_json
         FROM active_message_ids ai
         CROSS JOIN messages m
        WHERE m.workspace_id = ai.workspace_id
          AND m.id = ai.message_id
          AND m.task_id IN (${ids})
        ORDER BY m.created_at, m.id`;
}

function sumWorkflowRunReservations(
  reservations: readonly WorkflowRunReservation[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const reservation of reservations) {
    totals.set(reservation.runId, (totals.get(reservation.runId) ?? 0) + reservation.count);
  }
  return totals;
}

function sumWorkflowTurnReservations(
  reservations: readonly WorkflowTurnReservation[],
): Map<string, WorkflowTurnReservation> {
  const totals = new Map<string, WorkflowTurnReservation>();
  for (const reservation of reservations) {
    const key = `${reservation.runId}\0${reservation.taskId}`;
    const existing = totals.get(key);
    totals.set(key, {
      runId: reservation.runId,
      taskId: reservation.taskId,
      count: (existing?.count ?? 0) + reservation.count,
    });
  }
  return totals;
}

function childInvocationFingerprint(input: {
  callerScopeId: string;
  childDefinitionId: string;
  childDefinitionVersion: number;
  childIdempotencyKey: string;
  entryBindings: readonly {
    childEntryNodeId: string;
    inputRef: string;
    artifactRunId: string;
    artifactId: string;
    artifactRevision: number;
  }[];
  effectivePolicy: WorkflowPolicyV1;
}): string {
  const entryBindings = input.entryBindings
    .map((binding) => ({
      childEntryNodeId: binding.childEntryNodeId,
      inputRef: binding.inputRef,
      artifactRunId: binding.artifactRunId,
      artifactId: binding.artifactId,
      artifactRevision: binding.artifactRevision,
    }))
    .sort((left, right) =>
      left.childEntryNodeId.localeCompare(right.childEntryNodeId)
      || left.inputRef.localeCompare(right.inputRef));
  return stableId('wfif', JSON.stringify({
    callerScopeId: input.callerScopeId,
    childDefinitionId: input.childDefinitionId,
    childDefinitionVersion: input.childDefinitionVersion,
    childIdempotencyKey: input.childIdempotencyKey,
    entryBindings,
    effectivePolicy: input.effectivePolicy,
  }));
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
    workflowActivation: _workflowActivation, workflowWait: _workflowWait,
    ...payload
  } = turn;
  void _id; void _taskId; void _sequence; void _status; void _trigger;
  void _createdAt; void _startedAt; void _finishedAt; void _inputs;
  void _workflowActivation; void _workflowWait;
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

/** M018 S06: deterministic return artifact id on the caller run. */
function stableChildReturnArtifactId(_parentRunId: string, childRunId: string): string {
  const fence = deriveChildReturnFenceId(childRunId);
  return fence.replace(/^wfrm_/, 'wfa_');
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
  const workflowAuthorization = command.turn.disposition && (
    command.turn.disposition.kind === 'workflow_next' ||
    command.turn.disposition.kind === 'workflow_prev' ||
    command.turn.disposition.kind === 'workflow_fail'
  )
    ? workflowDispositionAuthorizationPredicate(command.turn.disposition)
    : undefined;
  const workflowPredicate = workflowAuthorization ? ` AND ${workflowAuthorization.sql}` : '';
  return {
    sql: `UPDATE turns
             SET task_id=?, sequence=?, status=?, trigger=?, created_at=?, started_at=?, settled_at=?, payload_json=?
           WHERE workspace_id=? AND id=? AND status IN (${placeholders(command.expectedStatuses.length)})${dispositionPredicate}${epochPredicate}${workflowPredicate}`,
    params: [
      command.turn.taskId, command.turn.sequence, command.turn.status, command.turn.trigger, command.turn.createdAt,
      command.turn.startedAt ?? null, command.turn.finishedAt ?? null, turnPayload(command.turn), workspaceId, command.turnId,
      ...command.expectedStatuses,
      ...(command.turn.disposition === undefined || command.expectedDisposition !== undefined ? [] : [JSON.stringify(command.turn.disposition)]),
      ...(command.expectedDisposition === undefined ? [] : [JSON.stringify(command.expectedDisposition)]),
      ...(command.expectedRuntimeEpoch === undefined ? [] : [command.expectedRuntimeEpoch]),
      ...(workflowAuthorization?.params ?? []),
    ],
  };
}

function workflowDispositionAuthorizationPredicate(disposition: TurnDisposition): {
  sql: string;
  params: SqlValue[];
} {
  const isChildWorkflowRoute =
    disposition.kind === 'workflow_next' && disposition.route?.kind === 'child_workflow';
  const activationConditions = [
    `activation.workspace_id = turns.workspace_id`,
    `activation.execution_turn_id = turns.id`,
    `activation.status IN ('queued', 'running')`,
    `run.status = 'running'`,
    `node.task_id = turns.task_id`,
  ];
  if (disposition.kind === 'workflow_next' && disposition.change === 'unchanged') {
    activationConditions.push(
      `(
         (
           activation.kind = 'feedback_request'
           AND EXISTS (
             SELECT 1 FROM workflow_feedback_targets target
              WHERE target.workspace_id = activation.workspace_id
                AND target.run_id = activation.run_id
                AND target.round_id = activation.feedback_round_id
                AND target.target_node_id = activation.feedback_target_node_id
                AND target.request_activation_id = activation.activation_id
                AND target.status = 'pending'
                AND target.base_artifact_run_id IS NOT NULL
                AND target.base_artifact_id IS NOT NULL
                AND target.base_artifact_revision IS NOT NULL
           )
         )
         OR
         (
           activation.kind = 'feedback_resume'
           AND activation.inherited_feedback_round_id IS NOT NULL
           AND activation.inherited_feedback_target_node_id IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM workflow_feedback_rounds resume_round
               JOIN workflow_feedback_targets target
                 ON target.workspace_id = resume_round.workspace_id
                AND target.run_id = resume_round.run_id
                AND target.round_id = resume_round.inherited_round_id
                AND target.target_id = resume_round.inherited_target_id
              WHERE resume_round.workspace_id = activation.workspace_id
                AND resume_round.run_id = activation.run_id
                AND resume_round.round_id = activation.feedback_round_id
                AND resume_round.resume_activation_id = activation.activation_id
                AND target.target_node_id = activation.inherited_feedback_target_node_id
                AND target.status = 'pending'
                AND target.base_artifact_run_id IS NOT NULL
                AND target.base_artifact_id IS NOT NULL
                AND target.base_artifact_revision IS NOT NULL
           )
         )
       )`,
    );
  }
  if (isChildWorkflowRoute) {
    activationConditions.push(
      `definition_node.is_terminal = 1`,
      `NOT EXISTS (
         SELECT 1 FROM workflow_feedback_rounds round_row
          WHERE round_row.workspace_id = activation.workspace_id
            AND round_row.run_id = activation.run_id
            AND round_row.status = 'open'
       )`,
      `NOT EXISTS (
         SELECT 1 FROM workflow_continuations continuation
          WHERE continuation.workspace_id = activation.workspace_id
            AND continuation.run_id = activation.run_id
            AND continuation.status = 'pending'
       )`,
    );
  }

  const activationExists = `EXISTS (
    SELECT 1
      FROM workflow_activations activation
      JOIN workflow_runs run
        ON run.workspace_id = activation.workspace_id
       AND run.run_id = activation.run_id
      JOIN workflow_nodes node
        ON node.workspace_id = activation.workspace_id
       AND node.run_id = activation.run_id
       AND node.node_id = activation.node_id
      JOIN workflow_definition_nodes definition_node
        ON definition_node.workspace_id = run.workspace_id
       AND definition_node.definition_id = run.definition_id
       AND definition_node.definition_version = run.definition_version
       AND definition_node.node_id = activation.node_id
     WHERE ${activationConditions.join('\n       AND ')}
  )`;

  if (!isChildWorkflowRoute) return { sql: activationExists, params: [] };

  const route = disposition.route!;
  const childDefinitionExists = `EXISTS (
    SELECT 1 FROM workflow_definitions child_definition
     WHERE child_definition.workspace_id = turns.workspace_id
       AND child_definition.definition_id = ?
       AND child_definition.version = ?
       AND (
         child_definition.scope_kind = 'workspace'
         OR (
           child_definition.scope_kind = 'root'
           AND child_definition.owner_root_task_id = COALESCE((
             SELECT caller_run.owner_root_task_id
               FROM workflow_activations caller_activation
               JOIN workflow_runs caller_run
                 ON caller_run.workspace_id = caller_activation.workspace_id
                AND caller_run.run_id = caller_activation.run_id
              WHERE caller_activation.workspace_id = turns.workspace_id
                AND caller_activation.execution_turn_id = turns.id
              LIMIT 1
           ), turns.task_id)
         )
       )
  )`;
  const exactContractCount = `(
    SELECT COUNT(*) FROM workflow_entry_contracts child_contract
     WHERE child_contract.workspace_id = turns.workspace_id
       AND child_contract.definition_id = ?
       AND child_contract.definition_version = ?
  ) = ?`;
  const bindingPredicates = route.entryBindings.map(() => `EXISTS (
    SELECT 1
      FROM workflow_entry_contracts child_contract
      JOIN workflow_artifacts artifact
        ON artifact.workspace_id = turns.workspace_id
       AND artifact.artifact_id = ?
       AND artifact.revision = ?
       AND artifact.kind = child_contract.expected_artifact_kind
      JOIN workflow_artifact_sources source
        ON source.workspace_id = artifact.workspace_id
       AND source.run_id = artifact.run_id
       AND source.artifact_id = artifact.artifact_id
       AND source.artifact_revision = artifact.revision
     WHERE child_contract.workspace_id = turns.workspace_id
       AND child_contract.definition_id = ?
       AND child_contract.definition_version = ?
       AND child_contract.entry_node_id = ?
       AND child_contract.input_ref = ?
       AND (
         EXISTS (
           SELECT 1 FROM workflow_activations caller_activation
            WHERE caller_activation.workspace_id = turns.workspace_id
              AND caller_activation.execution_turn_id = turns.id
              AND caller_activation.run_id = artifact.run_id
         )
         OR (
           source.source_kind = 'caller_turn'
           AND source.caller_task_id = turns.task_id
           AND source.caller_turn_id = turns.id
         )
         OR (
           source.source_kind = 'workflow_node'
           AND source.producer_task_id = turns.task_id
         )
       )
  )`);
  const childRouteParams: SqlValue[] = [
    route.childDefinitionId,
    route.childDefinitionVersion,
    route.childDefinitionId,
    route.childDefinitionVersion,
    route.entryBindings.length,
  ];
  for (const binding of route.entryBindings) {
    childRouteParams.push(
      binding.artifactId,
      binding.artifactRevision,
      route.childDefinitionId,
      route.childDefinitionVersion,
      binding.childEntryNodeId,
      binding.inputRef,
    );
  }

  return {
    sql: `EXISTS (
    SELECT 1 FROM tasks caller
     WHERE caller.workspace_id = turns.workspace_id
       AND caller.id = turns.task_id
       AND caller.role = 'coordinator'
       AND EXISTS (
         SELECT 1 FROM json_each(COALESCE(json_extract(caller.payload_json, '$.capabilities'), '[]')) capability
          WHERE capability.value = 'create_child'
       )
       AND (
         ${activationExists}
         OR (
           caller.parent_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM workflow_activations any_activation
               WHERE any_activation.workspace_id = turns.workspace_id
                 AND any_activation.execution_turn_id = turns.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_nodes caller_node
               WHERE caller_node.workspace_id = turns.workspace_id
                 AND caller_node.task_id = turns.task_id
            )
            AND NOT EXISTS (
             SELECT 1 FROM workflow_continuations continuation
              WHERE continuation.workspace_id = turns.workspace_id
                AND continuation.caller_task_id = turns.task_id
                AND continuation.status = 'pending'
           )
         )
       )
       AND ${childDefinitionExists}
       AND ${exactContractCount}
       ${bindingPredicates.map((predicate) => `AND ${predicate}`).join('\n       ')}
  )`,
    params: childRouteParams,
  };
}

function dispositionClaimInsertStatement(
  workspaceId: string,
  claim: DurableDispositionClaim,
  at = new Date().toISOString(),
): SqlStatement {
  return {
    sql: `INSERT INTO turn_disposition_claims
          (workspace_id, turn_id, task_id, runtime_epoch, op_id, family, kind,
           fingerprint, payload_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
    params: [
      workspaceId,
      claim.turnId,
      claim.taskId,
      claim.runtimeEpoch,
      claim.opId,
      claim.family,
      claim.kind,
      claim.fingerprint,
      claim.payloadJson,
      at,
      at,
    ],
  };
}

function dispositionClaimSettlementStatement(
  workspaceId: string,
  turnId: string,
  status: 'consumed' | 'discarded',
  at: string,
): SqlStatement {
  return {
    sql: `UPDATE turn_disposition_claims
             SET status = ?, updated_at = ?
           WHERE workspace_id = ? AND turn_id = ? AND status = 'staged'`,
    params: [status, at, workspaceId, turnId],
  };
}

function workflowActivationSettlementStatement(
  workspaceId: string,
  turnId: string,
  turnStatus: TurnStatus,
  at: string,
): SqlStatement {
  const status = turnStatus === 'succeeded'
    ? 'consumed'
    : turnStatus === 'failed' || turnStatus === 'interrupted' || turnStatus === 'cancelled'
      ? turnStatus
      : undefined;
  if (!status) throw new Error('workflow activation settlement requires a terminal turn');
  return {
    sql: `UPDATE workflow_activations
             SET status = ?, updated_at = ?
           WHERE workspace_id = ? AND execution_turn_id = ?
             AND status IN ('queued', 'running', 'failed', 'interrupted')`,
    params: [status, at, workspaceId, turnId],
  };
}

function workflowActivationRunningStatement(
  workspaceId: string,
  turnId: string,
  at: string,
): SqlStatement {
  return {
    sql: `UPDATE workflow_activations
             SET status = 'running', updated_at = ?
           WHERE workspace_id = ? AND execution_turn_id = ? AND status = 'queued'`,
    params: [at, workspaceId, turnId],
  };
}

function workflowActivationSourceConsumptionStatements(
  workspaceId: string,
  turnId: string,
  at: string,
): SqlStatement[] {
  return [
    {
      sql: `UPDATE workflow_feedback_rounds
               SET status = 'consumed', updated_at = ?
             WHERE workspace_id = ? AND status = 'satisfied'
               AND EXISTS (
                 SELECT 1 FROM workflow_activations activation
                  WHERE activation.workspace_id = workflow_feedback_rounds.workspace_id
                    AND activation.run_id = workflow_feedback_rounds.run_id
                    AND activation.feedback_round_id = workflow_feedback_rounds.round_id
                    AND activation.kind = 'feedback_resume'
                    AND activation.execution_turn_id = ?
                    AND activation.status IN ('queued', 'running')
               )`,
      params: [at, workspaceId, turnId],
    },
    {
      sql: `UPDATE workflow_continuations
               SET status = 'consumed', updated_at = ?
             WHERE workspace_id = ? AND status = 'resolved'
               AND EXISTS (
                 SELECT 1 FROM workflow_return_gates return_gate
                  WHERE return_gate.workspace_id = workflow_continuations.workspace_id
                    AND return_gate.continuation_run_id = workflow_continuations.run_id
                    AND return_gate.continuation_id = workflow_continuations.continuation_id
                    AND return_gate.execution_turn_id = ?
                    AND return_gate.status = 'satisfied'
               )`,
      params: [at, workspaceId, turnId],
    },
    {
      sql: `UPDATE workflow_return_gates
               SET status = 'consumed', updated_at = ?
             WHERE workspace_id = ? AND execution_turn_id = ? AND status = 'satisfied'`,
      params: [at, workspaceId, turnId],
    },
  ];
}

function workflowNodeArtifactSourceStatement(input: {
  workspaceId: string;
  runId: string;
  artifactId: string;
  artifactRevision: number;
  nodeId: string;
  taskId: string;
  turnId: string;
}): SqlStatement {
  return {
    sql: `INSERT INTO workflow_artifact_sources (
            workspace_id, run_id, artifact_id, artifact_revision, source_kind,
            producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
            producing_activation_id, caller_task_id, caller_turn_id,
            engine_start_operation_key
          )
          SELECT ?, ?, ?, ?, 'workflow_node', ?, ?, ?, ?, activation_id,
                 NULL, NULL, NULL
            FROM workflow_activations
           WHERE workspace_id = ? AND run_id = ? AND node_id = ?
             AND execution_turn_id = ?
          ON CONFLICT(workspace_id, run_id, artifact_id, artifact_revision) DO NOTHING`,
    params: [
      input.workspaceId,
      input.runId,
      input.artifactId,
      input.artifactRevision,
      input.runId,
      input.nodeId,
      input.taskId,
      input.turnId,
      input.workspaceId,
      input.runId,
      input.nodeId,
      input.turnId,
    ],
  };
}

function workflowAggregateOverflowClosureStatements(input: {
  workspaceId: string;
  runId: string;
  closureId: string;
  at: string;
}): SqlStatement[] {
  const markerParams = [input.workspaceId, input.runId, input.closureId];
  return [
    {
      sql: `UPDATE turns
               SET status = 'cancelled', settled_at = ?,
                   payload_json = json_set(payload_json, '$.error', 'aggregate_too_large')
             WHERE workspace_id = ? AND status = 'queued'
               AND task_id IN (
                 SELECT task_id FROM workflow_nodes
                  WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
               )
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )`,
      params: [
        input.at,
        input.workspaceId,
        input.workspaceId,
        input.runId,
        ...markerParams,
      ],
    },
    {
      sql: `INSERT INTO turn_cancel_requests (
              workspace_id, turn_id, task_id, kind, op_id, requested_by, requested_at, payload_json
            )
            SELECT turn.workspace_id, turn.id, turn.task_id, 'interrupt', ?, 'engine', ?,
                   json_object('kind', 'interrupt', 'by', 'engine', 'opId', ?, 'at', ?,
                               'reason', 'aggregate_too_large')
              FROM turns turn
             WHERE turn.workspace_id = ? AND turn.status IN ('running', 'waiting_user')
               AND turn.task_id IN (
                 SELECT task_id FROM workflow_nodes
                  WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
               )
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )
            ON CONFLICT(workspace_id, turn_id) DO NOTHING`,
      params: [
        input.closureId,
        input.at,
        input.closureId,
        input.at,
        input.workspaceId,
        input.workspaceId,
        input.runId,
        ...markerParams,
      ],
    },
    {
      sql: `UPDATE workflow_dependency_gates
               SET status = 'failed'
             WHERE workspace_id = ? AND run_id = ? AND status IN ('open', 'satisfied')
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )`,
      params: [input.workspaceId, input.runId, ...markerParams],
    },
    {
      sql: `UPDATE workflow_feedback_rounds
               SET status = 'failed', updated_at = ?
             WHERE workspace_id = ? AND run_id = ? AND status IN ('open', 'satisfied')
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )`,
      params: [input.at, input.workspaceId, input.runId, ...markerParams],
    },
    {
      sql: `UPDATE workflow_return_gates
               SET status = 'failed', updated_at = ?
             WHERE workspace_id = ? AND caller_run_id = ? AND status IN ('open', 'satisfied')
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )`,
      params: [input.at, input.workspaceId, input.runId, ...markerParams],
    },
    {
      sql: `UPDATE workflow_continuations
               SET status = 'failed', outcome = 'failed', reason_code = 'aggregate_too_large',
                   resolved_at = COALESCE(resolved_at, ?), updated_at = ?
             WHERE workspace_id = ? AND caller_run_id = ? AND status IN ('pending', 'resolved')
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )`,
      params: [input.at, input.at, input.workspaceId, input.runId, ...markerParams],
    },
    {
      sql: `UPDATE workflow_activations
               SET status = 'cancelled', updated_at = ?
             WHERE workspace_id = ? AND run_id = ?
               AND status IN ('queued', 'running', 'failed', 'interrupted')
               AND EXISTS (
                 SELECT 1 FROM workflow_runs
                  WHERE workspace_id = ? AND run_id = ? AND status = 'running'
                    AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?
               )`,
      params: [input.at, input.workspaceId, input.runId, ...markerParams],
    },
    {
      sql: `UPDATE workflow_runs
               SET status = 'failed', updated_at = ?
             WHERE workspace_id = ? AND run_id = ? AND status = 'running'
               AND terminal_reason_code = 'aggregate_too_large' AND closure_id = ?`,
      params: [input.at, input.workspaceId, input.runId, input.closureId],
    },
  ];
}

function sessionBindingStatements(
  workspaceId: string,
  task: MusterTask,
  at: string,
): SqlStatement[] {
  if (!task.committedSessionId) return [];
  const runtimeEpoch = task.runtimeEpoch ?? 1;
  return [
    {
      sql: `INSERT INTO session_owners
            (workspace_id, backend, session_id, task_id, first_bound_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, backend, session_id) DO NOTHING`,
      params: [workspaceId, task.backend, task.committedSessionId, task.id, at],
    },
    {
      sql: `UPDATE task_session_bindings
               SET active = 0, cleared_at = ?
             WHERE workspace_id = ? AND task_id = ? AND active = 1
               AND (runtime_epoch <> ? OR backend <> ? OR session_id <> ?)`,
      params: [at, workspaceId, task.id, runtimeEpoch, task.backend, task.committedSessionId],
    },
    {
      sql: `INSERT INTO task_session_bindings
            (workspace_id, task_id, runtime_epoch, backend, session_id, active, bound_at, cleared_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
            ON CONFLICT(workspace_id, task_id, runtime_epoch) DO UPDATE SET
              active = 1,
              bound_at = excluded.bound_at,
              cleared_at = NULL,
              backend = excluded.backend,
              session_id = excluded.session_id`,
      params: [workspaceId, task.id, runtimeEpoch, task.backend, task.committedSessionId, at],
    },
  ];
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

const DEFAULT_CHANGE_FEED_PAGE_LIMIT = 256;
export const MAX_CHANGE_FEED_PAGE_REVISIONS = 512;
export const MAX_CHANGE_FEED_METADATA_ROWS = 4096;
const WORKSPACE_CHANGE_ENTITY_KIND_SET = new Set<string>(WORKSPACE_CHANGE_ENTITY_KINDS);

interface ChangeLogRow {
  revision: number;
  entity_kind: string;
  entity_id: string;
  task_id: string | null;
  change_kind: string;
}

interface ChangeFeedQueryRow {
  current_revision: number;
  retained_from_revision: number;
  candidate_revision_count: number;
  page_revision: number | null;
  revision: number | null;
  entity_kind: string | null;
  entity_id: string | null;
  task_id: string | null;
  change_kind: string | null;
}

function parseWorkspaceChangeEntityKind(value: string): WorkspaceChangeEntityKind | undefined {
  return WORKSPACE_CHANGE_ENTITY_KIND_SET.has(value)
    ? (value as WorkspaceChangeEntityKind)
    : undefined;
}

/**
 * After a revision advances, persist the explicit low watermark and prune whole
 * revisions older than the retention window. These statements must run only after
 * the revision bump and feed inserts so they never overwrite a guarded mutation's
 * `changes()` signal.
 */
function changeFeedRetentionStatements(
  workspaceId: string,
  retainRevisions: number,
): SqlStatement[] {
  return [
    {
      // First durable revision initializes retained_from=1. Later advances keep
      // max(1, current - retain + 1) without lowering an already higher watermark.
      sql: `INSERT INTO change_feed_watermarks (workspace_id, retained_from_revision)
            SELECT ?, MAX(1, revision - ? + 1)
              FROM workspace_revisions
             WHERE workspace_id = ?
            ON CONFLICT(workspace_id) DO UPDATE SET
              retained_from_revision = MAX(
                change_feed_watermarks.retained_from_revision,
                excluded.retained_from_revision
              )`,
      params: [workspaceId, retainRevisions, workspaceId],
    },
    {
      sql: `DELETE FROM change_log
             WHERE workspace_id = ?
               AND revision < (
                 SELECT retained_from_revision
                   FROM change_feed_watermarks
                  WHERE workspace_id = ?
               )`,
      params: [workspaceId, workspaceId],
    },
  ];
}

function revisionStatements(
  workspaceId: string,
  changes: readonly ChangeRecord[],
  at: string,
  retainRevisions: number,
): SqlStatement[] {
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
    ...changeFeedRetentionStatements(workspaceId, retainRevisions),
  ];
}

/**
 * `changes()` refers to the immediately preceding statement. This helper is
 * deliberately used only directly after a guarded primary mutation, before any
 * cleanup statement can overwrite that signal. Feed inserts after the revision
 * bump chain on the previous statement's changes() so multi-row revisions do not
 * drop later metadata when an intermediate insert is a no-op.
 */
function conditionalRevisionStatements(
  workspaceId: string,
  change: ChangeRecord | readonly ChangeRecord[],
  at: string,
  retainRevisions: number,
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
    // Watermark/prune run only after feed rows. abortIfFirstUnchanged means a
    // committed conditional write always advanced revision before reaching here.
    ...changeFeedRetentionStatements(workspaceId, retainRevisions),
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
               AND NOT EXISTS (
                 SELECT 1
                  FROM workflow_activations activation
                  JOIN workflow_runs run
                    ON run.workspace_id = activation.workspace_id
                   AND run.run_id = activation.run_id
                 WHERE activation.workspace_id = turns.workspace_id
                   AND activation.execution_turn_id = turns.id
                    AND (activation.status <> 'queued' OR run.status <> 'running')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_feedback_rounds round_row
                  WHERE round_row.workspace_id = turns.workspace_id
                    AND round_row.requester_task_id = turns.task_id
                    AND round_row.status IN ('open', 'satisfied')
                    AND NOT EXISTS (
                      SELECT 1 FROM workflow_activations activation
                       WHERE activation.workspace_id = round_row.workspace_id
                         AND activation.run_id = round_row.run_id
                         AND activation.feedback_round_id = round_row.round_id
                         AND activation.execution_turn_id = turns.id
                         AND activation.kind = 'feedback_resume'
                         AND activation.status = 'queued'
                    )
               )
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_continuations continuation
                  WHERE continuation.workspace_id = turns.workspace_id
                    AND continuation.caller_task_id = turns.task_id
                    AND continuation.status IN ('pending', 'resolved')
                    AND NOT EXISTS (
                      SELECT 1 FROM workflow_activations activation
                       WHERE activation.workspace_id = continuation.workspace_id
                         AND activation.continuation_id = continuation.continuation_id
                         AND activation.execution_turn_id = turns.id
                         AND activation.kind = 'child_return'
                         AND activation.status = 'queued'
                    )
               )
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

interface SessionBindingRow {
  task_id: string;
  runtime_epoch: number;
  backend: string;
  session_id: string;
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
