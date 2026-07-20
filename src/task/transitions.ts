import { synthesizeBriefFromGoal } from './brief';
import { buildTaskResultFromSummary, clampSummary } from './dataflow';
import { validateDependencies, type DepGraph } from './deps';
import type {
  MusterTask,
  TaskBriefV1,
  TaskCapability,
  TaskCompletionCandidateV1,
  TaskDependency,
  TaskExecutionPolicy,
  TaskInputBinding,
  TaskLifecycleState,
  TaskMessage,
  TaskReleaseState,
  TaskRole,
  TaskSealedBy,
  TaskTurn,
  TaskVerdict,
  TurnDisposition,
  TurnFailureClass,
  TurnInput,
  TurnStatus,
  TurnTrigger,
} from './types';
import { truncateUtf8Bytes } from './content-limits';

/** Fallback when a child omits disposition and no assistant summary is available. */
export const MISSING_DISPOSITION_CANDIDATE_SUMMARY =
  'Turn completed without complete_task/fail_task disposition.';

/** Named parent-orchestration policy for child auto-seal (W4). */
export type ChildOrchestrationSealMode = 'parent_may_seal_direct' | 'propose_only';

/**
 * Whether a child may be auto-sealed by host parent-orchestration.
 * Policy is stored on the **root** (passed as rootPolicy); children are non-root.
 */
export function mayParentSealDirect(
  task: MusterTask,
  rootPolicy?: ChildOrchestrationSealMode,
): boolean {
  if (task.parentId === null) return false;
  const mode = rootPolicy ?? 'parent_may_seal_direct';
  return mode === 'parent_may_seal_direct';
}

export type Effect =
  | { kind: 'commitSession' }
  | { kind: 'markMessagesComplete'; messageIds: string[] }
  | { kind: 'scheduleContinuation'; waitTurnId: string }
  | { kind: 'enqueueRetry'; ofTurnId: string }
  | { kind: 'cancelProcess' }
  | { kind: 'emitUpdate' };

export type TransitionResult<T> =
  | { ok: true; next: T; effects: Effect[] }
  | { ok: false; reason: string };

const TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

const HARD_TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'cancelled',
  'skipped',
]);

const TERMINAL_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
]);

const SETTLED_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
]);

const LIVE_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set(['running', 'waiting_user']);

export function isTerminalLifecycle(state: TaskLifecycleState): boolean {
  return TERMINAL_LIFECYCLES.has(state);
}

/** Hard terminal: sealed success/cancel/skip (distinct from soft-failed). */
export function isHardTerminalLifecycle(state: TaskLifecycleState): boolean {
  return HARD_TERMINAL_LIFECYCLES.has(state);
}

/** Soft terminal (`failed`): sealed unsuccessful attempt. */
export function isSoftTerminalLifecycle(state: TaskLifecycleState): boolean {
  return state === 'failed';
}

/**
 * Reopen any terminal task to `open` so the user can continue on the same id.
 * Follow-up is reopen-or-new-task — not a separate continuation task id.
 */
export function reopenTask(
  task: MusterTask,
  options: { now: string },
): TransitionResult<MusterTask> {
  if (!isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is not terminal' };
  }
  return {
    ok: true,
    next: bumpTask(task, options.now, {
      lifecycle: 'open',
      finishedAt: undefined,
      outcomeProposal: undefined,
      executionEpoch: (task.executionEpoch ?? 1) + 1,
    }),
    effects: [{ kind: 'emitUpdate' }],
  };
}

/** @deprecated Prefer reopenTask — soft and hard terminals both reopen on the same id. */
export function reopenSoftFailedTask(
  task: MusterTask,
  options: { now: string },
): TransitionResult<MusterTask> {
  if (task.lifecycle !== 'failed') {
    return { ok: false, reason: 'task is not soft-failed' };
  }
  return reopenTask(task, options);
}

export function isTerminalTurn(status: TurnStatus): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}

export function isSettledTurn(status: TurnStatus): boolean {
  return SETTLED_TURN_STATUSES.has(status);
}

export function hasActiveOrQueuedTurn(turns: readonly TaskTurn[]): boolean {
  return turns.some(
    (turn) => turn.status === 'queued' || LIVE_TURN_STATUSES.has(turn.status),
  );
}

export function retryCountOf(turns: readonly TaskTurn[], turnId: string): number {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  let current = byId.get(turnId);
  if (!current) {
    return 0;
  }
  let count = 0;
  while (current.retryOf) {
    count += 1;
    current = byId.get(current.retryOf);
    if (!current) {
      break;
    }
  }
  return count;
}

export interface CreateTaskInput {
  id: string;
  role: TaskRole;
  goal: string;
  description?: string;
  reason?: string;
  continuationOf?: string;
  parentId: string | null;
  dependencies: TaskDependency[];
  backend: string;
  /** Optional model id selected for this task (see MusterTask.model). */
  model?: string;
  /** Provenance task type id (see MusterTask.taskType). */
  taskType?: string;
  /** Workspace directory the agent should run in for this task (see MusterTask.cwd). */
  cwd?: string;
  capabilities: TaskCapability[];
  executionPolicy: TaskExecutionPolicy;
  /** Structured brief; default synthesized from goal/description. */
  brief?: TaskBriefV1;
  /** Draft vs released; default draft (W3 auto-run). */
  releaseState?: TaskReleaseState;
  inputBindings?: TaskInputBinding[];
  claimsGit?: boolean;
}

