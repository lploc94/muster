import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSnapshot } from '../host/snapshot';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { TaskStore } from './store';
import type { TaskStoreFile } from './types';

const tempDirs: string[] = [];

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

const TEST_POLICY = {
  maxTurns: 10,
  maxAutomaticRetries: 0,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 300_000,
};

function makeTempStore(): { dir: string; filePath: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-lifecycle-runtime-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'tasks.json');
  return { dir, filePath, store: TaskStore.load({ filePath }) };
}

function makeGate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function scriptedBackend(
  script: (options: RunOptions) => AsyncIterable<NormalizedEvent>,
  caps: BackendCapabilities = MCP_CAPS,
): Backend {
  return {
    name: 'fake',
    capabilities: caps,
    run: script,
    extractSessionId: (rawOutput, lastUsedId) => {
      const match = /session:(\S+)/.exec(rawOutput);
      return match?.[1] ?? lastUsedId;
    },
  };
}

function eventBackend(events: NormalizedEvent[]): Backend {
  return scriptedBackend(async function* () {
    for (const event of events) {
      yield event;
    }
  });
}

function makeEngine(store: TaskStore, makeBackend: (name: string) => Backend): TaskEngine {
  return TaskEngine.load({
    store,
    makeBackend,
    clock: () => '2026-07-06T12:00:00.000Z',
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function turnFile(store: TaskStore): TaskStoreFile {
  return store.getFile() as TaskStoreFile;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('task lifecycle runtime regression harness', () => {
  it('creates a task with startNewTask and projects the gated turn as running', async () => {
    const { store } = makeTempStore();
    const gate = makeGate();
    const backend = scriptedBackend(async function* () {
      yield { type: 'sessionStarted', sessionId: 'sess-running' };
      await gate.wait;
      yield { type: 'turnCompleted' };
    });
    const engine = makeEngine(store, () => backend);

    const started = engine.startNewTask({ goal: 'Run a lifecycle task', backend: 'fake' });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(store.getTask(started.value.taskId)).toMatchObject({
      id: started.value.taskId,
      lifecycle: 'open',
      goal: 'Run a lifecycle task',
      backend: 'fake',
    });
    expect(store.getMessagesForTask(started.value.taskId)).toHaveLength(1);
    expect(turnFile(store).turns[started.value.turnId]?.status).toMatch(/queued|running/);

    await waitFor(
      () => turnFile(store).turns[started.value.turnId]?.status === 'running',
      'startNewTask turn to run',
    );

    expect(engine.viewStatus(started.value.taskId)).toBe('running');
    const snapshot = buildSnapshot(store, started.value.taskId);
    expect(snapshot.storeRevision).toBeGreaterThanOrEqual(2);
    expect(snapshot.rootTasks[0]).toMatchObject({
      id: started.value.taskId,
      viewStatus: 'running',
      lifecycle: 'open',
    });
    expect(snapshot.activeTurnId).toBe(started.value.turnId);
    expect(snapshot.transcript).toEqual([
      {
        id: started.value.messageId,
        kind: 'user',
        content: 'Run a lifecycle task',
        turnId: started.value.turnId,
        order: undefined,
        state: 'assigned',
      },
    ]);

    gate.release();
    await engine.whenIdle();
  });

  it('settles successful runtime completion with committed session and complete messages', async () => {
    const { store } = makeTempStore();
    const gate = makeGate();
    const backend = scriptedBackend(async function* () {
      yield { type: 'sessionStarted', sessionId: 'sess-success' };
      yield { type: 'assistantDelta', messageId: 'assistant-stream', content: 'done' };
      await gate.wait;
      yield { type: 'turnCompleted' };
    });
    const engine = makeEngine(store, () => backend);

    const started = engine.startNewTask({ goal: 'Finish the task', backend: 'fake' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(
      () => turnFile(store).turns[started.value.turnId]?.status === 'running',
      'successful turn to run',
    );

    expect(engine.stageDisposition(started.value.turnId, { kind: 'complete', result: 'finished' }, 'op-complete')).toEqual({
      ok: true,
      value: undefined,
    });
    gate.release();
    await engine.whenIdle();

    const task = store.getTask(started.value.taskId);
    const turn = turnFile(store).turns[started.value.turnId];
    const messages = store.getMessagesForTask(started.value.taskId);

    expect(task).toMatchObject({
      lifecycle: 'open',
      committedSessionId: 'sess-success',
      outcomeProposal: {
        kind: 'complete',
        result: 'finished',
        proposedByTurnId: started.value.turnId,
      },
    });
    expect(turn).toMatchObject({
      status: 'succeeded',
      observedSessionId: 'sess-success',
    });
    expect(messages.find((message) => message.role === 'user')).toMatchObject({
      id: started.value.messageId,
      state: 'complete',
      turnId: started.value.turnId,
    });
    expect(messages.find((message) => message.role === 'assistant')).toMatchObject({
      content: 'done',
      state: 'complete',
      turnId: started.value.turnId,
    });
    // Proposal pending → orchestration awaiting_outcome; CLI stopped; task still open.
    expect(engine.viewStatus(started.value.taskId)).toBe('awaiting_outcome');
  });

  it('drains a pending send into exactly one follow-up turn after idle settlement', async () => {
    const { store } = makeTempStore();
    const firstGate = makeGate();
    const secondGate = makeGate();
    let runCount = 0;
    const prompts: string[] = [];
    const backend = scriptedBackend(async function* (options) {
      runCount += 1;
      prompts.push(options.prompt);
      yield { type: 'sessionStarted', sessionId: `sess-${runCount}` };
      if (runCount === 1) {
        await firstGate.wait;
      } else {
        await secondGate.wait;
      }
      yield { type: 'turnCompleted' };
    });
    const engine = makeEngine(store, () => backend);

    const created = engine.createTask({
      id: 'pending-drain',
      goal: 'Drain pending sends',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(created.ok).toBe(true);

    const first = engine.send('pending-drain', 'first prompt');
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.turnId) return;
    await waitFor(
      () => turnFile(store).turns[first.value.turnId]?.status === 'running',
      'first turn to run',
    );

    const second = engine.send('pending-drain', 'follow-up prompt');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.turnId).toBeUndefined();
    expect(turnFile(store).messages[second.value.messageId]).toMatchObject({ state: 'pending' });
    expect(turnFile(store).messages[second.value.messageId]).not.toHaveProperty('turnId');

    expect(engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'op-idle')).toEqual({
      ok: true,
      value: undefined,
    });
    firstGate.release();
    await waitFor(() => runCount === 2, 'pending send follow-up turn to start');

    const duringFollowUp = turnFile(store);
    const followUpTurns = Object.values(duringFollowUp.turns).filter(
      (turn) => turn.taskId === 'pending-drain' && turn.id !== first.value.turnId,
    );
    expect(followUpTurns).toHaveLength(1);
    const followUp = followUpTurns[0];
    expect(followUp).toMatchObject({ sequence: 2, status: 'running' });
    expect(followUp.inputs).toEqual([{ kind: 'message', messageId: second.value.messageId }]);
    expect(duringFollowUp.messages[second.value.messageId]).toMatchObject({
      state: 'assigned',
      turnId: followUp.id,
    });
    expect(prompts).toEqual(['first prompt', 'follow-up prompt']);

    secondGate.release();
    await engine.whenIdle();
    await engine.whenIdle();

    const settled = turnFile(store);
    expect(Object.values(settled.turns).filter((turn) => turn.taskId === 'pending-drain')).toHaveLength(2);
    expect(settled.turns[followUp.id]).toMatchObject({ status: 'succeeded' });
    expect(settled.messages[second.value.messageId]).toMatchObject({
      state: 'complete',
      turnId: followUp.id,
    });
    expect(store.getTask('pending-drain')?.lifecycle).toBe('open');
    expect(engine.viewStatus('pending-drain')).toBe('idle');
  });

  it('leaves pending sends untouched when the active turn terminally completes the task', async () => {
    const { store } = makeTempStore();
    const gate = makeGate();
    const backend = scriptedBackend(async function* () {
      yield { type: 'sessionStarted', sessionId: 'sess-terminal' };
      await gate.wait;
      yield { type: 'turnCompleted' };
    });
    const engine = makeEngine(store, () => backend);

    const created = engine.createTask({
      id: 'terminal-pending',
      goal: 'Do not drain after completion',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(created.ok).toBe(true);
    const first = engine.send('terminal-pending', 'finish me');
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.turnId) return;
    await waitFor(
      () => turnFile(store).turns[first.value.turnId]?.status === 'running',
      'terminal turn to run',
    );
    const second = engine.send('terminal-pending', 'too late');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(engine.stageDisposition(first.value.turnId, { kind: 'complete', result: 'done' }, 'op-complete')).toEqual({
      ok: true,
      value: undefined,
    });
    gate.release();
    await engine.whenIdle();

    const file = turnFile(store);
    // Root complete is a proposal only — task stays open; pending second send may drain
    // into a follow-up turn (or stay pending until idle). Either way lifecycle is open.
    expect(store.getTask('terminal-pending')?.lifecycle).toBe('open');
    expect(store.getTask('terminal-pending')?.outcomeProposal?.kind).toBe('complete');
    expect(file.messages[second.value.messageId]).toBeDefined();
  });

  it('leaves concurrent pending sends visible after backend stream failure', async () => {
    const { store } = makeTempStore();
    const gate = makeGate();
    const backend = scriptedBackend(async function* () {
      yield { type: 'sessionStarted', sessionId: 'candidate-failure' };
      await gate.wait;
      yield { type: 'error', message: 'first turn failed' };
    });
    const engine = makeEngine(store, () => backend);

    const created = engine.createTask({
      id: 'failure-pending',
      goal: 'Keep pending messages after failure',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(created.ok).toBe(true);
    const first = engine.send('failure-pending', 'start');
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.turnId) return;
    await waitFor(
      () => turnFile(store).turns[first.value.turnId]?.status === 'running',
      'failing turn to run',
    );
    const second = engine.send('failure-pending', 'recoverable follow-up');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    gate.release();
    await engine.whenIdle();

    const file = turnFile(store);
    expect(file.turns[first.value.turnId]).toMatchObject({
      status: 'failed',
      candidateSessionId: 'candidate-failure',
    });
    expect(store.getTask('failure-pending')?.lifecycle).toBe('open');
    expect(Object.values(file.turns).filter((turn) => turn.taskId === 'failure-pending')).toHaveLength(1);
    expect(file.messages[second.value.messageId]).toMatchObject({ state: 'pending' });
    expect(file.messages[second.value.messageId]).not.toHaveProperty('turnId');
  });

  it('leaves pending sends queued as messages when turn limits prevent continuation creation', async () => {
    const { store } = makeTempStore();
    const gate = makeGate();
    const backend = scriptedBackend(async function* () {
      yield { type: 'sessionStarted', sessionId: 'sess-limit' };
      await gate.wait;
      yield { type: 'turnCompleted' };
    });
    const engine = makeEngine(store, () => backend);

    const created = engine.createTask({
      id: 'limit-pending',
      goal: 'Hit turn limit',
      backend: 'fake',
      executionPolicy: { ...TEST_POLICY, maxTurns: 1 },
    });
    expect(created.ok).toBe(true);
    const first = engine.send('limit-pending', 'first only');
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.turnId) return;
    await waitFor(
      () => turnFile(store).turns[first.value.turnId]?.status === 'running',
      'limited turn to run',
    );
    const second = engine.send('limit-pending', 'over the cap');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(engine.stageDisposition(first.value.turnId, { kind: 'idle' }, 'op-idle-limit')).toEqual({
      ok: true,
      value: undefined,
    });
    gate.release();
    await engine.whenIdle();

    const file = turnFile(store);
    expect(Object.values(file.turns).filter((turn) => turn.taskId === 'limit-pending')).toHaveLength(1);
    expect(file.messages[second.value.messageId]).toMatchObject({ state: 'pending' });
    expect(file.messages[second.value.messageId]).not.toHaveProperty('turnId');
    expect(engine.viewStatus('limit-pending')).toBe('idle');
  });



  it('terminally cancels a reload-deferred queued turn without scheduling it', async () => {
    const { filePath, store } = makeTempStore();
    store.commit((draft) => {
      draft.tasks['queued-cancel'] = {
        id: 'queued-cancel',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'Cancel before running',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
        executionPolicy: TEST_POLICY,
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.turns['queued-turn'] = {
        id: 'queued-turn',
        taskId: 'queued-cancel',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const reloadedStore = TaskStore.load({ filePath });
    const reloaded = makeEngine(reloadedStore, () => eventBackend([{ type: 'turnCompleted' }]));
    expect(turnFile(reloadedStore).turns['queued-turn']?.status).toBe('queued');

    expect(reloaded.cancelTask('queued-cancel')).toEqual({ ok: true, value: undefined });

    const file = turnFile(reloadedStore);
    expect(file.tasks['queued-cancel']).toMatchObject({
      lifecycle: 'cancelled',
      finishedAt: '2026-07-06T12:00:00.000Z',
    });
    expect(file.turns['queued-turn']).toMatchObject({
      status: 'cancelled',
      finishedAt: '2026-07-06T12:00:00.000Z',
    });
    expect(reloaded.viewStatus('queued-cancel')).toBe('cancelled');
  });

  it('terminally cancels a live turn while preserving interruption as retryable', async () => {
    const { store } = makeTempStore();
    const cancelGate = makeGate();
    const interruptGate = makeGate();
    let runCount = 0;
    const backend = scriptedBackend(async function* (options) {
      runCount += 1;
      yield { type: 'sessionStarted', sessionId: `sess-${runCount}` };
      await (runCount === 1 ? cancelGate.wait : interruptGate.wait);
      if (options.signal?.aborted) {
        yield { type: 'error', message: 'aborted', isCancellation: true };
      }
    });
    const engine = makeEngine(store, () => backend);

    const createdCancel = engine.createTask({
      id: 'live-cancel',
      goal: 'Cancel live task',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(createdCancel.ok).toBe(true);
    const cancelSent = engine.send('live-cancel', 'go cancel');
    expect(cancelSent.ok).toBe(true);
    if (!cancelSent.ok || !cancelSent.value.turnId) return;
    await waitFor(
      () => turnFile(store).turns[cancelSent.value.turnId!]?.observedSessionId === 'sess-1',
      'cancel turn to observe a session',
    );

    expect(engine.cancelTask('live-cancel')).toEqual({ ok: true, value: undefined });
    cancelGate.release();
    await engine.whenIdle();

    expect(store.getTask('live-cancel')).toMatchObject({ lifecycle: 'cancelled' });
    expect(turnFile(store).turns[cancelSent.value.turnId]).toMatchObject({
      status: 'cancelled',
      isCancellation: true,
      candidateSessionId: 'sess-1',
      finishedAt: '2026-07-06T12:00:00.000Z',
    });

    const createdInterrupt = engine.createTask({
      id: 'live-interrupt',
      goal: 'Interrupt live task',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(createdInterrupt.ok).toBe(true);
    const interruptSent = engine.send('live-interrupt', 'go interrupt');
    expect(interruptSent.ok).toBe(true);
    if (!interruptSent.ok || !interruptSent.value.turnId) return;
    await waitFor(
      () => turnFile(store).turns[interruptSent.value.turnId!]?.observedSessionId === 'sess-2',
      'interrupt turn to observe a session',
    );

    expect(engine.interruptTurn(interruptSent.value.turnId)).toEqual({ ok: true, value: undefined });
    interruptGate.release();
    await engine.whenIdle();

    expect(store.getTask('live-interrupt')?.lifecycle).toBe('open');
    expect(turnFile(store).turns[interruptSent.value.turnId]).toMatchObject({
      status: 'interrupted',
      isCancellation: true,
      candidateSessionId: 'sess-2',
      finishedAt: '2026-07-06T12:00:00.000Z',
    });
  });

  it('cancels descendant tasks and their pending turns with the parent', async () => {
    const { filePath, store } = makeTempStore();
    const engine = makeEngine(store, () => eventBackend([{ type: 'turnCompleted' }]));
    expect(engine.createTask({
      id: 'cancel-parent',
      goal: 'Parent',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    }).ok).toBe(true);
    store.commit((draft) => {
      const parent = draft.tasks['cancel-parent'];
      draft.tasks['cancel-child'] = {
        ...parent,
        id: 'cancel-child',
        goal: 'Child',
        parentId: 'cancel-parent',
        revision: 0,
      };
      draft.tasks['cancel-grandchild'] = {
        ...parent,
        id: 'cancel-grandchild',
        goal: 'Grandchild',
        parentId: 'cancel-child',
        revision: 0,
      };
      draft.turns['child-turn'] = {
        id: 'child-turn',
        taskId: 'cancel-child',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
      };
      draft.turns['grandchild-turn'] = {
        id: 'grandchild-turn',
        taskId: 'cancel-grandchild',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const reloadedStore = TaskStore.load({ filePath });
    const reloaded = makeEngine(reloadedStore, () => eventBackend([{ type: 'turnCompleted' }]));
    expect(reloaded.cancelTask('cancel-parent')).toEqual({ ok: true, value: undefined });

    const file = turnFile(reloadedStore);
    expect(file.tasks['cancel-parent']?.lifecycle).toBe('cancelled');
    expect(file.tasks['cancel-child']?.lifecycle).toBe('cancelled');
    expect(file.tasks['cancel-grandchild']?.lifecycle).toBe('cancelled');
    expect(file.turns['child-turn']).toMatchObject({ status: 'cancelled', finishedAt: '2026-07-06T12:00:00.000Z' });
    expect(file.turns['grandchild-turn']).toMatchObject({ status: 'cancelled', finishedAt: '2026-07-06T12:00:00.000Z' });
    expect(Object.values(file.turns).filter((turn) => turn.status === 'queued' || turn.status === 'running')).toEqual([]);
  });


  it('writes a cancel request instead of mutating a remote-owned live turn', async () => {
    const { filePath, store } = makeTempStore();
    const remoteOwner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    try {
      if (!remoteOwner.pid) {
        throw new Error('remote owner process did not start');
      }
      store.commit((draft) => {
        draft.tasks['remote-cancel'] = {
          id: 'remote-cancel',
          role: 'coordinator',
          lifecycle: 'open',
          goal: 'Remote owned task',
          parentId: null,
          dependencies: [],
          backend: 'fake',
          capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
          executionPolicy: TEST_POLICY,
          revision: 0,
          createdAt: '2026-07-06T12:00:00.000Z',
          updatedAt: '2026-07-06T12:00:00.000Z',
        };
        draft.turns['remote-turn'] = {
          id: 'remote-turn',
          taskId: 'remote-cancel',
          sequence: 1,
          trigger: 'user',
          status: 'running',
          inputs: [],
          createdAt: '2026-07-06T12:00:00.000Z',
          startedAt: '2026-07-06T12:00:00.000Z',
        };
        return { ok: true };
      });
      fs.writeFileSync(
        `${filePath}.lease.remote-turn`,
        JSON.stringify({ pid: remoteOwner.pid, token: 'remote-owner', createdAt: new Date().toISOString() }),
        'utf8',
      );
      const reloadedStore = TaskStore.load({ filePath });
      const reloaded = makeEngine(reloadedStore, () => eventBackend([{ type: 'turnCompleted' }]));

      expect(reloaded.cancelTask('remote-cancel')).toEqual({ ok: true, value: undefined });

      const file = turnFile(reloadedStore);
      expect(file.tasks['remote-cancel']?.lifecycle).toBe('open');
      expect(file.turns['remote-turn']?.status).toBe('running');
      expect(file.cancelRequests?.['remote-turn']).toMatchObject({
        kind: 'cancel',
        by: 'engine',
        opId: 'cancel-task-remote-cancel',
      });
    } finally {
      remoteOwner.kill();
    }
  });

  it('records runtime failure without committing the candidate session', async () => {
    const { store } = makeTempStore();
    const backend = eventBackend([
      { type: 'sessionStarted', sessionId: 'candidate-runtime' },
      { type: 'error', message: 'runtime exploded' },
    ]);
    const engine = makeEngine(store, () => backend);
    const created = engine.createTask({
      id: 'runtime-failure',
      goal: 'Expose runtime failure state',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(created.ok).toBe(true);

    const sent = engine.send('runtime-failure', 'please fail');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();

    const task = store.getTask('runtime-failure');
    const turn = turnFile(store).turns[sent.value.turnId];
    expect(task?.committedSessionId).toBeUndefined();
    expect(task?.lifecycle).toBe('open');
    expect(turn).toMatchObject({
      status: 'failed',
      error: 'runtime exploded',
      observedSessionId: 'candidate-runtime',
      candidateSessionId: 'candidate-runtime',
    });
    expect(engine.viewStatus('runtime-failure')).toBe('needs_recovery');

    const snapshot = buildSnapshot(store, 'runtime-failure');
    expect(snapshot.rootTasks[0]).toMatchObject({ id: 'runtime-failure', viewStatus: 'needs_recovery' });
    expect(snapshot.activeTurnId).toBe(sent.value.turnId);
  });

  it('persists backend factory failures as failed turns without a committed session', async () => {
    const { store } = makeTempStore();
    const eligibilityBackend = eventBackend([]);
    let calls = 0;
    const engine = makeEngine(store, () => {
      calls += 1;
      if (calls === 1) {
        return eligibilityBackend;
      }
      throw new Error('missing backend fake');
    });
    const created = engine.createTask({
      id: 'missing-backend',
      goal: 'Exercise missing backend failure',
      backend: 'fake',
      executionPolicy: TEST_POLICY,
    });
    expect(created.ok).toBe(true);

    const sent = engine.send('missing-backend', 'run through missing backend');
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value.turnId) return;
    await engine.whenIdle();

    const task = store.getTask('missing-backend');
    const turn = turnFile(store).turns[sent.value.turnId];
    expect(calls).toBe(2);
    expect(task?.committedSessionId).toBeUndefined();
    expect(task?.lifecycle).toBe('open');
    expect(turn).toMatchObject({
      status: 'failed',
      error: 'backend factory failed: missing backend fake',
    });
    expect(turn.candidateSessionId).toBeUndefined();
    expect(engine.viewStatus('missing-backend')).toBe('needs_recovery');
    expect(buildSnapshot(store, 'missing-backend').activeTurnId).toBe(sent.value.turnId);
  });
});
