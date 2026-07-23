import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from '../task/repository';
import { RepositoryProjection, withRepositoryProjection } from '../task/repository-projection';
import type { MusterTask } from '../task/types';
import { DbClient } from '../task/sqlite/client';
import {
  reconcileExternalWorkspaceChanges,
  reconcileInterleavedLocalCommit,
  type ExternalReconcileResult,
} from './external-workspace-reconciler';

function makeTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'draft',
    goal: id,
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

async function openPair(retain = 64) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-external-reconcile-'));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const workerPath = path.join(__dirname, '../task/sqlite/worker.ts');
  const aClient = new DbClient({ workerPath, execArgv: ['--import', 'tsx'] });
  const bClient = new DbClient({ workerPath, execArgv: ['--import', 'tsx'] });
  await aClient.open(dbPath);
  await bClient.open(dbPath);
  const a = new SqliteTaskRepository(aClient, 'ws', { changeFeedRetainRevisions: retain });
  const b = new SqliteTaskRepository(bClient, 'ws', { changeFeedRetainRevisions: retain });
  await a.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: 'pair',
    displayName: 'Pair',
    createdAt: 'now',
    lastOpenedAt: 'now',
  });
  return {
    dir,
    a,
    b,
    aClient,
    bClient,
    async close() {
      await Promise.all([aClient.close(), bClient.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('external workspace reconciler', () => {
  it('repairs a peer revision serialized immediately before a local commit', async () => {
    const pair = await openPair();
    try {
      const projectionA = await RepositoryProjection.load(pair.a, 'ws');
      let repaired: ExternalReconcileResult | undefined;
      const wrappedA = withRepositoryProjection(pair.a, projectionA, {
        onAfterCommit: async (ctx) => {
          repaired = await reconcileInterleavedLocalCommit({
            repository: pair.a,
            projection: ctx.projection,
            previousRevision: ctx.previousRevision,
            afterRevision: ctx.previousRevision,
            knownTranscriptIds: new Set(),
            beforeProjection: ctx.beforeFile,
          });
        },
      });

      await wrappedA.execute({
        kind: 'createTask', workspaceId: 'ws', task: makeTask('local-before'),
      });
      expect(repaired).toBeUndefined();
      await pair.b.execute({
        kind: 'createTask', workspaceId: 'ws', task: makeTask('peer-between'),
      });
      await wrappedA.execute({
        kind: 'createTask', workspaceId: 'ws', task: makeTask('local-after'),
      });

      expect(repaired?.kind).toBe('batches');
      if (!repaired || repaired.kind !== 'batches') return;
      expect(repaired.batches.map((batch) => batch.revision)).toEqual([3, 4]);
      expect(Object.keys(projectionA.getFile().tasks).sort()).toEqual([
        'local-after',
        'local-before',
        'peer-between',
      ]);
      const upserted = repaired.batches.flatMap((batch) => batch.patches)
        .filter((patch) => patch.type === 'taskUpserted')
        .map((patch) => patch.task.id)
        .sort();
      expect(upserted).toEqual(['local-after', 'peer-between']);
      expect(projectionA.getFile().revision).toBe(4);
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('keeps a pre-hydrated peer task visible in the reconciled patch', async () => {
    const pair = await openPair();
    try {
      const projection = await RepositoryProjection.load(pair.b, 'ws');
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('prehydrated-peer') });
      await projection.refreshTask('prehydrated-peer');

      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection,
        afterRevision: 1,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]?.patches).toEqual([
        expect.objectContaining({ type: 'turnActivityChanged', task: expect.objectContaining({ id: 'prehydrated-peer' }) }),
      ]);
      expect(projection.getFile().revision).toBe(2);
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('converges two clients with interleaved writes via feed without full transcript list', async () => {
    const pair = await openPair();
    try {
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const listMessages = vi.spyOn(pair.b, 'listMessages');
      const listToolCalls = vi.spyOn(pair.b, 'listToolCalls');
      const listReasoning = vi.spyOn(pair.b, 'listReasoning');

      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('t1') });
      await pair.b.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('t2') });
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('t3') });

      const afterA = await pair.a.getWorkspaceRevision();
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: 1,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      expect(result.appliedRevision).toBe(afterA);
      expect(listMessages).not.toHaveBeenCalled();
      expect(listToolCalls).not.toHaveBeenCalled();
      expect(listReasoning).not.toHaveBeenCalled();
      expect(result.batches.at(-1)?.revision).toBe(afterA);
      expect(Object.keys(projectionB.getFile().tasks).sort()).toEqual(['t1', 't2', 't3']);
      expect(await pair.a.getWorkspaceRevision()).toBe(await pair.b.getWorkspaceRevision());
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('expands the feed when a peer commits during hydration instead of skipping that revision', async () => {
    const pair = await openPair();
    try {
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('first') });

      const original = pair.b.listTasksByIds.bind(pair.b);
      let injected = false;
      vi.spyOn(pair.b, 'listTasksByIds').mockImplementation(async (ids) => {
        const rows = await original(ids);
        if (!injected) {
          injected = true;
          await pair.a.execute({
            kind: 'createTask',
            workspaceId: 'ws',
            task: makeTask('committed-during-hydration'),
          });
        }
        return rows;
      });

      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: 1,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      const durableRevision = await pair.b.getWorkspaceRevision();
      expect(result.appliedRevision).toBe(durableRevision);
      expect(result.batches.map((batch) => batch.revision)).toEqual(
        Array.from({ length: durableRevision - 1 }, (_, index) => index + 2),
      );
      expect(Object.keys(projectionB.getFile().tasks).sort()).toEqual([
        'committed-during-hydration',
        'first',
      ]);
      expect(projectionB.getFile().revision).toBe(durableRevision);
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('surfaces a queued follow-up user message when a peer promotes only the turn row', async () => {
    const pair = await openPair();
    try {
      const task = makeTask('promote-focus');
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await pair.a.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: {
          id: 'old-turn', taskId: task.id, sequence: 1, status: 'succeeded', trigger: 'user',
          inputs: [], createdAt: '2026-07-16T00:00:01.000Z', finishedAt: '2026-07-16T00:00:02.000Z',
        },
      });
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const beforeQueue = await pair.a.getWorkspaceRevision();
      // Create the turn before binding its input message so composite FKs stay valid.
      await pair.a.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: {
          id: 'follow-turn', taskId: task.id, sequence: 2, status: 'queued', trigger: 'user',
          inputs: [], createdAt: '2026-07-16T00:00:03.000Z',
        },
      });
      await pair.a.execute({
        kind: 'upsertMessage',
        workspaceId: 'ws',
        message: {
          // Production host sends bind user messages through turn_inputs; the
          // message row itself has no turn_id.
          id: 'follow-message', taskId: task.id, role: 'user',
          content: 'run next', state: 'pending', createdAt: '2026-07-16T00:00:03.000Z',
        },
      });
      await pair.a.execute({
        kind: 'upsertTurn',
        workspaceId: 'ws',
        turn: {
          id: 'follow-turn', taskId: task.id, sequence: 2, status: 'queued', trigger: 'user',
          inputs: [{ kind: 'message', messageId: 'follow-message' }],
          createdAt: '2026-07-16T00:00:03.000Z',
        },
      });

      const queued = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: beforeQueue,
        focusedTaskId: task.id,
        knownTranscriptIds: new Set(),
      });
      expect(queued.kind).toBe('batches');
      if (queued.kind !== 'batches') return;
      expect(
        queued.batches.flatMap((batch) => batch.patches).some((patch) =>
          patch.type === 'transcriptItemsAppended' &&
          patch.items.some((item) => item.id === 'follow-message'),
        ),
      ).toBe(false);

      const beforePromote = await pair.a.getWorkspaceRevision();
      await pair.a.execute({
        kind: 'promoteTurn',
        workspaceId: 'ws',
        turnId: 'follow-turn',
        startedAt: '2026-07-16T00:00:04.000Z',
      });
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: beforePromote,
        focusedTaskId: task.id,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      const final = result.batches.at(-1);
      expect(final?.patches).toContainEqual(expect.objectContaining({
        type: 'transcriptItemsAppended',
        taskId: task.id,
        items: [expect.objectContaining({
          id: 'follow-message',
          kind: 'user',
          turnId: 'follow-turn',
        })],
      }));
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('advances coordination-only revisions without a workspace-wide projection refresh', async () => {
    const pair = await openPair();
    try {
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const afterRevision = projectionB.getFile().revision;
      const refreshAll = vi.spyOn(projectionB, 'refreshAll');
      await pair.a.execute({
        kind: 'putSendOutbox',
        workspaceId: 'ws',
        entry: {
          clientRequestId: 'coord-only',
          status: 'pending',
          payload: { version: 1, text: 'draft' },
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      });
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      expect(refreshAll).not.toHaveBeenCalled();
      expect(projectionB.getFile().revision).toBe(await pair.b.getWorkspaceRevision());
    } finally {
      await pair.close();
    }
  }, 20_000);

  it('emits empty intermediate batches and hydrates focused transcript by id only', async () => {
    const pair = await openPair();
    try {
      const task = makeTask('focus');
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const turn = {
        id: 'turn-1',
        taskId: task.id,
        sequence: 1,
        status: 'running' as const,
        trigger: 'user' as const,
        inputs: [],
        createdAt: '2026-07-16T00:00:01.000Z',
      };
      await pair.a.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      const afterTurn = await pair.a.getWorkspaceRevision();
      await pair.a.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [{
          id: 'm1',
          taskId: task.id,
          turnId: turn.id,
          role: 'assistant' as const,
          content: 'hello',
          state: 'partial' as const,
          order: 0,
          createdAt: '2026-07-16T00:00:02.000Z',
        }],
      });
      await pair.a.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [{
          id: 'm1',
          taskId: task.id,
          turnId: turn.id,
          role: 'assistant' as const,
          content: 'hello world',
          state: 'partial' as const,
          order: 0,
          createdAt: '2026-07-16T00:00:02.000Z',
        }],
      });

      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const listMessages = vi.spyOn(pair.b, 'listMessages');
      const listByIds = vi.spyOn(pair.b, 'listMessagesByIds');

      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: afterTurn,
        focusedTaskId: task.id,
        knownTranscriptIds: new Set(['m1']),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      expect(listMessages).not.toHaveBeenCalled();
      expect(listByIds).toHaveBeenCalled();
      const final = result.batches.at(-1)!;
      expect(final.patches.some((p) => p.type === 'transcriptItemPatched')).toBe(true);
      if (result.batches.length > 1) {
        expect(result.batches.slice(0, -1).every((b) => b.patches.length === 0)).toBe(true);
      }
      expect(projectionB.getFile().messages.m1?.content).toBe('hello world');
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('returns gap after prune and does not invent patches', async () => {
    const pair = await openPair(2);
    try {
      for (let i = 0; i < 5; i += 1) {
        await pair.a.execute({
          kind: 'createTask',
          workspaceId: 'ws',
          task: makeTask(`g-${i}`),
        });
      }
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: 0,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('gap');
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('does not N+1 task activity queries when reconciling many affected tasks', async () => {
    const pair = await openPair();
    try {
      for (let i = 0; i < 8; i += 1) {
        await pair.a.execute({
          kind: 'createTask',
          workspaceId: 'ws',
          task: makeTask(`n-${i}`),
        });
      }
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const activity = vi.spyOn(pair.b, 'listTurnActivityForTasks');
      const inputs = vi.spyOn(pair.b, 'listActiveTurnInputMessages');
      const listTasksByIds = vi.spyOn(pair.b, 'listTasksByIds');
      const getTask = vi.spyOn(pair.b, 'getTask');
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: 1,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      expect(activity.mock.calls.length).toBeLessThanOrEqual(2);
      expect(inputs.mock.calls.length).toBeLessThanOrEqual(2);
      expect(listTasksByIds.mock.calls.length).toBeLessThanOrEqual(2);
      expect(getTask).not.toHaveBeenCalled();
      if (activity.mock.calls[0]) {
        expect(activity.mock.calls[0][0].length).toBeGreaterThan(1);
      }
      if (listTasksByIds.mock.calls[0]) {
        expect(listTasksByIds.mock.calls[0][0].length).toBeGreaterThan(1);
      }
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('treats send_outbox without taskId as coordination (no recovery storm)', async () => {
    const pair = await openPair();
    try {
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('t1') });
      const afterTask = await pair.a.getWorkspaceRevision();
      await pair.a.execute({
        kind: 'putSendOutbox',
        workspaceId: 'ws',
        entry: {
          clientRequestId: 'cr-1',
          status: 'pending',
          payload: { version: 1, text: 'hello' },
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      });
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: afterTask,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      expect(result.batches.at(-1)?.patches ?? []).toEqual([]);
    } finally {
      await pair.close();
    }
  }, 20_000);

  it('emits a bounded remove patch when a known focused transcript entity is deleted', async () => {
    const pair = await openPair();
    try {
      const task = makeTask('focus');
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await pair.a.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [{
          id: 'm-del',
          taskId: task.id,
          role: 'user' as const,
          content: 'bye',
          state: 'assigned' as const,
          createdAt: '2026-07-16T00:00:01.000Z',
        }],
      });
      const afterAppend = await pair.a.getWorkspaceRevision();
      await pair.a.execute({
        kind: 'deleteMessage',
        workspaceId: 'ws',
        messageId: 'm-del',
      });
      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: afterAppend,
        focusedTaskId: task.id,
        knownTranscriptIds: new Set(['m-del']),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      expect(result.batches.at(-1)?.patches).toContainEqual({
        type: 'transcriptItemsRemoved',
        taskId: task.id,
        itemIds: ['m-del'],
      });
    } finally {
      await pair.close();
    }
  }, 30_000);

  it('keeps local writer from duplicating its own revision when applied cursor is current', async () => {
    const pair = await openPair();
    try {
      const projection = await RepositoryProjection.load(pair.a, 'ws');
      const wrapped = withRepositoryProjection(pair.a, projection);
      await wrapped.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('local') });
      const rev = await pair.a.getWorkspaceRevision();
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.a,
        projection,
        afterRevision: rev,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      if (result.kind !== 'batches') return;
      expect(result.batches).toEqual([]);
    } finally {
      await pair.close();
    }
  }, 20_000);

  it('long transcript fixture does not list full history on external reconcile', async () => {
    const pair = await openPair();
    try {
      const task = makeTask('long');
      await pair.a.execute({ kind: 'createTask', workspaceId: 'ws', task });
      // Seed many historical messages via direct SQL would bypass feed; use a few
      // appends then spy that listMessages is never called on peer reconcile.
      for (let i = 0; i < 5; i += 1) {
        await pair.a.execute({
          kind: 'appendTranscriptBatch',
          workspaceId: 'ws',
          taskId: task.id,
          messages: [{
            id: `msg-${i}`,
            taskId: task.id,
            role: 'user' as const,
            content: `m${i}`,
            state: 'assigned' as const,
            createdAt: `2026-07-16T00:00:0${i}.000Z`,
          }],
        });
      }
      const afterSeed = await pair.a.getWorkspaceRevision();
      await pair.a.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [{
          id: 'msg-new',
          taskId: task.id,
          role: 'assistant' as const,
          content: 'latest',
          state: 'complete' as const,
          order: 0,
          createdAt: '2026-07-16T00:01:00.000Z',
        }],
      });

      const projectionB = await RepositoryProjection.load(pair.b, 'ws');
      const listMessages = vi.spyOn(pair.b, 'listMessages');
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: afterSeed,
        focusedTaskId: task.id,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      expect(listMessages).not.toHaveBeenCalled();
      if (result.kind !== 'batches') return;
      const final = result.batches.at(-1)!;
      const append = final.patches.find((p) => p.type === 'transcriptItemsAppended');
      expect(append && append.type === 'transcriptItemsAppended' && append.items.some((i) => i.id === 'msg-new')).toBe(true);
    } finally {
      await pair.close();
    }
  }, 30_000);
});