export interface CreateTaskContext {
  rootId: string;
  graph: DepGraph;
  now: string;
  /**
   * Internal opt-out for the verify-dependency auto-gate (verify-gate-loop default B).
   * The Phase B remediation path creates a fix task that DEPENDS on the failed verify
   * task (to run after it) but must NOT require its verdict to pass — otherwise the fix
   * could never run and the loop would not terminate. That single internal path sets
   * this true; all coordinator-initiated creates leave it false so the gate defaults on.
   */
  skipVerifyAutoGate?: boolean;
}

export interface QueueTurnOptions {
  inputs: TurnInput[];
  turnId: string;
  now: string;
  /** Default 'user'. Engine first-turn intents use 'engine'. */
  trigger?: TurnTrigger;
  retryOf?: string;
}

interface InternalQueueTurnOptions extends QueueTurnOptions {}

function bumpTask(task: MusterTask, now: string, patch: Partial<MusterTask>): MusterTask {
  return {
    ...task,
    ...patch,
    revision: task.revision + 1,
    updatedAt: now,
  };
}

function messageIdsFromInputs(inputs: readonly TurnInput[]): string[] {
  return inputs
    .filter((input): input is { kind: 'message'; messageId: string } => input.kind === 'message')
    .map((input) => input.messageId);
}

function nextSequence(turns: readonly TaskTurn[]): number {
  if (turns.length === 0) {
    return 1;
  }
  return Math.max(...turns.map((turn) => turn.sequence)) + 1;
}

function rejectUnlessTurnBelongsToTask(
  task: MusterTask,
  turn: TaskTurn,
): TransitionResult<never> | undefined {
  if (turn.taskId !== task.id) {
    return { ok: false, reason: 'turn does not belong to task' };
  }
  return undefined;
}

function queueTurn(
  task: MusterTask,
  turns: readonly TaskTurn[],
  options: InternalQueueTurnOptions,
): TransitionResult<TaskTurn> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is terminal' };
  }
  // R012: allow multiple FIFO queued turns (and queue behind a live turn).
  // One-at-a-time execution is enforced by canPromoteTurn / scheduler, not here.
  // Retry still uses exclusive queue via retryTurn's hasActiveOrQueuedTurn guard.

  const turn: TaskTurn = {
    id: options.turnId,
    taskId: task.id,
    sequence: nextSequence(turns),
    trigger: options.trigger ?? 'user',
    retryOf: options.retryOf,
    status: 'queued',
    executionEpoch: task.executionEpoch ?? 1,
    runtimeEpoch: task.runtimeEpoch ?? 1,
    inputs: [...options.inputs],
    createdAt: options.now,
  };

  return { ok: true, next: turn, effects: [] };
}

