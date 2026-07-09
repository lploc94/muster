import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine, projectPrompt } from './engine';
import { TaskStore } from './store';
import { buildTranscript } from '../host/snapshot';
import type { TaskMessage, TaskTurn } from './types';

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
});

describe('TaskEngine', () => {
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

  it('interrupts on cancellation without committing session id', async () => {
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
          yield { type: 'error', message: 'aborted', isCancellation: true };
        }
      },
    };
    const engine = TaskEngine.load({ store, makeBackend: () => backend });
    engine.createTask({ id: 'task-1', goal: 'hello', backend: 'fake' });
    const sent = engine.send('task-1', 'go');
    if (!sent.ok || !sent.value.turnId) {
      return;
    }
    engine.interruptTurn(sent.value.turnId);
    release?.();
    await engine.whenIdle();

    const task = store.getTask('task-1');
    const turn = store.getFile().turns[sent.value.turnId];
    expect(task?.lifecycle).toBe('open');
    expect(task?.committedSessionId).toBeUndefined();
    expect(turn?.status).toBe('interrupted');
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

  it('keeps send pending while running and rejects terminal send', async () => {
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
      expect(store.getFile().messages[second.value.messageId].state).toBe('pending');
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
