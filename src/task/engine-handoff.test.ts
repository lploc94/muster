import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, buildTranscript } from '../host/snapshot';
import { renderTaskMarkdownExport } from '../host/task-markdown-export';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from './engine';
import {
  advanceHandoffToPreparingReceiver,
  advanceHandoffWithSourceSummary,
  buildHandoffBootstrapPrompt,
  buildHandoffPackage,
  collectInternalSummaryTurnText,
  digestSourceSummaryText,
  exportConversationContextMetadata,
  HANDOFF_PACKAGE_VERSION,
  HANDOFF_SOURCE_SUMMARY_PROMPT,
  isActiveHandoffPhase,
  MAX_HANDOFF_CONVERSATION_CHARS,
  MAX_HANDOFF_CONVERSATION_MESSAGES,
  MAX_HANDOFF_SOURCE_SUMMARY_CHARS,
  rebuildHandoffConversation,
} from './engine-handoff';
import { TaskHandoff } from './task-handoff';
import { TaskStore } from './store';
import type { TaskMessage } from './types';

const MCP_CAPS: BackendCapabilities = {
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsMCP: true,
  supportsLiveInput: false,
};

function scriptedBackend(
  events: NormalizedEvent[] = [{ type: 'turnCompleted' }],
  caps: BackendCapabilities = MCP_CAPS,
  name = 'fake',
): Backend {
  return {
    name,
    capabilities: caps,
    run: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function makeTempStore(): { store: TaskStore; dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-handoff-'));
  const filePath = path.join(dir, 'tasks.json');
  const store = TaskStore.load({ filePath });
  return { store, dir, filePath };
}

function seedIdleTaskWithMessages(opts?: {
  backend?: string;
  model?: string;
  sessionId?: string;
  messages?: Array<Pick<TaskMessage, 'id' | 'role' | 'content'>>;
}): { store: TaskStore; taskId: string; filePath: string } {
  const { store, filePath } = makeTempStore();
  const taskId = 'task-handoff-1';
  const backend = opts?.backend ?? 'claude-cli';
  const model = opts?.model ?? 'sonnet';
  const sessionId = opts?.sessionId ?? 'sess-source';
  const messages =
    opts?.messages ??
    ([
      { id: 'm1', role: 'user' as const, content: 'hello world' },
      { id: 'm2', role: 'assistant' as const, content: 'hi there' },
    ] as const);

  store.commit((draft) => {
    draft.tasks[taskId] = {
      id: taskId,
      role: 'coordinator',
      lifecycle: 'open',
      goal: 'switch runtime',
      parentId: null,
      dependencies: [],
      backend,
      model,
      committedSessionId: sessionId,
      capabilities: [],
      executionPolicy: {
        maxTurns: 8,
        maxAutomaticRetries: 2,
        turnTimeoutMs: 300_000,
        taskTimeoutMs: 3_600_000,
      },
      revision: 1,
      createdAt: '2026-07-14T10:00:00.000Z',
      updatedAt: '2026-07-14T10:00:00.000Z',
    };
    for (const message of messages) {
      draft.messages[message.id] = {
        id: message.id,
        taskId,
        role: message.role,
        content: message.content,
        state: 'complete',
        createdAt: '2026-07-14T10:00:00.000Z',
      };
    }
    return { ok: true };
  });

  return { store, taskId, filePath };
}

describe('engine-handoff helpers', () => {
  it('exports conversation-context metadata as digests/counts only', () => {
    const messages: TaskMessage[] = [
      {
        id: 'm2',
        taskId: 't1',
        role: 'assistant',
        content: 'second',
        state: 'complete',
        createdAt: '2026-07-14T10:00:02.000Z',
      },
      {
        id: 'm1',
        taskId: 't1',
        role: 'user',
        content: 'first',
        state: 'complete',
        createdAt: '2026-07-14T10:00:01.000Z',
      },
    ];

    const exported = exportConversationContextMetadata(messages, '2026-07-14T10:05:00.000Z');
    expect(exported.messageCount).toBe(2);
    expect(exported.exportedAt).toBe('2026-07-14T10:05:00.000Z');
    expect(exported.contentDigest.length).toBeGreaterThan(0);
    expect(exported.contentDigest).not.toContain('first');
    expect(exported.contentDigest).not.toContain('second');

    const sameOrder = exportConversationContextMetadata(
      [...messages].reverse(),
      '2026-07-14T10:05:00.000Z',
    );
    expect(sameOrder.contentDigest).toBe(exported.contentDigest);

    const different = exportConversationContextMetadata(
      [
        {
          id: 'm1',
          taskId: 't1',
          role: 'user',
          content: 'changed',
          state: 'complete',
          createdAt: '2026-07-14T10:00:01.000Z',
        },
      ],
      '2026-07-14T10:05:00.000Z',
    );
    expect(different.contentDigest).not.toBe(exported.contentDigest);
  });

  it('advances requested → exporting_context → skip summary → preparing_receiver', () => {
    const handoff = TaskHandoff.create({
      operationId: 'op-1',
      source: { backend: 'claude-cli', model: 'sonnet', sessionId: 'sess-a' },
      target: { backend: 'codex', model: 'gpt-5' },
      now: '2026-07-14T10:00:00.000Z',
    });

    const advanced = advanceHandoffToPreparingReceiver({
      handoff,
      messages: [
        {
          id: 'm1',
          taskId: 't1',
          role: 'user',
          content: 'ctx',
          state: 'complete',
          createdAt: '2026-07-14T10:00:00.000Z',
        },
      ],
      now: '2026-07-14T10:01:00.000Z',
      skipSummaryReason: 'summary not requested',
    });

    expect(advanced.ok).toBe(true);
    if (!advanced.ok) {
      throw new Error(advanced.reason);
    }
    expect(advanced.next.phase).toBe('preparing_receiver');
    const state = advanced.next.toState();
    expect(state.conversationContext.status).toBe('ready');
    if (state.conversationContext.status === 'ready') {
      expect(state.conversationContext.messageCount).toBe(1);
    }
    expect(state.sourceSummary?.status).toBe('skipped');
    expect(state.source.backend).toBe('claude-cli');
    expect(state.source.sessionId).toBe('sess-a');
    expect(state.target.backend).toBe('codex');
  });

  it('treats in-flight handoff phases as active and terminals as inactive', () => {
    expect(isActiveHandoffPhase('requested')).toBe(true);
    expect(isActiveHandoffPhase('preparing_receiver')).toBe(true);
    expect(isActiveHandoffPhase('completed')).toBe(false);
    expect(isActiveHandoffPhase('failed')).toBe(false);
    expect(isActiveHandoffPhase('cancelled')).toBe(false);
  });

  it('digests source-summary text and collects assistant deltas without raw persistence helpers', async () => {
    const digest = digestSourceSummaryText('handoff body');
    expect(digest.length).toBe(32);
    expect(digest).not.toContain('handoff');

    async function* stream(): AsyncIterable<NormalizedEvent> {
      yield { type: 'assistantDelta', content: 'part-a ', messageId: 'x' };
      yield { type: 'assistantDelta', content: 'part-b', messageId: 'x' };
      yield { type: 'turnCompleted' };
    }
    const collected = await collectInternalSummaryTurnText(stream());
    expect(collected.text).toBe('part-a part-b');
    expect(collected.errorMessage).toBeUndefined();
  });

  it('advances through summarizing_source with ready summary to preparing_receiver', () => {
    const handoff = TaskHandoff.create({
      operationId: 'op-sum',
      source: { backend: 'claude-cli', model: 'sonnet' },
      target: { backend: 'codex', model: 'gpt-5' },
      now: '2026-07-14T10:00:00.000Z',
    });
    const advanced = advanceHandoffWithSourceSummary({
      handoff,
      messages: [
        {
          id: 'm1',
          taskId: 't1',
          role: 'user',
          content: 'ctx',
          state: 'complete',
          createdAt: '2026-07-14T10:00:00.000Z',
        },
      ],
      now: '2026-07-14T10:01:00.000Z',
      summary: {
        kind: 'ready',
        contentDigest: digestSourceSummaryText('ready summary'),
        summarizedAt: '2026-07-14T10:01:00.000Z',
      },
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) throw new Error(advanced.reason);
    expect(advanced.next.phase).toBe('preparing_receiver');
    expect(advanced.next.toState().sourceSummary?.status).toBe('ready');
  });

  it('still reaches preparing_receiver when summary is unavailable', () => {
    const handoff = TaskHandoff.create({
      operationId: 'op-unavail',
      source: { backend: 'claude-cli' },
      target: { backend: 'codex' },
      now: '2026-07-14T10:00:00.000Z',
    });
    const advanced = advanceHandoffWithSourceSummary({
      handoff,
      messages: [],
      now: '2026-07-14T10:01:00.000Z',
      summary: { kind: 'unavailable', reason: 'source refused summary' },
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) throw new Error(advanced.reason);
    expect(advanced.next.phase).toBe('preparing_receiver');
    expect(advanced.next.toState().sourceSummary).toEqual({
      status: 'unavailable',
      reason: 'source refused summary',
    });
  });
});

describe('HandoffPackage (S03 T01)', () => {
  const baseMessages: TaskMessage[] = [
    {
      id: 'm2',
      taskId: 't1',
      role: 'assistant',
      content: 'assistant reply',
      state: 'complete',
      createdAt: '2026-07-14T10:00:02.000Z',
    },
    {
      id: 'm1',
      taskId: 't1',
      role: 'user',
      content: 'display path',
      agentContent: 'full/agent/path',
      state: 'complete',
      createdAt: '2026-07-14T10:00:01.000Z',
    },
    {
      id: 'm-sys',
      taskId: 't1',
      role: 'system',
      content: 'system noise',
      state: 'complete',
      createdAt: '2026-07-14T10:00:00.000Z',
    },
    {
      id: 'm-pending',
      taskId: 't1',
      role: 'user',
      content: 'not yet visible',
      state: 'pending',
      createdAt: '2026-07-14T10:00:03.000Z',
    },
  ];

  it('rebuilds conversation from visible user/assistant messages only, ordered and agent-aware',
    () => {
      const rebuilt = rebuildHandoffConversation(baseMessages);
      expect(rebuilt.map((m) => m.id)).toEqual(['m1', 'm2']);
      expect(rebuilt[0]).toEqual({
        id: 'm1',
        role: 'user',
        content: 'full/agent/path',
      });
      expect(rebuilt[1]).toEqual({
        id: 'm2',
        role: 'assistant',
        content: 'assistant reply',
      });
    },
  );

  it('bounds conversation by message count, keeping the most recent messages',
    () => {
      const many: TaskMessage[] = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        taskId: 't1',
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `msg-${i}`,
        state: 'complete' as const,
        createdAt: `2026-07-14T10:00:0${i}.000Z`,
      }));
      const rebuilt = rebuildHandoffConversation(many, { maxMessages: 3 });
      expect(rebuilt.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
      expect(rebuilt[0].content).toBe('msg-2');
    },
  );

  it('bounds conversation by total char budget with head truncation marker',
    () => {
      const messages: TaskMessage[] = [
        {
          id: 'old',
          taskId: 't1',
          role: 'user',
          content: 'x'.repeat(80),
          state: 'complete',
          createdAt: '2026-07-14T10:00:00.000Z',
        },
        {
          id: 'new',
          taskId: 't1',
          role: 'assistant',
          content: 'y'.repeat(40),
          state: 'complete',
          createdAt: '2026-07-14T10:00:01.000Z',
        },
      ];
      const rebuilt = rebuildHandoffConversation(messages, { maxChars: 50 });
      expect(rebuilt.map((m) => m.id)).toEqual(['new']);
      expect(rebuilt[0].content).toBe('y'.repeat(40));
    },
  );

  it('builds a versioned conversation-only package without summary enrichment',
    () => {
      const handoff = TaskHandoff.create({
        operationId: 'op-pkg-1',
        source: { backend: 'claude-cli', model: 'sonnet', sessionId: 'sess-source' },
        target: { backend: 'codex', model: 'gpt-5' },
        now: '2026-07-14T10:00:00.000Z',
      });
      const advanced = advanceHandoffToPreparingReceiver({
        handoff,
        messages: baseMessages,
        now: '2026-07-14T10:01:00.000Z',
      });
      expect(advanced.ok).toBe(true);
      if (!advanced.ok) throw new Error(advanced.reason);

      const pkg = buildHandoffPackage({
        taskId: 't1',
        taskGoal: 'switch runtime',
        handoff: advanced.next,
        messages: baseMessages,
        builtAt: '2026-07-14T10:02:00.000Z',
      });

      expect(pkg.version).toBe(HANDOFF_PACKAGE_VERSION);
      expect(pkg.version).toBe(1);
      expect(pkg.operationId).toBe('op-pkg-1');
      expect(pkg.taskId).toBe('t1');
      expect(pkg.taskGoal).toBe('switch runtime');
      expect(pkg.builtAt).toBe('2026-07-14T10:02:00.000Z');
      expect(pkg.provenance).toEqual({
        sourceBackend: 'claude-cli',
        sourceModel: 'sonnet',
        targetBackend: 'codex',
        targetModel: 'gpt-5',
      });
      // Never carry source session id into the receiver package.
      expect(pkg.provenance).not.toHaveProperty('sourceSessionId');
      expect(pkg.provenance).not.toHaveProperty('sessionId');

      expect(pkg.conversation.map((m) => m.id)).toEqual(['m1', 'm2']);
      expect(pkg.conversation[0].content).toBe('full/agent/path');
      expect(pkg.sourceSummary).toBeUndefined();
      expect(pkg.continuationInstructions).toMatch(/continue/i);
      expect(pkg.continuationInstructions).toMatch(/do not address the user/i);

      // Digest of rebuilt conversation should match the order-stable export helper.
      const meta = exportConversationContextMetadata(
        baseMessages.filter((m) => m.role !== 'system' && m.state !== 'pending'),
        '2026-07-14T10:01:00.000Z',
      );
      // Package conversation uses agentContent; digest over package rows is independent.
      expect(pkg.conversationDigest.length).toBe(32);
      expect(pkg.conversationDigest).not.toContain('full/agent');
      expect(pkg.messageCount).toBe(2);
      expect(meta.messageCount).toBe(2);
    },
  );

  it('includes optional ephemeral source-summary text when provided (bounded)', () => {
    const handoff = TaskHandoff.create({
      operationId: 'op-pkg-sum',
      source: { backend: 'claude-cli' },
      target: { backend: 'codex' },
      now: '2026-07-14T10:00:00.000Z',
    });
    const advanced = advanceHandoffWithSourceSummary({
      handoff,
      messages: baseMessages,
      now: '2026-07-14T10:01:00.000Z',
      summary: {
        kind: 'ready',
        contentDigest: digestSourceSummaryText('short summary'),
        summarizedAt: '2026-07-14T10:01:00.000Z',
      },
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) throw new Error(advanced.reason);

    const longSummary = 'S'.repeat(MAX_HANDOFF_SOURCE_SUMMARY_CHARS + 50);
    const pkg = buildHandoffPackage({
      taskId: 't1',
      taskGoal: 'goal',
      handoff: advanced.next,
      messages: baseMessages,
      builtAt: '2026-07-14T10:02:00.000Z',
      sourceSummaryText: longSummary,
    });

    expect(pkg.sourceSummary).toBeDefined();
    expect(pkg.sourceSummary!.length).toBe(MAX_HANDOFF_SOURCE_SUMMARY_CHARS);
    expect(pkg.sourceSummary!.startsWith('S')).toBe(true);
    expect(pkg.conversation.length).toBeGreaterThan(0);
  });

  it('builds a bootstrap prompt with provenance, optional summary, and conversation',
    () => {
      const handoff = TaskHandoff.create({
        operationId: 'op-boot',
        source: { backend: 'claude-cli', model: 'sonnet', sessionId: 'sess-source' },
        target: { backend: 'codex', model: 'gpt-5' },
        now: '2026-07-14T10:00:00.000Z',
      });
      const advanced = advanceHandoffToPreparingReceiver({
        handoff,
        messages: baseMessages,
        now: '2026-07-14T10:01:00.000Z',
      });
      if (!advanced.ok) throw new Error(advanced.reason);

      const pkg = buildHandoffPackage({
        taskId: 'task-1',
        taskGoal: 'finish the feature',
        handoff: advanced.next,
        messages: baseMessages,
        builtAt: '2026-07-14T10:02:00.000Z',
        sourceSummaryText: 'Prior agent decided on option A.',
      });

      const prompt = buildHandoffBootstrapPrompt(pkg);
      expect(prompt).toContain('muster-handoff-package/v1');
      expect(prompt).toContain('task-1');
      expect(prompt).toContain('finish the feature');
      expect(prompt).toContain('claude-cli');
      expect(prompt).toContain('codex');
      expect(prompt).toContain('Prior agent decided on option A.');
      expect(prompt).toContain('full/agent/path');
      expect(prompt).toContain('assistant reply');
      expect(prompt).toMatch(/continue/i);
      // Bootstrap must never instruct resume of the source session.
      expect(prompt).not.toContain('sess-source');
      expect(prompt).not.toMatch(/resumeId|resume session/i);
    },
  );

  it('conversation-only bootstrap works when summary text is absent', () => {
    const handoff = TaskHandoff.create({
      operationId: 'op-conv-only',
      source: { backend: 'claude-cli' },
      target: { backend: 'codex' },
      now: '2026-07-14T10:00:00.000Z',
    });
    const advanced = advanceHandoffToPreparingReceiver({
      handoff,
      messages: baseMessages,
      now: '2026-07-14T10:01:00.000Z',
    });
    if (!advanced.ok) throw new Error(advanced.reason);

    const pkg = buildHandoffPackage({
      taskId: 't1',
      taskGoal: 'g',
      handoff: advanced.next,
      messages: baseMessages,
      builtAt: '2026-07-14T10:02:00.000Z',
    });
    const prompt = buildHandoffBootstrapPrompt(pkg);
    expect(prompt).toContain('muster-handoff-package/v1');
    expect(prompt).toMatch(/conversation only|no source summary|without a source summary/i);
    expect(prompt).not.toMatch(/^## Source summary$/m);
    expect(prompt).not.toContain('Prior agent decided');
  });

  it('defaults enforce package bounds constants', () => {
    expect(MAX_HANDOFF_CONVERSATION_MESSAGES).toBeGreaterThan(0);
    expect(MAX_HANDOFF_CONVERSATION_CHARS).toBeGreaterThan(0);
    expect(MAX_HANDOFF_SOURCE_SUMMARY_CHARS).toBeGreaterThan(0);
    expect(HANDOFF_PACKAGE_VERSION).toBe(1);
  });
});

describe('TaskEngine.requestRuntimeHandoff (skip-summary path)', () => {
  it('starts handoff, exports conversation metadata, and reaches preparing_receiver without rebinding', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
      clock: () => '2026-07-14T10:10:00.000Z',
    });

    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }

    const task = store.getTask(taskId)!;
    expect(task.handoff).toBeDefined();
    expect(task.handoff!.phase).toBe('preparing_receiver');
    expect(task.handoff!.conversationContext.status).toBe('ready');
    expect(task.handoff!.sourceSummary?.status).toBe('skipped');
    expect(task.handoff!.source.backend).toBe(before.backend);
    expect(task.handoff!.source.model).toBe(before.model);
    expect(task.handoff!.source.sessionId).toBe(before.committedSessionId);
    expect(task.handoff!.target.backend).toBe('codex');
    expect(task.handoff!.target.model).toBe('gpt-5');

    // S03 owns rebinding — keep source runtime binding on the task.
    expect(task.backend).toBe(before.backend);
    expect(task.model).toBe(before.model);
    expect(task.committedSessionId).toBe(before.committedSessionId);

    expect(result.value.operationId).toBe(task.handoff!.operationId);
    expect(result.value.phase).toBe('preparing_receiver');
    expect(result.value.diagnostics.phase).toBe('preparing_receiver');
    expect(result.value.diagnostics.sourceBackend).toBe('claude-cli');
    expect(result.value.diagnostics.targetBackend).toBe('codex');
    // Diagnostics stay free of digests / session ids.
    expect(result.value.diagnostics).not.toHaveProperty('contentDigest');
    expect(result.value.diagnostics).not.toHaveProperty('sessionId');
  });

  it('fails closed for missing task without mutating store tasks', async () => {
    const { store } = makeTempStore();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
    });
    const beforeRevision = store.getFile().revision;
    const result = await engine.requestRuntimeHandoff({
      taskId: 'missing',
      targetBackend: 'codex',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.reason).toMatch(/not found|missing/i);
    expect(store.getFile().revision).toBe(beforeRevision);
  });

  it('fails closed when a live turn is present', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    // Load the engine first — load-time orphan recovery can settle pre-existing
    // running turns. Seed the live turn after load so the gate sees it.
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
    });
    store.commit((draft) => {
      draft.turns['live-1'] = {
        id: 'live-1',
        taskId,
        sequence: 1,
        trigger: 'user',
        status: 'running',
        inputs: [],
        createdAt: '2026-07-14T10:00:00.000Z',
        startedAt: '2026-07-14T10:00:01.000Z',
      };
      return { ok: true };
    });
    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.reason).toMatch(/live|running|active turn/i);
    const after = store.getTask(taskId)!;
    expect(after.backend).toBe(before.backend);
    expect(after.model).toBe(before.model);
    expect(after.committedSessionId).toBe(before.committedSessionId);
    expect(after.handoff).toBeUndefined();
  });

  it('fails closed when an active handoff already exists', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const existing = TaskHandoff.create({
      operationId: 'op-existing',
      source: { backend: 'claude-cli', model: 'sonnet', sessionId: 'sess-source' },
      target: { backend: 'codex', model: 'gpt-5' },
      now: '2026-07-14T10:00:00.000Z',
    });
    store.commit((draft) => {
      draft.tasks[taskId] = {
        ...draft.tasks[taskId],
        handoff: existing.toState(),
        revision: draft.tasks[taskId].revision + 1,
        updatedAt: '2026-07-14T10:00:00.000Z',
      };
      return { ok: true };
    });
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
    });
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.reason).toMatch(/active handoff|handoff in progress/i);
    expect(store.getTask(taskId)!.handoff?.operationId).toBe('op-existing');
  });

  it('fails closed for non-MCP target without mutating binding', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) =>
        scriptedBackend(
          [],
          name === 'legacy'
            ? {
                supportsReasoning: false,
                supportsDetailedToolEvents: false,
                supportsMCP: false,
                supportsLiveInput: false,
              }
            : MCP_CAPS,
        ),
    });
    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'legacy',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.reason).toMatch(/MCP|backend/i);
    const after = store.getTask(taskId)!;
    expect(after.backend).toBe(before.backend);
    expect(after.model).toBe(before.model);
    expect(after.committedSessionId).toBe(before.committedSessionId);
    expect(after.handoff).toBeUndefined();
  });
});

