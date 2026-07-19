import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InvalidTranscriptCursorError } from '../task/transcript-cursor';
import { SqliteTaskRepository } from '../task/repository';
import type { TranscriptPage } from '../task/repository';
import { DbClient } from '../task/sqlite/client';
import type { MusterTask, TaskMessage, TaskTurn } from '../task/types';
import {
  parseLoadTranscriptPageMessage,
  routeLoadTranscriptPage,
  TRANSCRIPT_PAGE_LIMIT,
  type TranscriptPageRouteDeps,
} from './transcript-page-route';

function page(partial?: Partial<TranscriptPage>): TranscriptPage {
  return {
    items: partial?.items ?? [
      {
        id: 'u1',
        kind: 'user',
        content: 'hello',
        turnId: 't1',
        order: 0,
      },
    ],
    hasMoreBefore: partial?.hasMoreBefore ?? false,
    workspaceRevision: partial?.workspaceRevision ?? 3,
    ...(partial?.beforeCursor !== undefined ? { beforeCursor: partial.beforeCursor } : {}),
  };
}

function deps(overrides?: Partial<TranscriptPageRouteDeps>): TranscriptPageRouteDeps {
  return {
    getFocused: () => ({ taskId: 'task-1', generation: 1 }),
    getTask: async () =>
      ({
        id: 'task-1',
        role: 'worker',
        lifecycle: 'open',
        goal: 'g',
        backend: 'claude',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 0,
        releaseState: 'released',
      }) as never,
    getTranscriptPage: async () => page(),
    ...overrides,
  };
}

describe('parseLoadTranscriptPageMessage', () => {
  it('accepts a valid request', () => {
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
      }),
    ).toEqual({
      ok: true,
      requestId: 'req-1',
      taskId: 'task-1',
      beforeCursor: 'v2.abc',
    });
  });

  it('is silent for missing/oversized correlation fields', () => {
    expect(parseLoadTranscriptPageMessage(null)).toEqual({ ok: false, silent: true });
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: '',
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
      }),
    ).toEqual({ ok: false, silent: true });
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'x'.repeat(129),
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
      }),
    ).toEqual({ ok: false, silent: true });
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 't'.repeat(513),
        beforeCursor: 'v2.abc',
      }),
    ).toEqual({ ok: false, silent: true });
  });

  it('returns typed invalidRequest when correlation is safe but cursor is not', () => {
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: '',
      }),
    ).toEqual({
      ok: false,
      silent: false,
      requestId: 'req-1',
      taskId: 'task-1',
      code: 'invalidRequest',
    });
  });

  it('is silent for missing type or wrong type', () => {
    expect(
      parseLoadTranscriptPageMessage({
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
      }),
    ).toEqual({ ok: false, silent: true });
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadHistory',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
      }),
    ).toEqual({ ok: false, silent: true });
  });

  it('returns typed invalidRequest for extra keys with safe correlation', () => {
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
        limit: 50,
      }),
    ).toEqual({
      ok: false,
      silent: false,
      requestId: 'req-1',
      taskId: 'task-1',
      code: 'invalidRequest',
    });
  });

  it('returns typed invalidRequest for NUL or oversized cursor', () => {
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.\0bad',
      }),
    ).toMatchObject({ ok: false, silent: false, code: 'invalidRequest' });
    expect(
      parseLoadTranscriptPageMessage({
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'x'.repeat(4097),
      }),
    ).toMatchObject({ ok: false, silent: false, code: 'invalidRequest' });
  });
});

