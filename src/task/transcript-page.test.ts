import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository, transcriptPageSql } from './repository';
import { InvalidTranscriptCursorError } from './transcript-cursor';
import { DbClient } from './sqlite/client';
import type { MusterTask, PersistedReasoning, PersistedToolCall, TaskMessage, TaskTurn } from './types';
import { buildTranscript } from '../host/snapshot';
import type { EngineProjection } from './types';

function makeTask(id: string): MusterTask {
  return {
    id, role: 'worker', lifecycle: 'open', releaseState: 'released', goal: id,
    parentId: null, prerequisites: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 100, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

/** Spin up an isolated SQLite-backed repository with one workspace row. */
async function withRepo<T>(
  name: string,
  fn: (repo: SqliteTaskRepository, client: DbClient) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-${name}-`));
  const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
  try {
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repo = new SqliteTaskRepository(client, 'ws');
    await repo.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: name, displayName: name, createdAt: 'now', lastOpenedAt: 'now' });
    return await fn(repo, client);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('SqliteTaskRepository.getTranscriptPage — keyset pagination', () => {
  it('returns an empty page with the workspace revision for a task with no transcript', async () => {
    await withRepo('transcript-empty', async (repo) => {
      const task = makeTask('empty-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const page = await repo.getTranscriptPage(task.id, undefined, 100);
      expect(page.items).toEqual([]);
      expect(page.hasMoreBefore).toBe(false);
      expect(page.beforeCursor).toBeUndefined();
      expect(page.workspaceRevision).toBeGreaterThanOrEqual(0);
    });
  });

  it('rejects a structurally invalid cursor before running any query', async () => {
    await withRepo('transcript-bad-cursor', async (repo) => {
      const task = makeTask('cursor-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await expect(repo.getTranscriptPage(task.id, 'v1.deadbeef', 100)).rejects.toBeInstanceOf(
        InvalidTranscriptCursorError,
      );
    });
  });

  it('paginates a mixed transcript in ascending render order with no gaps or duplicates', async () => {
    await withRepo('transcript-mixed', async (repo) => {
      const { task, expectedIds } = await seedMixedTranscript(repo);

      // Walk newest → oldest in pages of 1; concatenate then compare to full order.
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      for (;;) {
        const page = await repo.getTranscriptPage(task.id, cursor, 1);
        expect(page.items.length).toBeLessThanOrEqual(1);
        // Newest page first: prepend so `seen` ends up ascending.
        seen.unshift(...page.items.map((item) => item.id));
        if (!page.hasMoreBefore) {
          expect(page.beforeCursor).toBeUndefined();
          break;
        }
        expect(page.beforeCursor).toBeDefined();
        cursor = page.beforeCursor;
        if (++guard > 1000) throw new Error('pagination did not terminate');
      }
      expect(seen).toEqual(expectedIds);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
    });
  });

  it('matches buildTranscript() ordering exactly (projector parity)', async () => {
    await withRepo('transcript-parity', async (repo) => {
      const { task, file } = await seedMixedTranscript(repo);
      const projected = buildTranscript(file, task.id).map((item) => item.id);
      // Single large page → full ascending order from SQL.
      const page = await repo.getTranscriptPage(task.id, undefined, 500);
      expect(page.items.map((item) => item.id)).toEqual(projected);
    });
  });

  it('returns beforeCursor only while older rows remain, and each page is ascending', async () => {
    await withRepo('transcript-before-cursor', async (repo) => {
      const { task, expectedIds } = await seedMixedTranscript(repo);
      const first = await repo.getTranscriptPage(task.id, undefined, 3);
      expect(first.items).toHaveLength(3);
      // ascending within the page
      expect(first.items.map((i) => i.id)).toEqual(expectedIds.slice(expectedIds.length - 3));
      expect(first.hasMoreBefore).toBe(true);
      expect(first.beforeCursor).toBeDefined();
    });
  });

  it('applies the default limit (100) and clamps out-of-range limits', async () => {
    await withRepo('transcript-limit', async (repo) => {
      const task = makeTask('limit-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await seedTurnWithSegments(repo, task.id, 1, 5);
      const def = await repo.getTranscriptPage(task.id, undefined);
      expect(def.items.length).toBeLessThanOrEqual(100);
      // limit 0 / negative clamp to >=1; huge clamps to <=500 (only 6 items exist here)
      const clampedLow = await repo.getTranscriptPage(task.id, undefined, 0);
      expect(clampedLow.items.length).toBe(1);
    });
  });

  it('keeps working after the anchor entity is deleted', async () => {
    await withRepo('transcript-deleted-anchor', async (repo) => {
      const { task } = await seedMixedTranscript(repo);
      const first = await repo.getTranscriptPage(task.id, undefined, 2);
      const anchorId = first.items[0]!.id;
      const cursor = first.beforeCursor!;
      // Delete the oldest item currently on the page (the cursor anchor).
      await repo.execute({ kind: 'deleteMessage', workspaceId: 'ws', messageId: anchorId });
      // Keyset cursor must still resolve even though the anchor row is gone.
      const older = await repo.getTranscriptPage(task.id, cursor, 100);
      expect(older.items.every((item) => item.id !== anchorId)).toBe(true);
    });
  });

  // Finding 1: a user message bound to no turn (no turn_id, no turn_inputs binding)
  // must still surface at the unbound sentinel sequence — never silently dropped.
  it('surfaces a user message that is bound to no turn', async () => {
    await withRepo('transcript-unbound-user', async (repo) => {
      const task = makeTask('unbound-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      // A resolved turn with its own assistant reply, plus a floating user message
      // with no turn_id and no turn_inputs entry pointing at it.
      const bound = msg('bound-user', task.id, 'user', 'bound', '2026-07-16T00:00:02.000Z');
      await repo.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: turn('t1', task.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: bound.id }], '2026-07-16T00:00:01.000Z'),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: bound });
      const floating = msg('floating-user', task.id, 'user', 'floating', '2026-07-16T00:00:00.500Z');
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: floating });

      const page = await repo.getTranscriptPage(task.id, undefined, 100);
      const ids = page.items.map((i) => i.id);
      expect(ids).toContain('floating-user');
      // Unbound sorts before bound turns (turn_sequence = -1) → appears first ascending.
      expect(ids.indexOf('floating-user')).toBeLessThan(ids.indexOf('bound-user'));
      // Parity: the projector agrees the unbound user message is visible and first.
      const file = toStoreFile(
        task,
        [turn('t1', task.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: bound.id }], '2026-07-16T00:00:01.000Z')],
        [bound, floating],
        [],
        [],
      );
      expect(buildTranscript(file, task.id).map((i) => i.id)).toEqual(ids);
    });
  });

  // Finding 2: bytewise (BINARY) tie-break must match the projector even when
  // entity IDs differ only by ASCII case or Unicode — localeCompare would diverge.
  it('breaks id ties bytewise, matching the projector (ASCII case + Unicode)', async () => {
    await withRepo('transcript-tiebreak', async (repo) => {
      const task = makeTask('tie-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const ts = '2026-07-16T00:00:03.000Z';
      await repo.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: turn('T1', task.id, 1, 'succeeded', 'engine', [], '2026-07-16T00:00:01.000Z'),
      });
      // Same turn/kind/order/timestamp; only entity id differs. 'A'(0x41) < 'a'(0x61)
      // bytewise; localeCompare on many locales would sort 'a' < 'A'.
      const tie: TaskMessage[] = [
        msg('a', task.id, 'assistant', 'lower', ts, 0, 'T1'),
        msg('A', task.id, 'assistant', 'upper', ts, 0, 'T1'),
        msg('Z', task.id, 'assistant', 'zed', ts, 0, 'T1'),
        msg('\u00e9', task.id, 'assistant', 'e-acute', ts, 0, 'T1'),
      ];
      await repo.execute({ kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id, messages: tie });

      const page = await repo.getTranscriptPage(task.id, undefined, 100);
      const sqlIds = page.items.map((i) => i.id);
      const file = toStoreFile(task, [turn('T1', task.id, 1, 'succeeded', 'engine', [], '2026-07-16T00:00:01.000Z')], tie, [], []);
      const projectedIds = buildTranscript(file, task.id).map((i) => i.id);
      expect(sqlIds).toEqual(projectedIds);
      // Bytewise expectation: 'A' < 'Z' < 'a' < 'é' (0x41 < 0x5a < 0x61 < 0xc3 0xa9).
      expect(sqlIds).toEqual(['A', 'Z', 'a', '\u00e9']);

      // Walk in pages of 1 across the tie: no dup/gap, identical order.
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      for (;;) {
        const p = await repo.getTranscriptPage(task.id, cursor, 1);
        seen.unshift(...p.items.map((i) => i.id));
        if (!p.hasMoreBefore) break;
        cursor = p.beforeCursor;
        if (++guard > 100) throw new Error('pagination did not terminate');
      }
      expect(seen).toEqual(sqlIds);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  // Finding 3: decode the full DTO shape — a user/assistant message with no raw
  // `order` must have `order` undefined (not the normalized fallback), while an
  // assistant with an explicit order and a tool call carry their real order.
  it('decodes raw order faithfully (absent when unset, real when set)', async () => {
    await withRepo('transcript-raw-order', async (repo) => {
      const task = makeTask('raw-order-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repo.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: turn('T1', task.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: 'u-open' }], '2026-07-16T00:00:01.000Z'),
      });
      const uOpen = msg('u-open', task.id, 'user', 'open', '2026-07-16T00:00:02.000Z'); // no order
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: uOpen });
      const messages: TaskMessage[] = [
        msg('a-noorder', task.id, 'assistant', 'no order', '2026-07-16T00:00:03.000Z', undefined, 'T1'),
        msg('a-order', task.id, 'assistant', 'ordered', '2026-07-16T00:00:04.000Z', 5, 'T1'),
      ];
      const toolCalls: PersistedToolCall[] = [
        { id: 'tc1', taskId: task.id, turnId: 'T1', toolCallId: 'call1', order: 7, name: 'read', status: 'success', output: 'ok', createdAt: '2026-07-16T00:00:05.000Z', updatedAt: '2026-07-16T00:00:05.000Z' },
      ];
      await repo.execute({ kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id, messages, toolCalls });

      const page = await repo.getTranscriptPage(task.id, undefined, 100);
      const byId = new Map(page.items.map((i) => [i.id, i]));
      // User opening prompt: no raw order → `order` absent (not -2).
      expect('order' in byId.get('u-open')!).toBe(false);
      // Assistant without order → absent (not 0).
      expect('order' in byId.get('a-noorder')!).toBe(false);
      // Assistant with explicit order → real value.
      expect((byId.get('a-order') as { order?: number }).order).toBe(5);
      // Tool call → real order.
      expect((byId.get('tc1') as { order?: number }).order).toBe(7);
    });
  });
});

describe('getTranscriptPage — queued visibility', () => {
  it('shows the opening prompt of a sole queued user turn, hides queued follow-ups', async () => {
    await withRepo('transcript-queued', async (repo, client) => {
      const task = makeTask('queued-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      // Opening turn: sole, user-triggered, queued, with a message input.
      const openMsg = msg('open-user', task.id, 'user', 'open', '2026-07-16T00:00:01.000Z');
      await repo.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: turn('t1', task.id, 1, 'queued', 'user', [{ kind: 'message', messageId: openMsg.id }], '2026-07-16T00:00:01.000Z'),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: openMsg });
      // Sole queued user turn → opening prompt is visible even before it runs.
      const openPage = await repo.getTranscriptPage(task.id, undefined, 100);
      expect(openPage.items.map((i) => i.id)).toContain('open-user');

      // In real UX the opening turn is already running by the time a follow-up is
      // queued behind it. Mark it running, then add a queued follow-up turn.
      await client.run(`UPDATE turns SET status = 'running' WHERE workspace_id = 'ws' AND id = 't1'`);
      const followMsg = msg('follow-user', task.id, 'user', 'follow', '2026-07-16T00:00:02.000Z');
      await repo.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: turn('t2', task.id, 2, 'queued', 'user', [{ kind: 'message', messageId: followMsg.id }], '2026-07-16T00:00:02.000Z'),
      });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: followMsg });
      const twoPage = await repo.getTranscriptPage(task.id, undefined, 100);
      const ids = twoPage.items.map((i) => i.id);
      expect(ids).toContain('open-user'); // opening (now running) still shown
      expect(ids).not.toContain('follow-user'); // queued follow-up hidden
    });
  });

  it('reveals a follow-up user message once its turn is running', async () => {
    await withRepo('transcript-queued-running', async (repo) => {
      const task = makeTask('running-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const m1 = msg('u1', task.id, 'user', 'first', '2026-07-16T00:00:01.000Z');
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn('t1', task.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: m1.id }], '2026-07-16T00:00:01.000Z') });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: m1 });
      const m2 = msg('u2', task.id, 'user', 'second', '2026-07-16T00:00:02.000Z');
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn('t2', task.id, 2, 'running', 'user', [{ kind: 'message', messageId: m2.id }], '2026-07-16T00:00:02.000Z') });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: m2 });
      const page = await repo.getTranscriptPage(task.id, undefined, 100);
      expect(page.items.map((i) => i.id)).toEqual(['u1', 'u2']);
    });
  });

  it('hides multiple queued follow-ups', async () => {
    await withRepo('transcript-multi-queued', async (repo) => {
      const task = makeTask('multi-queued-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const m1 = msg('mu1', task.id, 'user', 'first', '2026-07-16T00:00:01.000Z');
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn('t1', task.id, 1, 'running', 'user', [{ kind: 'message', messageId: m1.id }], '2026-07-16T00:00:01.000Z') });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: m1 });
      for (const [i, seq] of [2, 3].entries()) {
        const m = msg(`mu${seq}`, task.id, 'user', `q${i}`, `2026-07-16T00:00:0${seq}.000Z`);
        await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn(`t${seq}`, task.id, seq, 'queued', 'user', [{ kind: 'message', messageId: m.id }], `2026-07-16T00:00:0${seq}.000Z`) });
        await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: m });
      }
      const page = await repo.getTranscriptPage(task.id, undefined, 100);
      expect(page.items.map((i) => i.id)).toEqual(['mu1']);
    });
  });
});

describe('getTranscriptPage — concurrent mutation', () => {
  it('does not shift or duplicate rows when a newer item is inserted mid-traversal', async () => {
    await withRepo('transcript-concurrent', async (repo) => {
      const task = makeTask('concurrent-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await seedTurnWithSegments(repo, task.id, 1, 4); // user + 4 assistant segments (5 items)

      const first = await repo.getTranscriptPage(task.id, undefined, 2);
      expect(first.items).toHaveLength(2);
      const revBefore = first.workspaceRevision;
      const cursor = first.beforeCursor!;

      // Insert a NEWER turn+message after fetching the first (newest) page.
      const m = msg('newer-user', task.id, 'user', 'newer', '2026-07-16T01:00:00.000Z');
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn('t2', task.id, 2, 'running', 'user', [{ kind: 'message', messageId: m.id }], '2026-07-16T01:00:00.000Z') });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: m });

      // The older page from the old cursor must NOT include the newer row and must
      // not duplicate first-page rows.
      const older = await repo.getTranscriptPage(task.id, cursor, 100);
      const olderIds = older.items.map((i) => i.id);
      expect(olderIds).not.toContain('newer-user');
      for (const id of first.items.map((i) => i.id)) {
        expect(olderIds).not.toContain(id);
      }
      expect(older.workspaceRevision).toBeGreaterThan(revBefore); // revision advanced
    });
  });
});

describe('getTranscriptPage — 10k fixture', () => {
  it('bounds SQL rows to limit+1 and never full-hydrates', async () => {
    await withRepo('transcript-10k', async (repo, client) => {
      const task = makeTask('big-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await seedBulkTranscript(client, task.id, 10_000);

      const allSpy = vi.spyOn(client, 'all');
      const listTurns = vi.spyOn(repo, 'listTurns');
      const listMessages = vi.spyOn(repo, 'listMessages');
      const listToolCalls = vi.spyOn(repo, 'listToolCalls');
      const listReasoning = vi.spyOn(repo, 'listReasoning');

      const limit = 100;
      const started = Date.now();
      const page = await repo.getTranscriptPage(task.id, undefined, limit);
      const elapsedMs = Date.now() - started;

      // Public result bounded to `limit`.
      expect(page.items.length).toBe(limit);
      expect(page.hasMoreBefore).toBe(true);
      expect(page.beforeCursor).toBeDefined();

      // SQL returned at most limit+1 real rows (plus the query is a single call).
      expect(allSpy).toHaveBeenCalledTimes(1);
      const rows = await allSpy.mock.results[0]!.value;
      expect(rows.length).toBeLessThanOrEqual(limit + 1);

      // No full-hydration helper was used.
      expect(listTurns).not.toHaveBeenCalled();
      expect(listMessages).not.toHaveBeenCalled();
      expect(listToolCalls).not.toHaveBeenCalled();
      expect(listReasoning).not.toHaveBeenCalled();

      // Traversal sample: newest page is the last inserted items, descending? No —
      // ascending within page. The newest item overall is the last of the page.
      expect(page.items[page.items.length - 1]!.id).toBe('msg-10000');

      // Evidence only, not a hard gate (perf budget lives in W11).
      // eslint-disable-next-line no-console
      console.log(`[10k fixture] first page in ${elapsedMs}ms, SQL rows=${rows.length}`);

      allSpy.mockRestore();
    });
  }, 30_000);
});

describe('getTranscriptPage — cursor decoded before any SQL (Finding 5)', () => {
  it('rejects an invalid cursor without touching the database', async () => {
    await withRepo('transcript-presql', async (repo, client) => {
      const task = makeTask('presql-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const allSpy = vi.spyOn(client, 'all');
      await expect(repo.getTranscriptPage(task.id, 'v2.not-canonical-@@@', 100)).rejects.toBeInstanceOf(
        InvalidTranscriptCursorError,
      );
      // Decode/validation runs up front → the page query never executes.
      expect(allSpy).not.toHaveBeenCalled();
      allSpy.mockRestore();
    });
  });
});

describe('getTranscriptPage — query plan is task-scoped (Finding 4)', () => {
  it('drives every branch off the turn index and never scans workspace tables', async () => {
    await withRepo('transcript-explain', async (repo, client) => {
      const task = makeTask('target-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      // Seed the target task with all four kinds.
      await seedMixedTranscript(repo);
      const t1 = turn('X1', task.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: 'x-open' }], '2026-07-16T00:00:01.000Z');
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: t1 });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: msg('x-open', task.id, 'user', 'open', '2026-07-16T00:00:02.000Z') });
      await repo.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
        messages: [msg('x-a1', task.id, 'assistant', 'a', '2026-07-16T00:00:03.000Z', 0, 'X1')],
        reasoning: [{ id: 'x-r1', taskId: task.id, turnId: 'X1', order: 2, content: 'r', createdAt: '2026-07-16T00:00:02.500Z', updatedAt: '2026-07-16T00:00:02.500Z' }],
        toolCalls: [{ id: 'x-tc1', taskId: task.id, turnId: 'X1', toolCallId: 'c', order: 1, name: 'read', status: 'success', output: 'ok', createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:03.000Z' }],
      });
      // Seed a SIBLING task so any workspace-wide scan would leak its rows.
      const sibling = makeTask('sibling-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: sibling });
      const st = turn('S1', sibling.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: 's-open' }], '2026-07-16T00:00:01.000Z');
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: st });
      await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: msg('s-open', sibling.id, 'user', 'open', '2026-07-16T00:00:02.000Z') });
      await repo.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: sibling.id,
        messages: [msg('s-a1', sibling.id, 'assistant', 'a', '2026-07-16T00:00:03.000Z', 0, 'S1')],
        reasoning: [{ id: 's-r1', taskId: sibling.id, turnId: 'S1', order: 2, content: 'r', createdAt: '2026-07-16T00:00:02.500Z', updatedAt: '2026-07-16T00:00:02.500Z' }],
        toolCalls: [{ id: 's-tc1', taskId: sibling.id, turnId: 'S1', toolCallId: 'c', order: 1, name: 'read', status: 'success', output: 'ok', createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:03.000Z' }],
      });

      // Result isolation: the target page must never contain sibling rows.
      const page = await repo.getTranscriptPage(task.id, undefined, 500);
      const ids = page.items.map((i) => i.id);
      expect(ids).toContain('x-a1');
      expect(ids.some((id) => id.startsWith('s-'))).toBe(false);

      // EXPLAIN QUERY PLAN for the latest-page shape (no keyset predicate). Params
      // mirror getTranscriptPage's placeholder order.
      const params = ['ws', 'ws', task.id, 'ws', task.id, 'ws', 'ws', task.id, 501];
      const plan = await client.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${transcriptPageSql('')}`,
        params,
      );
      const details = plan.map((r) => r.detail).join('\n');

      // (a) task_turns must be materialized once, not flattened back into each branch
      // (flattening lets the planner reorder and drive from the detail tables).
      expect(details).toMatch(/MATERIALIZE task_turns/);

      // (b) No full-table scan of the per-turn detail tables.
      expect(details).not.toMatch(/SCAN (reasoning_segments|tool_calls|turn_inputs)\b/);

      // (c) No WORKSPACE-ONLY seek on the detail tables. The dangerous plan seeks by
      // `(workspace_id=?)` alone — walking every row of that table for the workspace,
      // then joining turns. The correct, task-scoped plan seeks by
      // `(workspace_id=? AND turn_id=?)`. The regex below matches ONLY the bad form
      // (a `)` immediately after the first `?`), so a workspace-only seek fails the test.
      expect(details).not.toMatch(
        /USING INDEX (idx_reasoning_turn_order|idx_tool_calls_turn_order|idx_turn_inputs_turn_order) \(workspace_id=\?\)/,
      );

      // (d) Positively require the task-scoped per-turn seeks: task_turns drives, and
      // each detail table is sought by (workspace_id, turn_id).
      expect(details).toMatch(/SEARCH \w+ USING (COVERING )?INDEX idx_turns_task_sequence \(workspace_id=\? AND task_id=\?\)/);
      expect(details).toMatch(/USING INDEX idx_reasoning_turn_order \(workspace_id=\? AND turn_id=\?\)/);
      expect(details).toMatch(/USING INDEX idx_tool_calls_turn_order \(workspace_id=\? AND turn_id=\?\)/);
      expect(details).toMatch(/USING INDEX idx_turn_inputs_turn_order \(workspace_id=\? AND turn_id=\?\)/);
    });
  });
});

