import { describe, expect, it } from 'vitest';
import {
  applyFailedTurn,
  applySuccessfulTurn,
  cancelTask,
  continueTask,
  createTask,
  interruptTurn,
  isHardTerminalLifecycle,
  isSettledTurn,
  isSoftTerminalLifecycle,
  isTerminalLifecycle,
  isTerminalTurn,
  hasActiveOrQueuedTurn,
  prepareDeleteQueuedTurn,
  prepareEditQueuedTurn,
  registerAsk,
  reopenSoftFailedTask,
  reopenTask,
  resolveChildWait,
  retryCountOf,
  retryTurn,
  setTaskLifecycle,
  startProcess,
  startTask,
  stageDisposition,
  submitAnswer,
  type CreateTaskContext,
} from './transitions';
import type { DepGraph } from './deps';
import type { MusterTask, TaskMessage, TaskTurn } from './types';

const NOW = '2026-07-06T00:00:00.000Z';

const defaultPolicy = {
  maxTurns: 10,
  maxAutomaticRetries: 2,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 300_000,
};

function baseTask(overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id: 'task-1',
    role: 'coordinator',
    lifecycle: 'open',
    goal: 'test',
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: defaultPolicy,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(overrides: Partial<TaskTurn> & Pick<TaskTurn, 'id' | 'status'>): TaskTurn {
  return {
    taskId: 'task-1',
    sequence: 1,
    trigger: 'user',
    inputs: [],
    createdAt: NOW,
    ...overrides,
  };
}

const emptyGraph: DepGraph = {
  rootOf: () => 'root',
  dependsOn: () => [],
};

const createCtx: CreateTaskContext = {
  rootId: 'root',
  graph: emptyGraph,
  now: NOW,
};

describe('guard helpers', () => {
  it('classifies terminal lifecycle and turn states', () => {
    expect(isTerminalLifecycle('succeeded')).toBe(true);
    expect(isTerminalLifecycle('open')).toBe(false);
    expect(isTerminalTurn('failed')).toBe(true);
    expect(isTerminalTurn('queued')).toBe(false);
    expect(isSettledTurn('interrupted')).toBe(true);
    expect(isSettledTurn('running')).toBe(false);
  });

  it('retryCountOf walks the retry chain', () => {
    const turns: TaskTurn[] = [
      turn({ id: 't1', status: 'failed', sequence: 1 }),
      turn({ id: 't2', status: 'failed', sequence: 2, retryOf: 't1' }),
      turn({ id: 't3', status: 'failed', sequence: 3, retryOf: 't2' }),
    ];
    expect(retryCountOf(turns, 't1')).toBe(0);
    expect(retryCountOf(turns, 't2')).toBe(1);
    expect(retryCountOf(turns, 't3')).toBe(2);
  });
});

describe('createTask', () => {
  it('creates an open task with no turn', () => {
    const result = createTask(
      {
        id: 'task-1',
        role: 'coordinator',
        goal: 'do work',
        parentId: null,
        dependencies: [],
        backend: 'grok',
        capabilities: [],
        executionPolicy: defaultPolicy,
      },
      createCtx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.lifecycle).toBe('open');
      expect(result.effects).toEqual([]);
    }
  });

  it('rejects cyclic dependencies', () => {
    const graph: DepGraph = {
      rootOf: (id) => (id === 'dep-1' ? 'root' : undefined),
      dependsOn: (id) => (id === 'dep-1' ? ['task-1'] : []),
    };
    const result = createTask(
      {
        id: 'task-1',
        role: 'coordinator',
        goal: 'do work',
        parentId: null,
        dependencies: [
          { taskId: 'dep-1', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
        ],
        backend: 'grok',
        capabilities: [],
        executionPolicy: defaultPolicy,
      },
      { ...createCtx, graph },
    );
    expect(result).toEqual({ ok: false, reason: 'dependency cycle detected' });
  });
});

describe('startTask / continueTask', () => {
  it('startTask is valid only before the first turn', () => {
    const task = baseTask();
    const first = startTask(task, [], {
      turnId: 't1',
      now: NOW,
      inputs: [{ kind: 'message', messageId: 'm1' }],
    });
    expect(first.ok).toBe(true);

    const second = startTask(task, first.ok ? [first.next] : [], {
      turnId: 't2',
      now: NOW,
      inputs: [],
    });
    expect(second).toEqual({
      ok: false,
      reason: 'startTask is only valid before the first turn',
    });
  });

  it('continueTask requires a prior turn and allows FIFO queue while live/queued', () => {
    const task = baseTask();
    const liveOnly = turn({ id: 't1', status: 'running', sequence: 1 });
    const settled = turn({ id: 't1', status: 'succeeded', sequence: 1 });
    const active = turn({ id: 't2', status: 'running', sequence: 2 });

    expect(
      continueTask(task, [], { turnId: 't2', now: NOW, inputs: [] }),
    ).toEqual({
      ok: false,
      reason: 'continueTask requires at least one prior turn',
    });

    // R012: first follow-up may queue while the initial turn is still live (no settled yet).
    const behindFirstLive = continueTask(task, [liveOnly], {
      turnId: 't2',
      now: NOW,
      inputs: [{ kind: 'message', messageId: 'm-early' }],
    });
    expect(behindFirstLive.ok).toBe(true);
    if (behindFirstLive.ok) {
      expect(behindFirstLive.next).toMatchObject({
        id: 't2',
        status: 'queued',
        sequence: 2,
        inputs: [{ kind: 'message', messageId: 'm-early' }],
      });
    }

    expect(
      continueTask(task, [settled], { turnId: 't2', now: NOW, inputs: [] }).ok,
    ).toBe(true);

    // R012: follow-up turns may stack behind a live turn (scheduler enforces one-at-a-time).
    const behindLive = continueTask(task, [settled, active], {
      turnId: 't3',
      now: NOW,
      inputs: [{ kind: 'message', messageId: 'm-follow' }],
    });
    expect(behindLive.ok).toBe(true);
    if (behindLive.ok) {
      expect(behindLive.next).toMatchObject({
        id: 't3',
        status: 'queued',
        sequence: 3,
        inputs: [{ kind: 'message', messageId: 'm-follow' }],
      });
    }
  });

  it('allows multiple one-message FIFO queued turns behind a live turn', () => {
    const task = baseTask();
    const settled = turn({ id: 't0', status: 'succeeded', sequence: 1 });
    const live = turn({ id: 't1', status: 'running', sequence: 2 });
    const firstQueued = continueTask(task, [settled, live], {
      turnId: 't2',
      now: NOW,
      inputs: [{ kind: 'message', messageId: 'm2' }],
    });
    expect(firstQueued.ok).toBe(true);
    if (!firstQueued.ok) return;

    const secondQueued = continueTask(task, [settled, live, firstQueued.next], {
      turnId: 't3',
      now: NOW,
      inputs: [{ kind: 'message', messageId: 'm3' }],
    });
    expect(secondQueued.ok).toBe(true);
    if (!secondQueued.ok) return;
    expect(secondQueued.next).toMatchObject({
      id: 't3',
      status: 'queued',
      sequence: 4,
      inputs: [{ kind: 'message', messageId: 'm3' }],
    });
    expect(hasActiveOrQueuedTurn([settled, live, firstQueued.next, secondQueued.next])).toBe(true);
  });

  it('retryTurn still rejects when another active or queued turn exists', () => {
    const task = baseTask();
    const failed = turn({ id: 't1', status: 'failed', sequence: 1 });
    const queued = turn({ id: 't2', status: 'queued', sequence: 2 });
    expect(
      retryTurn(task, [failed, queued], failed, {
        turnId: 't3',
        instruction: 'retry',
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: 'task already has an active or queued turn',
    });
  });
});

describe('turn status transitions', () => {
  it('startProcess sets running with startedAt from now', () => {
    const queued = turn({ id: 't1', status: 'queued', sequence: 1 });
    const result = startProcess(queued, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe('running');
      expect(result.next.startedAt).toBe(NOW);
    }
    expect(startProcess(turn({ id: 't2', status: 'running', sequence: 1 }), { now: NOW })).toEqual({
      ok: false,
      reason: 'startProcess requires a queued turn',
    });
  });

  it('registerAsk and submitAnswer move between running and waiting_user', () => {
    const running = turn({ id: 't1', status: 'running', sequence: 1 });
    const asked = registerAsk(running);
    expect(asked.ok).toBe(true);
    if (asked.ok) {
      expect(asked.next.status).toBe('waiting_user');
    }
    const resumed = submitAnswer(asked.ok ? asked.next : running);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.next.status).toBe('running');
    }
    expect(registerAsk(turn({ id: 't2', status: 'queued', sequence: 1 }))).toEqual({
      ok: false,
      reason: 'registerAsk requires a running turn',
    });
  });
});

