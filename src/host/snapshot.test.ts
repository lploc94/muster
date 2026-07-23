import { describe, expect, it } from 'vitest';
import {
  activeTurnIdForTask,
  buildSnapshot,
  buildTranscript,
  collectAncestorIds,
  collectSubtreeIds,
  findOwningRoot,
  owningRootMembershipChanged,
  projectCurrentTurnActivity,
  projectQueuedTurns,
  projectTaskSummary,
  type PendingAskOverlay,
  type TranscriptItem,
  type TranscriptPageState,
} from './snapshot';
import type { TaskReadPort } from '../task/store-port';
import type { MusterTask, TaskMessage, EngineProjection, TaskTurn } from '../task/types';

/** Focused v6 page fixture — production supplies this from getTranscriptPage. */
function pageOpts(
  transcript: TranscriptItem[],
  page: Partial<TranscriptPageState> = {},
): { transcript: TranscriptItem[]; transcriptPage: TranscriptPageState } {
  return {
    transcript,
    transcriptPage: {
      hasMoreBefore: false,
      workspaceRevision: 0,
      ...page,
    },
  };
}

const POLICY = {
  maxTurns: 10,
  maxAutomaticRetries: 1,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 300_000,
};

function task(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    goal: `Goal for ${id}`,
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: POLICY,
    revision: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function turn(overrides: Partial<TaskTurn> & Pick<TaskTurn, 'id' | 'taskId' | 'status' | 'sequence'>): TaskTurn {
  return {
    trigger: 'user',
    inputs: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<TaskMessage> & Pick<TaskMessage, 'id' | 'taskId' | 'role' | 'content'>): TaskMessage {
  return {
    state: 'complete',
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function storeFrom(file: EngineProjection): TaskReadPort {
  return {
    getFile: () => file,
  } as TaskReadPort;
}

describe('host task snapshot projection', () => {
  it('renders a human-readable configured run timeout reason', () => {
    const file: EngineProjection = {
      schemaVersion: 6,
      revision: 1,
      tasks: { timed: task('timed') },
      turns: {
        timeout: turn({
          id: 'timeout',
          taskId: 'timed',
          status: 'interrupted',
          sequence: 1,
          termination: {
            kind: 'run_timeout',
            limitMs: 2 * 60 * 60_000,
            deadlineAt: '2026-07-16T02:00:00.000Z',
          },
        }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectTaskSummary(file, 'timed')?.runTimeoutMessage).toBe(
      'Agent run reached the configured 2-hour limit.',
    );
  });

  it('does not reuse a historical run-timeout label after a later ordinary failure', () => {
    const file: EngineProjection = {
      schemaVersion: 6,
      revision: 1,
      tasks: { timed: task('timed') },
      turns: {
        timeout: turn({
          id: 'timeout',
          taskId: 'timed',
          status: 'interrupted',
          sequence: 1,
          termination: {
            kind: 'run_timeout',
            limitMs: 2 * 60 * 60_000,
            deadlineAt: '2026-07-16T02:00:00.000Z',
          },
        }),
        retry: turn({
          id: 'retry',
          taskId: 'timed',
          status: 'failed',
          sequence: 2,
        }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectTaskSummary(file, 'timed')?.runTimeoutMessage).toBeUndefined();
  });

  it('orders roots by projected activity and projects a focused task contract', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 7,
      tasks: {
        'root-old': task('root-old', {
          goal: 'Older root',
          updatedAt: '2026-07-06T00:02:00.000Z',
        }),
        'root-active': task('root-active', {
          role: 'coordinator',
          goal: 'Active root',
          updatedAt: '2026-07-06T00:01:00.000Z',
        }),
        'child-b': task('child-b', {
          goal: 'Second child',
          parentId: 'root-active',
          updatedAt: '2026-07-06T00:03:00.000Z',
        }),
        'child-a': task('child-a', {
          goal: 'First child',
          parentId: 'root-active',
          prerequisites: [
            { producerTaskId: 'root-old', requiredLifecycle: 'succeeded', onUnmet: 'block' },
          ],
          updatedAt: '2026-07-06T00:04:00.000Z',
        }),
        grandchild: task('grandchild', {
          goal: 'Nested child',
          parentId: 'child-a',
          updatedAt: '2026-07-06T00:05:00.000Z',
        }),
      },
      turns: {
        'root-active-succeeded': turn({
          id: 'root-active-succeeded',
          taskId: 'root-active',
          status: 'succeeded',
          sequence: 1,
          finishedAt: '2026-07-06T00:10:00.000Z',
        }),
        'root-active-running': turn({
          id: 'root-active-running',
          taskId: 'root-active',
          status: 'running',
          sequence: 2,
          startedAt: '2026-07-06T00:11:00.000Z',
        }),
        'root-active-queued': turn({
          id: 'root-active-queued',
          taskId: 'root-active',
          status: 'queued',
          sequence: 3,
          createdAt: '2026-07-06T00:12:00.000Z',
        }),
      },
      messages: {
        system: message({
          id: 'system',
          taskId: 'root-active',
          role: 'system',
          content: 'hidden from transcript',
          createdAt: '2026-07-06T00:14:00.000Z',
        }),
        assistant: message({
          id: 'assistant',
          taskId: 'root-active',
          role: 'assistant',
          content: 'assistant answer',
          createdAt: '2026-07-06T00:13:00.000Z',
        }),
        user: message({
          id: 'user',
          taskId: 'root-active',
          role: 'user',
          content: 'user request',
          createdAt: '2026-07-06T00:12:30.000Z',
        }),
      },
      operations: {},
      cancelRequests: {},
    };
    const pendingAsk: PendingAskOverlay = {
      taskId: 'root-active',
      turnId: 'root-active-running',
      askId: 'ask-1',
      questions: [{ prompt: 'Continue?' }],
    };
    // W4: focused transcript is a bounded page option, not rebuilt from messages.
    const focusedTranscript = buildTranscript(file, 'root-active');

    const snapshot = buildSnapshot(
      storeFrom(file),
      'root-active',
      new Map([['root-active', pendingAsk]]),
      pageOpts(focusedTranscript, { workspaceRevision: 7 }),
    );

    expect(snapshot.storeRevision).toBe(7);
    expect(snapshot.rootTasks.map((summary) => summary.id)).toEqual(['root-active', 'root-old']);
    expect(snapshot.rootTasks[0]).toMatchObject({
      id: 'root-active',
      role: 'coordinator',
      lifecycle: 'open',
      runtimeActivity: 'running',
      viewStatus: 'running',
      updatedAt: '2026-07-06T00:14:00.000Z',
    });
    expect(snapshot.focusedTaskId).toBe('root-active');
    // DFS preorder under owning root (siblings by createdAt then id).
    expect(snapshot.subtree?.map((summary) => [summary.id, summary.lifecycle, summary.runtimeActivity, summary.viewStatus])).toEqual([
      ['root-active', 'open', 'running', 'running'],
      ['child-a', 'open', 'waiting_prerequisites', 'waiting_prerequisites'],
      ['grandchild', 'open', 'idle', 'idle'],
      ['child-b', 'open', 'idle', 'idle'],
    ]);
    expect(snapshot.transcript).toEqual(focusedTranscript);
    expect(snapshot.transcriptPage).toEqual({
      hasMoreBefore: false,
      workspaceRevision: 7,
    });
    // Live turn wins over higher-sequence queued follow-ups (R012 multi-queue).
    expect(snapshot.activeTurnId).toBe('root-active-running');
    expect(snapshot.queuedTurns).toEqual([
      {
        turnId: 'root-active-queued',
        sequence: 3,
        status: 'queued',
        messageIds: [],
        createdAt: '2026-07-06T00:12:00.000Z',
      },
    ]);
    expect(snapshot.pendingAsk).toEqual({
      turnId: 'root-active-running',
      askId: 'ask-1',
      questions: [{ prompt: 'Continue?' }],
    });
  });

  it('projects multi-queued follow-ups in FIFO order with one message identity each', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 3,
      tasks: {
        multi: task('multi', { role: 'coordinator', goal: 'Multi queue' }),
      },
      turns: {
        'turn-live': turn({
          id: 'turn-live',
          taskId: 'multi',
          status: 'running',
          sequence: 1,
          startedAt: '2026-07-06T00:01:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-a' }],
        }),
        'turn-q1': turn({
          id: 'turn-q1',
          taskId: 'multi',
          status: 'queued',
          sequence: 2,
          createdAt: '2026-07-06T00:02:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-b' }],
        }),
        'turn-q2': turn({
          id: 'turn-q2',
          taskId: 'multi',
          status: 'queued',
          sequence: 3,
          createdAt: '2026-07-06T00:03:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-c' }],
        }),
      },
      messages: {
        'msg-a': message({
          id: 'msg-a',
          taskId: 'multi',
          role: 'user',
          content: 'a',
          state: 'assigned',
          turnId: 'turn-live',
        }),
        'msg-b': message({
          id: 'msg-b',
          taskId: 'multi',
          role: 'user',
          content: 'b',
          state: 'pending',
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
        'msg-c': message({
          id: 'msg-c',
          taskId: 'multi',
          role: 'user',
          content: 'c',
          state: 'pending',
          createdAt: '2026-07-06T00:03:00.000Z',
        }),
      },
      operations: {},
      cancelRequests: {},
    };

    expect(activeTurnIdForTask(file, 'multi')).toBe('turn-live');
    expect(projectQueuedTurns(file, 'multi')).toEqual([
      {
        turnId: 'turn-q1',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-b'],
        createdAt: '2026-07-06T00:02:00.000Z',
        previewText: 'b',
      },
      {
        turnId: 'turn-q2',
        sequence: 3,
        status: 'queued',
        messageIds: ['msg-c'],
        createdAt: '2026-07-06T00:03:00.000Z',
        previewText: 'c',
      },
    ]);

    const snapshot = buildSnapshot(
      storeFrom(file),
      'multi',
      undefined,
      pageOpts(buildTranscript(file, 'multi'), { workspaceRevision: 3 }),
    );
    expect(snapshot.activeTurnId).toBe('turn-live');
    expect(snapshot.queuedTurns).toEqual([
      {
        turnId: 'turn-q1',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-b'],
        createdAt: '2026-07-06T00:02:00.000Z',
        previewText: 'b',
      },
      {
        turnId: 'turn-q2',
        sequence: 3,
        status: 'queued',
        messageIds: ['msg-c'],
        createdAt: '2026-07-06T00:03:00.000Z',
        previewText: 'c',
      },
    ]);
    // Queued follow-ups stay out of chat; only the live-turn user prompt appears.
    expect(snapshot.transcript?.filter((item) => item.kind === 'user')).toEqual([
      {
        id: 'msg-a',
        kind: 'user',
        content: 'a',
        turnId: 'turn-live',
        order: undefined,
        state: 'assigned',
      },
    ]);
  });

  it('omits queuedTurns and prefers waiting_user over later queued when live is ask', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        ask: task('ask'),
      },
      turns: {
        live: turn({
          id: 'live',
          taskId: 'ask',
          status: 'waiting_user',
          sequence: 1,
        }),
        queued: turn({
          id: 'queued',
          taskId: 'ask',
          status: 'queued',
          sequence: 2,
          createdAt: '2026-07-06T00:02:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-q' }],
        }),
      },
      messages: {
        'msg-q': message({
          id: 'msg-q',
          taskId: 'ask',
          role: 'user',
          content: 'queued follow-up',
          state: 'pending',
        }),
      },
      operations: {},
      cancelRequests: {},
    };

    expect(activeTurnIdForTask(file, 'ask')).toBe('live');
    expect(projectQueuedTurns(file, 'ask')).toEqual([
      {
        turnId: 'queued',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-q'],
        createdAt: '2026-07-06T00:02:00.000Z',
        previewText: 'queued follow-up',
      },
    ]);
    expect(
      buildSnapshot(storeFrom(file), 'ask', undefined, pageOpts([])).activeTurnId,
    ).toBe('live');
  });

  it('returns empty queuedTurns when only a live turn exists', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { only: task('only') },
      turns: {
        live: turn({ id: 'live', taskId: 'only', status: 'running', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectQueuedTurns(file, 'only')).toEqual([]);
    expect(
      buildSnapshot(storeFrom(file), 'only', undefined, pageOpts([])).queuedTurns,
    ).toEqual([]);
  });

  it('selects the latest retryable turn only for recovery state', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        recovering: task('recovering'),
        settled: task('settled'),
      },
      turns: {
        failed: turn({ id: 'failed', taskId: 'recovering', status: 'failed', sequence: 1 }),
        interrupted: turn({
          id: 'interrupted',
          taskId: 'recovering',
          status: 'interrupted',
          sequence: 2,
        }),
        succeeded: turn({ id: 'succeeded', taskId: 'settled', status: 'succeeded', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };

    expect(activeTurnIdForTask(file, 'recovering')).toBe('interrupted');
    expect(activeTurnIdForTask(file, 'settled')).toBeUndefined();
    expect(activeTurnIdForTask(file, 'missing')).toBeUndefined();
  });

  it('projects currentTurnActivity per host precedence including pure stop → null', () => {
    const runningFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { t: task('t') },
      turns: {
        live: turn({ id: 'live', taskId: 't', status: 'running', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(runningFile, 't')).toEqual({
      state: 'executing',
      turnId: 'live',
    });
    expect(projectTaskSummary(runningFile, 't')?.currentTurnActivity).toEqual({
      state: 'executing',
      turnId: 'live',
    });
    expect(projectTaskSummary(runningFile, 't')).not.toHaveProperty('committedSessionId');

    const waitingFile: EngineProjection = {
      ...runningFile,
      turns: {
        live: turn({ id: 'ask', taskId: 't', status: 'waiting_user', sequence: 1 }),
      },
    };
    expect(projectCurrentTurnActivity(waitingFile, 't')).toEqual({
      state: 'waiting_you',
      turnId: 'ask',
    });

    const depFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        t: task('t', {
          prerequisites: [
            { producerTaskId: 'dep', requiredLifecycle: 'succeeded', onUnmet: 'block' },
          ],
        }),
        dep: task('dep', { lifecycle: 'open' }),
      },
      turns: {
        q: turn({ id: 'q', taskId: 't', status: 'queued', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(depFile, 't')).toEqual({
      state: 'queued',
      turnId: 'q',
      position: 1,
      waitReason: 'prerequisites',
    });

    const childrenFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        t: task('t', { wait: { kind: 'children', taskIds: ['c1'], registeredByTurnId: 'prev' } }),
      },
      turns: {
        q: turn({ id: 'q', taskId: 't', status: 'queued', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(childrenFile, 't')).toMatchObject({
      state: 'queued',
      waitReason: 'children',
    });

    const heldFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { t: task('t') },
      turns: {
        q: turn({
          id: 'q',
          taskId: 't',
          status: 'queued',
          sequence: 1,
          holdAutoPromote: true,
        }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(heldFile, 't')).toMatchObject({
      state: 'queued',
      waitReason: 'held_after_failure',
    });

    const failedFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { t: task('t') },
      turns: {
        f: turn({ id: 'f', taskId: 't', status: 'failed', sequence: 1, error: 'boom' }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(failedFile, 't')).toEqual({
      state: 'failed_turn',
      turnId: 'f',
      retryable: true,
    });

    const successAfterFailFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { t: task('t') },
      turns: {
        f: turn({ id: 'f', taskId: 't', status: 'failed', sequence: 1, error: 'boom' }),
        s: turn({ id: 's', taskId: 't', status: 'succeeded', sequence: 2 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(successAfterFailFile, 't')).toBeNull();

    const pureStopFile: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { t: task('t') },
      turns: {
        stop: turn({
          id: 'stop',
          taskId: 't',
          status: 'interrupted',
          sequence: 1,
          isCancellation: true,
          interruptConfidence: 'confirmed',
        }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectCurrentTurnActivity(pureStopFile, 't')).toBeNull();
  });

  it('projects wait continuation and recovery previews when no user message', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { t: task('t', { role: 'coordinator', goal: 'Wait UX' }) },
      turns: {
        wait: turn({
          id: 'wait',
          taskId: 't',
          sequence: 2,
          status: 'queued',
          trigger: 'engine',
          inputs: [{ kind: 'child_results', taskIds: ['c1'] }],
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
        recovery: turn({
          id: 'recovery',
          taskId: 't',
          sequence: 3,
          status: 'queued',
          trigger: 'engine',
          inputs: [
            {
              kind: 'recovery',
              interruptedTurnId: 'live',
              instruction: 'retry carefully',
            },
          ],
          createdAt: '2026-07-06T00:03:00.000Z',
        }),
        user: turn({
          id: 'user',
          taskId: 't',
          sequence: 4,
          status: 'queued',
          inputs: [{ kind: 'message', messageId: 'msg-user' }],
          createdAt: '2026-07-06T00:04:00.000Z',
        }),
      },
      messages: {
        'msg-user': message({
          id: 'msg-user',
          taskId: 't',
          role: 'user',
          content: '  real user follow-up  ',
          state: 'pending',
        }),
      },
      operations: {},
      cancelRequests: {},
    };
    const queued = projectQueuedTurns(file, 't');
    expect(queued.map((q) => q.previewText)).toEqual([
      'Continuation after wait',
      'Recovery turn',
      'real user follow-up',
    ]);
  });

  it('excludes queued-turn user messages from transcript but projects queue previewText', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        t: task('t', { role: 'coordinator', goal: 'Queue vs chat' }),
      },
      turns: {
        live: turn({
          id: 'live',
          taskId: 't',
          sequence: 1,
          status: 'running',
          inputs: [{ kind: 'message', messageId: 'msg-live' }],
          createdAt: '2026-07-06T00:01:00.000Z',
          startedAt: '2026-07-06T00:01:01.000Z',
        }),
        queued: turn({
          id: 'queued',
          taskId: 't',
          sequence: 2,
          status: 'queued',
          inputs: [{ kind: 'message', messageId: 'msg-queued' }],
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
      },
      messages: {
        'msg-live': {
          id: 'msg-live',
          taskId: 't',
          role: 'user',
          content: 'live prompt',
          state: 'assigned',
          createdAt: '2026-07-06T00:01:00.000Z',
          turnId: 'live',
        },
        'msg-queued': {
          id: 'msg-queued',
          taskId: 't',
          role: 'user',
          content: 'follow-up in queue only',
          state: 'pending',
          createdAt: '2026-07-06T00:02:00.000Z',
        },
      },
      operations: {},
      cancelRequests: {},
    };
    const store = storeFrom(file);
    // Bounded page carries only chat-visible items (live prompt); queue panel
    // is projected separately from observation messages.
    const chatTranscript = buildTranscript(file, 't');
    const snapshot = buildSnapshot(store, 't', undefined, pageOpts(chatTranscript));
    const userContents = (snapshot.transcript ?? [])
      .filter((item) => item.kind === 'user')
      .map((item) => item.content);
    expect(userContents).toEqual(['live prompt']);
    expect(userContents).not.toContain('follow-up in queue only');
    expect(snapshot.queuedTurns).toEqual([
      {
        turnId: 'queued',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-queued'],
        createdAt: '2026-07-06T00:02:00.000Z',
        previewText: 'follow-up in queue only',
      },
    ]);
  });

  it('shows the opening queued prompt in chat immediately without a queue-panel flash', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        t: task('t', { role: 'coordinator', goal: 'Fresh chat' }),
      },
      turns: {
        opening: turn({
          id: 'opening',
          taskId: 't',
          sequence: 1,
          status: 'queued',
          inputs: [{ kind: 'message', messageId: 'msg-opening' }],
        }),
      },
      messages: {
        'msg-opening': message({
          id: 'msg-opening',
          taskId: 't',
          role: 'user',
          content: 'Start immediately',
          state: 'pending',
        }),
      },
      operations: {},
      cancelRequests: {},
    };

    // Opening prompt is chat-visible (buildTranscript keeps sole queued user turn).
    const openingTranscript = buildTranscript(file, 't');
    const snapshot = buildSnapshot(storeFrom(file), 't', undefined, pageOpts(openingTranscript));
    expect(snapshot.transcript).toEqual([
      {
        id: 'msg-opening',
        kind: 'user',
        content: 'Start immediately',
        turnId: 'opening',
        order: undefined,
        state: 'pending',
      },
    ]);
    expect(snapshot.queuedTurns).toEqual([]);
  });

  it('omits multi-phase handoffProgress (v2 switch has no progress chrome)', () => {
    const canaries = {
      contentDigest: 'handoff-digest-SECRET',
      summaryReason: 'SOURCE_SUMMARY_BODY_MUST_NOT_APPEAR',
      bootstrapBody: 'BOOTSTRAP_PROMPT_BODY_MUST_NOT_APPEAR',
      boundSessionId: 'handoff-bound-session-SECRET',
      sourceSessionId: 'src-sess-SECRET',
      targetSessionId: 'tgt-sess-SECRET',
    };
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 5,
      tasks: {
        hop: task('hop', {
          backend: 'claude-cli',
          model: 'sonnet',
          handoff: {
            version: 1,
            operationId: 'hop-op-1',
            phase: 'preparing_receiver',
            source: {
              backend: 'claude-cli',
              model: 'sonnet',
              sessionId: canaries.sourceSessionId,
            },
            target: {
              backend: 'codex',
              model: 'gpt-5',
              sessionId: canaries.targetSessionId,
            },
            conversationContext: {
              status: 'ready',
              messageCount: 3,
              contentDigest: canaries.contentDigest,
              exportedAt: '2026-07-06T00:10:00.000Z',
            },
            sourceSummary: {
              status: 'ready',
              contentDigest: canaries.contentDigest,
              summarizedAt: '2026-07-06T00:10:30.000Z',
            },
            createdAt: '2026-07-06T00:00:00.000Z',
            updatedAt: '2026-07-06T00:10:45.000Z',
            startedAt: '2026-07-06T00:00:01.000Z',
          },
        }),
        idle: task('idle', {
          goal: 'No handoff',
          updatedAt: '2026-07-06T00:00:00.000Z',
        }),
      },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
    };

    const summary = projectTaskSummary(file, 'hop');
    // §19: no multi-phase progress bar; legacy phase machine is not projected.
    expect(summary).not.toHaveProperty('handoffProgress');
    expect(summary).not.toHaveProperty('handoff');
    expect(projectTaskSummary(file, 'idle')).not.toHaveProperty('handoffProgress');

    const snapshot = buildSnapshot(storeFrom(file), 'hop', undefined, pageOpts([]));
    const hopRoot = snapshot.rootTasks.find((t) => t.id === 'hop');
    const hopSubtree = snapshot.subtree?.find((t) => t.id === 'hop');
    expect(hopRoot).not.toHaveProperty('handoffProgress');
    expect(hopSubtree).toBeDefined();
    expect(hopSubtree).not.toHaveProperty('handoffProgress');

    const projectedJson = JSON.stringify({
      summary,
      roots: snapshot.rootTasks,
      subtree: snapshot.subtree,
      transcript: snapshot.transcript,
    });
    for (const needle of Object.values(canaries)) {
      expect(projectedJson, `projection must not contain ${needle}`).not.toContain(needle);
    }
    expect(projectedJson).not.toContain('contentDigest');
    expect(projectedJson).not.toContain('sourceSummary');
    expect(projectedJson).not.toContain('conversationContext');
    expect(projectedJson).not.toContain('sessionId');
    expect(projectedJson).not.toContain('boundSessionId');
    expect(projectedJson).not.toContain('preparing_receiver');
  });

  it('P2: coordinator TaskSummary includes childOrchestration aggregate', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        coord: task('coord', { role: 'coordinator', goal: 'root' }),
        c1: task('c1', {
          parentId: 'coord',
          role: 'worker',
          lifecycle: 'open',
          attention: {
            code: 'awaiting_parent_seal',
            message: 'awaiting parent seal',
            at: '2026-07-06T00:00:00.000Z',
          },
          completionCandidate: {
            version: 1,
            sourceTurnId: 't1',
            observedAt: '2026-07-06T00:00:00.000Z',
            summary: 'Turn completed without complete_task/fail_task disposition.',
            reason: 'missing_disposition',
          },
        }),
        c2: task('c2', {
          parentId: 'coord',
          role: 'worker',
          lifecycle: 'succeeded',
        }),
      },
      turns: {
        t1: turn({
          id: 't1',
          taskId: 'c1',
          status: 'running',
          sequence: 1,
        }),
      },
      messages: {},
    };
    const summary = projectTaskSummary(file, 'coord');
    expect(summary?.childOrchestration).toMatchObject({
      total: 2,
      running: 1,
      open: 1,
      terminal: 1,
      awaitingParentSeal: 1,
    });
    expect(summary?.childOrchestration).not.toHaveProperty('repairPending');
    expect(summary?.childOrchestration?.label).toContain('running');
    expect(summary?.childOrchestration?.label).toContain('awaiting parent seal');
    expect(summary?.childOrchestration?.label).not.toContain('disposition retry');
    expect(projectTaskSummary(file, 'c1')).not.toHaveProperty('childOrchestration');
  });

  it('projects full owning-root tree when focus is a nested child', () => {
    const file: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        root: task('root', { role: 'coordinator', goal: 'Root' }),
        a: task('a', { parentId: 'root', goal: 'A', createdAt: '2026-07-06T00:01:00.000Z' }),
        b: task('b', { parentId: 'root', goal: 'B', createdAt: '2026-07-06T00:02:00.000Z' }),
        nested: task('nested', { parentId: 'a', goal: 'Nested', createdAt: '2026-07-06T00:03:00.000Z' }),
      },
      turns: {},
      messages: {
        nestedUser: message({
          id: 'nestedUser',
          taskId: 'nested',
          role: 'user',
          content: 'only nested',
        }),
        rootUser: message({
          id: 'rootUser',
          taskId: 'root',
          role: 'user',
          content: 'only root',
        }),
      },
    };

    expect(findOwningRoot(file, 'nested')).toBe('root');
    expect(collectAncestorIds(file, 'nested')).toEqual(['a', 'root']);
    expect(collectSubtreeIds(file, 'root')).toEqual(['root', 'a', 'nested', 'b']);

    const nestedTranscript = buildTranscript(file, 'nested');
    const snapshot = buildSnapshot(
      storeFrom(file),
      'nested',
      undefined,
      pageOpts(nestedTranscript),
    );
    expect(snapshot.focusedTaskId).toBe('nested');
    expect(snapshot.subtree?.map((s) => s.id)).toEqual(['root', 'a', 'nested', 'b']);
    expect(snapshot.transcript?.map((item) => item.id)).toEqual(['nestedUser']);
  });

  it('normalizes focused snapshot without page options to no-focus (v6 invariant)', () => {
    const file: EngineProjection = {
      schemaVersion: 6,
      revision: 1,
      tasks: { t: task('t') },
      turns: {},
      messages: {},
    };
    const snapshot = buildSnapshot(storeFrom(file), 't');
    expect(snapshot.focusedTaskId).toBeUndefined();
    expect(snapshot.transcript).toBeUndefined();
    expect(snapshot.transcriptPage).toBeUndefined();
  });

  it('detects owning-root membership changes for sibling create', () => {
    const before: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        root: task('root', { role: 'coordinator' }),
        a: task('a', { parentId: 'root' }),
      },
      turns: {},
      messages: {},
    };
    const after: EngineProjection = {
      ...before,
      revision: 2,
      tasks: {
        ...before.tasks,
        b: task('b', { parentId: 'root', createdAt: '2026-07-06T00:02:00.000Z' }),
      },
    };
    expect(owningRootMembershipChanged(before, after, 'a')).toBe(true);
    expect(owningRootMembershipChanged(before, before, 'a')).toBe(false);
  });

  it('collectSubtreeIds does not recurse forever on parent cycles', () => {
    const selfParent: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        loop: task('loop', { parentId: 'loop' }),
      },
      turns: {},
      messages: {},
    };
    expect(collectSubtreeIds(selfParent, 'loop')).toEqual(['loop']);

    const mutual: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        a: task('a', { parentId: 'b' }),
        b: task('b', { parentId: 'a' }),
      },
      turns: {},
      messages: {},
    };
    const ids = collectSubtreeIds(mutual, 'a');
    expect(ids).toContain('a');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(2);
  });

});
