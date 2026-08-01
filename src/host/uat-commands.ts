/**
 * Live two-window UAT command surface.
 *
 * Registered only when MUSTER_UAT_MODE=1 (explicit harness opt-in), and then
 * only up to the tier {@link resolveUatSurface} allows: a Production
 * ExtensionMode (CLI-installed VSIX) is capped at the redacted bridge
 * health/closure observers the M022/S05 install gate needs, so no mutable
 * harness command ships reachable in a marketplace build. The full surface
 * requires a non-production Extension Host.
 * Handlers operate on the activated host repository / poller / presentation
 * paths — never a parallel DbClient.
 */

import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PresentationRecord,
  SendOutboxEntry,
  TaskRepository,
} from '../task/repository';
import type { StorageReportMeta } from '../task/sqlite/rpc';
import type { MusterTask, TaskMessage, TaskTurn } from '../task/types';
import type { RetentionReportSnapshot } from './sqlite-maintenance-commands';

export const UAT_MODE_ENV = 'MUSTER_UAT_MODE';

export const UAT_COMMANDS = {
  ping: 'muster.uat.ping',
  identity: 'muster.uat.identity',
  createTaskWithMessage: 'muster.uat.createTaskWithMessage',
  appendMessage: 'muster.uat.appendMessage',
  enqueueFollowUp: 'muster.uat.enqueueFollowUp',
  promoteFollowUp: 'muster.uat.promoteFollowUp',
  deleteMessage: 'muster.uat.deleteMessage',
  putSendOutbox: 'muster.uat.putSendOutbox',
  markSendOutboxRejected: 'muster.uat.markSendOutboxRejected',
  putPresentation: 'muster.uat.putPresentation',
  hostState: 'muster.uat.hostState',
  forcePollingActive: 'muster.uat.forcePollingActive',
  loadOlderTranscript: 'muster.uat.loadOlderTranscript',
  readDurableSurfaces: 'muster.uat.readDurableSurfaces',
  focusTask: 'muster.uat.focusTask',
  /**
   * Packaging-gate observation: redacted MCP bridge listen state.
   * Returns only `{ port, status, generation }` — never tokens/paths.
   */
  bridgeHealth: 'muster.uat.bridgeHealth',
  /**
   * Packaging-gate: run production `deactivate()` and return the redacted
   * deactivate trace (`{ port, bridgeClosed }` only).
   */
  runDeactivate: 'muster.uat.runDeactivate',
  /**
   * Packaging-gate observation: last redacted deactivate trace, or null when
   * deactivate has not run yet. Booleans + port only — never tokens/paths/env.
   */
  deactivateTrace: 'muster.uat.deactivateTrace',
  /** M019/S05 native first-run observations (production-path delegates). */
  refreshReadiness: 'muster.uat.refreshReadiness',
  probeBackend: 'muster.uat.probeBackend',
  runDoctor: 'muster.uat.runDoctor',
  acceptFirstTask: 'muster.uat.acceptFirstTask',
  nativeFirstRunCleanup: 'muster.uat.nativeFirstRunCleanup',
  /** M023/S05 storage lifecycle observations (production-path delegates). */
  seedStorageWorkload: 'muster.uat.seedStorageWorkload',
  storageLifecycleState: 'muster.uat.storageLifecycleState',
  runRetentionPass: 'muster.uat.runRetentionPass',
  /** M023/S08 orphan lifecycle delegates; registered only in live UAT mode. */
  seedOrphanLifecycleFixtures: 'muster.uat.seedOrphanLifecycleFixtures',
  reclaimOrphanedFiles: 'muster.uat.reclaimOrphanedFiles',
  /** M023/S07 read-only webview DOM observation; registered only in UAT mode. */
  renderProbe: 'muster.uat.renderProbe',
} as const;

export type UatCommandId = (typeof UAT_COMMANDS)[keyof typeof UAT_COMMANDS];

export type UatDbIdentity = {
  applicationId: number;
  userVersion: number;
  dataVersion: number;
  pageCount: number;
  byteSize: number;
  journalMode: string;
  foreignKeys: number;
  /** Hash of realpath + device/inode. Equal only when both hosts opened one file. */
  dbFileToken: string;
  workspaceId: string;
  workspaceIdentityKey: string;
};