export function createTask(
  input: CreateTaskInput,
  ctx: CreateTaskContext,
): TransitionResult<MusterTask> {
  const depResult = validateDependencies(
    { taskId: input.id, rootId: ctx.rootId },
    input.dependencies,
    ctx.graph,
    false,
  );
  if (!depResult.ok) {
    return depResult;
  }

  // Verify-gate auto-default (verify-gate-loop B): a dependency whose TARGET producer is
  // a verify-kind task defaults to requiring that verification's verdict to PASS. Reuses
  // the same graph `validateDependencies` just confirmed the targets against (an O(1)
  // briefKindOf lookup — no second scan). An explicit `requiredVerdict` is never
  // overwritten, and a dependency whose target is not verify-kind is left untouched.
  const dependencies = input.dependencies.map((dep) => {
    if (dep.requiredVerdict !== undefined || ctx.skipVerifyAutoGate) return dep;
    if (ctx.graph.briefKindOf?.(dep.taskId) === 'verify') {
      return { ...dep, requiredVerdict: 'pass' as const };
    }
    return dep;
  });

  const task: MusterTask = {
    id: input.id,
    role: input.role,
    lifecycle: 'open',
    goal: input.goal,
    description: input.description,
    reason: input.reason,
    continuationOf: input.continuationOf,
    parentId: input.parentId,
    dependencies,
    backend: input.backend,
    model: input.model,
    runtimeEpoch: 1,
    ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
    cwd: input.cwd,
    capabilities: [...input.capabilities],
    executionPolicy: { ...input.executionPolicy },
    executionEpoch: 1,
    brief: input.brief ?? synthesizeBriefFromGoal(input.goal, input.description),
    releaseState: input.releaseState ?? 'draft',
    // Workspace default on roots: parent may seal direct children.
    ...(input.parentId === null
      ? { childOrchestrationSeal: 'parent_may_seal_direct' as const }
      : {}),
    ...(input.inputBindings ? { inputBindings: [...input.inputBindings] } : {}),
    ...(input.claimsGit !== undefined ? { claimsGit: input.claimsGit } : {}),
    revision: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

  return { ok: true, next: task, effects: [] };
}

export function startTask(
  task: MusterTask,
  turns: readonly TaskTurn[],
  options: QueueTurnOptions,
): TransitionResult<TaskTurn> {
  if (turns.length > 0) {
    return { ok: false, reason: 'startTask is only valid before the first turn' };
  }
  return queueTurn(task, turns, options);
}

export function continueTask(
  task: MusterTask,
  turns: readonly TaskTurn[],
  options: QueueTurnOptions,
): TransitionResult<TaskTurn> {
  // R012: allow FIFO follow-up turns while a prior turn is still live/queued.
  // startTask covers the empty-history case; continue requires at least one prior turn.
  if (turns.length === 0) {
    return { ok: false, reason: 'continueTask requires at least one prior turn' };
  }
  return queueTurn(task, turns, options);
}

export function startProcess(
  turn: TaskTurn,
  options: { now: string },
): TransitionResult<TaskTurn> {
  if (turn.status !== 'queued') {
    return { ok: false, reason: 'startProcess requires a queued turn' };
  }
  return {
    ok: true,
    next: { ...turn, status: 'running', startedAt: options.now },
    effects: [],
  };
}

export function registerAsk(turn: TaskTurn): TransitionResult<TaskTurn> {
  if (turn.status !== 'running') {
    return { ok: false, reason: 'registerAsk requires a running turn' };
  }
  return { ok: true, next: { ...turn, status: 'waiting_user' }, effects: [] };
}

export function submitAnswer(turn: TaskTurn): TransitionResult<TaskTurn> {
  if (turn.status !== 'waiting_user') {
    return { ok: false, reason: 'submitAnswer requires a waiting_user turn' };
  }
  return { ok: true, next: { ...turn, status: 'running' }, effects: [] };
}

export function applySuccessfulTurn(
  task: MusterTask,
  turn: TaskTurn,
  options: {
    now: string;
    /**
     * Coordinator sealer for eligible direct-child auto-seal.
     * When omitted, host uses parentId with mode parent_may_seal_direct.
     */
    sealedBy?: TaskSealedBy;
    /** Root's childOrchestrationSeal policy (required for correct propose_only). */
    rootChildOrchestrationSeal?: ChildOrchestrationSealMode;
    /**
     * Optional final assistant summary for a missing-disposition completionCandidate.
     * Prefer the completed assistant message; transitions clamp and fall back if absent.
     */
    candidateSummary?: string;
  },
): TransitionResult<{ task: MusterTask; turn: TaskTurn }> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is terminal' };
  }
  const ownership = rejectUnlessTurnBelongsToTask(task, turn);
  if (ownership) {
    return ownership;
  }
  if (turn.status !== 'running') {
    return { ok: false, reason: 'applySuccessfulTurn requires a running turn' };
  }

  const succeededTurn: TaskTurn = {
    ...turn,
    status: 'succeeded',
    finishedAt: options.now,
  };

  const effects: Effect[] = [
    { kind: 'commitSession' },
    { kind: 'markMessagesComplete', messageIds: messageIdsFromInputs(turn.inputs) },
  ];

  const disposition = turn.disposition;
  if (!disposition || disposition.kind === 'idle') {
    // Engine attention / parent-question turns: no disposition expected.
    if (
      turn.id.endsWith('-attention') ||
      turn.id.includes('-child-question-') ||
      turn.id.includes('parent-q-')
    ) {
      return {
        ok: true,
        next: { task, turn: succeededTurn },
        effects,
      };
    }
    // Pending ask_parent: never treat as missing disposition / repair (ISSUE-9).
    if (
      task.pendingParentQuestion &&
      task.pendingParentQuestion.answers === undefined &&
      !task.pendingParentQuestion.continuationTurnId
    ) {
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            attention: {
              code: 'awaiting_parent_answer',
              message: 'waiting for parent answers',
              at: options.now,
              sourceTurnId: turn.id,
            },
          }),
          turn: succeededTurn,
        },
        effects,
      };
    }
    // Successful terminal without complete/fail: settle once, never seal from end_turn.
    // Root chat is allowed to end without a terminal tool — leave open/idle, no fake attention.
    // Non-root child: store a completionCandidate and wake parent via awaiting_parent_seal.
    if (task.parentId === null) {
      return {
        ok: true,
        next: { task, turn: succeededTurn },
        effects,
      };
    }

    const summary = clampSummary(
      options.candidateSummary?.trim() || MISSING_DISPOSITION_CANDIDATE_SUMMARY,
    );
    const completionCandidate: TaskCompletionCandidateV1 = {
      version: 1,
      sourceTurnId: turn.id,
      observedAt: options.now,
      summary,
      reason: 'missing_disposition',
    };
    return {
      ok: true,
      next: {
        task: bumpTask(task, options.now, {
          attention: {
            code: 'awaiting_parent_seal',
            message: 'turn completed without complete/fail; awaiting parent seal',
            at: options.now,
            sourceTurnId: turn.id,
          },
          completionCandidate,
        }),
        turn: succeededTurn,
      },
      effects,
    };
  }

  switch (disposition.kind) {
    case 'complete': {
      // Persist structured TaskResultV1 on propose and seal (W1 dataflow).
      // Attach the optional verify verdict so verdict-aware dependents can gate on it.
      const taskResult = buildTaskResultFromSummary(
        disposition.result,
        task.taskResult,
        disposition.verdict,
      );
      // Root tasks: human-gated — propose only; lifecycle stays open (TASK-MANAGEMENT §5.3).
      // Eligible direct children: host parent-orchestration seals with sealedBy.coordinator.
      if (!mayParentSealDirect(task, options.rootChildOrchestrationSeal)) {
        return {
          ok: true,
          next: {
            task: bumpTask(task, options.now, {
              taskResult,
              outcomeProposal: {
                kind: 'complete',
                result: taskResult.summary,
                proposedByTurnId: turn.id,
                proposedAt: options.now,
              },
            }),
            turn: succeededTurn,
          },
          effects,
        };
      }
      const sealedBy: TaskSealedBy = options.sealedBy ?? {
        kind: 'coordinator',
        taskId: task.parentId!,
        turnId: turn.id,
        mode: 'parent_may_seal_direct',
      };
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            lifecycle: 'succeeded',
            taskResult,
            finishedAt: options.now,
            outcomeProposal: undefined,
            sealedBy,
          }),
          turn: succeededTurn,
        },
        effects,
      };
    }
    case 'fail':
      if (!mayParentSealDirect(task, options.rootChildOrchestrationSeal)) {
        return {
          ok: true,
          next: {
            task: bumpTask(task, options.now, {
              outcomeProposal: {
                kind: 'fail',
                error: disposition.error,
                proposedByTurnId: turn.id,
                proposedAt: options.now,
              },
            }),
            turn: succeededTurn,
          },
          effects,
        };
      }
      {
        const sealedBy: TaskSealedBy = options.sealedBy ?? {
          kind: 'coordinator',
          taskId: task.parentId!,
          turnId: turn.id,
          mode: 'parent_may_seal_direct',
        };
        return {
          ok: true,
          next: {
            task: bumpTask(task, options.now, {
              lifecycle: 'failed',
              error: disposition.error,
              finishedAt: options.now,
              outcomeProposal: undefined,
              sealedBy,
            }),
            turn: succeededTurn,
          },
          effects,
        };
      }
    case 'wait_tasks':
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            wait: {
              kind: 'children',
              taskIds: [...disposition.taskIds],
              registeredByTurnId: turn.id,
              // W6: new waits default to terminal + attention wake.
              wakeOn: ['terminal', 'needs_attention'],
              phase: 'active',
              terminalObserved: {},
            },
            outcomeProposal: undefined,
          }),
          turn: succeededTurn,
        },
        effects,
      };
    case 'workflow_next': {
      // M018 S02 / §20.6: NEXT settles the turn successfully but never seals the
      // producer lifecycle. Gate contribution / aggregate activation is owned by
      // the repository commit path (T04). Keep disposition on the settled turn
      // so the commit path can read change + optional body.
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            outcomeProposal: undefined,
          }),
          turn: {
            ...succeededTurn,
            disposition: turn.disposition,
          },
        },
        effects,
      };
    }
    default: {
      const _exhaustive: never = disposition;
      return _exhaustive;
    }
  }
}