// ---------- fixtures ----------

function turn(
  id: string, taskId: string, sequence: number, status: TaskTurn['status'],
  trigger: TaskTurn['trigger'], inputs: TaskTurn['inputs'], createdAt: string,
): TaskTurn {
  return { id, taskId, sequence, status, trigger, inputs, createdAt };
}

function msg(id: string, taskId: string, role: TaskMessage['role'], content: string, createdAt: string, order?: number, turnId?: string): TaskMessage {
  return {
    id, taskId, role, content, state: 'complete', createdAt,
    ...(order !== undefined ? { order } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

/**
 * Seed a single turn: one opening user message, one reasoning, and N interleaved
 * assistant/tool segments. Returns the total item count.
 */
async function seedTurnWithSegments(repo: SqliteTaskRepository, taskId: string, seq: number, segments: number): Promise<void> {
  const t0 = `2026-07-16T00:0${seq}:00.000Z`;
  const userMsg = msg(`u-${seq}`, taskId, 'user', 'prompt', t0);
  await repo.execute({
    kind: 'createTurn', workspaceId: 'ws',
    turn: turn(`turn-${seq}`, taskId, seq, 'succeeded', 'user', [{ kind: 'message', messageId: userMsg.id }], t0),
  });
  await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: userMsg });
  const messages: TaskMessage[] = [];
  for (let i = 0; i < segments; i++) {
    messages.push(msg(`a-${seq}-${i}`, taskId, 'assistant', `seg ${i}`, `2026-07-16T00:0${seq}:1${i}.000Z`, i, `turn-${seq}`));
  }
  await repo.execute({ kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId, messages });
}

/**
 * Seed a deterministic mixed transcript spanning two turns with reasoning, several
 * assistant segments, tool calls interleaved by shared ordering, and equal
 * timestamps to exercise tie-breakers. Returns the task, the equivalent in-memory
 * store file for buildTranscript() parity, and the expected ascending id order.
 */
async function seedMixedTranscript(
  repo: SqliteTaskRepository,
): Promise<{ task: MusterTask; file: EngineProjection; expectedIds: string[] }> {
  const task = makeTask('mixed-task');
  await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });

  const turns: TaskTurn[] = [
    turn('T1', task.id, 1, 'succeeded', 'user', [{ kind: 'message', messageId: 'm-open' }], '2026-07-16T00:00:01.000Z'),
    turn('T2', task.id, 2, 'succeeded', 'engine', [], '2026-07-16T00:00:10.000Z'),
  ];
  for (const t of turns) await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn: t });

  const messages: TaskMessage[] = [
    msg('m-open', task.id, 'user', 'opening', '2026-07-16T00:00:02.000Z'),
    // Turn 1 assistant segments interleaved with reasoning and a tool.
    msg('m-a1', task.id, 'assistant', 'a1', '2026-07-16T00:00:03.000Z', 1, 'T1'),
    msg('m-a2', task.id, 'assistant', 'a2', '2026-07-16T00:00:03.000Z', 4, 'T1'),
    // Turn 2 assistant.
    msg('m-a3', task.id, 'assistant', 'a3', '2026-07-16T00:00:11.000Z', 1, 'T2'),
  ];
  const reasoning: PersistedReasoning[] = [
    { id: 'r-T1-0', taskId: task.id, turnId: 'T1', order: 0, content: 'think1', createdAt: '2026-07-16T00:00:02.500Z', updatedAt: '2026-07-16T00:00:02.500Z' },
    { id: 'r-T1-3', taskId: task.id, turnId: 'T1', order: 3, content: 'think again', createdAt: '2026-07-16T00:00:03.500Z', updatedAt: '2026-07-16T00:00:03.500Z' },
    { id: 'r-T2-0', taskId: task.id, turnId: 'T2', order: 0, content: 'think2', createdAt: '2026-07-16T00:00:10.500Z', updatedAt: '2026-07-16T00:00:10.500Z' },
  ];
  const toolCalls: PersistedToolCall[] = [
    { id: 'tc-T1-2', taskId: task.id, turnId: 'T1', toolCallId: 'call1', order: 2, name: 'read', status: 'success', output: 'ok', createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:03.000Z' },
    { id: 'tc-T2-2', taskId: task.id, turnId: 'T2', toolCallId: 'call2', order: 2, name: 'write', status: 'success', output: 'ok', createdAt: '2026-07-16T00:00:11.000Z', updatedAt: '2026-07-16T00:00:11.000Z' },
  ];
  await repo.execute({ kind: 'appendMessage', workspaceId: 'ws', message: messages[0]! });
  await repo.execute({ kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id, messages: messages.slice(1), reasoning, toolCalls });

  const file = toStoreFile(task, turns, messages, reasoning, toolCalls);
  const expectedIds = buildTranscript(file, task.id).map((item) => item.id);
  return { task, file, expectedIds };
}

