import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TaskHandoff,
  type CreateTaskHandoffInput,
  type TaskHandoffDiagnostics,
} from './task-handoff';
import { TaskStore } from './store';
import type { MusterTask, TaskHandoffState } from './types';

const NOW = '2026-07-14T12:00:00.000Z';
const LATER = '2026-07-14T12:00:05.000Z';
const FINISH = '2026-07-14T12:00:10.000Z';

function baseInput(overrides: Partial<CreateTaskHandoffInput> = {}): CreateTaskHandoffInput {
  return {
    operationId: 'hop-op-1',
    source: { backend: 'claude-cli', model: 'sonnet', sessionId: 'src-sess' },
    target: { backend: 'codex', model: 'gpt-5' },
    now: NOW,
    ...overrides,
  };
}

/** Advance a handoff to transferring with ready context and skipped summary. */
function advanceToTransferring(handoff: TaskHandoff): TaskHandoff {
  let h = handoff;
  const start = h.startExport({ now: LATER });
  expect(start.ok).toBe(true);
  if (!start.ok) throw new Error(start.reason);
  h = start.next;

  const ctx = h.markConversationReady({
    messageCount: 3,
    contentDigest: 'digest-abc',
    exportedAt: LATER,
    now: LATER,
  });
  expect(ctx.ok).toBe(true);
  if (!ctx.ok) throw new Error(ctx.reason);
  h = ctx.next;

  const skip = h.skipSummary({ reason: 'not requested', now: LATER });
  expect(skip.ok).toBe(true);
  if (!skip.ok) throw new Error(skip.reason);
  h = skip.next;

  const prep = h.beginPreparingReceiver({ now: LATER });
  expect(prep.ok).toBe(true);
  if (!prep.ok) throw new Error(prep.reason);
  h = prep.next;

  const xfer = h.beginTransfer({ now: LATER });
  expect(xfer.ok).toBe(true);
  if (!xfer.ok) throw new Error(xfer.reason);
  return xfer.next;
}

describe('TaskHandoff.create', () => {
  it('creates a requested handoff with pending conversation context and no summary', () => {
    const handoff = TaskHandoff.create(baseInput());
    const state = handoff.toState();

    expect(state.version).toBe(1);
    expect(state.operationId).toBe('hop-op-1');
    expect(state.phase).toBe('requested');
    expect(state.source).toEqual({
      backend: 'claude-cli',
      model: 'sonnet',
      sessionId: 'src-sess',
    });
    expect(state.target).toEqual({ backend: 'codex', model: 'gpt-5' });
    expect(state.conversationContext).toEqual({ status: 'pending' });
    expect(state.sourceSummary).toBeUndefined();
    expect(state.createdAt).toBe(NOW);
    expect(state.updatedAt).toBe(NOW);
    expect(state.startedAt).toBeUndefined();
    expect(state.finishedAt).toBeUndefined();
    expect(state.completion).toBeUndefined();
    expect(state.failure).toBeUndefined();
  });
});

