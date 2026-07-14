import { describe, expect, it } from 'vitest';
import { TRUNCATION_MARKER } from '../task/retention';
import type { MusterTask, TaskMessage, TaskStoreFile, TaskTurn } from '../task/types';
import {
  DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS,
  TASK_MARKDOWN_EXPORT_FORMAT,
  renderTaskMarkdownExport,
  suggestTaskMarkdownFilename,
} from './task-markdown-export';

const POLICY = {
  maxTurns: 10,
  maxAutomaticRetries: 1,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 300_000,
};

const EXPORTED_AT = '2026-07-14T12:00:00.000Z';

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

function turn(
  overrides: Partial<TaskTurn> & Pick<TaskTurn, 'id' | 'taskId' | 'status' | 'sequence'>,
): TaskTurn {
  return {
    trigger: 'user',
    inputs: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function message(
  overrides: Partial<TaskMessage> & Pick<TaskMessage, 'id' | 'taskId' | 'role' | 'content'>,
): TaskMessage {
  return {
    state: 'complete',
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function baseFile(overrides: Partial<TaskStoreFile> = {}): TaskStoreFile {
  return {
    schemaVersion: 3,
    revision: 11,
    tasks: {
      'task-a': task('task-a', {
        goal: 'Ship readable export',
        lifecycle: 'succeeded',
        backend: 'claude',
        model: 'sonnet',
        finishedAt: '2026-07-06T01:00:00.000Z',
      }),
    },
    turns: {
      t1: turn({
        id: 't1',
        taskId: 'task-a',
        status: 'succeeded',
        sequence: 1,
        inputs: [{ kind: 'message', messageId: 'u1' }],
        finishedAt: '2026-07-06T00:10:00.000Z',
      }),
    },
    messages: {
      u1: message({
        id: 'u1',
        taskId: 'task-a',
        role: 'user',
        content: 'Please summarize the plan.',
        createdAt: '2026-07-06T00:09:00.000Z',
        turnId: 't1',
      }),
      a1: message({
        id: 'a1',
        taskId: 'task-a',
        role: 'assistant',
        content: 'Here is the plan overview.',
        createdAt: '2026-07-06T00:09:30.000Z',
        turnId: 't1',
        order: 0,
      }),
    },
    operations: {},
    cancelRequests: {},
    ...overrides,
  };
}

describe('renderTaskMarkdownExport', () => {
  it('renders a versioned point-in-time Markdown document for one task', () => {
    const file = baseFile();
    const result = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });

    expect(result).toEqual({
      ok: true,
      markdown: expect.any(String),
      suggestedFilename: 'ship-readable-export.md',
      sourceRevision: 11,
      exportedAt: EXPORTED_AT,
      taskId: 'task-a',
    });
    if (!result.ok) return;

    expect(result.markdown.startsWith(`<!-- ${TASK_MARKDOWN_EXPORT_FORMAT} -->`)).toBe(true);
    expect(result.markdown).toContain('point-in-time');
    expect(result.markdown).toContain('Ship readable export');
    expect(result.markdown).toContain('task-a');
    expect(result.markdown).toContain('succeeded');
    expect(result.markdown).toContain('claude');
    expect(result.markdown).toContain('sonnet');
    expect(result.markdown).toContain('11');
    expect(result.markdown).toContain(EXPORTED_AT);
    expect(result.markdown).toContain('### User');
    expect(result.markdown).toContain('Please summarize the plan.');
    expect(result.markdown).toContain('### Assistant');
    expect(result.markdown).toContain('Here is the plan overview.');
    expect(DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS).toBeGreaterThan(0);
  });

  it('is deterministic for identical inputs and options', () => {
    const file = baseFile();
    const a = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    const b = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(a).toEqual(b);
  });

  it('does not mutate the input TaskStoreFile', () => {
    const file = baseFile();
    const before = JSON.stringify(file);
    renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(JSON.stringify(file)).toBe(before);
  });

  it('preserves canonical transcript order across turn sequence, segment order, and timestamps', () => {
    const file = baseFile({
      turns: {
        t2: turn({
          id: 't2',
          taskId: 'task-a',
          status: 'succeeded',
          sequence: 2,
          inputs: [{ kind: 'message', messageId: 'u2' }],
          createdAt: '2026-07-06T00:20:00.000Z',
        }),
        t1: turn({
          id: 't1',
          taskId: 'task-a',
          status: 'succeeded',
          sequence: 1,
          inputs: [{ kind: 'message', messageId: 'u1' }],
          createdAt: '2026-07-06T00:10:00.000Z',
        }),
      },
      messages: {
        u2: message({
          id: 'u2',
          taskId: 'task-a',
          role: 'user',
          content: 'second user',
          createdAt: '2026-07-06T00:20:00.000Z',
          turnId: 't2',
        }),
        a1b: message({
          id: 'a1b',
          taskId: 'task-a',
          role: 'assistant',
          content: 'assistant later segment',
          createdAt: '2026-07-06T00:10:20.000Z',
          turnId: 't1',
          order: 2,
        }),
        a1a: message({
          id: 'a1a',
          taskId: 'task-a',
          role: 'assistant',
          content: 'assistant earlier segment',
          createdAt: '2026-07-06T00:10:10.000Z',
          turnId: 't1',
          order: 0,
        }),
        u1: message({
          id: 'u1',
          taskId: 'task-a',
          role: 'user',
          content: 'first user',
          createdAt: '2026-07-06T00:10:00.000Z',
          turnId: 't1',
        }),
        a2: message({
          id: 'a2',
          taskId: 'task-a',
          role: 'assistant',
          content: 'second assistant',
          createdAt: '2026-07-06T00:20:10.000Z',
          turnId: 't2',
          order: 0,
        }),
      },
    });

    const result = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const userIdx = result.markdown.indexOf('first user');
    const a1aIdx = result.markdown.indexOf('assistant earlier segment');
    const a1bIdx = result.markdown.indexOf('assistant later segment');
    const u2Idx = result.markdown.indexOf('second user');
    const a2Idx = result.markdown.indexOf('second assistant');
    expect(userIdx).toBeGreaterThan(-1);
    expect(a1aIdx).toBeGreaterThan(userIdx);
    expect(a1bIdx).toBeGreaterThan(a1aIdx);
    expect(u2Idx).toBeGreaterThan(a1bIdx);
    expect(a2Idx).toBeGreaterThan(u2Idx);
  });

  it('omits system, tool, reasoning, and queued draft content while keeping committed user text', () => {
    const file = baseFile({
      turns: {
        live: turn({
          id: 'live',
          taskId: 'task-a',
          status: 'running',
          sequence: 1,
          inputs: [{ kind: 'message', messageId: 'msg-live' }],
          startedAt: '2026-07-06T00:01:00.000Z',
        }),
        queued: turn({
          id: 'queued',
          taskId: 'task-a',
          status: 'queued',
          sequence: 2,
          inputs: [{ kind: 'message', messageId: 'msg-queued' }],
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
      },
      messages: {
        'msg-live': message({
          id: 'msg-live',
          taskId: 'task-a',
          role: 'user',
          content: 'live prompt',
          state: 'assigned',
          createdAt: '2026-07-06T00:01:00.000Z',
          turnId: 'live',
        }),
        'msg-queued': message({
          id: 'msg-queued',
          taskId: 'task-a',
          role: 'user',
          content: 'SECRET_QUEUED_DRAFT',
          state: 'pending',
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
        system: message({
          id: 'system',
          taskId: 'task-a',
          role: 'system',
          content: 'SECRET_SYSTEM_PROMPT',
          createdAt: '2026-07-06T00:00:30.000Z',
        }),
        assistant: message({
          id: 'assistant',
          taskId: 'task-a',
          role: 'assistant',
          content: 'visible assistant',
          createdAt: '2026-07-06T00:01:10.000Z',
          turnId: 'live',
          order: 0,
        }),
      },
      toolCalls: {
        'live:tool-1': {
          id: 'live:tool-1',
          taskId: 'task-a',
          turnId: 'live',
          toolCallId: 'tool-1',
          order: 1,
          name: 'bash',
          status: 'success',
          input: { cmd: 'SECRET_TOOL_INPUT' },
          output: 'SECRET_TOOL_OUTPUT',
          createdAt: '2026-07-06T00:01:05.000Z',
          updatedAt: '2026-07-06T00:01:06.000Z',
        },
      },
      reasoning: {
        live: {
          id: 'live',
          taskId: 'task-a',
          turnId: 'live',
          content: 'SECRET_REASONING',
          createdAt: '2026-07-06T00:01:02.000Z',
          updatedAt: '2026-07-06T00:01:02.000Z',
        },
      },
    });

    const result = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.markdown).toContain('live prompt');
    expect(result.markdown).toContain('visible assistant');
    expect(result.markdown).not.toContain('SECRET_QUEUED_DRAFT');
    expect(result.markdown).not.toContain('SECRET_SYSTEM_PROMPT');
    expect(result.markdown).not.toContain('SECRET_TOOL_INPUT');
    expect(result.markdown).not.toContain('SECRET_TOOL_OUTPUT');
    expect(result.markdown).not.toContain('SECRET_REASONING');
    expect(result.markdown).not.toContain('### Tool');
    expect(result.markdown).not.toContain('### Reasoning');
  });

  it('preserves retention truncation markers exactly', () => {
    const truncated = `partial answer${TRUNCATION_MARKER}`;
    const file = baseFile({
      messages: {
        u1: message({
          id: 'u1',
          taskId: 'task-a',
          role: 'user',
          content: 'long request',
          turnId: 't1',
        }),
        a1: message({
          id: 'a1',
          taskId: 'task-a',
          role: 'assistant',
          content: truncated,
          turnId: 't1',
          order: 0,
        }),
      },
    });

    const result = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain(TRUNCATION_MARKER);
    expect(result.markdown).toContain(truncated);
  });

  it('supports empty transcripts without inventing conversation content', () => {
    const file = baseFile({
      turns: {},
      messages: {},
    });
    const result = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('## Conversation');
    expect(result.markdown).not.toContain('### User');
    expect(result.markdown).not.toContain('### Assistant');
  });

  it('returns invalid_request for blank or invalid task ids without throwing', () => {
    const file = baseFile();
    for (const taskId of ['', '   ', 'a'.repeat(257), 'bad\0id']) {
      const result = renderTaskMarkdownExport(file, taskId, { exportedAt: EXPORTED_AT });
      expect(result).toEqual({ ok: false, code: 'invalid_request' });
    }
  });

  it('returns task_not_found for absent tasks without throwing', () => {
    const file = baseFile();
    const result = renderTaskMarkdownExport(file, 'missing-task', { exportedAt: EXPORTED_AT });
    expect(result).toEqual({ ok: false, code: 'task_not_found' });
  });

  it('returns invalid_request when exportedAt is missing or invalid', () => {
    const file = baseFile();
    expect(renderTaskMarkdownExport(file, 'task-a', {} as { exportedAt: string })).toEqual({
      ok: false,
      code: 'invalid_request',
    });
    expect(
      renderTaskMarkdownExport(file, 'task-a', { exportedAt: 'not-an-iso-timestamp' }),
    ).toEqual({ ok: false, code: 'invalid_request' });
  });

  it('fails closed on adversarial cross-task, session, path, coordination, and credential canaries', () => {
    const file = baseFile({
      tasks: {
        'task-a': task('task-a', {
          goal: 'Ship readable export',
          lifecycle: 'succeeded',
          backend: 'claude',
          model: 'sonnet',
          committedSessionId: 'SESSION_COMMITTED_SECRET',
          cwd: 'C:\\Users\\secret\\workspace',
          parentId: null,
          finishedAt: '2026-07-06T01:00:00.000Z',
        }),
        'task-b': task('task-b', {
          goal: 'Other task must never export',
          lifecycle: 'open',
          backend: 'grok',
          model: 'secret-model-b',
          committedSessionId: 'SESSION_OTHER_TASK',
          cwd: '/var/secret/other-cwd',
        }),
      },
      turns: {
        t1: turn({
          id: 't1',
          taskId: 'task-a',
          status: 'succeeded',
          sequence: 1,
          inputs: [{ kind: 'message', messageId: 'u1' }],
          candidateSessionId: 'SESSION_CANDIDATE_SECRET',
          observedSessionId: 'SESSION_OBSERVED_SECRET',
          finishedAt: '2026-07-06T00:10:00.000Z',
        }),
        't-other': turn({
          id: 't-other',
          taskId: 'task-b',
          status: 'succeeded',
          sequence: 1,
          inputs: [{ kind: 'message', messageId: 'u-other' }],
          candidateSessionId: 'SESSION_OTHER_CANDIDATE',
          observedSessionId: 'SESSION_OTHER_OBSERVED',
        }),
        queued: turn({
          id: 'queued',
          taskId: 'task-a',
          status: 'queued',
          sequence: 2,
          inputs: [{ kind: 'message', messageId: 'msg-queued' }],
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
      },
      messages: {
        u1: message({
          id: 'u1',
          taskId: 'task-a',
          role: 'user',
          content: 'Please summarize the plan.',
          agentContent:
            'Please summarize using /abs/secret/path/agentContent.md and token sk-live-CREDENTIAL_CANARY',
          createdAt: '2026-07-06T00:09:00.000Z',
          turnId: 't1',
        }),
        a1: message({
          id: 'a1',
          taskId: 'task-a',
          role: 'assistant',
          content: 'Here is the plan overview.',
          agentContent: 'D:\\abs\\secret\\assistant-agentContent.txt',
          createdAt: '2026-07-06T00:09:30.000Z',
          turnId: 't1',
          order: 0,
        }),
        system: message({
          id: 'system',
          taskId: 'task-a',
          role: 'system',
          content: 'SECRET_SYSTEM_PROMPT with API_KEY=sk-sys-LEAK',
        }),
        'msg-queued': message({
          id: 'msg-queued',
          taskId: 'task-a',
          role: 'user',
          content: 'SECRET_QUEUED_DRAFT with password=hunter2',
          state: 'pending',
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
        'u-other': message({
          id: 'u-other',
          taskId: 'task-b',
          role: 'user',
          content: 'CROSS_TASK_USER_CONTENT',
          agentContent: '/other/task/agentContent.secret',
          turnId: 't-other',
        }),
        'a-other': message({
          id: 'a-other',
          taskId: 'task-b',
          role: 'assistant',
          content: 'CROSS_TASK_ASSISTANT_CONTENT',
          turnId: 't-other',
          order: 0,
        }),
      },
      toolCalls: {
        't1:tool-1': {
          id: 't1:tool-1',
          taskId: 'task-a',
          turnId: 't1',
          toolCallId: 'tool-1',
          order: 1,
          name: 'bash',
          status: 'success',
          input: { cmd: 'cat /etc/SECRET_TOOL_INPUT' },
          output: 'SECRET_TOOL_OUTPUT token=ghp_LEAK',
          createdAt: '2026-07-06T00:01:05.000Z',
          updatedAt: '2026-07-06T00:01:06.000Z',
        },
        't-other:tool': {
          id: 't-other:tool',
          taskId: 'task-b',
          turnId: 't-other',
          toolCallId: 'tool-other',
          order: 1,
          name: 'read',
          status: 'success',
          output: 'CROSS_TASK_TOOL_OUTPUT',
          createdAt: '2026-07-06T00:01:05.000Z',
          updatedAt: '2026-07-06T00:01:06.000Z',
        },
      },
      reasoning: {
        t1: {
          id: 't1',
          taskId: 'task-a',
          turnId: 't1',
          content: 'SECRET_REASONING with credential sk-reason-LEAK',
          createdAt: '2026-07-06T00:01:02.000Z',
          updatedAt: '2026-07-06T00:01:02.000Z',
        },
        't-other': {
          id: 't-other',
          taskId: 'task-b',
          turnId: 't-other',
          content: 'CROSS_TASK_REASONING',
          createdAt: '2026-07-06T00:01:02.000Z',
          updatedAt: '2026-07-06T00:01:02.000Z',
        },
      },
      operations: {
        t1: {
          fingerprint: 'op-fingerprint-SECRET',
          result: { ok: true, data: { token: 'COORD_OP_SECRET' } },
        },
        't-other': {
          fingerprint: 'other-op-SECRET',
          result: { ok: false, error: 'CROSS_TASK_OP_ERROR' },
        },
      },
      cancelRequests: {
        t1: {
          kind: 'interrupt',
          by: 'user',
          opId: 'cancel-op-SECRET',
          at: '2026-07-06T00:05:00.000Z',
        },
      },
      sendReceipts: {
        'client-req-1': {
          clientRequestId: 'client-req-1',
          fingerprint: 'receipt-fingerprint-SECRET',
          taskId: 'task-a',
          messageId: 'u1',
          turnId: 't1',
          createdAt: '2026-07-06T00:09:00.000Z',
        },
      },
    });

    const before = JSON.stringify(file);
    const result = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(JSON.stringify(file)).toBe(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Visible allowlisted content only.
    expect(result.markdown).toContain('Please summarize the plan.');
    expect(result.markdown).toContain('Here is the plan overview.');
    expect(result.markdown).toContain('Ship readable export');
    expect(result.markdown).toContain('task-a');

    const forbidden = [
      // Cross-task
      'task-b',
      'Other task must never export',
      'CROSS_TASK_USER_CONTENT',
      'CROSS_TASK_ASSISTANT_CONTENT',
      'CROSS_TASK_TOOL_OUTPUT',
      'CROSS_TASK_REASONING',
      'CROSS_TASK_OP_ERROR',
      'SESSION_OTHER_TASK',
      'SESSION_OTHER_CANDIDATE',
      'SESSION_OTHER_OBSERVED',
      '/var/secret/other-cwd',
      'secret-model-b',
      // Session ids
      'SESSION_COMMITTED_SECRET',
      'SESSION_CANDIDATE_SECRET',
      'SESSION_OBSERVED_SECRET',
      'committedSessionId',
      'candidateSessionId',
      'observedSessionId',
      // Paths / agentContent
      'agentContent',
      '/abs/secret/path/agentContent.md',
      'D:\\abs\\secret\\assistant-agentContent.txt',
      'C:\\Users\\secret\\workspace',
      // System / queue / tool / reasoning
      'SECRET_SYSTEM_PROMPT',
      'SECRET_QUEUED_DRAFT',
      'SECRET_TOOL_INPUT',
      'SECRET_TOOL_OUTPUT',
      'SECRET_REASONING',
      // Credentials / coordination ledgers
      'sk-live-CREDENTIAL_CANARY',
      'API_KEY=sk-sys-LEAK',
      'sk-reason-LEAK',
      'ghp_LEAK',
      'password=hunter2',
      'COORD_OP_SECRET',
      'op-fingerprint-SECRET',
      'cancel-op-SECRET',
      'receipt-fingerprint-SECRET',
      'client-req-1',
      'sendReceipts',
      'cancelRequests',
      'operations',
    ];

    for (const needle of forbidden) {
      expect(result.markdown, `must not leak ${needle}`).not.toContain(needle);
    }

    // Error results must also stay free of echo for missing / invalid requests.
    const missing = renderTaskMarkdownExport(file, 'task-b-missing', { exportedAt: EXPORTED_AT });
    expect(missing).toEqual({ ok: false, code: 'task_not_found' });
    expect(JSON.stringify(missing)).not.toContain('SESSION_');
    expect(JSON.stringify(missing)).not.toContain('CREDENTIAL');
    expect(JSON.stringify(missing)).not.toContain('CROSS_TASK');
  });

  it('returns atomic render_bound without partial markdown when output exceeds maxChars', () => {
    const file = baseFile({
      messages: {
        u1: message({
          id: 'u1',
          taskId: 'task-a',
          role: 'user',
          content: 'x'.repeat(500),
          turnId: 't1',
        }),
        a1: message({
          id: 'a1',
          taskId: 'task-a',
          role: 'assistant',
          content: 'y'.repeat(500),
          turnId: 't1',
          order: 0,
        }),
      },
    });

    const full = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.markdown.length).toBeGreaterThan(200);

    const bounded = renderTaskMarkdownExport(file, 'task-a', {
      exportedAt: EXPORTED_AT,
      maxChars: 200,
    });
    expect(bounded).toEqual({ ok: false, code: 'render_bound' });
    // Atomic: no markdown / filename / partial body on the failure union.
    expect(bounded).not.toHaveProperty('markdown');
    expect(bounded).not.toHaveProperty('suggestedFilename');
    expect(JSON.stringify(bounded)).not.toContain('Please summarize');
    expect(JSON.stringify(bounded)).not.toContain('xxxx');
    expect(JSON.stringify(bounded)).not.toContain('yyyy');
    expect(JSON.stringify(bounded)).not.toContain(TASK_MARKDOWN_EXPORT_FORMAT);

    // Exactly at the bound succeeds; one character over fails closed.
    const exact = renderTaskMarkdownExport(file, 'task-a', {
      exportedAt: EXPORTED_AT,
      maxChars: full.markdown.length,
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.markdown).toBe(full.markdown);

    const overByOne = renderTaskMarkdownExport(file, 'task-a', {
      exportedAt: EXPORTED_AT,
      maxChars: full.markdown.length - 1,
    });
    expect(overByOne).toEqual({ ok: false, code: 'render_bound' });
    expect(overByOne).not.toHaveProperty('markdown');
  });

  it('uses the default render bound when maxChars is omitted or non-positive', () => {
    const file = baseFile();
    const withDefault = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    const withZero = renderTaskMarkdownExport(file, 'task-a', {
      exportedAt: EXPORTED_AT,
      maxChars: 0,
    });
    const withNegative = renderTaskMarkdownExport(file, 'task-a', {
      exportedAt: EXPORTED_AT,
      maxChars: -10,
    });
    expect(withDefault.ok).toBe(true);
    expect(withZero).toEqual(withDefault);
    expect(withNegative).toEqual(withDefault);
    expect(DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS).toBe(1_000_000);
  });

  it('keeps existing export snapshots unchanged when a task carries handoff state', () => {
    const withoutHandoff = baseFile();
    const withHandoff = baseFile({
      tasks: {
        'task-a': task('task-a', {
          goal: 'Ship readable export',
          lifecycle: 'succeeded',
          backend: 'claude',
          model: 'sonnet',
          finishedAt: '2026-07-06T01:00:00.000Z',
          handoff: {
            version: 1,
            operationId: 'hop-export-canary',
            phase: 'completed',
            source: { backend: 'claude', model: 'sonnet', sessionId: 'src-handoff-sess' },
            target: { backend: 'codex', model: 'gpt-5' },
            conversationContext: {
              status: 'ready',
              messageCount: 2,
              contentDigest: 'export-handoff-digest-SECRET',
              exportedAt: '2026-07-06T00:50:00.000Z',
            },
            sourceSummary: {
              status: 'unavailable',
              reason: 'SOURCE_SUMMARY_MUST_NOT_EXPORT',
            },
            createdAt: '2026-07-06T00:40:00.000Z',
            updatedAt: '2026-07-06T00:55:00.000Z',
            finishedAt: '2026-07-06T00:55:00.000Z',
            completion: {
              completedAt: '2026-07-06T00:55:00.000Z',
              boundBackend: 'codex',
              boundSessionId: 'tgt-handoff-sess-SECRET',
            },
          },
        }),
      },
    });

    const baseline = renderTaskMarkdownExport(withoutHandoff, 'task-a', {
      exportedAt: EXPORTED_AT,
    });
    const withField = renderTaskMarkdownExport(withHandoff, 'task-a', {
      exportedAt: EXPORTED_AT,
    });
    expect(baseline.ok).toBe(true);
    expect(withField.ok).toBe(true);
    if (!baseline.ok || !withField.ok) return;

    // Handoff is orthogonal to Markdown export: conversation body is identical.
    expect(withField.markdown).toBe(baseline.markdown);
    expect(withField.suggestedFilename).toBe(baseline.suggestedFilename);
    expect(withField.sourceRevision).toBe(baseline.sourceRevision);

    for (const needle of [
      'hop-export-canary',
      'export-handoff-digest-SECRET',
      'SOURCE_SUMMARY_MUST_NOT_EXPORT',
      'tgt-handoff-sess-SECRET',
      'src-handoff-sess',
      'handoff',
    ]) {
      expect(withField.markdown, `export must not leak ${needle}`).not.toContain(needle);
    }
  });
});

describe('suggestTaskMarkdownFilename', () => {
  it('slugs readable goals into safe .md names', () => {
    expect(suggestTaskMarkdownFilename('Ship readable export')).toBe('ship-readable-export.md');
    expect(suggestTaskMarkdownFilename('  Hello/World: v2?  ')).toBe('hello-world-v2.md');
  });

  it('falls back deterministically for unsafe, Unicode-only, or punctuation-only goals', () => {
    expect(suggestTaskMarkdownFilename('!!!')).toBe('task-export.md');
    expect(suggestTaskMarkdownFilename('')).toBe('task-export.md');
    expect(suggestTaskMarkdownFilename('   ')).toBe('task-export.md');
    expect(suggestTaskMarkdownFilename('日本語だけ')).toBe('task-export.md');
    expect(suggestTaskMarkdownFilename('../etc/passwd')).toBe('etc-passwd.md');
    expect(suggestTaskMarkdownFilename('a'.repeat(300)).endsWith('.md')).toBe(true);
    expect(suggestTaskMarkdownFilename('a'.repeat(300)).length).toBeLessThanOrEqual(84);
  });
});
