import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from '../task/engine';
import { TaskStore } from '../task/store';
import type { MusterTask } from '../task/types';
import { createPresentationChatLink } from './presentation-chat-link';
import {
  PresentationManager,
  type PresentationDocument,
  type PresentationPanel,
  type PresentationPanelFactory,
} from './presentation-manager';

const tempDirs: string[] = [];
const capabilities: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false
};

class LoopPanel implements PresentationPanel {
  readonly updates: PresentationDocument[] = [];
  reveals = 0;
  delivery = true;
  private listeners = new Set<() => void>();
  async update(document: PresentationDocument): Promise<boolean> {
    if (!this.delivery) return false;
    this.updates.push(document);
    return true;
  }
  reveal(): void { this.reveals += 1; }
  dispose(): void { for (const listener of [...this.listeners]) listener(); }
  onDidDispose(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

class LoopFactory implements PresentationPanelFactory {
  readonly panels: LoopPanel[] = [];
  create(): PresentationPanel {
    const panel = new LoopPanel();
    this.panels.push(panel);
    return panel;
  }
}

function coordinator(overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id: 'root', role: 'coordinator', lifecycle: 'open', goal: 'revise presentation',
    parentId: null, dependencies: [], backend: 'fake', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0, turnTimeoutMs: 1_000, taskTimeoutMs: 5_000 },
    revision: 0, createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeHarness(backendFailure = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-presentation-loop-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, '.muster-tasks.json');
  const store = TaskStore.load({ filePath });
  store.commit((draft) => {
    draft.tasks.root = coordinator();
    draft.turns.initial = {
      id: 'initial', taskId: 'root', sequence: 1, trigger: 'user', status: 'failed', inputs: [],
      error: 'recoverable', createdAt: '2026-07-10T00:00:00.000Z', finishedAt: '2026-07-10T00:00:01.000Z',
    };
    return { ok: true };
  });
  const backend: Backend = {
    name: 'fake', capabilities,
    async *run(_options: RunOptions) {
      yield { type: 'sessionStarted', sessionId: 'session-root' } satisfies NormalizedEvent;
      if (backendFailure) throw new Error('backend unavailable');
      yield { type: 'turnCompleted' } satisfies NormalizedEvent;
    },
  };
  const engine = TaskEngine.load({ store, makeBackend: () => backend, clock: () => '2026-07-10T00:00:02.000Z' });
  const factory = new LoopFactory();
  const manager = new PresentationManager(factory);
  return { store, engine, factory, manager };
}

const context = { rootId: 'root', callerTaskId: 'root', turnId: 'initial' };
const document = {
  presentationId: 'plan.main', ownerTaskId: 'root', opId: 'present-1', revision: 1,
  title: 'Initial plan', markdown: '# Initial',
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('linked coordinator revision loop', () => {
  it('reveals, continues the same task, and refreshes the same panel without touching a sibling presentation', async () => {
    const { store, engine, factory, manager } = makeHarness();
    await manager.upsert(context, document);
    await manager.upsert(context, { ...document, presentationId: 'plan.second', opId: 'present-second' });
    const beforeTaskIds = Object.keys(store.getFile().tasks);
    const focusTask = vi.fn();
    const reveal = createPresentationChatLink(store, { executeCommand: vi.fn().mockResolvedValue(undefined) }, { focusTask });

    await expect(reveal('root')).resolves.toEqual({ ok: true, code: 'revealed' });
    const sent = engine.continueTaskWithMessage('root', 'Please revise the launch sequence');
    expect(sent.ok).toBe(true);
    await engine.whenIdle();
    const upsert = await manager.upsert(
      { ...context, turnId: sent.ok ? sent.value.turnId : 'unreachable' },
      { ...document, opId: 'present-2', revision: 2, title: 'Revised plan', markdown: '# Revised' },
    );

    const file = store.getFile();
    expect(upsert).toEqual({ ok: true, code: 'opened' });
    expect(Object.keys(file.tasks)).toEqual(beforeTaskIds);
    expect(Object.values(file.turns).filter((turn) => turn.taskId === 'root')).toHaveLength(2);
    expect(Object.values(file.messages)).toContainEqual(expect.objectContaining({ taskId: 'root', role: 'user', content: 'Please revise the launch sequence' }));
    expect(focusTask).toHaveBeenCalledTimes(1);
    expect(factory.panels).toHaveLength(2);
    expect(factory.panels[0].updates.map((value) => value.revision)).toEqual([1, 2]);
    expect(factory.panels[1].updates.map((value) => value.revision)).toEqual([1]);
  });

  it('keeps typed failures isolated without duplicate tasks, messages, or panels', async () => {
    const { store, engine, factory, manager } = makeHarness();
    await manager.upsert(context, document);
    const baseline = JSON.stringify(store.getFile());
    const reveal = createPresentationChatLink(store, { executeCommand: vi.fn().mockResolvedValue(undefined) }, { focusTask: vi.fn() });

    await expect(reveal('missing')).resolves.toEqual({ ok: false, code: 'not-found' });
    await expect(manager.upsert(context, { ...document, opId: 'equal', revision: 1 })).resolves.toEqual({ ok: false, code: 'stale_revision' });
    await expect(manager.upsert({ ...context, rootId: 'foreign' }, { ...document, opId: 'foreign', revision: 2 })).resolves.toEqual({ ok: true, code: 'opened' });
    await expect(manager.upsert(context, { ...document, ownerTaskId: 'other', opId: 'wrong-owner', revision: 2 })).resolves.toEqual({ ok: false, code: 'owner_mismatch' });

    store.commit((draft) => { draft.tasks.root.lifecycle = 'succeeded'; return { ok: true }; });
    expect(engine.continueTaskWithMessage('root', 'must not persist')).toEqual({ ok: false, reason: 'task is terminal' });
    expect(JSON.stringify(store.getFile())).not.toContain('must not persist');
    expect(JSON.parse(baseline).tasks.root.id).toBe(store.getFile().tasks.root.id);
    expect(factory.panels).toHaveLength(2);
  });

  it('reports failed continuation and panel delivery without duplicating durable identity', async () => {
    const { store, engine, factory, manager } = makeHarness(true);
    await manager.upsert(context, document);
    const sent = engine.continueTaskWithMessage('root', 'revision feedback');
    expect(sent.ok).toBe(true);
    await engine.whenIdle();
    expect(sent.ok && store.getFile().turns[sent.value.turnId].status).toBe('failed');

    factory.panels[0].delivery = false;
    await expect(manager.upsert({ ...context, turnId: 'delivery-turn' }, { ...document, opId: 'delivery', revision: 2 })).resolves.toEqual({ ok: false, code: 'host_delivery_failed' });
    expect(Object.keys(store.getFile().tasks)).toEqual(['root']);
    expect(factory.panels).toHaveLength(1);
    expect(factory.panels[0].updates.map((value) => value.revision)).toEqual([1]);
  });
});
