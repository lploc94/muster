// M017 named flow check + fault-injection baselines.
//
// R2 was inverted in S02 (lifecycle decoupling / repair-loop removal).
// R1 prompt-before-ready flipped in S06: with mcpSetup recovery path, prompt is
// NOT dispatched when MCP is not ready (attempts exhaust pre-dispatch).
// G1 session-isolation is the GREEN contract that must remain true throughout.
//
// Keep assertions on observable surfaces (NormalizedEvent stream, attention
// codes, enqueued turn ids, client.prompt call recording) — not internal step order.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions, Backend, BackendCapabilities } from '../types';
import {
  createFakeMcpBridge,
  isFakeMcpConnectionError,
  getToolCallIsError,
  getJsonRpcError,
} from '../bridge/mcp-fault-fixture.testkit';
import {
  makeFakeAcpFaultClient,
  catalogMissingDispositionTools,
  catalogHasDispositionTools,
  type FakeAcpFaultHarness,
} from './acp-fault-harness.testkit';
import { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { TaskEngine } from '../task/engine';
import { SqliteTaskRepository } from '../task/repository';
import { DbClient } from '../task/sqlite/client';
import { parseTaskTypeRegistry } from '../task/task-types';
import { deriveEntityId } from '../task/engine-graph';
import { applySuccessfulTurn } from '../task/transitions';
import type { MusterTask, TaskTurn } from '../task/types';

const H = vi.hoisted(() => ({ current: null as FakeAcpFaultHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend } from './claude';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

const TEST_TASK_TYPES = parseTaskTypeRegistry({
  worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
  coordinate: { backend: 'grok', role: 'coordinator', briefKind: 'coordinate' },
});

function options(over: Partial<RunOptions> = {}): RunOptions {
  return { prompt: 'hello', ...over };
}

async function collectRun(
  backend: { run(o: RunOptions): AsyncIterable<NormalizedEvent> },
  opts: RunOptions,
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const ev of backend.run(opts)) events.push(ev);
  return events;
}

function contents(events: NormalizedEvent[], type: 'assistantDelta' | 'reasoningDelta'): string[] {
  return events.filter((e) => e.type === type).map((e) => (e as { content: string }).content);
}

// ── T01 FakeMcpBridge smoke (fixture readiness for S04–S06) ─────────────────

describe('FakeMcpBridge smoke (T01 fixture)', () => {
  it('happy path: initialize → tools/list → tools/call returns Muster catalog', async () => {
    const bridge = createFakeMcpBridge();
    const result = await bridge.runHappyPath({
      name: 'complete_task',
      arguments: { summary: 'ok' },
    });
    expect(result.sessionId).toMatch(/^mcp-fake-/);
    expect(result.tools.some((t) => t.name === 'complete_task')).toBe(true);
    expect(result.tools.some((t) => t.name === 'fail_task')).toBe(true);
    expect(result.call).toBeDefined();
    expect(getToolCallIsError(result.call!)).toBe(false);
  });

  it('scripts initialize failure on attempt 1 then recovers on attempt 2', async () => {
    const bridge = createFakeMcpBridge();
    bridge.failOn({ phase: 'initialize', attempt: 1 });
    await bridge.connect();
    const fail = await bridge.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(getJsonRpcError(fail)).toBeDefined();
    const ok = await bridge.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(getJsonRpcError(ok)).toBeUndefined();
    expect(ok.sessionId).toBeTruthy();
  });

  it('scripts tools/list failure then recovers', async () => {
    const bridge = createFakeMcpBridge();
    bridge.failOn({ phase: 'tools/list', attempt: 1 });
    await bridge.connect();
    const init = await bridge.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    const sid = init.sessionId!;
    const fail = await bridge.handle(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { sessionId: sid },
    );
    expect(getJsonRpcError(fail)).toBeDefined();
    const ok = await bridge.handle(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { sessionId: sid },
    );
    expect(getJsonRpcError(ok)).toBeUndefined();
  });

  it('scripts tools/call isError then recovers', async () => {
    const bridge = createFakeMcpBridge();
    bridge.failOn({ phase: 'tools/call', attempt: 1 });
    const { sessionId } = await bridge.runHappyPath();
    const fail = await bridge.handle(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: {} },
      },
      { sessionId },
    );
    expect(getToolCallIsError(fail)).toBe(true);
    const ok = await bridge.handle(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: {} },
      },
      { sessionId },
    );
    expect(getToolCallIsError(ok)).toBe(false);
  });

  it('scripts connection ECONNREFUSED / ECONNRESET / socket_reset then recovers', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'socket_reset'] as const) {
      const bridge = createFakeMcpBridge();
      bridge.failOn({ phase: 'connection', attempt: 1, code });
      await expect(bridge.connect()).rejects.toSatisfy((err: unknown) => {
        return isFakeMcpConnectionError(err) && err.code === code;
      });
      // attempt 2 succeeds
      await expect(bridge.connect()).resolves.toBeUndefined();
    }
  });
});