describe('TaskEngine.requestRuntimeHandoff (hidden source-summary path)', () => {
  it('runs internal summary turn, digests response, hides text from transcript, keeps source binding', async () => {
    const SUMMARY_TEXT = 'INTERNAL_HANDOFF_SUMMARY_BODY_UNIQUE';
    const { store, taskId } = seedIdleTaskWithMessages();
    const messageCountBefore = Object.keys(store.getFile().messages).length;
    const turnCountBefore = Object.keys(store.getFile().turns).length;
    const captured: RunOptions[] = [];
    const engineEvents: unknown[] = [];

    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        captured.push(options);
        yield {
          type: 'assistantDelta',
          content: SUMMARY_TEXT,
          messageId: 'hidden-summary',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-14T10:20:00.000Z',
      emit: (e) => {
        engineEvents.push(e);
      },
    });

    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    // Source backend was asked with the hidden handoff prompt + source session/model.
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe(HANDOFF_SOURCE_SUMMARY_PROMPT);
    expect(captured[0].resumeId).toBe(before.committedSessionId);
    expect(captured[0].model).toBe(before.model);

    const task = store.getTask(taskId)!;
    expect(task.handoff!.phase).toBe('preparing_receiver');
    expect(task.handoff!.conversationContext.status).toBe('ready');
    expect(task.handoff!.sourceSummary?.status).toBe('ready');
    if (task.handoff!.sourceSummary?.status === 'ready') {
      expect(task.handoff!.sourceSummary.contentDigest).toBe(
        digestSourceSummaryText(SUMMARY_TEXT),
      );
      expect(task.handoff!.sourceSummary.contentDigest).not.toContain(SUMMARY_TEXT);
    }

    // No TaskMessage / TaskTurn leakage from the internal turn.
    expect(Object.keys(store.getFile().messages).length).toBe(messageCountBefore);
    expect(Object.keys(store.getFile().turns).length).toBe(turnCountBefore);

    // Transcript stays free of handoff prompt/response text.
    const transcript = buildTranscript(store.getFile(), taskId);
    const blob = JSON.stringify(transcript);
    expect(blob).not.toContain(SUMMARY_TEXT);
    expect(blob).not.toContain(HANDOFF_SOURCE_SUMMARY_PROMPT);
    expect(blob).not.toContain('INTERNAL_HANDOFF');

    // Old runtime binding held until S03.
    expect(task.backend).toBe(before.backend);
    expect(task.model).toBe(before.model);
    expect(task.committedSessionId).toBe(before.committedSessionId);

    // Hidden path must not emit ordinary engine turn events.
    expect(engineEvents).toHaveLength(0);

    expect(result.value.diagnostics.sourceSummaryStatus).toBe('ready');
    expect(result.value.diagnostics).not.toHaveProperty('contentDigest');
  });

  it('marks summary unavailable and still reaches preparing_receiver on source-summary failure', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const messageCountBefore = Object.keys(store.getFile().messages).length;
    const turnCountBefore = Object.keys(store.getFile().turns).length;

    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* () {
        yield {
          type: 'error',
          message: 'source refused summary',
        };
      },
      clock: () => '2026-07-14T10:21:00.000Z',
    });

    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const task = store.getTask(taskId)!;
    expect(task.handoff!.phase).toBe('preparing_receiver');
    expect(task.handoff!.conversationContext.status).toBe('ready');
    expect(task.handoff!.sourceSummary).toEqual({
      status: 'unavailable',
      reason: 'source refused summary',
    });
    expect(Object.keys(store.getFile().messages).length).toBe(messageCountBefore);
    expect(Object.keys(store.getFile().turns).length).toBe(turnCountBefore);
    expect(task.backend).toBe(before.backend);
    expect(task.model).toBe(before.model);
    expect(task.committedSessionId).toBe(before.committedSessionId);
  });

  it('marks summary unavailable when runTurn throws and still advances', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* () {
        throw new Error('backend crashed during summary');
        yield { type: 'turnCompleted' }; // unreachable, keeps AsyncGenerator typing
      },
      clock: () => '2026-07-14T10:22:00.000Z',
    });

    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const task = store.getTask(taskId)!;
    expect(task.handoff!.phase).toBe('preparing_receiver');
    expect(task.handoff!.sourceSummary?.status).toBe('unavailable');
    if (task.handoff!.sourceSummary?.status === 'unavailable') {
      expect(task.handoff!.sourceSummary.reason).toMatch(/backend crashed/i);
    }
  });
});

