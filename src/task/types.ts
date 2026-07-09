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
  committedSessionId?: string;
  /**
   * Workspace directory the agent runs in for this task's turns (schema-compatible:
   * optional, absent value tolerated so no schema bump is required). Populated at
   * task creation from the resolved workspace root; children inherit the parent's.
   */
  cwd?: string;
  capabilities: TaskCapability[];
  executionPolicy: TaskExecutionPolicy;
  result?: string;
  error?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
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
}

// Messages (§9) + store envelope (§12.1)
export type TaskMessageState = 'pending' | 'assigned' | 'complete' | 'partial';
export interface TaskMessage {
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
}

// Derived view status (§4.3) — computed, never persisted
export type TaskViewStatus =
  | 'waiting_dependencies' | 'queued' | 'running' | 'waiting_user' | 'waiting_children'
  | 'blocked' | 'needs_recovery' | 'idle'
  | 'succeeded' | 'failed' | 'cancelled' | 'skipped';