describe('TaskHandoff phase transitions', () => {
  it('advances through export → context ready → skip summary → prepare → transfer → complete', () => {
    let h = TaskHandoff.create(baseInput());
    h = advanceToTransferring(h);

    const done = h.complete({
      boundBackend: 'codex',
      boundSessionId: 'tgt-sess',
      now: FINISH,
    });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error(done.reason);

    const state = done.next.toState();
    expect(state.phase).toBe('completed');
    expect(state.finishedAt).toBe(FINISH);
    expect(state.completion).toEqual({
      completedAt: FINISH,
      boundBackend: 'codex',
      boundSessionId: 'tgt-sess',
    });
    expect(state.conversationContext).toEqual({
      status: 'ready',
      messageCount: 3,
      contentDigest: 'digest-abc',
      exportedAt: LATER,
    });
    expect(state.sourceSummary).toEqual({
      status: 'skipped',
      reason: 'not requested',
    });
  });

  it('supports summary-unavailable fallback and still reaches receiver-ready completion', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    const ctx = h.markConversationReady({
      messageCount: 1,
      contentDigest: 'd1',
      exportedAt: LATER,
      now: LATER,
    });
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) throw new Error(ctx.reason);
    h = ctx.next;

    const sumStart = h.beginSummarizing({ now: LATER });
    expect(sumStart.ok).toBe(true);
    if (!sumStart.ok) throw new Error(sumStart.reason);
    h = sumStart.next;
    expect(h.phase).toBe('summarizing_source');
    expect(h.toState().sourceSummary).toEqual({ status: 'pending' });

    const unavailable = h.markSummaryUnavailable({
      reason: 'source refused summary',
      now: LATER,
    });
    expect(unavailable.ok).toBe(true);
    if (!unavailable.ok) throw new Error(unavailable.reason);
    h = unavailable.next;
    expect(h.toState().sourceSummary).toEqual({
      status: 'unavailable',
      reason: 'source refused summary',
    });

    // Fallback: proceed without summary body.
    const prep = h.beginPreparingReceiver({ now: LATER });
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error(prep.reason);
    h = prep.next;

    const xfer = h.beginTransfer({ now: LATER });
    expect(xfer.ok).toBe(true);
    if (!xfer.ok) throw new Error(xfer.reason);
    h = xfer.next;

    const done = h.complete({ boundBackend: 'codex', now: FINISH });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error(done.reason);
    expect(done.next.phase).toBe('completed');
    expect(done.next.toState().sourceSummary?.status).toBe('unavailable');
  });

  it('rejects illegal phase jumps without mutating state', () => {
    const h = TaskHandoff.create(baseInput());
    const before = h.toState();

    const jump = h.beginTransfer({ now: LATER });
    expect(jump).toEqual({ ok: false, reason: 'illegal phase transition' });
    expect(h.toState()).toEqual(before);

    const complete = h.complete({ boundBackend: 'codex', now: LATER });
    expect(complete.ok).toBe(false);
    expect(h.toState()).toEqual(before);
  });

  it('rejects beginPreparingReceiver while source summary is still pending', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    const ctx = h.markConversationReady({
      messageCount: 1,
      contentDigest: 'd',
      exportedAt: LATER,
      now: LATER,
    });
    if (!ctx.ok) throw new Error(ctx.reason);
    h = ctx.next;

    const sum = h.beginSummarizing({ now: LATER });
    if (!sum.ok) throw new Error(sum.reason);
    h = sum.next;

    const before = h.toState();
    const prep = h.beginPreparingReceiver({ now: LATER });
    expect(prep).toEqual({
      ok: false,
      reason: 'source summary still pending',
    });
    expect(h.toState()).toEqual(before);
  });

  it('rejects complete when conversation context is not ready', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    // Force-walk phases by marking context unavailable and skipping summary is not enough —
    // complete requires ready context even if phase were transferring.
    const before = h.toState();
    const done = h.complete({ boundBackend: 'codex', now: FINISH });
    expect(done.ok).toBe(false);
    expect(h.toState()).toEqual(before);
  });
});

describe('stale operation rejection', () => {
  it('rejects transitions with a mismatched operationId and does not mutate', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;
    const before = h.toState();

    const stale = h.markConversationReady({
      messageCount: 1,
      contentDigest: 'd',
      exportedAt: LATER,
      now: LATER,
      operationId: 'other-op',
    });
    expect(stale).toEqual({ ok: false, reason: 'stale operation' });
    expect(h.toState()).toEqual(before);
  });

  it('accepts matching operationId on transitions', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER, operationId: 'hop-op-1' });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error(start.reason);
    expect(start.next.phase).toBe('exporting_context');
  });
});

