import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import { runTurn as defaultRunTurn } from '../runner';
import type { Backend, NormalizedEvent, RunOptions } from '../types';
import { canBindTaskToBackend } from './backend-eligibility';
import { deriveViewStatus } from './derived-status';
import type { DepGraph } from './deps';
import { selectCommittedSessionId } from './session-select';
import { TaskStore } from './store';
import {
  applyFailedTurn,
  applySuccessfulTurn,
  createTask,
  interruptTurn,
  retryCountOf,
  retryTurn,
  resolveChildWait,
  stageDisposition,
  startProcess,
  startTask as transitionStartTask,
  continueTask as transitionContinueTask,
  cancelTask as transitionCancelTask,
  isTerminalLifecycle,
  type CreateTaskInput,
  type Effect,
} from './transitions';
import type {
  MusterTask,
  TaskCapability,
  TaskDependency,
  TaskExecutionPolicy,
  TaskLifecycleState,
  TaskMessage,
  TaskRole,
  TaskStoreFile,
  TaskTurn,
  TurnDisposition,
  TurnInput,
} from './types';

export interface DispositionLimits {
  maxResult: number;
  maxError: number;
}

export interface TaskEngineConfig {
  store: TaskStore;
  makeBackend: (name: string) => Backend;
  runTurn?: (backend: Backend, options: RunOptions) => AsyncIterable<NormalizedEvent>;
  dispositionLimits?: DispositionLimits;
  clock?: () => string;
}

export type EngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

interface LockRecord {
  pid: number;
  token: string;
}

const DEFAULT_POLICY: TaskExecutionPolicy = {
  maxTurns: 50,
  maxAutomaticRetries: 2,
  turnTimeoutMs: 300_000,
  taskTimeoutMs: 1_800_000,
};

const DEFAULT_LIMITS: DispositionLimits = { maxResult: 16_384, maxError: 4_096 };

function nowIso(clock?: () => string): string {
  return clock?.() ?? new Date().toISOString();
}

function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'ESRCH';
  }
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockRecord;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function leasePath(storePath: string, turnId: string): string {
  return `${storePath}.lease.${turnId}`;
}

function tryAcquireLease(storePath: string, turnId: string): LockRecord | undefined {
  const path = leasePath(storePath, turnId);
  const record: LockRecord = { pid: process.pid, token: randomBytes(16).toString('hex') };
  try {
    const fd = fs.openSync(path, 'wx');
    fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
    fs.closeSync(fd);
    return record;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      return undefined;
    }
    const existing = readLockRecord(path);
    if (!existing || !isProcessDead(existing.pid)) {
      return undefined;
    }
    try {
      fs.unlinkSync(path);
    } catch {
      return undefined;
    }
    return tryAcquireLease(storePath, turnId);
  }
}