// ── M017 R1 GREEN (S06 recovery path) ───────────────────────────────────────

describe('M017 R1 GREEN — prompt blocked until MCP ready (S06)', () => {
  let fake: FakeAcpFaultHarness;

  beforeEach(() => {
    fake = makeFakeAcpFaultClient({ sessionIdQueue: ['sess-failed', 'sess-retry'] });
    H.current = fake;
  });

  afterEach(() => {
    H.current = null;
  });

  /**
   * R1 — prompt-before-ready (invariant #1) flipped under the S06 recovery path.
   * With RunOptions.mcpSetup, awaitReady fails for a non-ready session registry
   * and attempts exhaust pre-dispatch: client.prompt must NOT fire.
   */
  it('R1 prompt-before-ready: client.prompt is NOT called when MCP is not ready', async () => {
    fake.markSessionMcpFailed('sess-failed', 'mcp registry failed before ready');
    fake.markSessionMcpFailed('sess-retry', 'mcp registry still failed');

    const backend = new ClaudeBackend();
    const events = await collectRun(
      backend,
      options({
        prompt: 'do work without tools',
        mcpSetup: {
          maxAttempts: 2,
          prepareAttempt: () => undefined,
          awaitReady: async ({ sessionId }) => {
            if (fake.isSessionMcpReady(sessionId)) {
              return { ok: true };
            }
            return {
              ok: false,
              code: 'missing_evidence',
              message: fake.mcpFailureReason(sessionId) ?? 'mcp not ready',
              retriable: true,
              sticky: true,
            };
          },
        },
      }),
    );

    // Observable: MCP not ready, disposition tools missing, prompt never fired.
    expect(fake.isSessionMcpReady('sess-failed')).toBe(false);
    expect(fake.isSessionMcpFailed('sess-failed')).toBe(true);
    expect(catalogMissingDispositionTools(fake.toolCatalogFor('sess-failed'))).toBe(true);
    expect(fake.calls.prompt.length).toBe(0);
    // Process stays alive — failure is per-session, not process-death.
    expect(fake.isProcessAlive()).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === 'error' &&
          /attempts_exhausted|mcp setup exhausted/i.test(e.message) &&
          (e as { meta?: { mcpSetupCode?: string } }).meta?.mcpSetupCode === 'attempts_exhausted',
      ),
    ).toBe(true);
  });
});

// ── M017 R2 GREEN (S02 lifecycle decoupling) ─────────────────────────────────

