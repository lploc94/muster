// Tasks (§4.1)
export type TaskRole = 'coordinator' | 'worker';
export type TaskLifecycleState = 'open' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export interface TaskDependency {
  taskId: string;
  requiredOutcome: 'succeeded' | 'settled';
  onUnsatisfied: 'block' | 'fail' | 'skip';
}
export type PersistedWait =
  | { kind: 'children'; taskIds: string[]; registeredByTurnId: string }
  | { kind: 'external'; key: string; message?: string };
export type TaskCapability =
  | 'create_child' | 'start_child' | 'wait_child'
  | 'interrupt_child' | 'cancel_child' | 'read_subtree';
export interface TaskExecutionPolicy {
  maxTurns: number;
  maxAutomaticRetries: number;
  turnTimeoutMs: number;
  taskTimeoutMs: number;
}
/**
 * Agent-proposed outcome awaiting an authorized sealer (user, or coordinator under
 * delegate mode). Does not change lifecycle until accepted. See TASK-MANAGEMENT §5.3.
 */
export type OutcomeProposal =
  | {
      kind: 'complete';
      result: string;
      proposedByTurnId: string;
      proposedAt: string;
    }
  | {
      kind: 'fail';
      error: string;
      proposedByTurnId: string;
      proposedAt: string;
    };

export interface MusterTask {
  id: string;
  role: TaskRole;
  lifecycle: TaskLifecycleState;
  goal: string;
  description?: string;
  reason?: string;
  continuationOf?: string;
  parentId: string | null;
  dependencies: TaskDependency[];
  wait?: PersistedWait;
  backend: string;
  /** Optional model id selected for this task (ACP session config option value). */
  model?: string;
  /**
   * Backend conversation session for this task. Set after a successful turn
   * (session/new or session/load). Next turns pass it as resumeId — process may
   * stop between turns, but the session binding stays on the open task.
   */
  committedSessionId?: string;
  /**
   * Workspace directory the agent runs in for this task's turns (schema-compatible:
   * optional, absent value tolerated so no schema bump is required). Populated at
   * task creation from the resolved workspace root; children inherit the parent's.
   */
  cwd?: string;
  capabilities: TaskCapability[];
  executionPolicy: TaskExecutionPolicy;
  /** Staged complete/fail for root (human-gated) or display; not a lifecycle seal. */
  outcomeProposal?: OutcomeProposal;
  result?: string;
  error?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /**
   * Optional cross-runtime handoff state (schema-compatible: absent on legacy tasks).
   * Owned by the TaskHandoff aggregate; never projected as ordinary TaskMessage chat.
   * Malformed records are stripped on load (fail closed) without quarantining the store.
   */
  handoff?: TaskHandoffState;
}

// ---------------------------------------------------------------------------
// Cross-runtime task handoff (M010) — durable contract only.
// Phase transitions and orchestration live in the TaskHandoff aggregate (T02).
// ---------------------------------------------------------------------------

/** Explicit handoff progress phases. Terminal: completed | failed | cancelled. */
export type TaskHandoffPhase =
  | 'requested'
  | 'exporting_context'
  | 'summarizing_source'
  | 'preparing_receiver'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Source or target runtime binding for a handoff operation. */
export interface TaskHandoffRuntimeBinding {
  /** Backend id (e.g. claude-cli, codex). Never a credential or absolute path. */
  backend: string;
  /** Optional model id for this side of the handoff. */
  model?: string;
  /** Optional backend session id already bound (source) or established (target). */
  sessionId?: string;
}

/**
 * Required conversation-context export metadata.
 * Stores digests/counts only — never full conversation bodies or credentials.
 */
