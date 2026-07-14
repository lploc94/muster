import { describe, expect, it } from 'vitest';
import {
  activeTurnIdForTask,
  buildSnapshot,
  projectCurrentTurnActivity,
  projectQueuedTurns,
  projectTaskSummary,
  type PendingAskOverlay,
} from './snapshot';
import type { TaskStore } from '../task/store';
import type { MusterTask, TaskMessage, TaskStoreFile, TaskTurn } from '../task/types';

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
    dependencies: [],
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

function storeFrom(file: TaskStoreFile): TaskStore {
  return {
    getFile: () => file,
  } as TaskStore;
}

describe('host task snapshot projection', () => {
  it('orders roots by projected activity and projects a focused task contract', () => {
    const file: TaskStoreFile = {
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
          dependencies: [
            { taskId: 'root-old', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
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
      questions: [{ name: 'direction', question: 'Continue?', type: 'text' }],
    };

    const snapshot = buildSnapshot(storeFrom(file), 'root-active', new Map([['root-active', pendingAsk]]));

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
    expect(snapshot.subtree?.map((summary) => [summary.id, summary.lifecycle, summary.runtimeActivity, summary.viewStatus])).toEqual([
      ['child-a', 'open', 'waiting_dependencies', 'waiting_dependencies'],
      ['child-b', 'open', 'idle', 'idle'],
      ['grandchild', 'open', 'idle', 'idle'],
      ['root-active', 'open', 'running', 'running'],
    ]);
    expect(snapshot.transcript).toEqual([
      {
        id: 'user',
        kind: 'user',
        content: 'user request',
        turnId: undefined,
        order: undefined,
        state: 'complete',
      },
      {
        id: 'assistant',
        kind: 'assistant',
        content: 'assistant answer',
        turnId: undefined,
        order: undefined,
        state: 'complete',
      },
    ]);
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
      questions: [{ name: 'direction', question: 'Continue?', type: 'text' }],
    });
  });

  it('projects multi-queued follow-ups in FIFO order with one message identity each', () => {
    const file: TaskStoreFile = {
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

    const snapshot = buildSnapshot(storeFrom(file), 'multi');
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
    const file: TaskStoreFile = {
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
    expect(buildSnapshot(storeFrom(file), 'ask').activeTurnId).toBe('live');
  });

  it('returns empty queuedTurns when only a live turn exists', () => {
    const file: TaskStoreFile = {
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
    expect(buildSnapshot(storeFrom(file), 'only').queuedTurns).toEqual([]);
  });

  it('selects the latest retryable turn only for recovery state', () => {
    const file: TaskStoreFile = {
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
    const runningFile: TaskStoreFile = {
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

    const waitingFile: TaskStoreFile = {
      ...runningFile,
      turns: {
        live: turn({ id: 'ask', taskId: 't', status: 'waiting_user', sequence: 1 }),
      },
    };
    expect(projectCurrentTurnActivity(waitingFile, 't')).toEqual({
      state: 'waiting_you',
      turnId: 'ask',
    });

    const depFile: TaskStoreFile = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        t: task('t', {
          dependencies: [
            { taskId: 'dep', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
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
      waitReason: 'dependencies',
    });

    const childrenFile: TaskStoreFile = {
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

    const heldFile: TaskStoreFile = {
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

    const failedFile: TaskStoreFile = {
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

    const successAfterFailFile: TaskStoreFile = {
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

    const pureStopFile: TaskStoreFile = {
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

  it('excludes queued-turn user messages from transcript but projects queue previewText', () => {
    const file: TaskStoreFile = {
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
    const snapshot = buildSnapshot(store, 't');
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

  it('does not project TaskHandoff state into the webview transcript', () => {
    const handoffCanaries = {
      operationId: 'hop-secret-op',
      contentDigest: 'handoff-digest-SECRET',
      summaryReason: 'SOURCE_SUMMARY_BODY_MUST_NOT_APPEAR',
      boundSessionId: 'handoff-bound-session-SECRET',
      sourceSessionId: 'src-sess-SECRET',
    };
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 4,
      tasks: {
        handoff: task('handoff', {
          role: 'coordinator',
          goal: 'Cross-runtime handoff task',
          handoff: {
            version: 1,
            operationId: handoffCanaries.operationId,
            phase: 'completed',
            source: {
              backend: 'claude-cli',
              model: 'sonnet',
              sessionId: handoffCanaries.sourceSessionId,
            },
            target: { backend: 'codex', model: 'gpt-5' },
            conversationContext: {
              status: 'ready',
              messageCount: 2,
              contentDigest: handoffCanaries.contentDigest,
              exportedAt: '2026-07-06T00:10:00.000Z',
            },
            sourceSummary: {
              status: 'skipped',
              reason: handoffCanaries.summaryReason,
            },
            createdAt: '2026-07-06T00:00:00.000Z',
            updatedAt: '2026-07-06T00:11:00.000Z',
            startedAt: '2026-07-06T00:00:01.000Z',
            finishedAt: '2026-07-06T00:11:00.000Z',
            completion: {
              completedAt: '2026-07-06T00:11:00.000Z',
              boundBackend: 'codex',
              boundSessionId: handoffCanaries.boundSessionId,
            },
          },
        }),
      },
      turns: {
        t1: turn({
          id: 't1',
          taskId: 'handoff',
          status: 'succeeded',
          sequence: 1,
          inputs: [{ kind: 'message', messageId: 'u1' }],
          finishedAt: '2026-07-06T00:05:00.000Z',
        }),
      },
      messages: {
        u1: message({
          id: 'u1',
          taskId: 'handoff',
          role: 'user',
          content: 'visible chat only',
          createdAt: '2026-07-06T00:04:00.000Z',
          turnId: 't1',
        }),
        a1: message({
          id: 'a1',
          taskId: 'handoff',
          role: 'assistant',
          content: 'visible assistant reply',
          createdAt: '2026-07-06T00:04:30.000Z',
          turnId: 't1',
          order: 0,
        }),
      },
      operations: {},
      cancelRequests: {},
    };

    const snapshot = buildSnapshot(storeFrom(file), 'handoff');
    expect(snapshot.transcript).toEqual([
      {
        id: 'u1',
        kind: 'user',
        content: 'visible chat only',
        turnId: 't1',
        order: undefined,
        state: 'complete',
      },
      {
        id: 'a1',
        kind: 'assistant',
        content: 'visible assistant reply',
        turnId: 't1',
        order: 0,
        state: 'complete',
      },
    ]);

    const transcriptJson = JSON.stringify(snapshot.transcript);
    for (const needle of Object.values(handoffCanaries)) {
      expect(transcriptJson, `transcript must not contain ${needle}`).not.toContain(needle);
    }
    // Task summaries also must not surface handoff digests/session ids as chat.
    const summaryJson = JSON.stringify({
      roots: snapshot.rootTasks,
      subtree: snapshot.subtree,
    });
    expect(summaryJson).not.toContain(handoffCanaries.contentDigest);
    expect(summaryJson).not.toContain(handoffCanaries.summaryReason);
    expect(summaryJson).not.toContain(handoffCanaries.boundSessionId);
    expect(summaryJson).not.toContain(handoffCanaries.sourceSessionId);
  });

  it('projects sanitized handoffProgress on TaskSummary without secrets', () => {
    const canaries = {
      contentDigest: 'handoff-digest-SECRET',
      summaryReason: 'SOURCE_SUMMARY_BODY_MUST_NOT_APPEAR',
      bootstrapBody: 'BOOTSTRAP_PROMPT_BODY_MUST_NOT_APPEAR',
      boundSessionId: 'handoff-bound-session-SECRET',
      sourceSessionId: 'src-sess-SECRET',
      targetSessionId: 'tgt-sess-SECRET',
    };
    const file: TaskStoreFile = {
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
    expect(summary?.handoffProgress).toEqual({
      operationId: 'hop-op-1',
      phase: 'preparing_receiver',
      source: { backend: 'claude-cli', model: 'sonnet' },
      target: { backend: 'codex', model: 'gpt-5' },
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:10:45.000Z',
      startedAt: '2026-07-06T00:00:01.000Z',
    });
    expect(summary).not.toHaveProperty('handoff');
    expect(projectTaskSummary(file, 'idle')).not.toHaveProperty('handoffProgress');

    const snapshot = buildSnapshot(storeFrom(file), 'hop');
    const hopRoot = snapshot.rootTasks.find((t) => t.id === 'hop');
    const hopSubtree = snapshot.subtree?.find((t) => t.id === 'hop');
    expect(hopRoot?.handoffProgress?.phase).toBe('preparing_receiver');
    expect(hopSubtree?.handoffProgress?.operationId).toBe('hop-op-1');

    const projectedJson = JSON.stringify({
      summary,
      roots: snapshot.rootTasks,
      subtree: snapshot.subtree,
      transcript: snapshot.transcript,
    });
    for (const needle of Object.values(canaries)) {
      expect(projectedJson, `projection must not contain ${needle}`).not.toContain(needle);
    }
    // Explicit absence of internal handoff fields / bodies.
    expect(projectedJson).not.toContain('contentDigest');
    expect(projectedJson).not.toContain('sourceSummary');
    expect(projectedJson).not.toContain('conversationContext');
    expect(projectedJson).not.toContain('sessionId');
    expect(projectedJson).not.toContain('boundSessionId');
  });

  it('projects bounded handoff failure metadata only on failed handoffProgress', () => {
    const rawFailure =
      'Receiver init failed at C:\\Users\\secret\\repo\\handoff with sk-live-SECRETTOKEN12345 dump';
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 6,
      tasks: {
        fail: task('fail', {
          handoff: {
            version: 1,
            operationId: 'hop-fail-1',
            phase: 'failed',
            source: { backend: 'claude-cli', model: 'sonnet', sessionId: 'src-sess-SECRET' },
            target: { backend: 'codex', model: 'gpt-5' },
            conversationContext: {
              status: 'ready',
              messageCount: 1,
              contentDigest: 'handoff-digest-SECRET',
              exportedAt: '2026-07-06T00:01:00.000Z',
            },
            sourceSummary: {
              status: 'skipped',
              reason: 'SOURCE_SUMMARY_BODY_MUST_NOT_APPEAR',
            },
            createdAt: '2026-07-06T00:00:00.000Z',
            updatedAt: '2026-07-06T00:02:00.000Z',
            startedAt: '2026-07-06T00:00:01.000Z',
            finishedAt: '2026-07-06T00:02:00.000Z',
            failure: {
              code: 'receiver_init_failed',
              message: rawFailure,
              at: '2026-07-06T00:02:00.000Z',
            },
          },
        }),
      },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
    };

    const progress = projectTaskSummary(file, 'fail')?.handoffProgress;
    expect(progress).toMatchObject({
      operationId: 'hop-fail-1',
      phase: 'failed',
      source: { backend: 'claude-cli', model: 'sonnet' },
      target: { backend: 'codex', model: 'gpt-5' },
      finishedAt: '2026-07-06T00:02:00.000Z',
      failure: {
        code: 'receiver_init_failed',
        at: '2026-07-06T00:02:00.000Z',
      },
    });
    expect(progress?.failure?.message).toBeTruthy();
    expect(progress?.failure?.message.length).toBeLessThanOrEqual(240);
    expect(progress?.failure?.message).not.toMatch(/C:\\Users/);
    expect(progress?.failure?.message).not.toContain('sk-live-SECRETTOKEN12345');
    const progressJson = JSON.stringify(progress);
    expect(progressJson).not.toContain('src-sess-SECRET');
    expect(progressJson).not.toContain('handoff-digest-SECRET');
    expect(progressJson).not.toContain('SOURCE_SUMMARY_BODY_MUST_NOT_APPEAR');
    expect(progressJson).not.toContain('contentDigest');
    expect(progressJson).not.toContain('sessionId');
  });

});
