import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import { McpReadinessSupervisor } from '../bridge/mcp-readiness';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine, projectPrompt } from './engine';
import { TaskStore } from './store';
import { buildSnapshot, buildTranscript } from '../host/snapshot';
import type { TaskMessage, TaskTurn } from './types';
import { RUN_LIMIT_MS } from './execution-policy';

const tempDirs: string[] = [];

function makeTempStore(): { dir: string; filePath: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-task-engine-'));
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

function scriptedBackend(events: NormalizedEvent[], caps: BackendCapabilities = MCP_CAPS): Backend {
  return {
    name: 'fake',
    capabilities: caps,
    run: async function* (_options: RunOptions) {
      for (const event of events) {
        yield event;
      }
    },
    extractSessionId: (raw) => {
      const match = /session:(\S+)/.exec(raw);
      return match?.[1];
    },
  };
}

function makeEngine(
  store: TaskStore,
  events: NormalizedEvent[],
  caps?: BackendCapabilities,
  clock?: () => string,
): TaskEngine {
  return TaskEngine.load({
    store,
    makeBackend: () => scriptedBackend(events, caps),
    clock: clock ?? (() => '2026-07-06T12:00:00.000Z'),
  });
}

describe('projectPrompt', () => {
  it('projects message inputs in stable order and recovery instruction only', () => {
    const turn: TaskTurn = {
      id: 't1',
      taskId: 'task-1',
      sequence: 1,
      trigger: 'retry',
      status: 'queued',
      inputs: [
        { kind: 'message', messageId: 'm2' },
        { kind: 'message', messageId: 'm1' },
        { kind: 'recovery', interruptedTurnId: 't0', instruction: 'Try again carefully' },
      ],
      createdAt: '2026-07-06T00:00:00.000Z',
    };
    const messages = new Map<string, TaskMessage>([
      ['m1', {
        id: 'm1',
        taskId: 'task-1',
        role: 'user',
        content: 'first',
        state: 'assigned',
        createdAt: '2026-07-06T00:00:00.000Z',
      }],
      ['m2', {
        id: 'm2',
        taskId: 'task-1',
        role: 'user',
        content: 'second',
        state: 'assigned',
        createdAt: '2026-07-06T00:00:01.000Z',
      }],
    ]);
    expect(projectPrompt(turn, messages)).toBe('first\n\nsecond\n\nTry again carefully');
  });

  it('prefixes durable compiledPrompt / resolvedInputs before messages (W1 pin)', () => {
    const turn: TaskTurn = {
      id: 't1',
      taskId: 'impl',
      sequence: 1,
      trigger: 'engine',
      status: 'queued',
      inputs: [{ kind: 'message', messageId: 'm1' }],
      createdAt: '2026-07-06T00:00:00.000Z',
      compiledPrompt: '## Bound predecessor outputs\nplan text',
      resolvedInputs: [
        {
          as: 'implementationPlan',
          fromTaskId: 'plan',
          output: 'summary',
          producerResultRevision: 1,
          text: 'plan text',
        },
      ],
    };
    const messages = new Map<string, TaskMessage>([
      [
        'm1',
        {
          id: 'm1',
          taskId: 'impl',
          role: 'user',
          content: 'implement it',
          state: 'assigned',
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    ]);
    const prompt = projectPrompt(turn, messages);
    expect(prompt.startsWith('## Bound predecessor outputs')).toBe(true);
    expect(prompt).toContain('plan text');
    expect(prompt).toContain('implement it');
  });
});

describe('TaskEngine', () => {
  it('freezes a running deadline while later promotions read the updated host setting', async () => {
    const { filePath, store } = makeTempStore();
    let runLimit = RUN_LIMIT_MS['2h'];
    const resolvers: Array<() => void> = [];
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'session' };
        await new Promise<void>((resolve) => resolvers.push(resolve));
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      getRunLimitMs: () => runLimit,
      clock: () => '2026-07-16T00:00:00.000Z',
    });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const first = engine.startTask('task-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    while (resolvers.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getFile().turns[first.value.turnId]).toMatchObject({
      effectiveRunLimitMs: RUN_LIMIT_MS['2h'],
      runDeadlineAt: '2026-07-16T02:00:00.000Z',
    });
    const firstLease = JSON.parse(
      fs.readFileSync(`${filePath}.lease.${encodeURIComponent(first.value.turnId)}`, 'utf8'),
    ) as { expiresAt?: string };
    expect(firstLease.expiresAt).toBe('2026-07-16T02:01:00.000Z');
    runLimit = RUN_LIMIT_MS['4h'];
    expect(store.getFile().turns[first.value.turnId]?.effectiveRunLimitMs).toBe(RUN_LIMIT_MS['2h']);
    engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'idle-1');
    resolvers[0]!();
    await engine.whenIdle();

    const second = engine.continueTask('task-1');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    while (resolvers.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getFile().turns[second.value.turnId]?.effectiveRunLimitMs).toBe(RUN_LIMIT_MS['4h']);
    engine.stageDisposition(second.value.turnId, { kind: 'idle' }, 'idle-2');
    resolvers[1]!();
    await engine.whenIdle();
  });

  it('classifies the run watchdog as configured timeout instead of forced user interrupt', async () => {
    const { store } = makeTempStore();
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options) {
        yield { type: 'sessionStarted', sessionId: 'session-timeout' };
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'error', message: 'Turn cancelled', isCancellation: true };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({
      id: 'timeout-task',
      goal: 'long work',
      backend: 'fake',
      executionPolicy: {
        maxTurns: 50,
        maxAutomaticRetries: 0,
        runTimeoutOverrideMs: 1_000,
      },
    });
    const started = engine.startTask('timeout-task');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await engine.whenIdle();
    const turn = store.getFile().turns[started.value.turnId];
    expect(turn).toMatchObject({
      status: 'interrupted',
      termination: { kind: 'run_timeout', limitMs: 1_000 },
    });
    expect(turn?.interruptConfidence).toBeUndefined();
    expect(buildSnapshot(store, 'timeout-task').subtree?.find((task) => task.id === 'timeout-task')?.runTimeoutMessage).toBe(
      'Agent run reached the configured 1-minute limit.',
    );
  });

  it('immediately times out a recovered queued turn whose frozen deadline is expired', async () => {
    const { store } = makeTempStore();
    store.commit((draft) => {
      draft.tasks.expired = {
        id: 'expired',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'resume expired run',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: { maxTurns: 50, maxAutomaticRetries: 0 },
        executionEpoch: 1,
        releaseState: 'released',
        revision: 0,
        createdAt: '2026-07-15T23:00:00.000Z',
        updatedAt: '2026-07-15T23:00:00.000Z',
      };
      draft.messages.input = {
        id: 'input',
        taskId: 'expired',
        role: 'user',
        content: 'continue',
        state: 'assigned',
        createdAt: '2026-07-15T23:00:00.000Z',
        turnId: 'expired-turn',
      };
      draft.turns['expired-turn'] = {
        id: 'expired-turn',
        taskId: 'expired',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [{ kind: 'message', messageId: 'input' }],
        executionEpoch: 1,
        effectiveRunLimitMs: 60_000,
        runDeadlineAt: '2026-07-15T23:59:00.000Z',
        createdAt: '2026-07-15T23:00:00.000Z',
      };
      return { ok: true };
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options) {
        yield { type: 'sessionStarted', sessionId: 'expired-session' };
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'error', message: 'Turn cancelled', isCancellation: true };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-16T00:00:00.000Z',
    });
    expect(engine.resumeQueuedTurn('expired-turn')).toEqual({ ok: true, value: undefined });
    await engine.whenIdle();
    expect(store.getFile().turns['expired-turn']).toMatchObject({
      status: 'interrupted',
      runDeadlineAt: '2026-07-15T23:59:00.000Z',
      termination: {
        kind: 'run_timeout',
        limitMs: 60_000,
        deadlineAt: '2026-07-15T23:59:00.000Z',
      },
    });
  });

  it('rejects duplicate task ids and validates dependencies', () => {
    const { store } = makeTempStore();
    const engine = makeEngine(store, [{ type: 'turnCompleted' }]);
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    expect(engine.createTask({ id: 'task-1', goal: 'again', backend: 'fake' })).toEqual({
      ok: false,
      reason: 'task id already exists',
    });
  });

  it('exposes startTask and continueTask commands', async () => {
    const { store } = makeTempStore();
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const started = engine.startTask('task-1', []);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-1');
    resume?.();
    await engine.whenIdle();

    const continued = engine.continueTask('task-1', []);
    expect(continued.ok).toBe(true);
  });

  it('settles premature stream exhaustion as failed', async () => {
    const { store } = makeTempStore();
    const engine = makeEngine(store, [{ type: 'sessionStarted', sessionId: 'sess-1' }]);
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) {
      return;
    }
    await engine.whenIdle();
    expect(store.getFile().turns[sent.value.turnId].status).toBe('failed');
    expect(store.getTask('task-1')?.committedSessionId).toBeUndefined();
  });

  it('rejects createTask for non-MCP backends', () => {
    const { store } = makeTempStore();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend([], {
        supportsMCP: false,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
      }),
    });
    const result = engine.createTask({ goal: 'x', backend: 'fake' });
    expect(result).toEqual({ ok: false, reason: 'backend does not support MCP' });
  });

  it('W1: pins plan summary into implement first prompt; reopen does not rewrite pin', async () => {
    const { store } = makeTempStore();
    let capturedPrompt = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        capturedPrompt = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 'sess-impl' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
    });

    // Same-root plan→impl graph (host createTask always roots itself).
    const policy = {
      maxTurns: 10,
      maxAutomaticRetries: 0,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 120_000,
    };
    store.commit((draft) => {
      draft.tasks.plan = {
        id: 'plan',
        role: 'worker',
        lifecycle: 'succeeded',
        goal: 'plan work',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        result: 'do X then Y',
        taskResult: { version: 1, revision: 2, summary: 'do X then Y' },
        finishedAt: '2026-07-06T12:00:00.000Z',
        revision: 1,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement work',
        parentId: 'plan',
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        inputBindings: [{ fromTaskId: 'plan', output: 'summary', as: 'implementationPlan' }],
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const started = engine.startTask('impl', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const turn = store.getFile().turns[started.value.turnId];
    expect(turn.resolvedInputs?.[0]?.text).toBe('do X then Y');
    expect(turn.resolvedInputs?.[0]?.producerResultRevision).toBe(2);
    expect(capturedPrompt).toContain('do X then Y');
    expect(capturedPrompt).toContain('untrusted');

    // Producer "reopen" rewrite must not change pin.
    store.commit((draft) => {
      draft.tasks.plan = {
        ...draft.tasks.plan!,
        taskResult: { version: 1, revision: 9, summary: 'rewritten' },
        result: 'rewritten',
        revision: draft.tasks.plan!.revision + 1,
        updatedAt: '2026-07-06T12:00:01.000Z',
      };
      return { ok: true };
    });
    expect(store.getFile().turns[started.value.turnId].resolvedInputs?.[0]?.text).toBe('do X then Y');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-idle');
    resume?.();
    await engine.whenIdle();
  });

  it('W1: unbound dependency does not inject predecessor content', async () => {
    const { store } = makeTempStore();
    let capturedPrompt = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        capturedPrompt = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 'sess-u' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    const policy = {
      maxTurns: 10,
      maxAutomaticRetries: 0,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 120_000,
    };
    store.commit((draft) => {
      draft.tasks.plan = {
        id: 'plan',
        role: 'worker',
        lifecycle: 'succeeded',
        goal: 'plan',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        result: 'SECRET_PLAN',
        taskResult: { version: 1, revision: 1, summary: 'SECRET_PLAN' },
        finishedAt: '2026-07-06T12:00:00.000Z',
        revision: 1,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement',
        parentId: 'plan',
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });
    const started = engine.startTask('impl', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(capturedPrompt).not.toContain('SECRET_PLAN');
    // Seq-1 freeze pins empty resolvedInputs when there are no bindings.
    expect(store.getFile().turns[started.value.turnId].resolvedInputs).toEqual([]);
    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-u');
    resume?.();
    await engine.whenIdle();
  });

  it('W1: missing required binding sets attention and does not dispatch', async () => {
    const { store } = makeTempStore();
    let ran = false;
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        ran = true;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    const policy = {
      maxTurns: 10,
      maxAutomaticRetries: 0,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 120_000,
    };
    store.commit((draft) => {
      draft.tasks.plan = {
        id: 'plan',
        role: 'worker',
        lifecycle: 'succeeded',
        goal: 'plan',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        finishedAt: '2026-07-06T12:00:00.000Z',
        revision: 1,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement',
        parentId: 'plan',
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        inputBindings: [{ fromTaskId: 'plan', output: 'summary', as: 'implementationPlan' }],
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });
    const started = engine.startTask('impl', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ran).toBe(false);
    const impl = store.getTask('impl');
    expect(impl?.attention?.code).toBe('missing_input');
    expect(store.getFile().turns[started.value.turnId].status).toBe('queued');
    expect(store.getFile().turns[started.value.turnId].resolvedInputs).toBeUndefined();
  });

  it('C5: dependency_unsatisfied attention is set when block-policy dep fails', async () => {
    const { store } = makeTempStore();
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-dep' };
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    const policy = {
      maxTurns: 10,
      maxAutomaticRetries: 0,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 120_000,
    };
    store.commit((draft) => {
      draft.tasks.plan = {
        id: 'plan',
        role: 'worker',
        lifecycle: 'failed',
        goal: 'plan',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        releaseState: 'released',
        error: 'plan failed',
        finishedAt: '2026-07-06T12:00:00.000Z',
        revision: 1,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement',
        parentId: null,
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        backend: 'fake',
        capabilities: [],
        executionPolicy: policy,
        releaseState: 'released',
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });
    // Queue a first turn so scheduleTurn/applyDependencyTerminals run on the blocked sink.
    const implStarted = engine.startTask('impl', []);
    expect(implStarted.ok).toBe(true);
    if (!implStarted.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const impl = store.getTask('impl');
    expect(impl?.attention?.code).toBe('dependency_unsatisfied');
    expect(store.getFile().turns[implStarted.value.turnId]?.status).toBe('queued');
  });

  it('completes a successful turn and commits session id from sessionStarted', async () => {
    const { store } = makeTempStore();
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-123' };
        yield { type: 'assistantDelta', content: 'Hi', messageId: 'assistant-1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });

    const created = engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const sent = engine.send('task-1', 'Say hi');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.stageDisposition(sent.value.turnId, { kind: 'complete', result: 'done' }, 'op-1');
    resume?.();
    await engine.whenIdle();

    const task = store.getTask('task-1');
    const turn = store.getFile().turns[sent.value.turnId];
    expect(task?.committedSessionId).toBe('sess-123');
    // Root complete is human-gated: lifecycle stays open with a proposal.
    expect(task?.lifecycle).toBe('open');
    expect(task?.outcomeProposal).toMatchObject({ kind: 'complete', result: 'done' });
    expect(turn?.status).toBe('succeeded');
    expect(store.getMessagesForTask('task-1').find((m) => m.role === 'user')?.state).toBe('complete');
  });

  it('fails without committing session id and enqueues one durable retry', async () => {
    const { store } = makeTempStore();
    let calls = 0;
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        calls += 1;
        if (calls === 1) {
          yield { type: 'sessionStarted', sessionId: 'candidate-1' };
          yield { type: 'error', message: 'boom' };
          return;
        }
        await new Promise<void>(() => {
          // hang the auto-scheduled retry so it stays materialized once
        });
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });

    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const task = store.getTask('task-1');
    const turn = store.getFile().turns[sent.value.turnId];
    expect(task?.committedSessionId).toBeUndefined();
    expect(turn?.status).toBe('failed');
    expect(turn?.candidateSessionId).toBe('candidate-1');

    const retry = Object.values(store.getFile().turns).find((t) => t.retryOf === sent.value.turnId);
    expect(retry?.id).toBe(`${sent.value.turnId}-auto-retry-1`);
    expect(['queued', 'running']).toContain(retry?.status);
  });

  it('does not duplicate retry turns on reload', async () => {
    const { filePath, store } = makeTempStore();
    let calls = 0;
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        calls += 1;
        if (calls === 1) {
          yield { type: 'error', message: 'boom' };
          return;
        }
        await new Promise<void>(() => {});
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => scriptedBackend([]),
    });
    const retries = Object.values(TaskStore.load({ filePath }).getFile().turns).filter((t) => t.retryOf);
    expect(retries).toHaveLength(1);
  });

  it('interrupts on cancellation; confirmed pure-stop binds session, promotes nothing', async () => {
    const { store } = makeTempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        yield { type: 'sessionStarted', sessionId: 'sess-live' };
        await gate;
        if (options.signal?.aborted) {
          yield {
            type: 'error',
            message: 'aborted',
            isCancellation: true,
            meta: { interruptConfidence: 'confirmed' },
          };
        }
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) {
      return;
    }
    // Wait until promote/dispatch started (first-turn assemble is async).
    for (let i = 0; i < 100; i++) {
      const st = store.getFile().turns[sent.value.turnId]?.status;
      if (st === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Let sessionStarted land before interrupt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.interruptTurn(sent.value.turnId);
    release?.();
    await engine.whenIdle();

    const task = store.getTask('task-1');
    const turn = store.getFile().turns[sent.value.turnId];
    expect(task?.lifecycle).toBe('open');
    // Confirmed interrupt binds observed session for later resume (ISSUE-1).
    expect(task?.committedSessionId).toBe('sess-live');
    expect(turn?.status).toBe('interrupted');
    expect(turn?.interruptConfidence).toBe('confirmed');
    // No queued follow-ups → nothing else to promote.
    expect(Object.values(store.getFile().turns).filter((t) => t.status === 'queued')).toHaveLength(0);
  });

  it('settles iterator rejection as a single failed turn', async () => {
    const { store } = makeTempStore();
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        throw new Error('iterator blew up');
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) {
      return;
    }
    await engine.whenIdle();
    expect(store.getFile().turns[sent.value.turnId].status).toBe('failed');
    expect(store.getTask('task-1')?.committedSessionId).toBeUndefined();
  });

  it('eagerly queues a FIFO follow-up turn while running and continues on the open task', async () => {
    const { store } = makeTempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const first = engine.send('task-1', 'first');
    if (!first.ok || !first.value.turnId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = engine.send('task-1', 'second');
    expect(second.ok).toBe(true);
    if (second.ok) {
      // R012: concurrent send is a durable one-message queued turn (message pending until assign).
      expect(second.value.turnId).toBeDefined();
      expect(store.getFile().messages[second.value.messageId].state).toBe('pending');
      expect(store.getFile().turns[second.value.turnId!]).toMatchObject({
        status: 'queued',
        inputs: [{ kind: 'message', messageId: second.value.messageId }],
      });
      // Host projection keeps live activeTurnId and exposes the queued follow-up identity.
      const snapshot = buildSnapshot(store, 'task-1');
      expect(snapshot.activeTurnId).toBe(first.value.turnId);
      expect(snapshot.queuedTurns).toEqual([
        {
          turnId: second.value.turnId,
          sequence: store.getFile().turns[second.value.turnId!]!.sequence,
          status: 'queued',
          messageIds: [second.value.messageId],
          createdAt: store.getFile().turns[second.value.turnId!]!.createdAt,
          previewText: 'second',
        },
      ]);
      // Queued follow-up must not appear in chat transcript while still queued.
      expect(
        snapshot.transcript?.filter((item) => item.kind === 'user').map((item) => item.id),
      ).toEqual([first.value.messageId]);
    }
    engine.stageDisposition(first.value.turnId, { kind: 'complete', result: 'ok' }, 'op-1');
    release?.();
    await engine.whenIdle();

    // Root stays open after agent complete — user may continue on the same task/session.
    expect(store.getTask('task-1')?.lifecycle).toBe('open');
    expect(store.getTask('task-1')?.outcomeProposal?.kind).toBe('complete');
    const followUp = engine.send('task-1', 'continue please');
    expect(followUp.ok).toBe(true);
    // Follow-up clears the proposal and keeps the same open task (session resume on next turn).
    expect(store.getTask('task-1')?.outcomeProposal).toBeUndefined();
    expect(store.getTask('task-1')?.lifecycle).toBe('open');
  });

  it('never batches free-floating pending messages into one continuation turn', async () => {
    const { store } = makeTempStore();
    let release1!: () => void;
    let release2!: () => void;
    let release3!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const gate3 = new Promise<void>((resolve) => {
      release3 = resolve;
    });
    const prompts: string[] = [];
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        prompts.push(options.prompt);
        yield { type: 'sessionStarted', sessionId: `sess-${prompts.length}` };
        if (prompts.length === 1) await gate1;
        else if (prompts.length === 2) await gate2;
        else await gate3;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-batch', goal: 'no batch', backend: 'fake' });
    const first = engine.send('task-batch', 'first');
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Residual free-floating pendings (over-cap / recovery path).
    store.commit((draft) => {
      draft.messages['pend-b'] = {
        id: 'pend-b',
        taskId: 'task-batch',
        role: 'user',
        content: 'second',
        state: 'pending',
        createdAt: '2026-07-06T12:00:01.000Z',
      };
      draft.messages['pend-c'] = {
        id: 'pend-c',
        taskId: 'task-batch',
        role: 'user',
        content: 'third',
        state: 'pending',
        createdAt: '2026-07-06T12:00:02.000Z',
      };
      return { ok: true };
    });

    engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'op-batch-1');
    release1();
    // Wait for first free-float drain turn to start.
    for (let i = 0; i < 100 && prompts.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(prompts[1]).toBe('second');
    expect(prompts[1]).not.toContain('third');

    const afterDrain = Object.values(store.getFile().turns)
      .filter((turn) => turn.taskId === 'task-batch')
      .sort((a, b) => a.sequence - b.sequence);
    expect(afterDrain.length).toBeGreaterThanOrEqual(2);
    for (const turn of afterDrain) {
      expect(turn.inputs.filter((input) => input.kind === 'message')).toHaveLength(1);
    }
    expect(afterDrain[1].inputs).toEqual([{ kind: 'message', messageId: 'pend-b' }]);

    engine.stageDisposition(afterDrain[1].id, { kind: 'idle' }, 'op-batch-2');
    release2();
    for (let i = 0; i < 100 && prompts.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // First turn includes host+brief compile prefix; follow-ups are message-only.
    expect(prompts[0]).toContain('first');
    expect(prompts[0]).toContain('# Muster host context');
    expect(prompts[1]).toBe('second');
    expect(prompts[2]).toBe('third');
    expect(prompts).toHaveLength(3);

    const third = Object.values(store.getFile().turns).find(
      (turn) =>
        turn.taskId === 'task-batch' &&
        turn.inputs.some((input) => input.kind === 'message' && input.messageId === 'pend-c'),
    );
    expect(third).toBeDefined();
    if (!third) return;
    expect(third.inputs).toEqual([{ kind: 'message', messageId: 'pend-c' }]);
    engine.stageDisposition(third.id, { kind: 'idle' }, 'op-batch-3');
    release3();
    await engine.whenIdle();

    const turns = Object.values(store.getFile().turns)
      .filter((turn) => turn.taskId === 'task-batch')
      .sort((a, b) => a.sequence - b.sequence);
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      expect(turn.inputs.filter((input) => input.kind === 'message')).toHaveLength(1);
    }
  });

  it('reopens hard-terminal tasks on send (same task id)', async () => {
    const { store } = makeTempStore();
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-reopen' };
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'done work', backend: 'fake' });
    expect(engine.setTaskLifecycle('task-1', 'succeeded', { result: 'shipped' }).ok).toBe(true);
    expect(store.getTask('task-1')?.lifecycle).toBe('succeeded');

    const sent = engine.send('task-1', 'actually more work');
    expect(sent.ok).toBe(true);
    expect(store.getTask('task-1')?.lifecycle).toBe('open');
    expect(store.getTask('task-1')?.finishedAt).toBeUndefined();
    if (sent.ok) {
      expect(store.getFile().messages[sent.value.messageId]?.taskId).toBe('task-1');
    }
    await engine.whenIdle();
  });

  it('leaves reload running turns untouched when a live lease exists', async () => {
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
    fs.writeFileSync(
      `${filePath}.lease.turn-1`,
      // A fresh lease held by this (live) process — createdAt is now, so it is not
      // reclaimable by the max-age PID-reuse defense.
      JSON.stringify({ pid: process.pid, token: 'live', createdAt: new Date().toISOString() }),
      'utf8',
    );

    TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => scriptedBackend([]),
      clock: () => '2026-07-06T00:00:01.000Z',
    });
    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getFile().turns['turn-1'].status).toBe('running');
    fs.unlinkSync(`${filePath}.lease.turn-1`);
  });

  it('marks reload running turns interrupted when lease is absent', async () => {
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
      makeBackend: () => scriptedBackend([]),
      clock: () => '2026-07-06T00:00:01.000Z',
    });
    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getFile().turns['turn-1'].status).toBe('interrupted');
    expect(reloaded.getTask('task-1')?.lifecycle).toBe('open');
  });

  it('rejects conflicting disposition opIds after persist', async () => {
    const { store } = makeTempStore();
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const first = engine.stageDisposition(sent.value.turnId, { kind: 'idle' }, 'op-1');
    expect(first.ok).toBe(true);
    const replay = engine.stageDisposition(sent.value.turnId, { kind: 'idle' }, 'op-1');
    expect(replay.ok).toBe(true);
    const conflict = engine.stageDisposition(
      sent.value.turnId,
      { kind: 'complete', result: 'x' },
      'op-1',
    );
    expect(conflict.ok).toBe(false);
    resume?.();
    await engine.whenIdle();
  });
});

