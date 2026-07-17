import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CorruptWorkspaceChangeFeedError,
  InvalidWorkspaceChangeFeedRequestError,
  SqliteTaskRepository,
} from './repository';
import type { MusterTask } from './types';
import { DbClient } from './sqlite/client';
import { CHANGE_FEED_RETAIN_REVISIONS } from './sqlite/schema';

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

async function withRepo<T>(
  retain: number,
  fn: (repo: SqliteTaskRepository, client: DbClient) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-change-feed-'));
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  try {
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repo = new SqliteTaskRepository(client, 'ws', {
      changeFeedRetainRevisions: retain,
    });
    await repo.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'feed',
      displayName: 'Feed',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    return await fn(repo, client);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('workspace change feed', () => {
  it('exposes revision 0 and empty changes for a fresh workspace without gap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-change-feed-fresh-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repo = new SqliteTaskRepository(client, 'ws');
      expect(await repo.getWorkspaceRevision()).toBe(0);
      await expect(repo.getWorkspaceChangesSince(0)).resolves.toEqual({
        kind: 'changes',
        requestedAfterRevision: 0,
        currentRevision: 0,
        retainedFromRevision: 1,
        revisions: [],
        hasMore: false,
      });
      const dataVersion = await repo.getStorageDataVersion();
      expect(Number.isSafeInteger(dataVersion)).toBe(true);
      expect(dataVersion).toBeGreaterThan(0);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns one multi-row revision as a single contiguous page entry', async () => {
    await withRepo(4096, async (repo) => {
      const task = makeTask('t1');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const turn = {
        id: 'turn-1',
        taskId: task.id,
        sequence: 1,
        status: 'running' as const,
        trigger: 'user' as const,
        inputs: [],
        createdAt: '2026-07-16T00:00:01.000Z',
      };
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      const afterTurn = await repo.getWorkspaceRevision();
      await repo.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: task.id,
        messages: [{
          id: 'm1',
          taskId: task.id,
          turnId: turn.id,
          role: 'assistant' as const,
          content: 'SECRET_CANARY_PROMPT_CONTENT',
          state: 'partial' as const,
          order: 0,
          createdAt: '2026-07-16T00:00:02.000Z',
        }],
        toolCalls: [{
          id: 'turn-1:tool-1',
          taskId: task.id,
          turnId: turn.id,
          toolCallId: 'tool-1',
          order: 1,
          name: 'read_file',
          kind: 'builtin',
          status: 'success',
          input: { path: '/secret/path/canary.ts' },
          output: 'SECRET_TOOL_OUTPUT',
          createdAt: '2026-07-16T00:00:03.000Z',
          updatedAt: '2026-07-16T00:00:04.000Z',
        }],
        reasoning: [{
          id: turn.id,
          taskId: task.id,
          turnId: turn.id,
          content: 'SECRET_REASONING',
          createdAt: '2026-07-16T00:00:03.000Z',
          updatedAt: '2026-07-16T00:00:04.000Z',
        }],
      });

      const feed = await repo.getWorkspaceChangesSince(afterTurn);
      expect(feed.kind).toBe('changes');
      if (feed.kind !== 'changes') return;
      expect(feed.revisions).toHaveLength(1);
      expect(feed.revisions[0]?.revision).toBe(afterTurn + 1);
      expect(feed.revisions[0]?.changes).toHaveLength(3);
      expect(feed.hasMore).toBe(false);
      const kinds = feed.revisions[0]!.changes.map((c) => c.entityKind).sort();
      expect(kinds).toEqual(['message', 'reasoning', 'tool_call']);
      const serialized = JSON.stringify(feed);
      expect(serialized).not.toContain('SECRET_CANARY');
      expect(serialized).not.toContain('/secret/path');
      expect(serialized).not.toContain('SECRET_TOOL');
      expect(serialized).not.toContain('SECRET_REASONING');
    });
  });

  it('paginates by revision without splitting multi-row revisions', async () => {
    await withRepo(4096, async (repo) => {
      for (let i = 0; i < 5; i += 1) {
        await repo.execute({
          kind: 'createTask',
          workspaceId: 'ws',
          task: makeTask(`task-${i}`),
        });
      }
      // after workspace upsert revision=1, five tasks → revisions 2..6
      const page1 = await repo.getWorkspaceChangesSince(1, 2);
      expect(page1.kind).toBe('changes');
      if (page1.kind !== 'changes') return;
      expect(page1.revisions.map((r) => r.revision)).toEqual([2, 3]);
      expect(page1.hasMore).toBe(true);
      for (const entry of page1.revisions) {
        expect(entry.changes.length).toBeGreaterThan(0);
      }

      const page2 = await repo.getWorkspaceChangesSince(3, 2);
      expect(page2.kind).toBe('changes');
      if (page2.kind !== 'changes') return;
      expect(page2.revisions.map((r) => r.revision)).toEqual([4, 5]);
      expect(page2.hasMore).toBe(true);

      const page3 = await repo.getWorkspaceChangesSince(5, 2);
      expect(page3.kind).toBe('changes');
      if (page3.kind !== 'changes') return;
      expect(page3.revisions.map((r) => r.revision)).toEqual([6]);
      expect(page3.hasMore).toBe(false);
    });
  });

  it('returns empty changes when consumer is up-to-date and rejects ahead cursors', async () => {
    await withRepo(4096, async (repo) => {
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('t') });
      const current = await repo.getWorkspaceRevision();
      await expect(repo.getWorkspaceChangesSince(current)).resolves.toMatchObject({
        kind: 'changes',
        revisions: [],
        hasMore: false,
        currentRevision: current,
      });
      await expect(repo.getWorkspaceChangesSince(current + 1)).rejects.toBeInstanceOf(
        InvalidWorkspaceChangeFeedRequestError,
      );
      await expect(repo.getWorkspaceChangesSince(-1)).rejects.toBeInstanceOf(
        InvalidWorkspaceChangeFeedRequestError,
      );
      await expect(repo.getWorkspaceChangesSince(1.5)).rejects.toBeInstanceOf(
        InvalidWorkspaceChangeFeedRequestError,
      );
      await expect(repo.getWorkspaceChangesSince(0, 0)).rejects.toBeInstanceOf(
        InvalidWorkspaceChangeFeedRequestError,
      );
    });
  });

  it('prunes whole revisions and reports explicit gap while keeping exact watermark boundary readable', async () => {
    await withRepo(3, async (repo, client) => {
      for (let i = 0; i < 6; i += 1) {
        await repo.execute({
          kind: 'createTask',
          workspaceId: 'ws',
          task: makeTask(`prune-${i}`),
        });
      }
      const current = await repo.getWorkspaceRevision();
      // workspace + 6 tasks = 7 revisions with retain=3 → retained_from = 5
      const watermark = await client.get<{ retained_from_revision: number }>(
        'SELECT retained_from_revision FROM change_feed_watermarks WHERE workspace_id = ?',
        ['ws'],
      );
      expect(watermark?.retained_from_revision).toBe(current - 3 + 1);
      const retainedFrom = watermark!.retained_from_revision;

      const minRev = await client.get<{ m: number }>(
        'SELECT MIN(revision) AS m FROM change_log WHERE workspace_id = ?',
        ['ws'],
      );
      expect(minRev?.m).toBe(retainedFrom);

      const gap = await repo.getWorkspaceChangesSince(0);
      expect(gap).toEqual({
        kind: 'gap',
        requestedAfterRevision: 0,
        currentRevision: current,
        retainedFromRevision: retainedFrom,
      });

      // after = retainedFrom - 1 still reads the full retained range
      const boundary = await repo.getWorkspaceChangesSince(retainedFrom - 1);
      expect(boundary.kind).toBe('changes');
      if (boundary.kind !== 'changes') return;
      expect(boundary.retainedFromRevision).toBe(retainedFrom);
      expect(boundary.revisions[0]?.revision).toBe(retainedFrom);
      expect(boundary.revisions.map((r) => r.revision)).toEqual(
        Array.from({ length: current - retainedFrom + 1 }, (_, i) => retainedFrom + i),
      );
    });
  });

  it('does not advance revision or write feed rows on no-op / idempotent replay', async () => {
    await withRepo(4096, async (repo) => {
      const entry = {
        fingerprint: 'fp',
        result: { ok: true as const, data: { value: 1 } },
      };
      const first = await repo.execute({
        kind: 'claimOperation',
        workspaceId: 'ws',
        ledgerKey: 'op-1',
        entry,
        createdAt: 'now',
      });
      const rev1 = await repo.getWorkspaceRevision();
      const feed1 = await repo.getWorkspaceChangesSince(0);
      expect(first.changed).toBe(true);

      const replay = await repo.execute({
        kind: 'claimOperation',
        workspaceId: 'ws',
        ledgerKey: 'op-1',
        entry,
        createdAt: 'later',
      });
      expect(replay.changed).toBe(false);
      expect(await repo.getWorkspaceRevision()).toBe(rev1);
      const feed2 = await repo.getWorkspaceChangesSince(0);
      expect(feed2).toEqual(feed1);
    });
  });

  it('assigns contiguous revisions under concurrent writers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-change-feed-concurrent-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const one = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    const two = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await one.open(dbPath);
      await two.open(dbPath);
      const a = new SqliteTaskRepository(one, 'ws', { changeFeedRetainRevisions: 64 });
      const b = new SqliteTaskRepository(two, 'ws', { changeFeedRetainRevisions: 64 });
      await a.execute({
        kind: 'upsertWorkspace',
        workspaceId: 'ws',
        identityKey: 'concurrent',
        displayName: 'Concurrent',
        createdAt: 'now',
        lastOpenedAt: 'now',
      });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 === 0 ? a : b).execute({
            kind: 'createTask',
            workspaceId: 'ws',
            task: makeTask(`c-${i}`),
          }),
        ),
      );
      const current = await a.getWorkspaceRevision();
      // workspace + 10 tasks
      expect(current).toBe(11);
      const feed = await a.getWorkspaceChangesSince(0);
      expect(feed.kind).toBe('changes');
      if (feed.kind !== 'changes') return;
      expect(feed.revisions.map((r) => r.revision)).toEqual(
        Array.from({ length: current }, (_, i) => i + 1),
      );
      for (const entry of feed.revisions) {
        expect(entry.changes.length).toBeGreaterThan(0);
      }
    } finally {
      await Promise.all([one.close(), two.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('uses the workspace+revision index for change feed lookups', async () => {
    await withRepo(4096, async (repo, client) => {
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('idx') });
      const plan = await client.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT revision, entity_kind, entity_id, task_id, change_kind
           FROM change_log
          WHERE workspace_id = ?
            AND revision > ?
            AND revision <= ?
          ORDER BY revision ASC`,
        ['ws', 0, 10],
      );
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail.toLowerCase()).toMatch(/change_log|idx_change_log_workspace_revision/);
      expect(detail.toLowerCase()).not.toMatch(/scan change_log/);
    });
  });

  it('defaults production retention to the documented constant', () => {
    expect(CHANGE_FEED_RETAIN_REVISIONS).toBe(4096);
  });

  it('throws on corrupt entity kind rather than silently skipping', async () => {
    await withRepo(4096, async (repo, client) => {
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask('bad') });
      await client.run(
        `UPDATE change_log SET entity_kind = 'not_a_kind' WHERE workspace_id = ?`,
        ['ws'],
      );
      await expect(repo.getWorkspaceChangesSince(0)).rejects.toBeInstanceOf(
        CorruptWorkspaceChangeFeedError,
      );
    });
  });
});