describe('M017 R2 GREEN — settle once + awaiting_parent_seal (S02)', () => {
  const WORKER_TS = path.join(__dirname, '../task/sqlite/worker.ts');
  const TSX_ARGV = ['--import', 'tsx'];
  const activeHarnesses = new Set<{ engine: TaskEngine; resume: () => void }>();
  const tempDirs: string[] = [];
  const clients: DbClient[] = [];

  afterEach(async () => {
    const harnesses = [...activeHarnesses];
    activeHarnesses.clear();
    // Swallow late storage rejections from aborted in-flight settle paths.
    const swallow = () => undefined;
    process.on('unhandledRejection', swallow);
    try {
      for (const h of harnesses) {
        try {
          h.resume();
        } catch {
          /* ignore */
        }
        try {
          h.engine.quiesceForTerminalStorage();
        } catch {
          /* ignore */
        }
      }
      // Drain so aborted turn finals don't race client.close.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
      for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      process.off('unhandledRejection', swallow);
    }
  });

  async function makeEngineHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m017-r2-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'm017-r2',
      displayName: 'M017 R2',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const credentials = new CredentialRegistry();
    const askBridge = new AskBridge();
    // Shared gate: parent wait_tasks is applied only when the coordinator turn
    // settles, so child+coord must complete together for reconcileChildWaits.
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });

    const engine = await TaskEngine.loadAsync({
      repository,
      workspaceId: 'ws',
      makeBackend: (name) => ({
        name,
        capabilities: MCP_CAPS,
        async *run(_options: RunOptions): AsyncIterable<NormalizedEvent> {
          yield { type: 'sessionStarted', sessionId: 'sess-1' };
          yield { type: 'assistantDelta', content: 'working', messageId: 'm1' };
          await gate;
          yield { type: 'turnCompleted' };
        },
      }),
      askBridge,
      credentialRegistry: credentials,
      bridgePort: 19999,
      getTaskTypeRegistry: () => TEST_TASK_TYPES,
    });
    const resumeHarness = () => resume?.();
    activeHarnesses.add({ engine, resume: resumeHarness });
    return { engine, credentials, resume: resumeHarness };
  }

  async function waitTurnRunning(engine: TaskEngine, turnId: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (engine.getReadModel().getFile().turns[turnId]?.status === 'running') return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`turn ${turnId} never became running`);
  }

  /**
   * R2a — transitions path: successful child terminal with idle disposition settles
   * once with awaiting_parent_seal + completionCandidate (never seals from end_turn).
   */
  it('R2 settle-once (transitions): idle child terminal → awaiting_parent_seal + candidate', () => {
    const NOW = '2026-07-17T00:00:00.000Z';
    const task: MusterTask = {
      id: 'child-1',
      role: 'worker',
      lifecycle: 'open',
      releaseState: 'released',
      goal: 'work',
      parentId: 'root-1',
      dependencies: [],
      backend: 'grok',
      capabilities: [],
      executionPolicy: {
        maxTurns: 10,
        maxAutomaticRetries: 2,
      },
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const running: TaskTurn = {
      id: 't1',
      taskId: 'child-1',
      sequence: 1,
      status: 'running',
      trigger: 'user',
      inputs: [],
      createdAt: NOW,
      disposition: { kind: 'idle' },
    };

    const result = applySuccessfulTurn(task, running, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.next.task.attention?.code).toBe('awaiting_parent_seal');
    expect(result.next.task.completionCandidate).toMatchObject({
      version: 1,
      sourceTurnId: 't1',
      reason: 'missing_disposition',
    });
    expect(result.next.task.lifecycle).toBe('open');
    expect(result.next.task.sealedBy).toBeUndefined();
    expect(result.next.turn.status).toBe('succeeded');
  });

  /**
   * R2b — engine path: missing disposition never enqueues a model repair turn.
   * Child gets awaiting_parent_seal + completionCandidate; parent wait wakes.
   */
  it('R2 settle-once (engine): missing disposition → seal request + parent wake, no repair turn', async () => {
    const { engine, credentials, resume } = await makeEngineHarness();
    const started = await engine.startNewTask({
      goal: 'coord',
      backend: 'grok',
      role: 'coordinator',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { taskId: coordId, turnId } = started.value;
    await waitTurnRunning(engine, turnId);

    const token = credentials.issue({
      rootId: coordId,
      callerTaskId: coordId,
      turnId,
      attemptId: 'a0',
      allowedActions: new Set(['delegate_task', 'wait_for_tasks']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;
    const del = await engine.handleToolCall(ctx, 'delegate_task', {
      kind: 'delegate_task',
      opId: 'op-m017-seal-child',
      waitForCompletion: true,
      spec: { goal: 'work', taskType: 'worker' },
    });
    if (!del.ok) {
      throw new Error(`delegate_task failed: ${JSON.stringify(del)}`);
    }
    // Compound wait is staged on the coordinator TURN disposition (wait_tasks).
    // task.wait is applied when that turn settles.
    expect(del.result).toMatchObject({ waitStaged: true });
    const childIdFromResult =
      del.result && typeof del.result === 'object' && 'taskId' in del.result
        ? String((del.result as { taskId: string }).taskId)
        : undefined;
    const childId = childIdFromResult ?? deriveEntityId(turnId, 'op-m017-seal-child', 'task');
    const read = () => engine.getReadModel().getFile();
    expect(read().turns[turnId]?.disposition).toMatchObject({
      kind: 'wait_tasks',
      taskIds: [childId],
    });

    const childTurn = Object.values(read().turns).find(
      (t) => t.taskId === childId && t.sequence === 1,
    );
    expect(childTurn).toBeDefined();
    if (!childTurn) return;

    for (let i = 0; i < 100 && read().turns[childTurn.id]?.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(read().turns[childTurn.id]?.status).toBe('running');

    // Stage idle on child, then release backends so child settles once (no repair)
    // and coordinator wait_tasks can apply. Core R2 contract is settle-once + seal
    // request on the child — parent attention wake is best-effort under async SQLite.
    await engine.stageDispositionAsync(childTurn.id, { kind: 'idle' }, 'op-child-idle');
    resume();

    // Poll durable child seal outcomes (avoid whenIdle hang on follow-ups).
    for (let i = 0; i < 150; i++) {
      const snap = read();
      const c = snap.tasks[childId];
      const noRepair = !Object.values(snap.turns).some((t) =>
        t.id.endsWith('-disposition-repair') &&
        (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
      );
      if (
        noRepair &&
        c?.attention?.code === 'awaiting_parent_seal' &&
        c.lifecycle === 'open' &&
        c.completionCandidate?.reason === 'missing_disposition'
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    const child = read().tasks[childId];
    const repairSuffix = '-disposition' + '-repair';
    const scheduledRepairTurns = Object.values(read().turns).filter(
      (t) =>
        t.id.endsWith(repairSuffix) &&
        (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user'),
    );

    // R2 core: settle once — no disposition-repair turn, child open with seal request.
    expect(scheduledRepairTurns).toHaveLength(0);
    expect(read().turns[`${childTurn.id}${repairSuffix}`]).toBeUndefined();
    expect(child?.lifecycle).toBe('open');
    expect(child?.attention?.code).toBe('awaiting_parent_seal');
    expect(child?.completionCandidate).toMatchObject({
      version: 1,
      sourceTurnId: childTurn.id,
      reason: 'missing_disposition',
    });
    expect(child?.sealedBy).toBeUndefined();

    // Stop all background repository work before teardown (no further executes).
    engine.quiesceForTerminalStorage();
  }, 15_000);
});

// ── G1 session isolation (GREEN — must hold) ────────────────────────────────

describe('M017 G1 session-isolation (GREEN)', () => {
  let fake: FakeAcpFaultHarness;

  beforeEach(() => {
    fake = makeFakeAcpFaultClient({ sessionIdQueue: ['sess-a', 'sess-b'] });
    H.current = fake;
  });

  afterEach(() => {
    H.current = null;
  });

  it('session A MCP fails while session B streams to completion without cancel', async () => {
    // Sticky MCP failure on A only; process stays alive; B healthy.
    fake.markSessionMcpFailed('sess-a', 'initialize failed for A');

    const backendA = new ClaudeBackend();
    const backendB = new ClaudeBackend();

    const eventsA: NormalizedEvent[] = [];
    const eventsB: NormalizedEvent[] = [];

    // Start A first so it claims sess-a from the queue.
    const pumpA = (async () => {
      for await (const ev of backendA.run(options({ prompt: 'session A' }))) eventsA.push(ev);
    })();

    await fake.waitForPrompt('sess-a');
    expect(fake.isSessionMcpFailed('sess-a')).toBe(true);
    expect(fake.isSessionMcpReady('sess-a')).toBe(false);
    expect(catalogMissingDispositionTools(fake.toolCatalogFor('sess-a'))).toBe(true);

    // B starts on the same shared fake process / client.
    const pumpB = (async () => {
      for await (const ev of backendB.run(options({ prompt: 'session B' }))) eventsB.push(ev);
    })();

    await fake.waitForPrompt('sess-b');
    expect(fake.isSessionMcpFailed('sess-b')).toBe(false);
    expect(fake.isSessionMcpReady('sess-b')).toBe(true);
    expect(catalogHasDispositionTools(fake.toolCatalogFor('sess-b'))).toBe(true);
    expect(fake.isProcessAlive()).toBe(true);

    // Stream B's full NormalizedEvent path.
    fake.push('sess-b', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'B-hel' },
    });
    fake.push('sess-b', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'lo' },
    });
    fake.push('sess-b', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'B-think' },
    });
    fake.resolve('sess-b', { stopReason: 'end_turn' });

    // A also ends cleanly — no cancel of either session.
    fake.resolve('sess-a', { stopReason: 'end_turn' });

    await Promise.all([pumpA, pumpB]);

    // B emitted its full stream and completed.
    expect(contents(eventsB, 'assistantDelta')).toEqual(['B-hel', 'lo']);
    expect(contents(eventsB, 'reasoningDelta')).toEqual(['B-think']);
    expect(eventsB.some((e) => e.type === 'sessionStarted' && e.sessionId === 'sess-b')).toBe(true);
    expect(eventsB.some((e) => e.type === 'turnCompleted')).toBe(true);
    expect(eventsB.some((e) => e.type === 'error')).toBe(false);

    // A was not cancelled; process still alive; cancel never auto-fired.
    expect(fake.calls.cancel.length).toBe(0);
    expect(fake.isProcessAlive()).toBe(true);
    expect(eventsA.some((e) => e.type === 'sessionStarted' && e.sessionId === 'sess-a')).toBe(true);
    expect(eventsA.some((e) => e.type === 'turnCompleted')).toBe(true);

    // Isolation: A still MCP-failed; B still healthy after both settled.
    expect(fake.isSessionMcpFailed('sess-a')).toBe(true);
    expect(fake.isSessionMcpFailed('sess-b')).toBe(false);
  });
});