export function applyFailedTurn(
  task: MusterTask,
  turn: TaskTurn,
  options: {
    error: string;
    retryCount: number;
    policy: TaskExecutionPolicy;
    onExhausted: 'recover' | 'fail';
    now: string;
    /**
     * Phase C: only `safe_to_retry` (durable pre-dispatch) uses maxAutomaticRetries
     * and enqueues a silent retry. Other classes never auto-retry.
     */
    failureClass?: TurnFailureClass;
    /**
     * M017-S06: when true, do not enqueue generic automatic model retry even if
     * failureClass is safe_to_retry (mcp setup exhaustion already ran its own
     * bounded pre-dispatch recovery loop).
     */
    suppressAutoRetry?: boolean;
  },
): TransitionResult<{ task: MusterTask; turn: TaskTurn }> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is terminal' };
  }
  const ownership = rejectUnlessTurnBelongsToTask(task, turn);
  if (ownership) {
    return ownership;
  }
  if (turn.status !== 'running') {
    return { ok: false, reason: 'applyFailedTurn requires a running turn' };
  }

  const failureClass = options.failureClass ?? 'unclassified';
  const failedTurn: TaskTurn = {
    ...turn,
    status: 'failed',
    error: options.error,
    finishedAt: options.now,
    disposition: undefined,
    failureClass,
    dispatchPhase: 'terminal_received',
  };

  // Silent auto-retry only for durable pre-dispatch safety (Phase C).
  // M017-S06: mcp setup exhaustion already exhausted its own max-2 loop — do not
  // enqueue a generic automatic model retry for the same setup failure.
  if (
    failureClass === 'safe_to_retry' &&
    !options.suppressAutoRetry &&
    options.retryCount < options.policy.maxAutomaticRetries
  ) {
    return {
      ok: true,
      next: { task: bumpTask(task, options.now, {}), turn: failedTurn },
      effects: [{ kind: 'enqueueRetry', ofTurnId: turn.id }],
    };
  }

  // Lifecycle is never sealed by CLI/turn failure — only user or authorized coordinator.
  // Exhausted retries / non-safe failures leave the task open for recovery / user decision.
  void options.onExhausted;
  return {
    ok: true,
    next: { task: bumpTask(task, options.now, {}), turn: failedTurn },
    effects: [],
  };
}

function terminalPayloadMatches(
  task: MusterTask,
  lifecycle: TaskLifecycleState,
  options: { result?: string; error?: string; reason?: string },
): boolean {
  if (lifecycle === 'succeeded') {
    const existing = task.taskResult?.summary ?? '';
    const next = options.result ?? '';
    return existing === next;
  }
  if (lifecycle === 'failed') {
    return (task.error ?? '') === (options.error ?? '');
  }
  if (lifecycle === 'cancelled' || lifecycle === 'skipped') {
    return task.reason === options.reason;
  }
  return true;
}

/**
 * User (or authorized coordinator host path) sets task lifecycle explicitly.
 * Not driven by CLI process status.
 * Idempotent terminal replay = exact payload equality → identity no-op (no sealedBy mutate).
 */
