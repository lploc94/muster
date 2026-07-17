import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOOTSTRAP_TRANSCRIPT_LIMIT,
  buildRepositorySnapshot,
} from './repository-snapshot';
import { SqliteTaskRepository } from '../task/repository';
import { DbClient } from '../task/sqlite/client';
import type { MusterTask, TaskTurn } from '../task/types';

function task(id: string, parentId: string | null = null): MusterTask {
  return {
    id,
    role: parentId ? 'worker' : 'coordinator',
    lifecycle: 'open',
    releaseState: 'draft',
    goal: id,
    parentId,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
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
    createdAt: `2026-07-17T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

async function withRepo<T>(
  name: string,
  fn: (repo: SqliteTaskRepository, client: DbClient) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-${name}-`));
  const client = new DbClient({
    workerPath: path.join(__dirname, '../task/sqlite/worker.ts'),
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

/** Bulk-seed `count` assistant messages on one turn (deterministic ids msg-1..N). */
async function seedBulkTranscript(
  client: DbClient,
  taskId: string,
  count: number,
): Promise<void> {
  const createdAt = '2026-07-16T00:00:00.000Z';
  await client.run(
    `INSERT INTO turns (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      'bulk-turn',
      'ws',
      taskId,
      1,
      'succeeded',
      'engine',
      createdAt,
      JSON.stringify({ payloadVersion: 1, inputs: [] }),
    ],
  );
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
          'bulk-turn',
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

describe('buildRepositorySnapshot', () => {
  it('projects metadata plus the focused transcript from SQLite queries', async () => {
    await withRepo('repository-snapshot-basic', async (repo) => {
      const root = task('sqlite-root');
      const child = task('sqlite-child', root.id);
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: {
          id: 'sqlite-turn',
          taskId: child.id,
          sequence: 1,
          status: 'succeeded',
          trigger: 'user',
          inputs: [{ kind: 'message', messageId: 'sqlite-message' }],
          createdAt: '2026-07-17T00:00:01.000Z',
        },
      });
      await repo.execute({
        kind: 'appendMessage',
        workspaceId: 'ws',
        message: {
          id: 'sqlite-message',
          taskId: child.id,
          role: 'user',
          content: 'sqlite focused',
          state: 'complete',
          createdAt: '2026-07-17T00:00:02.000Z',
        },
      });
      const projection = await buildRepositorySnapshot(repo, 'ws', child.id, new Map());
      expect(projection.snapshot.subtree?.map((summary) => summary.id)).toEqual([
        root.id,
        child.id,
      ]);
      expect(projection.snapshot.transcript?.map((item) => item.id)).toEqual([
        'sqlite-message',
      ]);
      expect(projection.snapshot.storeRevision).toBeGreaterThan(0);
      expect(projection.snapshot.transcriptPage).toMatchObject({
        hasMoreBefore: false,
        workspaceRevision: projection.snapshot.storeRevision,
      });
    });
  }, 20_000);
});

describe('buildRepositorySnapshot — bounded page (P4-W4 C)', () => {
  it('calls getTranscriptPage once with (taskId, undefined, 100) and bounds the payload', async () => {
    await withRepo('snapshot-bounded-page', async (repo, client) => {
      const focused = task('focused-task');
      const sibling = task('sibling-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: focused });
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: sibling });
      await seedBulkTranscript(client, focused.id, 10_000);
      // Sibling noise must never leak into the focused page.
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('sib-turn', sibling.id, 1, 'succeeded'),
      });
      await repo.execute({
        kind: 'appendMessage',
        workspaceId: 'ws',
        message: {
          id: 'sib-msg',
          taskId: sibling.id,
          role: 'assistant',
          content: 'sibling only',
          state: 'complete',
          createdAt: '2026-07-17T00:00:03.000Z',
          turnId: 'sib-turn',
          order: 0,
        },
      });

      const getPage = vi.spyOn(repo, 'getTranscriptPage');
      const listMessages = vi.spyOn(repo, 'listMessages');
      const listToolCalls = vi.spyOn(repo, 'listToolCalls');
      const listReasoning = vi.spyOn(repo, 'listReasoning');
      const listTurns = vi.spyOn(repo, 'listTurns');

      const projection = await buildRepositorySnapshot(
        repo,
        'ws',
        focused.id,
        new Map(),
      );

      expect(getPage).toHaveBeenCalledTimes(1);
      expect(getPage).toHaveBeenCalledWith(
        focused.id,
        undefined,
        BOOTSTRAP_TRANSCRIPT_LIMIT,
      );
      expect(listMessages).not.toHaveBeenCalled();
      expect(listToolCalls).not.toHaveBeenCalled();
      expect(listReasoning).not.toHaveBeenCalled();
      expect(listTurns).not.toHaveBeenCalled();

      const snap = projection.snapshot;
      expect(snap.transcript).toHaveLength(100);
      // Ascending within page; newest is last.
      expect(snap.transcript![99]!.id).toBe('msg-10000');
      expect(snap.transcript![0]!.id).toBe('msg-9901');
      expect(snap.transcriptPage).toEqual({
        hasMoreBefore: true,
        beforeCursor: expect.any(String),
        workspaceRevision: snap.storeRevision,
      });
      // No sibling leak.
      expect(snap.transcript!.every((item) => item.id !== 'sib-msg')).toBe(true);
      // Observation stays empty of tool/reasoning history.
      expect(projection.observation.toolCalls).toEqual({});
      expect(projection.observation.reasoning).toEqual({});
    });
  }, 30_000);

  it('does not call getTranscriptPage when no task is focused', async () => {
    await withRepo('snapshot-no-focus', async (repo) => {
      const root = task('root-only');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      const getPage = vi.spyOn(repo, 'getTranscriptPage');
      const listActive = vi.spyOn(repo, 'listActiveTurnInputMessages');
      const projection = await buildRepositorySnapshot(repo, 'ws', undefined, new Map());
      expect(getPage).not.toHaveBeenCalled();
      expect(listActive).not.toHaveBeenCalled();
      expect(projection.snapshot.transcript).toBeUndefined();
      expect(projection.snapshot.transcriptPage).toBeUndefined();
      expect(projection.snapshot.focusedTaskId).toBeUndefined();
    });
  }, 20_000);

  it('normalizes deleted/stale focus to a valid no-focus v6 snapshot', async () => {
    await withRepo('snapshot-deleted-focus', async (repo) => {
      const root = task('alive-root');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      const getPage = vi.spyOn(repo, 'getTranscriptPage');
      const listActive = vi.spyOn(repo, 'listActiveTurnInputMessages');
      const projection = await buildRepositorySnapshot(
        repo,
        'ws',
        'deleted-task',
        new Map(),
      );
      expect(getPage).not.toHaveBeenCalled();
      expect(listActive).not.toHaveBeenCalled();
      expect(projection.snapshot.focusedTaskId).toBeUndefined();
      expect(projection.snapshot.transcript).toBeUndefined();
      expect(projection.snapshot.transcriptPage).toBeUndefined();
      // Still projects root list.
      expect(projection.snapshot.rootTasks.map((s) => s.id)).toEqual([root.id]);
    });
  }, 20_000);
});

describe('buildRepositorySnapshot — queue UX (P4-W4 D)', () => {
  it('projects queued follow-up previews from active input messages only', async () => {
    await withRepo('snapshot-queue-ux', async (repo) => {
      const focused = task('queue-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: focused });
      // Live turn with its opening user message.
      const liveMsg = {
        id: 'live-msg',
        taskId: focused.id,
        role: 'user' as const,
        content: 'live prompt',
        state: 'assigned' as const,
        createdAt: '2026-07-17T00:00:01.000Z',
      };
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', focused.id, 1, 'running', {
          inputs: [{ kind: 'message', messageId: liveMsg.id }],
          startedAt: '2026-07-17T00:00:01.000Z',
        }),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: liveMsg });
      // Queued follow-up (must appear in queue panel, not as the active turn).
      const qMsg = {
        id: 'q-msg',
        taskId: focused.id,
        role: 'user' as const,
        content: 'queued follow-up text',
        state: 'pending' as const,
        createdAt: '2026-07-17T00:00:02.000Z',
      };
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('q-turn', focused.id, 2, 'queued', {
          inputs: [{ kind: 'message', messageId: qMsg.id }],
        }),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: qMsg });
      // Historical terminal message that must NOT pollute queue preview.
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('old-turn', focused.id, 0, 'succeeded', {
          finishedAt: '2026-07-17T00:00:00.500Z',
        }),
      });
      await repo.execute({
        kind: 'appendMessage',
        workspaceId: 'ws',
        message: {
          id: 'old-msg',
          taskId: focused.id,
          role: 'assistant',
          content: 'old history',
          state: 'complete',
          createdAt: '2026-07-17T00:00:00.500Z',
          turnId: 'old-turn',
        },
      });

      const projection = await buildRepositorySnapshot(
        repo,
        'ws',
        focused.id,
        new Map(),
      );
      expect(projection.snapshot.activeTurnId).toBe('live-turn');
      expect(projection.snapshot.queuedTurns).toEqual([
        expect.objectContaining({
          turnId: 'q-turn',
          status: 'queued',
          messageIds: ['q-msg'],
          previewText: 'queued follow-up text',
        }),
      ]);
      // Observation only holds active-turn inputs (live + queued), not old history.
      expect(Object.keys(projection.observation.messages).sort()).toEqual([
        'live-msg',
        'q-msg',
      ]);
    });
  }, 20_000);
});

describe('buildRepositorySnapshot — payload budget (P4-W4 E)', () => {
  it('keeps the 10k-fixture focused snapshot under a fixture byte budget', async () => {
    await withRepo('snapshot-payload-budget', async (repo, client) => {
      const focused = task('budget-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: focused });
      await seedBulkTranscript(client, focused.id, 10_000);

      const projection = await buildRepositorySnapshot(
        repo,
        'ws',
        focused.id,
        new Map(),
      );
      const serialized = JSON.stringify(projection.snapshot);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      // Fixture evidence (not a product-enforced universal ceiling): 100 items
      // of short content stay well under 512 KiB; a full 10k hydrate would be multi-MB.
      expect(bytes).toBeLessThan(512 * 1024);
      expect(projection.snapshot.transcript).toHaveLength(100);
      // Sanity: full history would include msg-1; bootstrap must not.
      expect(serialized).not.toContain('"id":"msg-1"');
      expect(serialized).toContain('"id":"msg-10000"');
    });
  }, 30_000);
});

describe('buildRepositorySnapshot — source-boundary regression (P4-W4 F)', () => {
  it('source text never reintroduces full list* hydration or raw DbClient access', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'repository-snapshot.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const banned of [
      'listMessages(',
      'listToolCalls(',
      'listReasoning(',
      'listTurns(',
      'listTurnsForTasks(',
      'DbClient',
      '.db.',
    ]) {
      expect(code, `snapshot must not use ${banned}`).not.toContain(banned);
    }
    expect(code).toContain('getTranscriptPage');
    expect(code).toContain('listTurnActivityForTasks');
    expect(code).toContain('listActiveTurnInputMessages');
    expect(code).toContain('BOOTSTRAP_TRANSCRIPT_LIMIT');
  });
});