describe('terminal behavior', () => {
  it('fails closed from an active phase with sanitized failure diagnostics', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    const failed = h.fail({
      code: 'export_error',
      message: 'could not read C:\\Users\\hiep\\secret\\file with sk-abcde12345token body',
      now: FINISH,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error(failed.reason);

    const state = failed.next.toState();
    expect(state.phase).toBe('failed');
    expect(state.finishedAt).toBe(FINISH);
    expect(state.failure?.code).toBe('export_error');
    expect(state.failure?.at).toBe(FINISH);
    expect(state.failure?.message).not.toMatch(/C:\\Users/);
    expect(state.failure?.message).not.toMatch(/sk-abcde/);
    expect(state.failure?.message.length).toBeLessThanOrEqual(240);
  });

  it('cancels from an active phase', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    const cancelled = h.cancel({
      code: 'user_cancel',
      message: 'user cancelled',
      now: FINISH,
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error(cancelled.reason);
    expect(cancelled.next.phase).toBe('cancelled');
    expect(cancelled.next.toState().failure?.code).toBe('user_cancel');
  });

  it('is idempotent for matching terminal complete calls', () => {
    let h = advanceToTransferring(TaskHandoff.create(baseInput()));
    const first = h.complete({
      boundBackend: 'codex',
      boundSessionId: 's1',
      now: FINISH,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    h = first.next;
    const snapshot = h.toState();

    const second = h.complete({
      boundBackend: 'codex',
      boundSessionId: 's1',
      now: '2026-07-14T12:00:99.000Z',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    // No mutation on idempotent terminal replay.
    expect(second.next.toState()).toEqual(snapshot);
  });

  it('rejects complete with different completion metadata after terminal', () => {
    let h = advanceToTransferring(TaskHandoff.create(baseInput()));
    const first = h.complete({ boundBackend: 'codex', boundSessionId: 's1', now: FINISH });
    if (!first.ok) throw new Error(first.reason);
    h = first.next;
    const before = h.toState();

    const conflict = h.complete({ boundBackend: 'other', now: FINISH });
    expect(conflict).toEqual({
      ok: false,
      reason: 'terminal completion conflict',
    });
    expect(h.toState()).toEqual(before);
  });

  it('rejects non-terminal transitions after completion/failure', () => {
    let h = advanceToTransferring(TaskHandoff.create(baseInput()));
    const done = h.complete({ boundBackend: 'codex', now: FINISH });
    if (!done.ok) throw new Error(done.reason);
    h = done.next;
    const before = h.toState();

    expect(h.startExport({ now: LATER })).toEqual({
      ok: false,
      reason: 'handoff is terminal',
    });
    expect(h.fail({ code: 'x', message: 'y', now: LATER })).toEqual({
      ok: false,
      reason: 'handoff is terminal',
    });
    expect(h.toState()).toEqual(before);
  });

  it('is idempotent for matching fail and rejects conflicting fail', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    const first = h.fail({ code: 'e1', message: 'boom', now: FINISH });
    if (!first.ok) throw new Error(first.reason);
    h = first.next;
    const snapshot = h.toState();

    const again = h.fail({ code: 'e1', message: 'boom', now: LATER });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.reason);
    expect(again.next.toState()).toEqual(snapshot);

    const conflict = h.fail({ code: 'e2', message: 'other', now: LATER });
    expect(conflict).toEqual({ ok: false, reason: 'terminal failure conflict' });
    expect(h.toState()).toEqual(snapshot);
  });
});

describe('serialization and restore', () => {
  it('round-trips through toState / restore without losing metadata', () => {
    let h = advanceToTransferring(TaskHandoff.create(baseInput()));
    const done = h.complete({
      boundBackend: 'codex',
      boundSessionId: 'tgt',
      now: FINISH,
    });
    if (!done.ok) throw new Error(done.reason);

    const serialized = done.next.toState();
    const restored = TaskHandoff.restore(serialized);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored.next.toState()).toEqual(serialized);
  });

  it('restores in-progress handoff and continues legal transitions', () => {
    let h = TaskHandoff.create(baseInput());
    const start = h.startExport({ now: LATER });
    if (!start.ok) throw new Error(start.reason);
    h = start.next;

    const ctx = h.markConversationReady({
      messageCount: 2,
      contentDigest: 'mid',
      exportedAt: LATER,
      now: LATER,
    });
    if (!ctx.ok) throw new Error(ctx.reason);

    const restored = TaskHandoff.restore(ctx.next.toState());
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);

    const skip = restored.next.skipSummary({ reason: 'reload skip', now: LATER });
    expect(skip.ok).toBe(true);
    if (!skip.ok) throw new Error(skip.reason);
    expect(skip.next.toState().sourceSummary?.status).toBe('skipped');
  });

  it('fails closed on malformed restore input', () => {
    const bad = {
      version: 1,
      operationId: 'x',
      phase: 'not-a-phase',
    };
    const restored = TaskHandoff.restore(bad);
    expect(restored.ok).toBe(false);
    if (restored.ok) throw new Error('expected fail');
    expect(restored.reason).toMatch(/invalid|malformed/i);
  });

  it('restore accepts a sanitized TaskHandoffState snapshot', () => {
    const state: TaskHandoffState = {
      version: 1,
      operationId: 'op-restore',
      phase: 'requested',
      source: { backend: 'a' },
      target: { backend: 'b' },
      conversationContext: { status: 'pending' },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const restored = TaskHandoff.restore(state);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored.next.operationId).toBe('op-restore');
  });
});

describe('diagnostics (no conversation leakage)', () => {
  it('exposes sanitized phase/backends/operation/timestamps only', () => {
    let h = advanceToTransferring(TaskHandoff.create(baseInput()));
    const done = h.complete({ boundBackend: 'codex', boundSessionId: 's', now: FINISH });
    if (!done.ok) throw new Error(done.reason);

    const diag: TaskHandoffDiagnostics = done.next.toDiagnostics();
    expect(diag).toEqual({
      operationId: 'hop-op-1',
      phase: 'completed',
      sourceBackend: 'claude-cli',
      targetBackend: 'codex',
      createdAt: NOW,
      updatedAt: FINISH,
      startedAt: LATER,
      finishedAt: FINISH,
      conversationStatus: 'ready',
      sourceSummaryStatus: 'skipped',
      hasCompletion: true,
      hasFailure: false,
    });

    // Never includes digests of conversation bodies as free-form text fields beyond status.
    expect(JSON.stringify(diag)).not.toMatch(/digest-abc/);
    expect(JSON.stringify(diag)).not.toMatch(/session/);
  });
});

describe('handoff prompts never become chat fields', () => {
  it('serialized state has no message/prompt/content body fields', () => {
    let h = advanceToTransferring(TaskHandoff.create(baseInput()));
    const done = h.complete({ boundBackend: 'codex', now: FINISH });
    if (!done.ok) throw new Error(done.reason);
    const state = done.next.toState() as Record<string, unknown>;

    const forbidden = ['content', 'prompt', 'messages', 'transcript', 'summaryText', 'rawOutput'];
    const json = JSON.stringify(state);
    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(state, key)).toBe(false);
      // nested objects also must not use these free-form body keys as top-level-ish dumps
      expect(json).not.toMatch(new RegExp(`"${key}"\\s*:\\s*"`));
    }
  });
});