describe('TaskEngine.requestRuntimeHandoff isolation + fail-closed gates (S02 demo)', () => {
  it('keeps old runtime binding through reload while handoff is preparing_receiver', async () => {
    const { store, taskId, filePath } = seedIdleTaskWithMessages({
      backend: 'claude-cli',
      model: 'sonnet',
      sessionId: 'sess-source-hold',
    });
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
      clock: () => '2026-07-14T10:30:00.000Z',
    });

    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const mid = store.getTask(taskId)!;
    expect(mid.handoff!.phase).toBe('preparing_receiver');
    expect(mid.backend).toBe(before.backend);
    expect(mid.model).toBe(before.model);
    expect(mid.committedSessionId).toBe(before.committedSessionId);

    // Reload proves durable binding hold until S03 receiver setup rebinds.
    const reloaded = TaskStore.load({ filePath });
    const after = reloaded.getTask(taskId)!;
    expect(after.handoff?.phase).toBe('preparing_receiver');
    expect(after.backend).toBe('claude-cli');
    expect(after.model).toBe('sonnet');
    expect(after.committedSessionId).toBe('sess-source-hold');
    expect(after.handoff?.target.backend).toBe('codex');
    expect(after.handoff?.target.model).toBe('gpt-5');
  });

  it('hides handoff metadata from snapshot and markdown export projections', async () => {
    const SUMMARY_TEXT = 'MD_EXPORT_HANDOFF_SUMMARY_CANARY';
    const { store, taskId } = seedIdleTaskWithMessages({
      messages: [
        { id: 'm1', role: 'user', content: 'visible user chat only' },
        { id: 'm2', role: 'assistant', content: 'visible assistant chat only' },
      ],
    });

    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* () {
        yield {
          type: 'assistantDelta',
          content: SUMMARY_TEXT,
          messageId: 'hidden-md',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-14T10:31:00.000Z',
    });

    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const task = store.getTask(taskId)!;
    expect(task.handoff!.phase).toBe('preparing_receiver');
    expect(task.handoff!.sourceSummary?.status).toBe('ready');

    const digest =
      task.handoff!.sourceSummary?.status === 'ready'
        ? task.handoff!.sourceSummary.contentDigest
        : '';
    const operationId = task.handoff!.operationId;

    const snapshot = buildSnapshot(store, taskId);
    const transcriptJson = JSON.stringify(snapshot.transcript);
    const summaryJson = JSON.stringify({
      roots: snapshot.rootTasks,
      subtree: snapshot.subtree,
    });
    // Chat transcript must omit all handoff internals, including operationId.
    for (const needle of [
      SUMMARY_TEXT,
      HANDOFF_SOURCE_SUMMARY_PROMPT,
      digest,
      operationId,
      'MD_EXPORT_HANDOFF',
    ]) {
      expect(transcriptJson, `transcript must not contain ${needle}`).not.toContain(needle);
    }
    // S04 intentionally projects sanitized handoffProgress (includes operationId) on task summaries.
    // Digests/prompts/summary bodies remain forbidden on that surface.
    for (const needle of [SUMMARY_TEXT, HANDOFF_SOURCE_SUMMARY_PROMPT, digest, 'MD_EXPORT_HANDOFF']) {
      expect(summaryJson, `snapshot summaries must not contain ${needle}`).not.toContain(needle);
    }
    const progress = snapshot.rootTasks.find((t) => t.id === taskId)?.handoffProgress;
    expect(progress?.operationId).toBe(operationId);
    expect(progress?.phase).toBe('preparing_receiver');

    const exported = renderTaskMarkdownExport(store.getFile(), taskId, {
      exportedAt: '2026-07-14T10:31:00.000Z',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error(exported.code);
    expect(exported.markdown).toContain('visible user chat only');
    expect(exported.markdown).toContain('visible assistant chat only');
    // Export surfaces task id/goal metadata, but never handoff digests/prompts/summary text.
    for (const needle of [SUMMARY_TEXT, HANDOFF_SOURCE_SUMMARY_PROMPT, digest, operationId]) {
      expect(exported.markdown, `markdown export must not contain ${needle}`).not.toContain(
        needle,
      );
    }
  });

  it('fails closed when a queued turn is present without mutating binding', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
    });
    store.commit((draft) => {
      draft.turns['queued-1'] = {
        id: 'queued-1',
        taskId,
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: '2026-07-14T10:00:00.000Z',
      };
      return { ok: true };
    });
    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/live|active turn|queued/i);
    const after = store.getTask(taskId)!;
    expect(after.backend).toBe(before.backend);
    expect(after.model).toBe(before.model);
    expect(after.committedSessionId).toBe(before.committedSessionId);
    expect(after.handoff).toBeUndefined();
  });

  it('fails closed when a waiting_user turn is present without mutating binding', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const engine = TaskEngine.load({
      store,
      makeBackend: () => scriptedBackend(),
    });
    store.commit((draft) => {
      draft.turns['wait-1'] = {
        id: 'wait-1',
        taskId,
        sequence: 1,
        trigger: 'user',
        status: 'waiting_user',
        inputs: [],
        createdAt: '2026-07-14T10:00:00.000Z',
        startedAt: '2026-07-14T10:00:01.000Z',
      };
      return { ok: true };
    });
    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/live|active turn/i);
    const after = store.getTask(taskId)!;
    expect(after.backend).toBe(before.backend);
    expect(after.model).toBe(before.model);
    expect(after.committedSessionId).toBe(before.committedSessionId);
    expect(after.handoff).toBeUndefined();
  });

  it('fails closed when target backend factory throws without mutating binding', async () => {
    const { store, taskId } = seedIdleTaskWithMessages();
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => {
        if (name === 'missing-cli') {
          throw new Error('CLI binary not found');
        }
        return scriptedBackend([], MCP_CAPS, name);
      },
    });
    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'missing-cli',
      skipSummary: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/target backend unavailable|CLI binary/i);
    const after = store.getTask(taskId)!;
    expect(after.backend).toBe(before.backend);
    expect(after.model).toBe(before.model);
    expect(after.committedSessionId).toBe(before.committedSessionId);
    expect(after.handoff).toBeUndefined();
  });

  it('does not rebind runtime when source summary path succeeds against a different target model', async () => {
    // Slice demo: request model switch + hidden handoff turn; stay on old runtime.
    const SUMMARY_TEXT = 'DEMO_INTERNAL_SUMMARY_BODY';
    const { store, taskId } = seedIdleTaskWithMessages({
      backend: 'claude-cli',
      model: 'sonnet',
      sessionId: 'sess-demo-source',
    });
    const captured: RunOptions[] = [];
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        captured.push(options);
        yield {
          type: 'assistantDelta',
          content: SUMMARY_TEXT,
          messageId: 'demo-hidden',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-14T10:32:00.000Z',
    });

    const before = store.getTask(taskId)!;
    const result = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5.1',
      skipSummary: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe(HANDOFF_SOURCE_SUMMARY_PROMPT);
    expect(captured[0].resumeId).toBe('sess-demo-source');
    expect(captured[0].model).toBe('sonnet');

    const task = store.getTask(taskId)!;
    expect(task.handoff!.phase).toBe('preparing_receiver');
    expect(task.handoff!.target).toEqual({ backend: 'codex', model: 'gpt-5.1' });
    expect(task.backend).toBe(before.backend);
    expect(task.model).toBe(before.model);
    expect(task.committedSessionId).toBe(before.committedSessionId);

    const transcript = JSON.stringify(buildTranscript(store.getFile(), taskId));
    expect(transcript).not.toContain(SUMMARY_TEXT);
    expect(transcript).not.toContain(HANDOFF_SOURCE_SUMMARY_PROMPT);
  });
});

