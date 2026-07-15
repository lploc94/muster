import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend, BackendCapabilities, RunOptions } from '../types';
import * as brief from './brief';
import { TaskEngine } from './engine';
import type { HostEnvironmentSnapshot } from './host-context';
import { TaskStore } from './store';
import { parseTaskTypeRegistry } from './task-types';

const EMPTY_TASK_TYPES = parseTaskTypeRegistry({});
const WORKER_TASK_TYPES = parseTaskTypeRegistry({
  worker: { backend: 'grok', role: 'worker' },
});

const tempDirs: string[] = [];

function makeTempStore(): { store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-first-turn-'));
  tempDirs.push(dir);
  return { store: TaskStore.load({ filePath: path.join(dir, '.muster-tasks.json') }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

const hostSnap = (overrides: Partial<HostEnvironmentSnapshot> = {}): HostEnvironmentSnapshot => ({
  cwd: '/workspace',
  trusted: true,
  availableBackends: ['opencode', 'codex'],
  models: {
    opencode: {
      current: 'deepseek-v4-flash',
      options: [{ value: 'deepseek-v4-flash', name: 'DeepSeek' }],
    },
  },
  ...overrides,
});

describe('W1 single freeze site + host prepare', () => {
  it('assembles host context once at promote for root startNewTask', async () => {
    const { store } = makeTempStore();
    const spy = vi.spyOn(brief, 'assembleFirstTurnPrompt');
    let captured = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        captured = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 's1' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const prepare = vi.fn(async () => {});
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      prepareHostEnvironment: prepare,
      getHostEnvironment: () => hostSnap(),
      isWorkspaceTrusted: () => true,
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
    });

    const started = engine.startNewTask({
      goal: 'Coordinate the work',
      backend: 'fake',
      role: 'coordinator',
      message: 'Coordinate the work',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await new Promise((r) => setTimeout(r, 40));
    expect(prepare).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(captured).toContain('# Muster host context');
    expect(captured).toContain('## Available backends');
    expect(captured).toContain('opencode');

    const turnId = started.value.turnId;
    expect(turnId).toBeTruthy();
    if (!turnId) return;
    const turn = store.getFile().turns[turnId];
    expect(turn?.compiledPrompt).toContain('# Muster host context');
    expect(turn?.resolvedInputs).toEqual([]);

    engine.stageDisposition(turnId, { kind: 'idle' }, 'op-idle');
    resume?.();
    await engine.whenIdle();
  });

  it('worker first turn: host base + scope, no backends section', async () => {
    const { store } = makeTempStore();
    let captured = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        captured = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 's-w' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      isWorkspaceTrusted: () => true,
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
    });

    store.commit((draft) => {
      draft.tasks.child = {
        id: 'child',
        role: 'worker',
        lifecycle: 'open',
        goal: 'Implement X',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        releaseState: 'released',
        brief: brief.synthesizeBriefFromGoal('Implement X', undefined, 'implement'),
        cwd: '/task/cwd',
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const started = engine.startTask('child', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 40));

    expect(captured).toContain('# Muster host context');
    expect(captured).toContain('cwd: `/task/cwd`');
    expect(captured).toContain('## Scope');
    expect(captured).not.toContain('## Available backends');
    expect(captured).toContain('implementation agent');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-w');
    resume?.();
    await engine.whenIdle();
  });

  it('sequence >= 2 does not re-assemble host block', async () => {
    const { store } = makeTempStore();
    const spy = vi.spyOn(brief, 'assembleFirstTurnPrompt');
    const prompts: string[] = [];
    let resume1: (() => void) | undefined;
    let resume2: (() => void) | undefined;
    let turnCount = 0;
    const gate1 = new Promise<void>((r) => {
      resume1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      resume2 = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        prompts.push(options.prompt ?? '');
        turnCount += 1;
        yield { type: 'sessionStarted', sessionId: 's-multi' };
        if (turnCount === 1) await gate1;
        else await gate2;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
    });

    const created = engine.createTask({ id: 't-multi', goal: 'multi', backend: 'fake' });
    expect(created.ok).toBe(true);
    const t1 = engine.send('t-multi', 'first');
    expect(t1.ok).toBe(true);
    if (!t1.ok || !t1.value.turnId) return;
    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('# Muster host context');

    engine.stageDisposition(t1.value.turnId, { kind: 'idle' }, 'op-1');
    resume1?.();
    await engine.whenIdle();

    const t2 = engine.send('t-multi', 'second message only');
    expect(t2.ok).toBe(true);
    if (!t2.ok || !t2.value.turnId) return;
    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prompts[1]).toBe('second message only');
    expect(prompts[1]).not.toContain('# Muster host context');

    engine.stageDisposition(t2.value.turnId, { kind: 'idle' }, 'op-2');
    resume2?.();
    await engine.whenIdle();
  });

  it('prepare timeout / empty cache → minimal host; trust from workspace API', async () => {
    const { store } = makeTempStore();
    let captured = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        captured = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 's-min' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 5_000);
        }),
    );
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      prepareHostEnvironment: prepare,
      getHostEnvironment: () => undefined,
      isWorkspaceTrusted: () => true,
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
      workspaceFolder: '/fallback-cwd',
    });

    const started = engine.startNewTask({
      goal: 'minimal host',
      backend: 'fake',
      message: 'minimal host',
    });
    expect(started.ok).toBe(true);
    if (!started.ok || !started.value.turnId) return;
    // prepare races with 2s timeout before dispatch
    for (let i = 0; i < 80 && !captured; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(prepare).toHaveBeenCalled();
    expect(captured).toContain('# Muster host context');
    expect(captured).toContain('trusted: `true`');
    expect(captured).toContain('(none detected)');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-min');
    resume?.();
    await engine.whenIdle();
  }, 15_000);

  it('budget exceeded → failed turn + attention; no adapter run', async () => {
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
    vi.spyOn(brief, 'assembleFirstTurnPrompt').mockReturnValue({
      ok: false,
      code: 'prompt_budget_exceeded',
      message: 'First-turn prompt core exceeds budget (test)',
    });
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
    });

    store.commit((draft) => {
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        brief: brief.synthesizeBriefFromGoal('implement'),
        releaseState: 'released',
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const started = engine.startTask('impl', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 50));

    expect(ran).toBe(false);
    const turn = store.getFile().turns[started.value.turnId];
    expect(turn?.status).toBe('failed');
    expect(turn?.error).toMatch(/budget/i);
    const impl = store.getTask('impl');
    expect(impl?.attention?.code).toBe('prompt_budget_exceeded');
    expect(impl?.lifecycle).toBe('open');
  });

  it('KNOWN backend: known-absent skill → skill_unavailable attention + prompt omits command', async () => {
    const { store } = makeTempStore();
    let captured = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        captured = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 's-skill-known' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
      // KNOWN backend: advertises `plan` but not `ghost`.
      getAdvertisedCommands: () => new Set(['plan']),
    });

    store.commit((draft) => {
      const b = brief.synthesizeBriefFromGoal('implement');
      b.skills = ['plan', 'ghost'];
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        brief: b,
        releaseState: 'released',
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const started = engine.startTask('impl', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 50));

    // Advertised skill is injected as a leading line; known-absent one is not.
    expect(captured.startsWith('/plan\n\n')).toBe(true);
    expect(captured).not.toContain('/ghost');
    const impl = store.getTask('impl');
    expect(impl?.attention?.code).toBe('skill_unavailable');
    expect(impl?.attention?.message).toContain('ghost');
    expect(impl?.attention?.message).toContain('fake');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-skill');
    resume?.();
    await engine.whenIdle();
  });

  it('UNKNOWN backend: resolver returns undefined → skill injected, no attention', async () => {
    const { store } = makeTempStore();
    let captured = '';
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(options: RunOptions) {
        captured = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: 's-skill-unknown' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
      // UNKNOWN backend: never advertised → optimistic inject, no fail-closed.
      getAdvertisedCommands: () => undefined,
    });

    store.commit((draft) => {
      const b = brief.synthesizeBriefFromGoal('implement');
      b.skills = ['plan', 'ghost'];
      draft.tasks.impl = {
        id: 'impl',
        role: 'worker',
        lifecycle: 'open',
        goal: 'implement',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        brief: b,
        releaseState: 'released',
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const started = engine.startTask('impl', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 50));

    expect(captured.startsWith('/plan\n/ghost\n\n')).toBe(true);
    const impl = store.getTask('impl');
    expect(impl?.attention).toBeUndefined();

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-skill-2');
    resume?.();
    await engine.whenIdle();
  });

  it('release_tasks queues without assemble; promote assembles once per child', async () => {
    const { store } = makeTempStore();
    const spy = vi.spyOn(brief, 'assembleFirstTurnPrompt');
    const { AskBridge } = await import('../bridge/ask-bridge');
    const { CredentialRegistry } = await import('../bridge/credentials');
    const { deriveEntityId } = await import('./engine-graph');
    const credentials = new CredentialRegistry();
    let resumeRoot: (() => void) | undefined;
    let resumeChild: (() => void) | undefined;
    let runs = 0;
    const gateRoot = new Promise<void>((r) => {
      resumeRoot = r;
    });
    const gateChild = new Promise<void>((r) => {
      resumeChild = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        runs += 1;
        yield { type: 'sessionStarted', sessionId: `s-r-${runs}` };
        if (runs === 1) await gateRoot;
        else await gateChild;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      askBridge: new AskBridge(),
      credentialRegistry: credentials,
      bridgePort: 19997,
      getTaskTypeRegistry: () => WORKER_TASK_TYPES,
    });

    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'fake',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);

    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value.turnId,
      allowedActions: new Set(['create_task', 'release_tasks', 'complete_task']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const created = await engine.handleToolCall(ctx, 'create_task', {
      kind: 'create_task',
      opId: 'op-c',
      spec: { goal: 'draft child', taskType: 'worker', role: 'worker' },
    });
    expect(created.ok).toBe(true);
    const childId = deriveEntityId(started.value.turnId, 'op-c', 'task');
    expect(spy).toHaveBeenCalledTimes(1);

    // After create, child is draft with no turns → no assemble beyond root.
    expect(Object.values(store.getFile().turns).filter((t) => t.taskId === childId)).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);

    const released = await engine.handleToolCall(ctx, 'release_tasks', {
      kind: 'release_tasks',
      opId: 'op-rel',
      taskIds: [childId],
    });
    expect(released.ok).toBe(true);

    for (let i = 0; i < 50 && spy.mock.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // root promote + child promote only (release path does not assemble itself)
    expect(spy).toHaveBeenCalledTimes(2);
    const childTurn = Object.values(store.getFile().turns).find(
      (t) => t.taskId === childId && t.sequence === 1,
    );
    expect(childTurn?.compiledPrompt).toContain('# Muster host context');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-root-idle');
    resumeRoot?.();
    resumeChild?.();
    await engine.whenIdle();
  });

  it('delegate_task queues without assemble; promote assembles once', async () => {
    const { store } = makeTempStore();
    const spy = vi.spyOn(brief, 'assembleFirstTurnPrompt');
    const { AskBridge } = await import('../bridge/ask-bridge');
    const { CredentialRegistry } = await import('../bridge/credentials');
    const credentials = new CredentialRegistry();
    let resumeRoot: (() => void) | undefined;
    let resumeChild: (() => void) | undefined;
    let runs = 0;
    const gateRoot = new Promise<void>((r) => {
      resumeRoot = r;
    });
    const gateChild = new Promise<void>((r) => {
      resumeChild = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        runs += 1;
        yield { type: 'sessionStarted', sessionId: `s-d-${runs}` };
        if (runs === 1) await gateRoot;
        else await gateChild;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      askBridge: new AskBridge(),
      credentialRegistry: credentials,
      bridgePort: 19998,
      getTaskTypeRegistry: () => WORKER_TASK_TYPES,
    });

    engine.createTask({
      id: 'coord',
      goal: 'coord',
      backend: 'fake',
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 40));
    // Root first-turn assemble once
    expect(spy).toHaveBeenCalledTimes(1);

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
      spec: { goal: 'child work', taskType: 'worker', role: 'worker' },
    });
    expect(result.ok).toBe(true);

    // Wait for child promote (async schedule). Exactly root + child assemble.
    for (let i = 0; i < 50 && spy.mock.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(spy).toHaveBeenCalledTimes(2);

    const child = Object.values(store.getFile().tasks).find((t) => t.parentId === 'coord');
    expect(child).toBeDefined();
    const childTurn = Object.values(store.getFile().turns).find(
      (t) => t.taskId === child!.id && t.sequence === 1,
    );
    expect(childTurn?.compiledPrompt).toContain('# Muster host context');
    expect(childTurn?.compiledPrompt).toContain('## Scope');

    engine.stageDisposition(started.value.turnId, { kind: 'idle' }, 'op-root-idle');
    resumeRoot?.();
    resumeChild?.();
    await engine.whenIdle();
  });

  it('already pinned turn does not re-assemble', async () => {
    const { store } = makeTempStore();
    const spy = vi.spyOn(brief, 'assembleFirstTurnPrompt');
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run() {
        yield { type: 'sessionStarted', sessionId: 's-pin' };
        await gate;
        yield { type: 'turnCompleted' };
      },
    };
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend,
      clock: () => '2026-07-06T12:00:00.000Z',
      getHostEnvironment: () => hostSnap(),
      getTaskTypeRegistry: () => EMPTY_TASK_TYPES,
    });

    store.commit((draft) => {
      draft.tasks.t = {
        id: 't',
        role: 'worker',
        lifecycle: 'open',
        goal: 'pre-pinned',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        releaseState: 'released',
        brief: brief.synthesizeBriefFromGoal('pre-pinned'),
        revision: 0,
        createdAt: '2026-07-06T12:00:00.000Z',
        updatedAt: '2026-07-06T12:00:00.000Z',
      };
      draft.turns['turn-pre'] = {
        id: 'turn-pre',
        taskId: 't',
        sequence: 1,
        trigger: 'engine',
        status: 'queued',
        inputs: [],
        resolvedInputs: [],
        compiledPrompt: 'ALREADY_FROZEN_PROMPT',
        createdAt: '2026-07-06T12:00:00.000Z',
      };
      return { ok: true };
    });

    const engineAny = engine as unknown as { scheduleTurn: (id: string) => void };
    engineAny.scheduleTurn('turn-pre');
    await new Promise((r) => setTimeout(r, 40));

    expect(spy).not.toHaveBeenCalled();
    const turn = store.getFile().turns['turn-pre'];
    expect(turn?.compiledPrompt).toBe('ALREADY_FROZEN_PROMPT');

    if (turn?.status === 'running') {
      engine.stageDisposition('turn-pre', { kind: 'idle' }, 'op-pre');
      resume?.();
      await engine.whenIdle();
    }
  });
});