describe('routeLoadTranscriptPage', () => {
  it('calls getTranscriptPage(taskId, cursor, 100) exactly once on success', async () => {
    const getTranscriptPage = vi.fn(async () =>
      page({
        hasMoreBefore: true,
        beforeCursor: 'v2.older',
        workspaceRevision: 9,
        items: [
          {
            id: 'u-old',
            kind: 'user',
            content: 'older',
            turnId: 't0',
            order: 0,
          },
        ],
      }),
    );
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({ getTranscriptPage }),
    );
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    expect(getTranscriptPage).toHaveBeenCalledWith('task-1', 'v2.cursor', TRANSCRIPT_PAGE_LIMIT);
    expect(TRANSCRIPT_PAGE_LIMIT).toBe(100);
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: true,
        items: [
          {
            id: 'u-old',
            kind: 'user',
            content: 'older',
            turnId: 't0',
            order: 0,
          },
        ],
        transcriptPage: {
          hasMoreBefore: true,
          beforeCursor: 'v2.older',
          workspaceRevision: 9,
        },
      },
    });
  });

  it('returns staleFocus with zero page queries when focused task differs', async () => {
    const getTranscriptPage = vi.fn(async () => page());
    const getTask = vi.fn(async () => undefined);
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({
        getFocused: () => ({ taskId: 'other', generation: 1 }),
        getTask,
        getTranscriptPage,
      }),
    );
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: false,
        code: 'staleFocus',
      },
    });
    expect(getTranscriptPage).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
  });

  it('returns taskNotFound when task is missing', async () => {
    const getTranscriptPage = vi.fn(async () => page());
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({
        getTask: async () => undefined,
        getTranscriptPage,
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'message',
      message: { ok: false, code: 'taskNotFound' },
    });
    expect(getTranscriptPage).not.toHaveBeenCalled();
  });

  it('maps getTask throw (repository not ready) to unavailable, not taskNotFound', async () => {
    const getTranscriptPage = vi.fn(async () => page());
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({
        getTask: async () => {
          throw new Error('task repository not ready');
        },
        getTranscriptPage,
      }),
    );
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: false,
        code: 'unavailable',
      },
    });
    expect(getTranscriptPage).not.toHaveBeenCalled();
  });

  it('maps InvalidTranscriptCursorError to invalidCursor without echoing cursor', async () => {
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.bad-cursor-value',
      },
      deps({
        getTranscriptPage: async () => {
          throw new InvalidTranscriptCursorError();
        },
      }),
    );
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: false,
        code: 'invalidCursor',
      },
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('v2.bad-cursor-value');
    expect(outcome.kind === 'message' && 'message' in outcome.message ? true : false).toBe(
      false,
    );
  });

  it('maps repository throws to unavailable without leaking error text', async () => {
    const outcome = await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({
        getTranscriptPage: async () => {
          throw new Error('SQL boom at /Users/secret/db.sqlite SELECT * FROM messages');
        },
      }),
    );
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: false,
        code: 'unavailable',
      },
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('SQL boom');
    expect(serialized).not.toContain('/Users/secret');
    expect(serialized).not.toContain('SELECT');
  });

  it('returns staleFocus when focus generation changes before deferred resolve', async () => {
    let resolvePage!: (value: TranscriptPage) => void;
    const deferred = new Promise<TranscriptPage>((resolve) => {
      resolvePage = resolve;
    });
    let generation = 1;
    const getTranscriptPage = vi.fn(() => deferred);
    const routePromise = routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-A',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({
        getFocused: () => ({ taskId: 'task-1', generation }),
        getTranscriptPage,
      }),
    );
    generation = 2;
    resolvePage(page({ workspaceRevision: 4 }));
    const outcome = await routePromise;
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'transcriptPageResult',
        requestId: 'req-A',
        taskId: 'task-1',
        ok: false,
        code: 'staleFocus',
      },
    });
  });

  it('rejects response A after A → B → A focus race', async () => {
    let resolveA!: (value: TranscriptPage) => void;
    const deferredA = new Promise<TranscriptPage>((resolve) => {
      resolveA = resolve;
    });
    let focused: { taskId: string | undefined; generation: number } = {
      taskId: 'task-1',
      generation: 1,
    };
    const getTranscriptPage = vi.fn(() => deferredA);
    const routeA = routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-A',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({
        getFocused: () => focused,
        getTranscriptPage,
      }),
    );
    // Focus leaves task-1 then returns with a new generation (A → B → A).
    focused = { taskId: 'task-2', generation: 2 };
    focused = { taskId: 'task-1', generation: 3 };
    resolveA(page({ workspaceRevision: 8 }));
    const outcome = await routeA;
    expect(outcome).toMatchObject({
      kind: 'message',
      message: { ok: false, code: 'staleFocus', requestId: 'req-A' },
    });
  });

  it('never calls full hydration APIs', async () => {
    const getTranscriptPage = vi.fn(async () => page());
    const banned = {
      listTurns: vi.fn(),
      listMessages: vi.fn(),
      listToolCalls: vi.fn(),
      listReasoning: vi.fn(),
    };
    await routeLoadTranscriptPage(
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.cursor',
      },
      deps({ getTranscriptPage }),
    );
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    expect(banned.listTurns).not.toHaveBeenCalled();
    expect(banned.listMessages).not.toHaveBeenCalled();
    expect(banned.listToolCalls).not.toHaveBeenCalled();
    expect(banned.listReasoning).not.toHaveBeenCalled();
  });

  it('makes zero repository calls for every invalid request shape', async () => {
    const getTask = vi.fn(async () => undefined);
    const getTranscriptPage = vi.fn(async () => page());
    const invalids = [
      { requestId: 'req-1', taskId: 'task-1', beforeCursor: 'v2.abc' }, // missing type
      { type: 'loadHistory', requestId: 'req-1', taskId: 'task-1', beforeCursor: 'v2.abc' },
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.abc',
        extra: true,
      },
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: '',
      },
      {
        type: 'loadTranscriptPage',
        requestId: 'req-1',
        taskId: 'task-1',
        beforeCursor: 'v2.\0x',
      },
    ];
    for (const data of invalids) {
      getTask.mockClear();
      getTranscriptPage.mockClear();
      await routeLoadTranscriptPage(data, deps({ getTask, getTranscriptPage }));
      expect(getTask, JSON.stringify(data)).not.toHaveBeenCalled();
      expect(getTranscriptPage, JSON.stringify(data)).not.toHaveBeenCalled();
    }
  });
});

