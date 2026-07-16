import { describe, expect, it, vi } from 'vitest';
import {
  parseRequestRuntimeHandoffMessage,
  routeRuntimeHandoff,
  sanitizeRuntimeHandoffErrorText,
  type RuntimeHandoffRouteDeps,
} from './runtime-handoff-route';

function deps(overrides: Partial<RuntimeHandoffRouteDeps> = {}): RuntimeHandoffRouteDeps {
  return {
    getTask: () => ({ backend: 'claude', model: 'sonnet' }),
    requestRuntimeHandoff: vi.fn(async () => ({
      ok: true as const,
      value: {
        operationId: 'hop-1',
        boundBackend: 'codex',
        boundModel: 'gpt-5',
        switchedAt: '2026-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

describe('runtime handoff route v2', () => {
  it('validates labels and optional model', () => {
    expect(
      parseRequestRuntimeHandoffMessage({
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
        targetModel: 'gpt-5',
      }),
    ).toEqual({ ok: true, taskId: 'task-1', targetBackend: 'codex', targetModel: 'gpt-5' });
    expect(
      parseRequestRuntimeHandoffMessage({
        type: 'requestRuntimeHandoff',
        taskId: '',
        targetBackend: 'codex',
      }).ok,
    ).toBe(false);
  });

  it('commits through one engine request and returns immediately', async () => {
    const d = deps();
    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'codex',
        targetModel: 'gpt-5',
      },
      d,
    );
    expect(d.requestRuntimeHandoff).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      kind: 'completed',
      taskId: 'task-1',
      operationId: 'hop-1',
      boundBackend: 'codex',
      refreshSnapshot: true,
      messages: [],
    });
    expect(JSON.stringify(outcome)).not.toContain('session');
  });

  it('refuses an unchanged binding without calling the engine', async () => {
    const d = deps();
    const outcome = await routeRuntimeHandoff(
      {
        type: 'requestRuntimeHandoff',
        taskId: 'task-1',
        targetBackend: 'claude',
        targetModel: 'sonnet',
      },
      d,
    );
    expect(outcome.kind).toBe('refused');
    expect(d.requestRuntimeHandoff).not.toHaveBeenCalled();
  });

  it('surfaces an atomic request refusal without a misleading progress state', async () => {
    const outcome = await routeRuntimeHandoff(
      { type: 'requestRuntimeHandoff', taskId: 'task-1', targetBackend: 'codex' },
      deps({
        requestRuntimeHandoff: vi.fn(async () => ({ ok: false as const, reason: 'backend unavailable' })),
      }),
    );
    expect(outcome.kind).toBe('refused');
    expect(outcome.refreshSnapshot).toBe(false);
  });

  it('redacts paths and credentials in refusal text', () => {
    const text = sanitizeRuntimeHandoffErrorText(
      'failed at /Users/alice/project/file.ts with sk-live-SECRETTOKEN123',
    );
    expect(text).not.toContain('/Users/alice');
    expect(text).not.toContain('SECRETTOKEN');
  });
});