export function setTaskLifecycle(
  task: MusterTask,
  lifecycle: TaskLifecycleState,
  options: {
    now: string;
    result?: string;
    error?: string;
    reason?: string;
    /** Required on every terminal seal (W4). */
    sealedBy?: TaskSealedBy;
    /** Optional structured verify verdict to persist on the succeeded result. */
    verdict?: TaskVerdict;
  },
): TransitionResult<MusterTask> {
  const sealedBy = options.sealedBy ?? { kind: 'user' as const };

  if (task.lifecycle === lifecycle) {
    if (isTerminalLifecycle(lifecycle)) {
      if (terminalPayloadMatches(task, lifecycle, options)) {
        // Exact replay: preserve sealedBy, revision, timestamps.
        return { ok: true, next: task, effects: [] };
      }
      return { ok: false, reason: 'already_terminal' };
    }
    return {
      ok: true,
      next: bumpTask(task, options.now, { outcomeProposal: undefined }),
      effects: [{ kind: 'emitUpdate' }],
    };
  }

  if (isTerminalLifecycle(task.lifecycle) && isTerminalLifecycle(lifecycle)) {
    return { ok: false, reason: 'already_terminal' };
  }

  if (lifecycle === 'open') {
    // Any terminal lifecycle may reopen on the same task id (user choice).
    if (!isTerminalLifecycle(task.lifecycle)) {
      return { ok: false, reason: 'only terminal tasks may reopen to open' };
    }
    return reopenTask(task, { now: options.now });
  }

  if (lifecycle === 'succeeded') {
    const fromProposal =
      task.outcomeProposal?.kind === 'complete' ? task.outcomeProposal.result : undefined;
    const summary = options.result ?? fromProposal ?? task.taskResult?.summary;
    const patch: Partial<MusterTask> = {
      lifecycle: 'succeeded',
      finishedAt: options.now,
      outcomeProposal: undefined,
      sealedBy,
    };
    // Only write TaskResultV1 when a real summary exists — empty string would
    // incorrectly satisfy required inputBindings (W1 / codex-impl-review).
    if (summary !== undefined) {
      const taskResult = buildTaskResultFromSummary(summary, task.taskResult, options.verdict);
      patch.taskResult = taskResult;
    }
    return {
      ok: true,
      next: bumpTask(task, options.now, patch),
      effects: [{ kind: 'emitUpdate' }],
    };
  }

  if (lifecycle === 'failed') {
    const fromProposal =
      task.outcomeProposal?.kind === 'fail' ? task.outcomeProposal.error : undefined;
    return {
      ok: true,
      next: bumpTask(task, options.now, {
        lifecycle: 'failed',
        error: options.error ?? fromProposal ?? task.error,
        finishedAt: options.now,
        outcomeProposal: undefined,
        sealedBy,
      }),
      effects: [{ kind: 'emitUpdate' }],
    };
  }

  if (lifecycle === 'cancelled' || lifecycle === 'skipped') {
    return {
      ok: true,
      next: bumpTask(task, options.now, {
        lifecycle,
        finishedAt: options.now,
        outcomeProposal: undefined,
        sealedBy,
        // Always set reason (including undefined) so reopened tasks don't keep stale reasons.
        reason: options.reason,
      }),
      effects: [{ kind: 'emitUpdate' }],
    };
  }

  return { ok: false, reason: 'unsupported lifecycle' };
}

export function interruptTurn(
  turn: TaskTurn,
  options: { now: string },
): TransitionResult<TaskTurn> {
  if (!LIVE_TURN_STATUSES.has(turn.status)) {
    return { ok: false, reason: 'interruptTurn requires a live turn' };
  }
  return {
    ok: true,
    next: {
      ...turn,
      status: 'interrupted',
      finishedAt: options.now,
      disposition: undefined,
    },
    effects: [],
  };
}

export function retryTurn(
  task: MusterTask,
  turns: readonly TaskTurn[],
  oldTurn: TaskTurn,
  options: {
    turnId: string;
    instruction: string;
    now: string;
    /**
     * Phase C safe auto-retry: reuse original message input ids so the backend
     * prompt equals the original turn (no diagnostic-only recovery text).
     */
    reuseOriginalInputs?: boolean;
  },
): TransitionResult<TaskTurn> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is terminal' };
  }
  if (!turns.some((turn) => turn.id === oldTurn.id)) {
    return { ok: false, reason: 'oldTurn is not in turns' };
  }
  if (oldTurn.taskId !== task.id) {
    return { ok: false, reason: 'oldTurn does not belong to task' };
  }
  if (oldTurn.status !== 'failed' && oldTurn.status !== 'interrupted') {
    return { ok: false, reason: 'retryTurn requires a failed or interrupted turn' };
  }
  // Safe auto-retry may coexist with held follow-ups; other retries still require a clear queue.
  const blocking = turns.filter(
    (turn) =>
      turn.status === 'running' ||
      turn.status === 'waiting_user' ||
      (turn.status === 'queued' &&
        !(options.reuseOriginalInputs && turn.holdAutoPromote === true)),
  );
  if (blocking.length > 0) {
    return { ok: false, reason: 'task already has an active or queued turn' };
  }

  const inputs = options.reuseOriginalInputs
    ? [...oldTurn.inputs]
    : [
        {
          kind: 'recovery' as const,
          interruptedTurnId: oldTurn.id,
          instruction: options.instruction,
        },
      ];
  if (options.reuseOriginalInputs && inputs.length === 0) {
    return { ok: false, reason: 'cannot reuse original inputs: empty input list' };
  }

  return queueTurn(task, turns, {
    turnId: options.turnId,
    now: options.now,
    trigger: 'retry',
    retryOf: oldTurn.id,
    inputs,
  });
}

export function cancelPendingTurn(
  turn: TaskTurn,
  options: { now: string },
): TransitionResult<TaskTurn> {
  if (turn.status === 'queued' || LIVE_TURN_STATUSES.has(turn.status)) {
    return {
      ok: true,
      next: {
        ...turn,
        status: 'cancelled',
        candidateSessionId: turn.observedSessionId ?? turn.candidateSessionId,
        isCancellation: LIVE_TURN_STATUSES.has(turn.status) ? true : turn.isCancellation,
        finishedAt: options.now,
        disposition: undefined,
      },
      effects: LIVE_TURN_STATUSES.has(turn.status) ? [{ kind: 'cancelProcess' }] : [],
    };
  }
  return { ok: false, reason: 'turn is not pending' };
}

