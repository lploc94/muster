import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepositoryProjection, withRepositoryProjection } from './repository-projection';
import { activeTurnInputMessagesSql, SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask, TaskTurn } from './types';

function makeTask(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: id,
    parentId: null,
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: { maxTurns: 100, maxAutomaticRetries: 0 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeTurn(
  id: string,
  taskId: string,
  sequence: number,
  status: TaskTurn['status'],
  overrides: Partial<TaskTurn> = {},
): TaskTurn {
  return {
    id,
    taskId,
    sequence,
    status,
    trigger: 'user',
    inputs: [],
    createdAt: `2026-07-16T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

async function withRepo<T>(
  name: string,
  fn: (repo: SqliteTaskRepository, client: DbClient) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-${name}-`));
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  try {
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repo = new SqliteTaskRepository(client, 'ws');
    await repo.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: name,
      displayName: name,
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    return await fn(repo, client);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Bulk-seed N terminal turns for one task without named-command overhead. */
async function seedTerminalTurns(
  client: DbClient,
  taskId: string,
  count: number,
): Promise<void> {
  const BATCH = 200;
  for (let start = 1; start <= count; start += BATCH) {
    const stmts = [];
    for (let i = start; i < start + BATCH && i <= count; i++) {
      const ts = `2026-07-16T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
      stmts.push({
        sql: `INSERT INTO turns (id, workspace_id, task_id, sequence, status, trigger, created_at, settled_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [
          `term-${i}`,
          'ws',
          taskId,
          i,
          'succeeded',
          'engine',
          ts,
          ts,
          JSON.stringify({ payloadVersion: 1, inputs: [] }),
        ],
      });
    }
    await client.transaction(stmts);
  }
}

/** Bulk-seed N assistant messages on a single terminal turn. */
async function seedBulkMessages(
  client: DbClient,
  taskId: string,
  turnId: string,
  count: number,
): Promise<void> {
  const BATCH = 500;
  for (let start = 1; start <= count; start += BATCH) {
    const stmts = [];
    for (let i = start; i < start + BATCH && i <= count; i++) {
      const ts = `2026-07-16T00:00:${String(Math.floor(i / 1000)).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`;
      stmts.push({
        sql: `INSERT INTO messages (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [
          `msg-${i}`,
          'ws',
          taskId,
          turnId,
          'assistant',
          'complete',
          i,
          `content ${i}`,
          ts,
          JSON.stringify({ payloadVersion: 1 }),
        ],
      });
    }
    await client.transaction(stmts);
  }
}

describe('RepositoryProjection — bounded activation (P4-W4 A)', () => {
  it('loads only activity turns + active input messages, never full transcript', async () => {
    await withRepo('projection-activation', async (repo, client) => {
      const task = makeTask('big-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      // 200 terminal turns + 10k messages on the latest one — full history would blow memory.
      await seedTerminalTurns(client, task.id, 200);
      await seedBulkMessages(client, task.id, 'term-200', 10_000);
      // Live coordination surface: one running turn + its input + op/claim/cancel.
      const liveMsg = {
        id: 'live-input',
        taskId: task.id,
        role: 'user' as const,
        content: 'live prompt',
        state: 'assigned' as const,
        createdAt: '2026-07-16T01:00:00.000Z',
      };
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 201, 'running', {
          inputs: [{ kind: 'message', messageId: liveMsg.id }],
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: liveMsg });
      await repo.execute({
        kind: 'putOperation',
        workspaceId: 'ws',
        ledgerKey: 'live-turn:op',
        entry: { fingerprint: 'fp', result: { ok: true, data: { live: true } } },
        createdAt: 'now',
      });
      await repo.execute({
        kind: 'claimRuntime',
        workspaceId: 'ws',
        turnId: 'live-turn',
        ownerId: 'owner',
        claimedAt: 'now',
        heartbeatAt: 'now',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await repo.execute({
        kind: 'putCancelRequest',
        workspaceId: 'ws',
        turnId: 'live-turn',
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-op', at: 'now' },
      });

      const listTurns = vi.spyOn(repo, 'listTurns');
      const listTurnsForTasks = vi.spyOn(repo, 'listTurnsForTasks');
      const listMessages = vi.spyOn(repo, 'listMessages');
      const listToolCalls = vi.spyOn(repo, 'listToolCalls');
      const listReasoning = vi.spyOn(repo, 'listReasoning');
      const listActivity = vi.spyOn(repo, 'listTurnActivityForTasks');
      const listActiveInputs = vi.spyOn(repo, 'listActiveTurnInputMessages');

      const projection = await RepositoryProjection.load(repo, 'ws');
      const file = projection.getFile();

      // No full-hydration helpers.
      expect(listTurns).not.toHaveBeenCalled();
      expect(listTurnsForTasks).not.toHaveBeenCalled();
      expect(listMessages).not.toHaveBeenCalled();
      expect(listToolCalls).not.toHaveBeenCalled();
      expect(listReasoning).not.toHaveBeenCalled();
      // Bounded helpers used once for the workspace task set.
      expect(listActivity).toHaveBeenCalledTimes(1);
      expect(listActiveInputs).toHaveBeenCalledTimes(1);

      // Activity: latest terminal + the live turn (not all 200 terminals).
      const projectedTurns = Object.values(file.turns).filter((t) => t.taskId === task.id);
      expect(projectedTurns.map((t) => t.id).sort()).toEqual(['live-turn', 'term-200']);
      // Only the active-turn input message — not 10k historical ones.
      expect(Object.keys(file.messages)).toEqual(['live-input']);
      expect(file.toolCalls).toEqual({});
      expect(file.reasoning).toEqual({});
      // Coordination rows for the live turn are hydrated.
      expect(file.operations?.['live-turn:op']?.result.data).toEqual({ live: true });
      expect(file.runtimeClaims?.['live-turn']?.ownerId).toBe('owner');
      expect(file.cancelRequests?.['live-turn']?.opId).toBe('cancel-op');
    });
  }, 30_000);
});

describe('RepositoryProjection — bounded after-write refresh (P4-W4 B)', () => {
  it('serializes concurrent execute → refresh → publish lifecycles by revision', async () => {
    await withRepo('projection-concurrent-publish', async (repo) => {
      const projection = await RepositoryProjection.load(repo, 'ws');
      const baseRevision = projection.getFile().revision;
      const publications: Array<{
        previousRevision: number;
        beforeRevision: number;
        afterRevision: number;
        commandTaskId: string;
        visibleTaskIds: string[];
      }> = [];
      const wrapped = withRepositoryProjection(repo, projection, {
        onAfterCommit: async (ctx) => {
          const commandTaskId =
            'task' in ctx.command && ctx.command.task ? ctx.command.task.id : 'unknown';
          publications.push({
            previousRevision: ctx.previousRevision,
            beforeRevision: ctx.beforeFile.revision,
            afterRevision: ctx.projection.getFile().revision,
            commandTaskId,
            visibleTaskIds: Object.keys(ctx.projection.getFile().tasks).sort(),
          });
        },
      });

      await Promise.all([
        wrapped.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('a') }),
        wrapped.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('b') }),
      ]);

      expect(publications).toEqual([
        {
          previousRevision: baseRevision,
          beforeRevision: baseRevision,
          afterRevision: baseRevision + 1,
          commandTaskId: 'a',
          visibleTaskIds: ['a'],
        },
        {
          previousRevision: baseRevision + 1,
          beforeRevision: baseRevision + 1,
          afterRevision: baseRevision + 2,
          commandTaskId: 'b',
          visibleTaskIds: ['a', 'b'],
        },
      ]);
    });
  }, 20_000);

  it('refreshTask keeps only activity turns and active inputs after a write', async () => {
    await withRepo('projection-after-write', async (repo, client) => {
      const task = makeTask('write-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await seedTerminalTurns(client, task.id, 50);
      // Opening: one queued follow-up with input message.
      const qMsg = {
        id: 'q-msg',
        taskId: task.id,
        role: 'user' as const,
        content: 'queued follow-up',
        state: 'pending' as const,
        createdAt: '2026-07-16T02:00:00.000Z',
      };
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('q-turn', task.id, 51, 'queued', {
          inputs: [{ kind: 'message', messageId: qMsg.id }],
        }),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: qMsg });

      const projection = await RepositoryProjection.load(repo, 'ws');
      const wrapped = withRepositoryProjection(repo, projection);

      const listTurns = vi.spyOn(repo, 'listTurns');
      const listMessages = vi.spyOn(repo, 'listMessages');
      const listToolCalls = vi.spyOn(repo, 'listToolCalls');
      const listReasoning = vi.spyOn(repo, 'listReasoning');

      // A write that touches the task must re-bound the projection, not rehydrate history.
      await wrapped.execute({
        kind: 'upsertTurn',
        workspaceId: 'ws',
        turn: makeTurn('q-turn', task.id, 51, 'queued', {
          inputs: [{ kind: 'message', messageId: qMsg.id }],
          holdAutoPromote: true,
        }),
      });

      expect(listTurns).not.toHaveBeenCalled();
      expect(listMessages).not.toHaveBeenCalled();
      expect(listToolCalls).not.toHaveBeenCalled();
      expect(listReasoning).not.toHaveBeenCalled();

      const file = projection.getFile();
      const projectedTurns = Object.values(file.turns).filter((t) => t.taskId === task.id);
      // Latest terminal + queued activity only.
      expect(projectedTurns.map((t) => t.id).sort()).toEqual(['q-turn', 'term-50']);
      expect(Object.keys(file.messages)).toEqual(['q-msg']);
      expect(file.toolCalls).toEqual({});
      expect(file.reasoning).toEqual({});
      expect(file.turns['q-turn']?.holdAutoPromote).toBe(true);
    });
  }, 20_000);

  it('preserves runtimeClaims and cancelRequests across appendTranscriptBatch', async () => {
    await withRepo('projection-coord-preserve', async (repo) => {
      const task = makeTask('coord-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const liveMsg = {
        id: 'live-msg',
        taskId: task.id,
        role: 'user' as const,
        content: 'live',
        state: 'assigned' as const,
        createdAt: '2026-07-16T01:00:00.000Z',
      };
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 1, 'running', {
          inputs: [{ kind: 'message', messageId: liveMsg.id }],
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: liveMsg });
      await repo.execute({
        kind: 'claimRuntime',
        workspaceId: 'ws',
        turnId: 'live-turn',
        ownerId: 'owner-1',
        claimedAt: 'now',
        heartbeatAt: 'now',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await repo.execute({
        kind: 'putCancelRequest',
        workspaceId: 'ws',
        turnId: 'live-turn',
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-1', at: 'now' },
      });

      const projection = await RepositoryProjection.load(repo, 'ws');
      const wrapped = withRepositoryProjection(repo, projection);
      expect(projection.getFile().runtimeClaims?.['live-turn']?.ownerId).toBe('owner-1');
      expect(projection.getFile().cancelRequests?.['live-turn']?.opId).toBe('cancel-1');

      // Ordinary transcript write must NOT drop coordination for the still-live turn.
      await wrapped.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [
          {
            id: 'a1',
            taskId: task.id,
            role: 'assistant',
            content: 'delta',
            state: 'complete',
            createdAt: '2026-07-16T01:00:01.000Z',
            turnId: 'live-turn',
            order: 0,
          },
        ],
      });

      expect(projection.getFile().runtimeClaims?.['live-turn']?.ownerId).toBe('owner-1');
      expect(projection.getFile().cancelRequests?.['live-turn']?.opId).toBe('cancel-1');
      // Durable DB still has them.
      await expect(repo.getRuntimeClaim('live-turn')).resolves.toMatchObject({ ownerId: 'owner-1' });
      await expect(repo.getCancelRequest('live-turn')).resolves.toMatchObject({ opId: 'cancel-1' });
    });
  }, 20_000);

  it('preserves claim/cancel across replaceLiveTurn (active-turn write)', async () => {
    await withRepo('projection-coord-replace-live', async (repo) => {
      const task = makeTask('replace-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 1, 'running', {
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({
        kind: 'claimRuntime',
        workspaceId: 'ws',
        turnId: 'live-turn',
        ownerId: 'owner-2',
        claimedAt: 'now',
        heartbeatAt: 'now',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await repo.execute({
        kind: 'putCancelRequest',
        workspaceId: 'ws',
        turnId: 'live-turn',
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-2', at: 'now' },
      });

      const projection = await RepositoryProjection.load(repo, 'ws');
      const wrapped = withRepositoryProjection(repo, projection);
      await wrapped.execute({
        kind: 'replaceLiveTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 1, 'running', {
          startedAt: '2026-07-16T01:00:00.000Z',
          dispatchPhase: 'prompt_outstanding',
        }),
        expectedStatuses: ['running', 'waiting_user'],
      });
      expect(projection.getFile().runtimeClaims?.['live-turn']?.ownerId).toBe('owner-2');
      expect(projection.getFile().cancelRequests?.['live-turn']?.opId).toBe('cancel-2');
    });
  }, 20_000);

  it('reloads coordination with constant batched queries (no N+1)', async () => {
    await withRepo('projection-coord-batched', async (repo) => {
      const task = makeTask('batch-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      // Many active turns: one running + many queued followers.
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-0', task.id, 1, 'running', {
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({
        kind: 'claimRuntime',
        workspaceId: 'ws',
        turnId: 'live-0',
        ownerId: 'owner-batch',
        claimedAt: 'now',
        heartbeatAt: 'now',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await repo.execute({
        kind: 'putCancelRequest',
        workspaceId: 'ws',
        turnId: 'live-0',
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-batch', at: 'now' },
      });
      for (let i = 1; i <= 20; i++) {
        await repo.execute({
          kind: 'createTurn',
          workspaceId: 'ws',
          turn: makeTurn(`q-${i}`, task.id, i + 1, 'queued'),
        });
      }

      const projection = await RepositoryProjection.load(repo, 'ws');
      const wrapped = withRepositoryProjection(repo, projection);

      const getCancel = vi.spyOn(repo, 'getCancelRequest');
      const getClaim = vi.spyOn(repo, 'getRuntimeClaim');
      const listOps = vi.spyOn(repo, 'listOperationsForTurns');
      const listCancels = vi.spyOn(repo, 'listCancelRequestsForTurns');
      const listClaims = vi.spyOn(repo, 'listRuntimeClaimsForTurns');

      await wrapped.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [
          {
            id: 'a-batch',
            taskId: task.id,
            role: 'assistant',
            content: 'delta',
            state: 'complete',
            createdAt: '2026-07-16T01:00:01.000Z',
            turnId: 'live-0',
            order: 0,
          },
        ],
      });

      // Exactly one of each batched query; zero per-turn fan-out.
      expect(listOps).toHaveBeenCalledTimes(1);
      expect(listCancels).toHaveBeenCalledTimes(1);
      expect(listClaims).toHaveBeenCalledTimes(1);
      expect(getCancel).not.toHaveBeenCalled();
      expect(getClaim).not.toHaveBeenCalled();
      // Batched input includes all active turn ids (running + 20 queued).
      const cancelArg = listCancels.mock.calls[0]![0] as string[];
      expect(cancelArg).toHaveLength(21);
      expect(projection.getFile().runtimeClaims?.['live-0']?.ownerId).toBe('owner-batch');
      expect(projection.getFile().cancelRequests?.['live-0']?.opId).toBe('cancel-batch');
    });
  }, 20_000);

  it('processCancelRequests consumes claim/cancel after appendTranscriptBatch', async () => {
    await withRepo('projection-cancel-consume', async (repo) => {
      const { processCancelRequests } = await import('./engine-graph');
      const task = makeTask('consume-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 1, 'running', {
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({
        kind: 'claimRuntime',
        workspaceId: 'ws',
        turnId: 'live-turn',
        ownerId: 'owner-consume',
        claimedAt: 'now',
        heartbeatAt: 'now',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await repo.execute({
        kind: 'putCancelRequest',
        workspaceId: 'ws',
        turnId: 'live-turn',
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-consume', at: 'now' },
      });

      const projection = await RepositoryProjection.load(repo, 'ws');
      const wrapped = withRepositoryProjection(repo, projection);

      // Ordinary write must not drop coordination before the consumer runs.
      await wrapped.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [
          {
            id: 'a-consume',
            taskId: task.id,
            role: 'assistant',
            content: 'streaming',
            state: 'complete',
            createdAt: '2026-07-16T01:00:01.000Z',
            turnId: 'live-turn',
            order: 0,
          },
        ],
      });
      expect(projection.getFile().cancelRequests?.['live-turn']?.opId).toBe('cancel-consume');
      expect(projection.getFile().runtimeClaims?.['live-turn']?.ownerId).toBe('owner-consume');

      await processCancelRequests({
        store: projection,
        repository: wrapped,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        credentials: { issue: () => '', verify: () => undefined, revoke: () => {} } as never,
        askBridge: { cancelForTurn: () => {} } as never,
        bridgePort: 0,
        liveRuns: new Map(),
        pendingAskPromises: new Map(),
        onScheduleTurn: () => {},
        leaseOwnerAlive: () => true,
        ownsLease: (turnId) =>
          projection.getFile().runtimeClaims?.[turnId]?.ownerId === 'owner-consume',
        runtimeOwnerId: 'owner-consume',
        writeCancelRequest: () => {},
        clock: () => '2026-07-16T01:00:02.000Z',
      });

      // Durable SQLite and projection agree: request + claim consumed, turn interrupted.
      await expect(repo.getCancelRequest('live-turn')).resolves.toBeUndefined();
      await expect(repo.getRuntimeClaim('live-turn')).resolves.toBeUndefined();
      expect(projection.getFile().cancelRequests?.['live-turn']).toBeUndefined();
      expect(projection.getFile().runtimeClaims?.['live-turn']).toBeUndefined();
      await expect(repo.getTurn('live-turn')).resolves.toMatchObject({ status: 'interrupted' });
      expect(projection.getFile().turns['live-turn']?.status).toBe('interrupted');
    });
  }, 20_000);

  it('drops claim/cancel from projection when the live turn settles', async () => {
    await withRepo('projection-coord-settle', async (repo) => {
      const task = makeTask('settle-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 1, 'running', {
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({
        kind: 'claimRuntime',
        workspaceId: 'ws',
        turnId: 'live-turn',
        ownerId: 'owner-3',
        claimedAt: 'now',
        heartbeatAt: 'now',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await repo.execute({
        kind: 'putCancelRequest',
        workspaceId: 'ws',
        turnId: 'live-turn',
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-3', at: 'now' },
      });

      const projection = await RepositoryProjection.load(repo, 'ws');
      const wrapped = withRepositoryProjection(repo, projection);
      // Settle the live turn → no longer active → coordination must leave projection.
      await wrapped.execute({
        kind: 'upsertTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 1, 'succeeded', {
          startedAt: '2026-07-16T01:00:00.000Z',
          finishedAt: '2026-07-16T01:00:05.000Z',
        }),
      });
      // Projection no longer lists claim/cancel for the terminal turn.
      expect(projection.getFile().runtimeClaims?.['live-turn']).toBeUndefined();
      expect(projection.getFile().cancelRequests?.['live-turn']).toBeUndefined();
    });
  }, 20_000);
});

describe('listActiveTurnInputMessages — task-scoped query plan (P4-W4 residual)', () => {
  it('drives from active turns and never scans message history first', async () => {
    await withRepo('active-input-plan', async (repo, client) => {
      const task = makeTask('target-task');
      const sibling = makeTask('sibling-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: sibling });

      // 10k historical messages + turn_inputs on a terminal turn.
      await client.run(
        `INSERT INTO turns (id, workspace_id, task_id, sequence, status, trigger, created_at, settled_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          'hist-turn',
          'ws',
          task.id,
          1,
          'succeeded',
          'engine',
          '2026-07-16T00:00:00.000Z',
          '2026-07-16T00:00:00.000Z',
          JSON.stringify({ payloadVersion: 1, inputs: [] }),
        ],
      );
      const BATCH = 500;
      for (let start = 1; start <= 10_000; start += BATCH) {
        const stmts = [];
        for (let i = start; i < start + BATCH && i <= 10_000; i++) {
          stmts.push({
            sql: `INSERT INTO messages (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, payload_json)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`,
            params: [
              `hist-msg-${i}`,
              'ws',
              task.id,
              'hist-turn',
              'assistant',
              'complete',
              i,
              `h${i}`,
              '2026-07-16T00:00:00.000Z',
              JSON.stringify({ payloadVersion: 1 }),
            ],
          });
          stmts.push({
            sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
                  VALUES (?,?,?,?,?)`,
            params: [
              'ws',
              'hist-turn',
              i,
              'message',
              JSON.stringify({ payloadVersion: 1, kind: 'message', messageId: `hist-msg-${i}` }),
            ],
          });
        }
        await client.transaction(stmts);
      }

      // One active input on a running turn.
      const liveMsg = {
        id: 'active-only',
        taskId: task.id,
        role: 'user' as const,
        content: 'active',
        state: 'assigned' as const,
        createdAt: '2026-07-16T01:00:00.000Z',
      };
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 2, 'running', {
          inputs: [{ kind: 'message', messageId: liveMsg.id }],
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: liveMsg });

      // Sibling noise.
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('sib-live', sibling.id, 1, 'running', {
          inputs: [{ kind: 'message', messageId: 'sib-msg' }],
          startedAt: '2026-07-16T01:00:00.000Z',
        }),
      });
      await repo.execute({
        kind: 'appendMessage',
        workspaceId: 'ws',
        message: {
          id: 'sib-msg',
          taskId: sibling.id,
          role: 'user',
          content: 'sibling',
          state: 'assigned',
          createdAt: '2026-07-16T01:00:00.000Z',
        },
      });

      const rows = await repo.listActiveTurnInputMessages([task.id]);
      expect(rows.map((m) => m.id)).toEqual(['active-only']);
      expect(rows.every((m) => m.id !== 'sib-msg')).toBe(true);
      expect(rows.every((m) => !m.id.startsWith('hist-msg-'))).toBe(true);

      const params = ['ws', task.id, task.id];
      const plan = await client.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${activeTurnInputMessagesSql(1)}`,
        params,
      );
      const details = plan.map((r) => r.detail).join('\n');
      // eslint-disable-next-line no-console
      console.log('[active-input plan]\n' + details);

      // Must materialize the active-turn driver.
      expect(details).toMatch(/MATERIALIZE active_turns/);
      // No full scan of messages/turn_inputs.
      expect(details).not.toMatch(/SCAN (messages|turn_inputs)\b/);
      // No workspace-only seek on turn_inputs (must include turn_id).
      expect(details).not.toMatch(
        /USING INDEX idx_turn_inputs_turn_order \(workspace_id=\?\)(?! AND turn_id)/,
      );
      // Require task-scoped turns seek + (workspace, turn_id) on inputs + PK on messages.
      expect(details).toMatch(
        /SEARCH \w+ USING (COVERING )?INDEX idx_turns_task_sequence \(workspace_id=\? AND task_id=\?\)/,
      );
      expect(details).toMatch(
        /USING INDEX idx_turn_inputs_turn_order \(workspace_id=\? AND turn_id=\?\)/,
      );
      expect(details).toMatch(
        /SEARCH m USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex_messages_1)/,
      );
    });
  }, 60_000);
});

describe('RepositoryProjection — source-boundary regression (P4-W4 F)', () => {
  it('source text never reintroduces full list* hydration on load/refresh', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'repository-projection.ts'),
      'utf8',
    );
    // Strip block + line comments so docstrings mentioning the banned APIs do not trip the gate.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const banned of [
      'listMessages(',
      'listToolCalls(',
      'listReasoning(',
      'listTurns(',
      'listTurnsForTasks(',
    ]) {
      expect(code, `projection must not call ${banned}`).not.toContain(banned);
    }
    // Must keep the bounded helpers as the only turn/message surface.
    expect(code).toContain('listTurnActivityForTasks');
    expect(code).toContain('listActiveTurnInputMessages');
  });
});
