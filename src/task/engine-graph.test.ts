import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { deriveEntityId, issueTurnCredential, type GraphEngineDeps } from './engine-graph';
import { TaskEngine } from './engine';
import { DEFAULT_EXECUTION_POLICY_BOUNDS, MAX_BRIDGE_TOKEN_TTL_MS } from './limits';
import { TaskStore } from './store';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
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
      capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
    });
    const started = engine.startTask('coord');
    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
      turnId: started.value!.turnId,
      allowedActions: new Set([
        'create_task',
        'delegate_task',
        'start_task',
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
    // TTL is pinned to the independent cap, not the absurd turn timeout.
    expect(remainingMs).toBeGreaterThan(MAX_BRIDGE_TOKEN_TTL_MS - 1_000);
    expect(remainingMs).toBeLessThanOrEqual(MAX_BRIDGE_TOKEN_TTL_MS + 1_000);
  });
});