/**
 * R013: pure predicate for editing an undispatched queued follow-up.
 * Mutates only the bound pending user message content once applied by the engine.
 * Fail-closed at the queued→running assign boundary (status !== 'queued' or message not pending).
 */
export function prepareEditQueuedTurn(
  taskId: string,
  turn: TaskTurn | undefined,
  messages: Readonly<Record<string, TaskMessage>>,
  content: string,
): TransitionResult<{ messageId: string; content: string }> {
  if (!turn) {
    return { ok: false, reason: 'turn not found' };
  }
  if (turn.taskId !== taskId) {
    return { ok: false, reason: 'turn does not belong to task' };
  }
  if (turn.status !== 'queued') {
    return { ok: false, reason: 'turn is not queued' };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'invalid content' };
  }

  const messageIds = messageIdsFromInputs(turn.inputs);
  if (messageIds.length === 0) {
    return { ok: false, reason: 'message not found' };
  }
  // One-message-per-turn FIFO: edit the first (only) bound user message.
  // Multi-message inputs are not expected for R012 queue entries, but we still
  // validate every bound message is a pending user message on this task.
  for (const messageId of messageIds) {
    const message = messages[messageId];
    if (!message) {
      return { ok: false, reason: 'message not found' };
    }
    if (message.taskId !== taskId) {
      return { ok: false, reason: 'message not found' };
    }
    if (message.role !== 'user') {
      return { ok: false, reason: 'message is not pending' };
    }
    if (message.state !== 'pending') {
      return { ok: false, reason: 'message is not pending' };
    }
  }

  return {
    ok: true,
    next: { messageId: messageIds[0]!, content: trimmed },
    effects: [],
  };
}

/**
 * R013: pure predicate for deleting an undispatched queued follow-up turn.
 * Removes the turn row and its bound pending user messages only — no cancelProcess,
 * no lifecycle change, no mutation of live/settled turns.
 */
export function prepareDeleteQueuedTurn(
  taskId: string,
  turn: TaskTurn | undefined,
  messages: Readonly<Record<string, TaskMessage>>,
): TransitionResult<{ turnId: string; messageIds: string[] }> {
  if (!turn) {
    return { ok: false, reason: 'turn not found' };
  }
  if (turn.taskId !== taskId) {
    return { ok: false, reason: 'turn does not belong to task' };
  }
  if (turn.status !== 'queued') {
    return { ok: false, reason: 'turn is not queued' };
  }

  const messageIds = messageIdsFromInputs(turn.inputs);
  for (const messageId of messageIds) {
    const message = messages[messageId];
    if (!message) {
      return { ok: false, reason: 'message not found' };
    }
    if (message.taskId !== taskId) {
      return { ok: false, reason: 'message not found' };
    }
    if (message.role !== 'user' || message.state !== 'pending') {
      return { ok: false, reason: 'message is not pending' };
    }
  }

  return {
    ok: true,
    next: { turnId: turn.id, messageIds },
    effects: [],
  };
}

export function applyDependencyTerminal(
  task: MusterTask,
  pendingTurn: TaskTurn | undefined,
  outcome: 'failed' | 'skipped',
  options: { now: string; error?: string; sealedBy?: TaskSealedBy },
): TransitionResult<{ task: MusterTask; turn?: TaskTurn }> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is already terminal' };
  }

  const sealedBy: TaskSealedBy = options.sealedBy ?? {
    kind: 'coordinator',
    taskId: task.parentId ?? task.id,
    mode: 'dependency_policy',
  };
  const terminalTask = bumpTask(task, options.now, {
    lifecycle: outcome,
    finishedAt: options.now,
    sealedBy,
    ...(outcome === 'failed' ? { error: options.error ?? 'dependency unsatisfied' } : {}),
  });

  let settledTurn: TaskTurn | undefined;
  const effects: Effect[] = [];
  if (pendingTurn) {
    const ownership = rejectUnlessTurnBelongsToTask(task, pendingTurn);
    if (ownership) {
      return ownership;
    }
    const cancelled = cancelPendingTurn(pendingTurn, { now: options.now });
    if (!cancelled.ok) {
      return cancelled;
    }
    settledTurn = cancelled.next;
    effects.push(...cancelled.effects);
  }

  return {
    ok: true,
    next: { task: terminalTask, turn: settledTurn },
    effects,
  };
}

export function cancelTask(
  task: MusterTask,
  options: { liveTurn?: TaskTurn; now: string; sealedBy?: TaskSealedBy },
): TransitionResult<{ task: MusterTask; turn?: TaskTurn }> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is already terminal' };
  }

  const effects: Effect[] = [];
  let cancelledTurn: TaskTurn | undefined;

  if (options.liveTurn) {
    const ownership = rejectUnlessTurnBelongsToTask(task, options.liveTurn);
    if (ownership) {
      return ownership;
    }
    if (!LIVE_TURN_STATUSES.has(options.liveTurn.status)) {
      return { ok: false, reason: 'liveTurn must be running or waiting_user' };
    }
    cancelledTurn = {
      ...options.liveTurn,
      status: 'cancelled',
      candidateSessionId: options.liveTurn.observedSessionId ?? options.liveTurn.candidateSessionId,
      isCancellation: true,
      finishedAt: options.now,
      disposition: undefined,
    };
    effects.push({ kind: 'cancelProcess' });
  }

  const sealedBy: TaskSealedBy = options.sealedBy ?? { kind: 'user' };
  const cancelledTask = bumpTask(task, options.now, {
    lifecycle: 'cancelled',
    finishedAt: options.now,
    sealedBy,
  });

  return {
    ok: true,
    next: { task: cancelledTask, turn: cancelledTurn },
    effects,
  };
}

