import { describe, expect, it, vi } from 'vitest';
import {
  parseRequestRuntimeHandoffMessage,
  routeRuntimeHandoff,
  sanitizeRuntimeHandoffErrorText,
  type RuntimeHandoffRouteDeps,
} from './runtime-handoff-route';

function makeDeps(
  overrides: Partial<RuntimeHandoffRouteDeps> = {},
): {
  deps: RuntimeHandoffRouteDeps;
  request: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  afterRequest: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => ({
    ok: true as const,
    value: {
      operationId: 'op-1',
      phase: 'preparing_receiver' as const,
      diagnostics: { operationId: 'op-1', phase: 'preparing_receiver' },
    },
  }));
  const complete = vi.fn(async () => ({
    ok: true as const,
    value: {
      operationId: 'op-1',
      phase: 'completed' as const,
      diagnostics: { operationId: 'op-1', phase: 'completed' },
      boundBackend: 'codex',
      boundSessionId: 'sess-target-SECRET',
    },
  }));
  const afterRequest = vi.fn(async () => {});
  const deps: RuntimeHandoffRouteDeps = {
    getTask: (taskId) =>
      taskId === 'task-1'
        ? { backend: 'claude-cli', model: 'sonnet' }
        : undefined,
    requestRuntimeHandoff: request,
    completeRuntimeHandoff: complete,
    afterRequestCommitted: afterRequest,
    ...overrides,
  };
  // Return the mocks actually wired into deps (overrides may replace them).
  return {
    deps,
    request: deps.requestRuntimeHandoff as ReturnType<typeof vi.fn>,
    complete: deps.completeRuntimeHandoff as ReturnType<typeof vi.fn>,
    afterRequest: (deps.afterRequestCommitted ?? afterRequest) as ReturnType<
      typeof vi.fn
    >,
  };
}

describe('parseRequestRuntimeHandoffMessage', () => {
  it('accepts a well-formed requestRuntimeHandoff payload', () => {
    const parsed = parseRequestRuntimeHandoffMessage({
      type: 'requestRuntimeHandoff',
      taskId: 'task-1',
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: true,
    });
    expect(parsed).toEqual({
      ok: true,
      taskId: 'task-1',
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: true,
    });
  });

  it('rejects missing/empty/oversized/null-byte ids and backends', () => {
    const cases: unknown[] = [
      null,
      'string',
      { type: 'requestRuntimeHandoff' },
      { type: 'requestRuntimeHandoff', taskId: '', targetBackend: 'codex' },
      { type: 'requestRuntimeHandoff', taskId: 'task-1', targetBackend: '' },
      { type: 'requestRuntimeHandoff', taskId: 'task-1', targetBackend: 'codex', targetModel: 42 },
      {
        type: 'requestRuntimeHandoff',
        taskId: 'bad\0id',
        targetBackend: 'codex',
      },
      {
        type: 'requestRuntimeHandoff',
        taskId: 'x'.repeat(300),
        targetBackend: 'codex',
      },
      {
        type: 'exportTask',
        taskId: 'task-1',
        targetBackend: 'codex',
      },
    ];
    for (const data of cases) {
      const parsed = parseRequestRuntimeHandoffMessage(data);
      expect(parsed.ok, JSON.stringify(data)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.code).toBe('invalid_request');
      }
    }
  });
});

describe('sanitizeRuntimeHandoffErrorText', () => {
  it('strips absolute paths, stacks, and secrets from refusal text', () => {
    const raw =
      'target backend unavailable: ENOENT /Users/secret/bin/codex at run (/abs/path/engine.ts:10) sk-abcde12345token';
    const sanitized = sanitizeRuntimeHandoffErrorText(raw);
    expect(sanitized).not.toMatch(/\/Users\/secret/);
    expect(sanitized).not.toMatch(/engine\.ts/);
    expect(sanitized).not.toMatch(/sk-abcde/);
    expect(sanitized.length).toBeGreaterThan(0);
    expect(sanitized.length).toBeLessThanOrEqual(400);
  });
});