export type UatHostState = {
  projectionRevision: number;
  appliedWorkspaceRevision: number;
  taskIds: string[];
  messageIdsByTask: Record<string, string[]>;
  queuedTurnIdsByTask: Record<string, string[]>;
  knownTranscriptIds: string[];
  focusedTaskId?: string;
  viewResolved: boolean;
  viewVisible: boolean;
  pollingReady: boolean;
  pollCount: number;
  externalRecoveryCount: number;
  /** True only because the live UAT keeps two independent Electron processes active. */
  focusGateOverridden: boolean;
};

/** Redacted MCP bridge listen observation for packaging-gate /health proof. */
export type UatBridgeHealthStatus = 'ok' | 'stopping' | 'unavailable';

export type UatBridgeHealth = {
  port: number;
  status: UatBridgeHealthStatus;
  generation: number;
};

/**
 * Project a bridge health snapshot to the packaging-gate allowlist of fields.
 * Strips bearer tokens, credential ids, workspace/db paths, and any other extras.
 * Does not start or stop the bridge — pure observation.
 */
export function readRedactedBridgeHealth(
  source:
    | {
        port?: number | null;
        status?: string | null;
        generation?: number | null;
        [key: string]: unknown;
      }
    | null
    | undefined,
): UatBridgeHealth {
  if (!source) {
    return { port: 0, status: 'unavailable', generation: 0 };
  }

  const port =
    typeof source.port === 'number' && Number.isFinite(source.port) ? source.port : 0;
  const generation =
    typeof source.generation === 'number' && Number.isFinite(source.generation)
      ? source.generation
      : 0;

  let status: UatBridgeHealthStatus;
  if (source.status === 'ok' || source.status === 'stopping') {
    // Explicit bridge status wins, but a non-listening port cannot claim ok.
    status = source.status === 'ok' && port <= 0 ? 'unavailable' : source.status;
  } else if (port > 0) {
    status = 'ok';
  } else {
    status = 'unavailable';
  }

  return { port, status, generation };
}

/** Redacted deactivate observation for packaging-gate bridge-closure proof. */
export type UatDeactivateTrace = {
  port: number;
  bridgeClosed: boolean;
};

/**
 * Project a deactivate observation to the packaging-gate allowlist of fields.
 * Strips bearer tokens, credential ids, workspace/db paths, env values, and any extras.
 * Pure projection — does not start or stop the bridge.
 */
export function readRedactedDeactivateTrace(
  source:
    | {
        port?: number | null;
        bridgeClosed?: boolean | null;
        [key: string]: unknown;
      }
    | null
    | undefined,
): UatDeactivateTrace {
  if (!source) {
    return { port: 0, bridgeClosed: false };
  }

  const port =
    typeof source.port === 'number' && Number.isFinite(source.port) ? source.port : 0;
  const bridgeClosed = source.bridgeClosed === true;

  return { port, bridgeClosed };
}

/** Typed packaging-gate observation that deactivate closed the MCP bridge. */
export type BridgeClosureTracePresence = 'present' | 'missing';
export type BridgeClosurePostExitProbe = 'refused' | 'still-serving' | 'unknown';
export type BridgeClosurePhase =
  | 'ok'
  | 'deactivate-failed'
  | 'trace-missing'
  | 'not-closed'
  | 'still-serving'
  | 'probe-unknown';

export type BridgeClosureObservation = {
  port: number;
  trace: BridgeClosureTracePresence;
  bridgeClosed: boolean;
  postExitProbe: BridgeClosurePostExitProbe;
  phase: BridgeClosurePhase;
};

/**
 * Build the packaging-gate `bridgeClosure` observation from redacted inputs.
 * Pure — never carries tokens, workspace paths, or env values.
 */
