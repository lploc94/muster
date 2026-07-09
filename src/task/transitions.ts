import { validateDependencies, type DepGraph } from './deps';
import type {
  MusterTask,
  TaskCapability,
  TaskDependency,
  TaskExecutionPolicy,
  TaskLifecycleState,
  TaskRole,
  TaskTurn,
  TurnDisposition,
  TurnInput,
  TurnStatus,
  TurnTrigger,
} from './types';

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

/** Hard terminal: read-only; further work is a new/continuation task. */
export function isHardTerminalLifecycle(state: TaskLifecycleState): boolean {
  return HARD_TERMINAL_LIFECYCLES.has(state);
}

/** Soft terminal (`failed`): same task may reopen on a new user message. */
export function isSoftTerminalLifecycle(state: TaskLifecycleState): boolean {
  return state === 'failed';
}

/**
 * Reopen a soft-failed task to `open` so the user can continue on the same id.
 */
export function reopenSoftFailedTask(
  task: MusterTask,
  options: { now: string },
): TransitionResult<MusterTask> {
  if (task.lifecycle !== 'failed') {
    return { ok: false, reason: 'task is not soft-failed' };
  }
  return {
    ok: true,
    next: bumpTask(task, options.now, {
      lifecycle: 'open',
      finishedAt: undefined,
    }),
    effects: [{ kind: 'emitUpdate' }],
  };
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
  /** Workspace directory the agent should run in for this task (see MusterTask.cwd). */
  cwd?: string;
  capabilities: TaskCapability[];
  executionPolicy: TaskExecutionPolicy;
}

export interface CreateTaskContext {
  rootId: string;
  graph: DepGraph;
  now: string;
}

export interface QueueTurnOptions {
  inputs: TurnInput[];
  turnId: string;
  now: string;
}

interface InternalQueueTurnOptions extends QueueTurnOptions {
  trigger?: TurnTrigger;
  retryOf?: string;
}

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
  if (hasActiveOrQueuedTurn(turns)) {
    return { ok: false, reason: 'task already has an active or queued turn' };
  }

  const turn: TaskTurn = {
    id: options.turnId,
    taskId: task.id,
    sequence: nextSequence(turns),
    trigger: options.trigger ?? 'user',
    retryOf: options.retryOf,
    status: 'queued',
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

  const task: MusterTask = {
    id: input.id,
    role: input.role,
    lifecycle: 'open',
    goal: input.goal,
    description: input.description,
    reason: input.reason,
    continuationOf: input.continuationOf,
    parentId: input.parentId,
    dependencies: [...input.dependencies],
    backend: input.backend,
    model: input.model,
    cwd: input.cwd,
    capabilities: [...input.capabilities],
    executionPolicy: { ...input.executionPolicy },
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
  if (!turns.some((turn) => isSettledTurn(turn.status))) {
    return { ok: false, reason: 'continueTask requires at least one settled turn' };
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
  options: { now: string },
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
    return {
      ok: true,
      next: { task: bumpTask(task, options.now, {}), turn: succeededTurn },
      effects,
    };
  }

  switch (disposition.kind) {
    case 'complete':
      // Root tasks: human-gated — propose only; lifecycle stays open (TASK-MANAGEMENT §5.3).
      // Non-root: seal for orchestration / wait barriers.
      if (task.parentId === null) {
        return {
          ok: true,
          next: {
            task: bumpTask(task, options.now, {
              outcomeProposal: {
                kind: 'complete',
                result: disposition.result,
                proposedByTurnId: turn.id,
                proposedAt: options.now,
              },
            }),
            turn: succeededTurn,
          },
          effects,
        };
      }
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            lifecycle: 'succeeded',
            result: disposition.result,
            finishedAt: options.now,
            outcomeProposal: undefined,
          }),
          turn: succeededTurn,
        },
        effects,
      };
    case 'fail':
      if (task.parentId === null) {
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
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            lifecycle: 'failed',
            error: disposition.error,
            finishedAt: options.now,
            outcomeProposal: undefined,
          }),
          turn: succeededTurn,
        },
        effects,
      };
    case 'wait_tasks':
      return {
        ok: true,
        next: {
          task: bumpTask(task, options.now, {
            wait: {
              kind: 'children',
              taskIds: [...disposition.taskIds],
              registeredByTurnId: turn.id,
            },
            outcomeProposal: undefined,
          }),
          turn: succeededTurn,
        },
        effects,
      };
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

  const failedTurn: TaskTurn = {
    ...turn,
    status: 'failed',
    error: options.error,
    finishedAt: options.now,
    disposition: undefined,
  };

  if (options.retryCount < options.policy.maxAutomaticRetries) {
    return {
      ok: true,
      next: { task: bumpTask(task, options.now, {}), turn: failedTurn },
      effects: [{ kind: 'enqueueRetry', ofTurnId: turn.id }],
    };
  }

  // Lifecycle is never sealed by CLI/turn failure — only user or authorized coordinator.
  // Exhausted retries leave the task open for recovery / user decision.
  void options.onExhausted;
  return {
    ok: true,
    next: { task: bumpTask(task, options.now, {}), turn: failedTurn },
    effects: [],
  };
}

