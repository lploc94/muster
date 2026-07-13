import { describe, expect, it, vi } from 'vitest';
import type { EngineResult } from '../task/engine';
import {
  MAX_QUEUED_MUTATION_CONTENT_CHARS,
  MAX_QUEUED_MUTATION_ERROR_CHARS,
  MAX_QUEUED_MUTATION_ID_CHARS,
  parseDeleteQueuedTurnMessage,
  parseEditQueuedTurnMessage,
  queuedMutationRefusalMessage,
  routeDeleteQueuedTurn,
  routeEditQueuedTurn,
  sanitizeQueuedMutationText,
} from './queued-turn-mutations';

describe('parseEditQueuedTurnMessage', () => {
  it('accepts a valid editQueuedTurn payload and trims ids', () => {
    expect(
      parseEditQueuedTurnMessage({
        type: 'editQueuedTurn',
        taskId: '  task-1  ',
        turnId: '  turn-q  ',
        content: '  revised follow-up  ',
      }),
    ).toEqual({
      ok: true,
      taskId: 'task-1',
      turnId: 'turn-q',
      content: '  revised follow-up  ',
    });
  });

  it.each([
    [null, 'object payload'],
    [undefined, 'object payload'],
    ['editQueuedTurn', 'object payload'],
    [{ type: 'continueTask', taskId: 't', turnId: 'q', content: 'x' }, 'type mismatch'],
    [{ type: 'editQueuedTurn', turnId: 'q', content: 'x' }, 'requires taskId'],
    [{ type: 'editQueuedTurn', taskId: '   ', turnId: 'q', content: 'x' }, 'requires taskId'],
    [{ type: 'editQueuedTurn', taskId: 't', content: 'x' }, 'requires turnId'],
    [{ type: 'editQueuedTurn', taskId: 't', turnId: '   ', content: 'x' }, 'requires turnId'],
    [{ type: 'editQueuedTurn', taskId: 't', turnId: 'q', content: '' }, 'non-empty content'],
    [{ type: 'editQueuedTurn', taskId: 't', turnId: 'q', content: '   ' }, 'non-empty content'],
    [{ type: 'editQueuedTurn', taskId: 't', turnId: 'q', content: 12 }, 'non-empty content'],
  ])('rejects malformed edit payload %#', (input, fragment) => {
    const result = parseEditQueuedTurnMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(fragment);
    }
  });

  it('rejects oversized ids and content', () => {
    const longId = 'a'.repeat(MAX_QUEUED_MUTATION_ID_CHARS + 1);
    expect(
      parseEditQueuedTurnMessage({
        type: 'editQueuedTurn',
        taskId: longId,
        turnId: 'turn-1',
        content: 'ok',
      }).ok,
    ).toBe(false);
    expect(
      parseEditQueuedTurnMessage({
        type: 'editQueuedTurn',
        taskId: 'task-1',
        turnId: longId,
        content: 'ok',
      }).ok,
    ).toBe(false);

    const longContent = 'x'.repeat(MAX_QUEUED_MUTATION_CONTENT_CHARS + 1);
    const longResult = parseEditQueuedTurnMessage({
      type: 'editQueuedTurn',
      taskId: 'task-1',
      turnId: 'turn-1',
      content: longContent,
    });
    expect(longResult.ok).toBe(false);
    if (!longResult.ok) {
      expect(longResult.taskId).toBe('task-1');
      expect(longResult.message).toContain(String(MAX_QUEUED_MUTATION_CONTENT_CHARS));
    }
  });

  it('rejects null bytes in ids and content', () => {
    expect(
      parseEditQueuedTurnMessage({
        type: 'editQueuedTurn',
        taskId: 'task\0id',
        turnId: 'turn-1',
        content: 'ok',
      }).ok,
    ).toBe(false);
    expect(
      parseEditQueuedTurnMessage({
        type: 'editQueuedTurn',
        taskId: 'task-1',
        turnId: 'turn\0id',
        content: 'ok',
      }).ok,
    ).toBe(false);
    expect(
      parseEditQueuedTurnMessage({
        type: 'editQueuedTurn',
        taskId: 'task-1',
        turnId: 'turn-1',
        content: 'bad\0content',
      }).ok,
    ).toBe(false);
  });
});