describe('applySuccessfulTurn', () => {
  const running = turn({
    id: 't1',
    status: 'running',
    sequence: 1,
    inputs: [{ kind: 'message', messageId: 'm1' }],
  });

  it('rejects terminal tasks and foreign turns', () => {
    expect(
      applySuccessfulTurn(baseTask({ lifecycle: 'succeeded' }), running, { now: NOW }),
    ).toEqual({ ok: false, reason: 'task is terminal' });

    expect(
      applySuccessfulTurn(
        baseTask(),
        { ...running, taskId: 'other-task' },
        { now: NOW },
      ),
    ).toEqual({ ok: false, reason: 'turn does not belong to task' });
  });

  it('rejects non-running turns', () => {
    expect(
      applySuccessfulTurn(baseTask(), turn({ id: 't1', status: 'queued', sequence: 1 }), {
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'applySuccessfulTurn requires a running turn' });
  });

  it('root complete disposition stages proposal without sealing lifecycle', () => {
    const staged = {
      ...running,
      disposition: { kind: 'complete' as const, result: 'done' },
    };
    const result = applySuccessfulTurn(baseTask({ parentId: null }), staged, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.outcomeProposal).toEqual({
        kind: 'complete',
        result: 'done',
        proposedByTurnId: 't1',
        proposedAt: NOW,
      });
      expect(result.next.turn.status).toBe('succeeded');
      expect(result.next.turn.finishedAt).toBe(NOW);
      expect(result.effects).toEqual([
        { kind: 'commitSession' },
        { kind: 'markMessagesComplete', messageIds: ['m1'] },
      ]);
    }
  });

  it('non-root complete disposition seals child for orchestration', () => {
    const staged = {
      ...running,
      taskId: 'child-1',
      disposition: { kind: 'complete' as const, result: 'done' },
    };
    const result = applySuccessfulTurn(
      baseTask({ id: 'child-1', parentId: 'root-1' }),
      staged,
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('succeeded');
      expect(result.next.task.result).toBe('done');
    }
  });

  it('root fail disposition stages proposal without sealing lifecycle', () => {
    const staged = {
      ...running,
      disposition: { kind: 'fail' as const, error: 'boom' },
    };
    const result = applySuccessfulTurn(baseTask({ parentId: null }), staged, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.outcomeProposal).toMatchObject({ kind: 'fail', error: 'boom' });
    }
  });

  it('applies wait_tasks disposition', () => {
    const staged = {
      ...running,
      disposition: { kind: 'wait_tasks' as const, taskIds: ['child-1'] },
    };
    const result = applySuccessfulTurn(baseTask(), staged, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.wait).toEqual({
        kind: 'children',
        taskIds: ['child-1'],
        registeredByTurnId: 't1',
      });
    }
  });

  it('idle or undefined disposition keeps task open', () => {
    for (const disposition of [undefined, { kind: 'idle' as const }]) {
      const result = applySuccessfulTurn(
        baseTask(),
        { ...running, disposition },
        { now: NOW },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.task.lifecycle).toBe('open');
      }
    }
  });
});