function allChildrenTerminal(
  taskIds: readonly string[],
  childLifecycles: ReadonlyMap<string, TaskLifecycleState>,
): boolean {
  return taskIds.every((id) => {
    const lifecycle = childLifecycles.get(id);
    return lifecycle !== undefined && TERMINAL_LIFECYCLES.has(lifecycle);
  });
}

function hasContinuationForWait(
  turns: readonly TaskTurn[],
  wait: {
    kind: 'children';
    taskIds: string[];
    registeredByTurnId: string;
    attentionContinuationTurnId?: string;
  },
  continuationTurnId: string,
): boolean {
  if (turns.some((turn) => turn.id === continuationTurnId)) {
    return true;
  }
  const registeringTurn = turns.find((turn) => turn.id === wait.registeredByTurnId);
  if (!registeringTurn) {
    return false;
  }
  return turns.some(
    (turn) =>
      turn.trigger === 'engine' &&
      // Attention wakes must not satisfy the terminal barrier (P0.5 ask_parent ISSUE-3).
      !turn.id.endsWith('-attention') &&
      turn.id !== wait.attentionContinuationTurnId &&
      turn.sequence > registeringTurn.sequence &&
      turn.inputs.some(
        (input) =>
          input.kind === 'child_results' &&
          input.taskIds.length === wait.taskIds.length &&
          input.taskIds.every((id) => wait.taskIds.includes(id)),
      ),
  );
}

/** Wake events persisted with every children wait. */
export function effectiveWaitWakeOn(
  wait: Extract<MusterTask['wait'], { kind: 'children' }>,
): Array<'terminal' | 'needs_attention'> {
  return wait.wakeOn;
}

export function resolveChildWait(
  task: MusterTask,
  childLifecycles: ReadonlyMap<string, TaskLifecycleState>,
  turns: readonly TaskTurn[],
  options: {
    continuationTurnId: string;
    now: string;
    /** Child attention map for needs_attention wake (W6). */
    childAttention?: ReadonlyMap<string, { code: string } | undefined>;
  },
): TransitionResult<{ task: MusterTask; turn?: TaskTurn }> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is terminal' };
  }

  const wait = task.wait;

  if (wait?.kind === 'children') {
    if (
      hasContinuationForWait(turns, wait, options.continuationTurnId) ||
      turns.some((turn) => turn.id === options.continuationTurnId)
    ) {
      const clearedTask = bumpTask(task, options.now, { wait: undefined });
      return { ok: true, next: { task: clearedTask }, effects: [] };
    }
  } else if (turns.some((turn) => turn.id === options.continuationTurnId)) {
    return { ok: true, next: { task }, effects: [] };
  } else {
    return { ok: false, reason: 'task has no children wait' };
  }

  const wakeOn = effectiveWaitWakeOn(wait);
  const terminalObserved = { ...(wait.terminalObserved ?? {}) };
  for (const childId of wait.taskIds) {
    const lifecycle = childLifecycles.get(childId);
    if (
      lifecycle === 'succeeded' ||
      lifecycle === 'failed' ||
      lifecycle === 'cancelled' ||
      lifecycle === 'skipped'
    ) {
      terminalObserved[childId] = lifecycle;
    }
  }

  // Attention wake: one continuation while suspended; do not clear terminalObserved.
  if (
    wakeOn.includes('needs_attention') &&
    wait.phase !== 'suspended_attention' &&
    options.childAttention
  ) {
    const attentionChild = wait.taskIds.find((id) => {
      // Any child attention (including awaiting_parent_seal) wakes the parent.
      return options.childAttention?.get(id) !== undefined;
    });
    if (attentionChild && !wait.attentionContinuationTurnId) {
      const attentionTurnId = `${wait.registeredByTurnId}-attention`;
      if (!turns.some((t) => t.id === attentionTurnId)) {
        const attentionTurn: TaskTurn = {
          id: attentionTurnId,
          taskId: task.id,
          sequence: nextSequence(turns),
          trigger: 'engine',
          status: 'queued',
          inputs: [{ kind: 'child_results', taskIds: [...wait.taskIds] }],
          createdAt: options.now,
        };
        return {
          ok: true,
          next: {
            task: bumpTask(task, options.now, {
              wait: {
                ...wait,
                phase: 'suspended_attention',
                attentionContinuationTurnId: attentionTurnId,
                terminalObserved,
              },
            }),
            turn: attentionTurn,
          },
          effects: [{ kind: 'scheduleContinuation', waitTurnId: wait.registeredByTurnId }],
        };
      }
    }
  }

  if (!allChildrenTerminal(wait.taskIds, childLifecycles)) {
    // Persist observed terminals while still waiting.
    if (JSON.stringify(terminalObserved) !== JSON.stringify(wait.terminalObserved ?? {})) {
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            wait: { ...wait, terminalObserved },
          }),
        },
        effects: [],
      };
    }
    return { ok: true, next: { task }, effects: [] };
  }

  if (!wakeOn.includes('terminal')) {
    return { ok: true, next: { task }, effects: [] };
  }

  const continuationTurn: TaskTurn = {
    id: options.continuationTurnId,
    taskId: task.id,
    sequence: nextSequence(turns),
    trigger: 'engine',
    status: 'queued',
    inputs: [{ kind: 'child_results', taskIds: [...wait.taskIds] }],
    createdAt: options.now,
  };

  return {
    ok: true,
    next: {
      task: bumpTask(task, options.now, { wait: undefined }),
      turn: continuationTurn,
    },
    effects: [{ kind: 'scheduleContinuation', waitTurnId: wait.registeredByTurnId }],
  };
}

