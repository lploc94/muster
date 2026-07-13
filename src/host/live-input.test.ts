import { describe, expect, it, vi } from 'vitest';
import type { LiveInputResult } from '../types';
import {
  MAX_LIVE_INPUT_ID_CHARS,
  MAX_LIVE_INPUT_INSTRUCTION_CHARS,
  liveInputRefusalMessage,
  parseSendLiveInputMessage,
  routeSendLiveInput,
  sanitizeLiveInputText,
} from './live-input';

describe('parseSendLiveInputMessage', () => {
  it('accepts a valid sendLiveInput payload', () => {
    expect(
      parseSendLiveInputMessage({
        type: 'sendLiveInput',
        taskId: 'task-1',
        instruction: 'nudge the agent',
      }),
    ).toEqual({ ok: true, taskId: 'task-1', instruction: 'nudge the agent' });
  });

  it('trims taskId but preserves instruction body whitespace', () => {
    expect(
      parseSendLiveInputMessage({
        type: 'sendLiveInput',
        taskId: '  task-1  ',
        instruction: '  keep spaces  ',
      }),
    ).toEqual({ ok: true, taskId: 'task-1', instruction: '  keep spaces  ' });
  });

  it.each([
    [null, 'object payload'],
    [undefined, 'object payload'],
    ['sendLiveInput', 'object payload'],
    [{ type: 'continueTask', taskId: 't', instruction: 'x' }, 'type mismatch'],
    [{ type: 'sendLiveInput', instruction: 'x' }, 'requires taskId'],
    [{ type: 'sendLiveInput', taskId: '   ', instruction: 'x' }, 'requires taskId'],
    [{ type: 'sendLiveInput', taskId: 't', instruction: '' }, 'non-empty instruction'],
    [{ type: 'sendLiveInput', taskId: 't', instruction: '   ' }, 'non-empty instruction'],
    [{ type: 'sendLiveInput', taskId: 't', instruction: 12 }, 'non-empty instruction'],
  ])('rejects malformed payload %#', (input, fragment) => {
    const result = parseSendLiveInputMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(fragment);
    }
  });

  it('rejects oversized taskId and instruction', () => {
    const longId = 'a'.repeat(MAX_LIVE_INPUT_ID_CHARS + 1);
    const longIdResult = parseSendLiveInputMessage({
      type: 'sendLiveInput',
      taskId: longId,
      instruction: 'ok',
    });
    expect(longIdResult.ok).toBe(false);

    const longInstr = 'x'.repeat(MAX_LIVE_INPUT_INSTRUCTION_CHARS + 1);
    const longInstrResult = parseSendLiveInputMessage({
      type: 'sendLiveInput',
      taskId: 'task-1',
      instruction: longInstr,
    });
    expect(longInstrResult.ok).toBe(false);
    if (!longInstrResult.ok) {
      expect(longInstrResult.taskId).toBe('task-1');
      expect(longInstrResult.message).toContain(String(MAX_LIVE_INPUT_INSTRUCTION_CHARS));
    }
  });

  it('rejects null bytes in identifiers and instructions', () => {
    expect(
      parseSendLiveInputMessage({
        type: 'sendLiveInput',
        taskId: 'task\0id',
        instruction: 'ok',
      }).ok,
    ).toBe(false);
    expect(
      parseSendLiveInputMessage({
        type: 'sendLiveInput',
        taskId: 'task-1',
        instruction: 'bad\0instruction',
      }).ok,
    ).toBe(false);
  });
});