describe('parseDeleteQueuedTurnMessage', () => {
  it('accepts a valid deleteQueuedTurn payload and trims ids', () => {
    expect(
      parseDeleteQueuedTurnMessage({
        type: 'deleteQueuedTurn',
        taskId: '  task-1  ',
        turnId: '  turn-q  ',
      }),
    ).toEqual({ ok: true, taskId: 'task-1', turnId: 'turn-q' });
  });

  it.each([
    [null, 'object payload'],
    [{ type: 'editQueuedTurn', taskId: 't', turnId: 'q' }, 'type mismatch'],
    [{ type: 'deleteQueuedTurn', turnId: 'q' }, 'requires taskId'],
    [{ type: 'deleteQueuedTurn', taskId: 't' }, 'requires turnId'],
    [{ type: 'deleteQueuedTurn', taskId: 't', turnId: '   ' }, 'requires turnId'],
  ])('rejects malformed delete payload %#', (input, fragment) => {
    const result = parseDeleteQueuedTurnMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(fragment);
    }
  });
});

describe('queuedMutationRefusalMessage', () => {
  it('maps stable engine reasons to sanitized visible refusals', () => {
    expect(queuedMutationRefusalMessage('turn is not queued')).toContain('not queued');
    expect(queuedMutationRefusalMessage('turn not found')).toContain('not found');
    expect(queuedMutationRefusalMessage('turn does not belong to task')).toContain('belong');
    expect(queuedMutationRefusalMessage('message is not pending')).toContain('not pending');
    expect(queuedMutationRefusalMessage('invalid content')).toContain('invalid content');
    expect(queuedMutationRefusalMessage('task not found')).toContain('task not found');
  });

  it('sanitizes control characters and bounds length', () => {
    const message = queuedMutationRefusalMessage('boom\nstack\ttrace\x00secret');
    expect(message).not.toMatch(/[\n\t\x00]/);
    expect(message).toContain('boom');
    expect(message.length).toBeLessThanOrEqual(MAX_QUEUED_MUTATION_ERROR_CHARS);
  });
});