describe('TaskEngine.completeRuntimeHandoff (S03 T02)', () => {
  it('transfers preparing_receiver → completed with new target session and no source resumeId', async () => {
    const SOURCE_SESSION = 'sess-source-hold';
    const TARGET_SESSION = 'sess-target-new';
    const SUMMARY_TEXT = 'EPHEMERAL_SUMMARY_FOR_RECEIVER';
    const { store, taskId } = seedIdleTaskWithMessages({
      backend: 'claude-cli',
      model: 'sonnet',
      sessionId: SOURCE_SESSION,
    });

    const captured: Array<{ backend: string; options: RunOptions }> = [];
    let clock = '2026-07-14T11:00:00.000Z';
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (backend: Backend, options: RunOptions) {
        captured.push({ backend: backend.name, options });
        if (options.prompt === HANDOFF_SOURCE_SUMMARY_PROMPT) {
          yield {
            type: 'assistantDelta',
            content: SUMMARY_TEXT,
            messageId: 'hidden-summary',
          };
          yield { type: 'turnCompleted' };
          return;
        }
        // Receiver bootstrap turn — new session, no resumeId.
        yield { type: 'sessionStarted', sessionId: TARGET_SESSION };
        yield { type: 'assistantDelta', content: 'receiver ready', messageId: 'recv' };
        yield { type: 'turnCompleted' };
      },
      clock: () => clock,
    });

    const requested = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: false,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error(requested.reason);
    expect(store.getTask(taskId)!.handoff!.phase).toBe('preparing_receiver');
    expect(store.getTask(taskId)!.committedSessionId).toBe(SOURCE_SESSION);

    // Source summary turn used source session; not target.
    expect(captured).toHaveLength(1);
    expect(captured[0].backend).toBe('claude-cli');
    expect(captured[0].options.resumeId).toBe(SOURCE_SESSION);
    expect(captured[0].options.prompt).toBe(HANDOFF_SOURCE_SUMMARY_PROMPT);

    clock = '2026-07-14T11:01:00.000Z';
    const transferred = await engine.completeRuntimeHandoff({
      taskId,
      operationId: requested.value.operationId,
    });
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error(transferred.reason);

    expect(transferred.value.phase).toBe('completed');
    expect(transferred.value.boundBackend).toBe('codex');
    expect(transferred.value.boundSessionId).toBe(TARGET_SESSION);

    const task = store.getTask(taskId)!;
    expect(task.handoff!.phase).toBe('completed');
    expect(task.backend).toBe('codex');
    expect(task.model).toBe('gpt-5');
    expect(task.committedSessionId).toBe(TARGET_SESSION);
    expect(task.committedSessionId).not.toBe(SOURCE_SESSION);
    expect(task.handoff!.completion?.boundBackend).toBe('codex');
    expect(task.handoff!.completion?.boundSessionId).toBe(TARGET_SESSION);

    // Receiver init: target backend, bootstrap package prompt, no resumeId/source session.
    expect(captured).toHaveLength(2);
    expect(captured[1].backend).toBe('codex');
    expect(captured[1].options.resumeId).toBeUndefined();
    expect(captured[1].options.model).toBe('gpt-5');
    expect(captured[1].options.prompt).toContain('muster-handoff-package/v1');
    expect(captured[1].options.prompt).toContain(SUMMARY_TEXT);
    expect(captured[1].options.prompt).toContain('hello world');
    expect(captured[1].options.prompt).not.toContain(SOURCE_SESSION);
    expect(captured[1].options.prompt).not.toMatch(/resumeId|resume session/i);

    // Bootstrap/summary never become TaskMessage/TaskTurn rows or transcript.
    const transcript = JSON.stringify(buildTranscript(store.getFile(), taskId));
    expect(transcript).not.toContain(SUMMARY_TEXT);
    expect(transcript).not.toContain('muster-handoff-package/v1');
    expect(transcript).not.toContain(HANDOFF_SOURCE_SUMMARY_PROMPT);
    for (const message of Object.values(store.getFile().messages)) {
      expect(message.content).not.toContain(SUMMARY_TEXT);
      expect(message.content).not.toContain('muster-handoff-package');
    }
  });

  it('keeps source binding when receiver init fails and records handoff.failure', async () => {
    const SOURCE_SESSION = 'sess-source-fail';
    const { store, taskId } = seedIdleTaskWithMessages({
      sessionId: SOURCE_SESSION,
    });
    let clock = '2026-07-14T11:10:00.000Z';
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        if (options.prompt === HANDOFF_SOURCE_SUMMARY_PROMPT) {
          yield { type: 'turnCompleted' };
          return;
        }
        yield { type: 'error', message: 'target session refused bootstrap' };
      },
      clock: () => clock,
    });

    const requested = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: true,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error(requested.reason);

    const before = store.getTask(taskId)!;
    clock = '2026-07-14T11:11:00.000Z';
    const transferred = await engine.completeRuntimeHandoff({ taskId });
    expect(transferred.ok).toBe(false);
    if (transferred.ok) throw new Error('expected transfer failure');
    expect(transferred.reason).toMatch(/refused bootstrap/i);

    const after = store.getTask(taskId)!;
    expect(after.backend).toBe(before.backend);
    expect(after.model).toBe(before.model);
    expect(after.committedSessionId).toBe(SOURCE_SESSION);
    expect(after.handoff?.phase).toBe('failed');
    expect(after.handoff?.failure?.code).toBe('receiver_init_failed');
    expect(after.handoff?.failure?.message).toMatch(/refused bootstrap/i);
  });

  it('conversation-only transfer works when summary text was skipped', async () => {
    const TARGET_SESSION = 'sess-target-conv-only';
    const { store, taskId } = seedIdleTaskWithMessages();
    const captured: RunOptions[] = [];
    let clock = '2026-07-14T11:20:00.000Z';
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        captured.push(options);
        yield { type: 'sessionStarted', sessionId: TARGET_SESSION };
        yield { type: 'turnCompleted' };
      },
      clock: () => clock,
    });

    const requested = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      skipSummary: true,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error(requested.reason);

    clock = '2026-07-14T11:21:00.000Z';
    const transferred = await engine.completeRuntimeHandoff({ taskId });
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error(transferred.reason);
    expect(transferred.value.boundSessionId).toBe(TARGET_SESSION);
    expect(captured).toHaveLength(1);
    expect(captured[0].resumeId).toBeUndefined();
    expect(captured[0].prompt).toContain('muster-handoff-package/v1');
    expect(captured[0].prompt).toMatch(/conversation only|no source summary|without a source summary/i);
    expect(store.getTask(taskId)!.backend).toBe('codex');
    expect(store.getTask(taskId)!.committedSessionId).toBe(TARGET_SESSION);
  });
});