describe('liveInputRefusalMessage', () => {
  it('maps each refusal code to a capability- or ownership-specific message', () => {
    expect(liveInputRefusalMessage({ code: 'unsupported', reason: 'no capability' })).toContain(
      'unsupported',
    );
    expect(liveInputRefusalMessage({ code: 'no-active-turn', reason: 'idle' })).toContain(
      'No active turn',
    );
    expect(liveInputRefusalMessage({ code: 'not-local-owner', reason: 'remote pid' })).toContain(
      'not the local owner',
    );
    expect(liveInputRefusalMessage({ code: 'cancelled', reason: 'aborted' })).toContain('cancelled');
    expect(liveInputRefusalMessage({ code: 'rejected', reason: 'backend said no' })).toContain(
      'rejected',
    );
  });

  it('sanitizes control characters from backend reasons', () => {
    const message = liveInputRefusalMessage({
      code: 'rejected',
      reason: 'boom\nstack\ttrace\x00secret',
    });
    expect(message).not.toMatch(/[\n\t\x00]/);
    expect(message).toContain('boom');
  });
});

describe('sanitizeLiveInputText', () => {
  it('bounds length with an ellipsis', () => {
    const message = sanitizeLiveInputText('a'.repeat(500), 20);
    expect(message.length).toBe(20);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('routeSendLiveInput', () => {
  it('refuses when the engine is not ready without calling sendLiveInput', async () => {
    const sendLiveInput = vi.fn();
    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 't', instruction: 'x' },
      { engineReady: false, sendLiveInput },
    );
    expect(outcome).toEqual({ kind: 'error', message: 'task engine not ready' });
    expect(sendLiveInput).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads without engine delegation', async () => {
    const sendLiveInput = vi.fn();
    const continueTask = vi.fn();
    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 't', instruction: '' },
      { engineReady: true, sendLiveInput },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.taskId).toBe('t');
      expect(outcome.message).toContain('non-empty instruction');
    }
    expect(sendLiveInput).not.toHaveBeenCalled();
    expect(continueTask).not.toHaveBeenCalled();
  });

  it('delegates once on valid payload and returns ack for delivered', async () => {
    const sendLiveInput = vi.fn(async (): Promise<LiveInputResult> => ({
      code: 'delivered',
      sessionId: 'sess-1',
    }));
    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 'task-1', instruction: 'nudge' },
      { engineReady: true, sendLiveInput },
    );
    expect(sendLiveInput).toHaveBeenCalledTimes(1);
    expect(sendLiveInput).toHaveBeenCalledWith('task-1', 'nudge');
    expect(outcome).toEqual({ kind: 'ack', taskId: 'task-1', sessionId: 'sess-1' });
  });

  it.each([
    [{ code: 'unsupported' as const, reason: 'backend kiro lacks live input' }, 'unsupported'],
    [{ code: 'no-active-turn' as const, reason: 'no running turn' }, 'No active turn'],
    [{ code: 'not-local-owner' as const, reason: 'foreign lease' }, 'not the local owner'],
    [{ code: 'rejected' as const, reason: 'agent error' }, 'rejected'],
    [{ code: 'cancelled' as const, reason: 'aborted' }, 'cancelled'],
  ])('surfaces %s refusal as a visible command error', async (result, fragment) => {
    const sendLiveInput = vi.fn(async () => result);
    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 'task-1', instruction: 'nudge' },
      { engineReady: true, sendLiveInput },
    );
    expect(sendLiveInput).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.taskId).toBe('task-1');
      expect(outcome.message).toContain(fragment);
    }
  });

  it('never falls through to continueTask — only sendLiveInput is invoked', async () => {
    const calls: string[] = [];
    const sendLiveInput = vi.fn(async () => {
      calls.push('sendLiveInput');
      return { code: 'unsupported' as const, reason: 'nope' };
    });
    const continueTaskWithMessage = vi.fn(async () => {
      calls.push('continueTaskWithMessage');
      return { ok: true };
    });

    await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 'task-1', instruction: 'nudge' },
      { engineReady: true, sendLiveInput },
    );

    // Explicitly prove continueTask is not part of this route surface.
    expect(continueTaskWithMessage).not.toHaveBeenCalled();
    expect(calls).toEqual(['sendLiveInput']);
  });
});