describe('routeLoadTranscriptPage multi-page integration', () => {
  it('walks bootstrap + older pages over ~300 items without dup/gap/full hydrate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-w5-page-'));
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
        identityKey: 'w5',
        displayName: 'w5',
        createdAt: 'now',
        lastOpenedAt: 'now',
      });
      const task: MusterTask = {
        id: 'task-multi',
        role: 'worker',
        lifecycle: 'open',
        releaseState: 'released',
        goal: 'multi',
        parentId: null,
        dependencies: [],
        backend: 'grok',
        capabilities: [],
        executionPolicy: { maxTurns: 100, maxAutomaticRetries: 1 },
        revision: 0,
        createdAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      };
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      const ITEM_COUNT = 300;
      const turn: TaskTurn = {
        id: 'bulk-turn',
        taskId: task.id,
        sequence: 1,
        status: 'succeeded',
        trigger: 'engine',
        inputs: [],
        createdAt: '2026-07-16T00:00:00.000Z',
      };
      await repo.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      const BATCH = 50;
      for (let start = 1; start <= ITEM_COUNT; start += BATCH) {
        const messages: TaskMessage[] = [];
        for (let i = start; i < start + BATCH && i <= ITEM_COUNT; i++) {
          messages.push({
            id: `msg-${i}`,
            taskId: task.id,
            role: 'assistant',
            content: `content ${i}`,
            state: 'complete',
            createdAt: `2026-07-16T00:00:${String(Math.floor(i / 1000)).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`,
            order: i,
            turnId: turn.id,
          });
        }
        await repo.execute({
          kind: 'appendTranscriptBatch',
          workspaceId: 'ws',
          taskId: task.id,
          messages,
        });
      }

      const listTurns = vi.spyOn(repo, 'listTurns');
      const listMessages = vi.spyOn(repo, 'listMessages');
      const listToolCalls = vi.spyOn(repo, 'listToolCalls');
      const listReasoning = vi.spyOn(repo, 'listReasoning');

      const routeDeps: TranscriptPageRouteDeps = {
        getFocused: () => ({ taskId: task.id, generation: 1 }),
        getTask: (taskId) => repo.getTask(taskId),
        getTranscriptPage: (taskId, beforeCursor, limit) =>
          repo.getTranscriptPage(taskId, beforeCursor, limit),
      };

      // Bootstrap latest page (no cursor) via repository, then walk older via route.
      const bootstrap = await repo.getTranscriptPage(task.id, undefined, 100);
      expect(bootstrap.items.length).toBe(100);
      expect(bootstrap.hasMoreBefore).toBe(true);
      expect(bootstrap.beforeCursor).toBeDefined();

      const collected = [...bootstrap.items.map((item) => item.id)];
      let cursor = bootstrap.beforeCursor;
      let pages = 1;
      while (cursor) {
        const outcome = await routeLoadTranscriptPage(
          {
            type: 'loadTranscriptPage',
            requestId: `req-${pages}`,
            taskId: task.id,
            beforeCursor: cursor,
          },
          routeDeps,
        );
        expect(outcome.kind).toBe('message');
        if (outcome.kind !== 'message' || !outcome.message.ok) {
          throw new Error(`expected success page, got ${JSON.stringify(outcome)}`);
        }
        expect(outcome.message.items.length).toBeGreaterThan(0);
        expect(outcome.message.items.length).toBeLessThanOrEqual(100);
        collected.unshift(...outcome.message.items.map((item) => item.id));
        pages += 1;
        if (!outcome.message.transcriptPage.hasMoreBefore) {
          expect(outcome.message.transcriptPage.beforeCursor).toBeUndefined();
          break;
        }
        cursor = outcome.message.transcriptPage.beforeCursor;
        if (pages > 20) throw new Error('pagination did not terminate');
      }

      expect(collected).toHaveLength(ITEM_COUNT);
      expect(new Set(collected).size).toBe(ITEM_COUNT);
      expect(collected).toEqual(
        Array.from({ length: ITEM_COUNT }, (_, i) => `msg-${i + 1}`),
      );
      expect(listTurns).not.toHaveBeenCalled();
      expect(listMessages).not.toHaveBeenCalled();
      expect(listToolCalls).not.toHaveBeenCalled();
      expect(listReasoning).not.toHaveBeenCalled();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