// ---------------------------------------------------------------------------
// T03: transcript isolation + reload safety (store projection boundary)
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempStore(): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-handoff-isol-'));
  tempDirs.push(dir);
  return { dir, filePath: path.join(dir, '.muster-tasks.json') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleTask(id: string, handoff?: TaskHandoffState): MusterTask {
  return {
    id,
    role: 'coordinator',
    lifecycle: 'open',
    goal: 'handoff isolation',
    parentId: null,
    dependencies: [],
    backend: 'claude-cli',
    capabilities: [],
    executionPolicy: {
      maxTurns: 10,
      maxAutomaticRetries: 1,
      turnTimeoutMs: 1_000,
      taskTimeoutMs: 5_000,
    },
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...(handoff ? { handoff } : {}),
  };
}

describe('transcript isolation and reload safety', () => {
  it('persists in-progress and completed handoff without creating TaskMessage rows', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });

    // In-progress handoff with digests only — never chat bodies.
    let h = TaskHandoff.create(baseInput({ operationId: 'hop-progress' }));
    const start = h.startExport({ now: LATER });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error(start.reason);
    h = start.next;
    const ready = h.markConversationReady({
      messageCount: 2,
      contentDigest: 'progress-digest',
      exportedAt: LATER,
      now: LATER,
    });
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error(ready.reason);
    const inProgress = ready.next.toState();

    const first = store.commit((draft) => {
      draft.tasks['task-progress'] = sampleTask('task-progress', inProgress);
      // Existing visible chat remains independent of handoff.
      draft.messages['m-user'] = {
        id: 'm-user',
        taskId: 'task-progress',
        role: 'user',
        content: 'visible user turn',
        state: 'complete',
        createdAt: NOW,
      };
      return { ok: true };
    });
    expect(first.ok).toBe(true);

    // Completed handoff on a second task.
    let completed = advanceToTransferring(
      TaskHandoff.create(baseInput({ operationId: 'hop-done' })),
    );
    const done = completed.complete({
      boundBackend: 'codex',
      boundSessionId: 'tgt',
      now: FINISH,
    });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error(done.reason);

    const second = store.commit((draft) => {
      draft.tasks['task-done'] = sampleTask('task-done', done.next.toState());
      return { ok: true };
    });
    expect(second.ok).toBe(true);

    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getTask('task-progress')?.handoff?.phase).toBe('exporting_context');
    expect(reloaded.getTask('task-progress')?.handoff?.conversationContext).toEqual({
      status: 'ready',
      messageCount: 2,
      contentDigest: 'progress-digest',
      exportedAt: LATER,
    });
    expect(reloaded.getTask('task-done')?.handoff?.phase).toBe('completed');
    expect(reloaded.getTask('task-done')?.handoff?.completion?.boundBackend).toBe('codex');

    // Handoff must never materialize as TaskMessage rows.
    const progressMessages = reloaded.getMessagesForTask('task-progress');
    expect(progressMessages.map((m) => m.id)).toEqual(['m-user']);
    expect(progressMessages.every((m) => !m.content.includes('progress-digest'))).toBe(true);

    const doneMessages = reloaded.getMessagesForTask('task-done');
    expect(doneMessages).toEqual([]);

    // Aggregate restore from reloaded store continues legal transitions.
    const restored = TaskHandoff.restore(reloaded.getTask('task-progress')!.handoff!);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    const skip = restored.next.skipSummary({ reason: 'after reload', now: FINISH });
    expect(skip.ok).toBe(true);
  });

  it('legacy tasks without handoff remain loadable and message-stable after sibling handoff commits', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });

    const seed = store.commit((draft) => {
      draft.tasks['legacy'] = sampleTask('legacy');
      draft.messages['legacy-u'] = {
        id: 'legacy-u',
        taskId: 'legacy',
        role: 'user',
        content: 'legacy chat only',
        state: 'complete',
        createdAt: NOW,
      };
      return { ok: true };
    });
    expect(seed.ok).toBe(true);

    const handoff = TaskHandoff.create(baseInput({ operationId: 'hop-sib' })).toState();
    const sibling = store.commit((draft) => {
      draft.tasks['with-handoff'] = sampleTask('with-handoff', handoff);
      return { ok: true };
    });
    expect(sibling.ok).toBe(true);

    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getTask('legacy')?.handoff).toBeUndefined();
    expect(reloaded.getMessagesForTask('legacy')).toEqual([
      expect.objectContaining({ id: 'legacy-u', content: 'legacy chat only' }),
    ]);
    expect(reloaded.getMessagesForTask('with-handoff')).toEqual([]);
    expect(reloaded.getTask('with-handoff')?.handoff?.operationId).toBe('hop-sib');
  });

  it('reload preserves completed handoff without injecting transcript messages', () => {
    const { filePath } = makeTempStore();
    let h = advanceToTransferring(TaskHandoff.create(baseInput({ operationId: 'hop-reload' })));
    const done = h.complete({ boundBackend: 'codex', now: FINISH });
    if (!done.ok) throw new Error(done.reason);

    const store = TaskStore.load({ filePath });
    const commit = store.commit((draft) => {
      draft.tasks['task-1'] = sampleTask('task-1', done.next.toState());
      draft.messages['chat-u'] = {
        id: 'chat-u',
        taskId: 'task-1',
        role: 'user',
        content: 'pre-existing chat',
        state: 'complete',
        createdAt: NOW,
      };
      draft.messages['chat-a'] = {
        id: 'chat-a',
        taskId: 'task-1',
        role: 'assistant',
        content: 'pre-existing answer',
        state: 'complete',
        createdAt: LATER,
      };
      return { ok: true };
    });
    expect(commit.ok).toBe(true);

    const reloaded = TaskStore.load({ filePath });
    const task = reloaded.getTask('task-1');
    expect(task?.handoff?.phase).toBe('completed');
    expect(task?.handoff?.conversationContext).toMatchObject({
      status: 'ready',
      contentDigest: 'digest-abc',
    });

    const messages = reloaded.getMessagesForTask('task-1');
    expect(messages.map((m) => m.id).sort()).toEqual(['chat-a', 'chat-u']);
    const bodies = messages.map((m) => m.content).join('\n');
    expect(bodies).not.toContain('digest-abc');
    expect(bodies).not.toContain('hop-reload');
    expect(bodies).not.toContain('not requested');

    // Diagnostics remain free of conversation bodies after reload.
    const restored = TaskHandoff.restore(task!.handoff!);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    const diagJson = JSON.stringify(restored.next.toDiagnostics());
    expect(diagJson).not.toMatch(/digest-abc/);
    expect(diagJson).not.toMatch(/pre-existing/);
  });
});