/** Assemble an in-memory EngineProjection mirroring what was persisted (for parity). */
function toStoreFile(
  task: MusterTask, turns: TaskTurn[], messages: TaskMessage[],
  reasoning: PersistedReasoning[], toolCalls: PersistedToolCall[],
): EngineProjection {
  return {
    schemaVersion: 1,
    tasks: { [task.id]: task },
    turns: Object.fromEntries(turns.map((t) => [t.id, t])),
    messages: Object.fromEntries(messages.map((m) => [m.id, m])),
    reasoning: Object.fromEntries(reasoning.map((r) => [r.id, r])),
    toolCalls: Object.fromEntries(toolCalls.map((tc) => [tc.id, tc])),
  } as unknown as EngineProjection;
}

/**
 * Bulk-seed `count` transcript rows efficiently: one turn holding `count` assistant
 * messages inserted via batched appendTranscriptBatch calls (not per-item named
 * commands), so the 10k fixture stays fast.
 */
async function seedBulkTranscript(client: DbClient, taskId: string, count: number): Promise<void> {
  const createdAt = '2026-07-16T00:00:00.000Z';
  await client.run(
    `INSERT INTO turns (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['bulk-turn', 'ws', taskId, 1, 'succeeded', 'engine', createdAt, JSON.stringify({ payloadVersion: 1, inputs: [] })],
  );
  const BATCH = 500;
  for (let start = 1; start <= count; start += BATCH) {
    const stmts = [];
    for (let i = start; i < start + BATCH && i <= count; i++) {
      const ts = `2026-07-16T00:00:${String(Math.floor(i / 1000)).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`;
      stmts.push({
        sql: `INSERT INTO messages (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [`msg-${i}`, 'ws', taskId, 'bulk-turn', 'assistant', 'complete', i, `content ${i}`, ts, JSON.stringify({ payloadVersion: 1 })],
      });
    }
    await client.transaction(stmts);
  }
}
