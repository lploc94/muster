import { randomBytes, randomUUID } from 'crypto';
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
  projectChildResults,
  remintTurnMcpForAttempt,
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
import { canCreateTurn, DEFAULT_RESOURCE_LIMITS, effectiveTurnCap, type ResourceLimits } from './limits';
import {
  DEFAULT_RUN_LIMIT_MS,
  resolveTaskExecutionPolicy,
  resolveTurnRunDeadline,
  remainingRunTimeMs,
} from './execution-policy';
import { TASK_ERROR_MAX_BYTES, TASK_RESULT_MAX_BYTES } from './content-limits';
import { selectCommittedSessionId } from './session-select';
import type { TaskReadPort } from './store-port';
import {
  deriveResourceClaimKeys,
  type TaskRepository,
} from './repository';
import {
  RepositoryProjection,
  withRepositoryProjection,
  type RepositoryCommitContext,
} from './repository-projection';
import {
  TranscriptStreamBatcher,
  type StreamBatchPayload,
  type StreamFlushResult,
} from './transcript-stream-batcher';
import { createTranscriptStreamPersist } from './transcript-stream-persist';
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
  PersistedReasoning,
  PersistedToolCall,
  TaskAttentionCode,
  TaskCapability,
  TaskDependency,
  TaskExecutionPolicy,
  TaskInputBinding,
  TaskLifecycleState,
  TaskMessage,
  TaskRole,
  EngineProjection,
  TaskTurn,
  TaskVerdict,
  TurnDisposition,
  TurnInput,
} from './types';

/** Extra lifetime after the frozen run deadline before a runtime claim is reclaimable. */
export const LEASE_CLEANUP_BUFFER_MS = 60_000;

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
  repository: TaskRepository;
  workspaceId: string;
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
  /**
   * Host post-commit hook after a successful durable repository.execute and
   * projection refresh. Used to publish one workspacePatchBatch per revision.
   */
  onAfterCommit?: (ctx: RepositoryCommitContext) => void | Promise<void>;
}

export type EngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

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

function cloneEngineProjection(file: EngineProjection): EngineProjection {
  return structuredClone(file);
}