describe('applyFailedTurn', () => {
  const running = turn({ id: 't1', status: 'running', sequence: 1 });

  it('rejects terminal tasks and foreign turns', () => {
    expect(
      applyFailedTurn(baseTask({ lifecycle: 'failed' }), running, {
        error: 'x',
        retryCount: 0,
        policy: defaultPolicy,
        onExhausted: 'fail',
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'task is terminal' });

    expect(
      applyFailedTurn(baseTask(), { ...running, taskId: 'other-task' }, {
        error: 'x',
        retryCount: 0,
        policy: defaultPolicy,
        onExhausted: 'fail',
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'turn does not belong to task' });
  });

  it('discards staged disposition and enqueues retry when under limit', () => {
    const staged = {
      ...running,
      disposition: { kind: 'complete' as const, result: 'ignored' },
    };
    const result = applyFailedTurn(baseTask(), staged, {
      error: 'adapter error',
      retryCount: 0,
      policy: defaultPolicy,
      onExhausted: 'fail',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.turn.disposition).toBeUndefined();
      expect(result.next.turn.error).toBe('adapter error');
      expect(result.next.turn.finishedAt).toBe(NOW);
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.effects).toEqual([{ kind: 'enqueueRetry', ofTurnId: 't1' }]);
    }
  });

  it('recover leaves task open when retries exhausted', () => {
    const result = applyFailedTurn(baseTask(), running, {
      error: 'adapter error',
      retryCount: 2,
      policy: defaultPolicy,
      onExhausted: 'recover',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.effects).toEqual([]);
    }
  });

  it('never seals lifecycle failed when retries exhausted (user/coordinator only)', () => {
    const result = applyFailedTurn(baseTask(), running, {
      error: 'adapter error',
      retryCount: 2,
      policy: defaultPolicy,
      onExhausted: 'fail',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.effects).toEqual([]);
    }
  });

  it('setTaskLifecycle seals succeeded for user', () => {
    const result = setTaskLifecycle(baseTask(), 'succeeded', { now: NOW, result: 'shipped' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.lifecycle).toBe('succeeded');
      expect(result.next.result).toBe('shipped');
    }
  });

  it('setTaskLifecycle reopens any terminal task to open', () => {
    for (const lifecycle of ['failed', 'succeeded', 'cancelled', 'skipped'] as const) {
      const result = setTaskLifecycle(
        baseTask({ lifecycle, finishedAt: NOW, error: lifecycle === 'failed' ? 'x' : undefined }),
        'open',
        { now: NOW },
      );
      expect(result.ok, lifecycle).toBe(true);
      if (result.ok) {
        expect(result.next.lifecycle).toBe('open');
        expect(result.next.finishedAt).toBeUndefined();
      }
    }

    expect(setTaskLifecycle(baseTask({ lifecycle: 'open' }), 'open', { now: NOW }).ok).toBe(true);
  });
});

describe('interruptTurn', () => {
  it('interrupts live turns and discards disposition', () => {
    const running = turn({
      id: 't1',
      status: 'running',
      sequence: 1,
      disposition: { kind: 'complete', result: 'x' },
    });
    const result = interruptTurn(running, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe('interrupted');
      expect(result.next.finishedAt).toBe(NOW);
      expect(result.next.disposition).toBeUndefined();
    }
    expect(interruptTurn(turn({ id: 't2', status: 'queued', sequence: 1 }), { now: NOW })).toEqual({
      ok: false,
      reason: 'interruptTurn requires a live turn',
    });
  });
});

describe('retryTurn', () => {
  const task = baseTask();
  const failed = turn({ id: 't1', status: 'failed', sequence: 1 });

  it('creates a retry turn with retryOf set', () => {
    const result = retryTurn(task, [failed], failed, {
      turnId: 't2',
      instruction: 'try again',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.retryOf).toBe('t1');
      expect(result.next.trigger).toBe('retry');
      expect(result.next.inputs[0]).toEqual({
        kind: 'recovery',
        interruptedTurnId: 't1',
        instruction: 'try again',
      });
    }
  });

  it('rejects foreign or non-retryable old turns', () => {
    const foreign = { ...failed, taskId: 'other-task' };
    expect(
      retryTurn(task, [failed], foreign, { turnId: 't2', instruction: 'x', now: NOW }),
    ).toEqual({ ok: false, reason: 'oldTurn does not belong to task' });

    expect(
      retryTurn(task, [failed], turn({ id: 't9', status: 'succeeded', sequence: 1 }), {
        turnId: 't2',
        instruction: 'x',
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: 'oldTurn is not in turns',
    });

    expect(
      retryTurn(
        task,
        [turn({ id: 't1', status: 'succeeded', sequence: 1 })],
        turn({ id: 't1', status: 'succeeded', sequence: 1 }),
        { turnId: 't2', instruction: 'x', now: NOW },
      ),
    ).toEqual({
      ok: false,
      reason: 'retryTurn requires a failed or interrupted turn',
    });
  });
});

describe('terminal reopen', () => {
  it('reopens failed tasks to open', () => {
    const task = baseTask({ lifecycle: 'failed', finishedAt: NOW, error: 'nope' });
    expect(isSoftTerminalLifecycle(task.lifecycle)).toBe(true);
    expect(isHardTerminalLifecycle(task.lifecycle)).toBe(false);
    const result = reopenTask(task, { now: '2026-07-06T01:00:00.000Z' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.lifecycle).toBe('open');
      expect(result.next.finishedAt).toBeUndefined();
      expect(result.next.error).toBe('nope');
    }
  });

  it('reopens hard-terminal tasks to open', () => {
    for (const lifecycle of ['succeeded', 'cancelled', 'skipped'] as const) {
      const result = reopenTask(baseTask({ lifecycle, finishedAt: NOW }), { now: NOW });
      expect(result.ok, lifecycle).toBe(true);
      if (result.ok) {
        expect(result.next.lifecycle).toBe('open');
        expect(result.next.finishedAt).toBeUndefined();
      }
    }
  });

  it('rejects reopen of open tasks', () => {
    expect(reopenTask(baseTask({ lifecycle: 'open' }), { now: NOW })).toEqual({
      ok: false,
      reason: 'task is not terminal',
    });
  });

  it('legacy soft helper still rejects non-failed tasks', () => {
    expect(reopenSoftFailedTask(baseTask({ lifecycle: 'succeeded' }), { now: NOW })).toEqual({
      ok: false,
      reason: 'task is not soft-failed',
    });
    expect(reopenSoftFailedTask(baseTask({ lifecycle: 'open' }), { now: NOW })).toEqual({
      ok: false,
      reason: 'task is not soft-failed',
    });
  });
});

describe('resolveChildWait', () => {
  it('rejects terminal tasks', () => {
    const task = baseTask({
      lifecycle: 'succeeded',
      wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: 't1' },
    });
    expect(
      resolveChildWait(
        task,
        new Map([['child-1', 'succeeded']]),
        [],
        { continuationTurnId: 'cont-1', now: NOW },
      ),
    ).toEqual({ ok: false, reason: 'task is terminal' });
  });
});

describe('cancelTask', () => {
  it('rejects a live turn owned by another task', () => {
    const task = baseTask();
    const foreign = turn({ id: 't1', status: 'running', sequence: 1, taskId: 'other-task' });
    expect(cancelTask(task, { liveTurn: foreign, now: NOW })).toEqual({
      ok: false,
      reason: 'turn does not belong to task',
    });
  });

  it('cancels task and live turn together', () => {
    const task = baseTask();
    const live = turn({ id: 't1', status: 'running', sequence: 1 });
    const result = cancelTask(task, { liveTurn: live, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('cancelled');
      expect(result.next.task.finishedAt).toBe(NOW);
      expect(result.next.turn?.status).toBe('cancelled');
      expect(result.next.turn?.finishedAt).toBe(NOW);
      expect(result.effects).toEqual([{ kind: 'cancelProcess' }]);
    }
  });

  it('rejects terminal tasks', () => {
    expect(cancelTask(baseTask({ lifecycle: 'cancelled' }), { now: NOW })).toEqual({
      ok: false,
      reason: 'task is already terminal',
    });
  });
});

describe('stageDisposition rejections', () => {
  it('rejects staging on non-live turns', () => {
    expect(
      stageDisposition(
        turn({ id: 't1', status: 'queued', sequence: 1 }),
        { kind: 'idle' },
        'op-1',
        {},
      ),
    ).toEqual({ ok: false, reason: 'stageDisposition requires a live turn' });
  });
});

describe('prepareEditQueuedTurn / prepareDeleteQueuedTurn', () => {
  function userMessage(overrides: Partial<TaskMessage> & Pick<TaskMessage, 'id'>): TaskMessage {
    return {
      taskId: 'task-1',
      role: 'user',
      content: 'hello',
      state: 'pending',
      createdAt: NOW,
      ...overrides,
    };
  }

  it('edits only the bound pending user message content of a queued turn', () => {
    const queued = turn({
      id: 't2',
      status: 'queued',
      sequence: 2,
      inputs: [{ kind: 'message', messageId: 'm2' }],
    });
    const messages = {
      m2: userMessage({ id: 'm2', content: 'old' }),
      m1: userMessage({ id: 'm1', content: 'live', state: 'assigned', turnId: 't1' }),
    };
    const result = prepareEditQueuedTurn('task-1', queued, messages, '  revised  ');
    expect(result).toEqual({
      ok: true,
      next: { messageId: 'm2', content: 'revised' },
      effects: [],
    });
  });

  it('refuses edit when turn is missing, foreign, or not queued', () => {
    const messages = { m1: userMessage({ id: 'm1' }) };
    expect(prepareEditQueuedTurn('task-1', undefined, messages, 'x')).toEqual({
      ok: false,
      reason: 'turn not found',
    });
    expect(
      prepareEditQueuedTurn(
        'task-1',
        turn({ id: 't1', taskId: 'other', status: 'queued', sequence: 1, inputs: [{ kind: 'message', messageId: 'm1' }] }),
        messages,
        'x',
      ),
    ).toEqual({ ok: false, reason: 'turn does not belong to task' });
    expect(
      prepareEditQueuedTurn(
        'task-1',
        turn({ id: 't1', status: 'running', sequence: 1, inputs: [{ kind: 'message', messageId: 'm1' }] }),
        messages,
        'x',
      ),
    ).toEqual({ ok: false, reason: 'turn is not queued' });
    expect(
      prepareEditQueuedTurn(
        'task-1',
        turn({ id: 't1', status: 'succeeded', sequence: 1, inputs: [{ kind: 'message', messageId: 'm1' }] }),
        messages,
        'x',
      ),
    ).toEqual({ ok: false, reason: 'turn is not queued' });
  });

  it('refuses edit for empty content or non-pending bound messages', () => {
    const queued = turn({
      id: 't1',
      status: 'queued',
      sequence: 1,
      inputs: [{ kind: 'message', messageId: 'm1' }],
    });
    expect(prepareEditQueuedTurn('task-1', queued, { m1: userMessage({ id: 'm1' }) }, '   ')).toEqual({
      ok: false,
      reason: 'invalid content',
    });
    expect(prepareEditQueuedTurn('task-1', queued, {}, 'ok')).toEqual({
      ok: false,
      reason: 'message not found',
    });
    expect(
      prepareEditQueuedTurn(
        'task-1',
        queued,
        { m1: userMessage({ id: 'm1', state: 'assigned', turnId: 't1' }) },
        'ok',
      ),
    ).toEqual({ ok: false, reason: 'message is not pending' });
  });

  it('deletes a queued turn and its pending user messages only', () => {
    const queued = turn({
      id: 't2',
      status: 'queued',
      sequence: 2,
      inputs: [{ kind: 'message', messageId: 'm2' }],
    });
    const messages = {
      m2: userMessage({ id: 'm2', content: 'follow-up' }),
      m1: userMessage({ id: 'm1', content: 'live', state: 'assigned', turnId: 't1' }),
    };
    expect(prepareDeleteQueuedTurn('task-1', queued, messages)).toEqual({
      ok: true,
      next: { turnId: 't2', messageIds: ['m2'] },
      effects: [],
    });
  });

  it('refuses delete when turn is not queued or messages are not pending', () => {
    const messages = { m1: userMessage({ id: 'm1' }) };
    expect(prepareDeleteQueuedTurn('task-1', undefined, messages)).toEqual({
      ok: false,
      reason: 'turn not found',
    });
    expect(
      prepareDeleteQueuedTurn(
        'task-1',
        turn({ id: 't1', status: 'running', sequence: 1, inputs: [{ kind: 'message', messageId: 'm1' }] }),
        messages,
      ),
    ).toEqual({ ok: false, reason: 'turn is not queued' });
    expect(
      prepareDeleteQueuedTurn(
        'task-1',
        turn({ id: 't1', status: 'queued', sequence: 1, inputs: [{ kind: 'message', messageId: 'm1' }] }),
        { m1: userMessage({ id: 'm1', state: 'assigned' }) },
      ),
    ).toEqual({ ok: false, reason: 'message is not pending' });
  });
});