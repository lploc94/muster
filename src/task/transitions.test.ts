import { describe, expect, it } from 'vitest';
import {
  applyDependencyTerminal,
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
  mergeWaitDisposition,
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
import type { MusterTask, TaskBriefKind, TaskDependency, TaskMessage, TaskTurn } from './types';

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

  it('merges wait dispositions monotonically while preserving terminal conflicts', () => {
    const live = turn({ status: 'running' });
    const first = mergeWaitDisposition(live, ['a', 'a', 'b']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next).toMatchObject({
      addedTaskIds: ['a', 'b'],
      alreadyStaged: false,
      waitTaskIds: ['a', 'b'],
    });
    const second = mergeWaitDisposition(first.next.turn, ['b', 'c', 'a']);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.next).toMatchObject({
      addedTaskIds: ['c'],
      alreadyStaged: false,
      waitTaskIds: ['a', 'b', 'c'],
    });
    const redundant = mergeWaitDisposition(second.next.turn, ['c', 'a']);
    expect(redundant.ok && redundant.next.alreadyStaged).toBe(true);
    expect(
      mergeWaitDisposition({ ...live, disposition: { kind: 'complete', result: 'done' } }, ['a']),
    ).toEqual({ ok: false, reason: 'disposition conflict: current disposition is complete' });
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
      expect(result.next.releaseState).toBe('draft');
      expect(result.next.brief?.objective).toBe('do work');
      expect(result.next.brief?.kind).toBe('generic');
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

  // verify-gate-loop B: depending on a verify-kind producer auto-defaults requiredVerdict.
  const gateGraph = (kindById: Record<string, TaskBriefKind>): DepGraph => ({
    rootOf: (id) => (id in kindById ? 'root' : undefined),
    dependsOn: () => [],
    briefKindOf: (id) => kindById[id],
  });

  function createWithDep(dep: TaskDependency, graph: DepGraph) {
    return createTask(
      {
        id: 'task-1',
        role: 'worker',
        goal: 'do work',
        parentId: 'root',
        dependencies: [dep],
        backend: 'grok',
        capabilities: [],
        executionPolicy: defaultPolicy,
      },
      { ...createCtx, graph },
    );
  }

  it('auto-gates a dependency on a verify-kind producer (requiredVerdict defaults to pass)', () => {
    const result = createWithDep(
      { taskId: 'vfy', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
      gateGraph({ vfy: 'verify' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.dependencies).toEqual([
        { taskId: 'vfy', requiredOutcome: 'succeeded', onUnsatisfied: 'block', requiredVerdict: 'pass' },
      ]);
    }
  });

  it('does NOT auto-gate a dependency on a non-verify producer', () => {
    const result = createWithDep(
      { taskId: 'impl', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
      gateGraph({ impl: 'implement' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.dependencies).toEqual([
        { taskId: 'impl', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
      ]);
      expect(result.next.dependencies[0].requiredVerdict).toBeUndefined();
    }
  });

  it('never overwrites an explicit requiredVerdict on a verify-kind dependency', () => {
    const result = createWithDep(
      { taskId: 'vfy', requiredOutcome: 'settled', onUnsatisfied: 'skip', requiredVerdict: 'pass' },
      gateGraph({ vfy: 'verify' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.dependencies).toEqual([
        { taskId: 'vfy', requiredOutcome: 'settled', onUnsatisfied: 'skip', requiredVerdict: 'pass' },
      ]);
    }
  });

  it('skipVerifyAutoGate opts out (remediation-safe: a fix may depend on the failed verify)', () => {
    const result = createTask(
      {
        id: 'task-1',
        role: 'worker',
        goal: 'fix',
        parentId: 'root',
        dependencies: [{ taskId: 'vfy', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        backend: 'grok',
        capabilities: [],
        executionPolicy: defaultPolicy,
      },
      { ...createCtx, graph: gateGraph({ vfy: 'verify' }), skipVerifyAutoGate: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.dependencies[0].requiredVerdict).toBeUndefined();
    }
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
      expect(result.next.task.taskResult).toEqual({
        version: 1,
        revision: 1,
        summary: 'done',
      });
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
      expect(result.next.task.taskResult).toEqual({
        version: 1,
        revision: 1,
        summary: 'done',
      });
      expect(result.next.task.sealedBy).toEqual({
        kind: 'coordinator',
        taskId: 'root-1',
        turnId: 't1',
        mode: 'parent_may_seal_direct',
      });
    }
  });

  it('workflow_next settles turn without sealing lifecycle (root or child)', () => {
    for (const parentId of [null, 'root-1'] as const) {
      const taskId = parentId === null ? 'task-1' : 'child-1';
      const staged = {
        ...running,
        taskId,
        disposition: {
          kind: 'workflow_next' as const,
          change: 'updated' as const,
          result: 'producer output',
        },
      };
      const result = applySuccessfulTurn(
        baseTask({ id: taskId, parentId }),
        staged,
        { now: NOW },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.sealedBy).toBeUndefined();
      expect(result.next.task.taskResult).toBeUndefined();
      expect(result.next.task.outcomeProposal).toBeUndefined();
      expect(result.next.turn.status).toBe('succeeded');
      expect(result.next.turn.finishedAt).toBe(NOW);
      // Disposition retained for the repository commit path (T04 gate contribution).
      expect(result.next.turn.disposition).toEqual({
        kind: 'workflow_next',
        change: 'updated',
        result: 'producer output',
      });
    }
  });

  it('idle disposition on child sets awaiting_parent_seal with completionCandidate without sealing', () => {
    const result = applySuccessfulTurn(
      baseTask({ id: 'child-1', parentId: 'root-1' }),
      { ...running, taskId: 'child-1', disposition: { kind: 'idle' } },
      { now: NOW, candidateSummary: 'child finished work' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.attention?.code).toBe('awaiting_parent_seal');
      expect(result.next.task.attention?.sourceTurnId).toBe('t1');
      expect(result.next.task.completionCandidate).toEqual({
        version: 1,
        sourceTurnId: 't1',
        observedAt: NOW,
        summary: 'child finished work',
        reason: 'missing_disposition',
      });
      expect(result.next.task.taskResult).toBeUndefined();
      expect(result.next.task.sealedBy).toBeUndefined();
      expect(result.next.turn.status).toBe('succeeded');
    }
  });

  it('idle disposition on root leaves open/idle without attention or completionCandidate', () => {
    const result = applySuccessfulTurn(
      baseTask({ parentId: null }),
      { ...running, disposition: { kind: 'idle' } },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.attention).toBeUndefined();
      expect(result.next.task.completionCandidate).toBeUndefined();
      expect(result.next.task.sealedBy).toBeUndefined();
      expect(result.next.turn.status).toBe('succeeded');
    }
  });

  it('legacy disposition-repair turn id also settles to awaiting_parent_seal (no repair special-case)', () => {
    const result = applySuccessfulTurn(
      baseTask({ id: 'child-1', parentId: 'root-1' }),
      {
        ...running,
        id: 't1-disposition-repair',
        taskId: 'child-1',
        disposition: { kind: 'idle' },
      },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.attention?.code).toBe('awaiting_parent_seal');
      expect(result.next.task.completionCandidate?.sourceTurnId).toBe('t1-disposition-repair');
      expect(result.next.task.completionCandidate?.reason).toBe('missing_disposition');
      expect(result.next.task.completionCandidate?.summary.length).toBeGreaterThan(0);
    }
  });

  it('resolveChildWait attention-wakes on awaiting_parent_seal', () => {
    const parent = baseTask({
      id: 'coord',
      parentId: null,
      wait: {
        kind: 'children',
        taskIds: ['child-1'],
        registeredByTurnId: 't-wait',
        wakeOn: ['terminal', 'needs_attention'],
        phase: 'active',
        terminalObserved: {},
      },
    });
    const result = resolveChildWait(
      parent,
      new Map([['child-1', 'open']]),
      [turn({ id: 't-wait', status: 'succeeded', sequence: 1 })],
      {
        continuationTurnId: 't-wait-continuation',
        now: NOW,
        childAttention: new Map([['child-1', { code: 'awaiting_parent_seal' }]]),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.turn?.id).toBe('t-wait-attention');
      const wait = result.next.task.wait;
      expect(wait?.kind === 'children' ? wait.phase : undefined).toBe('suspended_attention');
    }
  });

  it('resolveChildWait attention-wakes on missing_disposition', () => {
    const parent = baseTask({
      id: 'coord',
      parentId: null,
      wait: {
        kind: 'children',
        taskIds: ['child-1'],
        registeredByTurnId: 't-wait',
        wakeOn: ['terminal', 'needs_attention'],
        phase: 'active',
        terminalObserved: {},
      },
    });
    const result = resolveChildWait(
      parent,
      new Map([['child-1', 'open']]),
      [turn({ id: 't-wait', status: 'succeeded', sequence: 1 })],
      {
        continuationTurnId: 't-wait-continuation',
        now: NOW,
        childAttention: new Map([['child-1', { code: 'missing_disposition' }]]),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.turn?.id).toBe('t-wait-attention');
      const wait = result.next.task.wait;
      expect(wait?.kind === 'children' ? wait.phase : undefined).toBe('suspended_attention');
    }
  });

  it('propose_only root policy keeps child open with outcome proposal', () => {
    const staged = {
      ...running,
      taskId: 'child-1',
      disposition: { kind: 'complete' as const, result: 'done' },
    };
    const result = applySuccessfulTurn(
      baseTask({ id: 'child-1', parentId: 'root-1' }),
      staged,
      { now: NOW, rootChildOrchestrationSeal: 'propose_only' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('open');
      expect(result.next.task.outcomeProposal).toMatchObject({ kind: 'complete', result: 'done' });
      expect(result.next.task.sealedBy).toBeUndefined();
    }
  });

  it('dependency fail sets sealedBy coordinator dependency_policy', () => {
    const result = applyDependencyTerminal(
      baseTask({ id: 'impl', parentId: 'root-1' }),
      undefined,
      'failed',
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('failed');
      expect(result.next.task.sealedBy).toEqual({
        kind: 'coordinator',
        taskId: 'root-1',
        mode: 'dependency_policy',
      });
    }
  });

  it('dependency skip and cancelTask set sealedBy', () => {
    const skip = applyDependencyTerminal(
      baseTask({ id: 'impl', parentId: 'root-1' }),
      undefined,
      'skipped',
      { now: NOW },
    );
    expect(skip.ok).toBe(true);
    if (skip.ok) {
      expect(skip.next.task.lifecycle).toBe('skipped');
      expect(skip.next.task.sealedBy?.kind).toBe('coordinator');
      expect(skip.next.task.sealedBy && 'mode' in skip.next.task.sealedBy
        ? skip.next.task.sealedBy.mode
        : undefined).toBe('dependency_policy');
    }
    const cancelled = cancelTask(baseTask({ id: 'c1', parentId: 'root-1' }), {
      now: NOW,
      sealedBy: { kind: 'user' },
    });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.next.task.sealedBy).toEqual({ kind: 'user' });
    }
  });

  it('non-root fail disposition seals with coordinator sealedBy', () => {
    const staged = {
      ...running,
      taskId: 'child-1',
      disposition: { kind: 'fail' as const, error: 'boom' },
    };
    const result = applySuccessfulTurn(
      baseTask({ id: 'child-1', parentId: 'root-1' }),
      staged,
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.task.lifecycle).toBe('failed');
      expect(result.next.task.sealedBy).toMatchObject({
        kind: 'coordinator',
        taskId: 'root-1',
        mode: 'parent_may_seal_direct',
      });
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
        wakeOn: ['terminal', 'needs_attention'],
        phase: 'active',
        terminalObserved: {},
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

  it('discards staged disposition and enqueues retry when under limit (safe_to_retry only)', () => {
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
      failureClass: 'safe_to_retry',
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

  it('suppresses generic auto-retry for mcp setup exhaustion even when safe_to_retry', () => {
    const result = applyFailedTurn(baseTask(), running, {
      error: 'mcp setup exhausted (attempts_exhausted): missing_evidence after 2 attempts',
      retryCount: 0,
      policy: defaultPolicy,
      onExhausted: 'recover',
      now: NOW,
      failureClass: 'safe_to_retry',
      suppressAutoRetry: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effects).toEqual([]);
      expect(result.next.turn.failureClass).toBe('safe_to_retry');
      expect(result.next.task.lifecycle).toBe('open');
    }
  });

  it('does not auto-retry unclassified failures', () => {
    const result = applyFailedTurn(baseTask(), running, {
      error: 'adapter error',
      retryCount: 0,
      policy: defaultPolicy,
      onExhausted: 'recover',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effects).toEqual([]);
      expect(result.next.turn.failureClass).toBe('unclassified');
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
    const result = setTaskLifecycle(baseTask(), 'succeeded', {
      now: NOW,
      result: 'shipped',
      sealedBy: { kind: 'user' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.lifecycle).toBe('succeeded');
      expect(result.next.taskResult).toEqual({
        version: 1,
        revision: 1,
        summary: 'shipped',
      });
      expect(result.next.sealedBy).toEqual({ kind: 'user' });
    }
  });

  it('setTaskLifecycle succeeded without summary does not invent empty TaskResult', () => {
    const result = setTaskLifecycle(baseTask(), 'succeeded', { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.lifecycle).toBe('succeeded');
      expect(result.next.taskResult).toBeUndefined();
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

  it('stages workflow_next idempotently by opId and requires limits', () => {
    const live = turn({ id: 't1', status: 'running', sequence: 1 });
    const limits = { maxResult: 1024, maxError: 1024 };
    expect(
      stageDisposition(live, { kind: 'workflow_next', change: 'updated' }, 'op-next', {}),
    ).toEqual({
      ok: false,
      reason: 'limits are required for complete, fail, or workflow_next dispositions',
    });

    const first = stageDisposition(
      live,
      { kind: 'workflow_next', change: 'updated', result: 'body' },
      'op-next',
      { limits },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next.turn.disposition).toEqual({
      kind: 'workflow_next',
      change: 'updated',
      result: 'body',
    });

    // Same opId + same disposition is idempotent.
    const replay = stageDisposition(
      first.next.turn,
      { kind: 'workflow_next', change: 'updated', result: 'body' },
      'op-next',
      { acceptedOpId: 'op-next', limits },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.next.turn.disposition).toEqual(first.next.turn.disposition);

    // Same opId + different disposition fails closed.
    expect(
      stageDisposition(
        first.next.turn,
        { kind: 'workflow_next', change: 'unchanged' },
        'op-next',
        { acceptedOpId: 'op-next', limits },
      ),
    ).toEqual({ ok: false, reason: 'same opId with different disposition' });

    // Different opId after staging fails closed.
    expect(
      stageDisposition(
        first.next.turn,
        { kind: 'workflow_next', change: 'updated', result: 'body' },
        'op-other',
        { limits },
      ),
    ).toEqual({ ok: false, reason: 'disposition already staged with a different opId' });
  });

  it('stages workflow_prev idempotently and rejects conflicting replay', () => {
    const live = turn({ status: 'running' });
    const first = stageDisposition(
      live,
      { kind: 'workflow_prev', targets: 'all', note: 'please fix' },
      'op-prev-1',
      { limits: { maxResult: 1024, maxError: 512 } },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next.turn.disposition).toEqual({
      kind: 'workflow_prev',
      targets: 'all',
      note: 'please fix',
    });
    const replay = stageDisposition(
      first.next.turn,
      { kind: 'workflow_prev', targets: 'all', note: 'please fix' },
      'op-prev-1',
      {
        acceptedOpId: 'op-prev-1',
        limits: { maxResult: 1024, maxError: 512 },
      },
    );
    expect(replay.ok).toBe(true);
    const conflict = stageDisposition(
      first.next.turn,
      { kind: 'workflow_prev', targets: ['from_p1'] },
      'op-prev-1',
      {
        acceptedOpId: 'op-prev-1',
        limits: { maxResult: 1024, maxError: 512 },
      },
    );
    expect(conflict.ok).toBe(false);
  });

  it('applySuccessfulTurn keeps workflow_prev without sealing lifecycle', () => {
    const task = baseTask();
    const live = turn({
      status: 'running',
      disposition: { kind: 'workflow_prev', targets: 'all' },
    });
    const settled = applySuccessfulTurn(task, live, { now: NOW });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.next.task.lifecycle).toBe('open');
    expect(settled.next.turn.status).toBe('succeeded');
    expect(settled.next.turn.disposition?.kind).toBe('workflow_prev');
  });

  it('applyFailedTurn and interruptTurn discard staged workflow_prev', () => {
    const task = baseTask();
    const live = turn({
      status: 'running',
      disposition: { kind: 'workflow_prev', targets: ['from_p1'], note: 'n' },
    });
    const failed = applyFailedTurn(task, live, {
      error: 'boom',
      retryCount: 0,
      policy: { maxTurns: 4, maxAutomaticRetries: 0 },
      onExhausted: 'recover',
      now: NOW,
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.next.turn.disposition).toBeUndefined();
    }
    const interrupted = interruptTurn(live, { now: NOW });
    expect(interrupted.ok).toBe(true);
    if (interrupted.ok) {
      expect(interrupted.next.disposition).toBeUndefined();
    }
  });

  it('applyFailedTurn and interruptTurn discard staged workflow_next', () => {
    const live = turn({
      id: 't1',
      status: 'running',
      sequence: 1,
      disposition: { kind: 'workflow_next', change: 'updated', result: 'body' },
    });
    const failed = applyFailedTurn(baseTask(), live, {
      error: 'boom',
      retryCount: 0,
      policy: defaultPolicy,
      onExhausted: 'recover',
      now: NOW,
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.next.turn.disposition).toBeUndefined();
      expect(failed.next.task.lifecycle).toBe('open');
    }

    const interrupted = interruptTurn(live, { now: NOW });
    expect(interrupted.ok).toBe(true);
    if (interrupted.ok) {
      expect(interrupted.next.disposition).toBeUndefined();
      expect(interrupted.next.status).toBe('interrupted');
    }
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