export type TaskHandoffConversationContext =
  | {
      status: 'pending';
    }
  | {
      status: 'ready';
      messageCount: number;
      /** Stable content digest of the exported conversation package. */
      contentDigest: string;
      exportedAt: string;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

/**
 * Optional source-summary state. Distinct from required conversation context:
 * handoff may complete with summary unavailable when conversation context is ready.
 */
export type TaskHandoffSourceSummary =
  | {
      status: 'pending';
    }
  | {
      status: 'ready';
      /** Digest of the source summary payload — not the summary text itself. */
      contentDigest: string;
      summarizedAt: string;
    }
  | {
      status: 'unavailable';
      reason: string;
    }
  | {
      status: 'skipped';
      reason: string;
    };

/** Terminal success metadata once the receiver is bound and ready for next turns. */
export interface TaskHandoffCompletion {
  completedAt: string;
  boundBackend: string;
  boundSessionId?: string;
}

/**
 * Bounded failure diagnostics for a failed/cancelled handoff.
 * `message` is sanitized (no absolute paths, credentials, or raw conversation bodies).
 */
export interface TaskHandoffFailure {
  code: string;
  message: string;
  at: string;
}

/**
 * Persisted handoff state on a MusterTask (versioned, bounded, reloadable).
 * Does not include chat messages, handoff prompts, raw CLI output, or secrets.
 */
export interface TaskHandoffState {
  /** Contract version for this handoff record (independent of store schemaVersion). */
  version: 1;
  /** Stable operation id for stale-op rejection and idempotent terminal handling. */
  operationId: string;
  phase: TaskHandoffPhase;
  source: TaskHandoffRuntimeBinding;
  target: TaskHandoffRuntimeBinding;
  conversationContext: TaskHandoffConversationContext;
  /** Optional; omit or set unavailable/skipped when source summary is not used. */
  sourceSummary?: TaskHandoffSourceSummary;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  completion?: TaskHandoffCompletion;
  failure?: TaskHandoffFailure;
}

// Turns (§4.2)
export type TurnStatus =
  | 'queued' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export type TurnTrigger = 'user' | 'engine' | 'retry';
export type TurnInput =
  | { kind: 'message'; messageId: string }
  | { kind: 'child_results'; taskIds: string[] }
  | { kind: 'recovery'; interruptedTurnId: string; instruction: string };
export type TurnDisposition =
  | { kind: 'complete'; result: string }
  | { kind: 'fail'; error: string }
  | { kind: 'wait_tasks'; taskIds: string[] }
  | { kind: 'idle' };
/**
 * Durable ACP boundary phase for a live/settled turn (Phase C).
 * Written before side-effecting `session/prompt`; used for reload classification.
 */
export type TurnDispatchPhase = 'pre_dispatch' | 'prompt_outstanding' | 'terminal_received';

/**
 * How a failed/interrupted turn is classified for retry / UI (Phase C).
 * - safe_to_retry: failed before durable prompt dispatch
 * - terminal_received: adapter saw an explicit terminal prompt outcome
 * - uncertain: prompt may have started; never silent auto-replay
 * - unclassified: transport/adapter failure without terminal evidence
 */
export type TurnFailureClass =
  | 'safe_to_retry'
  | 'terminal_received'
  | 'uncertain'
  | 'unclassified';

export interface TaskTurn {
  id: string;
  taskId: string;
  sequence: number;
  trigger: TurnTrigger;
  retryOf?: string;
  status: TurnStatus;
  inputs: TurnInput[];
  candidateSessionId?: string;
  observedSessionId?: string;
  disposition?: TurnDisposition;
  error?: string;
  isCancellation?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * When true, the engine must not auto-promote this queued turn after a prior
   * failed/interrupted settlement (MEM030). Cleared by explicit resume or by
   * confirmed interrupt-and-send settlement when follow-ups should continue.
   */
  holdAutoPromote?: boolean;
  /**
   * How an interrupted turn's cancel was observed (interrupt-and-send gate):
   * - `confirmed`: primary prompt ended after cancel without force-timeout
   * - `forced`: grace force-settle / unconfirmed — do not bind session or promote
   * - `armed`: reserved for in-flight bookkeeping (not a settled value)
   */
  interruptConfidence?: 'armed' | 'confirmed' | 'forced';
  /**
   * Durable dispatch marker (Phase C). Set `pre_dispatch` when the turn becomes
   * running; flip to `prompt_outstanding` immediately before `session/prompt`;
   * set `terminal_received` on terminal settlement. Missing/ambiguous on reload
   * → treat orphan live as uncertain.
   */
  dispatchPhase?: TurnDispatchPhase;
  /** Settlement classification for activity projection + auto-retry eligibility. */
  failureClass?: TurnFailureClass;
}

// Messages (§9) + store envelope (§12.1)
export type TaskMessageState = 'pending' | 'assigned' | 'complete' | 'partial';
export interface TaskMessage {
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  /** User-visible text (short display-name mentions). */
  content: string;
  /**
   * Optional agent-facing text when it differs from `content` (e.g. full paths
   * after mention expand-on-send). CLI turns use this when present.
   */
  agentContent?: string;
  state: TaskMessageState;
  createdAt: string;
  turnId?: string;
  /**
   * Per-turn monotonic render order for assistant segments (schema ≥ 3). Assistant
   * messages are segmented at tool boundaries so `(turn.sequence, order)` reproduces
   * the exact live interleaving of assistant text and tool cards.
   */
  order?: number;
}

/** Persisted tool call for transcript reconstruction (schema ≥ 3). */
export interface PersistedToolCall {
  /** Composite id `${turnId}:${toolCallId}` — unique across turns. */
  id: string;
  taskId: string;
  turnId: string;
  /** Raw backend tool-call id, used to match update/complete events within the turn. */
  toolCallId: string;
  /** Per-turn monotonic render order (shared counter with assistant segments). */
  order: number;
  name: string;
  kind?: 'mcp' | 'builtin' | 'other';
  status: 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Persisted reasoning, turn-scoped (schema ≥ 3). One record per turn. */
export interface PersistedReasoning {
  /** Equal to turnId. */
  id: string;
  taskId: string;
  turnId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
export interface OpResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface CancelRequest {
  kind: 'interrupt' | 'cancel';
  by: string;
  opId: string;
  at: string;
}

export interface OperationLedgerEntry {
  fingerprint: string;
  result: OpResult;
}

/**
 * Durable send ack receipt (Phase C idempotency). Keyed by clientRequestId.
 * Same id + same fingerprint → re-ACK original ids; same id + different fingerprint → conflict.
 */
export interface SendReceipt {
  clientRequestId: string;
  fingerprint: string;
  taskId: string;
  messageId: string;
  turnId: string;
  createdAt: string;
}

export interface TaskStoreFile {
  schemaVersion: number;
  revision: number;
  tasks: Record<string, MusterTask>;
  turns: Record<string, TaskTurn>;
  messages: Record<string, TaskMessage>;
  /** Phase C coordination state (schema ≥ 2). */
  operations?: Record<string, OperationLedgerEntry>;
  cancelRequests?: Record<string, CancelRequest>;
  /** Persisted tool calls, keyed by `${turnId}:${toolCallId}` (schema ≥ 3). */
  toolCalls?: Record<string, PersistedToolCall>;
  /** Persisted reasoning, keyed by turnId (schema ≥ 3). */
  reasoning?: Record<string, PersistedReasoning>;
  /**
   * Webview send outbox receipts (Phase C). Keyed by `clientRequestId`.
   * Retained for the resend window so duplicate delivery re-ACKs without a second commit.
   */
  sendReceipts?: Record<string, SendReceipt>;
}

/**
 * Derived runtime activity while lifecycle is `open` (never persisted).
 * Independent of CLI success as a task outcome — see docs/TASK-MANAGEMENT.md §4.3.
 */
export type TaskRuntimeActivity =
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'idle'
  | 'awaiting_outcome';

/**
 * Compact single-axis status for backward-compatible indexes and older UI.
 * Prefer `lifecycle` + `runtimeActivity` for presentation.
 * When lifecycle is terminal, equals lifecycle; when open, equals runtime activity.
 */
export type TaskViewStatus = TaskLifecycleState | TaskRuntimeActivity;