describe('sanitizeQueuedMutationText', () => {
  it('bounds length with an ellipsis', () => {
    const message = sanitizeQueuedMutationText('a'.repeat(500), 20);
    expect(message.length).toBe(20);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('routeEditQueuedTurn', () => {
  it('refuses when the engine is not ready without calling editQueuedTurn', () => {
    const editQueuedTurn = vi.fn();
    const outcome = routeEditQueuedTurn(
      { type: 'editQueuedTurn', taskId: 't', turnId: 'q', content: 'x' },
      { engineReady: false, editQueuedTurn },
    );
    expect(outcome).toEqual({ kind: 'error', message: 'task engine not ready' });
    expect(editQueuedTurn).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads without engine delegation', () => {
    const editQueuedTurn = vi.fn();
    const outcome = routeEditQueuedTurn(
      { type: 'editQueuedTurn', taskId: 't', turnId: 'q', content: '' },
      { engineReady: true, editQueuedTurn },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.taskId).toBe('t');
      expect(outcome.message).toContain('non-empty content');
    }
    expect(editQueuedTurn).not.toHaveBeenCalled();
  });

  it('delegates once on valid payload and returns ack for success', () => {
    const editQueuedTurn = vi.fn(
      (): EngineResult<{ turnId: string; messageId: string }> => ({
        ok: true,
        value: { turnId: 'turn-q', messageId: 'msg-1' },
      }),
    );
    const outcome = routeEditQueuedTurn(
      {
        type: 'editQueuedTurn',
        taskId: 'task-1',
        turnId: 'turn-q',
        content: 'revised',
      },
      { engineReady: true, editQueuedTurn },
    );
    expect(editQueuedTurn).toHaveBeenCalledTimes(1);
    expect(editQueuedTurn).toHaveBeenCalledWith('task-1', 'turn-q', 'revised');
    expect(outcome).toEqual({
      kind: 'ack',
      taskId: 'task-1',
      turnId: 'turn-q',
      messageId: 'msg-1',
    });
  });

  it.each([
    ['turn is not queued', 'not queued'],
    ['turn not found', 'not found'],
    ['turn does not belong to task', 'belong'],
    ['message is not pending', 'not pending'],
    ['invalid content', 'invalid content'],
  ])('surfaces engine refusal %s as a visible command error', (reason, fragment) => {
    const editQueuedTurn = vi.fn(
      (): EngineResult<{ turnId: string; messageId: string }> => ({
        ok: false,
        reason,
      }),
    );
    const outcome = routeEditQueuedTurn(
      {
        type: 'editQueuedTurn',
        taskId: 'task-1',
        turnId: 'turn-q',
        content: 'revised',
      },
      { engineReady: true, editQueuedTurn },
    );
    expect(editQueuedTurn).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.taskId).toBe('task-1');
      expect(outcome.message).toContain(fragment);
      expect(outcome.message).not.toMatch(/Error:|at\s+\w+/);
    }
  });

  it('never falls through to continueTask — only editQueuedTurn is invoked', () => {
    const calls: string[] = [];
    const editQueuedTurn = vi.fn((): EngineResult<{ turnId: string; messageId: string }> => {
      calls.push('editQueuedTurn');
      return { ok: false, reason: 'turn is not queued' };
    });
    const continueTaskWithMessage = vi.fn(() => {
      calls.push('continueTaskWithMessage');
      return { ok: true };
    });

    routeEditQueuedTurn(
      {
        type: 'editQueuedTurn',
        taskId: 'task-1',
        turnId: 'turn-q',
        content: 'revised',
      },
      { engineReady: true, editQueuedTurn },
    );

    expect(continueTaskWithMessage).not.toHaveBeenCalled();
    expect(calls).toEqual(['editQueuedTurn']);
  });
});

describe('routeDeleteQueuedTurn', () => {
  it('refuses when the engine is not ready without calling deleteQueuedTurn', () => {
    const deleteQueuedTurn = vi.fn();
    const outcome = routeDeleteQueuedTurn(
      { type: 'deleteQueuedTurn', taskId: 't', turnId: 'q' },
      { engineReady: false, deleteQueuedTurn },
    );
    expect(outcome).toEqual({ kind: 'error', message: 'task engine not ready' });
    expect(deleteQueuedTurn).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads without engine delegation', () => {
    const deleteQueuedTurn = vi.fn();
    const outcome = routeDeleteQueuedTurn(
      { type: 'deleteQueuedTurn', taskId: 't' },
      { engineReady: true, deleteQueuedTurn },
    );
    expect(outcome.kind).toBe('error');
    expect(deleteQueuedTurn).not.toHaveBeenCalled();
  });

  it('delegates once on valid payload and returns ack for success', () => {
    const deleteQueuedTurn = vi.fn(
      (): EngineResult<{ turnId: string; deletedMessageIds: string[] }> => ({
        ok: true,
        value: { turnId: 'turn-q', deletedMessageIds: ['msg-1'] },
      }),
    );
    const outcome = routeDeleteQueuedTurn(
      { type: 'deleteQueuedTurn', taskId: 'task-1', turnId: 'turn-q' },
      { engineReady: true, deleteQueuedTurn },
    );
    expect(deleteQueuedTurn).toHaveBeenCalledTimes(1);
    expect(deleteQueuedTurn).toHaveBeenCalledWith('task-1', 'turn-q');
    expect(outcome).toEqual({
      kind: 'ack',
      taskId: 'task-1',
      turnId: 'turn-q',
      deletedMessageIds: ['msg-1'],
    });
  });

  it('surfaces stale-dispatch refusal without leaking stack traces', () => {
    const deleteQueuedTurn = vi.fn(
      (): EngineResult<{ turnId: string; deletedMessageIds: string[] }> => ({
        ok: false,
        reason: 'turn is not queued\n    at TaskEngine.deleteQueuedTurn (engine.ts:1:1)',
      }),
    );
    const outcome = routeDeleteQueuedTurn(
      { type: 'deleteQueuedTurn', taskId: 'task-1', turnId: 'turn-q' },
      { engineReady: true, deleteQueuedTurn },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.taskId).toBe('task-1');
      expect(outcome.message).toContain('not queued');
      expect(outcome.message).not.toMatch(/\bat\s+TaskEngine/);
      expect(outcome.message).not.toMatch(/engine\.ts/);
    }
  });
});