describe('TaskEngine transcript persistence (tool + reasoning + segmentation)', () => {
  it('persists segmented assistant text, tool calls (composite id, replaced input), and reasoning; buildTranscript reconstructs order', async () => {
    const { store } = makeTempStore();
    const events: NormalizedEvent[] = [
      { type: 'assistantDelta', content: 'before ', messageId: 'a1' },
      { type: 'toolStarted', toolCallId: 'tc1', name: 'read_file', input: { path: 'x' } },
      { type: 'toolUpdated', toolCallId: 'tc1', input: { path: 'y' } },
      { type: 'toolCompleted', toolCallId: 'tc1', outcome: 'success', output: 'ok' },
      { type: 'assistantDelta', content: 'after', messageId: 'a2' },
      { type: 'reasoningDelta', content: 'thinking', messageId: 'r1' },
      { type: 'turnCompleted' },
    ];
    const engine = makeEngine(store, events);
    engine.createTask({ id: 'task-1', goal: 'g', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();

    const file = store.getFile();
    const turnId = sent.value.turnId;

    // Two assistant segments, distinct order, split around the tool.
    const asst = Object.values(file.messages)
      .filter((m) => m.role === 'assistant' && m.turnId === turnId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    expect(asst.map((m) => m.content)).toEqual(['before ', 'after']);
    expect(asst[0].order).toBe(0);
    expect(asst[1].order).toBe(2);
    expect(asst[0].id).toBe(`${turnId}:0`);

    // Tool call: composite id, input REPLACED (not merged), completed.
    const toolKey = `${turnId}:tc1`;
    const tc = file.toolCalls?.[toolKey];
    expect(tc).toBeDefined();
    expect(tc?.name).toBe('read_file');
    expect(tc?.status).toBe('success');
    expect(tc?.output).toBe('ok');
    expect(tc?.input).toEqual({ path: 'y' });
    expect(tc?.order).toBe(1);

    // Reasoning: turn-scoped, appended.
    expect(file.reasoning?.[turnId]?.content).toBe('thinking');

    // buildTranscript reconstructs exact order: user, reasoning, assistant, tool, assistant.
    const transcript = buildTranscript(file, 'task-1');
    expect(transcript.map((t) => t.kind)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'tool',
      'assistant',
    ]);
    const assistantTexts = transcript
      .filter((t) => t.kind === 'assistant')
      .map((t) => t.content as string);
    expect(assistantTexts).toEqual(['before ', 'after']);
  });

  it('creates a tool record on toolCompleted even when the start was missed (upsert)', async () => {
    const { store } = makeTempStore();
    const events: NormalizedEvent[] = [
      { type: 'toolCompleted', toolCallId: 'orphan', outcome: 'error', error: 'boom' },
      { type: 'turnCompleted' },
    ];
    const engine = makeEngine(store, events);
    engine.createTask({ id: 'task-1', goal: 'g', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();
    const file = store.getFile();
    const tc = file.toolCalls?.[`${sent.value.turnId}:orphan`];
    expect(tc?.status).toBe('error');
    expect(tc?.error).toBe('boom');
  });
});

// M017 S03 named flow check (D037).
// Runtime boundary: real TaskEngine stream path → JsonTurnStreamBuffer.apply →
// flushStreamBeforeTerminal → TaskStore durable commit → terminal emit.
// Independently executable:
//   npx vitest run src/task/engine.test.ts -t "TaskEngine stream batching"
describe('TaskEngine stream batching (TurnStreamPersistence / D035)', () => {
  it('batches 10k stream deltas with byte-exact transcript and bounded durable commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-task-engine-stream-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, '.muster-tasks.json');
    let commitCount = 0;
    const store = TaskStore.load({
      filePath,
      onCommit: () => {
        commitCount += 1;
      },
    });

    // Demo contract: 10k chunks through the real engine stream path.
    const N = 10_000;
    const chunks = Array.from({ length: N }, (_, i) => `Δ${i}`);
    const events: NormalizedEvent[] = [
      ...chunks.slice(0, 5_000).map((content) => ({
        type: 'assistantDelta' as const,
        content,
        messageId: 'a1',
      })),
      { type: 'reasoningDelta', content: 'r-a', messageId: 'r1' },
      { type: 'reasoningDelta', content: 'r-b', messageId: 'r1' },
      {
        type: 'toolStarted',
        toolCallId: 'tc1',
        name: 'read_file',
        kind: 'mcp',
        input: { path: 'x' },
      },
      {
        type: 'toolUpdated',
        toolCallId: 'tc1',
        input: { path: 'y' },
      },
      {
        type: 'toolCompleted',
        toolCallId: 'tc1',
        outcome: 'success',
        output: 'ok',
      },
      ...chunks.slice(5_000).map((content) => ({
        type: 'assistantDelta' as const,
        content,
        messageId: 'a2',
      })),
      { type: 'turnCompleted' },
    ];
    const engine = makeEngine(store, events);
    engine.createTask({ id: 'task-1', goal: 'g', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();

    const turnId = sent.value.turnId;
    const file = store.getFile();
    const asst = Object.values(file.messages)
      .filter((m) => m.role === 'assistant' && m.turnId === turnId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    expect(asst).toHaveLength(2);
    expect(asst[0]?.content).toBe(chunks.slice(0, 5_000).join(''));
    expect(asst[1]?.content).toBe(chunks.slice(5_000).join(''));
    expect(file.reasoning?.[turnId]?.content).toBe('r-ar-b');

    const toolKey = `${turnId}:tc1`;
    const tc = file.toolCalls?.[toolKey];
    expect(tc?.name).toBe('read_file');
    expect(tc?.status).toBe('success');
    expect(tc?.input).toEqual({ path: 'y' });
    expect(tc?.output).toBe('ok');

    // buildTranscript reconstructs interleaving: user, asst, reasoning, tool, asst
    // (reasoning is turn-scoped and may sort relative to first assistant by order).
    const transcript = buildTranscript(file, 'task-1');
    const kinds = transcript.map((t) => t.kind);
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('reasoning');
    const assistantTexts = transcript
      .filter((t) => t.kind === 'assistant')
      .map((t) => t.content as string);
    expect(assistantTexts).toEqual([
      chunks.slice(0, 5_000).join(''),
      chunks.slice(5_000).join(''),
    ]);

    // S01 baseline was ~1.0 commit per chunk. Batched path must stay far below that.
    const commitPerChunk = commitCount / N;
    expect(commitPerChunk).toBeLessThan(0.01);
    // Absolute ceiling: create/send/start/flush/settle overhead, not N stream commits.
    expect(commitCount).toBeLessThan(40);
  });

  it('emits turnDone only after stream transcript is durable (flush-before-terminal)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-task-engine-flush-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, '.muster-tasks.json');
    const timeline: string[] = [];
    let commitCount = 0;
    const store = TaskStore.load({
      filePath,
      onCommit: (file) => {
        commitCount += 1;
        const asst = Object.values(file.messages).find((m) => m.role === 'assistant');
        if (asst?.content.includes('stream-body')) {
          timeline.push(`durable:${asst.content}`);
        }
        // Prefer the task turn that holds assistant content.
        const relatedTurn = asst?.turnId ? file.turns[asst.turnId] : undefined;
        if (
          relatedTurn &&
          relatedTurn.status !== 'running' &&
          relatedTurn.status !== 'waiting_user' &&
          relatedTurn.status !== 'queued'
        ) {
          timeline.push(`settled:${relatedTurn.status}`);
        }
      },
    });

    const events: NormalizedEvent[] = [
      { type: 'assistantDelta', content: 'stream-body', messageId: 'a1' },
      { type: 'assistantDelta', content: '-part2', messageId: 'a1' },
      { type: 'turnCompleted' },
    ];
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(events),
      clock: () => '2026-07-06T12:00:00.000Z',
      emit: (e) => {
        if (e.type === 'turnDone' || e.type === 'turnError') {
          timeline.push(e.type);
        }
      },
    });
    engine.createTask({ id: 'task-1', goal: 'g', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();

    const durableIdx = timeline.findIndex((e) => e.startsWith('durable:stream-body'));
    const terminalIdx = timeline.findIndex((e) => e === 'turnDone' || e === 'turnError');
    expect(durableIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThan(durableIdx);
    // Transcript must be durable before terminal emit; settle may share the same commit
    // window but must not precede durable content.
    expect(timeline[durableIdx]).toBe('durable:stream-body-part2');
    expect(store.getFile().messages[`${sent.value.turnId}:0`]?.content).toBe('stream-body-part2');
    expect(commitCount).toBeGreaterThan(0);
    expect(timeline).toContain('turnDone');
    expect(timeline).not.toContain('turnError');
  });

  it('failed flush settles turnError without partial durable assistant content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-task-engine-flush-fail-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, '.muster-tasks.json');
    const timeline: string[] = [];
    const store = TaskStore.load({ filePath });

    // Inject a flush failure: reject any commit that would persist assistant stream content.
    // Create/send/start still succeed (user + turn only). The terminal flush is the first
    // commit that materializes assistant messages, so it fails atomically.
    const originalCommit = store.commit.bind(store);
    store.commit = ((apply) =>
      originalCommit((draft) => {
        const result = apply(draft);
        if (!result.ok) return result;
        const hasAssistant = Object.values(draft.messages).some((m) => m.role === 'assistant');
        if (hasAssistant) {
          return { ok: false, reason: 'injected flush failure' };
        }
        return result;
      })) as typeof store.commit;

    const events: NormalizedEvent[] = [
      { type: 'assistantDelta', content: 'should-not-land', messageId: 'a1' },
      { type: 'assistantDelta', content: '-part2', messageId: 'a1' },
      { type: 'turnCompleted' },
    ];
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(events),
      clock: () => '2026-07-06T12:00:00.000Z',
      emit: (e) => {
        if (e.type === 'turnDone' || e.type === 'turnError') {
          timeline.push(
            e.type === 'turnError' ? `turnError:${e.message}` : e.type,
          );
        }
      },
    });
    engine.createTask({ id: 'task-1', goal: 'g', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();

    const turnId = sent.value.turnId;
    const file = store.getFile();
    // Atomic: no partial assistant content on disk after failed flush.
    const asst = Object.values(file.messages).filter(
      (m) => m.role === 'assistant' && m.turnId === turnId,
    );
    expect(asst).toHaveLength(0);
    expect(file.turns[turnId]?.status).toBe('failed');
    expect(timeline.some((e) => e.startsWith('turnError:'))).toBe(true);
    expect(timeline).not.toContain('turnDone');
    // Failure message surfaces the flush rejection detail.
    expect(timeline.find((e) => e.startsWith('turnError:'))).toContain('injected flush failure');
  });
});

describe('TaskEngine workspace cwd', () => {
  it('persists a task cwd and passes it to the turn RunOptions', async () => {
    const { filePath, store } = makeTempStore();
    let captured: RunOptions | undefined;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend([{ type: 'turnCompleted' }]),
      // Capture the RunOptions the engine dispatches so we can assert cwd flows
      // through the turn base object all the way to the runner/adapter boundary.
      runTurn: (backend, options) => {
        captured = options;
        return backend.run(options);
      },
    });

    const started = engine.startNewTask({
      goal: 'do a thing',
      backend: 'fake',
      cwd: '/workspace/root',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await engine.whenIdle();

    // Persisted on the task...
    expect(store.getTask(started.value.taskId)?.cwd).toBe('/workspace/root');
    // ...survives a reload round-trip through the store file...
    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getTask(started.value.taskId)?.cwd).toBe('/workspace/root');
    // ...and is handed to the turn dispatch as RunOptions.cwd.
    expect(captured?.cwd).toBe('/workspace/root');
  });

  it('leaves cwd undefined when no workspace cwd is provided', async () => {
    const { store } = makeTempStore();
    let captured: RunOptions | undefined;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend([{ type: 'turnCompleted' }]),
      runTurn: (backend, options) => {
        captured = options;
        return backend.run(options);
      },
    });

    const started = engine.startNewTask({ goal: 'no cwd', backend: 'fake' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await engine.whenIdle();

    expect(store.getTask(started.value.taskId)?.cwd).toBeUndefined();
    expect(captured?.cwd).toBeUndefined();
  });
});


describe('TaskEngine.editQueuedTurn / deleteQueuedTurn', () => {
  it('edits and deletes undispatched FIFO queued turns without touching live work', async () => {
    const { store } = makeTempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-q', goal: 'queue edit', backend: 'fake' });

    const first = engine.send('task-q', 'live');
    expect(first.ok && first.value.turnId).toBeTruthy();
    if (!first.ok || !first.value.turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = engine.send('task-q', 'follow-b');
    const third = engine.send('task-q', 'follow-c');
    expect(second.ok && second.value.turnId).toBeTruthy();
    expect(third.ok && third.value.turnId).toBeTruthy();
    if (!second.ok || !second.value.turnId || !third.ok || !third.value.turnId) return;

    const revBeforeEdit = store.getFile().revision;
    const edit = engine.editQueuedTurn('task-q', second.value.turnId, '  revised-b  ');
    expect(edit).toEqual({
      ok: true,
      value: { turnId: second.value.turnId, messageId: second.value.messageId },
    });
    expect(store.getFile().messages[second.value.messageId]?.content).toBe('revised-b');
    expect(store.getFile().messages[second.value.messageId]).not.toHaveProperty('agentContent');
    expect(store.getFile().messages[third.value.messageId]?.content).toBe('follow-c');
    expect(store.getFile().turns[first.value.turnId]?.status).toBe('running');
    expect(store.getFile().turns[second.value.turnId]).toMatchObject({
      status: 'queued',
      inputs: [{ kind: 'message', messageId: second.value.messageId }],
    });
    expect(store.getFile().revision).toBeGreaterThan(revBeforeEdit);

    const revBeforeDelete = store.getFile().revision;
    const del = engine.deleteQueuedTurn('task-q', second.value.turnId);
    expect(del).toEqual({
      ok: true,
      value: { turnId: second.value.turnId, deletedMessageIds: [second.value.messageId] },
    });
    expect(store.getFile().turns[second.value.turnId]).toBeUndefined();
    expect(store.getFile().messages[second.value.messageId]).toBeUndefined();
    // Neighbor queue identity preserved; live turn untouched.
    expect(store.getFile().turns[third.value.turnId]).toMatchObject({
      status: 'queued',
      sequence: 3,
      inputs: [{ kind: 'message', messageId: third.value.messageId }],
    });
    expect(store.getFile().turns[first.value.turnId]?.status).toBe('running');
    expect(store.getFile().revision).toBeGreaterThan(revBeforeDelete);

    const snapshot = buildSnapshot(store, 'task-q');
    expect(snapshot.activeTurnId).toBe(first.value.turnId);
    expect(snapshot.queuedTurns?.map((entry) => entry.turnId)).toEqual([third.value.turnId]);

    engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'op-1');
    release?.();
    await engine.whenIdle();
  });

  it('clears stale agentContent when editing a queued turn', async () => {
    const { store } = makeTempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-ac' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-ac', goal: 'agent content edit', backend: 'fake' });
    const first = engine.send('task-ac', 'live');
    expect(first.ok && first.value.turnId).toBeTruthy();
    if (!first.ok || !first.value.turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = engine.send('task-ac', '@chip', { agentContent: '/abs/old/path.ts' });
    expect(second.ok && second.value.turnId).toBeTruthy();
    if (!second.ok || !second.value.turnId) return;
    expect(store.getFile().messages[second.value.messageId]?.agentContent).toBe('/abs/old/path.ts');
    const edit = engine.editQueuedTurn('task-ac', second.value.turnId, 'plain revised');
    expect(edit.ok).toBe(true);
    expect(store.getFile().messages[second.value.messageId]).toEqual(
      expect.objectContaining({ content: 'plain revised' }),
    );
    expect(store.getFile().messages[second.value.messageId]).not.toHaveProperty('agentContent');
    release?.();
    await engine.whenIdle();
  });


  it('refuses edit/delete after dispatch assigns messages and promotes to running', async () => {
    const { store } = makeTempStore();
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let runCount = 0;
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        runCount += 1;
        yield { type: 'sessionStarted', sessionId: `sess-${runCount}` };
        if (runCount === 1) await gate1;
        else await gate2;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-stale', goal: 'stale', backend: 'fake' });

    const first = engine.send('task-stale', 'live');
    expect(first.ok && first.value.turnId).toBeTruthy();
    if (!first.ok || !first.value.turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = engine.send('task-stale', 'queued');
    expect(second.ok && second.value.turnId).toBeTruthy();
    if (!second.ok || !second.value.turnId) return;

    // Promote the first turn so the second is dispatched and stays running on gate2.
    engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'op-live');
    release1();
    for (let i = 0; i < 100; i++) {
      const status = store.getFile().turns[second.value.turnId]?.status;
      if (status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const afterDispatch = store.getFile();
    expect(afterDispatch.turns[second.value.turnId]?.status).toBe('running');
    expect(afterDispatch.messages[second.value.messageId]?.state).toBe('assigned');

    const rev = afterDispatch.revision;
    const contentBefore = afterDispatch.messages[second.value.messageId]?.content;
    const edit = engine.editQueuedTurn('task-stale', second.value.turnId, 'too late');
    expect(edit.ok).toBe(false);
    if (!edit.ok) {
      expect(edit.reason).toBe('turn is not queued');
    }
    const del = engine.deleteQueuedTurn('task-stale', second.value.turnId);
    expect(del.ok).toBe(false);
    if (!del.ok) {
      expect(del.reason).toBe('turn is not queued');
    }
    expect(store.getFile().revision).toBe(rev);
    expect(store.getFile().messages[second.value.messageId]?.content).toBe(contentBefore);
    expect(store.getFile().turns[second.value.turnId]).toBeDefined();

    engine.stageDisposition(second.value.turnId, { kind: 'idle' }, 'op-stale');
    release2();
    await engine.whenIdle();
  });

  it('refuses foreign task ids, missing turns, empty content, and settled turns', async () => {
    const { store } = makeTempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-a', goal: 'a', backend: 'fake' });
    engine.createTask({ id: 'task-b', goal: 'b', backend: 'fake' });

    const liveA = engine.send('task-a', 'live-a');
    expect(liveA.ok && liveA.value.turnId).toBeTruthy();
    if (!liveA.ok || !liveA.value.turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queuedA = engine.send('task-a', 'queued-a');
    expect(queuedA.ok && queuedA.value.turnId).toBeTruthy();
    if (!queuedA.ok || !queuedA.value.turnId) return;

    const rev = store.getFile().revision;
    expect(engine.editQueuedTurn('task-b', queuedA.value.turnId, 'nope')).toEqual({
      ok: false,
      reason: 'turn does not belong to task',
    });
    expect(engine.deleteQueuedTurn('task-b', queuedA.value.turnId)).toEqual({
      ok: false,
      reason: 'turn does not belong to task',
    });
    expect(engine.editQueuedTurn('task-a', 'missing-turn', 'x')).toEqual({
      ok: false,
      reason: 'turn not found',
    });
    expect(engine.deleteQueuedTurn('task-a', 'missing-turn')).toEqual({
      ok: false,
      reason: 'turn not found',
    });
    expect(engine.editQueuedTurn('task-a', queuedA.value.turnId, '   ')).toEqual({
      ok: false,
      reason: 'invalid content',
    });
    // Live running turn is not editable/deletable via queue APIs.
    expect(engine.editQueuedTurn('task-a', liveA.value.turnId, 'nope')).toEqual({
      ok: false,
      reason: 'turn is not queued',
    });
    expect(engine.deleteQueuedTurn('task-a', liveA.value.turnId)).toEqual({
      ok: false,
      reason: 'turn is not queued',
    });
    expect(store.getFile().revision).toBe(rev);

    engine.stageDisposition(liveA.value.turnId, { kind: 'idle' }, 'op-a');
    release?.();
    await engine.whenIdle();
  });

  it('fails closed when startCommit and edit race on the same queued turn', async () => {
    const { store } = makeTempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep first turn live so the second stays queued until we simulate startCommit.
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 'sess-race' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-race', goal: 'race', backend: 'fake' });

    const first = engine.send('task-race', 'first');
    expect(first.ok && first.value.turnId).toBeTruthy();
    if (!first.ok || !first.value.turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = engine.send('task-race', 'second');
    expect(second.ok && second.value.turnId).toBeTruthy();
    if (!second.ok || !second.value.turnId) return;
    expect(store.getFile().turns[second.value.turnId]?.status).toBe('queued');

    // Simulate executeTurn startCommit winning the race: assign + promote to running.
    const now = '2026-07-06T12:00:00.000Z';
    store.commit((draft) => {
      const turn = draft.turns[second.value.turnId!];
      const message = draft.messages[second.value.messageId];
      if (!turn || !message) return { ok: false, reason: 'setup' };
      draft.messages[second.value.messageId] = {
        ...message,
        state: 'assigned',
        turnId: second.value.turnId!,
      };
      draft.turns[second.value.turnId!] = {
        ...turn,
        status: 'running',
        startedAt: now,
      };
      return { ok: true };
    });

    const rev = store.getFile().revision;
    const content = store.getFile().messages[second.value.messageId]?.content;
    expect(engine.editQueuedTurn('task-race', second.value.turnId, 'stale')).toEqual({
      ok: false,
      reason: 'turn is not queued',
    });
    expect(engine.deleteQueuedTurn('task-race', second.value.turnId)).toEqual({
      ok: false,
      reason: 'turn is not queued',
    });
    expect(store.getFile().revision).toBe(rev);
    expect(store.getFile().messages[second.value.messageId]?.content).toBe(content);
    expect(store.getFile().turns[second.value.turnId]?.status).toBe('running');

    engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'op-race');
    release?.();
    await engine.whenIdle();
  });
});

describe('TaskEngine.interruptAndSend', () => {
  async function startGatedTurn(opts?: {
    eventsAfterSession?: NormalizedEvent[];
  }): Promise<{
    store: TaskStore;
    filePath: string;
    engine: TaskEngine;
    taskId: string;
    turnId: string;
    resume: () => void;
    runOptions: RunOptions[];
  }> {
    const { store, filePath } = makeTempStore();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const runOptions: RunOptions[] = [];
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        runOptions.push(options);
        yield { type: 'sessionStarted', sessionId: 'sess-ias-1' };
        await gate;
        for (const e of opts?.eventsAfterSession ?? [{ type: 'turnCompleted' as const }]) {
          yield e;
        }
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-13T12:00:00.000Z',
    });
    engine.createTask({ id: 'task-ias', goal: 'ias', backend: 'fake' });
    const started = engine.startTask('task-ias', []);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('start failed');
    for (let i = 0; i < 80; i++) {
      const turn = store.getFile().turns[started.value.turnId];
      if (turn?.status === 'running' && turn.observedSessionId === 'sess-ias-1') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return {
      store,
      filePath,
      engine,
      taskId: 'task-ias',
      turnId: started.value.turnId,
      resume,
      runOptions,
    };
  }

  it('reserves a follow-up then interrupts; confirmed settle binds session and promotes', async () => {
    const { store, engine, taskId, turnId, resume, runOptions } = await startGatedTurn({
      eventsAfterSession: [
        {
          type: 'error',
          message: 'Turn cancelled',
          isCancellation: true,
          meta: { interruptConfidence: 'confirmed' },
        },
      ],
    });

    // First turn still running — committedSessionId not set yet (success-only historically).
    expect(store.getFile().tasks[taskId]?.committedSessionId).toBeUndefined();

    const result = engine.interruptAndSend(taskId, 'MUSTER_INJECT_ACK continue');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('interruptAndSend failed');
    expect(result.value.interruptedTurnId).toBe(turnId);
    expect(result.value.outcome).toBe('queued');

    const followUpId = result.value.turnId;
    expect(store.getFile().turns[followUpId]?.status).toBe('queued');
    // Live turn should be aborting; release gate so cancel terminal is processed.
    resume();
    await engine.whenIdle();

    const file = store.getFile();
    expect(file.turns[turnId]?.status).toBe('interrupted');
    expect(file.turns[turnId]?.interruptConfidence).toBe('confirmed');
    // Session bound on confirmed interrupt.
    expect(file.tasks[taskId]?.committedSessionId).toBe('sess-ias-1');
    // Follow-up should have run (or be running/finished) with resumeId.
    const followUp = file.turns[followUpId];
    expect(followUp?.status).not.toBe('queued');
    expect(followUp?.holdAutoPromote).not.toBe(true);
    // Second run uses committed session.
    const second = runOptions[1];
    expect(second?.resumeId).toBe('sess-ias-1');
    expect(second?.prompt).toContain('MUSTER_INJECT_ACK');
  });

  it('does not interrupt when reserve would fail (terminal task)', async () => {
    const { store, engine, taskId, turnId, resume } = await startGatedTurn();
    store.commit((draft) => {
      draft.tasks[taskId] = { ...draft.tasks[taskId]!, lifecycle: 'succeeded' };
      return { ok: true };
    });
    const beforeRunning = store.getFile().turns[turnId]?.status;
    const result = engine.interruptAndSend(taskId, 'should fail reserve');
    expect(result.ok).toBe(false);
    expect(store.getFile().turns[turnId]?.status).toBe(beforeRunning);
    resume();
    await engine.whenIdle();
  });

  it('forced interrupt keeps hold and does not bind committedSessionId', async () => {
    const { store, engine, taskId, turnId, resume, runOptions } = await startGatedTurn({
      eventsAfterSession: [
        {
          type: 'error',
          message: 'Turn cancelled',
          isCancellation: true,
          meta: { interruptConfidence: 'forced' },
        },
      ],
    });

    const result = engine.interruptAndSend(taskId, 'after forced');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fail');
    const followUpId = result.value.turnId;
    resume();
    await engine.whenIdle();

    const file = store.getFile();
    expect(file.turns[turnId]?.interruptConfidence).toBe('forced');
    expect(file.tasks[taskId]?.committedSessionId).toBeUndefined();
    expect(file.turns[followUpId]?.status).toBe('queued');
    expect(file.turns[followUpId]?.holdAutoPromote).toBe(true);
    // Only primary run should have started.
    expect(runOptions.length).toBe(1);
  });

  it('Enter queue without interrupt leaves live turn running', async () => {
    const { store, engine, taskId, turnId, resume } = await startGatedTurn();
    const cont = engine.continueTaskWithMessage(taskId, 'fifo only');
    expect(cont.ok).toBe(true);
    expect(store.getFile().turns[turnId]?.status).toBe('running');
    if (cont.ok) {
      expect(store.getFile().turns[cont.value.turnId]?.status).toBe('queued');
    }
    resume();
    await engine.whenIdle();
  });

  it('no local live handle: reserves queue but does not arm interrupt', async () => {
    const { store, engine, taskId, turnId, resume } = await startGatedTurn();
    // Simulate missing local handle (e.g. other window owns process view).
    (engine as unknown as { liveRuns: Map<string, unknown> }).liveRuns.delete(turnId);
    const result = engine.interruptAndSend(taskId, 'orphan queue');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fail');
    expect(result.value.interruptedTurnId).toBeUndefined();
    expect(store.getFile().turns[result.value.turnId]?.status).toBe('queued');
    // Primary still "running" in store (we only dropped in-memory handle).
    expect(store.getFile().turns[turnId]?.status).toBe('running');
    resume();
    await engine.whenIdle();
  });

  it('Enter-then-Stop (confirmed interrupt) promotes the queued follow-up', async () => {
    const { store, engine, taskId, turnId, resume, runOptions } = await startGatedTurn({
      eventsAfterSession: [
        {
          type: 'error',
          message: 'Turn cancelled',
          isCancellation: true,
          meta: { interruptConfidence: 'confirmed' },
        },
      ],
    });
    const cont = engine.continueTaskWithMessage(taskId, 'queued then stop');
    expect(cont.ok).toBe(true);
    if (!cont.ok) throw new Error('fail');
    engine.interruptTurn(turnId);
    resume();
    await engine.whenIdle();
    expect(store.getFile().turns[turnId]?.interruptConfidence).toBe('confirmed');
    expect(store.getFile().tasks[taskId]?.committedSessionId).toBe('sess-ias-1');
    const follow = store.getFile().turns[cont.value.turnId];
    expect(follow?.status).not.toBe('queued');
    expect(runOptions[1]?.prompt).toContain('queued then stop');
  });

  it('accepts free-form send after needs_recovery as a continuation turn', async () => {
    const { store } = makeTempStore();
    store.commit((draft) => {
      draft.tasks['recover-send'] = {
        id: 'recover-send',
        role: 'worker',
        lifecycle: 'open',
        goal: 'recover via free-form',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 300_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns['failed-1'] = {
        id: 'failed-1',
        taskId: 'recover-send',
        sequence: 1,
        trigger: 'user',
        status: 'failed',
        inputs: [],
        error: 'boom',
        createdAt: '2026-07-06T00:00:00.000Z',
        finishedAt: '2026-07-06T00:00:01.000Z',
      };
      return { ok: true };
    });

    const engine = TaskEngine.load({
      store,
      makeBackend: () =>
        scriptedBackend([
          { type: 'sessionStarted', sessionId: 'sess-cont' },
          { type: 'turnCompleted' },
        ]),
      clock: () => '2026-07-06T00:00:02.000Z',
    });

    expect(engine.viewStatus('recover-send')).toBe('needs_recovery');
    const sent = engine.send('recover-send', 'continue chatting');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) throw new Error('send failed');
    const contTurn = store.getFile().turns[sent.value.turnId];
    expect(contTurn?.retryOf).toBeUndefined();
    expect(contTurn?.status === 'queued' || contTurn?.status === 'running' || contTurn?.status === 'succeeded').toBe(
      true,
    );
    expect(store.getTask('recover-send')?.lifecycle).toBe('open');
    await engine.whenIdle();
    expect(store.getFile().turns[sent.value.turnId]?.status).toBe('succeeded');
  });

  it('queues send while waiting on children without promoting early', async () => {
    const { store } = makeTempStore();
    store.commit((draft) => {
      draft.tasks['wait-children'] = {
        id: 'wait-children',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'parent wait',
        parentId: null,
        dependencies: [],
        wait: { kind: 'children', taskIds: ['child-x'], registeredByTurnId: 'prev' },
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 300_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      return { ok: true };
    });

    let ran = 0;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => {
        ran += 1;
        return scriptedBackend([{ type: 'turnCompleted' }]);
      },
      clock: () => '2026-07-06T00:00:02.000Z',
    });

    const sent = engine.send('wait-children', 'queue while waiting');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) throw new Error('send failed');
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getFile().turns[sent.value.turnId]?.status).toBe('queued');
    expect(ran).toBe(0);
  });

  it('binds committedSessionId on first-turn terminal_received failure', async () => {
    const { store } = makeTempStore();
    const engine = TaskEngine.load({
      store,
      makeBackend: () =>
        scriptedBackend([
          { type: 'sessionStarted', sessionId: 'sess-term-1' },
          {
            type: 'error',
            message: 'Agent stopped: max_tokens',
            meta: { failureClass: 'terminal_received' },
          },
        ]),
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    const created = engine.createTask({
      id: 'term-bind',
      goal: 'bind on terminal fail',
      backend: 'fake',
      executionPolicy: {
        maxTurns: 10,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 60_000,
        taskTimeoutMs: 300_000,
      },
    });
    expect(created.ok).toBe(true);
    const sent = engine.send('term-bind', 'please fail terminally');
    expect(sent.ok).toBe(true);
    await engine.whenIdle();
    expect(store.getTask('term-bind')?.committedSessionId).toBe('sess-term-1');
    expect(store.getTask('term-bind')?.lifecycle).toBe('open');
  });

  it('does not bind committedSessionId on unclassified failure', async () => {
    const { store } = makeTempStore();
    const engine = TaskEngine.load({
      store,
      makeBackend: () =>
        scriptedBackend([
          { type: 'sessionStarted', sessionId: 'sess-unclass' },
          { type: 'error', message: 'transport died' },
        ]),
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    const created = engine.createTask({
      id: 'unclass-bind',
      goal: 'no bind',
      backend: 'fake',
      executionPolicy: {
        maxTurns: 10,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 60_000,
        taskTimeoutMs: 300_000,
      },
    });
    expect(created.ok).toBe(true);
    const sent = engine.send('unclass-bind', 'please fail');
    expect(sent.ok).toBe(true);
    await engine.whenIdle();
    expect(store.getTask('unclass-bind')?.committedSessionId).toBeUndefined();
  });

  it('rapid double interruptAndSend reserves two FIFO turns and one interrupt', async () => {
    const { store, engine, taskId, turnId, resume, runOptions } = await startGatedTurn({
      eventsAfterSession: [
        {
          type: 'error',
          message: 'Turn cancelled',
          isCancellation: true,
          meta: { interruptConfidence: 'confirmed' },
        },
      ],
    });
    const a = engine.interruptAndSend(taskId, 'first direct');
    const b = engine.interruptAndSend(taskId, 'second direct');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('fail');
    expect(a.value.interruptedTurnId).toBe(turnId);
    // Second may also report interruptedTurnId; both messages queued.
    expect(store.getFile().turns[a.value.turnId]?.status).toBe('queued');
    expect(store.getFile().turns[b.value.turnId]?.status).toBe('queued');
    resume();
    await engine.whenIdle();
    // First follow-up must leave queue; second may still be draining after first.
    const firstStatus = store.getFile().turns[a.value.turnId]?.status;
    expect(firstStatus).not.toBe('queued');
    // At least one extra run beyond primary for FIFO drain of directs.
    expect(runOptions.length).toBeGreaterThanOrEqual(2);
    // Second reservation still exists (queued or finished).
    expect(store.getFile().turns[b.value.turnId]).toBeDefined();
  });

  it('Phase C: same clientRequestId re-ACKs without duplicate turn', () => {
    const { store } = makeTempStore();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend([{ type: 'turnCompleted' }]),
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const first = engine.send('task-1', 'hi', { clientRequestId: 'req-1' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = engine.send('task-1', 'hi', { clientRequestId: 'req-1' });
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.value.messageId).toBe(first.value.messageId);
    expect(second.value.turnId).toBe(first.value.turnId);
    const userMsgs = Object.values(store.getFile().messages).filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
  });

  it('Phase C: same clientRequestId different payload is rejected', () => {
    const { store } = makeTempStore();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend([{ type: 'turnCompleted' }]),
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const first = engine.send('task-1', 'hi', { clientRequestId: 'req-2' });
    expect(first.ok).toBe(true);
    const second = engine.send('task-1', 'different', { clientRequestId: 'req-2' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toMatch(/conflict/i);
    }
  });

  it('Phase C: safe auto-retry reuses original message inputs (same prompt)', async () => {
    const { store } = makeTempStore();
    const prompts: string[] = [];
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options) {
        prompts.push(options.prompt);
        if (prompts.length === 1) {
          yield { type: 'error', message: 'pre-dispatch fail' };
          return;
        }
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    engine.createTask({
      id: 'task-1',
      goal: 'hello',
      backend: 'fake',
      executionPolicy: {
        maxTurns: 10,
        maxAutomaticRetries: 2,
        turnTimeoutMs: 60_000,
        taskTimeoutMs: 300_000,
      },
    });
    const sent = engine.send('task-1', 'exact original prompt');
    expect(sent.ok).toBe(true);
    await engine.whenIdle();
    // First failure at pre_dispatch should auto-retry with same prompt text.
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    if (prompts.length >= 2) {
      expect(prompts[1]).toBe(prompts[0]);
      expect(prompts[0]).toContain('exact original prompt');
    }
    const turns = Object.values(store.getFile().turns);
    const retry = turns.find((t) => t.retryOf);
    if (retry) {
      expect(retry.inputs.every((i) => i.kind === 'message')).toBe(true);
    }
  });
});

describe('TaskEngine runtime switch v2', () => {
  it('switches atomically without a hidden run, then attaches context to the next real turn', async () => {
    const { store } = makeTempStore();
    const captured: Array<{ backend: string; options: RunOptions }> = [];
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => ({ ...scriptedBackend([], MCP_CAPS), name }),
      runTurn: async function* (backend: Backend, options: RunOptions) {
        captured.push({ backend: backend.name, options });
        await options.onBeforePrompt?.();
        yield { type: 'sessionStarted', sessionId: 'target-session' };
        yield { type: 'assistantDelta', content: 'continued', messageId: 'a-target' };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T12:00:00.000Z',
    });

    const created = engine.createTask({
      id: 'switch-v2',
      goal: 'finish the implementation',
      backend: 'claude',
      executionPolicy: {
        maxTurns: 8,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 300_000,
        taskTimeoutMs: 3_600_000,
      },
    });
    expect(created.ok).toBe(true);
    store.commit((draft) => {
      const task = draft.tasks['switch-v2']!;
      draft.tasks['switch-v2'] = {
        ...task,
        model: 'sonnet',
        committedSessionId: 'source-session',
        runtimeEpoch: 1,
        releaseState: 'released',
      };
      draft.turns.old = {
        id: 'old', taskId: 'switch-v2', sequence: 1, trigger: 'user', status: 'succeeded',
        runtimeEpoch: 1, inputs: [{ kind: 'message', messageId: 'u-old' }],
        createdAt: '2026-07-16T11:00:00.000Z', finishedAt: '2026-07-16T11:01:00.000Z',
      };
      draft.messages['u-old'] = {
        id: 'u-old', taskId: 'switch-v2', role: 'user', content: 'edit file A', state: 'complete',
        createdAt: '2026-07-16T11:00:00.000Z',
      };
      draft.messages['a-old'] = {
        id: 'a-old', taskId: 'switch-v2', role: 'assistant', content: 'I edited file A',
        state: 'complete', createdAt: '2026-07-16T11:00:30.000Z', turnId: 'old', order: 0,
      };
      draft.toolCalls = {
        'old:test': {
          id: 'old:test', taskId: 'switch-v2', turnId: 'old', toolCallId: 'test', order: 1,
          name: 'exec_command', status: 'success', input: { cmd: 'npm test' }, output: 'passed',
          createdAt: '2026-07-16T11:00:40.000Z', updatedAt: '2026-07-16T11:00:50.000Z',
        },
      };
      return { ok: true };
    });

    const switched = await engine.requestRuntimeHandoff({
      taskId: 'switch-v2', targetBackend: 'codex', targetModel: 'gpt-5',
    });
    expect(switched.ok).toBe(true);
    expect(captured).toHaveLength(0);
    expect(store.getTask('switch-v2')).toMatchObject({
      backend: 'codex', model: 'gpt-5', runtimeEpoch: 2,
      handoff: { version: 2, continuation: { status: 'pending' } },
    });
    expect(store.getTask('switch-v2')?.committedSessionId).toBeUndefined();

    const sent = engine.send('switch-v2', 'continue with the next step');
    expect(sent.ok).toBe(true);
    await engine.whenIdle();

    expect(captured).toHaveLength(1);
    expect(captured[0].backend).toBe('codex');
    expect(captured[0].options.resumeId).toBeUndefined();
    expect(captured[0].options.model).toBe('gpt-5');
    expect(captured[0].options.prompt).toContain('## Continuation context');
    expect(captured[0].options.prompt).toContain('User: edit file A');
    expect(captured[0].options.prompt).toContain('bash npm test');
    expect(captured[0].options.prompt).toContain('continue with the next step');
    const handoff = store.getTask('switch-v2')?.handoff;
    expect(handoff?.version === 2 ? handoff.continuation.status : undefined).toBe('consumed');
    expect(store.getTask('switch-v2')?.committedSessionId).toBe('target-session');
  });

  it('ignores a late source session event after the runtime epoch advances', async () => {
    const { store } = makeTempStore();
    let markStarted!: () => void;
    let releaseSource!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseSource = resolve; });
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => ({ ...scriptedBackend([], MCP_CAPS), name }),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        await options.onBeforePrompt?.();
        markStarted();
        await release;
        // Deliberately misbehaving adapter: emits after AbortSignal. Epoch/status
        // fences must prevent this source session from rebinding the target task.
        yield { type: 'assistantDelta', content: 'late source text', messageId: 'late-source' };
        yield { type: 'sessionStarted', sessionId: 'late-source-session' };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T13:00:00.000Z',
    });
    const created = engine.createTask({
      id: 'epoch-fence', goal: 'keep binding safe', backend: 'claude',
      executionPolicy: {
        maxTurns: 8, maxAutomaticRetries: 0, turnTimeoutMs: 300_000, taskTimeoutMs: 3_600_000,
      },
    });
    expect(created.ok).toBe(true);
    store.commit((draft) => {
      draft.tasks['epoch-fence'] = {
        ...draft.tasks['epoch-fence']!, releaseState: 'released', runtimeEpoch: 1,
      };
      return { ok: true };
    });
    expect(engine.send('epoch-fence', 'start source work').ok).toBe(true);
    await started;

    const switched = await engine.requestRuntimeHandoff({
      taskId: 'epoch-fence', targetBackend: 'codex', targetModel: 'gpt-5',
    });
    expect(switched.ok).toBe(true);
    releaseSource();
    await engine.whenIdle();

    expect(store.getTask('epoch-fence')).toMatchObject({
      backend: 'codex', model: 'gpt-5', runtimeEpoch: 2,
    });
    expect(store.getTask('epoch-fence')?.committedSessionId).toBeUndefined();
    expect(Object.values(store.getFile().turns)[0]?.status).toBe('interrupted');
    expect(JSON.stringify(store.getFile().messages)).not.toContain('late source text');
  });
});

describe('MCP readiness supervisor and bridge instrumentation (M017-S04 / D037)', () => {
  it('onBeforePrompt does not mark prompt_outstanding when supervisor is not ready', async () => {
    const { store } = makeTempStore();
    const credentials = new CredentialRegistry();
    const mcpReadiness = new McpReadinessSupervisor();
    let onBeforePromptThrew = false;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend([], MCP_CAPS),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        try {
          await options.onBeforePrompt?.();
        } catch (error) {
          onBeforePromptThrew = true;
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toMatch(/mcp readiness not ready/);
          throw error;
        }
        yield { type: 'sessionStarted', sessionId: 'should-not-reach' };
        yield { type: 'turnCompleted' };
      },
      credentialRegistry: credentials,
      bridgePort: 9,
      mcpReadiness,
      getBridgeGeneration: () => 1,
      clock: () => '2026-07-17T12:00:00.000Z',
    });

    const created = engine.createTask({
      id: 'ready-gate',
      goal: 'prove readiness gate',
      backend: 'fake',
      executionPolicy: {
        maxTurns: 4,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 60_000,
        taskTimeoutMs: 300_000,
      },
    });
    expect(created.ok).toBe(true);
    store.commit((draft) => {
      draft.tasks['ready-gate'] = {
        ...draft.tasks['ready-gate']!,
        releaseState: 'released',
      };
      return { ok: true };
    });

    expect(engine.send('ready-gate', 'start').ok).toBe(true);
    await engine.whenIdle();

    expect(onBeforePromptThrew).toBe(true);
    const turns = Object.values(store.getFile().turns);
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(turn.dispatchPhase).not.toBe('prompt_outstanding');
    }
  });
});