function dispositionsEqual(a: TurnDisposition, b: TurnDisposition): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'complete':
      return b.kind === 'complete' && a.result === b.result;
    case 'fail':
      return b.kind === 'fail' && a.error === b.error;
    case 'wait_tasks':
      return (
        b.kind === 'wait_tasks' &&
        a.taskIds.length === b.taskIds.length &&
        a.taskIds.every((id, index) => id === b.taskIds[index])
      );
    case 'idle':
      return b.kind === 'idle';
    case 'workflow_next':
      return (
        b.kind === 'workflow_next' &&
        a.change === b.change &&
        (a.result ?? undefined) === (b.result ?? undefined)
      );
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function boundDisposition(
  disposition: TurnDisposition,
  limits: { maxResult: number; maxError: number },
): TurnDisposition {
  switch (disposition.kind) {
    case 'complete':
      // Pass the structured verdict through unchanged (already normalized/clamped upstream).
      return {
        kind: 'complete',
        result: truncateUtf8Bytes(disposition.result, limits.maxResult).text,
        ...(disposition.verdict ? { verdict: disposition.verdict } : {}),
      };
    case 'fail':
      return { kind: 'fail', error: truncateUtf8Bytes(disposition.error, limits.maxError).text };
    case 'workflow_next':
      return {
        kind: 'workflow_next',
        change: disposition.change,
        ...(disposition.result !== undefined
          ? { result: truncateUtf8Bytes(disposition.result, limits.maxResult).text }
          : {}),
      };
    default:
      return disposition;
  }
}

export function stageDisposition(
  turn: TaskTurn,
  disposition: TurnDisposition,
  opId: string,
  options: { acceptedOpId?: string; limits?: { maxResult: number; maxError: number } },
): TransitionResult<{ turn: TaskTurn; acceptedOpId: string }> {
  if (!LIVE_TURN_STATUSES.has(turn.status)) {
    return { ok: false, reason: 'stageDisposition requires a live turn' };
  }

  if (
    disposition.kind === 'complete' ||
    disposition.kind === 'fail' ||
    disposition.kind === 'workflow_next'
  ) {
    if (!options.limits) {
      return {
        ok: false,
        reason: 'limits are required for complete, fail, or workflow_next dispositions',
      };
    }
  }

  const bounded = options.limits ? boundDisposition(disposition, options.limits) : disposition;

  if (!turn.disposition) {
    return {
      ok: true,
      next: { turn: { ...turn, disposition: bounded }, acceptedOpId: opId },
      effects: [],
    };
  }

  if (options.acceptedOpId === opId) {
    if (dispositionsEqual(turn.disposition, bounded)) {
      return {
        ok: true,
        next: { turn, acceptedOpId: opId },
        effects: [],
      };
    }
    return { ok: false, reason: 'same opId with different disposition' };
  }

  return { ok: false, reason: 'disposition already staged with a different opId' };
}

export interface WaitDispositionMerge {
  turn: TaskTurn;
  addedTaskIds: string[];
  alreadyStaged: boolean;
  waitTaskIds: string[];
}

/**
 * Monotonically arms a child wait barrier on a live turn.
 *
 * Wait is deliberately different from terminal dispositions: independent compound
 * operations may each add a child to the same barrier, and a coordinator may
 * redundantly call `wait_for_tasks` after a compound wait.  Both cases are success.
 * Complete/fail/idle remain mutually exclusive with wait and still fail closed.
 */
export function mergeWaitDisposition(
  turn: TaskTurn,
  requestedTaskIds: readonly string[],
): TransitionResult<WaitDispositionMerge> {
  if (!LIVE_TURN_STATUSES.has(turn.status)) {
    return { ok: false, reason: 'mergeWaitDisposition requires a live turn' };
  }
  const requested = [...new Set(requestedTaskIds)];
  if (requested.length === 0) {
    return { ok: false, reason: 'wait set must be non-empty' };
  }
  if (turn.disposition && turn.disposition.kind !== 'wait_tasks') {
    return {
      ok: false,
      reason: `disposition conflict: current disposition is ${turn.disposition.kind}`,
    };
  }

  const existing = turn.disposition?.kind === 'wait_tasks'
    ? [...new Set(turn.disposition.taskIds)]
    : [];
  const existingSet = new Set(existing);
  const addedTaskIds = requested.filter((id) => !existingSet.has(id));
  const waitTaskIds = [...existing, ...addedTaskIds];
  const alreadyStaged = existing.length > 0 && addedTaskIds.length === 0;
  const nextTurn =
    turn.disposition?.kind === 'wait_tasks' && addedTaskIds.length === 0
      ? turn
      : { ...turn, disposition: { kind: 'wait_tasks' as const, taskIds: waitTaskIds } };

  return {
    ok: true,
    next: { turn: nextTurn, addedTaskIds, alreadyStaged, waitTaskIds },
    effects: [],
  };
}

/**
 * MEM030: mark already-queued follow-ups so they are not auto-promoted after a
 * failed/interrupted live settlement. Call inside the same commit that settles
 * the live turn, before creating post-settlement retry/recovery turns.
 */
export function holdQueuedFollowUpsOnFailure(
  draft: { turns: Record<string, TaskTurn> },
  taskId: string,
): void {
  for (const turn of Object.values(draft.turns)) {
    if (turn.taskId !== taskId || turn.status !== 'queued') continue;
    if (turn.holdAutoPromote) continue;
    draft.turns[turn.id] = { ...turn, holdAutoPromote: true };
  }
}
