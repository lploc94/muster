import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { TaskStore } from './store';

const tempDirs: string[] = [];

function makeTempStore(): { dir: string; filePath: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-reload-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, '.muster-tasks.json');
  return { dir, filePath, store: TaskStore.load({ filePath }) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

describe('reload scheduling', () => {
  it('preserves reconciled queued continuation without auto-scheduling on load', async () => {
    const { filePath } = makeTempStore();
    const waitTurnId = 'wait-turn';
    const continuationTurnId = `${waitTurnId}-continuation`;

    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['parent'] = {
        id: 'parent',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'coordinate',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
        wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: waitTurnId },
      };
      draft.tasks['child-1'] = {
        id: 'child-1',
        role: 'worker',
        lifecycle: 'succeeded',
        goal: 'child',
        parentId: 'parent',
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:01.000Z',
        finishedAt: '2026-07-06T00:00:01.000Z',
        result: 'done',
      };
      draft.turns[waitTurnId] = {
        id: waitTurnId,
        taskId: 'parent',
        sequence: 1,
        trigger: 'engine',
        status: 'succeeded',
        inputs: [],
        createdAt: '2026-07-06T00:00:00.000Z',
        finishedAt: '2026-07-06T00:00:00.500Z',
      };
      return { ok: true };
    });

    let runCalls = 0;
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions) {
        runCalls += 1;
        yield { type: 'turnCompleted' } satisfies NormalizedEvent;
      },
    };

    const engine = TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => backend,
      clock: () => '2026-07-06T00:00:02.000Z',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const continuation = TaskStore.load({ filePath }).getFile().turns[continuationTurnId];
    expect(continuation?.status).toBe('queued');
    expect(runCalls).toBe(0);

    const resumed = engine.resumeQueuedTurn(continuationTurnId);
    expect(resumed.ok).toBe(true);
    await engine.whenIdle();
    expect(runCalls).toBe(1);
    expect(TaskStore.load({ filePath }).getFile().turns[continuationTurnId].status).toBe('succeeded');
  });

  it('does not auto-schedule a reload-deferred continuation when an unrelated turn settles', async () => {
    const { filePath } = makeTempStore();
    const waitTurnId = 'wait-turn';
    const continuationTurnId = `${waitTurnId}-continuation`;

    TaskStore.load({ filePath }).commit((draft) => {
      draft.tasks['parent'] = {
        id: 'parent',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'coordinate',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
        wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: waitTurnId },
      };
      draft.tasks['child-1'] = {
        id: 'child-1',
        role: 'worker',
        lifecycle: 'succeeded',
        goal: 'child',
        parentId: 'parent',
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:01.000Z',
        finishedAt: '2026-07-06T00:00:01.000Z',
        result: 'done',
      };
      draft.tasks['other'] = {
        id: 'other',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'other',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns[waitTurnId] = {
        id: waitTurnId,
        taskId: 'parent',
        sequence: 1,
        trigger: 'engine',
        status: 'succeeded',
        inputs: [],
        createdAt: '2026-07-06T00:00:00.000Z',
        finishedAt: '2026-07-06T00:00:00.500Z',
      };
      return { ok: true };
    });

    let runCalls = 0;
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions) {
        runCalls += 1;
        yield { type: 'turnCompleted' } satisfies NormalizedEvent;
      },
    };

    const engine = TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => backend,
      clock: () => '2026-07-06T00:00:02.000Z',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(TaskStore.load({ filePath }).getFile().turns[continuationTurnId]?.status).toBe('queued');
    expect(runCalls).toBe(0);

    const otherStart = engine.startTask('other');
    expect(otherStart.ok).toBe(true);
    await engine.whenIdle();
    expect(runCalls).toBe(1);
    expect(TaskStore.load({ filePath }).getFile().turns[continuationTurnId]?.status).toBe('queued');
  });

  it('rejects resumeQueuedTurn for non-queued or missing turns', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['task-1'] = {
        id: 'task-1',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'x',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 5,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns['turn-1'] = {
        id: 'turn-1',
        taskId: 'task-1',
        sequence: 1,
        trigger: 'user',
        status: 'running',
        inputs: [],
        createdAt: '2026-07-06T00:00:00.000Z',
        startedAt: '2026-07-06T00:00:00.000Z',
      };
      return { ok: true };
    });

    const engine = TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => ({ name: 'fake', capabilities: MCP_CAPS, async *run() {} }),
      clock: () => '2026-07-06T00:00:01.000Z',
    });

    expect(engine.resumeQueuedTurn('missing')).toEqual({ ok: false, reason: 'turn not found' });
    expect(engine.resumeQueuedTurn('turn-1')).toEqual({ ok: false, reason: 'turn is not queued' });
  });

  it('marks reload running turns interrupted when lease is absent', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['task-1'] = {
        id: 'task-1',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'x',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 5,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns['turn-1'] = {
        id: 'turn-1',
        taskId: 'task-1',
        sequence: 1,
        trigger: 'user',
        status: 'running',
        inputs: [],
        createdAt: '2026-07-06T00:00:00.000Z',
        startedAt: '2026-07-06T00:00:00.000Z',
      };
      return { ok: true };
    });

    TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => ({ name: 'fake', capabilities: MCP_CAPS, async *run() {} }),
      clock: () => '2026-07-06T00:00:01.000Z',
    });

    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getFile().turns['turn-1'].status).toBe('interrupted');
    expect(reloaded.viewStatusOf('task-1')).toBe('needs_recovery');
  });
});