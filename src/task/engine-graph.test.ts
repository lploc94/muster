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
import { parseTaskTypeRegistry } from './task-types';
import { evaluateTaskReadiness } from './readiness';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';

/** Default test registry so create/delegate with taskType resolves. */
export const TEST_TASK_TYPES = parseTaskTypeRegistry({
  worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
  plan: { backend: 'codex', model: 'gpt-5', role: 'worker', briefKind: 'plan' },
  implement: { backend: 'claude', model: 'sonnet', role: 'worker', briefKind: 'implement' },
  coordinate: { backend: 'grok', role: 'coordinator', briefKind: 'coordinate' },
});

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
    makeBackend: (name) => ({ ...backend, name }),
    askBridge,
    credentialRegistry: credentials,
    bridgePort: 19999,
    getTaskTypeRegistry: () => TEST_TASK_TYPES,
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
      spec: { goal: 'child', taskType: 'worker', backend: 'grok' },
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
      spec: { goal: 'child task', taskType: 'worker', backend: 'grok', role: 'worker' },
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
      spec: { goal: 'child A', taskType: 'worker', backend: 'grok', role: 'worker' },
    });
    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-b',
      spec: { goal: 'child B', taskType: 'worker', backend: 'grok', role: 'worker' },
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
      spec: { goal: 'do it', taskType: 'worker', backend: 'grok', role: 'worker' },
    });
    expect(result.ok).toBe(true);
    const childId = deriveEntityId(started.value.turnId, 'op-del', 'task');
    expect(store.getTask(childId)?.releaseState).toBe('released');
    const turns = Object.values(store.getFile().turns).filter((t) => t.taskId === childId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.trigger).toBe('engine');
  });

  it('W4: set_task_lifecycle succeeded seals direct child with coordinator seal', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree', 'cancel_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 30));
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task', 'set_task_lifecycle', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-c',
      spec: { goal: 'child work', taskType: 'worker', backend: 'grok', role: 'worker' },
    });
    const childId = deriveEntityId(started.value.turnId, 'op-c', 'task');
    // release via host startTask after marking released
    store.commit((draft) => {
      draft.tasks[childId] = {
        ...draft.tasks[childId]!,
        releaseState: 'released',
        revision: draft.tasks[childId]!.revision + 1,
      };
      return { ok: true };
    });

    const sealed = await engine.handleToolCall(ctx, 'set_task_lifecycle', {
      kind: 'set_task_lifecycle',
      opId: 'op-seal',
      taskId: childId,
      lifecycle: 'succeeded',
      result: 'done by parent',
    });
    expect(sealed.ok).toBe(true);
    const child = store.getTask(childId);
    expect(child?.lifecycle).toBe('succeeded');
    expect(child?.taskResult?.summary).toBe('done by parent');
    expect(child?.sealedBy).toEqual({
      kind: 'coordinator',
      taskId: 'coord',
      turnId: started.value.turnId,
      mode: 'parent_seal',
    });

    // compatible replay: no mutation
    const rev = child!.revision;
    const again = await engine.handleToolCall(ctx, 'set_task_lifecycle', {
      kind: 'set_task_lifecycle',
      opId: 'op-seal-2',
      taskId: childId,
      lifecycle: 'succeeded',
      result: 'done by parent',
    });
    expect(again.ok).toBe(true);
    expect(store.getTask(childId)?.revision).toBe(rev);
    expect(store.getTask(childId)?.sealedBy?.kind).toBe('coordinator');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('W4: set_task_lifecycle propose_only rejects parent seal', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'cancel_child'],
    });
    store.commit((draft) => {
      draft.tasks.coord = {
        ...draft.tasks.coord!,
        childOrchestrationSeal: 'propose_only',
      };
      return { ok: true };
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task', 'set_task_lifecycle']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-c',
      spec: { goal: 'c', taskType: 'worker', backend: 'grok' },
    });
    const childId = deriveEntityId(started.value.turnId, 'op-c', 'task');
    const result = await engine.handleToolCall(ctx, 'set_task_lifecycle', {
      kind: 'set_task_lifecycle',
      opId: 'op-seal',
      taskId: childId,
      lifecycle: 'succeeded',
      result: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/propose_only/);
  });

  it('W3: get_host_context returns role-filtered JSON with zero op-ledger rows', async () => {
    const { store, engine, credentials } = makeHarness();
    const hostSnap = {
      cwd: '/ws',
      trusted: true,
      availableBackends: ['opencode'],
      models: {
        opencode: {
          current: 'm1',
          options: [{ value: 'm1', name: 'M1' }],
        },
      },
    };
    // Re-load engine with host cache for this test
    const engineWithHost = TaskEngine.load({
      store,
      makeBackend: () => ({
        name: 'grok',
        capabilities: MCP_CAPS,
        async *run() {
          yield { type: 'sessionStarted', sessionId: 's' };
          yield { type: 'turnCompleted' };
        },
      }),
      askBridge: new AskBridge(),
      credentialRegistry: credentials,
      bridgePort: 19999,
      getHostEnvironment: () => hostSnap,
      getTaskTypeRegistry: () => TEST_TASK_TYPES,
      isWorkspaceTrusted: () => true,
    });
    engineWithHost.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engineWithHost.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 30));
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['get_host_context', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const opsBefore = Object.keys(store.getFile().operations ?? {}).length;
    const result = await engineWithHost.handleToolCall(ctx, 'get_host_context', {
      kind: 'get_host_context',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const host = result.result as {
      version: number;
      self: { taskId: string; role: string };
      availableBackends?: string[];
      taskTypes?: Array<{ id: string }>;
      scope?: unknown;
    };
    expect(host.version).toBe(1);
    expect(host.self.taskId).toBe('coord');
    expect(host.self.role).toBe('coordinator');
    // get_host_context keeps diagnostic backends; also surfaces taskTypes.
    expect(host.availableBackends).toEqual(['opencode']);
    expect(host.taskTypes?.some((t) => t.id === 'plan')).toBe(true);
    expect(host.scope).toBeUndefined();
    const opsAfter = Object.keys(store.getFile().operations ?? {}).length;
    expect(opsAfter).toBe(opsBefore);

    // Second call still works, still no ledger growth
    const again = await engineWithHost.handleToolCall(ctx, 'get_host_context', {
      kind: 'get_host_context',
    });
    expect(again.ok).toBe(true);
    expect(Object.keys(store.getFile().operations ?? {}).length).toBe(opsBefore);
  });

  it('W3: get_host_context for worker omits backends/models', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({
      id: 'worker-1',
      goal: 'do work',
      backend: 'grok',
      role: 'worker',
      capabilities: [],
    });
    const started = engine.startTask('worker-1');
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'worker-1',
      callerTaskId: 'worker-1',
      turnId: started.value.turnId,
      allowedActions: new Set(['get_host_context', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    // harness engine has no getHostEnvironment → minimal snapshot
    const result = await engine.handleToolCall(ctx, 'get_host_context', {
      kind: 'get_host_context',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const host = result.result as {
      availableBackends?: string[];
      models?: unknown;
      scope?: { singleTask: boolean };
    };
    expect(host.availableBackends).toBeUndefined();
    expect(host.models).toBeUndefined();
    expect(host.scope?.singleTask).toBe(true);
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
        taskType: 'worker',
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
        taskType: 'worker',
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
        taskType: 'worker',
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
      spec: { goal: 'plan', taskType: 'plan', backend: 'codex', model: 'gpt-5', role: 'worker' },
    });
    const createId = deriveEntityId(started.value.turnId, 'op-model-create', 'task');
    expect(store.getTask(createId)?.model).toBe('gpt-5');
    expect(store.getTask(createId)?.backend).toBe('codex');

    await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-model-del',
      spec: { goal: 'impl', taskType: 'implement', backend: 'claude', model: 'sonnet', role: 'worker' },
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
      getTaskTypeRegistry: () => TEST_TASK_TYPES,
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
        taskType: 'worker',
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
      spec: { goal: 'child', taskType: 'worker', backend: 'grok', role: 'worker' },
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
        taskType: 'worker',
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

  it('task types: create_task resolves preset backend/model and persists taskType', async () => {
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
      allowedActions: new Set(['create_task', 'list_task_types', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const listed = await engine.handleToolCall(ctx, 'list_task_types', { kind: 'list_task_types' });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const data = listed.result as { taskTypes: Array<{ id: string }> };
      expect(data.taskTypes.some((t) => t.id === 'plan')).toBe(true);
    }
    const opsBefore = Object.keys(store.getFile().operations ?? {}).length;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-plan',
      spec: { goal: 'write plan', taskType: 'plan' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.result as {
        taskId: string;
        taskType: string;
        resolved: { backend: string; model?: string };
      };
      expect(data.taskType).toBe('plan');
      expect(data.resolved.backend).toBe('codex');
      expect(data.resolved.model).toBe('gpt-5');
    }
    const childId = deriveEntityId(started.value.turnId, 'op-plan', 'task');
    const child = store.getTask(childId);
    expect(child?.backend).toBe('codex');
    expect(child?.model).toBe('gpt-5');
    expect(child?.taskType).toBe('plan');
    expect(child?.brief?.kind).toBe('plan');
    // list_task_types does not grow op ledger
    expect(Object.keys(store.getFile().operations ?? {}).length).toBe(opsBefore + 1);
  });

  it('task types: unknown type has zero child rows', async () => {
    const { store, engine, credentials } = makeHarness();
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
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-unknown',
      spec: { goal: 'x', taskType: 'nope', backend: 'codex' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown_task_type/);
    }
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
  });

  it('task types: typo backend → backend_unsupported, zero children', async () => {
    const { store, engine, credentials } = makeHarness();
    // Override registry with typo backend
    const badReg = parseTaskTypeRegistry({ bad: { backend: 'codx' } });
    const engine2 = TaskEngine.load({
      store,
      makeBackend: (name) => {
        if (name === 'codx') throw new Error('unsupported backend: codx');
        return {
          name,
          capabilities: MCP_CAPS,
          async *run() {
            yield { type: 'turnCompleted' };
          },
        };
      },
      askBridge: new AskBridge(),
      credentialRegistry: credentials,
      bridgePort: 19999,
      getTaskTypeRegistry: () => badReg,
    });
    engine2.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child'],
    });
    const started = engine2.startTask('coord');
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine2.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-typo',
      spec: { goal: 'x', taskType: 'bad' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/backend_unsupported/);
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
  });

  it('task types: malformed registry → invalid_task_type_config, zero children', async () => {
    const { store, credentials } = makeHarness();
    const inv = parseTaskTypeRegistry({ plan: { backend: 1 } });
    const engine = TaskEngine.load({
      store,
      makeBackend: () => ({
        name: 'grok',
        capabilities: MCP_CAPS,
        async *run() {
          yield { type: 'turnCompleted' };
        },
      }),
      askBridge: new AskBridge(),
      credentialRegistry: credentials,
      bridgePort: 19999,
      getTaskTypeRegistry: () => inv,
    });
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
      allowedActions: new Set(['create_task', 'list_task_types']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const list = await engine.handleToolCall(ctx, 'list_task_types', { kind: 'list_task_types' });
    expect(list.ok).toBe(true);
    if (list.ok) {
      const data = list.result as { diagnostics: unknown[] };
      expect(data.diagnostics.length).toBeGreaterThan(0);
    }
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-inv',
      spec: { goal: 'x', taskType: 'plan' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid_task_type_config/);
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
  });

});

describe('engine graph batch create/delegate', () => {
  function startCoord(engine: TaskEngine, credentials: CredentialRegistry, actions: string[]) {
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree', 'cancel_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) throw new Error('failed to start coord');
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(actions as import('./capabilities').ToolAction[]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    return { turnId: started.value.turnId, ctx };
  }

  it('delegate_tasks atomically creates N children + N first turns; ledger idempotent on same opId', async () => {
    const { store, engine, credentials } = makeHarness();
    const { turnId, ctx } = startCoord(engine, credentials, ['delegate_tasks', 'complete_task']);

    const result = await engine.handleToolCall(ctx, 'delegate_tasks', {
      kind: 'delegate_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'first child', taskType: 'worker' },
        { localId: 'b', goal: 'second child', taskType: 'worker' },
      ],
    });
    expect(result.ok).toBe(true);
    const aId = deriveEntityId(turnId, 'op-batch', 'task:a');
    const bId = deriveEntityId(turnId, 'op-batch', 'task:b');
    if (result.ok) {
      const data = result.result as { taskIds: string[]; turnIds: string[] };
      expect(data.taskIds).toEqual([aId, bId]);
      expect(data.turnIds).toEqual([
        deriveEntityId(turnId, 'op-batch', 'turn:a'),
        deriveEntityId(turnId, 'op-batch', 'turn:b'),
      ]);
    }
    expect(store.getTask(aId)?.parentId).toBe('coord');
    expect(store.getTask(aId)?.releaseState).toBe('released');
    expect(store.getTask(bId)?.releaseState).toBe('released');
    expect(Object.values(store.getFile().turns).filter((t) => t.taskId === aId)).toHaveLength(1);
    expect(Object.values(store.getFile().turns).filter((t) => t.taskId === bId)).toHaveLength(1);

    const tasksAfterFirst = Object.keys(store.getFile().tasks).length;
    const turnsAfterFirst = Object.keys(store.getFile().turns).length;
    // Same opId → cached ledger, no new tasks/turns.
    const again = await engine.handleToolCall(ctx, 'delegate_tasks', {
      kind: 'delegate_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'first child', taskType: 'worker' },
        { localId: 'b', goal: 'second child', taskType: 'worker' },
      ],
    });
    expect(again.ok).toBe(true);
    expect(Object.keys(store.getFile().tasks).length).toBe(tasksAfterFirst);
    expect(Object.keys(store.getFile().turns).length).toBe(turnsAfterFirst);
  });

  it('create_tasks leaves every child as a draft with no turns', async () => {
    const { store, engine, credentials } = makeHarness();
    const { turnId, ctx } = startCoord(engine, credentials, ['create_tasks', 'complete_task']);
    const result = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'first', taskType: 'worker' },
        { localId: 'b', goal: 'second', taskType: 'worker' },
      ],
    });
    expect(result.ok).toBe(true);
    const aId = deriveEntityId(turnId, 'op-batch', 'task:a');
    const bId = deriveEntityId(turnId, 'op-batch', 'task:b');
    expect(store.getTask(aId)?.releaseState).toBe('draft');
    expect(store.getTask(bId)?.releaseState).toBe('draft');
    expect(Object.values(store.getFile().turns).filter((t) => t.taskId === aId)).toHaveLength(0);
    expect(Object.values(store.getFile().turns).filter((t) => t.taskId === bId)).toHaveLength(0);
    if (result.ok) {
      const data = result.result as { turnIds: string[] };
      expect(data.turnIds).toEqual([]);
    }
  });

  it('rejects the whole batch and writes zero tasks when one item has a bad taskType', async () => {
    const { store, engine, credentials } = makeHarness();
    const { ctx } = startCoord(engine, credentials, ['create_tasks']);
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'good', goal: 'ok', taskType: 'worker' },
        { localId: 'bad', goal: 'nope', taskType: 'does-not-exist' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown_task_type/);
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
  });

  it('rejects the whole batch and writes zero tasks when an intra-batch binding is invalid', async () => {
    const { store, engine, credentials } = makeHarness();
    const { ctx } = startCoord(engine, credentials, ['create_tasks']);
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'producer', taskType: 'worker' },
        {
          localId: 'b',
          goal: 'consumer',
          taskType: 'worker',
          // Non-summary output is fail-closed at bindings validation.
          inputBindings: [{ fromLocalId: 'a', output: 'artifact' as 'summary', as: 'p' }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
  });

  it('rejects the whole batch when it exceeds maxChildrenPerTask (low limit override)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-graph-limit-'));
    const store = TaskStore.load({ filePath: path.join(dir, '.muster-tasks.json') });
    const credentials = new CredentialRegistry();
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => ({
        name,
        capabilities: MCP_CAPS,
        async *run() {
          yield { type: 'turnCompleted' };
        },
      }),
      askBridge: new AskBridge(),
      credentialRegistry: credentials,
      bridgePort: 19999,
      getTaskTypeRegistry: () => TEST_TASK_TYPES,
      resourceLimits: {
        maxDepth: 8,
        maxChildrenPerTask: 2,
        maxChildrenPerRoot: 64,
        maxTurnsPerTask: 50,
        maxConcurrentTurns: 4,
        maxConcurrentPerRoot: 4,
        maxConcurrentPerBackend: 2,
        maxResultBytes: 16_384,
        maxErrorBytes: 4_096,
      },
    });
    const { ctx } = startCoord(engine, credentials, ['create_tasks']);
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'x', taskType: 'worker' },
        { localId: 'b', goal: 'y', taskType: 'worker' },
        { localId: 'c', goal: 'z', taskType: 'worker' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/max children per task/);
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an intra-batch dependency cycle with zero writes', async () => {
    const { store, engine, credentials } = makeHarness();
    const { ctx } = startCoord(engine, credentials, ['create_tasks']);
    const before = Object.keys(store.getFile().tasks).length;
    const result = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'x', taskType: 'worker', dependsOn: ['b'] },
        { localId: 'b', goal: 'y', taskType: 'worker', dependsOn: ['a'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cycle/);
    expect(Object.keys(store.getFile().tasks).length).toBe(before);
  });

  it('rejects worker delegate_tasks via tool handler with zero writes', async () => {
    const { store, engine, credentials } = makeHarness();
    engine.createTask({ id: 'root', goal: 'w', backend: 'grok', role: 'worker' });
    const started = engine.startTask('root');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const token = credentials.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: started.value.turnId,
      // Worker credential never carries the batch action.
      allowedActions: new Set(['complete_task', 'ask_user']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'delegate_tasks', {
      kind: 'delegate_tasks',
      opId: 'op-batch',
      specs: [{ localId: 'a', goal: 'child', taskType: 'worker' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not permitted/);
    expect(Object.keys(store.getFile().tasks)).toEqual(['root']);
  });

  it('wires an intra-batch dependency + binding: consumer is held until producer succeeds, then pins its summary', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    const { turnId, ctx } = startCoord(engine, credentials, [
      'create_tasks',
      'release_tasks',
      'set_task_lifecycle',
      'complete_task',
    ]);
    await new Promise((r) => setTimeout(r, 30));

    // Draft batch: B depends on + binds A.
    const created = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'produce the plan', taskType: 'plan' },
        {
          localId: 'b',
          goal: 'consume the plan',
          taskType: 'implement',
          dependsOn: ['a'],
          inputBindings: [{ fromLocalId: 'a', output: 'summary', as: 'plan' }],
        },
      ],
    });
    expect(created.ok).toBe(true);
    const aId = deriveEntityId(turnId, 'op-batch', 'task:a');
    const bId = deriveEntityId(turnId, 'op-batch', 'task:b');

    // Derived dependency + binding reference A's derived id.
    expect(store.getTask(bId)?.dependencies).toEqual([
      { taskId: aId, requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
    ]);
    expect(store.getTask(bId)?.inputBindings).toEqual([
      { fromTaskId: aId, output: 'summary', as: 'plan' },
    ]);

    // Release B while A is still open → B is held on the dependency.
    const releasedB = await engine.handleToolCall(ctx, 'release_tasks', {
      kind: 'release_tasks',
      opId: 'op-rel-b',
      taskIds: [bId],
    });
    expect(releasedB.ok).toBe(true);
    const heldReadiness = evaluateTaskReadiness(store.getFile(), bId);
    expect(heldReadiness.schedulable).toBe(false);
    expect(heldReadiness.reasons.some((r) => r.code === 'waiting_dependencies')).toBe(true);

    // Mark A released, then parent-seal A succeeded with a summary.
    store.commit((draft) => {
      draft.tasks[aId] = {
        ...draft.tasks[aId]!,
        releaseState: 'released',
        revision: draft.tasks[aId]!.revision + 1,
      };
      return { ok: true };
    });
    const sealed = await engine.handleToolCall(ctx, 'set_task_lifecycle', {
      kind: 'set_task_lifecycle',
      opId: 'op-seal-a',
      taskId: aId,
      lifecycle: 'succeeded',
      result: 'PLAN SUMMARY',
    });
    expect(sealed.ok).toBe(true);
    expect(store.getTask(aId)?.taskResult?.summary).toBe('PLAN SUMMARY');

    // A succeeded unblocks B; its first turn now freezes and pins A's summary.
    let bTurn = Object.values(store.getFile().turns).find((t) => t.taskId === bId && t.sequence === 1);
    for (let i = 0; i < 50 && bTurn?.resolvedInputs === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
      bTurn = Object.values(store.getFile().turns).find((t) => t.taskId === bId && t.sequence === 1);
    }
    expect(bTurn?.resolvedInputs).toEqual([
      {
        as: 'plan',
        fromTaskId: aId,
        output: 'summary',
        producerResultRevision: 1,
        text: 'PLAN SUMMARY',
      },
    ]);

    // Cleanup: drain coord + B turns.
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-coord-idle');
    if (bTurn && bTurn.status === 'running') {
      engine.stageDisposition(bTurn.id, { kind: 'idle' }, 'op-b-idle');
    }
    resume();
    await engine.whenIdle();
  });
});