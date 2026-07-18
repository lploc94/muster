// M017-S06 / D037: Pre-dispatch ACP session recovery via TaskEngine mcpSetup.
//
// Proves: multi-attempt prepare/awaitReady recovery, at-most-once prompt on
// recovery, exhausted setup → safe_to_retry + mcp_unavailable + no auto-retry,
// concurrent session isolation on the shared fake ACP process.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '../types';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { McpReadinessSupervisor } from '../bridge/mcp-readiness';
import { TaskEngine } from '../task/engine';
import { TaskStore } from '../task/store';
import { capabilitiesFor } from '../task/capabilities';
import {
  makeFakeAcpFaultClient,
  type FakeAcpFaultHarness,
} from './acp-fault-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpFaultHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend } from './claude';

const tempDirs: string[] = [];

function makeTempStore(): { dir: string; filePath: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m017-s06-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, '.muster-tasks.json');
  return { dir, filePath, store: TaskStore.load({ filePath }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedToolNamesForRoot(): string[] {
  // TaskEngine.createTask defaults role=coordinator and grants the default
  // capability set when callers omit capabilities.
  return [
    ...capabilitiesFor({
      role: 'coordinator',
      capabilities: [
        'create_child',
        'wait_child',
        'read_subtree',
        'cancel_child',
        'interrupt_child',
      ],
      parentId: null,
    }),
  ].sort();
}

describe('Pre-dispatch ACP session recovery (M017-S06 / D037)', () => {
  let fake: FakeAcpFaultHarness;
  const activeHarnesses = new Set<{ engine: TaskEngine; resume?: () => void }>();

  beforeEach(() => {
    fake = makeFakeAcpFaultClient({
      sessionIdQueue: ['sess-a1', 'sess-a2', 'sess-b1'],
    });
    H.current = fake;
  });

  afterEach(async () => {
    H.current = null;
    const harnesses = [...activeHarnesses];
    activeHarnesses.clear();
    for (const h of harnesses) h.resume?.();
    await Promise.all(harnesses.map(({ engine }) => engine.whenIdle()));
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeEngine(opts: {
    mcpReadiness: McpReadinessSupervisor;
    credentials: CredentialRegistry;
    store: TaskStore;
  }): TaskEngine {
    const engine = TaskEngine.load({
      store: opts.store,
      makeBackend: () => new ClaudeBackend(),
      runTurn: (backend, options) => backend.run(options),
      credentialRegistry: opts.credentials,
      bridgePort: 9,
      mcpReadiness: opts.mcpReadiness,
      getBridgeGeneration: () => 1,
      askBridge: new AskBridge(),
      // Real wall clock so run/setup deadlines advance with awaitReady polls.
      clock: () => new Date().toISOString(),
    });
    activeHarnesses.add({ engine });
    return engine;
  }

  function releaseAndStart(
    engine: TaskEngine,
    store: TaskStore,
    taskId: string,
    policy?: { maxAutomaticRetries?: number; turnTimeoutMs?: number },
  ): void {
    const created = engine.createTask({
      id: taskId,
      goal: 'recover mcp setup',
      backend: 'claude',
      executionPolicy: {
        maxTurns: 4,
        maxAutomaticRetries: policy?.maxAutomaticRetries ?? 2,
        turnTimeoutMs: policy?.turnTimeoutMs ?? 3_000,
        taskTimeoutMs: 30_000,
      },
    });
    expect(created.ok).toBe(true);
    store.commit((draft) => {
      draft.tasks[taskId] = {
        ...draft.tasks[taskId]!,
        releaseState: 'released',
      };
      return { ok: true };
    });
    expect(engine.send(taskId, 'start recovery').ok).toBe(true);
  }

  it(
    'first-attempt missing_evidence recovers on attempt 2 and prompts exactly once',
    async () => {
    const { store } = makeTempStore();
    const credentials = new CredentialRegistry();
    const mcpReadiness = new McpReadinessSupervisor();
    mcpReadiness.noteBridgeGeneration(1);
    const engine = makeEngine({ mcpReadiness, credentials, store });

    // Inject list_tools evidence only after the second session is opened (attempt 2).
    const injector = setInterval(() => {
      if (fake.calls.newSession.length < 2) return;
      const snap = mcpReadiness.getDebugSnapshot();
      for (const [turnId, turnSnap] of Object.entries(snap.turns)) {
        const attemptId = turnSnap.liveAttemptId;
        if (!attemptId) continue;
        mcpReadiness.recordObservation({
          phase: 'list_tools',
          toolNames: expectedToolNamesForRoot(),
          credentialId: 'inj',
          turnId,
          attemptId,
          generation: 1,
          timestamp: Date.now(),
        });
      }
    }, 15);

    try {
      releaseAndStart(engine, store, 'recover-once', {
        maxAutomaticRetries: 2,
        turnTimeoutMs: 12_000,
      });

      // Wait until prompt is dispatched on the recovered session.
      await fake.waitForPrompt('sess-a2');
      expect(fake.calls.prompt.length).toBe(1);
      expect(fake.calls.prompt[0]?.[0]).toBe('sess-a2');
      expect(fake.calls.newSession.length).toBeGreaterThanOrEqual(2);
      expect(fake.isProcessAlive()).toBe(true);

      fake.resolve('sess-a2', { stopReason: 'end_turn' });
      await engine.whenIdle();

      const turns = Object.values(store.getFile().turns).filter((t) => t.taskId === 'recover-once');
      const primary = turns.find((t) => !t.id.includes('auto-retry'));
      expect(primary).toBeDefined();
      // Recovered path should have reached prompt_outstanding / terminal.
      expect(
        primary!.dispatchPhase === 'prompt_outstanding' ||
          primary!.status === 'completed' ||
          primary!.status === 'failed',
      ).toBe(true);
      // No generic auto-retry for a successful recovered dispatch.
      expect(turns.some((t) => t.id.includes('auto-retry'))).toBe(false);
    } finally {
      clearInterval(injector);
    }
  },
    15_000,
  );

  it('two-attempt setup exhaustion settles safe_to_retry with mcp_unavailable and no auto-retry', async () => {
    const { store } = makeTempStore();
    const credentials = new CredentialRegistry();
    const mcpReadiness = new McpReadinessSupervisor();
    mcpReadiness.noteBridgeGeneration(1);
    // Never inject list_tools evidence — both attempts fail missing_evidence.
    const engine = makeEngine({
      mcpReadiness,
      credentials,
      store,
    });

    releaseAndStart(engine, store, 'exhaust-setup', {
      maxAutomaticRetries: 2,
      turnTimeoutMs: 1_500,
    });

    await engine.whenIdle();
    // Allow settle + attention commit to land.
    await sleep(50);
    await engine.whenIdle();

    const file = store.getFile();
    const task = file.tasks['exhaust-setup'];
    expect(task).toBeDefined();
    expect(task!.attention?.code).toBe('mcp_unavailable');
    expect(task!.lifecycle).toBe('open');

    const turns = Object.values(file.turns).filter((t) => t.taskId === 'exhaust-setup');
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(turn.dispatchPhase).not.toBe('prompt_outstanding');
    }
    const failed = turns.find((t) => t.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.failureClass).toBe('safe_to_retry');
    expect(failed!.error ?? '').toMatch(/attempts_exhausted|mcp setup exhausted/i);
    // Generic automatic model retry must NOT be enqueued for setup exhaustion.
    expect(turns.some((t) => t.id.includes('auto-retry'))).toBe(false);
    expect(fake.calls.prompt.length).toBe(0);
    expect(fake.isProcessAlive()).toBe(true);

    const snap = mcpReadiness.getDebugSnapshot();
    const turnIds = Object.keys(snap.turns);
    expect(turnIds.length).toBeGreaterThan(0);
  });

  it('concurrent session B keeps streaming while session A setup recovers/fails', async () => {
    const fakeShared = makeFakeAcpFaultClient({
      sessionIdQueue: ['sess-a1', 'sess-a2', 'sess-b'],
    });
    H.current = fakeShared;

    const backendA = new ClaudeBackend();
    const backendB = new ClaudeBackend();

    // A: both attempts fail readiness — no prompt.
    const pumpA = (async () => {
      const events: NormalizedEvent[] = [];
      for await (const ev of backendA.run({
        prompt: 'A setup fail',
        mcpSetup: {
          maxAttempts: 2,
          prepareAttempt: () => undefined,
          awaitReady: async () => ({
            ok: false,
            code: 'missing_evidence',
            message: 'A not ready',
            retriable: true,
          }),
        },
      })) {
        events.push(ev);
      }
      return events;
    })();

    // Give A a head start into setup.
    await sleep(20);

    // B: no mcpSetup — streams normally on same process.
    const pumpB = (async () => {
      const events: NormalizedEvent[] = [];
      for await (const ev of backendB.run({ prompt: 'B streams' })) {
        events.push(ev);
      }
      return events;
    })();

    await fakeShared.waitForPrompt('sess-b');
    expect(fakeShared.calls.prompt.some((args) => args[0] === 'sess-b')).toBe(true);
    expect(fakeShared.isProcessAlive()).toBe(true);

    // Stream content on B while A is still recovering/failing.
    await fakeShared.waitForSessionSink('sess-b');
    fakeShared.push('sess-b', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'B-alive' },
    });
    fakeShared.resolve('sess-b', { stopReason: 'end_turn' });

    const [eventsA, eventsB] = await Promise.all([pumpA, pumpB]);
    expect(fakeShared.calls.prompt.filter((args) => args[0] === 'sess-b').length).toBe(1);
    // A must not have prompted.
    expect(
      fakeShared.calls.prompt.every((args) => args[0] !== 'sess-a1' && args[0] !== 'sess-a2'),
    ).toBe(true);
    expect(
      eventsA.some(
        (e) => e.type === 'error' && /attempts_exhausted|mcp setup exhausted/i.test(e.message),
      ),
    ).toBe(true);
    expect(eventsB.some((e) => e.type === 'sessionStarted' && e.sessionId === 'sess-b')).toBe(true);
    expect(fakeShared.isProcessAlive()).toBe(true);
  });
});
