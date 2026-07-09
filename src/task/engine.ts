import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import type { Answers, AskRef } from '../bridge/ask-bridge';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { runTurn as defaultRunTurn } from '../runner';
import type { Backend, NormalizedEvent, RunOptions } from '../types';
import type { TurnTrigger } from './types';
import { canBindTaskToBackend } from './backend-eligibility';
import { deriveViewStatus } from './derived-status';
import type { DepGraph } from './deps';
import {
  buildRunOptionsForTurn,
  cleanupTurnResources,
  executeToolCommand,
  processCancelRequests,
  pruneLedgerForTurn,
  projectChildResults,
  tryPromoteTurn,
  type GraphEngineDeps,
} from './engine-graph';
import type { ToolCommand } from './coordinator-tools';
import { canPromoteTurn, dependencyTerminalOutcome } from './scheduler';
import { canCreateTurn, DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from './limits';
import { selectCommittedSessionId } from './session-select';
import { TaskStore } from './store';
import {
  applyDependencyTerminal,
  applyFailedTurn,
  applySuccessfulTurn,
  createTask,
  interruptTurn,
  retryCountOf,
  retryTurn,
  resolveChildWait,
  submitAnswer,
  stageDisposition,
  startProcess,
  startTask as transitionStartTask,
  continueTask as transitionContinueTask,
  cancelPendingTurn,
  cancelTask as transitionCancelTask,
  hasActiveOrQueuedTurn,
  isHardTerminalLifecycle,
  isTerminalLifecycle,
  reopenSoftFailedTask,
  setTaskLifecycle as transitionSetTaskLifecycle,
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

export type EngineEvent =
  | { type: 'turnStart'; taskId: string; turnId: string; trigger: TurnTrigger }
  | { type: 'event'; taskId: string; turnId: string; event: NormalizedEvent }
  | { type: 'turnDone'; taskId: string; turnId: string }
  | { type: 'turnError'; taskId: string; turnId: string; message: string };

export interface TaskEngineConfig {
  store: TaskStore;
  makeBackend: (name: string) => Backend;
  runTurn?: (backend: Backend, options: RunOptions) => AsyncIterable<NormalizedEvent>;
  dispositionLimits?: DispositionLimits;
  clock?: () => string;
  askBridge?: AskBridge;
  credentialRegistry?: CredentialRegistry;
  bridgePort?: number;
  resourceLimits?: ResourceLimits;
  emit?: (e: EngineEvent) => void;
  /** When false, reload reconciliation preserves queued turns without scheduling them. Default true. */

}

export type EngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface LeaseRecord {
  pid: number;
  token: string;
  /**
   * ISO timestamp the lease was acquired. Absent on legacy records written before this
   * field existed; a missing/unparseable value is treated as "very old" → reclaimable.
   */
  createdAt?: string;
}

/**
 * Max age a lease may reach before it is presumed abandoned and becomes reclaimable even
 * if its PID still appears alive. This defeats PID reuse: a recycled PID that happens to
 * match a dead owner's PID can no longer keep a stale lease "alive" forever. Sized to the
 * default task timeout — the longest a task (and therefore any of its turns/leases) can
 * legitimately run before it is force-cancelled anyway.
 */
export const MAX_LEASE_AGE_MS = 1_800_000;

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

function readLockRecord(lockPath: string): LeaseRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LeaseRecord;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function leasePath(storePath: string, turnId: string): string {
  return `${storePath}.lease.${turnId}`;
}

/**
 * A lease is reclaimable when it is missing/empty/unparseable, owned by a dead PID, or
 * older than {@link MAX_LEASE_AGE_MS}. A legacy record without `createdAt` is treated as
 * very old → reclaimable. This is the single source of truth for both acquisition
 * (reclaiming a stale lease) and reload reconciliation (deciding a turn is orphaned).
 */
export function isLeaseReclaimable(record: LeaseRecord | undefined): boolean {
  if (!record) {
    return true;
  }
  if (isProcessDead(record.pid)) {
    return true;
  }
  if (!record.createdAt) {
    return true;
  }
  const created = Date.parse(record.createdAt);
  if (Number.isNaN(created)) {
    return true;
  }
  return Date.now() - created > MAX_LEASE_AGE_MS;
}

/**
 * Reclaim a stale lease safely, mirroring the store lock's {@link TaskStore} reclaim.
 * Never disturbs a live, well-formed lease. A suspicious lease is claimed atomically via
 * rename — only one contender can win that rename, and each operates on the exact file
 * instance it removed — which closes the read-then-unlink TOCTOU where a stale read could
 * otherwise delete a freshly published live lease (letting two engines run one turn).
 * Returns true when the path was freed (a retry can now acquire).
 */
function reclaimStaleLease(target: string): boolean {
  const observed = readLockRecord(target);
  if (!isLeaseReclaimable(observed)) {
    return false;
  }
  // Looks stale (empty/corrupt, dead owner, or over max-age). Claim it atomically by
  // renaming it aside rather than unlinking the path in place.
  const quarantine = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(target, quarantine);
  } catch (error) {
    // ENOENT: another contender already reclaimed it — the path is free now, so a retry
    // can acquire. Any other error: leave the lease untouched.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  // We now exclusively hold whatever WAS at `target`. Re-inspect that exact instance.
  const claimed = readLockRecord(quarantine);
  if (!isLeaseReclaimable(claimed)) {
    // Rare race: a fresh, live lease was published between the observation and the rename.
    // Best-effort restore so its owner is not silently displaced.
    try {
      fs.linkSync(quarantine, target);
    } catch {
      // target already re-taken by another acquirer; nothing safe to do
    }
    try {
      fs.unlinkSync(quarantine);
    } catch {
      // best-effort
    }
    return false;
  }
  // Confirmed stale — discard it. `target` is now free for a retry.
  try {
    fs.unlinkSync(quarantine);
  } catch {
    // best-effort
  }
  return true;
}

export function tryAcquireLease(storePath: string, turnId: string): LeaseRecord | undefined {
  const target = leasePath(storePath, turnId);
  const record: LeaseRecord = {
    pid: process.pid,
    token: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  // Write the full record to a private temp file first, then publish it with an atomic,
  // exclusive hard link. This mirrors the store lock's temp+link pattern: the lease path
  // is therefore either absent or a fully-written record — never an empty/partial file,
  // even if this process is killed mid-acquire. (The old openSync('wx')+writeFileSync
  // could leave an EMPTY lease on a crash, which then permanently blocked that turn's
  // lease — a deadlock, since readLockRecord returned undefined and the reclaim path
  // refused it.)
  const tmpPath = `${target}.${process.pid}.${record.token}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
  } catch {
    return undefined;
  }
  try {
    fs.linkSync(tmpPath, target);
    return record;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      return undefined;
    }
    // A lease is present. Reclaim it only if stale, then retry the atomic publish once.
    // reclaimStaleLease claims via rename (never unlinks the path after a stale read), so
    // it cannot delete a lease a peer published in the meantime.
    if (!reclaimStaleLease(target)) {
      return undefined;
    }
    try {
      fs.linkSync(tmpPath, target);
      return record;
    } catch {
      // Another contender re-took the freed path first — let the caller retry later.
      return undefined;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort: an orphaned temp is harmless and uniquely named
    }
  }
}

function releaseLease(storePath: string, turnId: string, record: LeaseRecord): void {
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

export function leaseOwnerAlive(storePath: string, turnId: string): boolean {
  // "Alive" means a non-reclaimable lease: a live owner holding a fresh, well-formed
  // record. A dead PID, empty/corrupt file, or an over-age lease (PID-reuse defense) all
  // count as not-alive, so reload reconciliation reclaims the orphaned turn.
  return !isLeaseReclaimable(readLockRecord(leasePath(storePath, turnId)));
}

function ownsLocalLease(storePath: string, turnId: string): boolean {
  const existing = readLockRecord(leasePath(storePath, turnId));
  return existing?.pid === process.pid;
}

export function projectPrompt(
  turn: TaskTurn,
  messages: ReadonlyMap<string, TaskMessage>,
  file?: TaskStoreFile,
  maxChildResultBytes = 16_384,
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
        if (file) {
          parts.push(projectChildResults(input.taskIds, file, maxChildResultBytes));
        } else {
          parts.push(['[child_results]', ...input.taskIds.map((id) => `- ${id}`)].join('\n'));
        }
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

function childIdsOf(file: TaskStoreFile, parentId: string): string[] {
  return Object.values(file.tasks)
    .filter((task) => task.parentId === parentId)
    .map((task) => task.id)
    .sort();
}

function descendantIds(file: TaskStoreFile, rootId: string): string[] {
  const result: string[] = [];
  const stack = [...childIdsOf(file, rootId)].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...childIdsOf(file, id).reverse());
  }
  return result;
}

function pendingTurnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return turnsForTask(file, taskId).filter(
    (turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user',
  );
}

function pendingUserMessages(file: TaskStoreFile, taskId: string): TaskMessage[] {
  return Object.values(file.messages)
    .filter((message) => message.taskId === taskId && message.role === 'user' && message.state === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function deterministicRetryTurnId(failedTurnId: string, retryIndex: number): string {
  return `${failedTurnId}-auto-retry-${retryIndex}`;
}

export function viewStatusFromDraft(draft: TaskStoreFile, taskId: string) {
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
  private readonly askBridge: AskBridge;
  private readonly credentialRegistry?: CredentialRegistry;
  private readonly bridgePort: number;
  private readonly resourceLimits: ResourceLimits;
  private readonly emit?: (e: EngineEvent) => void;
  private readonly liveRuns = new Map<string, AbortController>();
  /** Queued turns preserved on reload — start only via resumeQueuedTurn. */
  private readonly deferredQueuedTurns = new Set<string>();
  private readonly acceptedOpIds = new Map<string, string>();
  private readonly turnPromises = new Map<string, Promise<void>>();
  private readonly pendingAskPromises = new Map<string, { promise: Promise<Answers>; fingerprint: string }>();
  private settling = new Set<string>();

  private constructor(config: TaskEngineConfig, storePath: string) {
    this.store = config.store;
    this.makeBackend = config.makeBackend;
    this.runTurnFn = config.runTurn ?? defaultRunTurn;
    this.limits = config.dispositionLimits ?? DEFAULT_LIMITS;
    this.clock = config.clock;
    this.storePath = storePath;
    this.askBridge = config.askBridge ?? new AskBridge();
    this.credentialRegistry = config.credentialRegistry;
    this.bridgePort = config.bridgePort ?? 0;
    this.resourceLimits = config.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
    this.emit = config.emit;
  }

  private safeEmit(event: EngineEvent): void {
    try {
      this.emit?.(event);
    } catch {
      // emission is best-effort and state-free
    }
  }

  private graphDeps(): GraphEngineDeps {
    const credentials = this.credentialRegistry ?? new CredentialRegistry();
    return {
      store: this.store,
      makeBackend: this.makeBackend,
      credentials,
      askBridge: this.askBridge,
      bridgePort: this.bridgePort,
      resourceLimits: this.resourceLimits,
      clock: this.clock,
      liveRuns: this.liveRuns,
      pendingAskPromises: this.pendingAskPromises,
      onScheduleTurn: (turnId) => void this.scheduleTurn(turnId),
      leaseOwnerAlive: (turnId) => leaseOwnerAlive(this.storePath, turnId),
      ownsLease: (turnId) => ownsLocalLease(this.storePath, turnId),
      writeCancelRequest: (turnId, kind, by, opId) => {
        this.store.commit((draft) => {
          draft.cancelRequests = draft.cancelRequests ?? {};
          draft.cancelRequests[turnId] = { kind, by, opId, at: nowIso(this.clock) };
          return { ok: true };
        });
      },
    };
  }

  submitAskAnswer(ref: AskRef, answers: Answers): EngineResult<void> {
    if (!this.askBridge.hasPending(ref)) {
      return { ok: false, reason: 'no matching pending ask' };
    }
    const commit = this.store.commit((draft) => {
      const turn = draft.turns[ref.turnId];
      if (!turn || turn.status !== 'waiting_user') {
        return { ok: false, reason: 'turn is not waiting for user' };
      }
      const resumed = submitAnswer(turn);
      if (!resumed.ok) return resumed;
      draft.turns[ref.turnId] = resumed.next;
      return { ok: true };
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    if (!this.askBridge.submit(ref, answers)) {
      return { ok: false, reason: 'ask disappeared before submit' };
    }
    return { ok: true, value: undefined };
  }

  cancelAskTurn(ref: AskRef): EngineResult<void> {
    if (!this.askBridge.hasPending(ref)) {
      return { ok: false, reason: 'no matching pending ask' };
    }
    this.liveRuns.get(ref.turnId)?.abort();
    const now = nowIso(this.clock);
    const commit = this.store.commit((draft) => {
      const turn = draft.turns[ref.turnId];
      if (!turn) return { ok: false, reason: 'turn not found' };
      if (turn.status === 'running' || turn.status === 'waiting_user') {
        const interrupted = interruptTurn(turn, { now });
        if (!interrupted.ok) return interrupted;
        draft.turns[ref.turnId] = interrupted.next;
      }
      return { ok: true };
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    this.askBridge.cancel(ref, 'turn cancelled');
    return { ok: true, value: undefined };
  }

  async handleToolCall(
    ctx: import('../bridge/credentials').CredentialContext,
    _tool: string,
    command: ToolCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    return executeToolCommand(
      this.graphDeps(),
      {
        callerTaskId: ctx.callerTaskId,
        turnId: ctx.turnId,
        rootId: ctx.rootId,
        allowedActions: ctx.allowedActions,
      },
      command,
    );
  }

  static load(config: TaskEngineConfig): TaskEngine {
    const engine = new TaskEngine(config, config.store.getStorePath());
    engine.reconcileReload();
    return engine;
  }

  startNewTask(params: {
    goal: string;
    backend: string;
    /** Model id selected for this task (ACP session config option value). */
    model?: string;
    continuationOf?: string;
    role?: TaskRole;
    /** Full content of the first user message. If not provided, falls back to goal. */
    message?: string;
    /** Workspace directory the agent runs in for this task's turns. */
    cwd?: string;
  }): EngineResult<{ taskId: string; messageId: string; turnId: string }> {
    const backend = this.makeBackend(params.backend);
    if (!canBindTaskToBackend(backend.capabilities)) {
      return { ok: false, reason: 'backend does not support MCP' };
    }

    const taskId = randomUUID();
    const messageId = randomUUID();
    const turnId = randomUUID();
    const now = nowIso(this.clock);
    const input: CreateTaskInput = {
      id: taskId,
      role: params.role ?? 'coordinator',
      goal: params.goal,
      continuationOf: params.continuationOf,
      parentId: null,
      dependencies: [],
      backend: params.backend,
      model: params.model,
      cwd: params.cwd,
      capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
      executionPolicy: DEFAULT_POLICY,
    };

    const commit = this.store.commit((draft) => {
      if (draft.tasks[taskId]) {
        return { ok: false, reason: 'task id already exists' };
      }
      const graph = depGraphFromFile(draft);
      const created = createTask(input, { rootId: taskId, graph, now });
      if (!created.ok) {
        return created;
      }
      draft.tasks[taskId] = created.next;

      const messageContent = params.message ?? params.goal;
      draft.messages[messageId] = {
        id: messageId,
        taskId,
        role: 'user',
        content: messageContent,
        state: 'pending',
        createdAt: now,
      };

      const queued = transitionStartTask(created.next, [], {
        turnId,
        now,
        inputs: [{ kind: 'message', messageId }],
      });
      if (!queued.ok) {
        return queued;
      }
      draft.turns[turnId] = queued.next;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }

    void this.scheduleTurn(turnId);
    return { ok: true, value: { taskId, messageId, turnId } };
  }

  continueTaskWithMessage(
    taskId: string,
    instruction: string,
  ): EngineResult<{ messageId: string; turnId: string }> {
    const messageId = randomUUID();
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

      draft.messages[messageId] = {
        id: messageId,
        taskId,
        role: 'user',
        content: instruction,
        state: 'pending',
        createdAt: now,
      };

      const turnCap = canCreateTurn(draft, taskId, this.resourceLimits);
      if (!turnCap.ok) {
        return turnCap;
      }

      const queued = transitionContinueTask(task, turnsForTask(draft, taskId), {
        turnId,
        now,
        inputs: [{ kind: 'message', messageId }],
      });
      if (!queued.ok) {
        return queued;
      }
      draft.turns[turnId] = queued.next;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }

    void this.scheduleTurn(turnId);
    return { ok: true, value: { messageId, turnId } };
  }

  resumeQueuedTurn(turnId: string): EngineResult<void> {
    const turn = this.store.getFile().turns[turnId];
    if (!turn) {
      return { ok: false, reason: 'turn not found' };
    }
    if (turn.status !== 'queued') {
      return { ok: false, reason: 'turn is not queued' };
    }
    this.deferredQueuedTurns.delete(turnId);
    void this.scheduleTurn(turnId);
    return { ok: true, value: undefined };
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
    /** Workspace directory the agent runs in for this task's turns. */
    cwd?: string;
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
      cwd: params.cwd,
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
      let draftTask = draft.tasks[taskId];
      if (!draftTask) {
        return { ok: false, reason: 'task not found' };
      }
      // Hard terminal: read-only. Soft failed: reopen to open on the same task id.
      if (isHardTerminalLifecycle(draftTask.lifecycle)) {
        return { ok: false, reason: 'task is terminal' };
      }
      if (draftTask.lifecycle === 'failed') {
        const reopened = reopenSoftFailedTask(draftTask, { now });
        if (!reopened.ok) {
          return reopened;
        }
        draft.tasks[taskId] = reopened.next;
        draftTask = reopened.next;
      }

      // New user message supersedes a pending outcome proposal (implicit continue).
      if (draftTask.outcomeProposal) {
        draftTask = {
          ...draftTask,
          outcomeProposal: undefined,
          revision: draftTask.revision + 1,
          updatedAt: now,
        };
        draft.tasks[taskId] = draftTask;
      }

      // Queue a turn when open and no live/queued turn — including after a
      // successful prior turn (resume session via committedSessionId) or recovery.
      const viewStatus = viewStatusFromDraft(draft, taskId) ?? 'idle';
      draft.messages[messageId] = {
        id: messageId,
        taskId,
        role: 'user',
        content,
        state: 'pending',
        createdAt: now,
      };

      // Allow continue when idle, awaiting_outcome (proposal cleared above), or
      // needs_recovery is handled by explicit retry — but plain send on idle after
      // stopped CLI must always queue a continuation turn.
      if (
        viewStatus === 'idle' ||
        viewStatus === 'awaiting_outcome' ||
        (viewStatus === 'needs_recovery' && !hasActiveOrQueuedTurn(turnsForTask(draft, taskId)))
      ) {
        const turnCap = canCreateTurn(draft, taskId, this.resourceLimits);
        if (!turnCap.ok) {
          return turnCap;
        }
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
      const turnCap = canCreateTurn(draft, taskId, this.resourceLimits);
      if (!turnCap.ok) {
        return turnCap;
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
      const turnCap = canCreateTurn(draft, taskId, this.resourceLimits);
      if (!turnCap.ok) {
        return turnCap;
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

  /**
   * User (or host UI) sets task lifecycle. Never driven by CLI process status.
   * Cancels/interrupts live turns when sealing terminal outcomes.
   * For `skipped`, cascades to unfinished descendants (see skipTask).
   */
  setTaskLifecycle(
    taskId: string,
    lifecycle: TaskLifecycleState,
    options?: { result?: string; error?: string },
  ): EngineResult<void> {
    if (lifecycle === 'skipped') {
      return this.skipTask(taskId);
    }

    const now = nowIso(this.clock);
    const file = this.store.getFile();
    if (!file.tasks[taskId]) {
      return { ok: false, reason: 'task not found' };
    }

    const turns = this.store.getTurnsForTask(taskId);
    const live = turns.find((t) => t.status === 'running' || t.status === 'waiting_user');
    const remoteOwned =
      !!live &&
      leaseOwnerAlive(this.storePath, live.id) &&
      !ownsLocalLease(this.storePath, live.id);

    if (live && lifecycle !== 'open' && !remoteOwned) {
      this.liveRuns.get(live.id)?.abort();
    }

    const commit = this.store.commit((draft) => {
      const task = draft.tasks[taskId];
      if (!task) {
        return { ok: false, reason: 'task not found' };
      }

      // Remote-owned live turn: request interrupt (not cancel). We already seal
      // lifecycle here; remote processCancelRequests cancel branch would call
      // transitionCancelTask and fail once the task is terminal.
      if (live && lifecycle !== 'open' && remoteOwned) {
        draft.cancelRequests = draft.cancelRequests ?? {};
        draft.cancelRequests[live.id] = {
          kind: 'interrupt',
          by: 'engine',
          opId: `lifecycle-${lifecycle}-${taskId}`,
          at: now,
        };
      }

      const result = transitionSetTaskLifecycle(task, lifecycle, {
        now,
        result: options?.result,
        error: options?.error,
        sealedBy: 'user',
      });
      if (!result.ok) {
        return result;
      }
      draft.tasks[taskId] = result.next;

      // When sealing terminal, settle live/queued turns without leaving zombies.
      // Skip remote-owned live turns (handled via cancelRequests).
      if (lifecycle !== 'open') {
        const pending = Object.values(draft.turns).filter(
          (t) =>
            t.taskId === taskId &&
            (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
        );
        for (const p of pending) {
          if (live && remoteOwned && p.id === live.id) {
            continue;
          }
          if (p.status === 'queued') {
            const cancelled = cancelPendingTurn(p, { now });
            if (cancelled.ok) draft.turns[p.id] = cancelled.next;
          } else {
            const interrupted = interruptTurn(p, { now });
            if (interrupted.ok) {
              draft.turns[p.id] = {
                ...interrupted.next,
                isCancellation: lifecycle === 'cancelled',
              };
            }
          }
        }
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }

    if (live && !remoteOwned) {
      this.askBridge.cancelForTurn(live.id, 'task lifecycle changed');
      this.credentialRegistry?.revoke(live.id);
    }
    return { ok: true, value: undefined };
  }

  /**
   * Skip task + unfinished descendants (user or authorized coordinator).
   * Hard terminal: won’t perform. Live turns are interrupted first.
   */
  skipTask(taskId: string): EngineResult<void> {
    const now = nowIso(this.clock);
    const file = this.store.getFile();
    if (!file.tasks[taskId]) {
      return { ok: false, reason: 'task not found' };
    }

    const taskIds = [taskId, ...descendantIds(file, taskId)].reverse();
    const liveTurnIds = taskIds.flatMap((id) =>
      pendingTurnsForTask(file, id)
        .filter((turn) => turn.status === 'running' || turn.status === 'waiting_user')
        .map((turn) => turn.id),
    );
    const remoteLiveTurnIds = new Set(
      liveTurnIds.filter(
        (turnId) => leaseOwnerAlive(this.storePath, turnId) && !ownsLocalLease(this.storePath, turnId),
      ),
    );
    for (const turnId of liveTurnIds) {
      if (!remoteLiveTurnIds.has(turnId)) {
        this.liveRuns.get(turnId)?.abort();
      }
    }

    const commit = this.store.commit((draft) => {
      for (const id of taskIds) {
        const task = draft.tasks[id];
        if (!task || isTerminalLifecycle(task.lifecycle)) {
          continue;
        }
        const pendingTurns = pendingTurnsForTask(draft, id);
        const currentLive = pendingTurns.find(
          (turn) => turn.status === 'running' || turn.status === 'waiting_user',
        );
        if (currentLive && remoteLiveTurnIds.has(currentLive.id)) {
          draft.cancelRequests = draft.cancelRequests ?? {};
          // interrupt: task is sealed to skipped here; remote only settles the turn.
          draft.cancelRequests[currentLive.id] = {
            kind: 'interrupt',
            by: 'engine',
            opId: `skip-task-${taskId}`,
            at: now,
          };
        }
        const result = transitionSetTaskLifecycle(task, 'skipped', {
          now,
          sealedBy: 'user',
        });
        if (!result.ok) {
          return result;
        }
        draft.tasks[id] = result.next;
        for (const pending of pendingTurns) {
          if (currentLive && remoteLiveTurnIds.has(currentLive.id) && pending.id === currentLive.id) {
            continue;
          }
          if (pending.status === 'queued') {
            const cancelled = cancelPendingTurn(pending, { now });
            if (!cancelled.ok) return cancelled;
            draft.turns[pending.id] = cancelled.next;
          } else {
            const interrupted = interruptTurn(pending, { now });
            if (!interrupted.ok) return interrupted;
            draft.turns[pending.id] = interrupted.next;
          }
        }
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    for (const turnId of liveTurnIds) {
      if (remoteLiveTurnIds.has(turnId)) {
        continue;
      }
      this.acceptedOpIds.delete(turnId);
      this.askBridge.cancelForTurn(turnId, 'task skipped');
      this.credentialRegistry?.revoke(turnId);
    }
    return { ok: true, value: undefined };
  }

  /**
   * Cancel task + descendants (user or authorized coordinator). Not driven by CLI exit.
   */
  cancelTask(taskId: string): EngineResult<void> {
    const now = nowIso(this.clock);
    const file = this.store.getFile();
    if (!file.tasks[taskId]) {
      return { ok: false, reason: 'task not found' };
    }

    const taskIds = [taskId, ...descendantIds(file, taskId)].reverse();
    const liveTurnIds = taskIds.flatMap((id) =>
      pendingTurnsForTask(file, id)
        .filter((turn) => turn.status === 'running' || turn.status === 'waiting_user')
        .map((turn) => turn.id),
    );
    const remoteLiveTurnIds = new Set(
      liveTurnIds.filter(
        (turnId) => leaseOwnerAlive(this.storePath, turnId) && !ownsLocalLease(this.storePath, turnId),
      ),
    );
    for (const turnId of liveTurnIds) {
      if (!remoteLiveTurnIds.has(turnId)) {
        this.liveRuns.get(turnId)?.abort();
      }
    }

    const commit = this.store.commit((draft) => {
      for (const id of taskIds) {
        const task = draft.tasks[id];
        if (!task || isTerminalLifecycle(task.lifecycle)) {
          continue;
        }
        const pendingTurns = pendingTurnsForTask(draft, id);
        const currentLive = pendingTurns.find(
          (turn) => turn.status === 'running' || turn.status === 'waiting_user',
        );
        if (currentLive && remoteLiveTurnIds.has(currentLive.id)) {
          draft.cancelRequests = draft.cancelRequests ?? {};
          draft.cancelRequests[currentLive.id] = {
            kind: 'cancel',
            by: 'engine',
            opId: `cancel-task-${taskId}`,
            at: now,
          };
          continue;
        }
        const result = transitionCancelTask(task, { liveTurn: currentLive, now });
        if (!result.ok) {
          return result;
        }
        draft.tasks[id] = result.next.task;
        if (result.next.turn) {
          draft.turns[result.next.turn.id] = result.next.turn;
        }
        for (const pending of pendingTurns) {
          if (pending.id === currentLive?.id) {
            continue;
          }
          const cancelled = cancelPendingTurn(pending, { now });
          if (!cancelled.ok) {
            return cancelled;
          }
          draft.turns[pending.id] = cancelled.next;
        }
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    for (const turnId of liveTurnIds) {
      if (remoteLiveTurnIds.has(turnId)) {
        continue;
      }
      this.acceptedOpIds.delete(turnId);
      this.askBridge.cancelForTurn(turnId, 'task cancelled');
      this.credentialRegistry?.revoke(turnId);
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
      this.askBridge.cancelForTurn(turn.id, 'reload interrupt');
      this.credentialRegistry?.revoke(turn.id);
    }

    this.reconcileChildWaits({ schedule: false });
    this.deferReloadQueuedTurns();
    this.reconcileTaskTimeouts();
    processCancelRequests(this.graphDeps());
  }

  /** Every persisted queued turn survives reload unscheduled until an explicit resume. */
  private deferReloadQueuedTurns(): void {
    for (const turn of Object.values(this.store.getFile().turns)) {
      if (turn.status === 'queued') {
        this.deferredQueuedTurns.add(turn.id);
      }
    }
  }

  private reconcileTaskTimeouts(): void {
    const deps = this.graphDeps();
    const now = nowIso(this.clock);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return;
    for (const task of Object.values(this.store.getFile().tasks)) {
      if (isTerminalLifecycle(task.lifecycle)) continue;
      const turns = this.store.getTurnsForTask(task.id);
      const firstStarted = turns.find((t) => t.startedAt)?.startedAt;
      if (!firstStarted) continue;
      const startedMs = Date.parse(firstStarted);
      // Invalid timestamps must not force-cancel every open task (NaN comparisons are false).
      if (!Number.isFinite(startedMs)) continue;
      if (nowMs - startedMs <= task.executionPolicy.taskTimeoutMs) continue;
      // Timeout interrupts live turns only — does NOT seal task lifecycle (user/coordinator only).
      const live = turns.find((t) => t.status === 'running' || t.status === 'waiting_user');
      const remoteLeased =
        live && deps.leaseOwnerAlive(live.id) && !deps.ownsLease(live.id);
      if (remoteLeased) {
        deps.writeCancelRequest(live.id, 'interrupt', 'engine', `task-timeout-${task.id}`);
        continue;
      }
      if (live) this.liveRuns.get(live.id)?.abort();
      this.store.commit((draft) => {
        const pendingTurns = Object.values(draft.turns).filter(
          (t) =>
            t.taskId === task.id &&
            (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
        );
        for (const pending of pendingTurns) {
          if (pending.status === 'queued') {
            const settled = cancelPendingTurn(pending, { now });
            if (settled.ok) draft.turns[pending.id] = settled.next;
          } else {
            const interrupted = interruptTurn(pending, { now });
            if (interrupted.ok) draft.turns[pending.id] = interrupted.next;
          }
        }
        // Task lifecycle stays open for user recovery / decision.
        return { ok: true };
      });
    }
  }

  private reconcileChildWaits(options?: { schedule?: boolean }): void {
    const schedule = options?.schedule ?? true;
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
        const turnCap = canCreateTurn(draft, task.id, this.resourceLimits);
        if (!turnCap.ok) {
          return { ok: true };
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
      if (!commit.ok) {
        continue;
      }
      const continuation = this.store.getFile().turns[continuationTurnId];
      if (continuation?.status !== 'queued') {
        continue;
      }
      if (schedule) {
        void this.scheduleTurn(continuationTurnId);
      } else {
        this.deferredQueuedTurns.add(continuationTurnId);
      }
    }
  }

  /**
   * Host policy for dependency `onUnsatisfied: fail|skip` — not CLI-driven.
   * Seals dependents when a required dependency finished unsuccessfully.
   * `onUnsatisfied: block` remains open + blocked via scheduler only.
   */
  private applyDependencyTerminals(): void {
    const now = nowIso(this.clock);
    this.store.commit((draft) => {
      for (const task of Object.values(draft.tasks)) {
        if (isTerminalLifecycle(task.lifecycle)) continue;
        const outcome = dependencyTerminalOutcome(draft, task.id);
        if (!outcome) continue;
        const live = Object.values(draft.turns).find(
          (t) =>
            t.taskId === task.id &&
            (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
        );
        const terminal = applyDependencyTerminal(task, live, outcome, {
          now,
          error: outcome === 'failed' ? 'dependency unsatisfied' : undefined,
        });
        if (terminal.ok) {
          draft.tasks[task.id] = terminal.next.task;
          if (terminal.next.turn) draft.turns[terminal.next.turn.id] = terminal.next.turn;
        }
      }
      return { ok: true };
    });
  }

  private afterTurnSettled(turnId: string): void {
    this.store.commit((draft) => {
      pruneLedgerForTurn(draft, turnId);
      return { ok: true };
    });
    this.reconcileChildWaits();
    this.drainPendingSendsAfterSettlement(turnId);
  }

  private drainPendingSendsAfterSettlement(settledTurnId: string): void {
    let continuationTurnId: string | undefined;
    const now = nowIso(this.clock);
    const commit = this.store.commit((draft) => {
      const settledTurn = draft.turns[settledTurnId];
      if (!settledTurn || settledTurn.status !== 'succeeded') {
        return { ok: true };
      }
      const task = draft.tasks[settledTurn.taskId];
      if (!task || isTerminalLifecycle(task.lifecycle)) {
        return { ok: true };
      }
      const pending = pendingUserMessages(draft, task.id);
      if (pending.length === 0) {
        return { ok: true };
      }
      const turnCap = canCreateTurn(draft, task.id, this.resourceLimits);
      if (!turnCap.ok) {
        return { ok: true };
      }
      const inputs: TurnInput[] = pending.map((message) => ({ kind: 'message', messageId: message.id }));
      const turnId = randomUUID();
      const queued = transitionContinueTask(task, turnsForTask(draft, task.id), { turnId, now, inputs });
      if (!queued.ok) {
        return { ok: true };
      }
      draft.turns[turnId] = queued.next;
      continuationTurnId = turnId;
      return { ok: true };
    });

    if (commit.ok && continuationTurnId && !this.deferredQueuedTurns.has(continuationTurnId)) {
      void this.scheduleTurn(continuationTurnId);
    }
  }

  private exceedsTurnLimit(taskId: string, candidateTurnId?: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task) return true;
    const turns = this.store.getTurnsForTask(taskId);
    const cap = Math.min(this.resourceLimits.maxTurnsPerTask, task.executionPolicy.maxTurns);
    const slotsUsed = turns.filter(
      (t) => t.status !== 'queued' || t.id === candidateTurnId,
    ).length;
    return slotsUsed > cap;
  }

  private scheduleTurn(turnId: string): Promise<void> {
    this.reconcileTaskTimeouts();
    this.applyDependencyTerminals();
    processCancelRequests(this.graphDeps());
    const turn = this.store.getFile().turns[turnId];
    if (turn && this.exceedsTurnLimit(turn.taskId, turnId)) {
      return Promise.resolve();
    }
    if (!tryPromoteTurn(this.store, turnId, this.resourceLimits)) {
      return Promise.resolve();
    }
    const existing = this.turnPromises.get(turnId);
    if (existing) {
      return existing;
    }
    const promise = this.executeTurn(turnId);
    this.turnPromises.set(turnId, promise);
    void promise.finally(() => {
      this.turnPromises.delete(turnId);
      const queued = Object.values(this.store.getFile().turns).filter((t) => t.status === 'queued');
      for (const turn of queued) {
        if (this.deferredQueuedTurns.has(turn.id)) {
          continue;
        }
        if (tryPromoteTurn(this.store, turn.id, this.resourceLimits)) {
          void this.scheduleTurn(turn.id);
        }
      }
    });
    return promise;
  }

  private async executeTurn(turnId: string): Promise<void> {
    // Acquire the per-turn lease UNDER the cross-process store lock so lease
    // read/reclaim/publish is serialized across VS Code windows. This eliminates the
    // multi-process reclaim race (two engines reclaiming the same stale lease and both
    // running one turn) that no plain-fs primitive can close on its own — only one
    // process can be inside this critical section at a time.
    const lease = this.store.runExclusive(() => tryAcquireLease(this.storePath, turnId));
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
      const promote = canPromoteTurn(draft, turnId, this.resourceLimits);
      if (!promote.ok) {
        return { ok: false, reason: promote.reason };
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

    const startedTurn = this.store.getFile().turns[turnId];
    if (startedTurn) {
      this.safeEmit({
        type: 'turnStart',
        taskId: startedTurn.taskId,
        turnId,
        trigger: startedTurn.trigger,
      });
    }

    const abort = new AbortController();
    this.liveRuns.set(turnId, abort);
    const turnTimeoutMs = task.executionPolicy.turnTimeoutMs;
    const cancelPoll = setInterval(() => {
      this.reconcileTaskTimeouts();
      processCancelRequests(this.graphDeps());
    }, 250);
    const turnTimer =
      turnTimeoutMs > 0
        ? setTimeout(() => {
            abort.abort();
          }, turnTimeoutMs)
        : undefined;

    let rawOutput = '';
    let observedSessionId: string | undefined;
    let terminalSettled = false;
    // Per-turn render ordering + assistant segmentation (see WEBVIEW-IMPROVEMENT-PLAN §5.1.1).
    // `order` is a per-turn monotonic counter shared by assistant segments and tool
    // calls; `(turn.sequence, order)` reconstructs the exact live interleaving.
    let orderCounter = 0;
    const nextOrder = (): number => orderCounter++;
    let currentAssistantSegment: { storeId: string; sourceMessageId: string } | undefined;
    let backend: Backend = {
      name: task.backend,
      run: async function* () {},
    };
    let mcpConfigPath: string | undefined;

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
        if (terminalSettled) {
          this.safeEmit({
            type: 'turnError',
            taskId: turn.taskId,
            turnId,
            message: `backend factory failed: ${message}`,
          });
        }
        return;
      }
      const current = this.store.getFile();
      const currentTurn = current.turns[turnId];
      const messages = messageMapFromFile(current);
      const prompt = projectPrompt(currentTurn, messages, current, this.resourceLimits.maxResultBytes);
      const built = this.bridgePort > 0 && this.credentialRegistry
        ? buildRunOptionsForTurn(this.graphDeps(), turnId, {
            prompt,
            resumeId: task.committedSessionId,
            signal: abort.signal,
            // Run the agent in the task's workspace directory so ACP adapters
            // pass it as session/new|load { cwd } instead of falling back to
            // process.cwd() (wrong dir in a packaged extension).
            cwd: task.cwd,
            model: task.model,
          })
        : {
            options: {
              prompt,
              resumeId: task.committedSessionId,
              signal: abort.signal,
              cwd: task.cwd,
              model: task.model,
            },
          };
      mcpConfigPath = built.mcpConfigPath;

      for await (const event of this.runTurnFn(backend, built.options)) {
        processCancelRequests(this.graphDeps());
        if (terminalSettled) {
          break;
        }

        // Auxiliary streaming events are forwarded raw. `assistantDelta` is
        // forwarded AFTER persistence with a rewritten, deterministic messageId
        // (`${turnId}:${order}`) so the live stream and hydrated snapshot reconcile
        // by identical id (see WEBVIEW-IMPROVEMENT-PLAN §5.1.1).
        if (
          event.type === 'reasoningDelta' ||
          event.type === 'toolStarted' ||
          event.type === 'toolUpdated' ||
          event.type === 'toolCompleted' ||
          event.type === 'usage'
        ) {
          this.safeEmit({ type: 'event', taskId: turn.taskId, turnId, event });
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
            // Open a new segment when none is current or the backend messageId
            // changed (mirrors the live reducer). Segment store id = `${turnId}:${order}`.
            const openNew =
              !currentAssistantSegment || currentAssistantSegment.sourceMessageId !== event.messageId;
            let segmentId: string;
            let segmentOrder = -1;
            if (openNew) {
              segmentOrder = nextOrder();
              segmentId = `${turnId}:${segmentOrder}`;
              currentAssistantSegment = { storeId: segmentId, sourceMessageId: event.messageId };
            } else {
              segmentId = currentAssistantSegment!.storeId;
            }
            const commit = this.store.commit((draft) => {
              const draftTurn = draft.turns[turnId];
              if (!draftTurn) {
                return { ok: false, reason: 'turn not found' };
              }
              const existing = draft.messages[segmentId];
              if (!existing) {
                draft.messages[segmentId] = {
                  id: segmentId,
                  taskId: draftTurn.taskId,
                  role: 'assistant',
                  content: event.content,
                  state: 'partial',
                  createdAt: nowIso(this.clock),
                  turnId,
                  order: segmentOrder,
                };
              } else {
                draft.messages[segmentId] = {
                  ...existing,
                  content: existing.content + event.content,
                };
              }
              return { ok: true };
            });
            if (!commit.ok) {
              const failMessage = commit.detail ?? 'assistant persistence failed';
              terminalSettled = await this.settleFailed(
                turnId,
                failMessage,
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message: failMessage });
              }
              break;
            }
            // Forward a rewritten delta carrying the deterministic segment id.
            this.safeEmit({
              type: 'event',
              taskId: turn.taskId,
              turnId,
              event: { type: 'assistantDelta', content: event.content, messageId: segmentId },
            });
            break;
          }
          case 'reasoningDelta': {
            const commit = this.store.commit((draft) => {
              const draftTurn = draft.turns[turnId];
              if (!draftTurn) {
                return { ok: false, reason: 'turn not found' };
              }
              draft.reasoning = draft.reasoning ?? {};
              const now = nowIso(this.clock);
              const existing = draft.reasoning[turnId];
              draft.reasoning[turnId] = existing
                ? { ...existing, content: existing.content + event.content, updatedAt: now }
                : {
                    id: turnId,
                    taskId: draftTurn.taskId,
                    turnId,
                    content: event.content,
                    createdAt: now,
                    updatedAt: now,
                  };
              return { ok: true };
            });
            if (!commit.ok) {
              const failMessage = commit.detail ?? 'reasoning persistence failed';
              terminalSettled = await this.settleFailed(
                turnId,
                failMessage,
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message: failMessage });
              }
              break;
            }
            break;
          }
          case 'toolStarted': {
            // A tool closes the current assistant segment (matches live commitStreaming).
            currentAssistantSegment = undefined;
            const compositeId = `${turnId}:${event.toolCallId}`;
            const commit = this.store.commit((draft) => {
              const draftTurn = draft.turns[turnId];
              if (!draftTurn) {
                return { ok: false, reason: 'turn not found' };
              }
              draft.toolCalls = draft.toolCalls ?? {};
              if (!draft.toolCalls[compositeId]) {
                const now = nowIso(this.clock);
                draft.toolCalls[compositeId] = {
                  id: compositeId,
                  taskId: draftTurn.taskId,
                  turnId,
                  toolCallId: event.toolCallId,
                  order: nextOrder(),
                  name: event.name,
                  kind: event.kind,
                  status: 'running',
                  input: event.input,
                  createdAt: now,
                  updatedAt: now,
                };
              }
              return { ok: true };
            });
            if (!commit.ok) {
              const failMessage = commit.detail ?? 'tool persistence failed';
              terminalSettled = await this.settleFailed(
                turnId,
                failMessage,
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message: failMessage });
              }
              break;
            }
            break;
          }
          case 'toolUpdated': {
            const compositeId = `${turnId}:${event.toolCallId}`;
            const commit = this.store.commit((draft) => {
              const draftTurn = draft.turns[turnId];
              if (!draftTurn) {
                return { ok: false, reason: 'turn not found' };
              }
              draft.toolCalls = draft.toolCalls ?? {};
              const now = nowIso(this.clock);
              const existing = draft.toolCalls[compositeId];
              draft.toolCalls[compositeId] = existing
                ? {
                    ...existing,
                    // Adapter `toolUpdated.input` is a full snapshot — replace, not merge.
                    input: event.input !== undefined ? event.input : existing.input,
                    updatedAt: now,
                  }
                : {
                    id: compositeId,
                    taskId: draftTurn.taskId,
                    turnId,
                    toolCallId: event.toolCallId,
                    order: nextOrder(),
                    name: 'tool',
                    status: 'running',
                    input: event.input,
                    createdAt: now,
                    updatedAt: now,
                  };
              return { ok: true };
            });
            if (!commit.ok) {
              const failMessage = commit.detail ?? 'tool persistence failed';
              terminalSettled = await this.settleFailed(
                turnId,
                failMessage,
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message: failMessage });
              }
              break;
            }
            break;
          }
          case 'toolCompleted': {
            const compositeId = `${turnId}:${event.toolCallId}`;
            const outcome = event.outcome;
            const commit = this.store.commit((draft) => {
              const draftTurn = draft.turns[turnId];
              if (!draftTurn) {
                return { ok: false, reason: 'turn not found' };
              }
              draft.toolCalls = draft.toolCalls ?? {};
              const now = nowIso(this.clock);
              const existing = draft.toolCalls[compositeId];
              const base =
                existing ??
                {
                  id: compositeId,
                  taskId: draftTurn.taskId,
                  turnId,
                  toolCallId: event.toolCallId,
                  order: nextOrder(),
                  name: 'tool',
                  status: 'running' as const,
                  createdAt: now,
                  updatedAt: now,
                };
              draft.toolCalls[compositeId] = {
                ...base,
                status: outcome === 'error' ? 'error' : 'success',
                updatedAt: now,
                ...(outcome === 'error'
                  ? { error: event.error, output: undefined }
                  : { output: event.output, error: undefined }),
              };
              return { ok: true };
            });
            if (!commit.ok) {
              const failMessage = commit.detail ?? 'tool persistence failed';
              terminalSettled = await this.settleFailed(
                turnId,
                failMessage,
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message: failMessage });
              }
              break;
            }
            break;
          }
          case 'raw':
            rawOutput += `${event.line}\n`;
            break;
          case 'turnCompleted':
            terminalSettled = await this.settleSuccess(turnId, observedSessionId, rawOutput, backend);
            if (terminalSettled) {
              this.safeEmit({ type: 'turnDone', taskId: turn.taskId, turnId });
            } else {
              terminalSettled = await this.settleFailed(
                turnId,
                'failed to settle successful turn',
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({
                  type: 'turnError',
                  taskId: turn.taskId,
                  turnId,
                  message: 'failed to settle successful turn',
                });
              }
            }
            break;
          case 'error':
            if (event.isCancellation) {
              terminalSettled = await this.settleInterrupted(turnId, observedSessionId, rawOutput, backend);
              if (terminalSettled) {
                this.safeEmit({ type: 'turnDone', taskId: turn.taskId, turnId });
              }
            } else {
              terminalSettled = await this.settleFailed(turnId, event.message, observedSessionId, rawOutput, backend);
              if (terminalSettled) {
                this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message: event.message });
              }
            }
            if (!terminalSettled) {
              terminalSettled = await this.settleFailed(
                turnId,
                'failed to settle error turn',
                observedSessionId,
                rawOutput,
                backend,
              );
              if (terminalSettled) {
                this.safeEmit({
                  type: 'turnError',
                  taskId: turn.taskId,
                  turnId,
                  message: 'failed to settle error turn',
                });
              }
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
        if (terminalSettled) {
          this.safeEmit({
            type: 'turnError',
            taskId: turn.taskId,
            turnId,
            message: 'turn ended without terminal event',
          });
        }
      }
    } catch (error) {
      if (!terminalSettled) {
        const message = error instanceof Error ? error.message : String(error);
        terminalSettled = await this.settleFailed(turnId, message, observedSessionId, rawOutput, backend);
        if (terminalSettled) {
          this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message });
        }
      }
    } finally {
      clearInterval(cancelPoll);
      if (turnTimer) clearTimeout(turnTimer);
      this.liveRuns.delete(turnId);
      this.acceptedOpIds.delete(turnId);
      if (this.credentialRegistry) {
        cleanupTurnResources(this.graphDeps(), turnId, mcpConfigPath);
      }
      this.afterTurnSettled(turnId);
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
            const turnCap = canCreateTurn(draft, task.id, this.resourceLimits);
            if (!turnCap.ok) {
              continue;
            }
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