export function buildBridgeClosureObservation(input: {
  port: number;
  trace: BridgeClosureTracePresence;
  bridgeClosed: boolean;
  postExitProbe: BridgeClosurePostExitProbe;
  deactivateFailed?: boolean;
}): BridgeClosureObservation {
  const port =
    typeof input.port === 'number' && Number.isFinite(input.port) && input.port > 0
      ? input.port
      : 0;
  const bridgeClosed = input.bridgeClosed === true;
  const trace: BridgeClosureTracePresence = input.trace === 'present' ? 'present' : 'missing';
  const postExitProbe: BridgeClosurePostExitProbe =
    input.postExitProbe === 'refused' ||
    input.postExitProbe === 'still-serving' ||
    input.postExitProbe === 'unknown'
      ? input.postExitProbe
      : 'unknown';

  let phase: BridgeClosurePhase;
  if (input.deactivateFailed) {
    phase = 'deactivate-failed';
  } else if (trace === 'missing') {
    phase = 'trace-missing';
  } else if (!bridgeClosed) {
    phase = 'not-closed';
  } else if (postExitProbe === 'still-serving') {
    phase = 'still-serving';
  } else if (postExitProbe === 'unknown') {
    phase = 'probe-unknown';
  } else {
    phase = 'ok';
  }

  return { port, trace, bridgeClosed, postExitProbe, phase };
}

export type UatDurableSurfaces = {
  sendOutbox: Array<{
    clientRequestId: string;
    status: SendOutboxEntry['status'];
    taskId?: string;
    textLength: number;
  }>;
  presentation?: {
    rootId: string;
    presentationId: string;
    revision: number;
    titleLength: number;
    markdownLength: number;
  };
  workspaceRevision: number;
};

/**
 * Exposure tier for the live UAT command surface.
 *
 * - `none` — nothing is registered. This is every marketplace install, because
 *   `MUSTER_UAT_MODE` is only ever set by our own release gates.
 * - `packaging` — Production ExtensionMode (a CLI-installed VSIX) with
 *   `MUSTER_UAT_MODE=1`. Only the redacted bridge observers the packaging and
 *   install gates need. No command in this tier touches persisted task rows,
 *   messages, follow-up turns, the send outbox, or presentations.
 * - `full` — non-production Extension Host with `MUSTER_UAT_MODE=1`. The whole
 *   harness surface, including the store-mutating commands.
 */
export type UatSurfaceTier = 'none' | 'packaging' | 'full';

/**
 * The only UAT commands allowed to be reachable from a Production VSIX.
 *
 * Deliberately minimal: redacted bridge listen state plus the deactivate trace
 * that proves the MCP bridge actually closes (M022/S05 real-install gate,
 * D073). `runDeactivate` tears down this extension instance and its own bridge
 * listener; it never creates, edits, or deletes stored data.
 */
export const PACKAGING_UAT_COMMAND_IDS: readonly UatCommandId[] = Object.freeze([
  UAT_COMMANDS.bridgeHealth,
  UAT_COMMANDS.runDeactivate,
  UAT_COMMANDS.deactivateTrace,
]);

/**
 * Resolve which UAT surface may be registered.
 *
 * The env flag is a necessary opt-in but not a sufficient one: a Production
 * extension host is capped at the redacted packaging tier so a marketplace
 * build can never expose mutable harness commands, even with the flag set.
 */
export function resolveUatSurface(
  isProductionExtension: boolean,
  env: NodeJS.ProcessEnv = process.env,
): UatSurfaceTier {
  if (env[UAT_MODE_ENV] !== '1') {
    return 'none';
  }
  return isProductionExtension ? 'packaging' : 'full';
}

/** True when `id` may be registered under `tier`. */
export function isUatCommandAllowed(tier: UatSurfaceTier, id: UatCommandId): boolean {
  if (tier === 'full') {
    return true;
  }
  if (tier === 'packaging') {
    return PACKAGING_UAT_COMMAND_IDS.includes(id);
  }
  return false;
}

/** True when any UAT command surface is registered at all. */
export function isUatModeEnabled(
  isProductionExtension: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveUatSurface(isProductionExtension, env) !== 'none';
}

export function makeIso(offsetMs = 0): string {
  return new Date(Date.UTC(2026, 6, 17, 12, 0, 0) + offsetMs).toISOString();
}