describe('routeRuntimeHandoff', () => {
  it('chains requestRuntimeHandoff then completeRuntimeHandoff and never returns session ids', async () => {
    const { deps, request, complete, afterRequest } = makeDeps();
    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
        targetModel: 'gpt-5',
      },
      deps,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      taskId: 'task-1',
      targetBackend: 'codex',
      targetModel: 'gpt-5',
      skipSummary: true,
    });
    expect(afterRequest).toHaveBeenCalledWith('task-1');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      taskId: 'task-1',
      operationId: 'op-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.taskId).toBe('task-1');
      expect(outcome.operationId).toBe('op-1');
      expect(outcome.boundBackend).toBe('codex');
      expect(outcome.refreshSnapshot).toBe(true);
      const json = JSON.stringify(outcome);
      expect(json).not.toContain('sess-target-SECRET');
      expect(json).not.toContain('sessionId');
      expect(json).not.toContain('boundSessionId');
    }
  });

  it('refuses same-binding switches without calling request or complete', async () => {
    const { deps, request, complete } = makeDeps();
    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'claude-cli',
        targetModel: 'sonnet',
      },
      deps,
    );

    expect(request).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.taskId).toBe('task-1');
      expect(outcome.refreshSnapshot).toBe(false);
      expect(outcome.messages).toEqual([
        {
          type: 'commandError',
          taskId: 'task-1',
          message: expect.stringMatching(/same|already|identical|unchanged/i),
        },
      ]);
    }
  });

  it('refuses missing tasks without calling complete', async () => {
    const { deps, request, complete } = makeDeps();
    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'missing',
        targetBackend: 'codex',
      },
      deps,
    );

    expect(request).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.taskId).toBe('missing');
      expect(outcome.messages[0]?.type).toBe('commandError');
    }
  });

  it('refuses invalid payloads without calling engine APIs', async () => {
    const { deps, request, complete } = makeDeps();
    const outcome = await routeRuntimeHandoff(
      { type: 'requestRuntimeHandoff', taskId: '', targetBackend: 'codex' },
      deps,
    );
    expect(request).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('refused');
  });

  it('never calls complete when requestRuntimeHandoff refuses (live turn / active handoff)', async () => {
    const { deps, request, complete, afterRequest } = makeDeps({
      requestRuntimeHandoff: vi.fn(async () => ({
        ok: false as const,
        reason: 'task has a live or active turn',
      })),
    });

    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
        targetModel: 'gpt-5',
      },
      deps,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(afterRequest).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refreshSnapshot).toBe(false);
      expect(outcome.messages).toEqual([
        {
          type: 'commandError',
          taskId: 'task-1',
          message: expect.stringMatching(/live|active turn/i),
        },
      ]);
      // Sanitized — no raw stack/path leakage if reason were dirty.
      const msg = outcome.messages[0];
      if (msg && msg.type === 'commandError') {
        expect(msg.message).not.toMatch(/\/Users\//);
      }
    }
  });

  it('surfaces sanitized error and refreshes when completeRuntimeHandoff fails after request', async () => {
    const { deps, request, complete, afterRequest } = makeDeps({
      completeRuntimeHandoff: vi.fn(async () => ({
        ok: false as const,
        reason:
          'receiver init failed: ENOENT /Users/secret/.codex/bin at transfer (/tmp/engine.ts:99) sk-secretTOKEN99',
      })),
    });

    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
      },
      deps,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(afterRequest).toHaveBeenCalledWith('task-1');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.taskId).toBe('task-1');
      expect(outcome.refreshSnapshot).toBe(true);
      expect(outcome.messages).toHaveLength(1);
      const msg = outcome.messages[0]!;
      expect(msg.type).toBe('commandError');
      if (msg.type === 'commandError') {
        expect(msg.taskId).toBe('task-1');
        expect(msg.message).not.toMatch(/\/Users\/secret/);
        expect(msg.message).not.toMatch(/engine\.ts/);
        expect(msg.message).not.toMatch(/sk-secret/);
        expect(msg.message.length).toBeLessThanOrEqual(400);
      }
    }
  });

  it('defaults skipSummary to true so the host does not force a hidden summary turn', async () => {
    const { deps, request } = makeDeps();
    await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
      },
      deps,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ skipSummary: true }),
    );
  });

  it('forwards explicit skipSummary: false when requested', async () => {
    const { deps, request } = makeDeps();
    await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
        skipSummary: false,
      },
      deps,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ skipSummary: false }),
    );
  });
});