/**
 * User (or authorized coordinator host path) sets task lifecycle explicitly.
 * Not driven by CLI process status.
 */
export function setTaskLifecycle(
  task: MusterTask,
  lifecycle: TaskLifecycleState,
  options: {
    now: string;
    result?: string;
    error?: string;
    /** Who applied the change (audit; optional). */
    sealedBy?: 'user' | 'coordinator';
  },
): TransitionResult<MusterTask> {
  if (task.lifecycle === lifecycle) {
    return {
      ok: true,
      next: bumpTask(task, options.now, {
        outcomeProposal: undefined,
        ...(lifecycle === 'succeeded' && options.result !== undefined
          ? { result: options.result }
          : {}),
        ...(lifecycle === 'failed' && options.error !== undefined ? { error: options.error } : {}),
      }),
      effects: [{ kind: 'emitUpdate' }],
    };
  }

  if (lifecycle === 'open') {
    // Soft-fail reopen only. Hard terminals require a new/continuation task.
    if (task.lifecycle !== 'failed') {
      return { ok: false, reason: 'only soft-failed tasks may reopen to open' };
    }
    return {
      ok: true,
      next: bumpTask(task, options.now, {
        lifecycle: 'open',
        finishedAt: undefined,
        outcomeProposal: undefined,
      }),
      effects: [{ kind: 'emitUpdate' }],
    };
  }

  if (lifecycle === 'succeeded') {
    const fromProposal =
      task.outcomeProposal?.kind === 'complete' ? task.outcomeProposal.result : undefined;
    return {
      ok: true,
      next: bumpTask(task, options.now, {
        lifecycle: 'succeeded',
        result: options.result ?? fromProposal ?? task.result,
        finishedAt: options.now,
        outcomeProposal: undefined,
      }),
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
  options: { turnId: string; instruction: string; now: string },
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
  if (hasActiveOrQueuedTurn(turns)) {
    return { ok: false, reason: 'task already has an active or queued turn' };
  }

  return queueTurn(task, turns, {
    turnId: options.turnId,
    now: options.now,
    trigger: 'retry',
    retryOf: oldTurn.id,
    inputs: [
      {
        kind: 'recovery',
        interruptedTurnId: oldTurn.id,
        instruction: options.instruction,
      },
    ],
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

export function applyDependencyTerminal(
  task: MusterTask,
  pendingTurn: TaskTurn | undefined,
  outcome: 'failed' | 'skipped',
  options: { now: string; error?: string },
): TransitionResult<{ task: MusterTask; turn?: TaskTurn }> {
  if (isTerminalLifecycle(task.lifecycle)) {
    return { ok: false, reason: 'task is already terminal' };
  }

  const terminalTask = bumpTask(task, options.now, {
    lifecycle: outcome,
    finishedAt: options.now,
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
  options: { liveTurn?: TaskTurn; now: string },
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

  const cancelledTask = bumpTask(task, options.now, {
    lifecycle: 'cancelled',
    finishedAt: options.now,
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
  wait: { kind: 'children'; taskIds: string[]; registeredByTurnId: string },
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
      turn.sequence > registeringTurn.sequence &&
      turn.inputs.some(
        (input) =>
          input.kind === 'child_results' &&
          input.taskIds.length === wait.taskIds.length &&
          input.taskIds.every((id) => wait.taskIds.includes(id)),
      ),
  );
}

export function resolveChildWait(
  task: MusterTask,
  childLifecycles: ReadonlyMap<string, TaskLifecycleState>,
  turns: readonly TaskTurn[],
  options: { continuationTurnId: string; now: string },
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

  if (!allChildrenTerminal(wait.taskIds, childLifecycles)) {
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

function clampString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
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
      return { kind: 'complete', result: clampString(disposition.result, limits.maxResult) };
    case 'fail':
      return { kind: 'fail', error: clampString(disposition.error, limits.maxError) };
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

  if (disposition.kind === 'complete' || disposition.kind === 'fail') {
    if (!options.limits) {
      return { ok: false, reason: 'limits are required for complete or fail dispositions' };
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