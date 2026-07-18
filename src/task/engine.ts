import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import type { Answers, AskRef } from '../bridge/ask-bridge';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import type { McpReadinessSupervisor } from '../bridge/mcp-readiness';
import { runTurn as defaultRunTurn } from '../runner';
import type { Backend, NormalizedEvent, RunOptions } from '../types';
import type { TurnTrigger } from './types';
import { canBindTaskToBackend } from './backend-eligibility';
import {
  assembleFirstTurnPrompt,
  COMPILED_PROMPT_MAX,
  mergeBriefFromCreate,
  normalizeSkillNames,
  synthesizeBriefFromGoal,
} from './brief';
import { capabilitiesFor } from './capabilities';
import { summarizeTaskTypes } from './task-types';
import {
  formatPinnedInputsForPrompt,
  pinResolvedInputs,
  resolveInputBindings,
} from './dataflow';
import {
  minimalHostSnapshot,
  type HostEnvironmentSnapshot,
} from './host-context';
import {
  buildCompactContinuationContext,
  captureContinuationCutoff,
  isActiveHandoffPhase,
} from './engine-handoff';
import { deriveViewStatus } from './derived-status';
import type { DepGraph } from './deps';
import {
  buildRunOptionsForTurn,
  cleanupTurnResources,
  clearPendingParentQuestionOnCancel,
  deriveEntityId,
  executeToolCommand,
  processCancelRequests,
  pruneLedgerForTurn,
  projectChildResults,
  remintTurnMcpForAttempt,
  tryPromoteTurn,
  type GraphEngineDeps,
} from './engine-graph';
import { buildFreshSessionRecoveryPromptOrThrow } from './fresh-session-recovery-prompt';
import {
  decideVerdictRetry,
  failureSignature,
  selectRecoveryDecision,
} from './recovery-policy';
import { runVerificationGate as defaultRunVerificationGate } from './verification-gate';
import {
  computeSourceRevision as defaultComputeSourceRevision,
  NO_GIT_REVISION,
  SOURCE_REVISION_UNAVAILABLE,
} from './source-revision';
import { BATCH_EXPAND_MAX, type ToolCommand } from './coordinator-tools';
import { evaluateTaskReadiness } from './readiness';
import { canPromoteTurn, dependencyTerminalOutcome } from './scheduler';
import { canCreateTurn, DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from './limits';
import {
  DEFAULT_RUN_LIMIT_MS,
  resolveTaskExecutionPolicy,
  resolveTurnRunDeadline,
  remainingRunTimeMs,
} from './execution-policy';
import { TASK_ERROR_MAX_BYTES, TASK_RESULT_MAX_BYTES } from './content-limits';
import { selectCommittedSessionId } from './session-select';
import { TaskStore } from './store';
import { createJsonTurnStreamBuffer } from './turn-stream-persistence';
import {
  applyDependencyTerminal,
  applyFailedTurn,
  applySuccessfulTurn,
  createTask,
  interruptTurn,
  registerAsk,
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
  isTerminalLifecycle,
  prepareDeleteQueuedTurn,
  prepareEditQueuedTurn,
  holdQueuedFollowUpsOnFailure,
  reopenTask,
  setTaskLifecycle as transitionSetTaskLifecycle,
  type CreateTaskInput,
  type Effect,
} from './transitions';
import type {
  MusterTask,
  TaskAttentionCode,
  TaskCapability,
  TaskDependency,
  TaskExecutionPolicy,
  TaskInputBinding,
  TaskLifecycleState,
  TaskMessage,
  TaskRole,
  TaskStoreFile,
  TaskTurn,
  TaskVerdict,
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
  /**
   * M017-S04 / D037: optional MCP readiness supervisor. When present with
   * bridgePort>0 + credentialRegistry, onBeforePrompt refuses to mark
   * prompt_outstanding until evaluate() is ready for the live turnId+attemptId.
   */
  mcpReadiness?: McpReadinessSupervisor;
  /** Current MusterBridgeServer generation (for readiness evaluate). */
  getBridgeGeneration?: () => number;
  resourceLimits?: ResourceLimits;
  /**
   * M016-S01 / D037: live ResourceLimits reader. When provided, every scheduling
   * decision (promote / create-turn / rescan) re-reads caps so a host setting
   * change takes effect on the next pass. Falls back to static `resourceLimits`
   * then DEFAULT_RESOURCE_LIMITS when omitted (backward compatible).
   */
  getResourceLimits?: () => ResourceLimits;
  /** Live host ceiling, read only when a queued turn is durably promoted. */
  getRunLimitMs?: () => number;
  emit?: (e: EngineEvent) => void;
  /**
   * W9: workspace trust gate for create-and-run / promote. Default true (tests).
   * Host should pass `() => vscode.workspace.isTrusted`.
   */
  isWorkspaceTrusted?: () => boolean;
  /**
   * Host-context W1: async prepare that fills backend/model cache (idempotent;
   * concurrent callers share one in-flight). Engine races this with a 2s timeout
   * at the single first-turn freeze site only.
   */
  prepareHostEnvironment?: () => Promise<void>;
  /**
   * Sync read of last resolved host env cache only (no I/O).
   * Missing → engine synthesizes minimalHostSnapshot.
   */
  getHostEnvironment?: () => HostEnvironmentSnapshot | undefined;
  /** Fallback cwd when task.cwd and snapshot.cwd are absent. */
  workspaceFolder?: string;
  /**
   * Task-types W2: live cwd-aware registry from host settings.
   * Passed through to GraphEngineDeps for create/list.
   */
  getTaskTypeRegistry?: (cwd?: string) => import('./task-types').TaskTypeRegistryResult;
  /**
   * Host-authorization master switch for the Phase C host gate (default false). When
   * NOT explicitly true, the engine NEVER executes a task's verification commands and
   * falls back to the worker's self-reported verdict (Phase A behavior) — so host
   * execution is user-authorized, never agent-triggerable.
   *
   * Accepts a live RESOLVER (`() => boolean`) as well as a static boolean: the engine
   * evaluates it at settle time, so toggling the `muster.verification.hostRun` setting
   * OFF revokes host execution immediately (no reload). Host wires a callback that reads
   * the current setting value each time.
   */
  allowHostVerification?: boolean | (() => boolean);
  /**
   * Host-run verification gate (verify-gate-loop Phase C). Injectable so tests are
   * deterministic and never shell out. Default: real host runner (`spawnSync`,
   * `shell:false`). Invoked ONLY for verify tasks with `brief.verification.hostRun`.
   */
  runVerificationGate?: (commands: string[], cwd: string) => { verdict: TaskVerdict };
  /**
   * Source-revision probe for host-verdict drift invalidation (Phase C).
   * Injectable for deterministic tests. Default: real git probe.
   */
  computeSourceRevision?: (cwd: string) => string;
  /**
   * ACP skill invocation: resolve a backend's advertised command/skill names for
   * fail-closed first-turn skill injection. Injected by the host (extension.ts)
   * to avoid a `task/` → `backends/` layering dependency. Returns undefined when
   * the backend has never advertised (UNKNOWN → optimistic inject).
   */
  getAdvertisedCommands?: (backend: string) => ReadonlySet<string> | undefined;
  /**
   * Per-backend skill invocation prefix (`/` for most, `$` for Codex). Injected
   * by the host (extension.ts) to keep the per-backend map out of `task/`
   * (no `task/` → `backends/` dependency). Defaults to `/` when absent.
   */
  getSkillPrefix?: (backend: string) => string;
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
  /** New leases expire after their owning turn deadline plus cleanup buffer. */
  expiresAt?: string;
}

/** Compatibility age fallback for legacy lease records without `expiresAt`. */
export const MAX_LEASE_AGE_MS = 1_800_000;
export const LEASE_CLEANUP_BUFFER_MS = 60_000;

/**
 * Attention message set when auto-remediation pauses on an identical recurring verify
 * failure. Stable literal so the pause branch can detect it and stay idempotent across
 * repeated ticks (verify-gate-loop ISSUE 10).
 */
const PAUSE_ATTENTION_MESSAGE = 'identical verify failure recurred; auto-remediation paused';

const DEFAULT_LIMITS: DispositionLimits = {
  maxResult: TASK_RESULT_MAX_BYTES,
  maxError: TASK_ERROR_MAX_BYTES,
};

function nowIso(clock?: () => string): string {
  return clock?.() ?? new Date().toISOString();
}

/** Non-empty backend/model label: no control bytes, length-capped. */
function normalizeRuntimeLabel(value: string, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
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
  // Batch entity ids include their local id in the suffix (for example
  // `turn:producer-<hash>`). A raw colon starts an NTFS alternate data stream on
  // Windows, collapsing distinct turn leases onto `<store>.lease.turn` and making
  // workers spin forever while contending for the same file. encodeURIComponent keeps
  // ordinary `turn-...` ids readable while making every lease a portable file name.
  return `${storePath}.lease.${encodeURIComponent(turnId)}`;
}

/**
 * A lease is reclaimable when it is missing/empty/unparseable, owned by a dead PID, or
 * past its explicit deadline. Legacy records without `expiresAt` use `createdAt` plus
 * {@link MAX_LEASE_AGE_MS}; missing legacy timestamps are treated as very old. This is
 * the single source of truth for acquisition and reload reconciliation.
 */
export function isLeaseReclaimable(record: LeaseRecord | undefined): boolean {
  if (!record) {
    return true;
  }
  if (isProcessDead(record.pid)) {
    return true;
  }
  if (record.expiresAt) {
    const expires = Date.parse(record.expiresAt);
    if (Number.isFinite(expires)) {
      return Date.now() > expires;
    }
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

function updateLeaseExpiry(
  storePath: string,
  turnId: string,
  record: LeaseRecord,
  runDeadlineAt: string,
): void {
  const target = leasePath(storePath, turnId);
  const current = readLockRecord(target);
  if (current?.pid !== record.pid || current.token !== record.token) return;
  const deadline = Date.parse(runDeadlineAt);
  if (!Number.isFinite(deadline)) return;
  const next: LeaseRecord = {
    ...current,
    expiresAt: new Date(deadline + LEASE_CLEANUP_BUFFER_MS).toISOString(),
  };
  try {
    fs.writeFileSync(target, JSON.stringify(next), 'utf8');
    record.expiresAt = next.expiresAt;
  } catch {
    // Compatibility fallback remains createdAt age + PID liveness.
  }
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

/** Stable fingerprint for Phase C send idempotency (existing-task path). */
export function sendFingerprint(input: {
  kind: 'existing' | 'new';
  taskId?: string;
  content: string;
  agentContent?: string;
  backend?: string;
  model?: string;
  continuationOf?: string;
  goal?: string;
}): string {
  return JSON.stringify({
    kind: input.kind,
    taskId: input.taskId ?? null,
    content: input.content,
    agentContent: input.agentContent ?? null,
    backend: input.backend ?? null,
    model: input.model ?? null,
    continuationOf: input.continuationOf ?? null,
    goal: input.goal ?? null,
  });
}

export function projectPrompt(
  turn: TaskTurn,
  messages: ReadonlyMap<string, TaskMessage>,
  file?: TaskStoreFile,
  maxChildResultBytes = TASK_RESULT_MAX_BYTES,
): string {
  const parts: string[] = [];
  // W1: durable pin / frozen compiled prompt precedes turn inputs.
  if (turn.compiledPrompt) {
    parts.push(turn.compiledPrompt);
  } else if (turn.resolvedInputs && turn.resolvedInputs.length > 0) {
    const framed = formatPinnedInputsForPrompt(turn.resolvedInputs);
    if (framed) parts.push(framed);
  }
  const messageInputs = turn.inputs
    .filter((input): input is { kind: 'message'; messageId: string } => input.kind === 'message')
    .map((input) => messages.get(input.messageId))
    .filter((message): message is TaskMessage => message !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const message of messageInputs) {
    parts.push(message.agentContent ?? message.content);
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
    briefKindOf: (taskId) => file.tasks[taskId]?.brief?.kind,
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

function isQueuedTurnAutoPromoteFrozen(
  file: TaskStoreFile,
  taskId: string,
  candidateTurnId: string,
): boolean {
  const candidate = file.turns[candidateTurnId];
  if (!candidate || candidate.taskId !== taskId || candidate.status !== 'queued') {
    return false;
  }
  return candidate.holdAutoPromote === true;
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
  private readonly mcpReadiness?: McpReadinessSupervisor;
  private readonly getBridgeGeneration?: () => number;
  /**
   * Live ResourceLimits getter (M016-S01). Always a function so scheduling
   * decision points can re-read host ceilings without reloading the engine.
   */
  private readonly getResourceLimits: () => ResourceLimits;
  private readonly getRunLimitMs: () => number;
  private readonly emit?: (e: EngineEvent) => void;
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly prepareHostEnvironment?: () => Promise<void>;
  private readonly getHostEnvironment?: () => HostEnvironmentSnapshot | undefined;
  private readonly workspaceFolder?: string;
  private readonly getTaskTypeRegistry?: (
    cwd?: string,
  ) => import('./task-types').TaskTypeRegistryResult;
  private readonly getAdvertisedCommands?: (
    backend: string,
  ) => ReadonlySet<string> | undefined;
  private readonly getSkillPrefix?: (backend: string) => string;
  /**
   * Phase C host-authorization master switch (default false — never execute). Held as
   * the raw config value (static boolean OR live resolver) and evaluated per settle via
   * {@link resolveAllowHostVerification}.
   */
  private readonly allowHostVerification: boolean | (() => boolean);
  /** Phase C host gate + drift probe (injectable; default real host shell/git). */
  private readonly runVerificationGate: (
    commands: string[],
    cwd: string,
  ) => { verdict: TaskVerdict };
  private readonly computeSourceRevision: (cwd: string) => string;
  /**
   * In-process handles for currently executing turns. Keyed by turnId so this
   * engine can abort only runs it owns and map session ids back to turns.
   */
  private readonly liveRuns = new Map<
    string,
    {
      controller: AbortController;
      taskId: string;
      sessionId?: string;
      /**
       * Monotonic render-order allocator for this live turn (assistant/tool segments).
       */
      nextOrder?: () => number;
      /**
       * Set when this process requested interrupt (abort). Required for
       * confirmed interrupt-and-send settlement (bind + promote).
       */
      interruptArmed?: boolean;
    }
  >();
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
    this.mcpReadiness = config.mcpReadiness;
    this.getBridgeGeneration = config.getBridgeGeneration;
    this.getResourceLimits =
      config.getResourceLimits ??
      (() => config.resourceLimits ?? DEFAULT_RESOURCE_LIMITS);
    this.getRunLimitMs = config.getRunLimitMs ?? (() => DEFAULT_RUN_LIMIT_MS);
    // Log effective caps once at engine load for diagnosis (slice verification).
    const bootLimits = this.getResourceLimits();
    console.info('[muster][task-orch] resource.limits', {
      maxConcurrentTurns: bootLimits.maxConcurrentTurns,
      maxConcurrentPerRoot: bootLimits.maxConcurrentPerRoot,
      maxConcurrentPerBackend: bootLimits.maxConcurrentPerBackend,
      maxTurnsPerTask: bootLimits.maxTurnsPerTask,
      source: config.getResourceLimits
        ? 'getResourceLimits'
        : config.resourceLimits
          ? 'resourceLimits'
          : 'DEFAULT_RESOURCE_LIMITS',
    });
    this.emit = config.emit;
    this.isWorkspaceTrusted = config.isWorkspaceTrusted ?? (() => true);
    this.prepareHostEnvironment = config.prepareHostEnvironment;
    this.getHostEnvironment = config.getHostEnvironment;
    this.workspaceFolder = config.workspaceFolder;
    this.getTaskTypeRegistry = config.getTaskTypeRegistry;
    this.getAdvertisedCommands = config.getAdvertisedCommands;
    this.getSkillPrefix = config.getSkillPrefix;
    // Preserve the raw value (boolean or resolver); resolveAllowHostVerification()
    // evaluates it live at settle time so a mid-session setting toggle takes effect.
    this.allowHostVerification = config.allowHostVerification ?? false;
    this.computeSourceRevision =
      config.computeSourceRevision ?? ((cwd) => defaultComputeSourceRevision(cwd));
    // Thread the injected source-revision probe into the DEFAULT settle-time host gate
    // too (not only revalidate), so the before/after drift capture uses the same
    // revision function — deterministic in tests, consistent in production.
    this.runVerificationGate =
      config.runVerificationGate ??
      ((commands, cwd) =>
        defaultRunVerificationGate(commands, cwd, {
          computeRevision: (c) => this.computeSourceRevision(c),
        }));
  }

  /** 2s-capped host prepare before sequence-1 assemble (single freeze site). */
  private async prepareHostForFirstTurn(): Promise<void> {
    if (!this.prepareHostEnvironment) return;
    try {
      await Promise.race([
        this.prepareHostEnvironment().catch(() => {
          // Rejection → fall through to minimal snapshot at assemble.
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // Never strand the turn: assemble with minimalHostSnapshot.
    }
  }

  /**
   * Sync host snapshot for assemble. Never returns undefined.
   * task.cwd wins; trusted always from isWorkspaceTrusted().
   */
  private resolveHostSnapshot(task: MusterTask): HostEnvironmentSnapshot {
    const trusted = this.isWorkspaceTrusted();
    const cached = this.getHostEnvironment?.();
    const cwd =
      (task.cwd && task.cwd.length > 0 ? task.cwd : undefined) ??
      cached?.cwd ??
      this.workspaceFolder ??
      process.cwd();
    if (!cached) {
      return minimalHostSnapshot(cwd, trusted);
    }
    return {
      ...cached,
      cwd,
      trusted,
    };
  }

  /** W9: host calls when workspace trust is granted — rescan safe queued work. */
  onWorkspaceTrustGranted(): void {
    this.rescanSchedulableTurns();
  }

  private requireWorkspaceTrusted(): EngineResult<void> {
    if (this.isWorkspaceTrusted()) {
      return { ok: true, value: undefined };
    }
    return {
      ok: false,
      reason: JSON.stringify({
        code: 'workspace_untrusted',
        message: 'workspace is not trusted; cannot run or release tasks',
        retryable: true,
      }),
    };
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
      // Live passthrough so each tool-command pass re-snapshots caps (M016-S01).
      getResourceLimits: () => this.getResourceLimits(),
      getRunLimitMs: this.getRunLimitMs,
      clock: this.clock,
      liveRuns: this.liveRuns,
      pendingAskPromises: this.pendingAskPromises,
      onScheduleTurn: (turnId) => void this.scheduleTurn(turnId),
      onRescanSchedulableTurns: (ids) => this.rescanSchedulableTurns(ids),
      isWorkspaceTrusted: () => this.isWorkspaceTrusted(),
      getHostEnvironment: this.getHostEnvironment
        ? () => this.getHostEnvironment!()
        : undefined,
      workspaceFolder: this.workspaceFolder,
      getTaskTypeRegistry: this.getTaskTypeRegistry
        ? (cwd) => this.getTaskTypeRegistry!(cwd)
        : undefined,
      leaseOwnerAlive: (turnId) => leaseOwnerAlive(this.storePath, turnId),
      ownsLease: (turnId) => ownsLocalLease(this.storePath, turnId),
      writeCancelRequest: (turnId, kind, by, opId, sealedBy) => {
        this.store.commit((draft) => {
          draft.cancelRequests = draft.cancelRequests ?? {};
          draft.cancelRequests[turnId] = {
            kind,
            by,
            opId,
            at: nowIso(this.clock),
            ...(sealedBy ? { sealedBy } : {}),
          };
          return { ok: true };
        });
      },
    };
  }

  /** Per-turn elicitation wait tokens (RFD form); resume only when empty. */
  private readonly elicitationWaitTokens = new Map<string, Set<string>>();

  /**
   * Whether the live session may prompt the user directly (root only by default).
   */
  mayDirectAskUser(sessionId: string): boolean {
    const live = this.findLiveTurnBySessionId(sessionId);
    if (!live) return false;
    const task = this.store.getFile().tasks[live.taskId];
    return !task?.parentId;
  }

  /**
   * Mark live turn waiting_user for an RFD elicitation prompt (no AskBridge).
   * Returns turnId when a live turn was found.
   */
  beginElicitationWait(
    sessionId: string,
    promptId: string,
  ): { turnId: string } | undefined {
    const live = this.findLiveTurnBySessionId(sessionId);
    if (!live) return undefined;
    if (!this.mayDirectAskUser(sessionId)) return undefined;
    const commit = this.store.commit((draft) => {
      const turn = draft.turns[live.turnId];
      if (!turn) return { ok: false, reason: 'turn not found' };
      if (turn.status === 'waiting_user') return { ok: true };
      if (turn.status !== 'running') return { ok: false, reason: 'turn is not live' };
      const asked = registerAsk(turn);
      if (!asked.ok) return asked;
      draft.turns[live.turnId] = asked.next;
      return { ok: true };
    });
    if (!commit.ok) return undefined;
    let set = this.elicitationWaitTokens.get(live.turnId);
    if (!set) {
      set = new Set();
      this.elicitationWaitTokens.set(live.turnId, set);
    }
    set.add(promptId);
    return { turnId: live.turnId };
  }

  /** Soft release: resume only if this token existed and set is now empty. */
  endElicitationWait(turnId: string, promptId: string): void {
    const set = this.elicitationWaitTokens.get(turnId);
    // Hard-cleared turns have no set — do not revive.
    if (!set || !set.has(promptId)) return;
    set.delete(promptId);
    if (set.size > 0) return;
    this.elicitationWaitTokens.delete(turnId);
    this.store.commit((draft) => {
      const turn = draft.turns[turnId];
      if (!turn || turn.status !== 'waiting_user') return { ok: true };
      const resumed = submitAnswer(turn);
      if (resumed.ok) draft.turns[turnId] = resumed.next;
      return { ok: true };
    });
  }

  /** Hard clear tokens without resuming (turn cancel / backend exit / deactivate). */
  dropElicitationWaits(turnId: string): void {
    this.elicitationWaitTokens.delete(turnId);
  }

  /**
   * Resolve a live turn for an ACP session id (observed on the live handle or
   * persisted on the turn). Used to route agent-extension ask_user_question
   * prompts back into the correct task/turn AskBridge registration.
   */
  findLiveTurnBySessionId(
    sessionId: string,
  ): { taskId: string; turnId: string } | undefined {
    if (!sessionId) {
      return undefined;
    }
    for (const [turnId, handle] of this.liveRuns) {
      if (handle.sessionId === sessionId) {
        return { taskId: handle.taskId, turnId };
      }
    }
    const file = this.store.getFile();
    for (const turn of Object.values(file.turns)) {
      if (
        (turn.status === 'running' || turn.status === 'waiting_user') &&
        turn.observedSessionId === sessionId
      ) {
        return { taskId: turn.taskId, turnId: turn.id };
      }
    }
    return undefined;
  }

  /**
   * Register an agent-extension ask (e.g. Grok x.ai/ask_user_question) against
   * the live turn for `sessionId`, pause the turn as waiting_user, and return
   * the AskBridge promise the host can await for webview answers.
   */
  registerAgentAsk(
    sessionId: string,
    questions: import('../bridge/ask-bridge').Question[],
    deadlineMs: number,
  ):
    | { ok: true; ref: AskRef; promise: Promise<Answers> }
    | { ok: false; reason: string } {
    const live = this.findLiveTurnBySessionId(sessionId);
    if (!live) {
      return { ok: false, reason: 'no live turn for session' };
    }
    if (questions.length === 0) {
      return { ok: false, reason: 'questions required' };
    }
    // Non-root tasks must not reach the user by default (ask_parent path).
    const liveTask = this.store.getFile().tasks[live.taskId];
    if (liveTask?.parentId) {
      return {
        ok: false,
        reason: 'direct user elicitation denied for non-root task; use ask_parent',
      };
    }
    const askId = this.askBridge.generateAskId();
    const ref: AskRef = { taskId: live.taskId, turnId: live.turnId, askId };
    const commit = this.store.commit((draft) => {
      const turn = draft.turns[ref.turnId];
      if (!turn) return { ok: false, reason: 'turn not found' };
      if (turn.status === 'waiting_user') {
        return { ok: true };
      }
      if (turn.status !== 'running') {
        return { ok: false, reason: 'turn is not live' };
      }
      const asked = registerAsk(turn);
      if (!asked.ok) return asked;
      draft.turns[ref.turnId] = asked.next;
      return { ok: true };
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    const promise = this.askBridge.register(ref, questions, deadlineMs);
    return { ok: true, ref, promise };
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
    // Soft dismiss: commit the waiting_user → resumed transition first, then
    // reject the pending ask so MCP/agent paths can continue (cancelled).
    // Cancel only after commit so a failed commit leaves the ask retryable.
    const commit = this.store.commit((draft) => {
      const turn = draft.turns[ref.turnId];
      if (!turn) return { ok: false, reason: 'turn not found' };
      if (turn.status !== 'waiting_user') {
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
    this.askBridge.cancel(ref, 'user dismissed ask');
    return { ok: true, value: undefined };
  }

  async handleToolCall(
    ctx: import('../bridge/credentials').CredentialContext,
    _tool: string,
    command: ToolCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const kind = command.kind;
    if (
      kind === 'create_task' ||
      kind === 'delegate_task' ||
      kind === 'create_tasks' ||
      kind === 'delegate_tasks' ||
      kind === 'release_tasks' ||
      kind === 'complete_task' ||
      kind === 'fail_task'
    ) {
      console.info('[muster][task-orch] tool.call', {
        kind,
        callerTaskId: ctx.callerTaskId,
        turnId: ctx.turnId,
        opId: 'opId' in command ? command.opId : undefined,
        ...(kind === 'create_task' || kind === 'delegate_task'
          ? {
              goal: command.spec.goal.slice(0, 120),
              backend: command.spec.backend,
              model: command.spec.model ?? null,
              role: command.spec.role ?? null,
            }
          : {}),
        ...(kind === 'create_tasks' || kind === 'delegate_tasks'
          ? {
              count: command.specs.length,
              localIds: command.specs.map((s) => s.localId).slice(0, BATCH_EXPAND_MAX),
            }
          : {}),
        ...(kind === 'release_tasks'
          ? { taskIds: command.taskIds, includeDependencies: command.includeDependencies ?? false }
          : {}),
      });
    }
    const result = await executeToolCommand(
      this.graphDeps(),
      {
        callerTaskId: ctx.callerTaskId,
        turnId: ctx.turnId,
        rootId: ctx.rootId,
        allowedActions: ctx.allowedActions,
      },
      command,
    );
    if (
      kind === 'create_task' ||
      kind === 'delegate_task' ||
      kind === 'release_tasks' ||
      kind === 'complete_task' ||
      kind === 'fail_task'
    ) {
      if (result.ok) {
        console.info('[muster][task-orch] tool.ok', { kind, result: result.result });
      } else {
        console.info('[muster][task-orch] tool.err', { kind, error: result.error });
      }
    }
    return result;
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
    /** User-visible first message (display-name mentions). Falls back to goal. */
    message?: string;
    /** Agent-facing first message when it differs from `message` (expanded paths). */
    agentMessage?: string;
    /** Workspace directory the agent runs in for this task's turns. */
    cwd?: string;
    /**
     * ACP skills to invoke on the new task's first turn (structured chips from the
     * composer). Applies ONLY to a genuinely new task's first-turn brief; ignored
     * for a continuation (`continuationOf` set → no fresh first turn to inject into).
     */
    skills?: string[];
    /** Phase C idempotent send key. */
    clientRequestId?: string;
  }): EngineResult<{ taskId: string; messageId: string; turnId: string; clientRequestId?: string }> {
    const trust = this.requireWorkspaceTrusted();
    if (!trust.ok) return trust;
    const backend = this.makeBackend(params.backend);
    if (!canBindTaskToBackend(backend.capabilities)) {
      return { ok: false, reason: 'backend does not support MCP' };
    }

    const clientRequestId =
      typeof params.clientRequestId === 'string' && params.clientRequestId.trim()
        ? params.clientRequestId.trim()
        : undefined;
    const messageContent = params.message ?? params.goal;
    const agentContent =
      params.agentMessage && params.agentMessage !== messageContent
        ? params.agentMessage
        : undefined;
    const fingerprint = sendFingerprint({
      kind: 'new',
      content: messageContent,
      agentContent,
      backend: params.backend,
      model: params.model,
      continuationOf: params.continuationOf,
      goal: params.goal,
    });
    if (clientRequestId) {
      const existing = this.store.getFile().sendReceipts?.[clientRequestId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return { ok: false, reason: 'clientRequestId conflict: different payload' };
        }
        return {
          ok: true,
          value: {
            taskId: existing.taskId,
            messageId: existing.messageId,
            turnId: existing.turnId,
            clientRequestId,
          },
        };
      }
    }

    const taskId = randomUUID();
    const messageId = randomUUID();
    const turnId = randomUUID();
    const now = nowIso(this.clock);
    const role = params.role ?? 'coordinator';
    // Skills inject into the FIRST turn only. A continuation reuses an existing
    // conversation with no fresh first turn, so skip skill attach there.
    const skills = params.continuationOf ? undefined : normalizeSkillNames(params.skills);
    const input: CreateTaskInput = {
      id: taskId,
      role,
      goal: params.goal,
      continuationOf: params.continuationOf,
      parentId: null,
      dependencies: [],
      backend: params.backend,
      model: params.model,
      cwd: params.cwd,
      capabilities: [
        'create_child',
        'wait_child',
        'read_subtree',
        'cancel_child',
        'interrupt_child',
      ],
      executionPolicy: resolveTaskExecutionPolicy(undefined, { userRunLimitMs: this.getRunLimitMs() }),
      // Host composer create-and-run: atomic released (plan W3 matrix).
      releaseState: 'released',
      // Root host tasks are coordinators by default — use coordinate preamble
      // (presentation + graph playbook); attach any composer skill chips for the
      // first-turn injection (undefined for a continuation).
      brief: {
        ...synthesizeBriefFromGoal(
          params.goal,
          undefined,
          role === 'coordinator' ? 'coordinate' : 'generic',
        ),
        ...(skills ? { skills } : {}),
      },
    };

    const commit = this.store.commit((draft) => {
      if (clientRequestId) {
        const race = draft.sendReceipts?.[clientRequestId];
        if (race) {
          if (race.fingerprint !== fingerprint) {
            return { ok: false, reason: 'clientRequestId conflict: different payload' };
          }
          return { ok: true };
        }
      }
      if (draft.tasks[taskId]) {
        return { ok: false, reason: 'task id already exists' };
      }
      const graph = depGraphFromFile(draft);
      const created = createTask(input, { rootId: taskId, graph, now });
      if (!created.ok) {
        return created;
      }
      draft.tasks[taskId] = {
        ...created.next,
        releasedAt: now,
      };

      draft.messages[messageId] = {
        id: messageId,
        taskId,
        role: 'user',
        content: messageContent,
        ...(agentContent ? { agentContent } : {}),
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
      if (clientRequestId) {
        draft.sendReceipts = draft.sendReceipts ?? {};
        draft.sendReceipts[clientRequestId] = {
          clientRequestId,
          fingerprint,
          taskId,
          messageId,
          turnId,
          createdAt: now,
        };
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }

    if (clientRequestId) {
      const receipt = this.store.getFile().sendReceipts?.[clientRequestId];
      if (receipt) {
        void this.scheduleTurn(receipt.turnId);
        return {
          ok: true,
          value: {
            taskId: receipt.taskId,
            messageId: receipt.messageId,
            turnId: receipt.turnId,
            clientRequestId,
          },
        };
      }
    }

    void this.scheduleTurn(turnId);
    return {
      ok: true,
      value: { taskId, messageId, turnId, ...(clientRequestId ? { clientRequestId } : {}) },
    };
  }

  /**
   * Enqueue a user message as a FIFO follow-up turn (plain Enter / idle send).
   * Does not interrupt a live turn. Schedules immediately when eligible.
   */
  continueTaskWithMessage(
    taskId: string,
    instruction: string,
  ): EngineResult<{
    messageId: string;
    turnId: string;
    outcome: 'queued' | 'scheduled';
  }> {
    const reserved = this.reserveQueuedFollowUp(taskId, instruction);
    if (!reserved.ok) {
      return reserved;
    }
    const liveTask = this.store.getTask(taskId);
    const handoffBusy =
      liveTask?.handoff?.version === 1 && isActiveHandoffPhase(liveTask.handoff.phase);
    if (!handoffBusy) {
      void this.scheduleTurn(reserved.value.turnId);
    }
    return {
      ok: true,
      value: {
        ...reserved.value,
        outcome: handoffBusy ? 'queued' : 'scheduled',
      },
    };
  }

  /**
   * Direct message while live: **reserve first, interrupt second**.
   * Never concurrent `backend.sendLiveInput`. On reserve failure the live turn
   * keeps running. Interrupt only when a local liveRuns handle exists.
   */
  interruptAndSend(
    taskId: string,
    instruction: string,
  ): EngineResult<{
    messageId: string;
    turnId: string;
    outcome: 'queued' | 'scheduled';
    interruptedTurnId?: string;
  }> {
    const file = this.store.getFile();
    const live = turnsForTask(file, taskId).find(
      (t) => t.status === 'running' || t.status === 'waiting_user',
    );

    if (!live) {
      const cont = this.continueTaskWithMessage(taskId, instruction);
      if (!cont.ok) return cont;
      return { ok: true, value: cont.value };
    }

    // ISSUE-3: reserve continuation before any abort.
    const reserved = this.reserveQueuedFollowUp(taskId, instruction);
    if (!reserved.ok) {
      return reserved;
    }

    const hasLocalHandle = this.liveRuns.has(live.id);
    if (hasLocalHandle) {
      this.interruptTurn(live.id);
      return {
        ok: true,
        value: {
          ...reserved.value,
          outcome: 'queued',
          interruptedTurnId: live.id,
        },
      };
    }

    // No local handle: message stays queued; do not fake interrupt success.
    return {
      ok: true,
      value: {
        ...reserved.value,
        outcome: 'queued',
      },
    };
  }

  /** Durable queue row only — does not schedule or interrupt. */
  private reserveQueuedFollowUp(
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

      const turnCap = canCreateTurn(draft, taskId, this.getResourceLimits());
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
      // Handoff barrier is canPromoteTurn (active handoff phase), not holdAutoPromote.
      draft.turns[turnId] = queued.next;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    return { ok: true, value: { messageId, turnId } };
  }

  resumeQueuedTurn(turnId: string): EngineResult<void> {
    const file = this.store.getFile();
    const turn = file.turns[turnId];
    if (!turn) {
      return { ok: false, reason: 'turn not found' };
    }
    if (turn.status !== 'queued') {
      return { ok: false, reason: 'turn is not queued' };
    }
    // Explicit resume clears MEM030 hold so this turn may auto-promote.
    if (turn.holdAutoPromote) {
      const clear = this.store.commit((draft) => {
        const current = draft.turns[turnId];
        if (!current || current.status !== 'queued') {
          return { ok: false, reason: 'turn is not queued' };
        }
        const { holdAutoPromote: _hold, ...rest } = current;
        void _hold;
        draft.turns[turnId] = rest;
        return { ok: true };
      });
      if (!clear.ok) {
        return { ok: false, reason: clear.detail ?? clear.reason };
      }
    }
    const promote = canPromoteTurn(this.store.getFile(), turnId, this.getResourceLimits());
    if (!promote.ok) {
      return { ok: false, reason: promote.reason };
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
      capabilities:
        params.capabilities ?? [
          'create_child',
          'wait_child',
          'read_subtree',
          'cancel_child',
          'interrupt_child',
        ],
      executionPolicy: resolveTaskExecutionPolicy(params.executionPolicy, {
        userRunLimitMs: this.getRunLimitMs(),
      }),
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

  /**
   * Atomically switch an existing task to a new runtime binding.
   *
   * No model is called here. The source conversation cutoff is persisted and
   * compiled into the first real target turn, which goes through the ordinary
   * prompt/MCP/session path.
   */
  async requestRuntimeHandoff(params: {
    taskId: string;
    targetBackend: string;
    targetModel?: string;
  }): Promise<
    EngineResult<{
      operationId: string;
      boundBackend: string;
      boundModel?: string;
      switchedAt: string;
    }>
  > {
    const task = this.store.getTask(params.taskId);
    if (!task) return { ok: false, reason: 'task not found' };

    const targetBackendId = normalizeRuntimeLabel(params.targetBackend, 128);
    if (!targetBackendId) {
      return { ok: false, reason: 'target backend is invalid' };
    }
    const targetModelId =
      params.targetModel === undefined
        ? undefined
        : normalizeRuntimeLabel(params.targetModel, 256);
    if (params.targetModel !== undefined && targetModelId === undefined) {
      return { ok: false, reason: 'target model is invalid' };
    }

    let targetBackend: Backend;
    try {
      targetBackend = this.makeBackend(targetBackendId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `target backend unavailable: ${message}` };
    }
    if (!canBindTaskToBackend(targetBackend.capabilities)) {
      return { ok: false, reason: 'backend does not support MCP' };
    }

    const now = nowIso(this.clock);
    const operationId = randomUUID();
    let boundModel: string | undefined;
    const commit = this.store.commit((draft) => {
      const current = draft.tasks[params.taskId];
      if (!current) return { ok: false, reason: 'task not found' };
      if (
        current.backend === targetBackendId &&
        (current.model ?? undefined) === (targetModelId ?? undefined)
      ) {
        return { ok: false, reason: 'target backend/model is already bound' };
      }

      const preempted = this.applyHandoffTurnPreemption(draft, params.taskId, now);
      if (!preempted.ok) return preempted;

      const sourceEpoch = current.runtimeEpoch ?? 1;
      const targetEpoch = sourceEpoch + 1;
      const contextCutoff = captureContinuationCutoff(draft, params.taskId, now);
      const nextTask: MusterTask = {
        ...current,
        backend: targetBackendId,
        runtimeEpoch: targetEpoch,
        handoff: {
          version: 2,
          operationId,
          source: {
            backend: current.backend,
            ...(current.model ? { model: current.model } : {}),
            runtimeEpoch: sourceEpoch,
          },
          target: {
            backend: targetBackendId,
            ...(targetModelId ? { model: targetModelId } : {}),
            runtimeEpoch: targetEpoch,
          },
          contextCutoff,
          continuation: { status: 'pending' },
          switchedAt: now,
        },
        revision: current.revision + 1,
        updatedAt: now,
      };
      if (targetModelId !== undefined) nextTask.model = targetModelId;
      else delete nextTask.model;
      delete nextTask.committedSessionId;
      draft.tasks[params.taskId] = nextTask;
      boundModel = targetModelId;

      // Turns queued before the click now belong to the new binding. The oldest
      // one will atomically claim the continuation at the prompt freeze site.
      for (const queued of turnsForTask(draft, params.taskId)) {
        if (queued.status === 'queued') {
          draft.turns[queued.id] = { ...queued, runtimeEpoch: targetEpoch };
        }
      }
      return { ok: true };
    });
    if (!commit.ok) return { ok: false, reason: commit.detail ?? commit.reason };

    // The durable epoch fence is already committed. Abort local source streams;
    // late events can no longer write a target binding.
    for (const [turnId, handle] of this.liveRuns) {
      if (handle.taskId !== params.taskId) continue;
      handle.interruptArmed = true;
      handle.controller.abort();
      this.acceptedOpIds.delete(turnId);
      this.askBridge.cancelForTurn(turnId, 'runtime switch');
      this.dropElicitationWaits(turnId);
      this.credentialRegistry?.revoke(turnId);
    }
    this.releaseQueuedTurnsAfterHandoff(params.taskId);
    return {
      ok: true,
      value: {
        operationId,
        boundBackend: targetBackendId,
        ...(boundModel !== undefined ? { boundModel } : {}),
        switchedAt: now,
      },
    };
  }

  send(
    taskId: string,
    content: string,
    options?: { agentContent?: string; clientRequestId?: string },
  ): EngineResult<{ messageId: string; turnId?: string; clientRequestId?: string }> {
    const clientRequestId =
      typeof options?.clientRequestId === 'string' && options.clientRequestId.trim()
        ? options.clientRequestId.trim()
        : undefined;
    const agentContent =
      options?.agentContent && options.agentContent !== content ? options.agentContent : undefined;
    const fingerprint = sendFingerprint({
      kind: 'existing',
      taskId,
      content,
      agentContent,
    });

    if (clientRequestId) {
      const existing = this.store.getFile().sendReceipts?.[clientRequestId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return { ok: false, reason: 'clientRequestId conflict: different payload' };
        }
        const liveTask = this.store.getTask(taskId);
        const handoffBusy =
          liveTask?.handoff?.version === 1 && isActiveHandoffPhase(liveTask.handoff.phase);
        if (
          !handoffBusy &&
          existing.turnId &&
          !this.deferredQueuedTurns.has(existing.turnId)
        ) {
          void this.scheduleTurn(existing.turnId);
        }
        return {
          ok: true,
          value: {
            messageId: existing.messageId,
            turnId: existing.turnId,
            clientRequestId,
          },
        };
      }
    }

    const messageId = randomUUID();
    const now = nowIso(this.clock);
    let queuedTurnId: string | undefined;

    const commit = this.store.commit((draft) => {
      if (clientRequestId) {
        const race = draft.sendReceipts?.[clientRequestId];
        if (race) {
          if (race.fingerprint !== fingerprint) {
            return { ok: false, reason: 'clientRequestId conflict: different payload' };
          }
          queuedTurnId = race.turnId;
          return { ok: true };
        }
      }

      let draftTask = draft.tasks[taskId];
      if (!draftTask) {
        return { ok: false, reason: 'task not found' };
      }
      // Any terminal lifecycle: reopen to open on the same task id, then queue.
      if (isTerminalLifecycle(draftTask.lifecycle)) {
        const reopened = reopenTask(draftTask, { now });
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

      // Host user send is create-and-run for drafts (same policy as startTask).
      if ((draftTask.releaseState ?? 'draft') === 'draft') {
        draftTask = {
          ...draftTask,
          releaseState: 'released',
          releasedAt: now,
          releaseAttemptId: `host:send:${randomUUID()}`,
          revision: draftTask.revision + 1,
          updatedAt: now,
        };
        draft.tasks[taskId] = draftTask;
      }

      // R012: every Enter/send becomes one distinct FIFO turn bound to this message.
      // Concurrent sends while a turn is live/queued still create queued turns
      // (scheduler promotes one-at-a-time). Refuse visibly when a turn cannot be
      // created — never leave free-floating pending messages without turn identity.
      // Phase B: free-form send after failed/interrupted is a normal continuation
      // turn (not retryOf); needs_recovery no longer blocks admission.
      // Active handoff does NOT block send — messages queue; canPromoteTurn gates promote.

      const turnCap = canCreateTurn(draft, taskId, this.getResourceLimits());
      if (!turnCap.ok) {
        return turnCap;
      }

      draft.messages[messageId] = {
        id: messageId,
        taskId,
        role: 'user',
        content,
        ...(agentContent ? { agentContent } : {}),
        state: 'pending',
        createdAt: now,
      };

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
        // Roll back the message so we never persist orphan pending content.
        delete draft.messages[messageId];
        return queue;
      }
      // Admit during handoff; canPromoteTurn refuses until handoff is terminal.
      draft.turns[turnId] = queue.next;
      queuedTurnId = turnId;
      if (clientRequestId) {
        draft.sendReceipts = draft.sendReceipts ?? {};
        draft.sendReceipts[clientRequestId] = {
          clientRequestId,
          fingerprint,
          taskId,
          messageId,
          turnId,
          createdAt: now,
        };
      }
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }

    // Do not schedule while a runtime handoff is still active — release after rebind.
    // canPromoteTurn also refuses during active handoff (without touching MEM030 holds).
    const liveTask = this.store.getTask(taskId);
    const handoffBusy =
      liveTask?.handoff?.version === 1 && isActiveHandoffPhase(liveTask.handoff.phase);

    if (clientRequestId) {
      const receipt = this.store.getFile().sendReceipts?.[clientRequestId];
      if (receipt) {
        if (
          receipt.turnId &&
          !this.deferredQueuedTurns.has(receipt.turnId) &&
          !handoffBusy
        ) {
          void this.scheduleTurn(receipt.turnId);
        }
        return {
          ok: true,
          value: {
            messageId: receipt.messageId,
            turnId: receipt.turnId,
            clientRequestId,
          },
        };
      }
    }

    if (queuedTurnId && !handoffBusy && !this.deferredQueuedTurns.has(queuedTurnId)) {
      void this.scheduleTurn(queuedTurnId);
    }

    return {
      ok: true,
      value: { messageId, turnId: queuedTurnId, ...(clientRequestId ? { clientRequestId } : {}) },
    };
  }

  /**
   * Hard upper bound for queued follow-up message content (edit path).
   * Host boundary may apply a tighter limit; this protects the engine store.
   */
  static readonly MAX_QUEUED_MESSAGE_CHARS = 100_000;

  /**
   * R013: edit the bound pending user message of an undispatched queued turn.
   * Fail-closed once executeTurn's startCommit assigns messages / promotes to running.
   */
  editQueuedTurn(
    taskId: string,
    turnId: string,
    content: string,
  ): EngineResult<{ turnId: string; messageId: string }> {
    if (typeof content !== 'string') {
      return { ok: false, reason: 'invalid content' };
    }
    if (content.length > TaskEngine.MAX_QUEUED_MESSAGE_CHARS) {
      return {
        ok: false,
        reason: `content exceeds ${TaskEngine.MAX_QUEUED_MESSAGE_CHARS} characters`,
      };
    }

    let editedMessageId: string | undefined;
    const commit = this.store.commit((draft) => {
      if (!draft.tasks[taskId]) {
        return { ok: false, reason: 'task not found' };
      }
      const prepared = prepareEditQueuedTurn(taskId, draft.turns[turnId], draft.messages, content);
      if (!prepared.ok) {
        return prepared;
      }
      const message = draft.messages[prepared.next.messageId];
      if (!message) {
        return { ok: false, reason: 'message not found' };
      }
      // Clear stale agentContent: edited display text must drive projectPrompt.
      // Callers that expand mentions on edit can pass agentContent via a future
      // option; plain edit replaces content and drops the prior expansion.
      const { agentContent: _staleAgentContent, ...rest } = message;
      void _staleAgentContent;
      draft.messages[prepared.next.messageId] = {
        ...rest,
        content: prepared.next.content,
      };
      editedMessageId = prepared.next.messageId;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    if (!editedMessageId) {
      return { ok: false, reason: 'message not found' };
    }
    return { ok: true, value: { turnId, messageId: editedMessageId } };
  }

  /**
   * R013: remove an undispatched queued turn and its bound pending user message(s).
   * Does not cancelProcess, does not touch live/settled turns or task lifecycle.
   */
  deleteQueuedTurn(
    taskId: string,
    turnId: string,
  ): EngineResult<{ turnId: string; deletedMessageIds: string[] }> {
    let deletedMessageIds: string[] | undefined;
    const commit = this.store.commit((draft) => {
      if (!draft.tasks[taskId]) {
        return { ok: false, reason: 'task not found' };
      }
      const prepared = prepareDeleteQueuedTurn(taskId, draft.turns[turnId], draft.messages);
      if (!prepared.ok) {
        return prepared;
      }
      for (const messageId of prepared.next.messageIds) {
        delete draft.messages[messageId];
      }
      delete draft.turns[turnId];
      deletedMessageIds = prepared.next.messageIds;
      return { ok: true };
    });

    if (!commit.ok) {
      return { ok: false, reason: commit.detail ?? commit.reason };
    }
    return {
      ok: true,
      value: { turnId, deletedMessageIds: deletedMessageIds ?? [] },
    };
  }

  startTask(
    taskId: string,
    inputs: TurnInput[] = [],
  ): EngineResult<{ turnId: string }> {
    const trust = this.requireWorkspaceTrusted();
    if (!trust.ok) return trust;
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
      // Host recovery / create-and-run: atomically release drafts in the same commit
      // (coordinator MCP cannot start drafts — use release_tasks instead).
      let taskForStart = task;
      if ((task.releaseState ?? 'draft') === 'draft') {
        taskForStart = {
          ...task,
          releaseState: 'released',
          releasedAt: now,
          releaseAttemptId: `host:startTask:${turnId}`,
          revision: task.revision + 1,
          updatedAt: now,
        };
        draft.tasks[taskId] = taskForStart;
      }
      const turnCap = canCreateTurn(draft, taskId, this.getResourceLimits());
      if (!turnCap.ok) {
        return turnCap;
      }
      const result = transitionStartTask(taskForStart, turnsForTask(draft, taskId), {
        turnId,
        now,
        inputs,
        trigger: 'engine',
      });
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
      const turnCap = canCreateTurn(draft, taskId, this.getResourceLimits());
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
    const handle = this.liveRuns.get(turnId);
    if (handle) {
      handle.interruptArmed = true;
      handle.controller.abort();
    }
    return { ok: true, value: undefined };
  }

  retryTurn(
    turnId: string,
    instruction: string,
    options?: { reuseOriginalInputs?: boolean },
  ): EngineResult<{ turnId: string }> {
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
        reuseOriginalInputs: options?.reuseOriginalInputs === true,
      });
      if (!result.ok) {
        return result;
      }
      draft.turns[newTurnId] = result.next;
      if (
        !task.committedSessionId &&
        task.handoff?.version === 2 &&
        task.handoff.continuation.status === 'assigned' &&
        task.handoff.continuation.turnId === oldTurn.id
      ) {
        draft.tasks[taskId] = {
          ...task,
          handoff: {
            ...task.handoff,
            continuation: { status: 'assigned', turnId: newTurnId, assignedAt: now },
          },
        };
      }
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
      this.liveRuns.get(live.id)?.controller.abort();
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
        sealedBy: { kind: 'user' },
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
      this.dropElicitationWaits(live.id);
      // Note: host elicitationBridge.cancelForSession is invoked from extension cancel paths when available.
      this.credentialRegistry?.revoke(live.id);
    }
    // Seal may unblock dependents — rescan queued released turns.
    this.rescanSchedulableTurns();
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
        this.liveRuns.get(turnId)?.controller.abort();
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
          sealedBy: { kind: 'user' },
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
      this.dropElicitationWaits(turnId);
      this.credentialRegistry?.revoke(turnId);
    }
    this.rescanSchedulableTurns();
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
        this.liveRuns.get(turnId)?.controller.abort();
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
          // Clear pending ask_parent now; remote processCancelRequests also cleans.
          draft.tasks[id] = clearPendingParentQuestionOnCancel(draft, task, now);
          continue;
        }
        const result = transitionCancelTask(task, {
          liveTurn: currentLive,
          now,
          sealedBy: { kind: 'user' },
        });
        if (!result.ok) {
          return result;
        }
        draft.tasks[id] = clearPendingParentQuestionOnCancel(draft, result.next.task, now);
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
      this.dropElicitationWaits(turnId);
      this.credentialRegistry?.revoke(turnId);
    }
    this.rescanSchedulableTurns();
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
        // Phase C: orphan live after reload → uncertain (no silent auto-replay).
        draft.turns[turn.id] = {
          ...result.next,
          failureClass: 'uncertain',
          dispatchPhase: draftTurn.dispatchPhase ?? 'prompt_outstanding',
        };
        const task = draft.tasks[draftTurn.taskId];
        // Preserve answer continuations while awaiting parent answer.
        if (task?.attention?.code !== 'awaiting_parent_answer') {
          holdQueuedFollowUpsOnFailure(draft, draftTurn.taskId);
        }
        return { ok: true };
      });
      this.acceptedOpIds.delete(turn.id);
      this.askBridge.cancelForTurn(turn.id, 'reload interrupt');
      this.dropElicitationWaits(turn.id);
      this.credentialRegistry?.revoke(turn.id);
    }

    this.reconcileChildWaits({ schedule: false });
    this.deferReloadQueuedTurns();
    processCancelRequests(this.graphDeps());
  }

  /** Interrupt live source turns in the same commit; queued turns are retagged to target epoch. */
  private applyHandoffTurnPreemption(
    draft: TaskStoreFile,
    taskId: string,
    now: string,
  ): { ok: true } | { ok: false; reason: string } {
    const pending = pendingTurnsForTask(draft, taskId);
    for (const turn of pending) {
      if (turn.status === 'queued') {
        continue;
      } else {
        // Notify remote owners before marking interrupted in the shared store.
        if (
          !this.liveRuns.has(turn.id) &&
          leaseOwnerAlive(this.storePath, turn.id) &&
          !ownsLocalLease(this.storePath, turn.id)
        ) {
          draft.cancelRequests = draft.cancelRequests ?? {};
          draft.cancelRequests[turn.id] = {
            kind: 'interrupt',
            by: 'engine',
            opId: `handoff-preempt-${taskId}-${turn.id}`,
            at: now,
          };
        }
        const interrupted = interruptTurn(turn, { now });
        if (!interrupted.ok) {
          return interrupted;
        }
        draft.turns[turn.id] = {
          ...interrupted.next,
          isCancellation: true,
          interruptConfidence: 'confirmed',
        };
      }
    }
    return { ok: true };
  }

  /** Queued turn ids for a task, oldest-first (sequence then createdAt then id). */
  private queuedTurnIdsInFifoOrder(taskId: string): string[] {
    const file = this.store.getFile();
    return turnsForTask(file, taskId)
      .filter((t) => t.status === 'queued')
      .map((t) => t.id)
      .sort((a, b) => {
        const ta = file.turns[a];
        const tb = file.turns[b];
        if (!ta || !tb) return 0;
        return (
          ta.sequence - tb.sequence ||
          ta.createdAt.localeCompare(tb.createdAt) ||
          ta.id.localeCompare(tb.id)
        );
      });
  }

  /**
   * After handoff becomes terminal (completed/failed), schedule queued turns that
   * are eligible. Does not clear holdAutoPromote — failure-safety holds stay until
   * explicit resume.
   */
  private releaseQueuedTurnsAfterHandoff(taskId: string): void {
    for (const turnId of this.queuedTurnIdsInFifoOrder(taskId)) {
      this.deferredQueuedTurns.delete(turnId);
      void this.scheduleTurn(turnId);
    }
  }

  /** Reload policy for ordinary queued turns; runtime switches need no recovery work. */
  private deferReloadQueuedTurns(): void {
    const file = this.store.getFile();
    const trusted = this.isWorkspaceTrusted();
    for (const turn of Object.values(file.turns)) {
      if (turn.status !== 'queued') continue;
      const task = file.tasks[turn.taskId];
      const releaseState =
        task?.releaseState ?? (Object.values(file.turns).some((t) => t.taskId === turn.taskId) ? 'released' : 'draft');
      // safe_never_dispatched: never running, no prompt dispatch phase (or only pre-queue).
      const safeNeverDispatched =
        !turn.dispatchPhase ||
        turn.dispatchPhase === 'pre_dispatch';
      const safeRetry =
        turn.retryOf &&
        file.turns[turn.retryOf]?.failureClass === 'safe_to_retry';
      if (
        trusted &&
        releaseState === 'released' &&
        (safeNeverDispatched || safeRetry) &&
        turn.holdAutoPromote !== true
      ) {
        // Eligible for auto-resume — do not defer (or clear if safe retry).
        if (safeRetry) {
          this.deferredQueuedTurns.delete(turn.id);
          const retryIndex = Math.max(
            1,
            retryCountOf(
              Object.values(file.turns).filter((t) => t.taskId === turn.taskId),
              turn.id,
            ),
          );
          const baseMs = Math.min(30_000, 250 * 2 ** Math.min(retryIndex - 1, 6));
          const jitter = Math.floor(Math.random() * Math.min(500, baseMs));
          setTimeout(() => {
            void this.scheduleTurn(turn.id);
          }, baseMs + jitter);
        } else if (
          turn.trigger === 'engine' &&
          safeNeverDispatched &&
          !turn.id.endsWith('-continuation') &&
          !turn.id.endsWith('-attention')
        ) {
          // Auto-resume safe released first-turn intents (not wait continuations).
          setTimeout(() => {
            void this.scheduleTurn(turn.id);
          }, 0);
        } else {
          // Continuations and user turns stay deferred until explicit resume / settle.
          this.deferredQueuedTurns.add(turn.id);
        }
      } else {
        this.deferredQueuedTurns.add(turn.id);
      }
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
        const childAttention = new Map<string, { code: string } | undefined>();
        for (const childId of draftTask.wait.taskIds) {
          const child = draft.tasks[childId];
          const lifecycle = child?.lifecycle;
          if (lifecycle) {
            childLifecycles.set(childId, lifecycle);
          }
          if (child?.attention) {
            childAttention.set(childId, { code: child.attention.code });
          }
        }
        const turnCap = canCreateTurn(draft, task.id, this.getResourceLimits());
        if (!turnCap.ok) {
          return { ok: true };
        }
        const result = resolveChildWait(
          draftTask,
          childLifecycles,
          turnsForTask(draft, task.id),
          { continuationTurnId, now, childAttention },
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
      // Schedule terminal continuation and/or attention continuation (W6).
      const updated = this.store.getFile().tasks[task.id];
      const attentionTurnId =
        updated?.wait?.kind === 'children'
          ? updated.wait.attentionContinuationTurnId
          : undefined;
      for (const id of [continuationTurnId, attentionTurnId]) {
        if (!id) continue;
        const cont = this.store.getFile().turns[id];
        if (cont?.status !== 'queued') continue;
        if (schedule) {
          void this.scheduleTurn(id);
        } else {
          this.deferredQueuedTurns.add(id);
        }
      }
    }
  }

  /**
   * Host policy for dependency `onUnsatisfied: fail|skip` — not CLI-driven.
   * Seals dependents when a required dependency finished unsuccessfully.
   * `onUnsatisfied: block` remains open + blocked; publish wakeable attention (P0 ISSUE-6).
   */
  private applyDependencyTerminals(): void {
    const now = nowIso(this.clock);
    this.store.commit((draft) => {
      for (const task of Object.values(draft.tasks)) {
        if (isTerminalLifecycle(task.lifecycle)) continue;
        const outcome = dependencyTerminalOutcome(draft, task.id);
        if (!outcome) {
          // Wakeable attention for block-policy sinks that are permanently unsatisfied.
          if (
            (task.releaseState ?? 'draft') === 'released' &&
            task.lifecycle === 'open' &&
            task.dependencies.some((dep) => {
              if (dep.onUnsatisfied !== 'block') return false;
              const depTask = draft.tasks[dep.taskId];
              if (!depTask || !isTerminalLifecycle(depTask.lifecycle)) return false;
              return depTask.lifecycle !== 'succeeded';
            }) &&
            task.attention?.code !== 'dependency_unsatisfied'
          ) {
            draft.tasks[task.id] = {
              ...task,
              attention: {
                code: 'dependency_unsatisfied',
                message: 'required dependency finished unsuccessfully (block policy)',
                at: now,
              },
              revision: task.revision + 1,
              updatedAt: now,
            };
          }
          continue;
        }
        const live = Object.values(draft.turns).find(
          (t) =>
            t.taskId === task.id &&
            (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
        );
        const terminal = applyDependencyTerminal(task, live, outcome, {
          now,
          error: outcome === 'failed' ? 'dependency unsatisfied' : undefined,
          sealedBy: {
            kind: 'coordinator',
            taskId: task.parentId ?? task.id,
            mode: 'dependency_policy',
          },
        });
        if (terminal.ok) {
          draft.tasks[task.id] = terminal.next.task;
          if (terminal.next.turn) draft.turns[terminal.next.turn.id] = terminal.next.turn;
        }
      }
      return { ok: true };
    });
    // Do not call reconcileChildWaits here: scheduleTurn → applyDependencyTerminals
    // would recurse. Parents wake on the next settle/afterTurnSettled path.
  }

  /**
   * Bounded verify-remediation (verify-gate-loop Phase B/C) — opt-in, per-dependency.
   *
   * Runs in the same engine tick as {@link applyDependencyTerminals}, inside its own
   * commit. Two triggers, both bounded by the SAME remediation budget so the loop
   * ALWAYS terminates (never a permanent block):
   *
   *  1. A `requiredVerdict:'pass'` + `onUnsatisfied:'block'` gate whose producer settled
   *     with a non-pass verdict. If the producer has a PRESENT fail/inconclusive verdict
   *     → create ONE bounded fix task (re-point the gate to the fix, bind the failing
   *     verdict as an untrusted `verify_failure` input). If the producer is terminal with
   *     NO verdict (ISSUE 4) → seal the blocked task `failed` (`verdict_missing`) rather
   *     than fabricate an un-runnable verdict-binding task.
   *  2. A previously-created fix task that has ITSELF terminally failed (ISSUE 3). The
   *     gate now waits on that failed fix forever; re-enter the budget — retry within
   *     budget or seal the blocked task `failed`.
   *
   * Idempotent + bounded: fix ids derive deterministically from (blockedId, uses); once
   * the gate is re-pointed the verdict trigger no longer matches, so a re-run creates no
   * duplicate and never re-bumps `uses`. A graph with no `requiredVerdict` gate and no
   * `remediation.fixTaskId` is a strict no-op (default behavior unchanged).
   */
  private applyVerdictRemediation(): void {
    const now = nowIso(this.clock);
    const turnsToSchedule: string[] = [];
    this.store.commit((draft) => {
      const graph = depGraphFromFile(draft);

      // Seal a blocked task `failed` — an honest terminal, never a hang — attaching a
      // verdict attention and cancelling any pending turn on it.
      const sealBlockedFailed = (
        blocked: MusterTask,
        code: TaskAttentionCode,
        message: string,
        error: string,
      ): void => {
        const live = Object.values(draft.turns).find(
          (t) =>
            t.taskId === blocked.id &&
            (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
        );
        const sealed = applyDependencyTerminal(blocked, live, 'failed', {
          now,
          error,
          sealedBy: {
            kind: 'coordinator',
            taskId: blocked.parentId ?? blocked.id,
            mode: 'dependency_policy',
          },
        });
        if (sealed.ok) {
          draft.tasks[blocked.id] = {
            ...sealed.next.task,
            attention: { code, message, at: now },
          };
          if (sealed.next.turn) draft.turns[sealed.next.turn.id] = sealed.next.turn;
        }
      };

      // Set a non-terminal `verdict_failed` attention (block-with-reason, no seal).
      const setBlockedAttention = (blocked: MusterTask, message: string): void => {
        draft.tasks[blocked.id] = {
          ...blocked,
          revision: blocked.revision + 1,
          updatedAt: now,
          attention: { code: 'verdict_failed', message, at: now },
        };
      };

      // Create ONE bounded fix task R that remediates `upstream`, binding `verify`'s
      // failing verdict as an untrusted `verify_failure` input, re-point `blocked`'s gate
      // (at `depIndex`) to require R to succeed, and bump the bounded budget (recording
      // the failure signature + the new fix id for ISSUE 3 re-entry). Deterministic id
      // keyed by (blockedId, uses) → idempotent; a pre-existing fix id is a strict skip.
      const stageFix = (
        blocked: MusterTask,
        upstream: MusterTask,
        verify: MusterTask,
        depIndex: number,
        uses: number,
        sig: string,
      ): void => {
        const remediationId = deriveEntityId(blocked.id, 'verdict-remediation', String(uses));
        if (draft.tasks[remediationId]) return; // a prior pass already staged this attempt
        const remediationTurnId = deriveEntityId(
          blocked.id,
          'verdict-remediation-turn',
          String(uses),
        );
        const remediationMessageId = deriveEntityId(
          blocked.id,
          'verdict-remediation-msg',
          String(uses),
        );

        const rootId =
          upstream.parentId === null ? remediationId : graph.rootOf(upstream.id) ?? remediationId;
        const goal = `Remediate verification failure for: ${upstream.goal}`;
        // Carry the upstream brief kind + writePaths so resource serialization
        // (git-mutex) still applies to the fix.
        const brief = mergeBriefFromCreate({
          goal,
          brief: { kind: upstream.brief?.kind ?? 'implement' },
          writePaths: upstream.brief?.writePaths,
        });
        // The verdict binding also implies a succeeded/block dependency on the verify
        // task (already terminal-succeeded → immediately satisfied), matching the
        // create_tasks binding wiring.
        const bindings: TaskInputBinding[] = [
          { fromTaskId: verify.id, output: 'verdict', as: 'verify_failure' },
        ];
        const input: CreateTaskInput = {
          id: remediationId,
          role: 'worker',
          goal,
          parentId: upstream.parentId,
          dependencies: [
            { taskId: verify.id, requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
          ],
          backend: upstream.backend,
          model: upstream.model,
          ...(upstream.taskType !== undefined ? { taskType: upstream.taskType } : {}),
          cwd: upstream.cwd,
          capabilities: ['create_child', 'wait_child', 'read_subtree'],
          executionPolicy: { ...upstream.executionPolicy },
          releaseState: 'released',
          brief,
          inputBindings: bindings,
          ...(upstream.claimsGit !== undefined ? { claimsGit: upstream.claimsGit } : {}),
        };
        // skipVerifyAutoGate: the fix DEPENDS on the failed verify task (to run after it)
        // but must NOT require its verdict to pass — that would deadlock the fix and break
        // the loop-termination invariant. The gate re-point below is a direct mutation
        // (not a createTask), so it is likewise never auto-gated.
        const created = createTask(input, { rootId, graph, now, skipVerifyAutoGate: true });
        if (!created.ok) {
          // ISSUE 11 — an internal creation failure (e.g. cross-root verify) is NOT
          // fixable by re-dispatch, so SEAL the blocked task rather than leave it hanging
          // (or thrashing with a re-set attention). Nothing was staged yet.
          sealBlockedFailed(
            blocked,
            'verdict_failed',
            `could not create remediation task: ${created.reason}`,
            `could not create remediation task: ${created.reason}`,
          );
          return;
        }
        draft.tasks[remediationId] = { ...created.next, releasedAt: now };
        const turnCheck = canCreateTurn(draft, remediationId, this.getResourceLimits());
        if (!turnCheck.ok) {
          // ISSUE 11 — roll back the partially-staged task in the SAME commit, then seal
          // (guarantees termination; never a silent delete-and-return hang).
          delete draft.tasks[remediationId];
          sealBlockedFailed(
            blocked,
            'verdict_failed',
            `could not create remediation task: ${turnCheck.reason}`,
            `could not create remediation task: ${turnCheck.reason}`,
          );
          return;
        }
        draft.messages[remediationMessageId] = {
          id: remediationMessageId,
          taskId: remediationId,
          role: 'user',
          content: goal,
          state: 'assigned',
          createdAt: now,
          turnId: remediationTurnId,
        };
        const started = transitionStartTask(draft.tasks[remediationId]!, [], {
          turnId: remediationTurnId,
          now,
          inputs: [{ kind: 'message', messageId: remediationMessageId }],
          trigger: 'engine',
        });
        if (!started.ok) {
          // ISSUE 11 — roll back ALL partial staging (task + message) in the SAME commit,
          // then seal so the blocked task terminates instead of hanging silently.
          delete draft.tasks[remediationId];
          delete draft.messages[remediationMessageId];
          sealBlockedFailed(
            blocked,
            'verdict_failed',
            `could not create remediation task: ${started.reason}`,
            `could not create remediation task: ${started.reason}`,
          );
          return;
        }
        draft.turns[remediationTurnId] = started.next;

        // Neutralize the blocked task's failed verdict gate: it now waits for the FIX
        // task to succeed (drop requiredVerdict). Bump the bounded budget + record the
        // failure signature and fix id so an identical recurrence pauses and a failed
        // fix re-enters the SAME budget (ISSUE 3).
        const nextDeps = blocked.dependencies.slice();
        nextDeps[depIndex] = {
          taskId: remediationId,
          requiredOutcome: 'succeeded',
          onUnsatisfied: 'block',
        };
        draft.tasks[blocked.id] = {
          ...blocked,
          dependencies: nextDeps,
          remediation: { uses: uses + 1, lastFailureSig: sig, fixTaskId: remediationId },
          revision: blocked.revision + 1,
          updatedAt: now,
        };
        turnsToSchedule.push(remediationTurnId);
      };

      for (const blocked of Object.values(draft.tasks)) {
        if (blocked.lifecycle !== 'open') continue;

        // ── ISSUE 3 trigger: a previously-created fix task has ITSELF terminally failed.
        // The gate (onUnsatisfied:'block' on the failed fix) would hang forever, so
        // re-enter the SAME bounded budget: retry within budget or seal `failed`.
        const fixTaskId = blocked.remediation?.fixTaskId;
        if (fixTaskId) {
          const fix = draft.tasks[fixTaskId];
          const fixDepIndex = blocked.dependencies.findIndex(
            (d) => d.taskId === fixTaskId && d.onUnsatisfied === 'block',
          );
          if (
            fix &&
            fixDepIndex >= 0 &&
            isTerminalLifecycle(fix.lifecycle) &&
            fix.lifecycle !== 'succeeded'
          ) {
            const uses = blocked.remediation?.uses ?? 0;
            const sig = failureSignature(
              fix.taskResult?.verdict?.rationale ??
                fix.taskResult?.summary ??
                fix.error ??
                fix.id,
            );
            const identical =
              decideVerdictRetry(blocked.remediation?.lastFailureSig, sig) === 'pause';
            // Budget exhausted OR an identical fix-failure recurred → seal (terminate).
            if (identical || selectRecoveryDecision('verdict-failed', uses) === 'abort') {
              sealBlockedFailed(
                blocked,
                'verdict_failed',
                identical
                  ? 'remediation fix failed identically; auto-remediation stopped'
                  : 'remediation budget exhausted',
                identical
                  ? 'remediation fix failed identically'
                  : 'remediation budget exhausted',
              );
              continue;
            }
            // Within budget: retry against the SAME original verify context, recovered
            // from the failed fix's verdict binding. If it cannot be recovered, seal
            // rather than fabricate an un-runnable task (never hang).
            const verifyId = (fix.inputBindings ?? []).find(
              (b) => b.output === 'verdict',
            )?.fromTaskId;
            const verify = verifyId ? draft.tasks[verifyId] : undefined;
            if (!verify) {
              sealBlockedFailed(
                blocked,
                'verdict_failed',
                'remediation fix failed; cannot reconstruct verify context — sealed',
                'remediation fix failed; verify context missing',
              );
              continue;
            }
            stageFix(blocked, fix, verify, fixDepIndex, uses, sig);
            continue;
          }
        }

        // ── Phase A opt-in verdict-block gate on a settled, non-pass producer. Every
        // other dependency shape is left untouched (Phase A already seals fail/skip;
        // plain blocks wait via the scheduler).
        const depIndex = blocked.dependencies.findIndex((dep) => {
          if (dep.requiredVerdict !== 'pass' || dep.onUnsatisfied !== 'block') return false;
          const producer = draft.tasks[dep.taskId];
          if (!producer || !isTerminalLifecycle(producer.lifecycle)) return false;
          return producer.taskResult?.verdict?.status !== 'pass';
        });
        if (depIndex < 0) continue;
        const dep = blocked.dependencies[depIndex];
        const verify = draft.tasks[dep.taskId]!;

        // ── ISSUE 12: a remediation fix binds the producer's `verdict` output, which
        // auto-wires a `requiredOutcome:'succeeded'` dependency on that producer. That is
        // only satisfiable when the verify task itself SUCCEEDED. A producer that is
        // terminal but NOT succeeded (failed/cancelled/skipped) would yield an
        // un-promotable fix that could never run, so SEAL the blocked task `failed`
        // (honest terminal) instead of fabricating a task that hangs.
        if (verify.lifecycle !== 'succeeded') {
          sealBlockedFailed(
            blocked,
            'verdict_failed',
            'verify task did not succeed; gate cannot pass — coordinator action required',
            'verify task did not succeed',
          );
          continue;
        }

        // ── ISSUE 4/12: producer succeeded but reported NO verdict. A verdict-binding fix
        // would be un-runnable (no `verdict` output to consume), so seal `failed` with a
        // `verdict_missing` attention — honest terminal, no silent hang.
        if (!verify.taskResult?.verdict) {
          sealBlockedFailed(
            blocked,
            'verdict_missing',
            'verify produced no verdict; gate cannot pass — coordinator action required',
            'verify produced no verdict',
          );
          continue;
        }

        const uses = blocked.remediation?.uses ?? 0;
        const sig = failureSignature(
          verify.taskResult?.verdict?.rationale ?? verify.taskResult?.summary ?? verify.id,
        );

        // Anti-thrash: an identical failure recurred → pause (attention, no new task).
        if (decideVerdictRetry(blocked.remediation?.lastFailureSig, sig) === 'pause') {
          // ISSUE 10 — idempotent: if the task already carries this exact pause attention,
          // skip entirely (no new commit, no revision bump) across repeated ticks.
          if (
            blocked.attention?.code === 'verdict_failed' &&
            blocked.attention.message === PAUSE_ATTENTION_MESSAGE
          ) {
            continue;
          }
          draft.tasks[blocked.id] = {
            ...blocked,
            revision: blocked.revision + 1,
            updatedAt: now,
            attention: { code: 'verdict_failed', message: PAUSE_ATTENTION_MESSAGE, at: now },
          };
          continue;
        }

        // Budget exhausted → seal the blocked task `failed` (honest terminal, not a hang).
        if (selectRecoveryDecision('verdict-failed', uses) === 'abort') {
          sealBlockedFailed(
            blocked,
            'verdict_failed',
            'remediation budget exhausted',
            'remediation budget exhausted',
          );
          continue;
        }

        // Identify the work to remediate from the verify task's OWN bindings: the first
        // terminal input-binding producer is the task the verify was checking. Never
        // fabricate work — with no upstream, block-with-reason for the coordinator.
        const upstream = (verify.inputBindings ?? [])
          .map((b) => draft.tasks[b.fromTaskId])
          .find((t): t is MusterTask => !!t && isTerminalLifecycle(t.lifecycle));
        if (!upstream) {
          setBlockedAttention(
            blocked,
            'verify failed; no upstream task to remediate — coordinator action required',
          );
          continue;
        }

        stageFix(blocked, upstream, verify, depIndex, uses, sig);
      }
      return { ok: true };
    });

    // Schedule fix tasks' first turns outside the commit (mirrors create_tasks /
    // drainPendingSendsAfterSettlement). scheduleTurn re-checks trust + readiness.
    for (const turnId of turnsToSchedule) {
      void this.scheduleTurn(turnId);
    }
  }

  /**
   * ISSUE 13 — resolve the host-authorization switch LIVE. When configured with a
   * resolver callback (the host wires one reading `muster.verification.hostRun`), it is
   * called every time so a mid-session toggle is honored. A throwing resolver fails
   * CLOSED (never authorizes host execution).
   */
  private resolveAllowHostVerification(): boolean {
    const value = this.allowHostVerification;
    if (typeof value === 'function') {
      try {
        return value() === true;
      } catch {
        return false;
      }
    }
    return value === true;
  }

  /**
   * Phase C host gate (settle helper). Returns a source-bound HOST verdict when the
   * settling turn belongs to a verify task with `brief.verification.hostRun === true`
   * and carries a `complete` disposition; otherwise `undefined` (Phase A worker
   * self-report is left unchanged). MUST be called OUTSIDE `store.commit` because the
   * runner blocks (spawnSync) for the whole command duration.
   */
  private computeHostVerdictForSettle(turnId: string): TaskVerdict | undefined {
    const file = this.store.getFile();
    const turn = file.turns[turnId];
    const task = turn ? file.tasks[turn.taskId] : undefined;
    if (
      !turn ||
      !task ||
      turn.status !== 'running' ||
      turn.disposition?.kind !== 'complete' ||
      task.brief?.kind !== 'verify' ||
      task.brief.verification?.hostRun !== true
    ) {
      return undefined;
    }
    // ISSUE 1 — host-authorization master switch. Unless the USER explicitly enabled
    // host verification, NEVER execute: fall back to the worker's self-reported verdict
    // (Phase A behavior). Host execution is user-authorized, not agent-triggerable.
    // ISSUE 13 — resolved LIVE here (before any spawn), so disabling the setting
    // mid-session revokes host execution on the very next settle without a reload.
    if (!this.resolveAllowHostVerification()) {
      return undefined;
    }
    // ISSUE 2 — re-check workspace trust IMMEDIATELY before any host spawn (the same
    // trust gate the delegate/scheduler paths use). Untrusted → run NOTHING and emit an
    // `inconclusive` host verdict so the gate is NOT passed (fail-closed, no execution).
    if (!this.isWorkspaceTrusted()) {
      return {
        status: 'inconclusive',
        source: 'host',
        rationale: 'workspace not trusted; host verification skipped',
        at: nowIso(this.clock),
      };
    }
    const cwd = this.resolveHostSnapshot(task).cwd;
    const commands = task.brief.verification.commands ?? [];
    return this.runVerificationGate(commands, cwd).verdict;
  }

  /**
   * Drift invalidation (verify-gate-loop Phase C). A host verdict is bound to the
   * source revision it was produced against; if the working tree has since moved
   * (new commit or dirty edit) the stored `pass` is stale and is downgraded to
   * `inconclusive`, which re-blocks any `requiredVerdict:'pass'` dependent.
   *
   * CRITICAL: git is invoked ONCE per cwd, OUTSIDE `store.commit` (it blocks for the
   * whole subprocess). Cheap pre-scan first — if no producer carries a `source:'host'`
   * passing verdict, this is a strict no-op and git is NEVER shelled, so a graph with
   * no host verdicts keeps today's behavior and perf. Runs before
   * {@link applyDependencyTerminals} in the tick so a re-blocked `onUnsatisfied:'fail'`
   * dependent still seals in the same pass.
   */
  private revalidateVerdicts(): void {
    // ISSUE 2 — never shell git on an untrusted workspace. Skip the drift probe when
    // untrusted (no host spawn); stale verdicts are simply left intact until trust is
    // granted, which re-runs the tick.
    if (!this.isWorkspaceTrusted()) return;
    const file = this.store.getFile();
    // Cheap guard: only a passing host verdict can drift into a re-block. No such
    // verdict → skip entirely (never shell git).
    const candidates = Object.values(file.tasks).filter(
      (t) =>
        t.taskResult?.verdict?.source === 'host' &&
        t.taskResult.verdict.status === 'pass',
    );
    if (candidates.length === 0) return;

    // Compute the current revision ONCE per cwd, outside the commit (git blocks).
    const revisionByCwd = new Map<string, string>();
    const currentRevisionFor = (task: MusterTask): string => {
      const cwd = this.resolveHostSnapshot(task).cwd;
      let rev = revisionByCwd.get(cwd);
      if (rev === undefined) {
        rev = this.computeSourceRevision(cwd);
        revisionByCwd.set(cwd, rev);
      }
      return rev;
    };
    const staleIds: string[] = [];
    for (const task of candidates) {
      const tested = task.taskResult?.verdict?.testedRevision;
      const current = currentRevisionFor(task);
      // Downgrade when the verdict can no longer be trusted as source-bound: either the
      // current tree is UNAVAILABLE (cannot be fingerprinted → cannot confirm it still
      // matches), or drift is positively observable (both tokens known and differing). A
      // `no-git` sentinel on either side cannot prove drift → leave the verdict intact
      // (never thrash on a git-less workspace).
      if (
        tested !== undefined &&
        tested !== NO_GIT_REVISION &&
        current !== NO_GIT_REVISION &&
        (current === SOURCE_REVISION_UNAVAILABLE || tested !== current)
      ) {
        staleIds.push(task.id);
      }
    }
    if (staleIds.length === 0) return;

    const now = nowIso(this.clock);
    this.store.commit((draft) => {
      for (const id of staleIds) {
        const task = draft.tasks[id];
        const verdict = task?.taskResult?.verdict;
        if (!task || !task.taskResult || !verdict) continue;
        if (verdict.source !== 'host' || verdict.status !== 'pass') continue;
        draft.tasks[id] = {
          ...task,
          revision: task.revision + 1,
          updatedAt: now,
          taskResult: {
            ...task.taskResult,
            // ISSUE 9 — bump the RESULT revision on downgrade so downstream pins /
            // readiness observe the change (not just the task revision below).
            revision: task.taskResult.revision + 1,
            verdict: { ...verdict, status: 'inconclusive' },
          },
        };
      }
      return { ok: true };
    });
  }

  private afterTurnSettled(turnId: string): void {
    this.store.commit((draft) => {
      pruneLedgerForTurn(draft, turnId);
      return { ok: true };
    });
    // Apply dependency terminals before child waits so block-policy sinks get
    // attention and parents wake without waiting for an unrelated rescan.
    this.applyDependencyTerminals();
    this.reconcileChildWaits();
    this.drainPendingSendsAfterSettlement(turnId);
  }

  private drainPendingSendsAfterSettlement(settledTurnId: string): void {
    const continuationTurnIds: string[] = [];
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
      // R012: when follow-ups were eagerly queued on send, do not create a
      // second continuation from free-floating pending messages — the scheduler
      // promotes existing queued turns one-at-a-time.
      if (turnsForTask(draft, task.id).some((turn) => turn.status === 'queued')) {
        return { ok: true };
      }
      const pending = pendingUserMessages(draft, task.id);
      if (pending.length === 0) {
        return { ok: true };
      }
      // R012/T02: one free-floating pending message → one continuation turn.
      // Never batch multiple pending messages into a single turn's inputs
      // (projectPrompt would join them into one multi-message backend prompt).
      for (const message of pending) {
        const turnCap = canCreateTurn(draft, task.id, this.getResourceLimits());
        if (!turnCap.ok) {
          break;
        }
        const turnId = randomUUID();
        const inputs: TurnInput[] = [{ kind: 'message', messageId: message.id }];
        const queued = transitionContinueTask(task, turnsForTask(draft, task.id), {
          turnId,
          now,
          inputs,
        });
        if (!queued.ok) {
          break;
        }
        draft.turns[turnId] = queued.next;
        continuationTurnIds.push(turnId);
      }
      return { ok: true };
    });

    if (commit.ok) {
      for (const continuationTurnId of continuationTurnIds) {
        if (!this.deferredQueuedTurns.has(continuationTurnId)) {
          void this.scheduleTurn(continuationTurnId);
        }
      }
    }
  }

  private exceedsTurnLimit(taskId: string, candidateTurnId?: string): boolean {
    const limits = this.getResourceLimits();
    const task = this.store.getTask(taskId);
    if (!task) return true;
    const executionEpoch = task.executionEpoch ?? 1;
    const turns = this.store
      .getTurnsForTask(taskId)
      .filter((turn) => (turn.executionEpoch ?? 1) === executionEpoch);
    const cap = Math.min(limits.maxTurnsPerTask, task.executionPolicy.maxTurns);
    const slotsUsed = turns.filter(
      (t) => t.status !== 'queued' || t.id === candidateTurnId,
    ).length;
    return slotsUsed > cap;
  }

  /**
   * W5: re-evaluate queued released turns after readiness-changing commits
   * (release, lifecycle seal, dependency terminal, settle, trust grant).
   */
  private rescanSchedulableTurns(affectedTaskIds?: readonly string[]): void {
    const file = this.store.getFile();
    const queued = Object.values(file.turns)
      .filter((t) => t.status === 'queued')
      .filter((t) => {
        if (!affectedTaskIds || affectedTaskIds.length === 0) return true;
        return affectedTaskIds.includes(t.taskId);
      })
      .sort(
        (a, b) =>
          a.sequence - b.sequence ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    for (const turn of queued) {
      if (this.deferredQueuedTurns.has(turn.id)) continue;
      void this.scheduleTurn(turn.id);
    }
  }

  private scheduleTurn(turnId: string): Promise<void> {
    // One consistent ResourceLimits snapshot for this scheduling pass.
    const limits = this.getResourceLimits();
    // Phase C: downgrade stale host verdicts (git-guarded, no-op without host
    // verdicts) BEFORE sealing so a re-blocked fail/skip dependent seals this tick.
    this.revalidateVerdicts();
    this.applyDependencyTerminals();
    this.applyVerdictRemediation();
    processCancelRequests(this.graphDeps());
    if (!this.isWorkspaceTrusted()) {
      return Promise.resolve();
    }
    const turn = this.store.getFile().turns[turnId];
    if (turn && this.exceedsTurnLimit(turn.taskId, turnId)) {
      return Promise.resolve();
    }
    if (!tryPromoteTurn(this.store, turnId, limits)) {
      // Persist missing_input attention when readiness blocks pin (W1/W5).
      const file = this.store.getFile();
      const t = file.turns[turnId];
      if (t) {
        const readiness = evaluateTaskReadiness(file, t.taskId);
        if (
          readiness.reasons.some((r) => r.code === 'missing_input_binding') &&
          file.tasks[t.taskId]?.attention?.code !== 'missing_input'
        ) {
          const now = nowIso(this.clock);
          this.store.commit((draft) => {
            const task = draft.tasks[t.taskId];
            if (!task) return { ok: true };
            draft.tasks[t.taskId] = {
              ...task,
              revision: task.revision + 1,
              updatedAt: now,
              attention: {
                code: 'missing_input',
                message: 'missing required input binding',
                at: now,
                sourceTurnId: turnId,
              },
            };
            return { ok: true };
          });
        }
      }
      return Promise.resolve();
    }
    const existing = this.turnPromises.get(turnId);
    if (existing) {
      return existing;
    }
    const promise = this.executeTurn(turnId);
    this.turnPromises.set(turnId, promise);
    void promise.finally(async () => {
      this.turnPromises.delete(turnId);
      const file = this.store.getFile();
      const settled = file.turns[turnId];
      // Success always drains same-task FIFO. Confirmed interrupt with queued
      // follow-ups also drains (interrupt-and-send / Enter-then-Stop). Forced
      // interrupt and failed settlements keep MEM030 freeze.
      const confirmedInterrupt =
        settled?.status === 'interrupted' && settled.interruptConfidence === 'confirmed';
      const allowSameTaskFollowUps =
        settled?.status === 'succeeded' || confirmedInterrupt;
      const settledTaskId = settled?.taskId;

      const afterFlush = this.store.getFile();
      const queued = Object.values(afterFlush.turns)
        .filter((t) => t.status === 'queued')
        .sort(
          (a, b) =>
            a.sequence - b.sequence ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      // Always re-apply dependency terminals after settlement so blocked sinks
      // get attention even when tryPromoteTurn fails and scheduleTurn never runs.
      this.applyDependencyTerminals();
      for (const turn of queued) {
        if (this.deferredQueuedTurns.has(turn.id)) {
          continue;
        }
        if (settledTaskId && turn.taskId === settledTaskId) {
          if (!allowSameTaskFollowUps) continue;
          // Confirmed interrupt path already cleared holds in settleInterrupted.
        } else if (isQueuedTurnAutoPromoteFrozen(afterFlush, turn.taskId, turn.id)) {
          // Unrelated settlement must not thaw pre-failure follow-ups; post-
          // settlement recovery/retry turns are not frozen (see helper).
          continue;
        }
        if (tryPromoteTurn(this.store, turn.id, this.getResourceLimits())) {
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
    // One consistent ResourceLimits snapshot for this execute/promote pass
    // (canPromoteTurn, maxResultBytes projection, later canCreateTurn).
    const limits = this.getResourceLimits();

    // Every fresh backend session gets the same host/runtime/task bootstrap.
    // After a switch, the first real target turn is also a fresh-session boundary.
    const hasPendingContinuation =
      task.handoff?.version === 2 &&
      task.handoff.target.runtimeEpoch === (turn.runtimeEpoch ?? 1) &&
      (task.handoff.continuation.status === 'pending' ||
        (task.handoff.continuation.status === 'assigned' &&
          task.handoff.continuation.turnId === turn.id));
    const needsFreshSessionAssemble =
      turn.resolvedInputs === undefined && (turn.sequence === 1 || hasPendingContinuation);
    if (needsFreshSessionAssemble) {
      await this.prepareHostForFirstTurn();
    }

    const startCommit = this.store.commit((draft) => {
      const draftTurn = draft.turns[turnId];
      const draftTask = draft.tasks[turn.taskId];
      if (!draftTurn || draftTurn.status !== 'queued' || !draftTask) {
        return { ok: false, reason: 'turn is no longer schedulable' };
      }
      const promote = canPromoteTurn(draft, turnId, limits);
      if (!promote.ok) {
        return { ok: false, reason: promote.reason };
      }
      if (isTerminalLifecycle(draftTask.lifecycle)) {
        return { ok: false, reason: 'task is terminal' };
      }
      if ((draftTurn.runtimeEpoch ?? 1) !== (draftTask.runtimeEpoch ?? 1)) {
        return { ok: false, reason: 'turn belongs to a superseded runtime binding' };
      }

      // Single freeze site for a new task or first real turn after a switch.
      // Presence of resolvedInputs (even []) is the durable pin marker — never re-assemble.
      let turnForStart = draftTurn;
      let taskForStart = draftTask;

      const continuation = draftTask.handoff?.version === 2 ? draftTask.handoff : undefined;
      const claimsContinuation =
        continuation?.version === 2 &&
        continuation.target.runtimeEpoch === (draftTurn.runtimeEpoch ?? 1) &&
        (continuation.continuation.status === 'pending' ||
          (continuation.continuation.status === 'assigned' &&
            continuation.continuation.turnId === draftTurn.id));
      const isFreshSessionTurn = draftTurn.sequence === 1 || claimsContinuation;

      if (isFreshSessionTurn && draftTurn.resolvedInputs === undefined) {
        let pins: import('./types').ResolvedInputPin[] = [];
        const bindings = draftTask.inputBindings;
        if (draftTurn.sequence === 1 && bindings && bindings.length > 0) {
          const resolved = resolveInputBindings(bindings, draft.tasks);
          if (!resolved.ok) {
            draft.tasks[draftTask.id] = {
              ...draftTask,
              revision: draftTask.revision + 1,
              updatedAt: now,
              attention: {
                code: 'missing_input',
                message: resolved.reason,
                at: now,
                sourceTurnId: turnId,
              },
            };
            // Leave turn queued; caller detects status !== running.
            return { ok: true };
          }
          pins = resolved.pins;
        }

        const brief =
          draftTask.brief ??
          synthesizeBriefFromGoal(draftTask.goal, draftTask.description);
        const snapshot = this.resolveHostSnapshot(draftTask);
        const tools = [...capabilitiesFor(draftTask)].sort();
        const registryCwd =
          (draftTask.cwd && draftTask.cwd.length > 0 ? draftTask.cwd : undefined) ??
          snapshot.cwd ??
          this.workspaceFolder;
        const registryResult = this.getTaskTypeRegistry
          ? this.getTaskTypeRegistry(registryCwd)
          : undefined;
        // Coordinators always get taskTypes array (empty when unconfigured) for guidance.
        const taskTypesForHost =
          draftTask.role === 'coordinator'
            ? summarizeTaskTypes(
                registryResult ?? {
                  status: 'empty' as const,
                  registry: new Map(),
                  diagnostics: [],
                },
              ).taskTypes
            : undefined;
        // Fail-closed skill injection: resolve the backend's advertised commands
        // (undefined = UNKNOWN backend → optimistic inject). Read-only peek.
        const advertisedCommands = this.getAdvertisedCommands?.(draftTask.backend);
        // Per-backend skill invocation prefix (`/` default, `$` for Codex).
        const skillPrefix = this.getSkillPrefix?.(draftTask.backend) ?? '/';
        // Protected bootstrap/task layers first. Continuation shrinks to the
        // remaining budget so history never displaces the common first-session contract.
        const assembled = assembleFirstTurnPrompt({
          snapshot,
          self: {
            taskId: draftTask.id,
            role: draftTask.role,
            backend: draftTask.backend,
            ...(draftTask.model !== undefined ? { model: draftTask.model } : {}),
            ...(draftTask.parentId ? { parentTaskId: draftTask.parentId } : {}),
            ...(draftTask.goal ? { goal: draftTask.goal } : {}),
          },
          tools,
          taskCwd: draftTask.cwd,
          brief,
          resolvedInputs: pins,
          meta: { taskId: draftTask.id, goal: draftTask.goal },
          ...(taskTypesForHost !== undefined ? { taskTypes: taskTypesForHost } : {}),
          ...(advertisedCommands !== undefined ? { advertisedCommands } : {}),
          skillPrefix,
        });

        if (!assembled.ok) {
          // Budget fail: assign bound messages, fail turn in-commit (no adapter run).
          for (const input of draftTurn.inputs) {
            if (input.kind !== 'message') continue;
            const message = draft.messages[input.messageId];
            if (!message || message.taskId !== turn.taskId) continue;
            if (message.state === 'pending' || message.state === 'assigned') {
              draft.messages[input.messageId] = {
                ...message,
                state: 'complete',
                turnId,
              };
            }
          }
          const started = startProcess(draftTurn, { now });
          if (!started.ok) {
            return started;
          }
          const failed = applyFailedTurn(draftTask, started.next, {
            error: assembled.message,
            retryCount: 0,
            policy: draftTask.executionPolicy,
            onExhausted: 'recover',
            now,
            failureClass: 'unclassified',
          });
          if (!failed.ok) {
            return { ok: false, reason: failed.reason };
          }
          draft.tasks[draftTask.id] = {
            ...failed.next.task,
            attention: {
              code: 'prompt_budget_exceeded',
              message: assembled.message,
              at: now,
              sourceTurnId: turnId,
            },
          };
          draft.turns[turnId] = failed.next.turn;
          return { ok: true };
        }

        const remainingContinuationBudget = Math.max(
          0,
          COMPILED_PROMPT_MAX - assembled.prompt.length - 2,
        );
        const compactContinuation =
          claimsContinuation && remainingContinuationBudget > 0
            ? buildCompactContinuationContext(
                draft,
                draftTask.id,
                continuation,
                Math.min(16_000, remainingContinuationBudget),
              )
            : undefined;
        const compiledPrompt = compactContinuation
          ? `${assembled.prompt}\n\n${compactContinuation}`
          : assembled.prompt;
        const pinned = pinResolvedInputs(draftTurn, pins, compiledPrompt);
        if (!pinned.ok) {
          return { ok: false, reason: pinned.reason };
        }
        turnForStart = pinned.next;
        if (claimsContinuation && continuation.continuation.status === 'pending') {
          taskForStart = {
            ...taskForStart,
            handoff: {
              ...continuation,
              continuation: { status: 'assigned', turnId, assignedAt: now },
            },
          };
          draft.tasks[draftTask.id] = taskForStart;
        }
        // First-turn attention (in-commit): raise skill_unavailable when declared
        // skills are known-absent/invalid on this backend; otherwise clear any
        // prior missing_input / budget attention now that freeze succeeded.
        if (assembled.unavailableSkills.length > 0) {
          taskForStart = {
            ...taskForStart,
            revision: draftTask.revision + 1,
            updatedAt: now,
            attention: {
              code: 'skill_unavailable',
              message: `Skill(s) not available on backend ${draftTask.backend}: ${assembled.unavailableSkills.join(', ')}`,
              at: now,
              sourceTurnId: turnId,
            },
          };
          draft.tasks[draftTask.id] = taskForStart;
        } else if (
          draftTask.attention?.code === 'missing_input' ||
          draftTask.attention?.code === 'prompt_budget_exceeded'
        ) {
          taskForStart = {
            ...taskForStart,
            revision: draftTask.revision + 1,
            updatedAt: now,
            attention: undefined,
          };
          draft.tasks[draftTask.id] = taskForStart;
        }
      }

      // R012: assign only messages already bound to this turn. Do not sweep other
      // pending user messages onto this turn (that batching is removed for FIFO).
      const inputs: TurnInput[] = [...turnForStart.inputs];
      for (const input of inputs) {
        if (input.kind !== 'message') continue;
        const message = draft.messages[input.messageId];
        if (!message || message.taskId !== turn.taskId) continue;
        if (message.state === 'pending' || message.state === 'assigned') {
          draft.messages[input.messageId] = {
            ...message,
            state: 'assigned',
            turnId,
          };
        }
      }

      const withInputs = { ...turnForStart, inputs };
      const started = startProcess(withInputs, { now });
      if (!started.ok) {
        return started;
      }
      // Phase C: durable pre_dispatch until onBeforePrompt flips to prompt_outstanding.
      const frozenDeadline =
        started.next.effectiveRunLimitMs !== undefined && started.next.runDeadlineAt
          ? {
              effectiveRunLimitMs: started.next.effectiveRunLimitMs,
              runDeadlineAt: started.next.runDeadlineAt,
            }
          : resolveTurnRunDeadline(
              draftTask.executionPolicy,
              this.getRunLimitMs(),
              now,
            );
      draft.turns[turnId] = {
        ...started.next,
        ...frozenDeadline,
        dispatchPhase: 'pre_dispatch',
      };
      return { ok: true };
    });

    if (!startCommit.ok) {
      releaseLease(this.storePath, turnId, lease);
      return;
    }
    // Pin gate / budget fail: leave queued or failed without adapter dispatch.
    {
      const afterPin = this.store.getFile().turns[turnId];
      if (!afterPin || afterPin.status !== 'running') {
        if (afterPin?.status === 'failed') {
          // Budget fail: wake parent waits (needs_attention) + prune ledger.
          this.afterTurnSettled(turnId);
        }
        releaseLease(this.storePath, turnId, lease);
        return;
      }
    }

    // Re-pin task/turn after the promote commit so a switch that landed during
    // prepareHostForFirstTurn cannot dispatch the frozen prompt on a stale binding.
    const postStartFile = this.store.getFile();
    const startedTurn = postStartFile.turns[turnId];
    const taskForDispatch = startedTurn
      ? postStartFile.tasks[startedTurn.taskId]
      : undefined;
    if (!startedTurn || !taskForDispatch) {
      releaseLease(this.storePath, turnId, lease);
      return;
    }
    if ((startedTurn.runtimeEpoch ?? 1) !== (taskForDispatch.runtimeEpoch ?? 1)) {
      releaseLease(this.storePath, turnId, lease);
      return;
    }
    if (startedTurn.runDeadlineAt) {
      updateLeaseExpiry(this.storePath, turnId, lease, startedTurn.runDeadlineAt);
    }
    this.safeEmit({
      type: 'turnStart',
      taskId: startedTurn.taskId,
      turnId,
      trigger: startedTurn.trigger,
    });

    const abort = new AbortController();
    // Placeholder backend until factory succeeds.
    let backend: Backend = {
      name: taskForDispatch.backend,
      run: async function* () {},
    };
    this.liveRuns.set(turnId, {
      controller: abort,
      taskId: startedTurn.taskId,
      sessionId: undefined,
    });
    const engineNowMs = Date.parse(nowIso(this.clock));
    const remainingRunMs =
      remainingRunTimeMs(
        startedTurn ?? {},
        Number.isFinite(engineNowMs) ? engineNowMs : Date.now(),
      ) ?? DEFAULT_RUN_LIMIT_MS;
    const cancelPoll = setInterval(() => {
      processCancelRequests(this.graphDeps());
    }, 250);
    // A recovered/frozen deadline may already be expired. Arm a zero-delay
    // watchdog instead of treating 0 as "no timeout" and running forever.
    const turnTimer = setTimeout(() => {
      const timeoutTurn = this.store.getFile().turns[turnId];
      const limitMs = timeoutTurn?.effectiveRunLimitMs ?? remainingRunMs;
      const deadlineAt = timeoutTurn?.runDeadlineAt ?? new Date().toISOString();
      this.store.commit((draft) => {
        const live = draft.turns[turnId];
        if (!live || (live.status !== 'running' && live.status !== 'waiting_user')) {
          return { ok: true };
        }
        draft.turns[turnId] = {
          ...live,
          termination: { kind: 'run_timeout', limitMs, deadlineAt },
        };
        return { ok: true };
      });
      console.info('[muster][task-orch] turn.settle.timeout', {
        taskId: taskForDispatch.id,
        turnId,
        backend: taskForDispatch.backend,
        limitMs,
        deadlineAt,
      });
      abort.abort();
    }, Math.max(0, remainingRunMs));

    let rawOutput = '';
    let observedSessionId: string | undefined;
    let terminalSettled = false;
    // Per-turn render ordering + assistant segmentation (see WEBVIEW-IMPROVEMENT-PLAN §5.1.1).
    // `order` is a per-turn monotonic counter shared by assistant segments, tools,
    // and mid-turn user messages; `(turn.sequence, order)` reconstructs
    // the exact live interleaving.
    let orderCounter = 0;
    const nextOrder = (): number => orderCounter++;
    {
      const liveHandle = this.liveRuns.get(turnId);
      if (liveHandle) liveHandle.nextOrder = nextOrder;
    }
    let currentAssistantSegment: { storeId: string; sourceMessageId: string } | undefined;
    // D035/D041: temporary JsonTurnStreamBuffer (dated post-M017 DELETION_GATE);
    // flush before terminal settle (invariant 9). No legacy repair side path.
    const streamBuffer = createJsonTurnStreamBuffer(this.store);
    /** Tool compositeIds seen this turn (buffer + store) so order is allocated once. */
    const seenToolCalls = new Set<string>();
    const ensureToolOrder = (compositeId: string): number => {
      if (seenToolCalls.has(compositeId)) {
        return this.store.getFile().toolCalls?.[compositeId]?.order ?? 0;
      }
      const existing = this.store.getFile().toolCalls?.[compositeId];
      if (existing) {
        seenToolCalls.add(compositeId);
        return existing.order;
      }
      const order = nextOrder();
      seenToolCalls.add(compositeId);
      return order;
    };
    /**
     * Flush pending stream ops before any terminal settle path.
     * On failure, settles the turn failed and returns true (terminalSettled).
     */
    const flushStreamBeforeTerminal = async (
      failLabel: string,
    ): Promise<{ ok: true } | { ok: false; settled: boolean; message: string }> => {
      const flushed = streamBuffer.flush();
      if (flushed.ok) {
        return { ok: true };
      }
      const message = flushed.detail ?? failLabel;
      const settled = await this.settleFailed(
        turnId,
        message,
        observedSessionId,
        rawOutput,
        backend,
      );
      if (settled) {
        this.safeEmit({ type: 'turnError', taskId: startedTurn.taskId, turnId, message });
      }
      return { ok: false, settled, message };
    };
    let mcpConfigPath: string | undefined;

    try {
      try {
        backend = this.makeBackend(taskForDispatch.backend);
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
            taskId: startedTurn.taskId,
            turnId,
            message: `backend factory failed: ${message}`,
          });
        }
        return;
      }
      const current = this.store.getFile();
      const currentTurn = current.turns[turnId];
      const messages = messageMapFromFile(current);
      const prompt = projectPrompt(currentTurn, messages, current, limits.maxResultBytes);
      console.info('[muster][task-orch] turn.run', {
        taskId: taskForDispatch.id,
        turnId,
        parentId: taskForDispatch.parentId,
        backend: taskForDispatch.backend,
        model: taskForDispatch.model ?? null,
        releaseState: taskForDispatch.releaseState ?? null,
        cwd: taskForDispatch.cwd ?? null,
        trigger: currentTurn?.trigger ?? null,
        promptChars: prompt.length,
      });
      // MCP-enabled turns: optional readiness supervisor + multi-attempt mcpSetup
      // (M017-S06 / D037). prepareAttempt allocates attemptId + remints credentials;
      // awaitReady polls tools/list evidence before onBeforePrompt / prompt.
      const mcpEnabled = this.bridgePort > 0 && !!this.credentialRegistry;
      let attemptId: string | undefined;
      const baseRun = {
        prompt,
        resumeId: taskForDispatch.committedSessionId,
        signal: abort.signal,
        // Run the agent in the task's workspace directory so ACP adapters
        // pass it as session/new|load { cwd } instead of falling back to
        // process.cwd() (wrong dir in a packaged extension).
        cwd: taskForDispatch.cwd,
        model: taskForDispatch.model,
      };
      // Provisional attempt mint so mcpServers array exists for in-place remint.
      if (mcpEnabled) {
        attemptId = randomBytes(8).toString('hex');
      }
      const built = mcpEnabled
        ? buildRunOptionsForTurn(this.graphDeps(), turnId, baseRun, attemptId!)
        : { options: { ...baseRun } };
      mcpConfigPath = built.mcpConfigPath;
      // Ensure mutable shared mcpServers array for prepareAttempt remints.
      if (mcpEnabled && !built.options.mcpServers) {
        built.options.mcpServers = [];
      }

      if (mcpEnabled && this.mcpReadiness) {
        const readiness = this.mcpReadiness;
        const expectedTools = capabilitiesFor(taskForDispatch);
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        built.options.mcpSetup = {
          maxAttempts: 2,
          prepareAttempt: async () => {
            attemptId = randomBytes(8).toString('hex');
            const generation = this.getBridgeGeneration?.() ?? 1;
            readiness.beginAttempt({
              turnId,
              attemptId,
              expectedToolNames: expectedTools,
              bridgeGeneration: generation,
            });
            const reminted = remintTurnMcpForAttempt(
              this.graphDeps(),
              turnId,
              attemptId,
              built.options,
              mcpConfigPath,
            );
            mcpConfigPath = reminted.mcpConfigPath;
            return {};
          },
          awaitReady: async (ctx) => {
            if (!attemptId) {
              return {
                ok: false,
                code: 'missing_evidence',
                message: 'no attemptId for awaitReady',
                retriable: true,
              };
            }
            const generation = this.getBridgeGeneration?.() ?? 1;
            // Cap per-attempt wait so attempt 2 retains setup budget for
            // session/new|load + awaitReady (setupDeadlineAt is absolute in runAcpTurn).
            const totalSetupMs = built.options.setupTimeoutMs ?? 5_000;
            const budgetMs = Math.max(
              100,
              Math.min(Math.floor(totalSetupMs / 3), 5_000),
            );
            const deadline = Date.now() + budgetMs;
            let last = readiness.evaluate(turnId, attemptId, generation);
            while (!last.ok && Date.now() < deadline) {
              if (abort.signal.aborted) {
                return {
                  ok: false,
                  code: 'setup_timeout',
                  message: 'awaitReady aborted',
                  retriable: false,
                };
              }
              await sleep(25);
              last = readiness.evaluate(turnId, attemptId, generation);
              if (last.ok) break;
            }
            if (last.ok) return { ok: true };
            return {
              ok: false,
              code: last.code,
              message: last.message,
              retriable: true,
              sticky: ctx.recoveryMode === 'load',
            };
          },
          disposeAttempt: async () => {
            if (attemptId && this.credentialRegistry) {
              this.credentialRegistry.revokeAttempt(turnId, attemptId);
            }
          },
          buildFreshSessionPrompt: async (ctx) => {
            const fileNow = this.store.getFile();
            const taskNow = fileNow.tasks[taskForDispatch.id];
            const priorOutcomes: string[] = [];
            for (const tr of Object.values(fileNow.turns)) {
              if (tr.taskId !== taskForDispatch.id) continue;
              if (tr.status === 'succeeded' && tr.disposition?.kind === 'complete') {
                priorOutcomes.push(String(tr.disposition.result ?? ''));
              } else if (typeof tr.error === 'string' && tr.error.trim()) {
                priorOutcomes.push(tr.error);
              }
            }
            return buildFreshSessionRecoveryPromptOrThrow({
              goal: taskNow?.goal ?? taskForDispatch.goal,
              brief: taskNow?.brief ?? taskForDispatch.brief,
              priorOutcomes,
              originalPrompt: prompt,
              recoveryReason: ctx.previousFailure?.code ?? 'session_registry_sticky',
            });
          },
        };
      }

      // Phase C: mark prompt_outstanding immediately before side-effecting prompt.
      // Abort the ACP boundary if the durable marker cannot be written.
      built.options = {
        ...built.options,
        onBeforePrompt: async () => {
          // D037 readiness gate: refuse prompt_outstanding when MCP is not ready.
          if (this.mcpReadiness && mcpEnabled && attemptId) {
            const generation = this.getBridgeGeneration?.() ?? 1;
            const readinessEval = this.mcpReadiness.evaluate(turnId, attemptId, generation);
            if (!readinessEval.ok) {
              throw new Error(
                'mcp readiness not ready: ' + readinessEval.code + ': ' + readinessEval.message,
              );
            }
          }
          const commit = this.store.commit((draft) => {
            const liveTurn = draft.turns[turnId];
            const currentTask = liveTurn ? draft.tasks[liveTurn.taskId] : undefined;
            if (!liveTurn || (liveTurn.status !== 'running' && liveTurn.status !== 'waiting_user')) {
              return { ok: false, reason: 'turn is not live for prompt dispatch marker' };
            }
            if (!currentTask || (liveTurn.runtimeEpoch ?? 1) !== (currentTask.runtimeEpoch ?? 1)) {
              return { ok: false, reason: 'runtime binding was superseded before prompt dispatch' };
            }
            if (
              liveTurn.dispatchPhase === 'prompt_outstanding' ||
              liveTurn.dispatchPhase === 'terminal_received'
            ) {
              return { ok: true };
            }
            draft.turns[turnId] = { ...liveTurn, dispatchPhase: 'prompt_outstanding' };
            return { ok: true };
          });
          if (!commit.ok) {
            throw new Error(
              'failed to persist prompt_outstanding dispatch marker: ' +
                (commit.detail ?? commit.reason),
            );
          }
        },
      };

      for await (const event of this.runTurnFn(backend, built.options)) {
        processCancelRequests(this.graphDeps());
        if (terminalSettled) {
          break;
        }
        const eventFile = this.store.getFile();
        const eventTurn = eventFile.turns[turnId];
        const eventTask = eventTurn ? eventFile.tasks[eventTurn.taskId] : undefined;
        if (
          !eventTurn ||
          !eventTask ||
          (eventTurn.status !== 'running' && eventTurn.status !== 'waiting_user') ||
          (eventTurn.runtimeEpoch ?? 1) !== (eventTask.runtimeEpoch ?? 1)
        ) {
          // A runtime switch can settle/interrupt this source turn without
          // waiting for a misbehaving adapter stream. Drain but ignore late data.
          continue;
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
              const liveHandle = this.liveRuns.get(turnId);
              if (liveHandle) liveHandle.sessionId = event.sessionId;
              this.store.commit((draft) => {
                const draftTurn = draft.turns[turnId];
                const draftTask = draftTurn ? draft.tasks[draftTurn.taskId] : undefined;
                if (!draftTurn || !draftTask) {
                  return { ok: false, reason: 'turn not found' };
                }
                if ((draftTurn.runtimeEpoch ?? 1) !== (draftTask.runtimeEpoch ?? 1)) {
                  return { ok: true };
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
            // Buffer only — durable write happens at flush-before-terminal.
            streamBuffer.apply({
              type: 'assistantDelta',
              turnId,
              taskId: eventTurn.taskId,
              segmentId,
              content: event.content,
              order: segmentOrder,
              createdAt: nowIso(this.clock),
            });
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
            streamBuffer.apply({
              type: 'reasoningDelta',
              turnId,
              taskId: eventTurn.taskId,
              content: event.content,
              now: nowIso(this.clock),
            });
            break;
          }
          case 'toolStarted': {
            // A tool closes the current assistant segment (matches live commitStreaming).
            currentAssistantSegment = undefined;
            const compositeId = `${turnId}:${event.toolCallId}`;
            const order = ensureToolOrder(compositeId);
            streamBuffer.apply({
              type: 'toolStarted',
              turnId,
              taskId: eventTurn.taskId,
              compositeId,
              toolCallId: event.toolCallId,
              order,
              name: event.name,
              kind: event.kind,
              input: event.input,
              createdAt: nowIso(this.clock),
            });
            break;
          }
          case 'toolUpdated': {
            const compositeId = `${turnId}:${event.toolCallId}`;
            const order = ensureToolOrder(compositeId);
            streamBuffer.apply({
              type: 'toolUpdated',
              turnId,
              taskId: eventTurn.taskId,
              compositeId,
              toolCallId: event.toolCallId,
              order,
              input: event.input,
              now: nowIso(this.clock),
            });
            break;
          }
          case 'toolCompleted': {
            const compositeId = `${turnId}:${event.toolCallId}`;
            const order = ensureToolOrder(compositeId);
            streamBuffer.apply({
              type: 'toolCompleted',
              turnId,
              taskId: eventTurn.taskId,
              compositeId,
              toolCallId: event.toolCallId,
              order,
              outcome: event.outcome,
              output: event.output,
              error: event.error,
              now: nowIso(this.clock),
            });
            break;
          }
          case 'raw':
            rawOutput += `${event.line}\n`;
            break;
          case 'turnCompleted': {
            const preFlush = await flushStreamBeforeTerminal('stream flush failed before settle');
            if (!preFlush.ok) {
              terminalSettled = preFlush.settled;
              break;
            }
            const successOutcome = await this.settleSuccess(
              turnId,
              observedSessionId,
              rawOutput,
              backend,
            );
            if (successOutcome === 'ok') {
              terminalSettled = true;
              this.safeEmit({ type: 'turnDone', taskId: turn.taskId, turnId });
            } else {
              const failMessage =
                successOutcome === 'missing_session'
                  ? 'target session was not observed after runtime switch'
                  : 'failed to settle successful turn';
              terminalSettled = await this.settleFailed(
                turnId,
                failMessage,
                observedSessionId,
                rawOutput,
                backend,
                successOutcome === 'missing_session'
                  ? { failureClass: 'uncertain' }
                  : undefined,
              );
              if (terminalSettled) {
                this.safeEmit({
                  type: 'turnError',
                  taskId: turn.taskId,
                  turnId,
                  message: failMessage,
                });
              }
            }
            break;
          }
          case 'error':
            if (event.isCancellation) {
              const runTimedOut =
                this.store.getFile().turns[turnId]?.termination?.kind === 'run_timeout';
              // Confirmed only if we armed a local interrupt and adapter did not
              // force-timeout. Missing meta / spontaneous cancel → forced.
              const handle = this.liveRuns.get(turnId);
              const armed = handle?.interruptArmed === true;
              const adapterForced = event.meta?.interruptConfidence === 'forced';
              const confidence: 'confirmed' | 'forced' | 'run_timeout' = runTimedOut
                ? 'run_timeout'
                : armed && !adapterForced
                  ? 'confirmed'
                  : 'forced';
              const preFlush = await flushStreamBeforeTerminal('stream flush failed before interrupt settle');
              if (!preFlush.ok) {
                terminalSettled = preFlush.settled;
                break;
              }
              terminalSettled = await this.settleInterrupted(
                turnId,
                observedSessionId,
                rawOutput,
                backend,
                confidence,
              );
              if (terminalSettled) {
                this.safeEmit({ type: 'turnDone', taskId: turn.taskId, turnId });
              }
            } else {
              const terminalReceived = event.meta?.failureClass === 'terminal_received';
              const mcpSetupExhausted = event.meta?.mcpSetupCode === 'attempts_exhausted';
              const livePhase = this.store.getFile().turns[turnId]?.dispatchPhase;
              const failureClass =
                terminalReceived
                  ? 'terminal_received'
                  : livePhase === 'prompt_outstanding'
                    ? 'uncertain'
                    : livePhase === 'pre_dispatch' || livePhase === undefined || mcpSetupExhausted
                      ? 'safe_to_retry'
                      : 'unclassified';
              const preFlush = await flushStreamBeforeTerminal('stream flush failed before error settle');
              if (!preFlush.ok) {
                terminalSettled = preFlush.settled;
                break;
              }
              terminalSettled = await this.settleFailed(
                turnId,
                event.message,
                observedSessionId,
                rawOutput,
                backend,
                {
                  terminalReceived,
                  failureClass,
                  suppressAutoRetry: mcpSetupExhausted,
                  mcpSetupExhausted,
                },
              );
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
        const preFlush = await flushStreamBeforeTerminal(
          'stream flush failed before missing-terminal settle',
        );
        if (!preFlush.ok) {
          terminalSettled = preFlush.settled;
        } else {
          const runTimedOut = this.store.getFile().turns[turnId]?.termination?.kind === 'run_timeout';
          terminalSettled = runTimedOut
            ? await this.settleInterrupted(turnId, observedSessionId, rawOutput, backend, 'run_timeout')
            : await this.settleFailed(
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
      }
    } catch (error) {
      if (!terminalSettled) {
        // Best-effort flush so partial stream transcript is durable before settle.
        const preFlush = await flushStreamBeforeTerminal(
          'stream flush failed before exception settle',
        );
        if (!preFlush.ok) {
          terminalSettled = preFlush.settled;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          const runTimedOut = this.store.getFile().turns[turnId]?.termination?.kind === 'run_timeout';
          terminalSettled = runTimedOut
            ? await this.settleInterrupted(turnId, observedSessionId, rawOutput, backend, 'run_timeout')
            : await this.settleFailed(turnId, message, observedSessionId, rawOutput, backend);
          if (terminalSettled) {
            this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message });
          }
        }
      }
    } finally {
      clearInterval(cancelPoll);
      clearTimeout(turnTimer);
      // Hard clear elicitation wait tokens — do not soft-resume a settling turn.
      this.dropElicitationWaits(turnId);
      this.liveRuns.delete(turnId);
      this.acceptedOpIds.delete(turnId);
      if (this.credentialRegistry) {
        cleanupTurnResources(this.graphDeps(), turnId, mcpConfigPath);
      }
      this.afterTurnSettled(turnId);
      releaseLease(this.storePath, turnId, lease);
    }
  }

  /**
   * @returns `'ok'` on success settlement, `'missing_session'` when an assigned
   * handoff turn completed without a bindable target session (caller must route
   * through settleFailed), or `false` when settlement could not run.
   */
  private async settleSuccess(
    turnId: string,
    observedSessionId: string | undefined,
    rawOutput: string,
    backend: Backend,
  ): Promise<'ok' | 'missing_session' | false> {
    if (this.settling.has(turnId)) {
      return false;
    }
    this.settling.add(turnId);
    const now = nowIso(this.clock);
    try {
      // Phase C host gate — OPT-IN. When the settling turn is a verify task with
      // `brief.verification.hostRun`, the ENGINE runs the declared commands on the
      // host and OVERRIDES the worker's self-report. CRITICAL: `spawnSync`/git block
      // for the whole command duration, so the gate runs HERE — before/outside the
      // store.commit — and is threaded into the disposition inside the commit. The
      // store lock is never held across the subprocess.
      const hostVerdict = this.computeHostVerdictForSettle(turnId);
      let missingSession = false;
      const commit = this.store.commit((draft) => {
        const turn = draft.turns[turnId];
        const task = turn ? draft.tasks[turn.taskId] : undefined;
        if (!turn || !task || turn.status !== 'running') {
          return { ok: false, reason: 'turn is not running' };
        }
        if ((turn.runtimeEpoch ?? 1) !== (task.runtimeEpoch ?? 1)) {
          return { ok: false, reason: 'turn belongs to a superseded runtime binding' };
        }

        const observed = observedSessionId ?? turn.observedSessionId;
        // Override the worker's self-reported verdict with the host verdict when the
        // gate ran; `buildTaskResultFromSummary` then persists the HOST verdict.
        const withObserved =
          hostVerdict && turn.disposition?.kind === 'complete'
            ? {
                ...turn,
                observedSessionId: observed,
                disposition: { ...turn.disposition, verdict: hostVerdict },
              }
            : { ...turn, observedSessionId: observed };
        // Root owns childOrchestrationSeal policy (W4).
        let rootId = task.id;
        let walk: string | null = task.parentId;
        const seen = new Set<string>();
        while (walk && !seen.has(walk)) {
          seen.add(walk);
          rootId = walk;
          walk = draft.tasks[walk]?.parentId ?? null;
        }
        const rootPolicy = draft.tasks[rootId]?.childOrchestrationSeal;
        const sessionId = selectCommittedSessionId(
          backend,
          { observedSessionId: observed },
          rawOutput,
          task.committedSessionId,
        );
        const assignedContinuation =
          task.handoff?.version === 2 &&
          task.handoff.continuation.status === 'assigned' &&
          task.handoff.continuation.turnId === turnId;
        // Detect missing target session without mutating state here — the caller
        // routes through settleFailed so follow-ups freeze and turnError emits.
        if (assignedContinuation && !sessionId) {
          missingSession = true;
          return { ok: false, reason: 'target session was not observed after runtime switch' };
        }

        const result = applySuccessfulTurn(task, withObserved, {
          now,
          rootChildOrchestrationSeal: rootPolicy,
          sealedBy:
            task.parentId !== null
              ? {
                  kind: 'coordinator',
                  taskId: task.parentId,
                  turnId,
                  mode: 'parent_may_seal_direct',
                }
              : undefined,
        });
        if (!result.ok) {
          return result;
        }

        draft.turns[turnId] = result.next.turn;
        let nextTask: MusterTask = {
          ...result.next.task,
          committedSessionId: sessionId ?? result.next.task.committedSessionId,
        };
        if (
          sessionId &&
          nextTask.handoff?.version === 2 &&
          nextTask.handoff.continuation.status === 'assigned' &&
          nextTask.handoff.continuation.turnId === turnId
        ) {
          nextTask = {
            ...nextTask,
            handoff: {
              ...nextTask.handoff,
              continuation: { status: 'consumed', turnId, consumedAt: now },
            },
          };
        }
        draft.tasks[task.id] = nextTask;

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
      if (commit.ok) {
        const file = this.store.getFile();
        const turn = file.turns[turnId];
        const task = turn ? file.tasks[turn.taskId] : undefined;
        console.info('[muster][task-orch] turn.settle.ok', {
          taskId: turn?.taskId,
          turnId,
          parentId: task?.parentId ?? null,
          lifecycle: task?.lifecycle,
          disposition: turn?.disposition?.kind ?? null,
          sealedBy: task?.sealedBy ?? null,
          attention: task?.attention?.code ?? null,
          hasCompletionCandidate: Boolean(task?.completionCandidate),
          resultChars:
            typeof task?.result === 'string'
              ? task.result.length
              : task?.taskResult?.summary?.length ?? 0,
        });
        return 'ok';
      }
      if (missingSession) {
        console.info('[muster][task-orch] turn.settle.missing_session', { turnId });
        return 'missing_session';
      }
      console.info('[muster][task-orch] turn.settle.commit_failed', {
        turnId,
        reason: commit.detail ?? commit.reason,
      });
      return false;
    } finally {
      this.settling.delete(turnId);
    }
  }

  private async settleInterrupted(
    turnId: string,
    observedSessionId: string | undefined,
    rawOutput: string,
    backend: Backend,
    interruptConfidence: 'confirmed' | 'forced' | 'run_timeout' = 'confirmed',
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
        const observed = observedSessionId ?? turn.observedSessionId;
        const candidate = selectCommittedSessionId(
          backend,
          { observedSessionId: observed },
          rawOutput,
          undefined,
        );
        draft.turns[turnId] = {
          ...result.next,
          observedSessionId: observed,
          candidateSessionId: candidate,
          isCancellation: interruptConfidence !== 'run_timeout',
          ...(interruptConfidence === 'run_timeout' ? {} : { interruptConfidence }),
        };

        const task = draft.tasks[turn.taskId];
        const queuedFollowUps = turnsForTask(draft, turn.taskId).filter(
          (t) => t.status === 'queued',
        );

        let nextTask = task;
        if (interruptConfidence === 'confirmed') {
          // ISSUE-1: bind observed session for first-turn interrupt when unset.
          if (
            nextTask &&
            !nextTask.committedSessionId &&
            (turn.runtimeEpoch ?? 1) === (nextTask.runtimeEpoch ?? 1)
          ) {
            const bindId = observed ?? candidate;
            if (bindId) {
              nextTask = {
                ...nextTask,
                committedSessionId: bindId,
              };
            }
          }
          if (queuedFollowUps.length > 0) {
            // ISSUE-4: clear holds so FIFO can promote after confirmed cut.
            for (const q of queuedFollowUps) {
              if (!q.holdAutoPromote) continue;
              const { holdAutoPromote: _h, ...rest } = q;
              void _h;
              draft.turns[q.id] = rest;
            }
          }
          // Pure Stop (no queued follow-ups): nothing to promote; no freeze needed.
        } else {
          // Forced / unconfirmed: freeze follow-ups; do not commit session.
          holdQueuedFollowUpsOnFailure(draft, turn.taskId);
        }
        // Proven pre-dispatch stop never ran the target prompt — free the
        // one-shot continuation so the next eligible turn can claim it.
        if (
          nextTask &&
          (turn.dispatchPhase === undefined || turn.dispatchPhase === 'pre_dispatch') &&
          nextTask.handoff?.version === 2 &&
          nextTask.handoff.continuation.status === 'assigned' &&
          nextTask.handoff.continuation.turnId === turnId
        ) {
          nextTask = {
            ...nextTask,
            handoff: {
              ...nextTask.handoff,
              continuation: { status: 'pending' },
            },
          };
        }
        if (nextTask && nextTask !== task) {
          draft.tasks[turn.taskId] = nextTask;
        }
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
    opts?: {
      terminalReceived?: boolean;
      failureClass?: import('./types').TurnFailureClass;
      suppressAutoRetry?: boolean;
      mcpSetupExhausted?: boolean;
    },
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
        const failureClass =
          opts?.failureClass ??
          (opts?.terminalReceived
            ? 'terminal_received'
            : turn.dispatchPhase === 'pre_dispatch'
              ? 'safe_to_retry'
              : turn.dispatchPhase === 'prompt_outstanding'
                ? 'uncertain'
                : 'unclassified');
        const result = applyFailedTurn(task, turn, {
          error: errorMessage,
          retryCount: retryCountOf(turns, turn.id),
          policy: task.executionPolicy,
          onExhausted: 'recover',
          now,
          failureClass,
          suppressAutoRetry: opts?.suppressAutoRetry === true || opts?.mcpSetupExhausted === true,
        });
        if (!result.ok) {
          return result;
        }

        const observed = observedSessionId ?? turn.observedSessionId;
        const candidate = selectCommittedSessionId(
          backend,
          { observedSessionId: observed },
          rawOutput,
          undefined,
        );
        draft.turns[turnId] = {
          ...result.next.turn,
          observedSessionId: observed,
          candidateSessionId: candidate,
        };
        // Phase B: bind only terminal_received + nonblank observed session id
        // (never speculative candidate from raw output).
        let nextTask = result.next.task;
        if (opts?.mcpSetupExhausted) {
          nextTask = {
            ...nextTask,
            attention: {
              code: 'mcp_unavailable',
              message: errorMessage,
              at: now,
              sourceTurnId: turnId,
            },
          };
        }
        if (
          opts?.terminalReceived &&
          !nextTask.committedSessionId &&
          (turn.runtimeEpoch ?? 1) === (nextTask.runtimeEpoch ?? 1)
        ) {
          const bindId =
            typeof observed === 'string' && observed.trim().length > 0 ? observed.trim() : undefined;
          if (bindId) {
            nextTask = { ...nextTask, committedSessionId: bindId };
          }
        }
        if (
          failureClass === 'safe_to_retry' &&
          nextTask.handoff?.version === 2 &&
          nextTask.handoff.continuation.status === 'assigned' &&
          nextTask.handoff.continuation.turnId === turnId
        ) {
          nextTask = {
            ...nextTask,
            handoff: {
              ...nextTask.handoff,
              continuation: { status: 'pending' },
            },
          };
        }
        draft.tasks[task.id] = nextTask;
        // Do not hold follow-ups when awaiting parent answer (answer continuation must promote).
        if (nextTask.attention?.code !== 'awaiting_parent_answer') {
          holdQueuedFollowUpsOnFailure(draft, task.id);
        }

        for (const effect of result.effects) {
          if (effect.kind === 'enqueueRetry') {
            const turnCap = canCreateTurn(draft, task.id, this.getResourceLimits());
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
                  instruction: '',
                  now,
                  reuseOriginalInputs: true,
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
        const file = this.store.getFile();
        const turn = file.turns[turnId];
        const task = turn ? file.tasks[turn.taskId] : undefined;
        console.info('[muster][task-orch] turn.settle.failed', {
          taskId: turn?.taskId,
          turnId,
          parentId: task?.parentId ?? null,
          lifecycle: task?.lifecycle,
          error: errorMessage.slice(0, 300),
          failureClass: opts?.failureClass ?? null,
        });
        const retryTurnEntry = Object.values(this.store.getFile().turns).find(
          (turn) => turn.retryOf === turnId && turn.status === 'queued',
        );
        if (retryTurnEntry) {
          // Bounded exponential backoff + jitter for safe auto-retries (Phase C).
          // Depth is measured from the new retry turn's chain, not the failed predecessor alone.
          const retryIndex = Math.max(
            1,
            retryCountOf(
              Object.values(this.store.getFile().turns).filter(
                (t) => t.taskId === retryTurnEntry.taskId,
              ),
              retryTurnEntry.id,
            ),
          );
          const baseMs = Math.min(30_000, 250 * 2 ** Math.min(retryIndex - 1, 6));
          const jitter = Math.floor(Math.random() * Math.min(500, baseMs));
          const delayMs = baseMs + jitter;
          setTimeout(() => {
            void this.scheduleTurn(retryTurnEntry.id);
          }, delayMs);
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