describe('TaskEngine.completeRuntimeHandoff (S03 T03 proof)', () => {
  it('reload at preparing_receiver transfers conversation-only without re-querying source CLI', async () => {
    const SOURCE_SESSION = 'sess-source-reload';
    const TARGET_SESSION = 'sess-target-after-reload';
    const SUMMARY_TEXT = 'RELOAD_EPHEMERAL_SUMMARY_CANARY';
    const { store, taskId, filePath } = seedIdleTaskWithMessages({
      backend: 'claude-cli',
      model: 'sonnet',
      sessionId: SOURCE_SESSION,
      messages: [
        { id: 'm1', role: 'user', content: 'reload visible user' },
        { id: 'm2', role: 'assistant', content: 'reload visible assistant' },
      ],
    });

    const sourceCaptured: RunOptions[] = [];
    const firstEngine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        sourceCaptured.push(options);
        yield {
          type: 'assistantDelta',
          content: SUMMARY_TEXT,
          messageId: 'hidden-reload',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-14T12:00:00.000Z',
    });

    const requested = await firstEngine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: false,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error(requested.reason);
    expect(sourceCaptured).toHaveLength(1);
    expect(sourceCaptured[0].resumeId).toBe(SOURCE_SESSION);
    expect(store.getTask(taskId)!.handoff!.phase).toBe('preparing_receiver');
    // Digest may survive reload; raw summary text must not be in the store.
    const storeJson = JSON.stringify(store.getFile());
    expect(storeJson).not.toContain(SUMMARY_TEXT);

    // Process restart: new engine + reloaded store drops ephemeral summary cache.
    const reloaded = TaskStore.load({ filePath });
    const reloadedTask = reloaded.getTask(taskId)!;
    expect(reloadedTask.handoff?.phase).toBe('preparing_receiver');
    expect(reloadedTask.backend).toBe('claude-cli');
    expect(reloadedTask.committedSessionId).toBe(SOURCE_SESSION);

    const transferCaptured: Array<{ backend: string; options: RunOptions }> = [];
    const secondEngine = TaskEngine.load({
      store: reloaded,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (backend: Backend, options: RunOptions) {
        transferCaptured.push({ backend: backend.name, options });
        // Must not re-run source summary (no HANDOFF_SOURCE_SUMMARY_PROMPT).
        yield { type: 'sessionStarted', sessionId: TARGET_SESSION };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-14T12:05:00.000Z',
    });

    const transferred = await secondEngine.completeRuntimeHandoff({
      taskId,
      operationId: requested.value.operationId,
    });
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error(transferred.reason);

    expect(transferred.value.boundSessionId).toBe(TARGET_SESSION);
    expect(transferred.value.boundBackend).toBe('codex');
    // Exactly one receiver init — no hidden source-summary re-query after reload.
    expect(transferCaptured).toHaveLength(1);
    expect(transferCaptured[0].backend).toBe('codex');
    expect(transferCaptured[0].options.resumeId).toBeUndefined();
    expect(transferCaptured[0].options.prompt).toContain('muster-handoff-package/v1');
    expect(transferCaptured[0].options.prompt).toContain('reload visible user');
    expect(transferCaptured[0].options.prompt).toContain('reload visible assistant');
    expect(transferCaptured[0].options.prompt).toMatch(
      /conversation only|no source summary|without a source summary/i,
    );
    expect(transferCaptured[0].options.prompt).not.toContain(SUMMARY_TEXT);
    expect(transferCaptured[0].options.prompt).not.toContain(SOURCE_SESSION);
    expect(transferCaptured[0].options.prompt).not.toBe(HANDOFF_SOURCE_SUMMARY_PROMPT);

    const after = reloaded.getTask(taskId)!;
    expect(after.backend).toBe('codex');
    expect(after.model).toBe('gpt-5');
    expect(after.committedSessionId).toBe(TARGET_SESSION);
    expect(after.committedSessionId).not.toBe(SOURCE_SESSION);
    expect(after.handoff?.phase).toBe('completed');
  });

  it('never reuses source or sibling session ids across tasks', async () => {
    const SOURCE_A = 'sess-source-a';
    const SOURCE_B = 'sess-source-b';
    const TARGET_A = 'sess-target-a-unique';
    const TARGET_B = 'sess-target-b-unique';

    const { store: storeA, taskId: taskA } = seedIdleTaskWithMessages({
      sessionId: SOURCE_A,
      messages: [
        { id: 'a1', role: 'user', content: 'task A user' },
        { id: 'a2', role: 'assistant', content: 'task A assistant' },
      ],
    });
    const { store: storeB, taskId: taskB } = seedIdleTaskWithMessages({
      sessionId: SOURCE_B,
      messages: [
        { id: 'b1', role: 'user', content: 'task B user' },
        { id: 'b2', role: 'assistant', content: 'task B assistant' },
      ],
    });

    async function transferTask(
      store: TaskStore,
      taskId: string,
      sourceSession: string,
      targetSession: string,
    ): Promise<RunOptions> {
      const captured: RunOptions[] = [];
      let clock = '2026-07-14T12:10:00.000Z';
      const engine = TaskEngine.load({
        store,
        makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
        runTurn: async function* (_backend: Backend, options: RunOptions) {
          captured.push(options);
          yield { type: 'sessionStarted', sessionId: targetSession };
          yield { type: 'turnCompleted' };
        },
        clock: () => clock,
      });
      const requested = await engine.requestRuntimeHandoff({
        taskId,
        targetBackend: 'codex',
        targetModel: 'gpt-5',
        skipSummary: true,
      });
      expect(requested.ok).toBe(true);
      if (!requested.ok) throw new Error(requested.reason);
      clock = '2026-07-14T12:11:00.000Z';
      const transferred = await engine.completeRuntimeHandoff({ taskId });
      expect(transferred.ok).toBe(true);
      if (!transferred.ok) throw new Error(transferred.reason);
      expect(transferred.value.boundSessionId).toBe(targetSession);
      expect(transferred.value.boundSessionId).not.toBe(sourceSession);
      expect(store.getTask(taskId)!.committedSessionId).toBe(targetSession);
      expect(captured).toHaveLength(1);
      expect(captured[0].resumeId).toBeUndefined();
      return captured[0];
    }

    const optsA = await transferTask(storeA, taskA, SOURCE_A, TARGET_A);
    const optsB = await transferTask(storeB, taskB, SOURCE_B, TARGET_B);

    // Distinct new sessions; neither reuses either source id.
    expect(storeA.getTask(taskA)!.committedSessionId).toBe(TARGET_A);
    expect(storeB.getTask(taskB)!.committedSessionId).toBe(TARGET_B);
    expect(storeA.getTask(taskA)!.committedSessionId).not.toBe(
      storeB.getTask(taskB)!.committedSessionId,
    );
    expect(optsA.prompt).not.toContain(SOURCE_A);
    expect(optsA.prompt).not.toContain(SOURCE_B);
    expect(optsB.prompt).not.toContain(SOURCE_A);
    expect(optsB.prompt).not.toContain(SOURCE_B);
    // Bootstrap provenance carries backends/models, not session ids.
    expect(optsA.prompt).toContain('claude-cli');
    expect(optsA.prompt).toContain('codex');
    expect(optsA.prompt).toMatch(/continue/i);
  });

  it('keeps bootstrap prompt and summary out of transcript, snapshot, and markdown after transfer', async () => {
    const SOURCE_SESSION = 'sess-source-proj';
    const TARGET_SESSION = 'sess-target-proj';
    const SUMMARY_TEXT = 'PROJECTION_ISOLATION_SUMMARY_CANARY';
    const { store, taskId } = seedIdleTaskWithMessages({
      sessionId: SOURCE_SESSION,
      messages: [
        { id: 'm1', role: 'user', content: 'visible projection user' },
        { id: 'm2', role: 'assistant', content: 'visible projection assistant' },
      ],
    });

    const messageCountBefore = Object.keys(store.getFile().messages).length;
    const turnCountBefore = Object.keys(store.getFile().turns).length;
    let bootstrapPrompt = '';
    let clock = '2026-07-14T12:20:00.000Z';
    const engine = TaskEngine.load({
      store,
      makeBackend: (name) => scriptedBackend([], MCP_CAPS, name),
      runTurn: async function* (_backend: Backend, options: RunOptions) {
        if (options.prompt === HANDOFF_SOURCE_SUMMARY_PROMPT) {
          yield {
            type: 'assistantDelta',
            content: SUMMARY_TEXT,
            messageId: 'hidden-proj',
          };
          yield { type: 'turnCompleted' };
          return;
        }
        bootstrapPrompt = options.prompt ?? '';
        yield { type: 'sessionStarted', sessionId: TARGET_SESSION };
        yield { type: 'turnCompleted' };
      },
      clock: () => clock,
    });

    const requested = await engine.requestRuntimeHandoff({
      taskId,
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: false,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error(requested.reason);

    clock = '2026-07-14T12:21:00.000Z';
    const transferred = await engine.completeRuntimeHandoff({ taskId });
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error(transferred.reason);
    expect(bootstrapPrompt).toContain('muster-handoff-package/v1');
    expect(bootstrapPrompt).toContain(SUMMARY_TEXT);

    // No new chat/turn rows from bootstrap or summary.
    expect(Object.keys(store.getFile().messages).length).toBe(messageCountBefore);
    expect(Object.keys(store.getFile().turns).length).toBe(turnCountBefore);

    const operationId = requested.value.operationId;
    // Secrets / bodies / bootstrap never appear on any projection surface.
    const secretNeedles = [
      SUMMARY_TEXT,
      HANDOFF_SOURCE_SUMMARY_PROMPT,
      'muster-handoff-package/v1',
      bootstrapPrompt.slice(0, 80),
    ];

    const transcript = JSON.stringify(buildTranscript(store.getFile(), taskId));
    expect(transcript).toContain('visible projection user');
    expect(transcript).toContain('visible projection assistant');
    for (const needle of [...secretNeedles, operationId]) {
      expect(transcript, `transcript must not contain ${needle}`).not.toContain(needle);
    }

    const snapshot = buildSnapshot(store, taskId);
    const snapshotBlob = JSON.stringify({
      transcript: snapshot.transcript,
      roots: snapshot.rootTasks,
      subtree: snapshot.subtree,
    });
    for (const needle of secretNeedles) {
      expect(snapshotBlob, `snapshot must not contain ${needle}`).not.toContain(needle);
    }
    // S04 projects sanitized handoffProgress (operationId allowed) on task summaries only.
    const progress = snapshot.rootTasks.find((t) => t.id === taskId)?.handoffProgress;
    expect(progress?.operationId).toBe(operationId);
    expect(progress?.phase).toBe('completed');
    expect(JSON.stringify(snapshot.transcript)).not.toContain(operationId);

    const exported = renderTaskMarkdownExport(store.getFile(), taskId, {
      exportedAt: '2026-07-14T12:21:00.000Z',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error(exported.code);
    expect(exported.markdown).toContain('visible projection user');
    expect(exported.markdown).toContain('visible projection assistant');
    for (const needle of [SUMMARY_TEXT, HANDOFF_SOURCE_SUMMARY_PROMPT, 'muster-handoff-package/v1', operationId]) {
      expect(exported.markdown, `markdown must not contain ${needle}`).not.toContain(needle);
    }

    // Diagnostics stay sanitized (no summary body / session ids).
    expect(transferred.value.diagnostics.phase).toBe('completed');
    expect(JSON.stringify(transferred.value.diagnostics)).not.toContain(SUMMARY_TEXT);
    expect(transferred.value.diagnostics).not.toHaveProperty('sessionId');
  });
});
