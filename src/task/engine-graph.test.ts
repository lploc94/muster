import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { deriveEntityId } from './engine-graph';
import { TaskEngine } from './engine';
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

});