/** Non-empty backend/model label: no control bytes, length-capped. */
function normalizeRuntimeLabel(value: string, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
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
  file?: EngineProjection,
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

function messageMapFromFile(file: EngineProjection): Map<string, TaskMessage> {
  return new Map(Object.entries(file.messages));
}

function depGraphFromFile(file: EngineProjection): DepGraph {
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

function turnsForTask(file: EngineProjection, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

function childIdsOf(file: EngineProjection, parentId: string): string[] {
  return Object.values(file.tasks)
    .filter((task) => task.parentId === parentId)
    .map((task) => task.id)
    .sort();
}

function descendantIds(file: EngineProjection, rootId: string): string[] {
  const result: string[] = [];
  const stack = [...childIdsOf(file, rootId)].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...childIdsOf(file, id).reverse());
  }
  return result;
}

function pendingTurnsForTask(file: EngineProjection, taskId: string): TaskTurn[] {
  return turnsForTask(file, taskId).filter(
    (turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user',
  );
}

function pendingUserMessages(file: EngineProjection, taskId: string): TaskMessage[] {
  return Object.values(file.messages)
    .filter((message) => message.taskId === taskId && message.role === 'user' && message.state === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function isQueuedTurnAutoPromoteFrozen(
  file: EngineProjection,
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

export function viewStatusFromDraft(draft: EngineProjection, taskId: string) {
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
  private readonly store: TaskReadPort | RepositoryProjection;
  private readonly repository: TaskRepository;
  private readonly workspaceId: string;
  private readonly makeBackend: (name: string) => Backend;
  private readonly runTurnFn: (backend: Backend, options: RunOptions) => AsyncIterable<NormalizedEvent>;
  private readonly limits: DispositionLimits;
  private readonly clock?: () => string;
  /** Stable owner identity for repository runtime claims in this extension host. */
  private readonly runtimeOwnerId: string;
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
      /** Cancel-request poll interval — cleared synchronously on terminal quiesce. */
      cancelPoll?: ReturnType<typeof setInterval>;
      /** Run-deadline watchdog — cleared synchronously on terminal quiesce. */
      turnTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  /** Queued turns preserved on reload — start only via resumeQueuedTurn. */
  private readonly deferredQueuedTurns = new Set<string>();
  private readonly turnPromises = new Map<string, Promise<void>>();
  private workflowDeadlineTimer?: ReturnType<typeof setInterval>;
  private workflowDeadlineReapRunning = false;
  private shuttingDown = false;
  /** Terminal storage latch: zero repository writes after this (distinct from graceful shutdown). */
  private storageTerminal = false;
  /**
   * Maintenance hold (P5-W5): reject new user/tool mutations while backup/reset
   * is in progress. Distinct from storageTerminal (no hard abort of live runs).
   */
  private maintenanceHold = false;
  private readonly pendingAskPromises = new Map<string, { promise: Promise<Answers>; fingerprint: string }>();
  private settling = new Set<string>();
  /** Live executeTurn closures used to settle unobserved timer flush failures. */
  private readonly streamFailureHandlers = new Map<
    string,
    (message: string) => Promise<void>
  >();
  /** Per-turn assistant/reasoning coalescer (P4-W8). */
  private readonly streamBatcher: TranscriptStreamBatcher;

  private constructor(
    config: TaskEngineConfig,
    store: TaskReadPort | RepositoryProjection,
    repository: TaskRepository,
  ) {
    this.store = store;
    this.workspaceId = config.workspaceId;
    this.repository = repository;
    this.makeBackend = config.makeBackend;
    this.runTurnFn = config.runTurn ?? defaultRunTurn;
    this.limits = config.dispositionLimits ?? DEFAULT_LIMITS;
    this.clock = config.clock;
    this.runtimeOwnerId = `${process.pid}:${randomUUID()}`;
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
    this.streamBatcher = new TranscriptStreamBatcher({
      persist: createTranscriptStreamPersist({
        repository: this.repository,
        workspaceId: this.workspaceId,
        isStorageTerminal: () => this.storageTerminal,
      }),
      onTimerFlushError: (turnId, message) =>
        this.reportStreamFlushFailure(turnId, message),
    });
  }

  /** Flush pending assistant/reasoning for one task before focus teardown. */
  async flushPendingTranscriptForTask(taskId: string): Promise<void> {
    await this.requireSuccessfulFlushes(await this.streamBatcher.flushTask(taskId));
  }

  /** Flush all pending stream batches (deactivate / global barriers). */
  async flushAllPendingTranscript(): Promise<void> {
    await this.requireSuccessfulFlushes(await this.streamBatcher.flushAll());
  }

  /**
   * Awaitable extension-host teardown. Stop new dispatch, persist the current
   * windows, abort adapters, then perform a final flush for deltas that raced
   * the first barrier.
   */
  async shutdown(): Promise<void> {
    if (this.storageTerminal) {
      // Already hard-quiesced for terminal storage — do not flush/settle.
      return;
    }
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.workflowDeadlineTimer !== undefined) {
      clearInterval(this.workflowDeadlineTimer);
      this.workflowDeadlineTimer = undefined;
    }
    let flushError: unknown;
    try {
      await this.flushAllPendingTranscript();
    } catch (error) {
      flushError = error;
    }

    for (const handle of this.liveRuns.values()) {
      handle.controller.abort();
    }

    if (this.turnPromises.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.turnPromises.values()]).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    try {
      await this.flushAllPendingTranscript();
    } catch (error) {
      flushError ??= error;
    } finally {
      this.streamBatcher.disposeAll();
    }
    if (flushError) throw flushError;
  }

  /**
   * Hard quiesce after terminal storage (corrupt / not_a_database / protocol).
   * Aborts adapters, cancels asks/elicitation, clears timers and stream buffers,
   * and performs ZERO repository flush/settlement/release/afterTurnSettled writes.
   * Distinct from {@link shutdown} which is graceful and may write.
   */
  quiesceForTerminalStorage(): void {
    if (this.storageTerminal) return;
    // Latch first so every subsequent path sees terminal immediately.
    this.storageTerminal = true;
    this.shuttingDown = true;
    if (this.workflowDeadlineTimer !== undefined) {
      clearInterval(this.workflowDeadlineTimer);
      this.workflowDeadlineTimer = undefined;
    }
    for (const handle of this.liveRuns.values()) {
      if (handle.cancelPoll !== undefined) {
        clearInterval(handle.cancelPoll);
        handle.cancelPoll = undefined;
      }
      if (handle.turnTimer !== undefined) {
        clearTimeout(handle.turnTimer);
        handle.turnTimer = undefined;
      }
      try {
        handle.controller.abort();
      } catch {
        // best-effort
      }
    }
    this.liveRuns.clear();
    this.streamFailureHandlers.clear();
    this.deferredQueuedTurns.clear();
    this.settling.clear();
    try {
      this.streamBatcher.disposeAll();
    } catch {
      // best-effort
    }
    for (const turnId of [...this.turnPromises.keys()]) {
      try {
        this.askBridge.cancelForTurn(turnId, 'storage terminal');
      } catch {
        // best-effort
      }
      try {
        this.dropElicitationWaits(turnId);
      } catch {
        // best-effort
      }
    }
    this.pendingAskPromises.clear();
    this.turnPromises.clear();
  }

  /** True after {@link quiesceForTerminalStorage}. Live paths must skip repository writes. */
  isStorageTerminal(): boolean {
    return this.storageTerminal;
  }

  /**
   * Block new host/tool mutations during developer reset maintenance (P5-W5).
   * Does not abort live runs; shutdown/quiesce still drain them.
   */
  beginMaintenanceHold(): void {
    this.maintenanceHold = true;
  }

  endMaintenanceHold(): void {
    this.maintenanceHold = false;
  }

  isMaintenanceHold(): boolean {
    return this.maintenanceHold;
  }

  private rejectIfMaintenanceHold(): EngineResult<never> | undefined {
    if (this.storageTerminal) {
      return { ok: false, reason: 'storage terminal' };
    }
    if (this.maintenanceHold || this.shuttingDown) {
      return { ok: false, reason: 'storage maintenance in progress' };
    }
    return undefined;
  }

  private async reportStreamFlushFailure(turnId: string, message: string): Promise<void> {
    if (this.storageTerminal) return;
    await this.streamFailureHandlers.get(turnId)?.(message);
  }

  private async requireSuccessfulFlushes(results: readonly StreamFlushResult[]): Promise<void> {
    const failures = results.filter(
      (result): result is Extract<StreamFlushResult, { ok: false }> => !result.ok,
    );
    for (const failure of failures) {
      await this.reportStreamFlushFailure(failure.turnId, failure.message);
    }
    if (failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join('; '));
    }
  }

  private async flushTurnBoundary(turnId: string): Promise<StreamFlushResult> {
    const result = await this.streamBatcher.flushTurn(turnId);
    if (!result.ok) {
      await this.reportStreamFlushFailure(turnId, result.message);
    }
    return result;
  }

  /**
   * Acquire the durable per-turn cross-process ownership claim.
   * Domain contention (changed=false) is normal. Storage busy/full/etc. must not
   * collapse into false — rethrow so the scheduler can fail-clear with a signal
   * instead of leaving a queued turn silent (P5-W1 finding 5).
   */
  private async claimRuntimeTurn(turnId: string, expiresAt: string): Promise<boolean> {
    if (this.storageTerminal) return false;
    const now = nowIso(this.clock);
    const result = await this.repository.execute({
      kind: 'claimRuntime', workspaceId: this.workspaceId, turnId,
      ownerId: this.runtimeOwnerId, claimedAt: now, heartbeatAt: now, expiresAt,
    });
    if (this.storageTerminal) return false;
    return result.changed === true;
  }

  private async heartbeatRuntimeTurn(turnId: string, expiresAt: string): Promise<boolean> {
    if (this.storageTerminal) return false;
    const now = nowIso(this.clock);
    const result = await this.repository.execute({
      kind: 'heartbeatRuntime', workspaceId: this.workspaceId, turnId,
      ownerId: this.runtimeOwnerId, heartbeatAt: now, expiresAt,
    });
    if (this.storageTerminal) return false;
    return result.changed === true;
  }

  private async releaseRuntimeTurn(turnId: string): Promise<void> {
    if (this.storageTerminal) return;
    try {
      await this.repository.execute({
        kind: 'releaseRuntime', workspaceId: this.workspaceId, turnId,
        ownerId: this.runtimeOwnerId,
      });
    } catch {
      // Best-effort cleanup; expiry makes abandoned claims reclaimable.
    }
  }

  private runtimeClaimAlive(turnId: string): boolean {
    const claim = this.store.getFile().runtimeClaims?.[turnId];
    return !!claim && Number.isFinite(Date.parse(claim.expiresAt)) && Date.parse(claim.expiresAt) > Date.parse(nowIso(this.clock));
  }

  private ownsRuntimeClaim(turnId: string): boolean {
    return this.store.getFile().runtimeClaims?.[turnId]?.ownerId === this.runtimeOwnerId;
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
      repository: this.repository,
      workspaceId: this.workspaceId,
      makeBackend: this.makeBackend,
      credentials,
      askBridge: this.askBridge,
      bridgePort: this.bridgePort,
      // Live passthrough so each tool-command pass re-snapshots caps (M016-S01).
      getResourceLimits: () => this.getResourceLimits(),
      getRunLimitMs: this.getRunLimitMs,
      clock: this.clock,
      liveRuns: this.liveRuns,
      flushPendingTranscript: async (turnId) => {
        const result = await this.flushTurnBoundary(turnId);
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      },
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
      leaseOwnerAlive: (turnId) => this.runtimeClaimAlive(turnId),
      ownsLease: (turnId) => this.ownsRuntimeClaim(turnId),
      runtimeOwnerId: this.runtimeOwnerId,
      writeCancelRequest: (turnId, kind, by, opId, sealedBy) => {
        void this.repository.execute({
          kind: 'putCancelRequest',
          workspaceId: this.workspaceId,
          turnId,
          request: {
            kind,
            by,
            opId,
            at: nowIso(this.clock),
            ...(sealedBy ? { sealedBy } : {}),
          },
        }).catch(() => undefined);
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
  async beginElicitationWait(
    sessionId: string,
    promptId: string,
  ): Promise<{ turnId: string } | undefined> {
    const live = this.findLiveTurnBySessionId(sessionId);
    if (!live) return undefined;
    if (!this.mayDirectAskUser(sessionId)) return undefined;
    const current = await this.repository.getTurn(live.turnId);
    if (!current) return undefined;
    const expectedStatus = current.status === 'waiting_user'
      ? 'waiting_user'
      : current.status === 'running'
        ? 'running'
        : undefined;
    if (!expectedStatus) return undefined;
    const next = current.status === 'waiting_user'
      ? current
      : current.status === 'running'
        ? registerAsk(current)
        : undefined;
    if (!next || ('ok' in next && !next.ok)) return undefined;
    const turn = 'next' in next ? next.next : next;
    const write = await this.repository.execute({
      kind: 'recordAsk', workspaceId: this.workspaceId, turn,
      expectedRuntimeEpoch: current.runtimeEpoch ?? 1,
    });
    if (!write.changed) return undefined;
    let set = this.elicitationWaitTokens.get(live.turnId);
    if (!set) {
      set = new Set();
      this.elicitationWaitTokens.set(live.turnId, set);
    }
    set.add(promptId);
    return { turnId: live.turnId };
  }

  /** Soft release: resume only if this token existed and set is now empty. */
  async endElicitationWait(turnId: string, promptId: string): Promise<void> {
    const set = this.elicitationWaitTokens.get(turnId);
    // Hard-cleared turns have no set — do not revive.
    if (!set || !set.has(promptId)) return;
    set.delete(promptId);
    if (set.size > 0) return;
    this.elicitationWaitTokens.delete(turnId);
    const current = await this.repository.getTurn(turnId);
    if (!current || current.status !== 'waiting_user') return;
    const resumed = submitAnswer(current);
    if (!resumed.ok) return;
    await this.repository.execute({
      kind: 'answerAsk', workspaceId: this.workspaceId, turn: resumed.next,
      expectedRuntimeEpoch: current.runtimeEpoch ?? 1,
    }).catch(() => undefined);
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
  async registerAgentAsk(
    sessionId: string,
    questions: import('../bridge/ask-bridge').Question[],
    deadlineMs: number,
  ):
    Promise<
    | { ok: true; ref: AskRef; promise: Promise<Answers> }
    | { ok: false; reason: string }
    > {
    const live = this.findLiveTurnBySessionId(sessionId);
    if (!live) {
      return { ok: false, reason: 'no live turn for session' };
    }
    if (questions.length === 0) {
      return { ok: false, reason: 'questions required' };
    }
    // Non-root tasks must not reach the user by default (ask_parent path).
    const liveTask = await this.repository.getTask(live.taskId);
    if (liveTask?.parentId) {
      return {
        ok: false,
        reason: 'direct user elicitation denied for non-root task; use ask_parent',
      };
    }
    const askId = this.askBridge.generateAskId();
    const ref: AskRef = { taskId: live.taskId, turnId: live.turnId, askId };
    const turn = await this.repository.getTurn(ref.turnId);
    if (!turn) return { ok: false, reason: 'turn not found' };
    const expectedStatus = turn.status === 'waiting_user'
      ? 'waiting_user'
      : turn.status === 'running'
        ? 'running'
        : undefined;
    if (!expectedStatus) return { ok: false, reason: 'turn is not live' };
    const next = turn.status === 'waiting_user'
      ? turn
      : turn.status === 'running'
        ? registerAsk(turn)
        : undefined;
    if (!next || ('ok' in next && !next.ok)) return { ok: false, reason: 'turn is not live' };
    const write = await this.repository.execute({
      kind: 'recordAsk', workspaceId: this.workspaceId,
      turn: 'next' in next ? next.next : next,
      expectedRuntimeEpoch: turn.runtimeEpoch ?? 1,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'turn is not live' };
    const promise = this.askBridge.register(ref, questions, deadlineMs);
    return { ok: true, ref, promise };
  }

  async submitAskAnswer(ref: AskRef, answers: Answers): Promise<EngineResult<void>> {
    if (!this.askBridge.hasPending(ref)) {
      return { ok: false, reason: 'no matching pending ask' };
    }
    const turn = await this.repository.getTurn(ref.turnId);
    if (!turn || turn.status !== 'waiting_user') return { ok: false, reason: 'turn is not waiting for user' };
    const resumed = submitAnswer(turn);
    if (!resumed.ok) return resumed;
    const write = await this.repository.execute({
      kind: 'answerAsk', workspaceId: this.workspaceId, turn: resumed.next,
      expectedRuntimeEpoch: turn.runtimeEpoch ?? 1,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'turn is not waiting for user' };
    if (!this.askBridge.submit(ref, answers)) {
      return { ok: false, reason: 'ask disappeared before submit' };
    }
    return { ok: true, value: undefined };
  }

  async cancelAskTurn(ref: AskRef): Promise<EngineResult<void>> {
    if (!this.askBridge.hasPending(ref)) {
      return { ok: false, reason: 'no matching pending ask' };
    }
    // Soft dismiss: commit the waiting_user → resumed transition first, then
    // reject the pending ask so MCP/agent paths can continue (cancelled).
    // Cancel only after commit so a failed commit leaves the ask retryable.
    const turn = await this.repository.getTurn(ref.turnId);
    if (!turn || turn.status !== 'waiting_user') return { ok: false, reason: 'turn is not waiting for user' };
    const resumed = submitAnswer(turn);
    if (!resumed.ok) return resumed;
    const write = await this.repository.execute({
      kind: 'answerAsk', workspaceId: this.workspaceId, turn: resumed.next,
      expectedRuntimeEpoch: turn.runtimeEpoch ?? 1,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'turn is not waiting for user' };
    this.askBridge.cancel(ref, 'user dismissed ask');
    return { ok: true, value: undefined };
  }

  async handleToolCall(
    ctx: import('../bridge/credentials').CredentialContext,
    _tool: string,
    command: ToolCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    if (this.storageTerminal) return { ok: false, error: 'storage terminal' };
    if (this.maintenanceHold || this.shuttingDown) {
      return { ok: false, error: 'storage maintenance in progress' };
    }
    // Test/host callers can deliver a tool invocation in the same tick that a
    // queued first turn is being promoted. Give the durable promotion a short
    // chance to publish `running`; never wait for the backend turn itself.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const callerTurn = await this.repository.getTurn(ctx.turnId);
      if (!callerTurn || callerTurn.status === 'running' || callerTurn.status === 'waiting_user') break;
      if (callerTurn.status !== 'queued') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
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

  /** Repository-only constructor. No JSON file is created or used. */
  static async loadAsync(config: TaskEngineConfig): Promise<TaskEngine> {
    await config.repository.execute({
      kind: 'reapWorkflowTimeouts',
      workspaceId: config.workspaceId,
      now: nowIso(config.clock),
    });
    const projection = await RepositoryProjection.load(config.repository, config.workspaceId);
    const repository = withRepositoryProjection(config.repository, projection, {
      onAfterCommit: config.onAfterCommit,
    });
    const engine = new TaskEngine(config, projection, repository);
    await engine.reconcileReloadFromRepository();
    engine.startWorkflowDeadlineReaper();
    return engine;
  }

  private startWorkflowDeadlineReaper(): void {
    const timer = setInterval(() => {
      if (this.shuttingDown || this.storageTerminal || this.workflowDeadlineReapRunning) return;
      this.workflowDeadlineReapRunning = true;
      void this.repository.execute({
        kind: 'reapWorkflowTimeouts',
        workspaceId: this.workspaceId,
        now: nowIso(this.clock),
      }).catch((error) => {
        console.error('[muster][task-orch] workflow deadline reaper failed', error);
      }).finally(() => {
        this.workflowDeadlineReapRunning = false;
      });
    }, 30_000);
    timer.unref?.();
    this.workflowDeadlineTimer = timer;
  }

  /** Host read model backed by the same projection refreshed after every durable write. */
  getReadModel(): TaskReadPort {
    return this.store;
  }

  /**
   * Mutable projection used by external multi-window reconciliation. Same object
   * as {@link getReadModel} when the engine is repository-backed.
   */
  getProjection(): RepositoryProjection | undefined {
    return this.store instanceof RepositoryProjection ? this.store : undefined;
  }

  /** Repository wrapper whose successful writes refresh {@link getReadModel}. */
  getRepository(): TaskRepository {
    return this.repository;
  }

  async startNewTask(params: {
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
  }): Promise<EngineResult<{ taskId: string; messageId: string; turnId: string; clientRequestId?: string }>> {
    const hold = this.rejectIfMaintenanceHold();
    if (hold) return hold;
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
      const existing = await this.repository.getSendReceipt(clientRequestId);
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

    // Root creation has no dependencies, so it never needs a materialized graph
    // snapshot. Keep this intentionally tiny graph contract rather than reaching
    // into EngineProjection for a callback mutation.
    const created = createTask(input, {
      rootId: taskId,
      graph: { rootOf: () => undefined, dependsOn: () => [] },
      now,
    });
    if (!created.ok) return created;
    const task: MusterTask = { ...created.next, releasedAt: now };
    const message: TaskMessage = {
      id: messageId,
      taskId,
      role: 'user',
      content: messageContent,
      ...(agentContent ? { agentContent } : {}),
      state: 'pending',
      createdAt: now,
    };
    const queued = transitionStartTask(task, [], {
      turnId,
      now,
      inputs: [{ kind: 'message', messageId }],
    });
    if (!queued.ok) return queued;
    try {
      const write = await this.repository.execute({
        kind: 'createRootAndInitialTurn',
        workspaceId: this.workspaceId,
        task,
        message,
        turn: queued.next,
        ...(clientRequestId
          ? {
              receipt: {
                clientRequestId,
                fingerprint,
                taskId,
                messageId,
                turnId,
                createdAt: now,
              },
            }
          : {}),
      });
      if (!write.changed) {
        return { ok: false, reason: write.reason ?? 'could not create task' };
      }
    } catch (error) {
      // A resend racing the first request may hit the unique receipt after its
      // preflight read. Re-read once: exact fingerprint is a normal idempotent
      // replay; any other error remains visible to the host.
      if (clientRequestId) {
        const race = await this.repository.getSendReceipt(clientRequestId);
        if (race) {
          if (race.fingerprint !== fingerprint) {
            return { ok: false, reason: 'clientRequestId conflict: different payload' };
          }
          void this.scheduleTurn(race.turnId);
          return {
            ok: true,
            value: {
              taskId: race.taskId,
              messageId: race.messageId,
              turnId: race.turnId,
              clientRequestId,
            },
          };
        }
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    // The successful command atomically committed task/message/turn/receipt.
    // Do not add a fallible receipt read between that commit and the host ACK;
    // the known IDs are the canonical result for this writer.
    void this.scheduleTurn(turnId);
    return {
      ok: true,
      value: { taskId, messageId, turnId, ...(clientRequestId ? { clientRequestId } : {}) },
    };
  }

  /** Repository-backed variant used by the host's interrupt-and-send action. */
  async interruptAndSendAsync(
    taskId: string,
    instruction: string,
  ): Promise<EngineResult<{
    messageId: string;
    turnId: string;
    outcome: 'queued' | 'scheduled';
    interruptedTurnId?: string;
  }>> {
    const live = (await this.repository.listTurns(taskId)).find(
      (turn) => turn.status === 'running' || turn.status === 'waiting_user',
    );
    const sent = await this.sendAsync(taskId, instruction);
    if (!sent.ok || !sent.value.turnId) {
      return sent.ok
        ? { ok: false, reason: 'send did not create a queued turn' }
        : sent;
    }
    if (!live) {
      return {
        ok: true,
        value: { messageId: sent.value.messageId, turnId: sent.value.turnId, outcome: 'scheduled' },
      };
    }
    if (this.liveRuns.has(live.id)) {
      const interrupted = await this.interruptTurnAsync(live.id);
      if (!interrupted.ok) return interrupted;
      return {
        ok: true,
        value: {
          messageId: sent.value.messageId,
          turnId: sent.value.turnId,
          outcome: 'queued',
          interruptedTurnId: live.id,
        },
      };
    }
    return {
      ok: true,
      value: { messageId: sent.value.messageId, turnId: sent.value.turnId, outcome: 'queued' },
    };
  }

  /** Durable queue row only — does not schedule or interrupt. */
  private async reserveQueuedFollowUp(
    taskId: string,
    instruction: string,
  ): Promise<EngineResult<{ messageId: string; turnId: string }>> {
    const messageId = randomUUID();
    const turnId = randomUUID();
    const now = nowIso(this.clock);

    const task = await this.repository.getTask(taskId);
    if (!task) {
      return { ok: false, reason: 'task not found' };
    }
    if (isTerminalLifecycle(task.lifecycle)) {
      return { ok: false, reason: 'task is terminal' };
    }

    const existingTurns = await this.repository.listTurns(taskId);
    const epoch = task.executionEpoch ?? 1;
    const slotsUsed = existingTurns.filter(
      (turn) => (turn.executionEpoch ?? 1) === epoch,
    ).length;
    if (slotsUsed >= effectiveTurnCap(task, this.getResourceLimits())) {
      return { ok: false, reason: 'max turns per task exceeded' };
    }

    const message: TaskMessage = {
      id: messageId,
      taskId,
      role: 'user',
      content: instruction,
      state: 'pending',
      createdAt: now,
    };

    const queued = transitionContinueTask(task, existingTurns, {
      turnId,
      now,
      inputs: [{ kind: 'message', messageId }],
    });
    if (!queued.ok) {
      return queued;
    }
    // Handoff barrier is canPromoteTurn (active handoff phase), not holdAutoPromote.
    const write = await this.repository.execute({
      kind: 'enqueueMessageTurn',
      workspaceId: this.workspaceId,
      expectedTaskRevision: task.revision,
      maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask,
      task,
      message,
      turn: queued.next,
    });
    if (!write.changed) {
      return { ok: false, reason: write.reason ?? 'task changed; retry' };
    }
    return { ok: true, value: { messageId, turnId } };
  }

  async resumeQueuedTurnAsync(taskId: string, turnId: string): Promise<EngineResult<void>> {
    const turn = (await this.repository.listTurns(taskId)).find((candidate) => candidate.id === turnId);
    if (!turn) return { ok: false, reason: 'turn not found' };
    if (turn.status !== 'queued') return { ok: false, reason: 'turn is not queued' };
    if (turn.holdAutoPromote) {
      const cleared = await this.repository.execute({
        kind: 'clearQueuedTurnHold', workspaceId: this.workspaceId, taskId, turnId,
      });
      if (!cleared.changed) {
        return { ok: false, reason: cleared.reason ?? 'turn is no longer queued' };
      }
    }
    this.deferredQueuedTurns.delete(turnId);
    await this.scheduleTurn(turnId);
    return { ok: true, value: undefined };
  }

  async whenIdle(): Promise<void> {
    // Settlement may synchronously enqueue the next FIFO turn from a promise
    // finalizer. Keep draining until no registered schedule remains instead of
    // observing only the first snapshot of the map.
    while (this.turnPromises.size > 0) {
      await Promise.all([...this.turnPromises.values()]);
      await Promise.resolve();
    }
  }

  viewStatus(taskId: string) {
    return this.store.viewStatusOf(taskId);
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
    const task = await this.repository.getTask(params.taskId);
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
    if (task.backend === targetBackendId && (task.model ?? undefined) === (targetModelId ?? undefined)) {
      return { ok: false, reason: 'target backend/model is already bound' };
    }
    const preHandoff = await this.flushLocalTurnsBeforeMutation(
      [...this.liveRuns]
        .filter(([, handle]) => handle.taskId === params.taskId)
        .map(([turnId]) => turnId),
    );
    if (!preHandoff.ok) return preHandoff;
    const [turns, messages, toolCalls] = await Promise.all([
      this.repository.listTurns(params.taskId),
      this.repository.listMessages(params.taskId),
      this.repository.listToolCalls(params.taskId),
    ]);
    const aggregate: EngineProjection = {
      schemaVersion: 6,
      revision: await this.repository.getWorkspaceRevision(),
      tasks: { [task.id]: task },
      turns: Object.fromEntries(turns.map((turn) => [turn.id, turn])),
      messages: Object.fromEntries(messages.map((message) => [message.id, message])),
      toolCalls: Object.fromEntries(toolCalls.map((tool) => [tool.id, tool])),
    };
    const sourceEpoch = task.runtimeEpoch ?? 1;
    const targetEpoch = sourceEpoch + 1;
    const contextCutoff = captureContinuationCutoff(aggregate, params.taskId, now);
    const nextTask: MusterTask = {
        ...task,
        backend: targetBackendId,
        runtimeEpoch: targetEpoch,
        handoff: {
          version: 2,
          operationId,
          source: {
            backend: task.backend,
            ...(task.model ? { model: task.model } : {}),
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
        revision: task.revision + 1,
        updatedAt: now,
      };
    if (targetModelId !== undefined) nextTask.model = targetModelId;
    else delete nextTask.model;
    delete nextTask.committedSessionId;
    const changedTurns: TaskTurn[] = [];
    const expectedTurns: { id: string; status: TaskTurn['status']; runtimeEpoch?: number }[] = [];
    const cancelRequests: { turnId: string; request: import('./types').CancelRequest }[] = [];
    for (const currentTurn of turns.filter((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user')) {
      expectedTurns.push({ id: currentTurn.id, status: currentTurn.status, runtimeEpoch: currentTurn.runtimeEpoch });
      if (currentTurn.status === 'queued') {
        changedTurns.push({ ...currentTurn, runtimeEpoch: targetEpoch });
        continue;
      }
      const claim = await this.repository.getRuntimeClaim(currentTurn.id);
      if (claim && claim.ownerId !== this.runtimeOwnerId && Date.parse(claim.expiresAt) > Date.parse(now)) {
        cancelRequests.push({ turnId: currentTurn.id, request: {
          kind: 'interrupt', by: 'engine', opId: `handoff-preempt-${params.taskId}-${currentTurn.id}`, at: now,
        } });
      }
      const interrupted = interruptTurn(currentTurn, { now });
      if (!interrupted.ok) return interrupted;
      changedTurns.push({ ...interrupted.next, isCancellation: true, interruptConfidence: 'confirmed' });
    }
    const commit = await this.repository.execute({
      kind: 'requestRuntimeHandoff', workspaceId: this.workspaceId, taskId: params.taskId,
      expectedTaskRevision: task.revision, task: nextTask, turns: changedTurns,
      expectedTurns, cancelRequests,
    });
    if (!commit.changed) return { ok: false, reason: commit.reason ?? 'task or turn changed; retry' };

    // The durable epoch fence is already committed. Abort local source streams;
    // late events can no longer write a target binding.
    for (const [turnId, handle] of this.liveRuns) {
      if (handle.taskId !== params.taskId) continue;
      handle.interruptArmed = true;
      handle.controller.abort();
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
        ...(targetModelId !== undefined ? { boundModel: targetModelId } : {}),
        switchedAt: now,
      },
    };
  }

  /** Repository-backed host send path; task/message/turn/receipt are one transaction. */
  async sendAsync(
    taskId: string,
    content: string,
    options?: { agentContent?: string; clientRequestId?: string },
  ): Promise<EngineResult<{ messageId: string; turnId?: string; clientRequestId?: string }>> {
    const hold = this.rejectIfMaintenanceHold();
    if (hold) return hold;
    const clientRequestId =
      typeof options?.clientRequestId === 'string' && options.clientRequestId.trim()
        ? options.clientRequestId.trim()
        : undefined;
    const agentContent =
      options?.agentContent && options.agentContent !== content ? options.agentContent : undefined;
    const fingerprint = sendFingerprint({ kind: 'existing', taskId, content, agentContent });
    const replay = async (): Promise<EngineResult<{ messageId: string; turnId?: string; clientRequestId?: string }> | undefined> => {
      if (!clientRequestId) return undefined;
      const receipt = await this.repository.getSendReceipt(clientRequestId);
      if (!receipt) return undefined;
      if (receipt.fingerprint !== fingerprint) {
        return { ok: false, reason: 'clientRequestId conflict: different payload' };
      }
      const task = await this.repository.getTask(taskId);
      if (!this.deferredQueuedTurns.has(receipt.turnId)) {
        void this.scheduleTurn(receipt.turnId);
      }
      return {
        ok: true,
        value: { messageId: receipt.messageId, turnId: receipt.turnId, clientRequestId },
      };
    };

    const existing = await replay();
    if (existing) return existing;

    const current = await this.repository.getTask(taskId);
    if (!current) return { ok: false, reason: 'task not found' };
    const existingTurns = await this.repository.listTurns(taskId);
    const now = nowIso(this.clock);
    let nextTask = current;
    if (isTerminalLifecycle(nextTask.lifecycle)) {
      const reopened = reopenTask(nextTask, { now });
      if (!reopened.ok) return reopened;
      nextTask = reopened.next;
    }
    if (nextTask.outcomeProposal) {
      nextTask = {
        ...nextTask,
        outcomeProposal: undefined,
        revision: nextTask.revision + 1,
        updatedAt: now,
      };
    }
    if (nextTask.releaseState === 'draft') {
      nextTask = {
        ...nextTask,
        releaseState: 'released',
        releasedAt: now,
        releaseAttemptId: `host:send:${randomUUID()}`,
        revision: nextTask.revision + 1,
        updatedAt: now,
      };
    }
    const epoch = nextTask.executionEpoch ?? 1;
    const slotsUsed = existingTurns.filter(
      (turn) => (turn.executionEpoch ?? 1) === epoch,
    ).length;
    if (slotsUsed >= effectiveTurnCap(nextTask, this.getResourceLimits())) {
      return { ok: false, reason: 'max turns per task exceeded' };
    }

    const messageId = randomUUID();
    const turnId = randomUUID();
    const message: TaskMessage = {
      id: messageId,
      taskId,
      role: 'user',
      content,
      ...(agentContent ? { agentContent } : {}),
      state: 'pending',
      createdAt: now,
    };
    const queue = existingTurns.length === 0
      ? transitionStartTask(nextTask, existingTurns, {
          turnId, now, inputs: [{ kind: 'message', messageId }],
        })
      : transitionContinueTask(nextTask, existingTurns, {
          turnId, now, inputs: [{ kind: 'message', messageId }],
        });
    if (!queue.ok) return queue;

    try {
      const write = await this.repository.execute({
        kind: 'enqueueMessageTurn',
        workspaceId: this.workspaceId,
        expectedTaskRevision: current.revision,
        maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask,
        task: nextTask,
        message,
        turn: queue.next,
        ...(clientRequestId
          ? {
              receipt: {
                clientRequestId,
                fingerprint,
                taskId,
                messageId,
                turnId,
                createdAt: now,
              },
            }
          : {}),
      });
      if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry send' };
    } catch (error) {
      const raced = await replay();
      if (raced) return raced;
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (!this.deferredQueuedTurns.has(turnId)) {
      void this.scheduleTurn(turnId);
    }
    return {
      ok: true,
      value: { messageId, turnId, ...(clientRequestId ? { clientRequestId } : {}) },
    };
  }

  /**
   * Hard upper bound for queued follow-up message content (edit path).
   * Host boundary may apply a tighter limit; this protects the engine store.
   */
  static readonly MAX_QUEUED_MESSAGE_CHARS = 100_000;

  async editQueuedTurnAsync(
    taskId: string,
    turnId: string,
    content: string,
  ): Promise<EngineResult<{ turnId: string; messageId: string }>> {
    if (typeof content !== 'string' || content.length > TaskEngine.MAX_QUEUED_MESSAGE_CHARS) {
      return { ok: false, reason: 'invalid content' };
    }
    const normalized = content.trim();
    if (!normalized) return { ok: false, reason: 'invalid content' };
    const result = await this.repository.execute({
      kind: 'editQueuedMessage', workspaceId: this.workspaceId, taskId, turnId, content: normalized,
    });
    if (!result.changed || !result.messageId) {
      return { ok: false, reason: result.reason ?? 'turn is no longer queued' };
    }
    return { ok: true, value: { turnId, messageId: result.messageId } };
  }

  async deleteQueuedTurnAsync(
    taskId: string,
    turnId: string,
  ): Promise<EngineResult<{ turnId: string; deletedMessageIds: string[] }>> {
    const result = await this.repository.execute({
      kind: 'deleteQueuedTurnAndMessages', workspaceId: this.workspaceId, taskId, turnId,
    });
    if (!result.changed) return { ok: false, reason: result.reason ?? 'turn is no longer queued' };
    return { ok: true, value: { turnId, deletedMessageIds: [...(result.deletedMessageIds ?? [])] } };
  }

  /** Repository-backed start boundary used by host/graph async callers. */
  async startTaskAsync(
    taskId: string,
    inputs: TurnInput[] = [],
  ): Promise<EngineResult<{ turnId: string }>> {
    const trust = this.requireWorkspaceTrusted();
    if (!trust.ok) return trust;
    const task = await this.repository.getTask(taskId);
    if (!task) return { ok: false, reason: 'task not found' };
    if (isTerminalLifecycle(task.lifecycle)) return { ok: false, reason: 'task is terminal' };
    const turns = await this.repository.listTurns(taskId);
    if (turns.length > 0) return { ok: false, reason: 'startTask is only valid before the first turn' };
    const now = nowIso(this.clock);
    const turnId = randomUUID();
    const nextTask = task.releaseState === 'draft'
      ? {
          ...task,
          releaseState: 'released' as const,
          releasedAt: now,
          releaseAttemptId: `host:startTask:${turnId}`,
          revision: task.revision + 1,
          updatedAt: now,
        }
      : task;
    const result = transitionStartTask(nextTask, turns, { turnId, now, inputs, trigger: 'engine' });
    if (!result.ok) return result;
    const write = await this.repository.execute({
      kind: 'queueTaskTurn', workspaceId: this.workspaceId,
      expectedTaskRevision: task.revision,
      maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask,
      task: nextTask, turn: result.next,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry' };
    void this.scheduleTurn(turnId);
    return { ok: true, value: { turnId } };
  }

  /** Repository-backed continuation boundary used by async graph/host callers. */
  async continueTaskAsync(
    taskId: string,
    inputs: TurnInput[] = [],
  ): Promise<EngineResult<{ turnId: string }>> {
    const task = await this.repository.getTask(taskId);
    if (!task) return { ok: false, reason: 'task not found' };
    if (isTerminalLifecycle(task.lifecycle)) return { ok: false, reason: 'task is terminal' };
    const turns = await this.repository.listTurns(taskId);
    const cap = effectiveTurnCap(task, this.getResourceLimits());
    const epoch = task.executionEpoch ?? 1;
    if (turns.filter((turn) => (turn.executionEpoch ?? 1) === epoch).length >= cap) {
      return { ok: false, reason: 'max turns per task exceeded' };
    }
    const now = nowIso(this.clock);
    const turnId = randomUUID();
    const result = transitionContinueTask(task, turns, { turnId, now, inputs });
    if (!result.ok) return result;
    const write = await this.repository.execute({
      kind: 'queueTaskTurn', workspaceId: this.workspaceId,
      expectedTaskRevision: task.revision,
      maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask,
      task, turn: result.next,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry' };
    void this.scheduleTurn(turnId);
    return { ok: true, value: { turnId } };
  }

  async stageDispositionAsync(
    turnId: string,
    disposition: TurnDisposition,
    opId: string,
  ): Promise<EngineResult<void>> {
    const turn = await this.repository.getTurn(turnId);
    if (!turn) return { ok: false, reason: 'turn not found' };
    const task = await this.repository.getTask(turn.taskId);
    if (!task) return { ok: false, reason: 'task not found' };
    const result = stageDisposition(turn, disposition, opId, {
      limits: this.limits,
    });
    if (!result.ok) return result;
    const write = await this.repository.execute({
      kind: 'stageDisposition', workspaceId: this.workspaceId, turnId, opId,
      turn: result.next.turn, expectedStatuses: [turn.status as 'running' | 'waiting_user'],
      ...(turn.disposition ? { expectedDisposition: turn.disposition } : {}),
      expectedRuntimeEpoch: task.runtimeEpoch,
    });
    if (!write.changed && JSON.stringify(result.next.turn) !== JSON.stringify(turn)) {
      return { ok: false, reason: write.reason ?? 'turn changed; retry' };
    }
    return { ok: true, value: undefined };
  }


  private abortLocalTurn(turnId: string): void {
    const handle = this.liveRuns.get(turnId);
    if (handle) {
      handle.interruptArmed = true;
      handle.controller.abort();
    }
  }

  private async flushLocalTurnsBeforeMutation(
    turnIds: readonly string[],
  ): Promise<EngineResult<void>> {
    for (const turnId of new Set(turnIds)) {
      if (!this.liveRuns.has(turnId)) continue;
      const flushed = await this.flushTurnBoundary(turnId);
      if (!flushed.ok) {
        return {
          ok: false,
          reason: `transcript persistence failed: ${flushed.message}`,
        };
      }
    }
    return { ok: true, value: undefined };
  }

  /** Durable interrupt request followed by aborting only a locally-owned run. */
  async interruptTurnAsync(turnId: string): Promise<EngineResult<void>> {
    const turn = await this.repository.getTurn(turnId);
    if (!turn) return { ok: false, reason: 'turn not found' };
    if (turn.status !== 'running' && turn.status !== 'waiting_user') {
      return { ok: false, reason: 'turn is not live' };
    }
    const preInterrupt = await this.flushLocalTurnsBeforeMutation([turnId]);
    if (!preInterrupt.ok) return preInterrupt;
    const now = nowIso(this.clock);
    const request = await this.repository.execute({
      kind: 'putCancelRequest',
      workspaceId: this.workspaceId,
      turnId,
      request: { kind: 'interrupt', by: 'user', opId: `interrupt:${turnId}:${now}`, at: now },
    });
    if (!request.changed) return { ok: false, reason: request.reason ?? 'turn is no longer live' };
    this.abortLocalTurn(turnId);
    return { ok: true, value: undefined };
  }

  async retryTurnAsync(
    taskId: string,
    turnId: string,
    instruction: string,
    options?: { reuseOriginalInputs?: boolean },
  ): Promise<EngineResult<{ turnId: string }>> {
    const oldTurn = await this.repository.getTurn(turnId);
    if (!oldTurn) return { ok: false, reason: 'turn not found' };
    if (oldTurn.taskId !== taskId) return { ok: false, reason: 'turn does not belong to task' };
    const task = await this.repository.getTask(oldTurn.taskId);
    if (!task) return { ok: false, reason: 'turn not found' };
    const turns = await this.repository.listTurns(task.id);
    const now = nowIso(this.clock);
    const newTurnId = randomUUID();
    const retry = retryTurn(task, turns, oldTurn, {
      turnId: newTurnId,
      instruction,
      now,
      reuseOriginalInputs: options?.reuseOriginalInputs === true,
    });
    if (!retry.ok) return retry;
    let nextTask = task;
    if (
      !task.committedSessionId &&
      task.handoff?.version === 2 &&
      task.handoff.continuation.status === 'assigned' &&
      task.handoff.continuation.turnId === oldTurn.id
    ) {
      nextTask = {
        ...task,
        handoff: {
          ...task.handoff,
          continuation: { status: 'assigned', turnId: newTurnId, assignedAt: now },
        },
      };
    }
    const write = await this.repository.execute({
      kind: 'retryTurn', workspaceId: this.workspaceId, expectedTaskRevision: task.revision,
      maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask, task: nextTask, turn: retry.next,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry' };
    void this.scheduleTurn(newTurnId);
    return { ok: true, value: { turnId: newTurnId } };
  }

  async recoverWorkflowActivationAsync(input: {
    runId: string;
    activationId: string;
    failedTurnId: string;
    recoveryOperationId: string;
    instruction: string;
    expectedActivationStatus: 'failed' | 'interrupted';
  }): Promise<EngineResult<{ turnId: string }>> {
    const hold = this.rejectIfMaintenanceHold();
    if (hold) return hold;
    const trust = this.requireWorkspaceTrusted();
    if (!trust.ok) return trust;
    const fingerprint = JSON.stringify({
      runId: input.runId,
      activationId: input.activationId,
      failedTurnId: input.failedTurnId,
      recoveryOperationId: input.recoveryOperationId,
      instruction: input.instruction.trim(),
      expectedActivationStatus: input.expectedActivationStatus,
    });
    const write = await this.repository.execute({
      kind: 'recoverWorkflowActivation',
      workspaceId: this.workspaceId,
      ...input,
      fingerprint,
      createdAt: nowIso(this.clock),
    });
    if (write.conflict) return { ok: false, reason: write.reason ?? 'workflow recovery conflict' };
    const result = write.operation?.result as
      | { ok?: boolean; data?: { turnId?: string } }
      | undefined;
    const turnId = result?.data?.turnId;
    if (!turnId) {
      return { ok: false, reason: write.reason ?? 'workflow activation is no longer recoverable' };
    }
    if (write.changed) void this.scheduleTurn(turnId);
    return { ok: true, value: { turnId } };
  }

  async setTaskLifecycleAsync(
    taskId: string,
    lifecycle: TaskLifecycleState,
    options?: { result?: string; error?: string },
  ): Promise<EngineResult<void>> {
    if (lifecycle === 'skipped') return this.skipTaskAsync(taskId);
    const task = await this.repository.getTask(taskId);
    if (!task) return { ok: false, reason: 'task not found' };
    const turns = await this.repository.listTurns(taskId);
    const live = turns.find((turn) => turn.status === 'running' || turn.status === 'waiting_user');
    const liveClaim = live ? await this.repository.getRuntimeClaim(live.id) : undefined;
    const remoteOwned = !!liveClaim && liveClaim.ownerId !== this.runtimeOwnerId && Date.parse(liveClaim.expiresAt) > Date.parse(nowIso(this.clock));
    const now = nowIso(this.clock);
    const transitioned = transitionSetTaskLifecycle(task, lifecycle, {
      now, result: options?.result, error: options?.error, sealedBy: { kind: 'user' },
    });
    if (!transitioned.ok) return transitioned;
    const changedTurns: TaskTurn[] = [];
    const cancelRequests: { turnId: string; request: import('./types').CancelRequest }[] = [];
    if (lifecycle !== 'open') {
      for (const pending of turns.filter((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user')) {
        if (live && remoteOwned && pending.id === live.id) {
          cancelRequests.push({ turnId: pending.id, request: { kind: 'interrupt', by: 'engine', opId: `lifecycle-${lifecycle}-${taskId}`, at: now } });
          continue;
        }
        if (pending.status === 'queued') {
          const cancelled = cancelPendingTurn(pending, { now });
          if (cancelled.ok) changedTurns.push(cancelled.next);
        } else {
          const interrupted = interruptTurn(pending, { now });
          if (interrupted.ok) changedTurns.push({ ...interrupted.next, isCancellation: lifecycle === 'cancelled' });
        }
      }
    }
    if (live && !remoteOwned && lifecycle !== 'open') {
      const preLifecycle = await this.flushLocalTurnsBeforeMutation([live.id]);
      if (!preLifecycle.ok) return preLifecycle;
    }
    const write = await this.repository.execute({
      kind: 'applyTaskLifecycle', workspaceId: this.workspaceId, taskId,
      expectedTaskRevision: task.revision, task: transitioned.next, turns: changedTurns,
      expectedTurns: turns.filter((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user')
        .map((turn) => ({ id: turn.id, status: turn.status, runtimeEpoch: turn.runtimeEpoch })),
      cancelRequests,
    });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry' };
    if (live && !remoteOwned && lifecycle !== 'open') this.liveRuns.get(live.id)?.controller.abort();
    if (live && !remoteOwned) {
      this.askBridge.cancelForTurn(live.id, 'task lifecycle changed');
      this.dropElicitationWaits(live.id);
      this.credentialRegistry?.revoke(live.id);
    }
    this.rescanSchedulableTurns();
    return { ok: true, value: undefined };
  }

  private prepareLifecycleCascade(
    taskId: string,
    mode: 'skip' | 'cancel',
    file: EngineProjection,
    now: string,
  ):
    | { ok: true; taskIds: string[]; liveTurnIds: string[]; remoteLiveTurnIds: Set<string>; tasks: MusterTask[]; turns: TaskTurn[]; expectedTasks: { id: string; revision: number }[]; expectedTurns: { id: string; status: TaskTurn['status']; runtimeEpoch?: number }[]; cancelRequests: { turnId: string; request: import('./types').CancelRequest }[] }
    | { ok: false; reason: string } {
    if (!file.tasks[taskId]) return { ok: false, reason: 'task not found' };
    const taskIds = [taskId, ...descendantIds(file, taskId)].reverse();
    const liveTurnIds = taskIds.flatMap((id) => pendingTurnsForTask(file, id)
      .filter((turn) => turn.status === 'running' || turn.status === 'waiting_user').map((turn) => turn.id));
    const remoteLiveTurnIds = new Set(liveTurnIds.filter((id) => this.runtimeClaimAlive(id) && !this.ownsRuntimeClaim(id)));
    const draft = cloneEngineProjection(file);
    const cancelRequests: { turnId: string; request: import('./types').CancelRequest }[] = [];
    for (const id of taskIds) {
      const task = draft.tasks[id];
      if (!task || isTerminalLifecycle(task.lifecycle)) continue;
      const pendingTurns = pendingTurnsForTask(draft, id);
      const currentLive = pendingTurns.find((turn) => turn.status === 'running' || turn.status === 'waiting_user');
      if (mode === 'skip') {
        if (currentLive && remoteLiveTurnIds.has(currentLive.id)) {
          cancelRequests.push({ turnId: currentLive.id, request: { kind: 'interrupt', by: 'engine', opId: `skip-task-${taskId}`, at: now } });
        }
        const result = transitionSetTaskLifecycle(task, 'skipped', { now, sealedBy: { kind: 'user' } });
        if (!result.ok) return result;
        draft.tasks[id] = result.next;
        for (const pending of pendingTurns) {
          if (currentLive && remoteLiveTurnIds.has(currentLive.id) && pending.id === currentLive.id) continue;
          const next = pending.status === 'queued' ? cancelPendingTurn(pending, { now }) : interruptTurn(pending, { now });
          if (!next.ok) return next;
          draft.turns[pending.id] = next.next;
        }
      } else {
        if (currentLive && remoteLiveTurnIds.has(currentLive.id)) {
          cancelRequests.push({ turnId: currentLive.id, request: { kind: 'cancel', by: 'engine', opId: `cancel-task-${taskId}`, at: now } });
          draft.tasks[id] = clearPendingParentQuestionOnCancel(draft, task, now);
          continue;
        }
        const result = transitionCancelTask(task, { liveTurn: currentLive, now, sealedBy: { kind: 'user' } });
        if (!result.ok) return result;
        draft.tasks[id] = clearPendingParentQuestionOnCancel(draft, result.next.task, now);
        if (result.next.turn) draft.turns[result.next.turn.id] = result.next.turn;
        for (const pending of pendingTurns) {
          if (pending.id === currentLive?.id) continue;
          const cancelled = cancelPendingTurn(pending, { now });
          if (!cancelled.ok) return cancelled;
          draft.turns[pending.id] = cancelled.next;
        }
      }
    }
    const tasks = taskIds.map((id) => draft.tasks[id]).filter((task): task is MusterTask => {
      const before = task ? file.tasks[task.id] : undefined;
      return !!task && !!before && JSON.stringify(task) !== JSON.stringify(before);
    });
    // clearPendingParentQuestionOnCancel can update parent holders outside the subtree.
    for (const task of Object.values(draft.tasks)) {
      const before = file.tasks[task.id];
      if (before && JSON.stringify(task) !== JSON.stringify(before) && !tasks.some((entry) => entry.id === task.id)) tasks.push(task);
    }
    // A remote-owned live turn may only add a durable cancel request while the
    // task itself remains byte-for-byte unchanged. Keep that task in the named
    // aggregate so the request and its optimistic fence are still one command.
    for (const id of taskIds) {
      const unchanged = file.tasks[id];
      if (unchanged && !tasks.some((entry) => entry.id === id)) tasks.push(unchanged);
    }
    const turns = Object.values(draft.turns).filter((turn) => {
      const before = file.turns[turn.id];
      return !!before && JSON.stringify(turn) !== JSON.stringify(before);
    });
    const expectedTasks = Object.keys(file.tasks)
      .filter((id) => taskIds.includes(id) || tasks.some((task) => task.id === id))
      .map((id) => ({ id, revision: file.tasks[id]!.revision }));
    const expectedTurns = Object.values(file.turns)
      .filter((turn) => liveTurnIds.includes(turn.id) || turns.some((next) => next.id === turn.id))
      .filter((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user')
      .map((turn) => ({ id: turn.id, status: turn.status, runtimeEpoch: turn.runtimeEpoch }));
    return { ok: true, taskIds, liveTurnIds, remoteLiveTurnIds, tasks, turns, expectedTasks, expectedTurns, cancelRequests };
  }

  async skipTaskAsync(taskId: string): Promise<EngineResult<void>> {
    const tasks = await this.repository.listSubtree(taskId);
    if (tasks.length === 0) return { ok: false, reason: 'task not found' };
    const turns = await this.repository.listTurnsForTasks(tasks.map((task) => task.id));
    const file: EngineProjection = {
      schemaVersion: 6, revision: await this.repository.getWorkspaceRevision(),
      tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
      turns: Object.fromEntries(turns.map((turn) => [turn.id, turn])), messages: {},
    };
    const now = nowIso(this.clock);
    const prepared = this.prepareLifecycleCascade(taskId, 'skip', file, now);
    if (!prepared.ok) return prepared;
    const preSkip = await this.flushLocalTurnsBeforeMutation(
      prepared.liveTurnIds.filter((turnId) => !prepared.remoteLiveTurnIds.has(turnId)),
    );
    if (!preSkip.ok) return preSkip;
    const write = await this.repository.execute({ kind: 'cascadeTaskLifecycle', workspaceId: this.workspaceId, rootTaskId: taskId, mode: 'skip', expectedTasks: prepared.expectedTasks, expectedTurns: prepared.expectedTurns, tasks: prepared.tasks, turns: prepared.turns, cancelRequests: prepared.cancelRequests });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry' };
    for (const turnId of prepared.liveTurnIds) {
      if (prepared.remoteLiveTurnIds.has(turnId)) continue;
      this.liveRuns.get(turnId)?.controller.abort();
      this.askBridge.cancelForTurn(turnId, 'task skipped'); this.dropElicitationWaits(turnId); this.credentialRegistry?.revoke(turnId);
    }
    this.rescanSchedulableTurns();
    return { ok: true, value: undefined };
  }

  async cancelTaskAsync(taskId: string): Promise<EngineResult<void>> {
    const tasks = await this.repository.listSubtree(taskId);
    if (tasks.length === 0) return { ok: false, reason: 'task not found' };
    const turns = await this.repository.listTurnsForTasks(tasks.map((task) => task.id));
    const file: EngineProjection = {
      schemaVersion: 6, revision: await this.repository.getWorkspaceRevision(),
      tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
      turns: Object.fromEntries(turns.map((turn) => [turn.id, turn])), messages: {},
    };
    const now = nowIso(this.clock);
    const prepared = this.prepareLifecycleCascade(taskId, 'cancel', file, now);
    if (!prepared.ok) return prepared;
    const preCancel = await this.flushLocalTurnsBeforeMutation(
      prepared.liveTurnIds.filter((turnId) => !prepared.remoteLiveTurnIds.has(turnId)),
    );
    if (!preCancel.ok) return preCancel;
    const write = await this.repository.execute({ kind: 'cascadeTaskLifecycle', workspaceId: this.workspaceId, rootTaskId: taskId, mode: 'cancel', expectedTasks: prepared.expectedTasks, expectedTurns: prepared.expectedTurns, tasks: prepared.tasks, turns: prepared.turns, cancelRequests: prepared.cancelRequests });
    if (!write.changed) return { ok: false, reason: write.reason ?? 'task changed; retry' };
    for (const turnId of prepared.liveTurnIds) {
      if (prepared.remoteLiveTurnIds.has(turnId)) continue;
      this.liveRuns.get(turnId)?.controller.abort();
      this.askBridge.cancelForTurn(turnId, 'task cancelled'); this.dropElicitationWaits(turnId); this.credentialRegistry?.revoke(turnId);
    }
    this.rescanSchedulableTurns();
    return { ok: true, value: undefined };
  }

  /** Repository-only reload recovery. A non-expired runtime claim belongs to
   * another live host; missing/expired claims are reconciled behind the same
   * task/turn fences. */
  private async reconcileReloadFromRepository(): Promise<void> {
    const file = this.store.getFile();
    const now = nowIso(this.clock);
    for (const turn of Object.values(file.turns)) {
      if (turn.status !== 'running' && turn.status !== 'waiting_user') continue;
      const claim = await this.repository.getRuntimeClaim(turn.id);
      if (claim && Date.parse(claim.expiresAt) > Date.parse(now)) continue;
      const task = await this.repository.getTask(turn.taskId);
      if (!task) continue;
      const interrupted = interruptTurn(turn, { now });
      if (!interrupted.ok) continue;
      // Bounded: only the task's queued followers need holdAutoPromote, not full history.
      const queued = await this.repository.listQueuedTurns(task.id);
      const heldTurns = task.attention?.code === 'awaiting_parent_answer'
        ? []
        : queued.filter((candidate) => !candidate.holdAutoPromote)
          .map((candidate) => ({ ...candidate, holdAutoPromote: true }));
      await this.repository.execute({
        kind: 'reconcileOrphanTurn', workspaceId: this.workspaceId, taskId: task.id,
        expectedTaskRevision: task.revision, expectedTurnStatus: turn.status,
        task, turn: { ...interrupted.next, failureClass: 'uncertain', dispatchPhase: turn.dispatchPhase ?? 'prompt_outstanding' },
        heldTurns,
      });
      await this.repository.execute({ kind: 'releaseRuntime', workspaceId: this.workspaceId, turnId: turn.id });
    }
    await this.reconcileChildWaits({ schedule: false });
    await this.deferReloadQueuedTurns();
    await processCancelRequests(this.graphDeps());
  }

  /** Interrupt live source turns in the same commit; queued turns are retagged to target epoch. */
  private applyHandoffTurnPreemption(
    draft: EngineProjection,
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
          this.runtimeClaimAlive(turn.id) &&
          !this.ownsRuntimeClaim(turn.id)
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
  private async deferReloadQueuedTurns(): Promise<void> {
    const file = this.store.getFile();
    const trusted = this.isWorkspaceTrusted();
    for (const turn of Object.values(file.turns)) {
      if (turn.status !== 'queued') continue;
      const task = file.tasks[turn.taskId];
      if (!task) continue;
      // safe_never_dispatched: never running, no prompt dispatch phase (or only pre-queue).
      const safeNeverDispatched =
        !turn.dispatchPhase ||
        turn.dispatchPhase === 'pre_dispatch';
      const safeRetry =
        turn.retryOf &&
        file.turns[turn.retryOf]?.failureClass === 'safe_to_retry';
      if (
        trusted &&
        task.releaseState === 'released' &&
        (safeNeverDispatched || safeRetry) &&
        turn.holdAutoPromote !== true
      ) {
        // Eligible for auto-resume — do not defer (or clear if safe retry).
        if (safeRetry) {
          this.deferredQueuedTurns.delete(turn.id);
          // Recursive CTE over retryOf — O(depth), never full task history.
          const retryIndex = Math.max(1, await this.repository.countRetryDepth(turn.id));
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

  private async reconcileChildWaits(options?: { schedule?: boolean }): Promise<void> {
    const schedule = options?.schedule ?? true;
    const file = this.store.getFile();
    const now = nowIso(this.clock);
    for (const task of Object.values(file.tasks)) {
      if (task.wait?.kind !== 'children') {
        continue;
      }
      const continuationTurnId = `${task.wait.registeredByTurnId}-continuation`;
      const childLifecycles = new Map<string, TaskLifecycleState>();
      const childAttention = new Map<string, { code: string } | undefined>();
      for (const childId of task.wait.taskIds) {
        const child = file.tasks[childId];
        if (child?.lifecycle) childLifecycles.set(childId, child.lifecycle);
        if (child?.attention) childAttention.set(childId, { code: child.attention.code });
      }
      // Bootstrap must not hydrate full history. Use named bounded queries for
      // turn-cap, next sequence, and continuation existence.
      const executionEpoch = task.executionEpoch ?? 1;
      const [slotsUsed, maxSequence] = await Promise.all([
        this.repository.countTurnsForTaskEpoch(task.id, executionEpoch),
        this.repository.getMaxTurnSequence(task.id),
      ]);
      const cap = Math.min(this.getResourceLimits().maxTurnsPerTask, task.executionPolicy.maxTurns);
      if (slotsUsed >= cap) continue;
      // Already-queued continuation (exact id) short-circuits wait clearing.
      if (await this.repository.getTurn(continuationTurnId)) {
        const cleared = { ...task, wait: undefined, revision: task.revision + 1, updatedAt: now };
        await this.repository.execute({
          kind: 'resolveChildWait', workspaceId: this.workspaceId, taskId: task.id,
          expectedTaskRevision: task.revision, task: cleared,
        });
        continue;
      }
      // Synthetic view: projected activity turns + sequence anchors so
      // resolveChildWait can allocate nextSequence without full history.
      const sequenceAnchors: TaskTurn[] = [];
      if (maxSequence > 0) {
        sequenceAnchors.push({
          id: `__seq-anchor-${task.id}`,
          taskId: task.id,
          sequence: maxSequence,
          status: 'succeeded',
          trigger: 'engine',
          inputs: [],
          createdAt: now,
        });
      }
      if (task.wait.registeredByTurnId) {
        const registering = await this.repository.getTurn(task.wait.registeredByTurnId);
        if (registering) sequenceAnchors.push(registering);
        // Detect a prior engine child_results continuation after the wait turn
        // (hasContinuationForWait heuristic without full listTurns).
        const afterSeq = registering?.sequence ?? 0;
        const prior = await this.repository.listEngineChildResultsAfter(task.id, afterSeq, 8);
        sequenceAnchors.push(...prior);
      }
      const waitTurns = [
        ...Object.values(file.turns).filter((t) => t.taskId === task.id),
        ...sequenceAnchors,
      ];
      const result = resolveChildWait(task, childLifecycles, waitTurns, {
        continuationTurnId, now, childAttention,
      });
      if (!result.ok) continue;
      const write = await this.repository.execute({
        kind: 'resolveChildWait', workspaceId: this.workspaceId, taskId: task.id,
        expectedTaskRevision: task.revision, task: result.next.task, turn: result.next.turn,
      });
      if (!write.changed) continue;
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
  private async applyDependencyTerminals(): Promise<void> {
    if (this.storageTerminal) return;
    const now = nowIso(this.clock);
    const before = this.store.getFile();
    const draft = cloneEngineProjection(before);
    for (const task of Object.values(before.tasks)) {
      const current = draft.tasks[task.id];
      if (!current || isTerminalLifecycle(current.lifecycle)) continue;
      const outcome = dependencyTerminalOutcome(draft, task.id);
      if (!outcome) {
        if (
          current.releaseState === 'released' && current.lifecycle === 'open' &&
          current.dependencies.some((dep) => {
            if (dep.onUnsatisfied !== 'block') return false;
            const depTask = draft.tasks[dep.taskId];
            return !!depTask && isTerminalLifecycle(depTask.lifecycle) && depTask.lifecycle !== 'succeeded';
          }) && current.attention?.code !== 'dependency_unsatisfied'
        ) {
          draft.tasks[task.id] = {
            ...current,
            attention: { code: 'dependency_unsatisfied', message: 'required dependency finished unsuccessfully (block policy)', at: now },
            revision: current.revision + 1, updatedAt: now,
          };
        }
        continue;
      }
      const live = Object.values(draft.turns).find((candidate) => candidate.taskId === task.id &&
        (candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'waiting_user'));
      const terminal = applyDependencyTerminal(current, live, outcome, {
        now, error: outcome === 'failed' ? 'dependency unsatisfied' : undefined,
        sealedBy: { kind: 'coordinator', taskId: current.parentId ?? current.id, mode: 'dependency_policy' },
      });
      if (terminal.ok) {
        draft.tasks[task.id] = terminal.next.task;
        if (terminal.next.turn) draft.turns[terminal.next.turn.id] = terminal.next.turn;
      }
    }
    const mutations = Object.values(draft.tasks).filter((task) => JSON.stringify(task) !== JSON.stringify(before.tasks[task.id])).map((task) => ({
      taskId: task.id, task,
      ...(Object.values(draft.turns).find((turn) => turn.taskId === task.id && JSON.stringify(turn) !== JSON.stringify(before.turns[turn.id]))
        ? { turn: Object.values(draft.turns).find((turn) => turn.taskId === task.id && JSON.stringify(turn) !== JSON.stringify(before.turns[turn.id])) } : {}),
    }));
    if (mutations.length > 0) {
      await this.repository.execute({
        kind: 'applyDependencyTerminals', workspaceId: this.workspaceId,
        expectedTasks: mutations.map((mutation) => ({ id: mutation.taskId, revision: before.tasks[mutation.taskId]!.revision })),
        mutations,
      });
    }
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
  private async applyVerdictRemediation(): Promise<void> {
    const now = nowIso(this.clock);
    const turnsToSchedule: string[] = [];
    const before = this.store.getFile();
    const draft = cloneEngineProjection(before);
    const mutate = (): void => {
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
      return;
    };
    mutate();

    const tasks = Object.values(draft.tasks).filter((task) => {
      const beforeTask = before.tasks[task.id];
      return !beforeTask || JSON.stringify(task) !== JSON.stringify(beforeTask);
    });
    const turns = Object.values(draft.turns).filter((turn) => {
      const beforeTurn = before.turns[turn.id];
      return !beforeTurn || JSON.stringify(turn) !== JSON.stringify(beforeTurn);
    });
    const messages = Object.values(draft.messages).filter((message) => {
      const beforeMessage = before.messages[message.id];
      return !beforeMessage || JSON.stringify(message) !== JSON.stringify(beforeMessage);
    });
    const deletedTaskIds = Object.keys(before.tasks).filter((id) => !draft.tasks[id]);
    if (tasks.length > 0 || turns.length > 0 || messages.length > 0 || deletedTaskIds.length > 0) {
      const expectedTaskRevisions = tasks
        .map((task) => before.tasks[task.id])
        .filter((task): task is MusterTask => !!task)
        .map((task) => ({ id: task.id, revision: task.revision }));
      if (expectedTaskRevisions.length > 0) {
        await this.repository.execute({
          kind: 'applyVerdictRemediation', workspaceId: this.workspaceId,
          expectedTaskRevisions, tasks, turns, messages, deletedTaskIds,
        });
      }
    }

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
   * self-report is left unchanged). MUST be called outside the persistence transaction because the
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
   * CRITICAL: git is invoked ONCE per cwd, outside the persistence transaction (it blocks for the
   * whole subprocess). Cheap pre-scan first — if no producer carries a `source:'host'`
   * passing verdict, this is a strict no-op and git is NEVER shelled, so a graph with
   * no host verdicts keeps today's behavior and perf. Runs before
   * {@link applyDependencyTerminals} in the tick so a re-blocked `onUnsatisfied:'fail'`
   * dependent still seals in the same pass.
   */
  private async revalidateVerdicts(): Promise<void> {
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
    const updates: MusterTask[] = [];
    const expectedTaskRevisions: { id: string; revision: number }[] = [];
    for (const id of staleIds) {
      const task = file.tasks[id];
      const verdict = task?.taskResult?.verdict;
      if (!task || !task.taskResult || !verdict || verdict.source !== 'host' || verdict.status !== 'pass') continue;
      updates.push({
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
      });
      expectedTaskRevisions.push({ id: task.id, revision: task.revision });
    }
    if (updates.length === 0) return;
    await this.repository.execute({
      kind: 'applyVerdictRemediation', workspaceId: this.workspaceId,
      expectedTaskRevisions, tasks: updates, turns: [], messages: [],
    });
  }

  private async afterTurnSettled(turnId: string): Promise<void> {
    if (this.storageTerminal) return;
    await this.repository.execute({
      kind: 'deleteOperationsForTurn', workspaceId: this.workspaceId, turnId,
    });
    if (this.storageTerminal) return;
    // Apply dependency terminals before child waits so block-policy sinks get
    // attention and parents wake without waiting for an unrelated rescan.
    await this.applyDependencyTerminals();
    if (this.storageTerminal) return;
    await this.reconcileChildWaits();
    if (this.storageTerminal) return;
    await this.drainPendingSendsAfterSettlement(turnId);
  }

  /**
   * Best-effort claim release that must not initiate repository I/O after
   * terminal storage latch (finally may race with quiesce).
   */
  private safeReleaseClaim(release: () => void): void {
    if (this.storageTerminal) return;
    release();
  }

  private async drainPendingSendsAfterSettlement(settledTurnId: string): Promise<void> {
    const settledTurn = await this.repository.getTurn(settledTurnId);
    if (!settledTurn || settledTurn.status !== 'succeeded') return;
    const task = await this.repository.getTask(settledTurn.taskId);
    if (!task || isTerminalLifecycle(task.lifecycle)) return;
    const turns = [...await this.repository.listTurns(task.id)];
    // R012: eager queue entries already represent the FIFO; only free-floating
    // pending messages become continuations here.
    if (turns.some((turn) => turn.status === 'queued')) return;
    const messages = [...await this.repository.listMessages(task.id)];
    const pending = messages.filter((message) => message.role === 'user' && message.state === 'pending' && !message.turnId);
    if (pending.length === 0) return;
    const now = nowIso(this.clock);
    const continuationTurns: TaskTurn[] = [];
    let workingTask = task;
    let workingTurns = turns;
    for (const message of pending) {
      const cap = canCreateTurn({
        schemaVersion: 6, revision: 0,
        tasks: Object.fromEntries([workingTask].map((entry) => [entry.id, entry])),
        turns: Object.fromEntries(workingTurns.map((entry) => [entry.id, entry])), messages: {},
      }, task.id, this.getResourceLimits());
      if (!cap.ok) break;
      const queued = transitionContinueTask(workingTask, workingTurns, {
        turnId: randomUUID(), now, inputs: [{ kind: 'message', messageId: message.id }], trigger: 'engine',
      });
      if (!queued.ok) break;
      continuationTurns.push(queued.next);
      workingTurns = [...workingTurns, queued.next];
    }
    if (continuationTurns.length === 0) return;
    const nextTask = { ...workingTask, revision: workingTask.revision + 1, updatedAt: now };
    const write = await this.repository.execute({
      kind: 'drainPendingSends', workspaceId: this.workspaceId,
      expectedTaskRevision: task.revision, maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask,
      task: nextTask, turns: continuationTurns,
      messages: pending.map((message) => ({ ...message, state: 'assigned' as const, turnId: continuationTurns.find((turn) => turn.inputs.some((input) => input.kind === 'message' && input.messageId === message.id))?.id })),
    });
    if (!write.changed) return;
    for (const continuationTurn of continuationTurns) {
      if (!this.deferredQueuedTurns.has(continuationTurn.id)) void this.scheduleTurn(continuationTurn.id);
    }
  }

  /**
   * Turn-cap gate. The bounded runtime projection only retains the latest
   * terminal turn per task, so historical slots are counted via a durable
   * repository query instead of the in-memory turn map. A slot is any turn that
   * is not still queued; the candidate turn (about to promote) is counted as a
   * consumed slot even while its row is still queued.
   */
  private async exceedsTurnLimit(taskId: string, candidateTurnId?: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) return true;
    const executionEpoch = task.executionEpoch ?? 1;
    const cap = Math.min(this.getResourceLimits().maxTurnsPerTask, task.executionPolicy.maxTurns);
    // Non-queued turns are committed slots; count them durably. The candidate
    // (still queued) consumes one more slot when it promotes.
    const nonQueued = await this.repository.countTurnsForTaskEpoch(taskId, executionEpoch, [
      'running',
      'waiting_user',
      'succeeded',
      'failed',
      'interrupted',
      'cancelled',
    ]);
    const slotsUsed = candidateTurnId ? nonQueued + 1 : nonQueued;
    return slotsUsed > cap;
  }

  /**
   * W5: re-evaluate queued released turns after readiness-changing commits
   * (release, lifecycle seal, dependency terminal, settle, trust grant).
   */
  private rescanSchedulableTurns(affectedTaskIds?: readonly string[]): void {
    if (this.shuttingDown || this.storageTerminal) return;
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
    if (this.shuttingDown || this.storageTerminal) return Promise.resolve();
    const existing = this.turnPromises.get(turnId);
    if (existing) return existing;
    // Register before the first await so callers of whenIdle cannot observe a
    // false idle window and duplicate schedules cannot start the same turn.
    const promise = this.runScheduledTurn(turnId);
    this.turnPromises.set(turnId, promise);
    void promise.finally(async () => {
      this.turnPromises.delete(turnId);
      // Terminal storage: zero repository / reschedule after latch.
      if (this.storageTerminal || this.shuttingDown) return;
      const file = this.store.getFile();
      const settled = file.turns[turnId];
      const confirmedInterrupt = settled?.status === 'interrupted' && settled.interruptConfidence === 'confirmed';
      const allowSameTaskFollowUps = settled?.status === 'succeeded' || confirmedInterrupt;
      const settledTaskId = settled?.taskId;
      const afterFlush = this.store.getFile();
      const queued = Object.values(afterFlush.turns)
        .filter((turn) => turn.status === 'queued')
        .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (this.storageTerminal) return;
      await this.applyDependencyTerminals();
      if (this.storageTerminal) return;
      for (const queuedTurn of queued) {
        if (this.deferredQueuedTurns.has(queuedTurn.id)) continue;
        if (settledTaskId && queuedTurn.taskId === settledTaskId) {
          if (!allowSameTaskFollowUps) continue;
        } else if (isQueuedTurnAutoPromoteFrozen(afterFlush, queuedTurn.taskId, queuedTurn.id)) {
          continue;
        }
        if (canPromoteTurn(this.store.getFile(), queuedTurn.id, this.getResourceLimits()).ok) void this.scheduleTurn(queuedTurn.id);
      }
    });
    return promise;
  }

  private async runScheduledTurn(turnId: string): Promise<void> {
    if (this.storageTerminal) return;
    // Phase C: downgrade stale host verdicts (git-guarded, no-op without host
    // verdicts) BEFORE sealing so a re-blocked fail/skip dependent seals this tick.
    await this.revalidateVerdicts();
    if (this.storageTerminal) return;
    await this.applyDependencyTerminals();
    if (this.storageTerminal) return;
    await this.applyVerdictRemediation();
    if (this.storageTerminal) return;
    await processCancelRequests(this.graphDeps());
    if (this.storageTerminal) return;
    if (!this.isWorkspaceTrusted()) {
      return;
    }
    const turn = this.store.getFile().turns[turnId];
    if (turn && (await this.exceedsTurnLimit(turn.taskId, turnId))) {
      return;
    }
    if (!canPromoteTurn(this.store.getFile(), turnId, this.getResourceLimits()).ok) {
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
          const task = file.tasks[t.taskId];
          if (task) {
            await this.repository.execute({
              kind: 'setTaskAttention', workspaceId: this.workspaceId,
              expectedTaskRevision: task.revision,
              task: {
                ...task,
                revision: task.revision + 1,
                updatedAt: now,
                attention: {
                  code: 'missing_input',
                  message: 'missing required input binding',
                  at: now,
                  sourceTurnId: turnId,
                },
              },
            });
          }
        }
      }
      return;
    }
    await this.executeTurn(turnId);
  }

  /**
   * Deterministically freeze the state needed to dispatch one turn.  This is a
   * pure draft transform: the caller persists its result through the named
   * `prepareDispatch` repository command, whose transaction is the actual
   * scheduler/claim gate.  Keeping prompt construction out of that transaction
   * avoids holding the SQLite write lock while resolving host configuration.
   */
  private prepareDispatchDraft(
    draft: EngineProjection,
    turnId: string,
    expectedTaskId: string,
    now: string,
  ): EngineResult<void> {
    const draftTurn = draft.turns[turnId];
    const draftTask = draft.tasks[expectedTaskId];
    if (!draftTurn || draftTurn.status !== 'queued' || !draftTask) {
      return { ok: false, reason: 'turn is no longer schedulable' };
    }
    const promote = canPromoteTurn(draft, turnId, this.getResourceLimits());
    if (!promote.ok) return { ok: false, reason: promote.reason };
    if (isTerminalLifecycle(draftTask.lifecycle)) return { ok: false, reason: 'task is terminal' };
    if ((draftTurn.runtimeEpoch ?? 1) !== (draftTask.runtimeEpoch ?? 1)) {
      return { ok: false, reason: 'turn belongs to a superseded runtime binding' };
    }

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
              code: 'missing_input', message: resolved.reason, at: now, sourceTurnId: turnId,
            },
          };
          return { ok: true, value: undefined };
        }
        pins = resolved.pins;
      }

      const brief = draftTask.brief ?? synthesizeBriefFromGoal(draftTask.goal, draftTask.description);
      const snapshot = this.resolveHostSnapshot(draftTask);
      const registryCwd =
        (draftTask.cwd && draftTask.cwd.length > 0 ? draftTask.cwd : undefined) ??
        snapshot.cwd ?? this.workspaceFolder;
      const registryResult = this.getTaskTypeRegistry
        ? this.getTaskTypeRegistry(registryCwd)
        : undefined;
      const taskTypesForHost =
        draftTask.role === 'coordinator'
          ? summarizeTaskTypes(registryResult ?? {
            status: 'empty' as const, registry: new Map(), diagnostics: [],
          }).taskTypes
          : undefined;
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
        tools: [...capabilitiesFor(draftTask, {
          turn: draftTurn,
          workspaceTrusted: this.isWorkspaceTrusted(),
        })].sort(),
        taskCwd: draftTask.cwd,
        brief,
        resolvedInputs: pins,
        meta: { taskId: draftTask.id, goal: draftTask.goal },
        ...(taskTypesForHost !== undefined ? { taskTypes: taskTypesForHost } : {}),
        ...(this.getAdvertisedCommands?.(draftTask.backend) !== undefined
          ? { advertisedCommands: this.getAdvertisedCommands!(draftTask.backend) }
          : {}),
        skillPrefix: this.getSkillPrefix?.(draftTask.backend) ?? '/',
      });

      if (!assembled.ok) {
        for (const input of draftTurn.inputs) {
          if (input.kind !== 'message') continue;
          const message = draft.messages[input.messageId];
          if (!message || message.taskId !== expectedTaskId) continue;
          if (message.state === 'pending' || message.state === 'assigned') {
            draft.messages[input.messageId] = { ...message, state: 'complete', turnId };
          }
        }
        const started = startProcess(draftTurn, { now });
        if (!started.ok) return { ok: false, reason: started.reason };
        const failed = applyFailedTurn(draftTask, started.next, {
          error: assembled.message,
          retryCount: 0,
          policy: draftTask.executionPolicy,
          onExhausted: 'recover',
          now,
          failureClass: 'unclassified',
        });
        if (!failed.ok) return { ok: false, reason: failed.reason };
        draft.tasks[draftTask.id] = {
          ...failed.next.task,
          attention: {
            code: 'prompt_budget_exceeded', message: assembled.message, at: now, sourceTurnId: turnId,
          },
        };
        draft.turns[turnId] = failed.next.turn;
        return { ok: true, value: undefined };
      }

      const remainingContinuationBudget = Math.max(0, COMPILED_PROMPT_MAX - assembled.prompt.length - 2);
      const compactContinuation = claimsContinuation && remainingContinuationBudget > 0
        ? buildCompactContinuationContext(draft, draftTask.id, continuation!, Math.min(16_000, remainingContinuationBudget))
        : undefined;
      const pinned = pinResolvedInputs(
        draftTurn,
        pins,
        compactContinuation ? `${assembled.prompt}\n\n${compactContinuation}` : assembled.prompt,
      );
      if (!pinned.ok) return { ok: false, reason: pinned.reason };
      turnForStart = pinned.next;
      if (claimsContinuation && continuation!.continuation.status === 'pending') {
        taskForStart = {
          ...taskForStart,
          handoff: {
            ...continuation!,
            continuation: { status: 'assigned', turnId, assignedAt: now },
          },
        };
        draft.tasks[draftTask.id] = taskForStart;
      }
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
          ...taskForStart, revision: draftTask.revision + 1, updatedAt: now, attention: undefined,
        };
        draft.tasks[draftTask.id] = taskForStart;
      }
    }

    const inputs: TurnInput[] = [...turnForStart.inputs];
    for (const input of inputs) {
      if (input.kind !== 'message') continue;
      const message = draft.messages[input.messageId];
      if (!message || message.taskId !== expectedTaskId) continue;
      if (message.state === 'pending' || message.state === 'assigned') {
        draft.messages[input.messageId] = { ...message, state: 'assigned', turnId };
      }
    }
    const started = startProcess({ ...turnForStart, inputs }, { now });
    if (!started.ok) return { ok: false, reason: started.reason };
    const frozenDeadline =
      started.next.effectiveRunLimitMs !== undefined && started.next.runDeadlineAt
        ? { effectiveRunLimitMs: started.next.effectiveRunLimitMs, runDeadlineAt: started.next.runDeadlineAt }
        : resolveTurnRunDeadline(draftTask.executionPolicy, this.getRunLimitMs(), now);
    draft.turns[turnId] = { ...started.next, ...frozenDeadline, dispatchPhase: 'pre_dispatch' };
    return { ok: true, value: undefined };
  }

  /** Load only the aggregate rows needed to prepare/settle one task. Related
   * task DTOs are limited to ancestors, dependencies, input producers and child
   * result references; transcript rows are loaded only for the target task. */
  private async loadTaskAggregate(taskId: string): Promise<EngineProjection | undefined> {
    const task = await this.repository.getTask(taskId);
    if (!task) return undefined;
    const tasks = new Map<string, MusterTask>([[task.id, task]]);
    const turns = [...await this.repository.listTurns(task.id)];
    const relatedIds = new Set<string>();
    for (const dependency of task.dependencies) relatedIds.add(dependency.taskId);
    for (const binding of task.inputBindings ?? []) relatedIds.add(binding.fromTaskId);
    for (const turn of turns) {
      for (const input of turn.inputs) {
        if (input.kind === 'child_results') for (const id of input.taskIds) relatedIds.add(id);
      }
    }
    let parentId = task.parentId;
    const seenParents = new Set<string>();
    while (parentId && !seenParents.has(parentId)) {
      seenParents.add(parentId);
      const parent = await this.repository.getTask(parentId);
      if (!parent) break;
      tasks.set(parent.id, parent);
      parentId = parent.parentId;
    }
    for (const id of relatedIds) {
      if (tasks.has(id)) continue;
      const related = await this.repository.getTask(id);
      if (related) tasks.set(related.id, related);
    }
    const [messages, toolCalls, reasoning] = await Promise.all([
      this.repository.listMessages(task.id),
      this.repository.listToolCalls(task.id),
      this.repository.listReasoning(task.id),
    ]);
    return {
      schemaVersion: 6,
      revision: await this.repository.getWorkspaceRevision(),
      tasks: Object.fromEntries([...tasks].map(([id, value]) => [id, value])),
      turns: Object.fromEntries(turns.map((value) => [value.id, value])),
      messages: Object.fromEntries(messages.map((value) => [value.id, value])),
      toolCalls: Object.fromEntries(toolCalls.map((value) => [value.id, value])),
      reasoning: Object.fromEntries(reasoning.map((value) => [value.id, value])),
    };
  }

  private async loadTurnAggregate(turnId: string): Promise<EngineProjection | undefined> {
    const turn = await this.repository.getTurn(turnId);
    return turn ? this.loadTaskAggregate(turn.taskId) : undefined;
  }

  /** Persist a prepared dispatch with optimistic task revision fencing. */
  private async prepareAndPersistDispatch(
    turnId: string,
    expectedTaskId: string,
    now: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const source = await this.loadTaskAggregate(expectedTaskId);
    if (!source) return { ok: false, reason: 'task not found' };
    const before = cloneEngineProjection(source);
    const beforeTask = before.tasks[expectedTaskId];
    if (!beforeTask) return { ok: false, reason: 'task not found' };
    const prepared = this.prepareDispatchDraft(before, turnId, expectedTaskId, now);
    if (!prepared.ok) return prepared;
    const task = before.tasks[expectedTaskId];
    const turn = before.turns[turnId];
    if (!task || !turn) return { ok: false, reason: 'dispatch state disappeared' };
    const messages = Object.values(before.messages).filter((message) =>
      JSON.stringify(source.messages[message.id]) !== JSON.stringify(message));
    let rootTaskId = task.id;
    const seen = new Set<string>();
    while (before.tasks[rootTaskId]?.parentId && !seen.has(rootTaskId)) {
      seen.add(rootTaskId);
      rootTaskId = before.tasks[rootTaskId]!.parentId!;
    }
    try {
      const write = await this.repository.execute({
        kind: 'prepareDispatch',
        workspaceId: this.workspaceId,
        expectedTaskRevision: beforeTask.revision,
        task,
        turn,
        messages,
        startedAt: now,
        rootTaskId,
        maxConcurrentTurns: this.getResourceLimits().maxConcurrentTurns,
        maxConcurrentPerRoot: this.getResourceLimits().maxConcurrentPerRoot,
        maxConcurrentPerBackend: this.getResourceLimits().maxConcurrentPerBackend,
        ...(task.committedSessionId ? { sessionId: task.committedSessionId } : {}),
        resourceKeys: deriveResourceClaimKeys(task),
      });
      return write.changed
        ? { ok: true }
        : { ok: false, reason: write.reason ?? 'turn is no longer schedulable' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Persist a small live-turn activity change without materializing or
   * mutating a EngineProjection. The repository re-checks the status and epoch in
   * its own transaction, so late stream events cannot revive a superseded run. */
  private async replaceLiveTurn(
    turnId: string,
    update: (turn: TaskTurn) => TaskTurn,
  ): Promise<EngineResult<TaskTurn>> {
    if (this.storageTerminal) {
      return { ok: false, reason: 'storage terminal' };
    }
    const current = await this.repository.getTurn(turnId);
    if (this.storageTerminal) {
      return { ok: false, reason: 'storage terminal' };
    }
    if (!current || (current.status !== 'running' && current.status !== 'waiting_user')) {
      return { ok: false, reason: 'turn is no longer live' };
    }
    const task = await this.repository.getTask(current.taskId);
    if (this.storageTerminal) {
      return { ok: false, reason: 'storage terminal' };
    }
    const epoch = current.runtimeEpoch ?? 1;
    if (!task || (task.runtimeEpoch ?? 1) !== epoch) {
      return { ok: false, reason: 'runtime binding was superseded' };
    }
    const next = update(current);
    if (this.storageTerminal) {
      return { ok: false, reason: 'storage terminal' };
    }
    const write = await this.repository.execute({
      kind: 'replaceLiveTurn',
      workspaceId: this.workspaceId,
      turn: next,
      expectedStatuses: [current.status],
      expectedRuntimeEpoch: epoch,
    });
    return write.changed
      ? { ok: true, value: next }
      : { ok: false, reason: write.reason ?? 'turn is no longer live' };
  }

  /** Persist the compact diff produced by a terminal transition.  The command
   * owns the terminal guard and claim release; this helper never sends a whole
   * EngineProjection across the repository boundary. */
  private async persistSettlementDraft(
    before: EngineProjection,
    draft: EngineProjection,
    turnId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const previousTurn = before.turns[turnId];
    const nextTurn = draft.turns[turnId];
    const nextTask = nextTurn ? draft.tasks[nextTurn.taskId] : undefined;
    const previousTask = previousTurn ? before.tasks[previousTurn.taskId] : undefined;
    if (!previousTurn || !previousTask || !nextTurn || !nextTask) {
      return { ok: false, reason: 'settlement state disappeared' };
    }
    const relatedTurns = Object.values(draft.turns).filter(
      (turn) => turn.id !== turnId && JSON.stringify(before.turns[turn.id]) !== JSON.stringify(turn),
    );
    const messages = Object.values(draft.messages).filter(
      (message) => JSON.stringify(before.messages[message.id]) !== JSON.stringify(message),
    );
    try {
      const write = await this.repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: this.workspaceId,
        expectedTaskRevision: previousTask.revision,
        task: nextTask,
        turn: nextTurn,
        expectedStatuses: previousTurn.status === 'waiting_user' ? ['waiting_user'] : ['running'],
        relatedTurns,
        messages,
      });
      return write.changed
        ? { ok: true }
        : { ok: false, reason: write.reason ?? 'turn is no longer live' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeTurn(turnId: string): Promise<void> {
    // Acquire a repository-owned runtime claim before any backend side effect.
    // The conditional row update is the cross-process fence and stale claims are
    // reclaimed by expiry.
    const initialExpiry = new Date(Date.now() + DEFAULT_RUN_LIMIT_MS + LEASE_CLEANUP_BUFFER_MS).toISOString();
    try {
      if (!(await this.claimRuntimeTurn(turnId, initialExpiry))) {
        // Domain contention: another host owns the claim. Not a storage fault.
        return;
      }
    } catch (error) {
      // Storage busy/full/etc. must surface — never silent false (P5-W1).
      const { diagnoseSqliteError } = await import('./sqlite/diagnostics');
      const diagnostic = diagnoseSqliteError(error, 'transaction');
      const taskId = this.store.getFile().turns[turnId]?.taskId ?? '';
      this.safeEmit({
        type: 'turnError',
        taskId,
        turnId,
        message: diagnostic.message,
      });
      return;
    }
    const releaseClaim = (): void => { void this.releaseRuntimeTurn(turnId); };

    const file = this.store.getFile();
    const turn = file.turns[turnId];
    if (!turn || turn.status !== 'queued') {
      releaseClaim();
      return;
    }
    const task = file.tasks[turn.taskId];
    if (!task) {
      releaseClaim();
      return;
    }

    const now = nowIso(this.clock);

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

    const startCommit = await this.prepareAndPersistDispatch(turnId, turn.taskId, now);

    if (!startCommit.ok) {
      releaseClaim();
      return;
    }
    // Pin gate / budget fail: leave queued or failed without adapter dispatch.
    {
      const afterPin = this.store.getFile().turns[turnId];
      if (!afterPin || afterPin.status !== 'running') {
        if (afterPin?.status === 'failed') {
          // Budget fail: wake parent waits (needs_attention) + prune ledger.
          await this.afterTurnSettled(turnId);
        }
        releaseClaim();
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
      releaseClaim();
      return;
    }
    if ((startedTurn.runtimeEpoch ?? 1) !== (taskForDispatch.runtimeEpoch ?? 1)) {
      releaseClaim();
      return;
    }
    if (startedTurn.runDeadlineAt) {
      const deadline = Date.parse(startedTurn.runDeadlineAt);
      if (Number.isFinite(deadline)) {
        void this.heartbeatRuntimeTurn(
          turnId,
          new Date(deadline + LEASE_CLEANUP_BUFFER_MS).toISOString(),
        ).catch(async (error) => {
          const { diagnoseSqliteError } = await import('./sqlite/diagnostics');
          const diagnostic = diagnoseSqliteError(error, 'transaction');
          this.safeEmit({
            type: 'turnError',
            taskId: startedTurn.taskId,
            turnId,
            message: diagnostic.message,
          });
        });
      }
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
      if (this.storageTerminal || this.shuttingDown) return;
      void processCancelRequests(this.graphDeps());
    }, 250);
    // A recovered/frozen deadline may already be expired. Arm a zero-delay
    // watchdog instead of treating 0 as "no timeout" and running forever.
    const turnTimer = setTimeout(() => {
      void (async () => {
        if (this.storageTerminal || this.shuttingDown) return;
        const flushed = await this.flushTurnBoundary(turnId);
        if (this.storageTerminal || this.shuttingDown) return;
        if (!flushed.ok) return;
        const live = await this.repository.getTurn(turnId);
        if (this.storageTerminal || this.shuttingDown) return;
        const limitMs = live?.effectiveRunLimitMs ?? remainingRunMs;
        const deadlineAt = live?.runDeadlineAt ?? new Date().toISOString();
        await this.replaceLiveTurn(turnId, (current) => ({
          ...current,
          termination: { kind: 'run_timeout', limitMs, deadlineAt },
        })).catch(() => undefined);
        if (this.storageTerminal || this.shuttingDown) return;
        console.info('[muster][task-orch] turn.settle.timeout', {
          taskId: taskForDispatch.id,
          turnId,
          backend: taskForDispatch.backend,
          limitMs,
          deadlineAt,
        });
        abort.abort();
      })();
    }, Math.max(0, remainingRunMs));
    {
      const liveHandle = this.liveRuns.get(turnId);
      if (liveHandle) {
        liveHandle.cancelPoll = cancelPoll;
        liveHandle.turnTimer = turnTimer;
      }
    }

    let rawOutput = '';
    let observedSessionId: string | undefined;
    let terminalSettled = false;
    let streamFailureStarted = false;
    let streamFailureMessage: string | undefined;
    let streamFailurePromise: Promise<void> | undefined;
    let streamFailureFinishPromise: Promise<boolean> | undefined;
    /** Timer path only: report once, abort backend, keep dirty buffer; no settle yet. */
    const markStreamPersistenceFailure = (message: string): Promise<void> => {
      if (streamFailurePromise) return streamFailurePromise;
      streamFailureStarted = true;
      streamFailureMessage = message;
      streamFailurePromise = (async () => {
        try {
          if (this.storageTerminal) return;
          // Abort backend; durable settle + one bounded flush retry happen at
          // the explicit lifecycle boundary (finishStreamPersistenceFailure).
          abort.abort();
        } catch {
          // timer callbacks must never reject globally
        }
      })();
      return streamFailurePromise;
    };
    /**
     * Explicit lifecycle boundary after mark: one bounded flushTurn retry, then
     * settle failed. When retry fails, keep dirty buffer (no false success).
     * Returns true when stream-failure handling owns the boundary.
     */
    const finishStreamPersistenceFailure = (): Promise<boolean> => {
      if (!streamFailureStarted) return Promise.resolve(false);
      // A settlement read can itself fail and route execution through catch.
      // Cache the whole finish operation so catch observes the same rejection
      // instead of starting a third transcript flush/retry.
      if (streamFailureFinishPromise) return streamFailureFinishPromise;
      streamFailureFinishPromise = (async () => {
        if (streamFailurePromise) await streamFailurePromise;
        if (this.storageTerminal) return true;
        if (terminalSettled) return true;
        const message = streamFailureMessage ?? 'stream batch persistence failed';
        // Exactly one bounded retry at the deterministic boundary.
        if (this.streamBatcher.hasPending(turnId)) {
          const retry = await this.streamBatcher.flushTurn(turnId);
          if (this.storageTerminal) return true;
          void retry;
        }
        // Always attempt durable failed settlement after the bounded attempt.
        // running + no claim is forbidden: if settle fails, retain claim below.
        try {
          terminalSettled = await this.settleFailed(
            turnId,
            message,
            observedSessionId,
            rawOutput,
            backend,
          );
        } catch (error) {
          const { diagnoseSqliteError } = await import('./sqlite/diagnostics');
          const diagnostic = diagnoseSqliteError(error, 'transaction');
          if (diagnostic.kind === 'invariant') throw error;
          // Settlement could not read/write durable state. Keep the running
          // claim and retained stream buffer; surface only the safe diagnostic.
          this.safeEmit({
            type: 'turnError',
            taskId: startedTurn.taskId,
            turnId,
            message: diagnostic.message,
          });
          return true;
        }
        if (terminalSettled) {
          this.safeEmit({
            type: 'turnError',
            taskId: startedTurn.taskId,
            turnId,
            message,
          });
        }
        return true;
      })();
      return streamFailureFinishPromise;
    };
    /**
     * Unified explicit boundary for normal completion and catch:
     * finish started failure → else flushTurn → on fail mark + finish (one retry).
     */
    const flushBoundaryOrFinishStreamFailure = async (): Promise<boolean> => {
      if (this.storageTerminal) return true;
      if (streamFailureStarted) {
        return finishStreamPersistenceFailure();
      }
      const flushed = await this.streamBatcher.flushTurn(turnId);
      if (this.storageTerminal) return true;
      if (!flushed.ok) {
        await markStreamPersistenceFailure(flushed.message);
        return finishStreamPersistenceFailure();
      }
      return false;
    };
    this.streamFailureHandlers.set(turnId, markStreamPersistenceFailure);
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
    let currentAssistantSegment: {
      storeId: string;
      sourceMessageId: string;
      content: string;
      createdAt: string;
      order: number;
    } | undefined;
    let currentReasoning: PersistedReasoning | undefined;
    const streamedTools = new Map<string, PersistedToolCall>();
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
      const prompt = projectPrompt(currentTurn, messages, current, this.getResourceLimits().maxResultBytes);
      console.info('[muster][task-orch] turn.run', {
        taskId: taskForDispatch.id,
        turnId,
        parentId: taskForDispatch.parentId,
        backend: taskForDispatch.backend,
        model: taskForDispatch.model ?? null,
        releaseState: taskForDispatch.releaseState,
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
        const expectedTools = capabilitiesFor(taskForDispatch, {
          turn: currentTurn,
          workspaceTrusted: this.isWorkspaceTrusted(),
        });
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
          if (this.storageTerminal) {
            throw new Error('storage terminal');
          }
          const commit = await this.replaceLiveTurn(turnId, (current) => {
            if (current.dispatchPhase === 'prompt_outstanding' || current.dispatchPhase === 'terminal_received') {
              return current;
            }
            return { ...current, dispatchPhase: 'prompt_outstanding' };
          });
          if (this.storageTerminal) {
            throw new Error('storage terminal');
          }
          if (!commit.ok) {
            throw new Error(
              `failed to persist prompt_outstanding dispatch marker: ${commit.reason}`,
            );
          }
        },
      };

      for await (const event of this.runTurnFn(backend, built.options)) {
        if (this.storageTerminal || terminalSettled || streamFailureStarted || this.shuttingDown) {
          break;
        }
        await processCancelRequests(this.graphDeps());
        if (this.storageTerminal || terminalSettled || streamFailureStarted || this.shuttingDown) {
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

        // Ephemeral usage only — durable assistant/reasoning/tool UI posts only
        // after successful appendTranscriptBatch (P4-W8 durable-before-visible).
        if (event.type === 'usage') {
          this.safeEmit({ type: 'event', taskId: turn.taskId, turnId, event });
        }

        switch (event.type) {
          case 'sessionStarted':
            if (event.sessionId) {
              observedSessionId = event.sessionId;
              const liveHandle = this.liveRuns.get(turnId);
              if (liveHandle) liveHandle.sessionId = event.sessionId;
              await this.replaceLiveTurn(turnId, (current) => ({
                ...current,
                observedSessionId: event.sessionId,
              })).catch(() => undefined);
            }
            break;
          case 'assistantDelta': {
            // Open a new segment when none is current or the backend messageId
            // changed (mirrors the live reducer). Segment store id = `${turnId}:${order}`.
            const openNew =
              !currentAssistantSegment || currentAssistantSegment.sourceMessageId !== event.messageId;
            if (openNew) {
              // Flush prior segment before opening a new stable id/order.
              if (currentAssistantSegment) {
                const flushed = await this.streamBatcher.flushTurn(turnId);
                if (!flushed.ok) {
                  await markStreamPersistenceFailure(flushed.message);
                  break;
                }
              }
              const order = nextOrder();
              currentAssistantSegment = {
                storeId: `${turnId}:${order}`,
                sourceMessageId: event.messageId,
                content: event.content,
                createdAt: nowIso(this.clock),
                order,
              };
            } else {
              currentAssistantSegment = {
                ...currentAssistantSegment!,
                content: currentAssistantSegment!.content + event.content,
              };
            }
            const segment = currentAssistantSegment;
            this.streamBatcher.noteAssistant({
              storeId: segment.storeId,
              sourceMessageId: segment.sourceMessageId,
              content: segment.content,
              createdAt: segment.createdAt,
              order: segment.order,
              taskId: eventTurn.taskId,
              turnId,
            });
            break;
          }
          case 'reasoningDelta': {
            const at = nowIso(this.clock);
            currentReasoning = currentReasoning
              ? { ...currentReasoning, content: currentReasoning.content + event.content, updatedAt: at }
              : {
                  id: turnId, taskId: eventTurn.taskId, turnId, content: event.content,
                  createdAt: at, updatedAt: at,
                };
            this.streamBatcher.noteReasoning(currentReasoning);
            break;
          }
          case 'toolStarted': {
            // Flush assistant/reasoning before tool boundary (ordering).
            const preTool = await this.streamBatcher.flushTurn(turnId);
            if (!preTool.ok) {
              await markStreamPersistenceFailure(preTool.message);
              break;
            }
            // A tool closes the current assistant segment (matches live commitStreaming).
            currentAssistantSegment = undefined;
            const compositeId = `${turnId}:${event.toolCallId}`;
            if (!streamedTools.has(compositeId)) {
              const at = nowIso(this.clock);
              streamedTools.set(compositeId, {
                id: compositeId,
                taskId: eventTurn.taskId,
                turnId,
                toolCallId: event.toolCallId,
                order: nextOrder(),
                name: event.name,
                kind: event.kind,
                status: 'running',
                input: event.input,
                createdAt: at,
                updatedAt: at,
              });
            }
            let failMessage: string | undefined;
            try {
              const persisted = await this.repository.execute({
                kind: 'appendTranscriptBatch', workspaceId: this.workspaceId, taskId: eventTurn.taskId,
                toolCalls: [streamedTools.get(compositeId)!],
              });
              if (!persisted.changed) failMessage = persisted.reason ?? 'tool persistence failed';
            } catch (error) {
              failMessage = error instanceof Error ? error.message : String(error);
            }
            if (failMessage) {
              await markStreamPersistenceFailure(failMessage);
              break;
            }
            this.safeEmit({ type: 'event', taskId: turn.taskId, turnId, event });
            break;
          }
          case 'toolUpdated': {
            const preTool = await this.streamBatcher.flushTurn(turnId);
            if (!preTool.ok) {
              await markStreamPersistenceFailure(preTool.message);
              break;
            }
            const compositeId = `${turnId}:${event.toolCallId}`;
            const at = nowIso(this.clock);
            const existing = streamedTools.get(compositeId);
            const nextTool: PersistedToolCall = existing
              ? {
                  ...existing,
                  input: event.input !== undefined ? event.input : existing.input,
                  updatedAt: at,
                }
              : {
                  id: compositeId, taskId: eventTurn.taskId, turnId, toolCallId: event.toolCallId,
                  order: nextOrder(), name: 'tool', status: 'running', input: event.input,
                  createdAt: at, updatedAt: at,
                };
            streamedTools.set(compositeId, nextTool);
            let failMessage: string | undefined;
            try {
              const persisted = await this.repository.execute({
                kind: 'appendTranscriptBatch', workspaceId: this.workspaceId, taskId: eventTurn.taskId,
                toolCalls: [nextTool],
              });
              if (!persisted.changed) failMessage = persisted.reason ?? 'tool persistence failed';
            } catch (error) {
              failMessage = error instanceof Error ? error.message : String(error);
            }
            if (failMessage) {
              await markStreamPersistenceFailure(failMessage);
              break;
            }
            this.safeEmit({ type: 'event', taskId: turn.taskId, turnId, event });
            break;
          }
          case 'toolCompleted': {
            const preTool = await this.streamBatcher.flushTurn(turnId);
            if (!preTool.ok) {
              await markStreamPersistenceFailure(preTool.message);
              break;
            }
            const compositeId = `${turnId}:${event.toolCallId}`;
            const outcome = event.outcome;
            const at = nowIso(this.clock);
            const base = streamedTools.get(compositeId) ?? {
              id: compositeId,
              taskId: eventTurn.taskId,
              turnId,
              toolCallId: event.toolCallId,
              order: nextOrder(),
              name: 'tool',
              status: 'running' as const,
              createdAt: at,
              updatedAt: at,
            };
            const nextTool: PersistedToolCall = {
              ...base,
              status: outcome === 'error' ? 'error' : 'success',
              updatedAt: at,
              ...(outcome === 'error'
                ? { error: event.error, output: undefined }
                : { output: event.output, error: undefined }),
            };
            streamedTools.set(compositeId, nextTool);
            let failMessage: string | undefined;
            try {
              const persisted = await this.repository.execute({
                kind: 'appendTranscriptBatch', workspaceId: this.workspaceId, taskId: eventTurn.taskId,
                toolCalls: [nextTool],
              });
              if (!persisted.changed) failMessage = persisted.reason ?? 'tool persistence failed';
            } catch (error) {
              failMessage = error instanceof Error ? error.message : String(error);
            }
            if (failMessage) {
              await markStreamPersistenceFailure(failMessage);
              break;
            }
            this.safeEmit({ type: 'event', taskId: turn.taskId, turnId, event });
            break;
          }
          case 'raw':
            rawOutput += `${event.line}\n`;
            break;
          case 'turnCompleted': {
            const preDone = await this.streamBatcher.flushTurn(turnId);
            if (!preDone.ok) {
              await markStreamPersistenceFailure(preDone.message);
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
          case 'error': {
            const preError = await this.streamBatcher.flushTurn(turnId);
            if (!preError.ok) {
              await markStreamPersistenceFailure(preError.message);
              break;
            }
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
              const preFlush = await this.streamBatcher.flushTurn(turnId);
              if (!preFlush.ok) {
                await markStreamPersistenceFailure(preFlush.message);
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
              const preFlush = await this.streamBatcher.flushTurn(turnId);
              if (!preFlush.ok) {
                await markStreamPersistenceFailure(preFlush.message);
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
          }
          default:
            break;
        }
      }

      if (!this.storageTerminal) {
        const streamFailureHandled = await flushBoundaryOrFinishStreamFailure();
        if (!terminalSettled && !streamFailureHandled) {
          const runTimedOut = this.store.getFile().turns[turnId]?.termination?.kind === 'run_timeout';
          // Terminal storage must not settleInterrupted (graceful shutdown may).
          if (this.storageTerminal) {
            // skip durable settlement
          } else if (runTimedOut) {
            terminalSettled = await this.settleInterrupted(
              turnId, observedSessionId, rawOutput, backend, 'run_timeout',
            );
          } else if (this.shuttingDown) {
            terminalSettled = await this.settleInterrupted(
              turnId, observedSessionId, rawOutput, backend, 'forced',
            );
          } else {
            terminalSettled = await this.settleFailed(
              turnId,
              'turn ended without terminal event',
              observedSessionId,
              rawOutput,
              backend,
            );
          }
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
      if (!this.storageTerminal) {
        const streamFailureHandled = await flushBoundaryOrFinishStreamFailure();
        if (!terminalSettled && !streamFailureHandled) {
          const message = error instanceof Error ? error.message : String(error);
          const runTimedOut = this.store.getFile().turns[turnId]?.termination?.kind === 'run_timeout';
          if (this.storageTerminal) {
            // skip durable settlement after terminal latch
          } else if (runTimedOut) {
            terminalSettled = await this.settleInterrupted(
              turnId, observedSessionId, rawOutput, backend, 'run_timeout',
            );
          } else if (this.shuttingDown) {
            terminalSettled = await this.settleInterrupted(
              turnId, observedSessionId, rawOutput, backend, 'forced',
            );
          } else {
            terminalSettled = await this.settleFailed(
              turnId, message, observedSessionId, rawOutput, backend,
            );
          }
          if (terminalSettled) {
            this.safeEmit({ type: 'turnError', taskId: turn.taskId, turnId, message });
          }
        }
      }
    } finally {
      {
        const liveHandle = this.liveRuns.get(turnId);
        if (liveHandle) {
          if (liveHandle.cancelPoll !== undefined) {
            clearInterval(liveHandle.cancelPoll);
            liveHandle.cancelPoll = undefined;
          }
          if (liveHandle.turnTimer !== undefined) {
            clearTimeout(liveHandle.turnTimer);
            liveHandle.turnTimer = undefined;
          }
        }
      }
      clearInterval(cancelPoll);
      clearTimeout(turnTimer);
      if (streamFailurePromise && !this.storageTerminal) await streamFailurePromise;
      this.streamFailureHandlers.delete(turnId);
      // Hard clear elicitation wait tokens — do not soft-resume a settling turn.
      this.dropElicitationWaits(turnId);
      // Drop buffer only when not terminal and no retained dirty stream state.
      // After a failed bounded retry the dirty buffer must remain for recovery.
      const retainDirtyStream =
        streamFailureStarted && this.streamBatcher.hasPending(turnId);
      if (!this.storageTerminal && !retainDirtyStream) {
        this.streamBatcher.disposeTurn(turnId);
      }
      this.liveRuns.delete(turnId);
      if (this.credentialRegistry) {
        cleanupTurnResources(this.graphDeps(), turnId, mcpConfigPath);
      }
      // Never release claim while the durable turn is still running (stream
      // failure that could not settle). running + no claim is forbidden.
      if (!this.storageTerminal) {
        if (terminalSettled) {
          await this.afterTurnSettled(turnId);
          this.safeReleaseClaim(releaseClaim);
        } else if (!streamFailureStarted) {
          await this.afterTurnSettled(turnId);
          this.safeReleaseClaim(releaseClaim);
        } else {
          // Stream failure path without durable settlement: keep claim so the
          // turn remains recoverable. Do not afterTurnSettled.
        }
      }
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
    if (this.storageTerminal) return false;
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
      // host gate runs outside the persistence transaction and is threaded into the disposition. The
      // store lock is never held across the subprocess.
      const hostVerdict = this.computeHostVerdictForSettle(turnId);
      let missingSession = false;
      const source = await this.loadTurnAggregate(turnId);
      if (!source) return false;
      const before = cloneEngineProjection(source);
      const draft = cloneEngineProjection(before);
      const prepared = (() => {
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
      })();
      const commit = prepared.ok
        ? await this.persistSettlementDraft(before, draft, turnId)
        : prepared;
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
          resultChars: task?.taskResult?.summary?.length ?? 0,
        });
        if (
          task?.attention?.code === 'disposition_repair_pending' &&
          task.lifecycle === 'open' &&
          !task.pendingParentQuestion
        ) {
          await this.enqueueDispositionRepair(task.id, turnId);
        }
        return 'ok';
      }
      if (missingSession) {
        console.info('[muster][task-orch] turn.settle.missing_session', { turnId });
        return 'missing_session';
      }
      console.info('[muster][task-orch] turn.settle.commit_failed', {
        turnId,
        reason: commit.reason,
      });
      return false;
    } finally {
      this.settling.delete(turnId);
    }
  }

  /**
   * P0.5: at most one disposition-repair turn after CLI success without complete/fail.
   * Id derived from settled turn for reload idempotency. Never seals lifecycle.
   */
  private async enqueueDispositionRepair(taskId: string, settledTurnId: string): Promise<void> {
    const repairTurnId = `${settledTurnId}-disposition-repair`;
    const now = nowIso(this.clock);
    if (await this.repository.getTurn(repairTurnId)) return;
    const task = await this.repository.getTask(taskId);
    if (!task || task.lifecycle !== 'open' || task.attention?.code !== 'disposition_repair_pending' || task.parentId === null) return;
    let root = task;
    while (root.parentId) {
      const parent = await this.repository.getTask(root.parentId);
      if (!parent) break;
      root = parent;
    }
    if (root.childOrchestrationSeal === 'propose_only') return;
    const turns = [...await this.repository.listTurns(taskId)];
    const aggregate: EngineProjection = {
      schemaVersion: 6, revision: 0,
      tasks: Object.fromEntries([task].map((entry) => [entry.id, entry])),
      turns: Object.fromEntries(turns.map((entry) => [entry.id, entry])), messages: {},
    };
    const turnCap = canCreateTurn(aggregate, taskId, this.getResourceLimits());
    if (!turnCap.ok) {
      const write = await this.repository.execute({
        kind: 'setTaskAttention', workspaceId: this.workspaceId,
        expectedTaskRevision: task.revision,
        task: { ...task, revision: task.revision + 1, updatedAt: now,
          attention: { code: 'missing_disposition', message: 'disposition repair could not be scheduled', at: now, sourceTurnId: settledTurnId } },
      });
      void write;
      return;
    }
    const messageId = randomUUID();
    const content =
      'Muster host: previous turn finished without complete_task/fail_task. ' +
      'Inspect your prior work in this session and stage complete_task (with a short summary) ' +
      'or fail_task. Do not invent success; do not start new work.';
    const message: TaskMessage = { id: messageId, taskId, role: 'user', content, state: 'assigned', createdAt: now, turnId: repairTurnId };
    const continued = transitionContinueTask(task, turns, {
      turnId: repairTurnId, now, inputs: [{ kind: 'message', messageId }], trigger: 'engine',
    });
    if (!continued.ok) {
      await this.repository.execute({
        kind: 'setTaskAttention', workspaceId: this.workspaceId,
        expectedTaskRevision: task.revision,
        task: { ...task, revision: task.revision + 1, updatedAt: now,
          attention: { code: 'missing_disposition', message: 'disposition repair failed to create turn', at: now, sourceTurnId: settledTurnId } },
      });
      return;
    }
    const write = await this.repository.execute({
      kind: 'enqueueDispositionRepair', workspaceId: this.workspaceId,
      expectedTaskRevision: task.revision, maxTurnsPerTask: this.getResourceLimits().maxTurnsPerTask,
      task: { ...task, revision: task.revision + 1, updatedAt: now }, turn: continued.next, message,
    });
    if (write.changed) void this.scheduleTurn(repairTurnId);
    await this.reconcileChildWaits();
  }

  private async settleInterrupted(
    turnId: string,
    observedSessionId: string | undefined,
    rawOutput: string,
    backend: Backend,
    interruptConfidence: 'confirmed' | 'forced' | 'run_timeout' = 'confirmed',
  ): Promise<boolean> {
    if (this.storageTerminal) return false;
    if (this.settling.has(turnId)) {
      return false;
    }
    this.settling.add(turnId);
    const now = nowIso(this.clock);
    try {
      const source = await this.loadTurnAggregate(turnId);
      if (!source) return false;
      const before = cloneEngineProjection(source);
      const draft = cloneEngineProjection(before);
      const prepared = (() => {
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
      })();
      const commit = prepared.ok
        ? await this.persistSettlementDraft(before, draft, turnId)
        : prepared;
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
    if (this.storageTerminal) return false;
    if (this.settling.has(turnId)) {
      return false;
    }
    this.settling.add(turnId);
    const now = nowIso(this.clock);
    try {
      const source = await this.loadTurnAggregate(turnId);
      if (!source) return false;
      const before = cloneEngineProjection(source);
      const draft = cloneEngineProjection(before);
      const prepared = (() => {
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
      })();
      const commit = prepared.ok
        ? await this.persistSettlementDraft(before, draft, turnId)
        : prepared;

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
          // Recursive CTE — never full task history.
          const retryIndex = Math.max(1, await this.repository.countRetryDepth(retryTurnEntry.id));
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

  private applyEffect(draft: EngineProjection, effect: Effect, turnId: string, now: string): void {
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
