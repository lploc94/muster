/**
 * Live two-window UAT command surface.
 *
 * Registered only when MUSTER_UAT_MODE=1 in a non-production Extension Host.
 * Handlers operate on the activated host repository / poller / presentation
 * paths — never a parallel DbClient.
 */

import type {
  PresentationRecord,
  SendOutboxEntry,
  TaskRepository,
} from '../task/repository';
import type { MusterTask, TaskMessage, TaskTurn } from '../task/types';

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

export function isUatModeEnabled(
  isProductionExtension: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isProductionExtension && env[UAT_MODE_ENV] === '1';
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
    dependencies: [],
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