export function makeTask(id: string, goal = id): MusterTask {
  const now = makeIso();
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'draft',
    goal,
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeUserMessage(
  id: string,
  taskId: string,
  content: string,
  createdAt = makeIso(),
): TaskMessage {
  return {
    id,
    taskId,
    role: 'user',
    content,
    state: 'complete',
    createdAt,
  };
}

export function makeQueuedTurn(
  id: string,
  taskId: string,
  sequence: number,
  messageId: string,
  createdAt = makeIso(),
): TaskTurn {
  return {
    id,
    taskId,
    sequence,
    status: 'queued',
    trigger: 'user',
    inputs: [{ kind: 'message', messageId }],
    createdAt,
  };
}

export type UatDbProbe = {
  pragma(name: string): Promise<number>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
};

export async function readRedactedDbIdentity(
  repository: TaskRepository,
  dbPath: string,
  fsIdentity: (path: string) => { size: number; physicalIdentity: string },
  hash: (input: string) => string,
  probe: UatDbProbe,
): Promise<UatDbIdentity> {
  const workspace = await repository.getWorkspace();
  if (!workspace) {
    throw new Error('workspace row missing');
  }
  const applicationId = await probe.pragma('application_id');
  const userVersion = await probe.pragma('user_version');
  const dataVersion = await repository.getStorageDataVersion();
  const pageCountRow = await probe.get<{ page_count: number }>('PRAGMA page_count');
  const journal = await probe.get<{ journal_mode: string }>('PRAGMA journal_mode');
  const foreignKeys = await probe.pragma('foreign_keys');
  const file = fsIdentity(dbPath);
  const byteSize = file.size;
  const pageCount = pageCountRow?.page_count ?? 0;
  const dbFileToken = hash(file.physicalIdentity);
  return {
    applicationId,
    userVersion,
    dataVersion,
    pageCount,
    byteSize,
    journalMode: journal?.journal_mode ?? 'unknown',
    foreignKeys,
    dbFileToken,
    workspaceId: workspace.id,
    workspaceIdentityKey: workspace.identityKey,
  };
}

export type CreateTaskWithMessageArgs = {
  taskId: string;
  messageId: string;
  turnId: string;
  goal?: string;
  content?: string;
  clientRequestId?: string;
};

export async function createTaskWithMessage(
  repository: TaskRepository,
  workspaceId: string,
  args: CreateTaskWithMessageArgs,
): Promise<{ taskId: string; messageId: string; turnId: string; workspaceRevision: number }> {
  const now = makeIso();
  const task = makeTask(args.taskId, args.goal ?? args.taskId);
  const message = makeUserMessage(args.messageId, args.taskId, args.content ?? 'uat-message', now);
  const turn: TaskTurn = {
    id: args.turnId,
    taskId: args.taskId,
    sequence: 1,
    status: 'succeeded',
    trigger: 'user',
    inputs: [{ kind: 'message', messageId: args.messageId }],
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  };
  await repository.execute({
    kind: 'createRootAndInitialTurn',
    workspaceId,
    task,
    message,
    turn,
    receipt: {
      clientRequestId: args.clientRequestId ?? `uat-${args.messageId}`,
      fingerprint: `uat-${args.messageId}`,
      taskId: args.taskId,
      messageId: args.messageId,
      turnId: args.turnId,
      createdAt: now,
    },
  });
  return {
    taskId: args.taskId,
    messageId: args.messageId,
    turnId: args.turnId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export type AppendMessageArgs = {
  taskId: string;
  messageId: string;
  content?: string;
};

export async function appendMessage(
  repository: TaskRepository,
  workspaceId: string,
  args: AppendMessageArgs,
): Promise<{ messageId: string; workspaceRevision: number }> {
  const message = makeUserMessage(
    args.messageId,
    args.taskId,
    args.content ?? 'uat-followup-message',
    makeIso(1_000),
  );
  await repository.execute({
    kind: 'appendMessage',
    workspaceId,
    message,
  });
  return {
    messageId: args.messageId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export type EnqueueFollowUpArgs = {
  taskId: string;
  turnId: string;
  messageId: string;
  sequence: number;
  content?: string;
};

export async function enqueueFollowUp(
  repository: TaskRepository,
  workspaceId: string,
  args: EnqueueFollowUpArgs,
): Promise<{ turnId: string; messageId: string; workspaceRevision: number }> {
  const createdAt = makeIso(2_000);
  const task = await repository.getTask(args.taskId);
  if (!task) throw new Error('UAT task missing');
  const result = await repository.execute({
    kind: 'enqueueMessageTurn',
    workspaceId,
    expectedTaskRevision: task.revision,
    maxTurnsPerTask: task.executionPolicy.maxTurns,
    task,
    message: {
      id: args.messageId,
      taskId: args.taskId,
      role: 'user',
      content: args.content ?? 'uat-queued',
      state: 'pending',
      createdAt,
    },
    turn: makeQueuedTurn(args.turnId, args.taskId, args.sequence, args.messageId, createdAt),
  });
  if (!result.changed) throw new Error(result.reason ?? 'UAT enqueue failed');
  return {
    turnId: args.turnId,
    messageId: args.messageId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export async function promoteFollowUp(
  repository: TaskRepository,
  workspaceId: string,
  turnId: string,
): Promise<{ turnId: string; workspaceRevision: number }> {
  await repository.execute({
    kind: 'promoteTurn',
    workspaceId,
    turnId,
    startedAt: makeIso(3_000),
  });
  return {
    turnId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export async function deleteMessage(
  repository: TaskRepository,
  workspaceId: string,
  messageId: string,
): Promise<{ messageId: string; workspaceRevision: number }> {
  await repository.execute({
    kind: 'deleteMessage',
    workspaceId,
    messageId,
  });
  return {
    messageId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export type PutSendOutboxArgs = {
  clientRequestId: string;
  status?: SendOutboxEntry['status'];
  taskId?: string;
  text?: string;
};

export async function putSendOutbox(
  repository: TaskRepository,
  workspaceId: string,
  args: PutSendOutboxArgs,
): Promise<{ clientRequestId: string; workspaceRevision: number }> {
  const now = makeIso(4_000);
  await repository.execute({
    kind: 'putSendOutbox',
    workspaceId,
    entry: {
      clientRequestId: args.clientRequestId,
      status: args.status ?? 'pending',
      ...(args.taskId ? { taskId: args.taskId } : {}),
      payload: { version: 1, text: args.text ?? 'uat-outbox-draft' },
      createdAt: now,
      updatedAt: now,
    },
  });
  return {
    clientRequestId: args.clientRequestId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export async function markSendOutboxRejected(
  repository: TaskRepository,
  workspaceId: string,
  clientRequestId: string,
): Promise<{ clientRequestId: string; workspaceRevision: number }> {
  await repository.execute({
    kind: 'markSendOutboxRejected',
    workspaceId,
    clientRequestId,
    updatedAt: makeIso(5_000),
  });
  return {
    clientRequestId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export type PutPresentationArgs = {
  rootId: string;
  presentationId: string;
  ownerTaskId: string;
  revision?: number;
  title?: string;
  markdown?: string;
};

export async function putPresentation(
  repository: TaskRepository,
  workspaceId: string,
  args: PutPresentationArgs,
): Promise<{ presentationId: string; workspaceRevision: number }> {
  const document: PresentationRecord = {
    presentationId: args.presentationId,
    ownerTaskId: args.ownerTaskId,
    rootId: args.rootId,
    revision: args.revision ?? 1,
    title: args.title ?? 'uat-presentation',
    markdown: args.markdown ?? '# uat',
    updatedAt: makeIso(6_000),
  };
  await repository.execute({
    kind: 'putPresentation',
    workspaceId,
    document,
  });
  return {
    presentationId: args.presentationId,
    workspaceRevision: await repository.getWorkspaceRevision(),
  };
}

export type StorageLifecycleSeedResult = {
  seededTasks: number;
  seededTurns: number;
  seededToolCalls: number;
};

const STORAGE_SEED_TASK_ID = 'uat-storage-seed-terminal';
const STORAGE_SEED_ACTIVE_TASK_ID = 'uat-storage-seed-active';
// Remains inside the shared 128 KiB per-side file-change boundary while
// contributing four substantial, retention-eligible diff payloads.
const STORAGE_SEED_LARGE_DIFF = 'x'.repeat(120 * 1024);
// Uses the established open-task tool-output retention branch to ensure the
// seed exceeds pages already allocated by scenarios A-I; it is not returned
// by the numeric lifecycle observation surface.
const STORAGE_SEED_LARGE_OUTPUT = 'y'.repeat(1_250 * 1024);
const STORAGE_SEED_AGE_MS = 366 * 24 * 60 * 60 * 1_000;

/** Keeps the live fixture eligible as wall time advances without changing production retention policy. */
function makeStorageSeedIso(offsetMs = 0): string {
  return new Date(Date.now() - STORAGE_SEED_AGE_MS + offsetMs).toISOString();
}

/**
 * Creates a bounded, retention-eligible production workload plus one live turn.
 * The caller owns UAT gating; this helper never opens a parallel database client.
 */
export async function seedStorageWorkload(
  repository: Pick<TaskRepository, 'execute'>,
  workspaceId: string,
): Promise<StorageLifecycleSeedResult> {
  const terminalTask = { ...makeTask(STORAGE_SEED_TASK_ID, 'UAT storage lifecycle terminal workload'), lifecycle: 'succeeded' as const };
  const activeTask = makeTask(STORAGE_SEED_ACTIVE_TASK_ID, 'UAT storage lifecycle active workload');
  await repository.execute({ kind: 'createTask', workspaceId, task: terminalTask });
  await repository.execute({ kind: 'createTask', workspaceId, task: activeTask });

  // SQLite retention preserves durable rows, but truncates oversized payloads
  // on settled turns belonging to an otherwise open task.
  const settledTurns: TaskTurn[] = Array.from({ length: 4 }, (_, index) => index + 1).map((sequence) => ({
    id: `${STORAGE_SEED_ACTIVE_TASK_ID}-settled-${sequence}`,
    taskId: activeTask.id,
    sequence,
    status: 'succeeded' as const,
    trigger: 'user' as const,
    inputs: [],
    createdAt: makeStorageSeedIso(sequence * 1_000),
    finishedAt: makeStorageSeedIso(sequence * 1_000 + 500),
  }));
  for (const turn of settledTurns) {
    await repository.execute({ kind: 'createTurn', workspaceId, turn });
  }
  const activeTurn: TaskTurn = {
    id: `${STORAGE_SEED_ACTIVE_TASK_ID}-turn-5`, taskId: activeTask.id, sequence: 5,
    status: 'running', trigger: 'user', inputs: [], createdAt: makeStorageSeedIso(5_000), startedAt: makeStorageSeedIso(5_100),
  };
  await repository.execute({ kind: 'createTurn', workspaceId, turn: activeTurn });

  await repository.execute({
    kind: 'appendTranscriptBatch', workspaceId, taskId: activeTask.id,
    toolCalls: settledTurns.map((turn, index) => ({
      id: `${turn.id}:edit`, taskId: activeTask.id, turnId: turn.id, toolCallId: 'edit', order: 0,
      name: 'edit_file', kind: 'builtin' as const, status: 'success' as const,
      output: STORAGE_SEED_LARGE_OUTPUT,
      fileChanges: index < 4
        ? [{
          path: `src/retained-${index}.ts`, oldText: STORAGE_SEED_LARGE_DIFF, newText: STORAGE_SEED_LARGE_DIFF,
        }]
        : [{ path: 'src/current.ts', oldText: 'before', newText: 'after' }],
      createdAt: makeStorageSeedIso(6_000 + index), updatedAt: makeStorageSeedIso(6_000 + index),
    })),
  });
  await repository.execute({
    kind: 'appendTranscriptBatch', workspaceId, taskId: activeTask.id,
    toolCalls: [{
      id: `${activeTurn.id}:edit`, taskId: activeTask.id, turnId: activeTurn.id, toolCallId: 'edit', order: 0,
      name: 'edit_file', kind: 'builtin', status: 'success',
      fileChanges: [{ path: 'src/live.ts', oldText: 'live-before', newText: 'live-after' }],
      createdAt: makeStorageSeedIso(7_000), updatedAt: makeStorageSeedIso(7_000),
    }],
  });
  return { seededTasks: 2, seededTurns: settledTurns.length + 1, seededToolCalls: settledTurns.length + 1 };
}

type LifecycleDbProbe = {
  storageReport(): Promise<StorageReportMeta>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
};

type LifecycleRetentionReport = { snapshot(): RetentionReportSnapshot };

export type StorageLifecycleState = {
  storage: StorageReportMeta;
  retention: { completedPasses: number; failedPasses: number; latestPassOrdinal: number };
  durableRows: { tasks: number; turns: number; messages: number; operations: number };
  retentionTruncatedEntries: number;
};

/** Numeric-and-enum-only storage lifecycle observation for the live UAT runner. */
export async function readStorageLifecycleState(deps: {
  repository: Pick<TaskRepository, 'listTasks' | 'listToolCalls'>;
  sqliteClient: LifecycleDbProbe;
  retentionReport: LifecycleRetentionReport;
  workspaceId: string;
}): Promise<StorageLifecycleState> {
  const tables = ['tasks', 'turns', 'messages', 'operations'] as const;
  const [storage, snapshot, rows, tasks] = await Promise.all([
    deps.sqliteClient.storageReport(),
    Promise.resolve(deps.retentionReport.snapshot()),
    Promise.all(tables.map(async (table) => {
      const row = await deps.sqliteClient.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`, [deps.workspaceId],
      );
      return [table, row?.count ?? 0] as const;
    })),
    deps.repository.listTasks(deps.workspaceId),
  ]);
  const toolCalls = await Promise.all(tasks.map((task) => deps.repository.listToolCalls(task.id)));
  const retentionTruncatedEntries = toolCalls.flat(2).reduce(
    (count, tool) => count + (tool.fileChanges ?? []).filter((change) => change.retentionTruncated === true).length,
    0,
  );
  const latestPassOrdinal = snapshot.completedPassDetails.at(-1)?.ordinal ?? 0;
  return {
    storage,
    retention: { completedPasses: snapshot.completedPasses, failedPasses: snapshot.failedPasses, latestPassOrdinal },
    durableRows: Object.fromEntries(rows) as StorageLifecycleState['durableRows'],
    retentionTruncatedEntries,
  };
}

/** Preserves production retention failure semantics while giving UAT a direct pass seam. */
export async function runRetentionPass<T>(runPass: () => Promise<T>): Promise<T> {
  return runPass();
}

/**
 * Creates only classifier-recognized orphan fixtures beside the activated store.
 * Results deliberately expose numeric totals, never filenames or filesystem paths.
 */
export async function seedOrphanLifecycleFixtures(
  storageDirectory: string,
): Promise<{ deadLegacyStores: number; staleLeases: number; activeLeases: number }> {
  const now = new Date();
  const stale = new Date(now.getTime() - 61_000);
  await writeFile(join(storageDirectory, '.muster-tasks.json'), '{}', 'utf8');
  await writeFile(join(storageDirectory, '.lease.turn%3Aorphan-uat'), 'stale', 'utf8');
  await writeFile(join(storageDirectory, '.lease.turn%3Aactive-uat'), 'active', 'utf8');
  await utimes(join(storageDirectory, '.lease.turn%3Aorphan-uat'), stale, stale);
  return { deadLegacyStores: 1, staleLeases: 1, activeLeases: 1 };
}

export async function readDurableSurfaces(
  repository: TaskRepository,
  args: { rootId: string; presentationId: string },
): Promise<UatDurableSurfaces> {
  const [outbox, presentation, workspaceRevision] = await Promise.all([
    repository.listSendOutbox(),
    repository.getPresentation(args.rootId, args.presentationId),
    repository.getWorkspaceRevision(),
  ]);
  return {
    sendOutbox: outbox.map((entry) => ({
      clientRequestId: entry.clientRequestId,
      status: entry.status,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      textLength: entry.payload.text.length,
    })),
    presentation: presentation
      ? {
          rootId: presentation.rootId,
          presentationId: presentation.presentationId,
          revision: presentation.revision,
          titleLength: presentation.title.length,
          markdownLength: presentation.markdown.length,
        }
      : undefined,
    workspaceRevision,
  };
}