function releaseLease(storePath: string, turnId: string, record: LockRecord): void {
  const path = leasePath(storePath, turnId);
  const existing = readLockRecord(path);
  if (existing?.pid === record.pid && existing.token === record.token) {
    try {
      fs.unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

function leaseOwnerAlive(storePath: string, turnId: string): boolean {
  const existing = readLockRecord(leasePath(storePath, turnId));
  if (!existing) {
    return false;
  }
  return !isProcessDead(existing.pid);
}

export function projectPrompt(
  turn: TaskTurn,
  messages: ReadonlyMap<string, TaskMessage>,
): string {
  const parts: string[] = [];
  const messageInputs = turn.inputs
    .filter((input): input is { kind: 'message'; messageId: string } => input.kind === 'message')
    .map((input) => messages.get(input.messageId))
    .filter((message): message is TaskMessage => message !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const message of messageInputs) {
    parts.push(message.content);
  }

  for (const input of turn.inputs) {
    switch (input.kind) {
      case 'message':
        break;
      case 'recovery':
        parts.push(input.instruction);
        break;
      case 'child_results':
        parts.push(
          ['[child_results]', ...input.taskIds.map((id) => `- ${id}`)].join('\n'),
        );
        break;
      default: {
        const _exhaustive: never = input;
        return _exhaustive;
      }
    }
  }
  return parts.join('\n\n');
}

function messageMapFromFile(file: TaskStoreFile): Map<string, TaskMessage> {
  return new Map(Object.entries(file.messages));
}

function depGraphFromFile(file: TaskStoreFile): DepGraph {
  return {
    rootOf: (taskId) => {
      const task = file.tasks[taskId];
      if (!task) {
        return undefined;
      }
      let current = task;
      while (current.parentId) {
        const parent = file.tasks[current.parentId];
        if (!parent) {
          break;
        }
        current = parent;
      }
      return current.id;
    },
    dependsOn: (taskId) => file.tasks[taskId]?.dependencies.map((dep) => dep.taskId) ?? [],
  };
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

function pendingUserMessages(file: TaskStoreFile, taskId: string): TaskMessage[] {
  return Object.values(file.messages)
    .filter((message) => message.taskId === taskId && message.role === 'user' && message.state === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function deterministicRetryTurnId(failedTurnId: string, retryIndex: number): string {
  return `${failedTurnId}-auto-retry-${retryIndex}`;
}

function viewStatusFromDraft(draft: TaskStoreFile, taskId: string) {
  const task = draft.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const depLifecycles = new Map(
    task.dependencies
      .map((dep) => [dep.taskId, draft.tasks[dep.taskId]?.lifecycle] as const)
      .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined),
  );
  return deriveViewStatus(task, turnsForTask(draft, taskId), depLifecycles);
}

export class TaskEngine {
  private readonly store: TaskStore;
  private readonly makeBackend: (name: string) => Backend;
  private readonly runTurnFn: (backend: Backend, options: RunOptions) => AsyncIterable<NormalizedEvent>;
  private readonly limits: DispositionLimits;
  private readonly clock?: () => string;
  private readonly storePath: string;
  private readonly liveRuns = new Map<string, AbortController>();
  private readonly acceptedOpIds = new Map<string, string>();
  private readonly turnPromises = new Map<string, Promise<void>>();
  private settling = new Set<string>();

  private constructor(config: TaskEngineConfig, storePath: string) {
    this.store = config.store;
    this.makeBackend = config.makeBackend;
    this.runTurnFn = config.runTurn ?? defaultRunTurn;
    this.limits = config.dispositionLimits ?? DEFAULT_LIMITS;
    this.clock = config.clock;
    this.storePath = storePath;
  }

  static load(config: TaskEngineConfig): TaskEngine {
    const engine = new TaskEngine(config, config.store.getStorePath());
    engine.reconcileReload();
    return engine;
  }

  async whenIdle(): Promise<void> {
    await Promise.all([...this.turnPromises.values()]);
  }

  viewStatus(taskId: string) {
    return this.store.viewStatusOf(taskId);
  }

  createTask(params: {
    id?: string;
    goal: string;
    backend: string;
    role?: TaskRole;
    dependencies?: TaskDependency[];
    capabilities?: TaskCapability[];
    executionPolicy?: TaskExecutionPolicy;
  }): EngineResult<{ taskId: string }> {
    const backend = this.makeBackend(params.backend);
    if (!canBindTaskToBackend(backend.capabilities)) {
      return { ok: false, reason: 'backend does not support MCP' };
    }

    const taskId = params.id ?? randomUUID();
    const now = nowIso(this.clock);
    const input: CreateTaskInput = {
      id: taskId,
      role: params.role ?? 'coordinator',
      goal: params.goal,
      parentId: null,
      dependencies: params.dependencies ?? [],
      backend: params.backend,
      capabilities: params.capabilities ?? ['create_child', 'start_child', 'wait_child', 'read_subtree'],
      executionPolicy: params.executionPolicy ?? DEFAULT_POLICY,
    };

    const commit = this.store.commit((draft) => {
      if (draft.tasks[taskId]) {
        return { ok: false, reason: 'task id already exists' };
      }
      const graph = depGraphFromFile(draft);
      const result = createTask(input, { rootId: taskId, graph, now });
      if (!result.ok) {
        return result;
      }
      draft.tasks[taskId] = result.next;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    return { ok: true, value: { taskId } };
  }

  send(taskId: string, content: string): EngineResult<{ messageId: string; turnId?: string }> {
    const messageId = randomUUID();
    const now = nowIso(this.clock);
    let queuedTurnId: string | undefined;

    const commit = this.store.commit((draft) => {
      const draftTask = draft.tasks[taskId];
      if (!draftTask) {
        return { ok: false, reason: 'task not found' };
      }
      if (isTerminalLifecycle(draftTask.lifecycle)) {
        return { ok: false, reason: 'task is terminal' };
      }

      const viewStatus = viewStatusFromDraft(draft, taskId) ?? 'idle';
      draft.messages[messageId] = {
        id: messageId,
        taskId,
        role: 'user',
        content,
        state: 'pending',
        createdAt: now,
      };

      if (viewStatus === 'idle') {
        const turns = turnsForTask(draft, taskId);
        const turnId = randomUUID();
        const queue =
          turns.length === 0
            ? transitionStartTask(draftTask, turns, {
                turnId,
                now,
                inputs: [{ kind: 'message', messageId }],
              })
            : transitionContinueTask(draftTask, turns, {
                turnId,
                now,
                inputs: [{ kind: 'message', messageId }],
              });
        if (!queue.ok) {
          return queue;
        }
        draft.turns[turnId] = queue.next;
        queuedTurnId = turnId;
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }

    if (queuedTurnId) {
      void this.scheduleTurn(queuedTurnId);
    }

    return { ok: true, value: { messageId, turnId: queuedTurnId } };
  }

  startTask(
    taskId: string,
    inputs: TurnInput[] = [],
  ): EngineResult<{ turnId: string }> {
    const turnId = randomUUID();
    const now = nowIso(this.clock);
    const commit = this.store.commit((draft) => {
      const task = draft.tasks[taskId];
      if (!task) {
        return { ok: false, reason: 'task not found' };
      }
      if (isTerminalLifecycle(task.lifecycle)) {
        return { ok: false, reason: 'task is terminal' };
      }
      const result = transitionStartTask(task, turnsForTask(draft, taskId), { turnId, now, inputs });
      if (!result.ok) {
        return result;
      }
      draft.turns[turnId] = result.next;
      return { ok: true };
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    void this.scheduleTurn(turnId);
    return { ok: true, value: { turnId } };
  }

  continueTask(
    taskId: string,
    inputs: TurnInput[] = [],
  ): EngineResult<{ turnId: string }> {
    const turnId = randomUUID();
    const now = nowIso(this.clock);
    const commit = this.store.commit((draft) => {
      const task = draft.tasks[taskId];
      if (!task) {
        return { ok: false, reason: 'task not found' };
      }
      if (isTerminalLifecycle(task.lifecycle)) {
        return { ok: false, reason: 'task is terminal' };
      }
      const result = transitionContinueTask(task, turnsForTask(draft, taskId), { turnId, now, inputs });
      if (!result.ok) {
        return result;
      }
      draft.turns[turnId] = result.next;
      return { ok: true };
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    void this.scheduleTurn(turnId);
    return { ok: true, value: { turnId } };
  }

  stageDisposition(
    turnId: string,
    disposition: TurnDisposition,
    opId: string,
  ): EngineResult<void> {
    const commit = this.store.commit((draft) => {
      const turn = draft.turns[turnId];
      if (!turn) {
        return { ok: false, reason: 'turn not found' };
      }
      const result = stageDisposition(turn, disposition, opId, {
        acceptedOpId: this.acceptedOpIds.get(turnId),
        limits: this.limits,
      });
      if (!result.ok) {
        return result;
      }
      draft.turns[turnId] = result.next.turn;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    this.acceptedOpIds.set(turnId, opId);
    return { ok: true, value: undefined };
  }

  interruptTurn(turnId: string): EngineResult<void> {
    this.liveRuns.get(turnId)?.abort();
    return { ok: true, value: undefined };
  }

  retryTurn(turnId: string, instruction: string): EngineResult<{ turnId: string }> {
    const taskId = this.store.getFile().turns[turnId]?.taskId;
    if (!taskId) {
      return { ok: false, reason: 'turn not found' };
    }
    const newTurnId = randomUUID();
    const now = nowIso(this.clock);
    const commit = this.store.commit((draft) => {
      const task = draft.tasks[taskId];
      const turns = turnsForTask(draft, taskId);
      const oldTurn = draft.turns[turnId];
      if (!task || !oldTurn) {
        return { ok: false, reason: 'turn not found' };
      }
      const result = retryTurn(task, turns, oldTurn, {
        turnId: newTurnId,
        instruction,
        now,
      });
      if (!result.ok) {
        return result;
      }
      draft.turns[newTurnId] = result.next;
      return { ok: true };
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    void this.scheduleTurn(newTurnId);
    return { ok: true, value: { turnId: newTurnId } };
  }

  cancelTask(taskId: string): EngineResult<void> {
    const now = nowIso(this.clock);
    const liveTurn = turnsForTask(this.store.getFile(), taskId).find(
      (turn) => turn.status === 'running' || turn.status === 'waiting_user',
    );
    if (liveTurn) {
      this.liveRuns.get(liveTurn.id)?.abort();
    }

    const commit = this.store.commit((draft) => {
      const task = draft.tasks[taskId];
      if (!task) {
        return { ok: false, reason: 'task not found' };
      }
      const currentLive = turnsForTask(draft, taskId).find(
        (turn) => turn.status === 'running' || turn.status === 'waiting_user',
      );
      const result = transitionCancelTask(task, { liveTurn: currentLive, now });
      if (!result.ok) {
        return result;
      }
      draft.tasks[taskId] = result.next.task;
      if (result.next.turn) {
        draft.turns[result.next.turn.id] = result.next.turn;
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    if (liveTurn) {
      this.acceptedOpIds.delete(liveTurn.id);
    }
    return { ok: true, value: undefined };
  }

  private reconcileReload(): void {
    const file = this.store.getFile();
    const now = nowIso(this.clock);
    for (const turn of Object.values(file.turns)) {
      if (turn.status !== 'running' && turn.status !== 'waiting_user') {
        continue;
      }
      if (leaseOwnerAlive(this.storePath, turn.id)) {
        continue;
      }
      this.store.commit((draft) => {
        const draftTurn = draft.turns[turn.id];
        if (!draftTurn || (draftTurn.status !== 'running' && draftTurn.status !== 'waiting_user')) {
          return { ok: true };
        }
        const result = interruptTurn(draftTurn, { now });
        if (!result.ok) {
          return result;
        }
        draft.turns[turn.id] = result.next;
        return { ok: true };
      });
      this.acceptedOpIds.delete(turn.id);
    }

    this.reconcileChildWaits();
  }

  private reconcileChildWaits(): void {
    const file = this.store.getFile();
    const now = nowIso(this.clock);
    for (const task of Object.values(file.tasks)) {
      if (task.wait?.kind !== 'children') {
        continue;
      }
      const continuationTurnId = `${task.wait.registeredByTurnId}-continuation`;
      const commit = this.store.commit((draft) => {
        const draftTask = draft.tasks[task.id];
        if (!draftTask?.wait || draftTask.wait.kind !== 'children') {
          return { ok: true };
        }
        const childLifecycles = new Map<string, TaskLifecycleState>();
        for (const childId of draftTask.wait.taskIds) {
          const lifecycle = draft.tasks[childId]?.lifecycle;
          if (lifecycle) {
            childLifecycles.set(childId, lifecycle);
          }
        }
        const result = resolveChildWait(
          draftTask,
          childLifecycles,
          turnsForTask(draft, task.id),
          { continuationTurnId, now },
        );
        if (!result.ok) {
          return result;
        }
        draft.tasks[task.id] = result.next.task;
        if (result.next.turn) {
          draft.turns[result.next.turn.id] = result.next.turn;
        }
        return { ok: true };
      });
      if (commit.ok) {
        const continuation = this.store.getFile().turns[continuationTurnId];
        if (continuation?.status === 'queued') {
          void this.scheduleTurn(continuationTurnId);
        }
      }
    }
  }

  private scheduleTurn(turnId: string): Promise<void> {
    const existing = this.turnPromises.get(turnId);
    if (existing) {
      return existing;
    }
    const promise = this.executeTurn(turnId);
    this.turnPromises.set(turnId, promise);
    void promise.finally(() => this.turnPromises.delete(turnId));
    return promise;
  }

  private async executeTurn(turnId: string): Promise<void> {
    const lease = tryAcquireLease(this.storePath, turnId);
    if (!lease) {
      return;
    }

    const file = this.store.getFile();
    const turn = file.turns[turnId];
    if (!turn || turn.status !== 'queued') {
      releaseLease(this.storePath, turnId, lease);
      return;
    }
    const task = file.tasks[turn.taskId];
    if (!task) {
      releaseLease(this.storePath, turnId, lease);
      return;
    }

    const now = nowIso(this.clock);
    const startCommit = this.store.commit((draft) => {
      const draftTurn = draft.turns[turnId];
      const draftTask = draft.tasks[turn.taskId];
      if (!draftTurn || draftTurn.status !== 'queued' || !draftTask) {
        return { ok: false, reason: 'turn is no longer schedulable' };
      }
      if (isTerminalLifecycle(draftTask.lifecycle)) {
        return { ok: false, reason: 'task is terminal' };
      }

      const pending = pendingUserMessages(draft, turn.taskId);
      const inputs: TurnInput[] = [...draftTurn.inputs];
      for (const message of pending) {
        if (!inputs.some((input) => input.kind === 'message' && input.messageId === message.id)) {
          inputs.push({ kind: 'message', messageId: message.id });
        }
        message.state = 'assigned';
        message.turnId = turnId;
        draft.messages[message.id] = message;
      }

      const withInputs = { ...draftTurn, inputs };
      const started = startProcess(withInputs, { now });
      if (!started.ok) {
        return started;
      }
      draft.turns[turnId] = started.next;
      return { ok: true };
    });

    if (!startCommit.ok) {
      releaseLease(this.storePath, turnId, lease);
      return;
    }

    const abort = new AbortController();
    this.liveRuns.set(turnId, abort);

    let rawOutput = '';
    let observedSessionId: string | undefined;
    let terminalSettled = false;
    const assistantStoreIds = new Map<string, string>();
    let backend: Backend = {
      name: task.backend,
      run: async function* () {},
    };

    try {
      try {
        backend = this.makeBackend(task.backend);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminalSettled = await this.settleFailed(
          turnId,
          `backend factory failed: ${message}`,
          observedSessionId,
          rawOutput,
          backend,
        );
        return;
      }
      const current = this.store.getFile();
      const currentTurn = current.turns[turnId];
      const messages = messageMapFromFile(current);
      const prompt = projectPrompt(currentTurn, messages);

      for await (const event of this.runTurnFn(backend, {
        prompt,
        resumeId: task.committedSessionId,
        signal: abort.signal,
      })) {
        if (terminalSettled) {
          break;
        }

        switch (event.type) {
          case 'sessionStarted':
            if (event.sessionId) {
              observedSessionId = event.sessionId;
              this.store.commit((draft) => {
                const draftTurn = draft.turns[turnId];
                if (!draftTurn) {
                  return { ok: false, reason: 'turn not found' };
                }
                draft.turns[turnId] = { ...draftTurn, observedSessionId: event.sessionId };
                return { ok: true };
              });
            }
            break;
          case 'assistantDelta': {
            const commit = this.store.commit((draft) => {
              const draftTurn = draft.turns[turnId];
              if (!draftTurn) {
                return { ok: false, reason: 'turn not found' };
              }
              let storeMessageId = assistantStoreIds.get(event.messageId);
              if (!storeMessageId) {
                storeMessageId = randomUUID();
                assistantStoreIds.set(event.messageId, storeMessageId);
                draft.messages[storeMessageId] = {
                  id: storeMessageId,
                  taskId: draftTurn.taskId,
                  role: 'assistant',
                  content: event.content,
                  state: 'partial',
                  createdAt: nowIso(this.clock),
                  turnId,
                };
              } else {
                const existing = draft.messages[storeMessageId];
                draft.messages[storeMessageId] = {
                  ...existing,
                  content: existing.content + event.content,
                };
              }
              return { ok: true };
            });
            if (!commit.ok) {
              terminalSettled = await this.settleFailed(
                turnId,
                commit.detail ?? 'assistant persistence failed',
                observedSessionId,
                rawOutput,
                backend,
              );
              break;
            }
            break;
          }
          case 'raw':
            rawOutput += `${event.line}\n`;
            break;
          case 'turnCompleted':
            terminalSettled = await this.settleSuccess(turnId, observedSessionId, rawOutput, backend);
            if (!terminalSettled) {
              terminalSettled = await this.settleFailed(
                turnId,
                'failed to settle successful turn',
                observedSessionId,
                rawOutput,
                backend,
              );
            }
            break;
          case 'error':
            if (event.isCancellation) {
              terminalSettled = await this.settleInterrupted(turnId, observedSessionId, rawOutput, backend);
            } else {
              terminalSettled = await this.settleFailed(turnId, event.message, observedSessionId, rawOutput, backend);
            }
            if (!terminalSettled) {
              terminalSettled = await this.settleFailed(
                turnId,
                'failed to settle error turn',
                observedSessionId,
                rawOutput,
                backend,
              );
            }
            break;
          default:
            break;
        }
      }

      if (!terminalSettled) {
        terminalSettled = await this.settleFailed(
          turnId,
          'turn ended without terminal event',
          observedSessionId,
          rawOutput,
          backend,
        );
      }
    } catch (error) {
      if (!terminalSettled) {
        const message = error instanceof Error ? error.message : String(error);
        terminalSettled = await this.settleFailed(turnId, message, observedSessionId, rawOutput, backend);
      }
    } finally {
      this.liveRuns.delete(turnId);
      this.acceptedOpIds.delete(turnId);
      releaseLease(this.storePath, turnId, lease);
    }
  }

  private async settleSuccess(
    turnId: string,
    observedSessionId: string | undefined,
    rawOutput: string,
    backend: Backend,
  ): Promise<boolean> {
    if (this.settling.has(turnId)) {
      return false;
    }
    this.settling.add(turnId);
    const now = nowIso(this.clock);
    try {
      const commit = this.store.commit((draft) => {
        const turn = draft.turns[turnId];
        const task = turn ? draft.tasks[turn.taskId] : undefined;
        if (!turn || !task || turn.status !== 'running') {
          return { ok: false, reason: 'turn is not running' };
        }

        const observed = observedSessionId ?? turn.observedSessionId;
        const withObserved = { ...turn, observedSessionId: observed };
        const result = applySuccessfulTurn(task, withObserved, { now });
        if (!result.ok) {
          return result;
        }

        const sessionId = selectCommittedSessionId(
          backend,
          { observedSessionId: observed },
          rawOutput,
          task.committedSessionId,
        );

        draft.turns[turnId] = result.next.turn;
        draft.tasks[task.id] = {
          ...result.next.task,
          committedSessionId: sessionId ?? result.next.task.committedSessionId,
        };

        for (const effect of result.effects) {
          this.applyEffect(draft, effect, turnId, now);
        }

        const assistantMessages = Object.values(draft.messages).filter(
          (message) => message.turnId === turnId && message.role === 'assistant' && message.state === 'partial',
        );
        for (const message of assistantMessages) {
          draft.messages[message.id] = { ...message, state: 'complete' };
        }

        return { ok: true };
      });
      return commit.ok;
    } finally {
      this.settling.delete(turnId);
    }
  }

  private async settleInterrupted(
    turnId: string,
    observedSessionId: string | undefined,
    rawOutput: string,
    backend: Backend,
  ): Promise<boolean> {
    if (this.settling.has(turnId)) {
      return false;
    }
    this.settling.add(turnId);
    const now = nowIso(this.clock);
    try {
      const commit = this.store.commit((draft) => {
        const turn = draft.turns[turnId];
        if (!turn || (turn.status !== 'running' && turn.status !== 'waiting_user')) {
          return { ok: false, reason: 'turn is not live' };
        }
        const result = interruptTurn(turn, { now });
        if (!result.ok) {
          return result;
        }
        const candidate = selectCommittedSessionId(
          backend,
          { observedSessionId: observedSessionId ?? turn.observedSessionId },
          rawOutput,
          undefined,
        );
        draft.turns[turnId] = {
          ...result.next,
          observedSessionId: observedSessionId ?? turn.observedSessionId,
          candidateSessionId: candidate,
          isCancellation: true,
        };
        return { ok: true };
      });
      return commit.ok;
    } finally {
      this.settling.delete(turnId);
    }
  }

  private async settleFailed(
    turnId: string,
    errorMessage: string,
    observedSessionId: string | undefined,
    rawOutput: string,
    backend: Backend,
  ): Promise<boolean> {
    if (this.settling.has(turnId)) {
      return false;
    }
    this.settling.add(turnId);
    const now = nowIso(this.clock);
    try {
      const commit = this.store.commit((draft) => {
        const turn = draft.turns[turnId];
        const task = turn ? draft.tasks[turn.taskId] : undefined;
        if (!turn || !task || turn.status !== 'running') {
          return { ok: false, reason: 'turn is not running' };
        }

        const turns = turnsForTask(draft, task.id);
        const result = applyFailedTurn(task, turn, {
          error: errorMessage,
          retryCount: retryCountOf(turns, turn.id),
          policy: task.executionPolicy,
          onExhausted: 'recover',
          now,
        });
        if (!result.ok) {
          return result;
        }

        const candidate = selectCommittedSessionId(
          backend,
          { observedSessionId: observedSessionId ?? turn.observedSessionId },
          rawOutput,
          undefined,
        );
        draft.turns[turnId] = {
          ...result.next.turn,
          observedSessionId: observedSessionId ?? turn.observedSessionId,
          candidateSessionId: candidate,
        };
        draft.tasks[task.id] = result.next.task;

        for (const effect of result.effects) {
          if (effect.kind === 'enqueueRetry') {
            const retryIndex = retryCountOf(turnsForTask(draft, task.id), turnId) + 1;
            const retryId = deterministicRetryTurnId(turnId, retryIndex);
            if (!draft.turns[retryId]) {
              const retryResult = retryTurn(
                draft.tasks[task.id],
                turnsForTask(draft, task.id),
                draft.turns[turnId],
                {
                  turnId: retryId,
                  instruction: `Automatic retry after failure: ${errorMessage.slice(0, 200)}`,
                  now,
                },
              );
              if (retryResult.ok) {
                draft.turns[retryId] = retryResult.next;
              }
            }
          } else {
            this.applyEffect(draft, effect, turnId, now);
          }
        }
        return { ok: true };
      });

      if (commit.ok) {
        const retryTurnEntry = Object.values(this.store.getFile().turns).find(
          (turn) => turn.retryOf === turnId && turn.status === 'queued',
        );
        if (retryTurnEntry) {
          void this.scheduleTurn(retryTurnEntry.id);
        }
        return true;
      }
      return false;
    } finally {
      this.settling.delete(turnId);
    }
  }

  private applyEffect(draft: TaskStoreFile, effect: Effect, turnId: string, now: string): void {
    switch (effect.kind) {
      case 'markMessagesComplete': {
        for (const messageId of effect.messageIds) {
          const message = draft.messages[messageId];
          if (message && message.state === 'assigned') {
            draft.messages[messageId] = { ...message, state: 'complete' };
          }
        }
        break;
      }
      case 'commitSession':
      case 'scheduleContinuation':
      case 'enqueueRetry':
      case 'cancelProcess':
      case 'emitUpdate':
        break;
      default: {
        const _exhaustive: never = effect;
        return _exhaustive;
      }
    }
  }
}