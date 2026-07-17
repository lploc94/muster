import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from '../task/repository';
import { RepositoryProjection, withRepositoryProjection } from '../task/repository-projection';
import type { MusterTask } from '../task/types';
import { DbClient } from '../task/sqlite/client';
import { reconcileExternalWorkspaceChanges } from './external-workspace-reconciler';

function makeTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'draft',
    goal: id,
    parentId: null,
    dependencies: [],
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
      const result = await reconcileExternalWorkspaceChanges({
        repository: pair.b,
        projection: projectionB,
        afterRevision: 1,
        knownTranscriptIds: new Set(),
      });
      expect(result.kind).toBe('batches');
      expect(activity.mock.calls.length).toBeLessThanOrEqual(2);
      expect(inputs.mock.calls.length).toBeLessThanOrEqual(2);
      if (activity.mock.calls[0]) {
        expect(activity.mock.calls[0][0].length).toBeGreaterThan(1);
      }
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
