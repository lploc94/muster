import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { deriveEntityId, issueTurnCredential, type GraphEngineDeps } from './engine-graph';
import { TaskEngine } from './engine';
import {
  DEFAULT_EXECUTION_POLICY_BOUNDS,
  HARD_BRIDGE_TOKEN_TTL_MS,
  MAX_BRIDGE_TOKEN_TTL_MS,
} from './limits';
import { TaskStore } from './store';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false
};

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-graph-'));
  const store = TaskStore.load({ filePath: path.join(dir, '.muster-tasks.json') });
  const credentials = new CredentialRegistry();
  const askBridge = new AskBridge();
  let resume: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });

  const backend: Backend = {
    name: 'grok',
    capabilities: MCP_CAPS,
    async *run(_options: RunOptions): AsyncIterable<NormalizedEvent> {
      yield { type: 'sessionStarted', sessionId: 'sess-1' };
      yield { type: 'assistantDelta', content: 'working', messageId: 'm1' };
      await gate;
      yield { type: 'turnCompleted' };
    },
  };

  const engine = TaskEngine.load({
    store,
    makeBackend: () => backend,
    askBridge,
    credentialRegistry: credentials,
    bridgePort: 19999,
  });

  return { store, engine, credentials, resume: () => resume?.() };
}

