import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import {
  ACP_DEADLINE_BUFFER_MS,
  CREDENTIAL_DEADLINE_BUFFER_MS,
  buildRunOptionsForTurn,
  clearPendingParentQuestionOnCancel,
  deriveEntityId,
  issueTurnCredential,
  type GraphEngineDeps,
} from './engine-graph';
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
};

const activeHarnesses = new Set<{ engine: TaskEngine; resume: () => void }>();

afterEach(async () => {
  const harnesses = [...activeHarnesses];
  activeHarnesses.clear();

  for (const harness of harnesses) {
    harness.resume();
  }
  // Let schedules already queued by the assertion path register their promises,
  // then drain both current turns and any settlement-triggered continuations.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(harnesses.map(({ engine }) => engine.whenIdle()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(harnesses.map(({ engine }) => engine.whenIdle()));
});

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
  const resumeHarness = () => resume?.();
  activeHarnesses.add({ engine, resume: resumeHarness });

  return { store, engine, credentials, resume: resumeHarness };
}

describe('engine graph orchestration', () => {
  it('derives deterministic entity ids', () => {
    const a = deriveEntityId('turn-1', 'op-1', 'task');
    const b = deriveEntityId('turn-1', 'op-1', 'task');
    const c = deriveEntityId('turn-1', 'op-2', 'task');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('C5: cancel one of multiple child questions recomputes parent attention', () => {
    const draft = {
      tasks: {
        parent: {
          id: 'parent',
          role: 'coordinator' as const,
          lifecycle: 'open' as const,
          goal: 'p',
          parentId: null,
          dependencies: [],
          backend: 'grok',
          capabilities: [],
          executionPolicy: {
            maxTurns: 10,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 60_000,
            taskTimeoutMs: 120_000,
          },
          revision: 1,
          createdAt: 't0',
          updatedAt: 't0',
          attention: {
            code: 'child_question' as const,
            message: 'child c2 needs input',
            at: 't2',
            sourceTurnId: 'turn2',
          },
          pendingChildQuestions: {
            q1: { fromChildId: 'c1', questions: [{ prompt: 'q1' }], askedAt: 't1' },
            q2: { fromChildId: 'c2', questions: [{ prompt: 'q2' }], askedAt: 't2' },
          },
        },
        c1: {
          id: 'c1',
          role: 'worker' as const,
          lifecycle: 'open' as const,
          goal: 'c1',
          parentId: 'parent',
          dependencies: [],
          backend: 'grok',
          capabilities: [],
          executionPolicy: {
            maxTurns: 10,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 60_000,
            taskTimeoutMs: 120_000,
          },
          revision: 1,
          createdAt: 't0',
          updatedAt: 't0',
          pendingParentQuestion: {
            questionId: 'q1',
            questions: [{ prompt: 'q1' }],
            askedAt: 't1',
            sourceTurnId: 'turn1',
          },
        },
        c2: {
          id: 'c2',
          role: 'worker' as const,
          lifecycle: 'open' as const,
          goal: 'c2',
          parentId: 'parent',
          dependencies: [],
          backend: 'grok',
          capabilities: [],
          executionPolicy: {
            maxTurns: 10,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 60_000,
            taskTimeoutMs: 120_000,
          },
          revision: 1,
          createdAt: 't0',
          updatedAt: 't0',
          attention: {
            code: 'awaiting_parent_answer' as const,
            message: 'wait',
            at: 't2',
            sourceTurnId: 'turn2',
          },
          pendingParentQuestion: {
            questionId: 'q2',
            questions: [{ prompt: 'q2' }],
            askedAt: 't2',
            sourceTurnId: 'turn2',
          },
        },
      },
      turns: {},
      messages: {},
    };
    const nextChild = clearPendingParentQuestionOnCancel(draft as never, draft.tasks.c2 as never, 'now');
    expect(nextChild.pendingParentQuestion).toBeUndefined();
    const parent = draft.tasks.parent;
    expect(parent.pendingChildQuestions?.q2).toBeUndefined();
    expect(parent.pendingChildQuestions?.q1).toBeTruthy();
    expect(parent.attention?.code).toBe('child_question');
    expect(parent.attention?.message).toBe('child c1 needs input');
    expect(parent.attention?.sourceTurnId).toBe('turn1');
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
      allowedActions: new Set(['complete_task', 'complete_task']),
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
        'complete_task',
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
        'get_task_status',
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
    // With maxConcurrentPerBackend raised to 10, the scheduler auto-promotes the
    // released first-turn immediately, so it may already be running rather than
    // still queued. The atomic-release invariant is "exactly one non-terminal
    // first-turn per child", not the transient queued state.
    expect(['queued', 'running']).toContain(turnsA[0]?.status);

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
    // Creation clamps only to hard bounds; live user ceiling is applied at promote.
    expect(policy.runTimeoutOverrideMs).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurnTimeoutMs);
    expect(policy.turnTimeoutMs).toBeUndefined();
    expect(policy.taskTimeoutMs).toBeUndefined();
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

  it('derives ACP and credential lifetimes beyond the frozen run deadline', () => {
    const { store, credentials } = makeHarness();
    const before = Date.now();
    const deadlineMs = before + 30 * 60_000;
    store.commit((draft) => {
      draft.tasks['deadline-task'] = {
        id: 'deadline-task',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'long run',
        parentId: null,
        dependencies: [],
        backend: 'grok',
        capabilities: ['create_child'],
        executionPolicy: { maxTurns: 50, maxAutomaticRetries: 2 },
        executionEpoch: 1,
        revision: 0,
        createdAt: new Date(before).toISOString(),
        updatedAt: new Date(before).toISOString(),
      };
      draft.turns['deadline-turn'] = {
        id: 'deadline-turn',
        taskId: 'deadline-task',
        sequence: 0,
        trigger: 'user',
        status: 'running',
        inputs: [],
        executionEpoch: 1,
        effectiveRunLimitMs: 30 * 60_000,
        runDeadlineAt: new Date(deadlineMs).toISOString(),
        createdAt: new Date(before).toISOString(),
        startedAt: new Date(before).toISOString(),
      };
      return { ok: true };
    });
    const deps = {
      store,
      credentials,
      bridgePort: 19999,
      makeBackend: () => ({ name: 'grok', capabilities: MCP_CAPS, run: async function* () {} }),
    } as unknown as GraphEngineDeps;

    const built = buildRunOptionsForTurn(deps, 'deadline-turn', { prompt: 'continue' });
    expect(built.options.promptTimeoutMs).toBeGreaterThanOrEqual(
      deadlineMs - Date.now() + ACP_DEADLINE_BUFFER_MS - 10,
    );
    expect(built.options.promptTimeoutMs).toBeLessThanOrEqual(
      deadlineMs - before + ACP_DEADLINE_BUFFER_MS,
    );
    if (built.mcpConfigPath) fs.rmSync(built.mcpConfigPath, { force: true });

    const token = issueTurnCredential(deps, 'deadline-turn')!;
    const verified = credentials.verify(token)!;
    expect(verified.expiry).toBeGreaterThanOrEqual(
      deadlineMs + CREDENTIAL_DEADLINE_BUFFER_MS - 10,
    );
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
      allowedActions: new Set(['complete_task', 'complete_task']),
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
      { taskId: aId, requiredOutcome: 'succeeded', onUnsatisfied: 'fail' },
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

  it('auto-gates batch dependencies onto verify-kind producers, leaving non-verify deps ungated (verify-gate-loop B+C)', async () => {
    const { store, engine, credentials } = makeHarness();
    const { turnId, ctx } = startCoord(engine, credentials, ['create_tasks']);

    // Pre-existing tasks in the same root: one verify-kind, one implement-kind.
    const seedTask = (id: string, kind: 'verify' | 'implement') =>
      ({
        id,
        role: 'worker' as const,
        lifecycle: 'open' as const,
        goal: id,
        parentId: 'coord',
        dependencies: [],
        backend: 'grok',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        brief: {
          version: 1 as const,
          kind,
          title: id,
          objective: id,
          acceptanceCriteria: [],
          expectedOutputs: ['summary'],
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      });
    store.commit((draft) => {
      draft.tasks['pre-verify'] = seedTask('pre-verify', 'verify');
      draft.tasks['pre-impl'] = seedTask('pre-impl', 'implement');
      return { ok: true };
    });

    const created = await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-gate',
      specs: [
        // A verify-kind SIBLING produced within the same batch.
        { localId: 'vfy', goal: 'verify the work', taskType: 'worker', brief: { kind: 'verify' } },
        {
          localId: 'ship',
          goal: 'ship the work',
          taskType: 'implement',
          // Intra-batch binding onto the verify sibling → derived succeeded/fail dep, auto-gated.
          inputBindings: [{ fromLocalId: 'vfy', output: 'summary', as: 'verified' }],
          dependencies: [
            // Pre-existing verify producer, no requiredVerdict → auto-gated.
            { taskId: 'pre-verify', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
            // Pre-existing NON-verify producer → left untouched.
            { taskId: 'pre-impl', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
          ],
        },
      ],
    });
    expect(created.ok).toBe(true);

    const vfyId = deriveEntityId(turnId, 'op-gate', 'task:vfy');
    const shipId = deriveEntityId(turnId, 'op-gate', 'task:ship');
    const shipDeps = store.getTask(shipId)?.dependencies ?? [];

    // Sibling inputBinding dep onto the verify producer is auto-gated.
    expect(shipDeps).toContainEqual({
      taskId: vfyId,
      requiredOutcome: 'succeeded',
      onUnsatisfied: 'fail',
      requiredVerdict: 'pass',
    });
    // Explicit dep onto a pre-existing verify producer is auto-gated.
    expect(shipDeps).toContainEqual({
      taskId: 'pre-verify',
      requiredOutcome: 'succeeded',
      onUnsatisfied: 'block',
      requiredVerdict: 'pass',
    });
    // Dep onto a non-verify producer is NOT auto-gated.
    expect(shipDeps).toContainEqual({
      taskId: 'pre-impl',
      requiredOutcome: 'succeeded',
      onUnsatisfied: 'block',
    });
  });

  async function waitTurnRunning(
    store: TaskStore,
    turnId: string,
  ): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (store.getFile().turns[turnId]?.status === 'running') return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`turn ${turnId} never became running`);
  }

  it('P0: delegate_task waitForCompletion stages wait on created child in one op', async () => {
    const { store, engine, credentials, resume } = makeHarness();
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
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_task', 'wait_for_tasks', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-dwait',
      waitForCompletion: true,
      spec: { goal: 'do work', taskType: 'worker', backend: 'grok' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.result as { taskId: string; waitStaged?: boolean; waitTaskIds?: string[] };
    const childId = deriveEntityId(turnId, 'op-dwait', 'task');
    expect(data.taskId).toBe(childId);
    expect(data.waitStaged).toBe(true);
    expect(data.waitTaskIds).toEqual([childId]);
    expect(store.getFile().turns[turnId]?.disposition).toEqual({
      kind: 'wait_tasks',
      taskIds: [childId],
    });
    // Fire-and-forget still works when flag omitted.
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-clear');
    resume();
    await engine.whenIdle();
  });

  it('P0: same opId with different waitForCompletion conflicts', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_task', 'wait_for_tasks']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const first = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-same',
      waitForCompletion: true,
      spec: { goal: 'a', taskType: 'worker' },
    });
    expect(first.ok).toBe(true);
    const second = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-same',
      spec: { goal: 'a', taskType: 'worker' },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('opId conflict');
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P0: release_tasks waitForTaskIds stages exact wait subset', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['create_tasks', 'release_tasks', 'wait_for_tasks']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-ct',
      specs: [
        { localId: 'a', goal: 'a', taskType: 'worker' },
        { localId: 'b', goal: 'b', taskType: 'worker' },
      ],
    });
    const aId = deriveEntityId(turnId, 'op-ct', 'task:a');
    const bId = deriveEntityId(turnId, 'op-ct', 'task:b');
    const released = await engine.handleToolCall(ctx, 'release_tasks', {
      kind: 'release_tasks',
      opId: 'op-rel-wait',
      taskIds: [aId, bId],
      waitForTaskIds: [bId],
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const data = released.result as { waitStaged?: boolean; waitTaskIds?: string[] };
    expect(data.waitStaged).toBe(true);
    expect(data.waitTaskIds).toEqual([bId]);
    expect(store.getFile().turns[turnId]?.disposition).toEqual({
      kind: 'wait_tasks',
      taskIds: [bId],
    });
    const redundant = await engine.handleToolCall(ctx, 'wait_for_tasks', {
      kind: 'wait_for_tasks',
      opId: 'op-rel-redundant',
      taskIds: [bId],
    });
    expect(redundant.ok && redundant.result).toMatchObject({
      alreadyStaged: true,
      waitTaskIds: [bId],
      nextAction: 'end_current_turn',
      doNotPoll: true,
    });
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P1: continue_child reopens terminal child and queues instruction turn', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'cancel_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set([
        'create_task',
        'set_task_lifecycle',
        'continue_child',
        'wait_for_tasks',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-c',
      spec: { goal: 'child', taskType: 'worker' },
    });
    const childId = deriveEntityId(turnId, 'op-c', 'task');
    await engine.handleToolCall(ctx, 'set_task_lifecycle', {
      kind: 'set_task_lifecycle',
      opId: 'op-seal',
      taskId: childId,
      lifecycle: 'succeeded',
      result: 'done',
    });
    expect(store.getTask(childId)?.lifecycle).toBe('succeeded');
    const cont = await engine.handleToolCall(ctx, 'continue_child', {
      kind: 'continue_child',
      opId: 'op-cont',
      childId,
      instruction: 'revise the summary',
      waitForCompletion: true,
    });
    expect(cont.ok).toBe(true);
    expect(store.getTask(childId)?.lifecycle).toBe('open');
    const contTurnId = deriveEntityId(turnId, 'op-cont', 'turn');
    expect(store.getFile().turns[contTurnId]?.status).toBe('queued');
    expect(store.getFile().turns[turnId]?.disposition).toEqual({
      kind: 'wait_tasks',
      taskIds: [childId],
    });
    const redundant = await engine.handleToolCall(ctx, 'wait_for_tasks', {
      kind: 'wait_for_tasks',
      opId: 'op-cont-redundant',
      taskIds: [childId],
    });
    expect(redundant.ok && redundant.result).toMatchObject({
      alreadyStaged: true,
      waitTaskIds: [childId],
      nextAction: 'end_current_turn',
      doNotPoll: true,
    });
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P1: continue_child rejects live child', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_task', 'continue_child']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-d',
      spec: { goal: 'x', taskType: 'worker' },
    });
    const childId = deriveEntityId(turnId, 'op-d', 'task');
    for (let i = 0; i < 50; i++) {
      const t = Object.values(store.getFile().turns).find((x) => x.taskId === childId);
      if (t?.status === 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const cont = await engine.handleToolCall(ctx, 'continue_child', {
      kind: 'continue_child',
      opId: 'op-live',
      childId,
      instruction: 'more',
    });
    expect(cont.ok).toBe(false);
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P1: cancel_tasks cancels multiple owned children', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'cancel_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['create_tasks', 'cancel_tasks', 'cancel_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'create_tasks', {
      kind: 'create_tasks',
      opId: 'op-batch',
      specs: [
        { localId: 'a', goal: 'a', taskType: 'worker' },
        { localId: 'b', goal: 'b', taskType: 'worker' },
      ],
    });
    const aId = deriveEntityId(turnId, 'op-batch', 'task:a');
    const bId = deriveEntityId(turnId, 'op-batch', 'task:b');
    const cancelled = await engine.handleToolCall(ctx, 'cancel_tasks', {
      kind: 'cancel_tasks',
      opId: 'op-can',
      childIds: [aId, bId],
    });
    expect(cancelled.ok).toBe(true);
    expect(store.getTask(aId)?.lifecycle).toBe('cancelled');
    expect(store.getTask(bId)?.lifecycle).toBe('cancelled');
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P1: cancel_tasks clears pending ask_parent and parent inbound attention', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'cancel_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set([
        'delegate_task',
        'wait_for_tasks',
        'cancel_tasks',
        'cancel_task',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const delegated = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-ask-can',
      waitForCompletion: true,
      spec: { goal: 'work', taskType: 'worker' },
    });
    expect(delegated.ok).toBe(true);
    const childId = deriveEntityId(turnId, 'op-ask-can', 'task');
    let childTurn = Object.values(store.getFile().turns).find(
      (t) => t.taskId === childId && t.sequence === 1,
    );
    for (let i = 0; i < 50 && !childTurn; i++) {
      await new Promise((r) => setTimeout(r, 20));
      childTurn = Object.values(store.getFile().turns).find(
        (t) => t.taskId === childId && t.sequence === 1,
      );
    }
    expect(childTurn).toBeTruthy();
    for (let i = 0; i < 50 && store.getFile().turns[childTurn!.id]?.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const childToken = credentials.issue({
      rootId: 'coord',
      callerTaskId: childId,
      turnId: childTurn!.id,
      allowedActions: new Set(['ask_parent']),
      ttlMs: 60_000,
    });
    const childCtx = credentials.verify(childToken)!;
    const asked = await engine.handleToolCall(childCtx, 'ask_parent', {
      kind: 'ask_parent',
      opId: 'op-q-can',
      questions: [{ prompt: 'Need parent?', allowFreeText: false, options: ['a'] }],
    });
    expect(asked.ok).toBe(true);
    const qId = store.getTask(childId)?.pendingParentQuestion?.questionId;
    expect(qId).toBeTruthy();
    expect(store.getTask('coord')?.pendingChildQuestions?.[qId!]).toBeTruthy();

    const cancelled = await engine.handleToolCall(ctx, 'cancel_tasks', {
      kind: 'cancel_tasks',
      opId: 'op-can-q',
      childIds: [childId],
    });
    expect(cancelled.ok).toBe(true);
    expect(store.getTask(childId)?.lifecycle).toBe('cancelled');
    expect(store.getTask(childId)?.pendingParentQuestion).toBeUndefined();
    expect(store.getTask('coord')?.pendingChildQuestions?.[qId!]).toBeUndefined();
    expect(store.getTask('coord')?.attention?.code).not.toBe('child_question');
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('C5: cancel clears routed ask_parent on open ancestor when direct parent terminal', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'root',
      goal: 'root',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'cancel_child', 'wait_child'],
    });
    const rootStarted = engine.startTask('root');
    if (!rootStarted.ok) return;
    const rootTurnId = rootStarted.value.turnId;
    await waitTurnRunning(store, rootTurnId);
    // Terminal mid under open root so ask_parent routes to ancestor.
    store.commit((draft) => {
      const policy = {
        maxTurns: 10,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 60_000,
        taskTimeoutMs: 120_000,
      };
      draft.tasks.mid = {
        id: 'mid',
        role: 'coordinator',
        lifecycle: 'succeeded',
        goal: 'mid',
        parentId: 'root',
        dependencies: [],
        backend: 'grok',
        capabilities: ['create_child', 'cancel_child'],
        executionPolicy: policy,
        releaseState: 'released',
        finishedAt: '2026-07-06T12:00:00.000Z',
        revision: 1,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.tasks.leaf = {
        id: 'leaf',
        role: 'worker',
        lifecycle: 'open',
        goal: 'leaf',
        parentId: 'mid',
        dependencies: [],
        backend: 'grok',
        capabilities: [],
        executionPolicy: policy,
        releaseState: 'released',
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.turns['leaf-turn-1'] = {
        id: 'leaf-turn-1',
        taskId: 'leaf',
        sequence: 1,
        status: 'running',
        trigger: 'engine',
        inputs: [],
        createdAt: '2026-07-06T12:00:00.000Z',
        startedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });
    const childToken = credentials.issue({
      rootId: 'root',
      callerTaskId: 'leaf',
      turnId: 'leaf-turn-1',
      allowedActions: new Set(['ask_parent']),
      ttlMs: 60_000,
    });
    const childCtx = credentials.verify(childToken)!;
    const asked = await engine.handleToolCall(childCtx, 'ask_parent', {
      kind: 'ask_parent',
      opId: 'op-q-route',
      questions: [{ prompt: 'Need ancestor?', allowFreeText: false, options: ['a'] }],
    });
    expect(asked.ok).toBe(true);
    const qId = store.getTask('leaf')?.pendingParentQuestion?.questionId;
    expect(qId).toBeTruthy();
    // Question should land on open root ancestor, not only terminal mid.
    expect(store.getTask('root')?.pendingChildQuestions?.[qId!]).toBeTruthy();
    expect(store.getTask('root')?.attention?.code).toBe('child_question');

    const cancelled = engine.cancelTask('leaf');
    expect(cancelled.ok).toBe(true);
    expect(store.getTask('leaf')?.pendingParentQuestion).toBeUndefined();
    expect(store.getTask('root')?.pendingChildQuestions?.[qId!]).toBeUndefined();
    expect(store.getTask('root')?.attention?.code).not.toBe('child_question');
    expect(store.getTask('mid')?.pendingChildQuestions?.[qId!]).toBeUndefined();
    engine.stageDisposition(rootTurnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('C5: host cancelTask clears pending ask_parent and parent inbound', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'cancel_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_task', 'wait_for_tasks', 'cancel_tasks', 'cancel_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const delegated = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-ask-host-can',
      waitForCompletion: true,
      spec: { goal: 'work', taskType: 'worker' },
    });
    expect(delegated.ok).toBe(true);
    const childId = deriveEntityId(turnId, 'op-ask-host-can', 'task');
    let childTurn = Object.values(store.getFile().turns).find(
      (t) => t.taskId === childId && t.sequence === 1,
    );
    for (let i = 0; i < 50 && !childTurn; i++) {
      await new Promise((r) => setTimeout(r, 20));
      childTurn = Object.values(store.getFile().turns).find(
        (t) => t.taskId === childId && t.sequence === 1,
      );
    }
    expect(childTurn).toBeTruthy();
    for (let i = 0; i < 50 && store.getFile().turns[childTurn!.id]?.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const childToken = credentials.issue({
      rootId: 'coord',
      callerTaskId: childId,
      turnId: childTurn!.id,
      allowedActions: new Set(['ask_parent']),
      ttlMs: 60_000,
    });
    const childCtx = credentials.verify(childToken)!;
    const asked = await engine.handleToolCall(childCtx, 'ask_parent', {
      kind: 'ask_parent',
      opId: 'op-q-host-can',
      questions: [{ prompt: 'Need parent?', allowFreeText: false, options: ['a'] }],
    });
    expect(asked.ok).toBe(true);
    const qId = store.getTask(childId)?.pendingParentQuestion?.questionId;
    expect(qId).toBeTruthy();
    expect(store.getTask('coord')?.pendingChildQuestions?.[qId!]).toBeTruthy();

    const cancelled = engine.cancelTask(childId);
    expect(cancelled.ok).toBe(true);
    expect(store.getTask(childId)?.lifecycle).toBe('cancelled');
    expect(store.getTask(childId)?.pendingParentQuestion).toBeUndefined();
    expect(store.getTask('coord')?.pendingChildQuestions?.[qId!]).toBeUndefined();
    expect(store.getTask('coord')?.attention?.code).not.toBe('child_question');
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P0.5: ask_parent routes question; answer_child_question queues child continuation', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'cancel_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set([
        'delegate_task',
        'wait_for_tasks',
        'answer_child_question',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-ask-child',
      waitForCompletion: true,
      spec: { goal: 'work', taskType: 'worker' },
    });
    const childId = deriveEntityId(turnId, 'op-ask-child', 'task');
    const childTurn = Object.values(store.getFile().turns).find(
      (t) => t.taskId === childId && t.sequence === 1,
    )!;
    for (let i = 0; i < 50 && store.getFile().turns[childTurn.id]?.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const childToken = credentials.issue({
      rootId: 'coord',
      callerTaskId: childId,
      turnId: childTurn.id,
      allowedActions: new Set(['ask_parent', 'complete_task']),
      ttlMs: 60_000,
    });
    const childCtx = credentials.verify(childToken)!;
    const asked = await engine.handleToolCall(childCtx, 'ask_parent', {
      kind: 'ask_parent',
      opId: 'op-q1',
      questions: [{ prompt: 'Which approach?' }],
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    const qId = (asked.result as { questionId: string }).questionId;
    expect(store.getTask(childId)?.pendingParentQuestion?.questionId).toBe(qId);
    expect(store.getTask('coord')?.pendingChildQuestions?.[qId]?.fromChildId).toBe(childId);

    const answered = await engine.handleToolCall(ctx, 'answer_child_question', {
      kind: 'answer_child_question',
      opId: 'op-ans',
      questionId: qId,
      answers: ['use option A'],
    });
    expect(answered.ok).toBe(true);
    const contId = (answered.result as { continuationTurnId: string }).continuationTurnId;
    expect(store.getFile().turns[contId]?.taskId).toBe(childId);
    expect(store.getTask(childId)?.pendingParentQuestion?.answers).toEqual(['use option A']);
    expect(store.getTask('coord')?.pendingChildQuestions?.[qId]).toBeUndefined();

    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-c-idle');
    engine.stageDisposition(childTurn.id, { kind: 'idle' }, 'op-ch-idle');
    resume();
    await engine.whenIdle();
  });

  it('P0.5: child turn without disposition queues one disposition-repair turn', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_task', 'wait_for_tasks']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const del = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-repair-child',
      waitForCompletion: true,
      spec: { goal: 'work', taskType: 'worker' },
    });
    expect(del.ok).toBe(true);
    const childId = deriveEntityId(turnId, 'op-repair-child', 'task');
    const childTurn = Object.values(store.getFile().turns).find(
      (t) => t.taskId === childId && t.sequence === 1,
    );
    expect(childTurn).toBeDefined();
    // Wait child turn running, then settle with idle (no complete_task).
    for (let i = 0; i < 50 && store.getFile().turns[childTurn!.id]?.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    engine.stageDisposition(childTurn!.id, { kind: 'idle' }, 'op-child-idle');
    resume();
    await engine.whenIdle();
    const child = store.getTask(childId);
    // After idle settle: either repair_pending or already advanced to missing after repair.
    const repairId = `${childTurn!.id}-disposition-repair`;
    const repairTurn = store.getFile().turns[repairId];
    // Repair should have been created (at most once).
    expect(repairTurn).toBeDefined();
    expect(repairTurn?.id).toBe(repairId);
    // Parent wait should not have attention-woken solely for repair_pending mid-repair.
    // (coord may still be running; child lifecycle open)
    expect(child?.lifecycle).toBe('open');
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-coord-idle');
    if (repairTurn && (repairTurn.status === 'running' || repairTurn.status === 'queued')) {
      // Drain repair if still live
      for (let i = 0; i < 50 && store.getFile().turns[repairId]?.status === 'queued'; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      if (store.getFile().turns[repairId]?.status === 'running') {
        engine.stageDisposition(repairId, { kind: 'idle' }, 'op-repair-idle');
      }
    }
    resume();
    await engine.whenIdle();
  });

  it('P0: compound wait requires wait_for_tasks permission', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_task', 'release_tasks', 'delegate_tasks', 'create_tasks']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const d = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-no-wait-cap',
      waitForCompletion: true,
      spec: { goal: 'x', taskType: 'worker' },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain('wait_for_tasks');
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('P0: delegate_tasks waitForLocalIds stages wait only for listed locals', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    if (!started.ok) return;
    const turnId = started.value.turnId;
    await waitTurnRunning(store, turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId,
      allowedActions: new Set(['delegate_tasks', 'wait_for_tasks']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const result = await engine.handleToolCall(ctx, 'delegate_tasks', {
      kind: 'delegate_tasks',
      opId: 'op-dt',
      waitForLocalIds: ['b'],
      specs: [
        { localId: 'a', goal: 'a', taskType: 'worker' },
        { localId: 'b', goal: 'b', taskType: 'worker' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bId = deriveEntityId(turnId, 'op-dt', 'task:b');
    const data = result.result as { waitTaskIds?: string[] };
    expect(data.waitTaskIds).toEqual([bId]);
    expect(store.getFile().turns[turnId]?.disposition).toEqual({
      kind: 'wait_tasks',
      taskIds: [bId],
    });
    const redundant = await engine.handleToolCall(ctx, 'wait_for_tasks', {
      kind: 'wait_for_tasks',
      opId: 'op-dt-redundant',
      taskIds: [bId],
    });
    expect(redundant.ok && redundant.result).toMatchObject({
      alreadyStaged: true,
      waitTaskIds: [bId],
      nextAction: 'end_current_turn',
      doNotPoll: true,
    });
    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume();
    await engine.whenIdle();
  });

  it('makes a redundant standalone wait idempotent after compound delegate wait', async () => {
    const { store, engine, credentials, resume } = makeHarness();
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
    await waitTurnRunning(store, started.value.turnId);
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['delegate_task', 'wait_for_tasks', 'get_task_status']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const delegated = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-compound',
      waitForCompletion: true,
      spec: { goal: 'work', taskType: 'worker' },
    });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;
    const childId = (delegated.result as { taskId: string }).taskId;
    const redundant = await engine.handleToolCall(ctx, 'wait_for_tasks', {
      kind: 'wait_for_tasks',
      opId: 'op-redundant',
      taskIds: [childId],
    });
    expect(redundant).toEqual({
      ok: true,
      result: {
        staged: true,
        alreadyStaged: true,
        waitTaskIds: [childId],
        nextAction: 'end_current_turn',
        doNotPoll: true,
      },
    });
    const status = await engine.handleToolCall(ctx, 'get_task_status', {
      kind: 'get_task_status',
      taskId: 'coord',
    });
    expect(status.ok && status.result).toMatchObject({
      callerWaitStaged: true,
      nextAction: 'end_current_turn',
      doNotPoll: true,
    });
    resume();
    await engine.whenIdle();
  });

  it('unions children from two singular compound delegates in stable order', async () => {
    const { store, engine, credentials, resume } = makeHarness();
    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child'],
    });
    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitTurnRunning(store, started.value.turnId);
    const ctx = credentials.verify(credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['delegate_task', 'wait_for_tasks']),
      ttlMs: 60_000,
    }))!;
    for (const opId of ['op-a', 'op-b']) {
      const result = await engine.handleToolCall(ctx, 'delegate_task', {
        kind: 'delegate_task',
        opId,
        waitForCompletion: true,
        spec: { goal: opId, taskType: 'worker' },
      });
      expect(result.ok).toBe(true);
    }
    expect(store.getFile().turns[started.value.turnId]?.disposition).toEqual({
      kind: 'wait_tasks',
      taskIds: [
        deriveEntityId(started.value.turnId, 'op-a', 'task'),
        deriveEntityId(started.value.turnId, 'op-b', 'task'),
      ],
    });
    resume();
    await engine.whenIdle();
  });
});