describe('engine graph orchestration', () => {
  it('derives deterministic entity ids', () => {
    const a = deriveEntityId('turn-1', 'op-1', 'task');
    const b = deriveEntityId('turn-1', 'op-1', 'task');
    const c = deriveEntityId('turn-1', 'op-2', 'task');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('rejects worker create_task via tool handler', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({ id: 'root', goal: 'coord', backend: 'grok', role: 'coordinator' });
    const started = engine.startTask('root');
    expect(started.ok).toBe(true);

    const token = credentials.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: started.value!.turnId,
      allowedActions: new Set(['complete_task', 'ask_user']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-1',
      spec: { goal: 'child', backend: 'grok' },
    });
    expect(result.ok).toBe(false);
    expect(Object.keys(store.getFile().tasks)).toEqual(['root']);
  });

  it('create_task via coordinator credential persists child', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value!.turnId,
      allowedActions: new Set([
        'create_task',
        'delegate_task',
        'release_tasks',
        'wait_for_tasks',
        'get_task_status',
        'complete_task',
        'ask_user',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-create',
      spec: { goal: 'child task', backend: 'grok', role: 'worker' },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value!.turnId, 'op-create', 'task');
    expect(store.getFile().tasks[childId]?.parentId).toBe('coord');
    expect(store.getFile().tasks[childId]?.releaseState).toBe('draft');
    expect(
      Object.values(store.getFile().turns).filter((t) => t.taskId === childId),
    ).toHaveLength(0);
  });

  it('W3: create → release queues first-turn; partial fail is atomic; start_task on draft rejected', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const turnId = started.value.turnId;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set([
        'create_task',
        'delegate_task',
        'release_tasks',
        'start_task',
        'wait_for_tasks',
        'complete_task',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-a',
      spec: { goal: 'child A', backend: 'grok', role: 'worker' },
    });
    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-b',
      spec: { goal: 'child B', backend: 'grok', role: 'worker' },
    });
    const childA = deriveEntityId(turnId, 'op-a', 'task');
    const childB = deriveEntityId(turnId, 'op-b', 'task');
    expect(store.getTask(childA)?.releaseState).toBe('draft');
    expect(store.getTask(childB)?.releaseState).toBe('draft');

    // start_task on draft must fail even if credential still lists it.
    const startDraft = await engine.handleToolCall(ctx, 'start_task', {
      kind: 'start_task',
      opId: 'op-start-draft',
      childId: childA,
    });
    expect(startDraft.ok).toBe(false);
    if (!startDraft.ok) {
      expect(startDraft.error).toMatch(/not released/);
    }

    // Atomic fail: include a missing id → neither child releases.
    const badRelease = await engine.handleToolCall(ctx, 'release_tasks', {
      kind: 'release_tasks',
      opId: 'op-rel-bad',
      taskIds: [childA, 'missing-child'],
    });
    expect(badRelease.ok).toBe(false);
    expect(store.getTask(childA)?.releaseState).toBe('draft');
    expect(store.getTask(childB)?.releaseState).toBe('draft');

    const goodRelease = await engine.handleToolCall(ctx, 'release_tasks', {
      kind: 'release_tasks',
      opId: 'op-rel-ok',
      taskIds: [childA, childB],
    });
    expect(goodRelease.ok).toBe(true);
    expect(store.getTask(childA)?.releaseState).toBe('released');
    expect(store.getTask(childB)?.releaseState).toBe('released');
    expect(store.getTask(childA)?.releaseAttemptId).toBe('op-rel-ok');
    const turnsA = Object.values(store.getFile().turns).filter((t) => t.taskId === childA);
    const turnsB = Object.values(store.getFile().turns).filter((t) => t.taskId === childB);
    expect(turnsA).toHaveLength(1);
    expect(turnsB).toHaveLength(1);
    expect(turnsA[0]?.trigger).toBe('engine');
    expect(turnsA[0]?.status).toBe('queued');

    // Idempotent same opId.
    const again = await engine.handleToolCall(ctx, 'release_tasks', {
      kind: 'release_tasks',
      opId: 'op-rel-ok',
      taskIds: [childA, childB],
    });
    expect(again.ok).toBe(true);
    expect(Object.values(store.getFile().turns).filter((t) => t.taskId === childA)).toHaveLength(1);
  });

  it('W3: delegate_task creates released child with first-turn', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['delegate_task', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-del',
      spec: { goal: 'do it', backend: 'grok', role: 'worker' },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value.turnId, 'op-del', 'task');
    expect(store.getTask(childId)?.releaseState).toBe('released');
    const turns = Object.values(store.getFile().turns).filter((t) => t.taskId === childId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.trigger).toBe('engine');
  });

  it('W2: create_task with brief AC and paths persists on child', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-brief',
      spec: {
        goal: 'implement feature',
        backend: 'grok',
        description: 'from coordinator',
        brief: {
          kind: 'implement',
          acceptanceCriteria: ['tests pass'],
        },
        writePaths: ['src/f.ts'],
        claimsGit: true,
      },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value.turnId, 'op-brief', 'task');
    const child = store.getTask(childId);
    expect(child?.brief?.kind).toBe('implement');
    expect(child?.brief?.acceptanceCriteria).toEqual(['tests pass']);
    expect(child?.brief?.writePaths).toEqual(['src/f.ts']);
    expect(child?.brief?.context).toBe('from coordinator');
    expect(child?.claimsGit).toBe(true);
    expect(child?.releaseState).toBe('draft');
  });

  it('W2: create_task rejects non-summary inputBindings', async () => {
    const { engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-bad-bind',
      spec: {
        goal: 'x',
        backend: 'grok',
        inputBindings: [{ fromTaskId: 'p', output: 'artifact' as 'summary', as: 'a' }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('W2: delegate_task with brief + model persists and queues first turn', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 30));
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['delegate_task', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-del-brief',
      spec: {
        goal: 'plan the work',
        backend: 'grok',
        model: 'm1',
        brief: {
          kind: 'plan',
          objective: 'Produce a concrete plan',
          acceptanceCriteria: ['has steps'],
        },
      },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value.turnId, 'op-del-brief', 'task');
    const child = store.getTask(childId);
    expect(child?.model).toBe('m1');
    expect(child?.brief?.kind).toBe('plan');
    expect(child?.brief?.objective).toBe('Produce a concrete plan');
    expect(child?.goal).toBe('Produce a concrete plan');
    expect(child?.releaseState).toBe('released');
    const turn = Object.values(store.getFile().turns).find((t) => t.taskId === childId);
    expect(turn).toBeDefined();
    await new Promise((r) => setTimeout(r, 40));
    const after = store.getFile().turns[turn!.id];
    expect(after?.compiledPrompt).toContain('Produce a concrete plan');
    expect(after?.compiledPrompt).toContain('Acceptance criteria');
    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-idle');
    if (after?.status === 'running') {
      engine.stageDisposition(after.id, { kind: 'idle' }, 'op-child-idle');
    }
    resume();
    await engine.whenIdle();
  });

  it('create_task / delegate_task persist optional model on child', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task', 'delegate_task', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-model-create',
      spec: { goal: 'plan', backend: 'codex', model: 'gpt-5', role: 'worker' },
    });
    const createId = deriveEntityId(started.value.turnId, 'op-model-create', 'task');
    expect(store.getTask(createId)?.model).toBe('gpt-5');
    expect(store.getTask(createId)?.backend).toBe('codex');

    await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-model-del',
      spec: { goal: 'impl', backend: 'claude', model: 'sonnet', role: 'worker' },
    });
    const delId = deriveEntityId(started.value.turnId, 'op-model-del', 'task');
    expect(store.getTask(delId)?.model).toBe('sonnet');
    expect(store.getTask(delId)?.backend).toBe('claude');
  });

  it('delegate_task with opencode-go/deepseek-v4-flash pins model through to RunOptions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-graph-model-'));
    const store = TaskStore.load({ filePath: path.join(dir, '.muster-tasks.json') });
    const credentials = new CredentialRegistry();
    const askBridge = new AskBridge();
    const capturedModels: Array<string | undefined> = [];
    const backend: Backend = {
      name: 'opencode',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        capturedModels.push(options.model);
        yield { type: 'sessionStarted', sessionId: `sess-${capturedModels.length}` };
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      askBridge,
      credentialRegistry: credentials,
      bridgePort: 19999,
      clock: () => '2026-07-06T12:00:00.000Z',
    });
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'opencode',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    // Seed a synthetic open turn for tool credentials without running a real coord turn.
    store.commit((draft) => {
      draft.turns['coord-turn'] = {
        id: 'coord-turn',
        taskId: 'coord',
        sequence: 1,
        trigger: 'user',
        status: 'running',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
        startedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.tasks.coord = {
        ...draft.tasks.coord!,
        releaseState: 'released',
        revision: draft.tasks.coord!.revision + 1,
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: 'coord-turn',
      allowedActions: new Set(['delegate_task', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const MODEL = 'opencode-go/deepseek-v4-flash';
    const result = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-oc-model',
      spec: {
        goal: 'quick research',
        backend: 'opencode',
        model: MODEL,
        role: 'worker',
      },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId('coord-turn', 'op-oc-model', 'task');
    expect(store.getTask(childId)?.model).toBe(MODEL);
    expect(store.getTask(childId)?.backend).toBe('opencode');

    await engine.whenIdle();
    // Child is the only turn that should have run.
    expect(capturedModels).toContain(MODEL);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cancel_task via coordinator terminally cancels a child subtree and queued turns', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord-cancel',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'start_child', 'wait_child', 'cancel_child', 'read_subtree'],
    });
    const started = engine.startTask('coord-cancel');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord-cancel',
      callerTaskId: 'coord-cancel',
      turnId: started.value.turnId,
      allowedActions: new Set(['cancel_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    store.commit((draft) => {
      const parent = draft.tasks['coord-cancel'];
      draft.tasks['child-cancel'] = {
        ...parent,
        id: 'child-cancel',
        role: 'worker',
        goal: 'child',
        parentId: 'coord-cancel',
        revision: 0,
      };
      draft.tasks['grandchild-cancel'] = {
        ...parent,
        id: 'grandchild-cancel',
        role: 'worker',
        goal: 'grandchild',
        parentId: 'child-cancel',
        revision: 0,
      };
      draft.turns['child-cancel-turn'] = {
        id: 'child-cancel-turn',
        taskId: 'child-cancel',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
      };
      draft.turns['grandchild-cancel-turn'] = {
        id: 'grandchild-cancel-turn',
        taskId: 'grandchild-cancel',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const result = await engine.handleToolCall(ctx, 'cancel_task', {
      kind: 'cancel_task',
      opId: 'op-cancel-subtree',
      childId: 'child-cancel',
    });

    expect(result).toEqual({ ok: true, result: { cancelled: 'child-cancel' } });
    const file = store.getFile();
    expect(file.tasks['child-cancel']?.lifecycle).toBe('cancelled');
    expect(file.tasks['grandchild-cancel']?.lifecycle).toBe('cancelled');
    expect(file.turns['child-cancel-turn']?.status).toBe('cancelled');
    expect(file.turns['grandchild-cancel-turn']?.status).toBe('cancelled');
  });

  it('rejects cancel_task for a non-owned child without mutating that task', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord-owner',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['cancel_child'],
    });
    engine.createTask({ id: 'unowned-child', goal: 'other', backend: 'grok', role: 'worker' });
    const started = engine.startTask('coord-owner');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord-owner',
      callerTaskId: 'coord-owner',
      turnId: started.value.turnId,
      allowedActions: new Set(['cancel_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    const result = await engine.handleToolCall(ctx, 'cancel_task', {
      kind: 'cancel_task',
      opId: 'op-reject-unowned',
      childId: 'unowned-child',
    });

    expect(result).toEqual({ ok: false, error: 'not an owned direct child' });
    expect(store.getFile().tasks['unowned-child']?.lifecycle).toBe('open');
    expect(store.getFile().operations?.[`${started.value.turnId}:op-reject-unowned`]).toBeUndefined();
  });

  it('child tasks inherit the parent task cwd on create_task', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
      cwd: '/parent/workspace',
    });
    const started = engine.startTask('coord');
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value!.turnId,
      allowedActions: new Set(['create_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-child-cwd',
      spec: { goal: 'child', backend: 'grok', role: 'worker' },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value!.turnId, 'op-child-cwd', 'task');
    expect(store.getFile().tasks[childId]?.cwd).toBe('/parent/workspace');
  });

  it('clamps an agent-supplied over-limit executionPolicy on create_task', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value!.turnId,
      allowedActions: new Set(['create_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-clamp',
      spec: {
        goal: 'child',
        backend: 'grok',
        role: 'worker',
        executionPolicy: {
          maxTurns: 1_000_000,
          maxAutomaticRetries: 9_999,
          turnTimeoutMs: 999_999_999,
          taskTimeoutMs: 999_999_999,
        },
      },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value!.turnId, 'op-clamp', 'task');
    const policy = store.getFile().tasks[childId]!.executionPolicy;
    expect(policy.maxTurns).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurns);
    expect(policy.maxAutomaticRetries).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.maxAutomaticRetries);
    expect(policy.turnTimeoutMs).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurnTimeoutMs);
    expect(policy.taskTimeoutMs).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.maxTaskTimeoutMs);
  });

  it('caps the issued bridge token TTL below a large turn timeout', () => {
    const { store, credentials } = makeHarness();
    // Seed a task + running turn whose persisted turn timeout dwarfs the token cap.
    store.commit((draft) => {
      draft.tasks['t'] = {
        id: 't',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'g',
        parentId: null,
        dependencies: [],
        backend: 'grok',
        capabilities: ['create_child'],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 1,
          turnTimeoutMs: 9_999_999_999,
          taskTimeoutMs: 9_999_999_999,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns['turn-t'] = {
        id: 'turn-t',
        taskId: 't',
        sequence: 0,
        trigger: 'user',
        status: 'running',
        inputs: [],
        createdAt: '2026-07-06T00:00:00.000Z',
      };
      return { ok: true };
    });

    const deps = { store, credentials } as unknown as GraphEngineDeps;
    const before = Date.now();
    const token = issueTurnCredential(deps, 'turn-t');
    expect(token).toBeDefined();
    const verified = credentials.verify(token!)!;
    const remainingMs = verified.expiry - before;
    // W8: token covers turn budget up to hard cap (not soft 15m floor only).
    expect(remainingMs).toBeGreaterThan(MAX_BRIDGE_TOKEN_TTL_MS - 1_000);
    expect(remainingMs).toBeLessThanOrEqual(HARD_BRIDGE_TOKEN_TTL_MS + 1_000);
  });
});