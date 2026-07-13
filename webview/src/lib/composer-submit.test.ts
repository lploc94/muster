import { describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import {
  buildTaskComposerMessage,
  resolveComposerKeyIntent,
  shouldPreventDefaultForComposerKey,
  type ComposerKeyPolicyInput,
} from './composer-submit';

function key(partial: Partial<ComposerKeyPolicyInput> & Pick<ComposerKeyPolicyInput, 'key'>): ComposerKeyPolicyInput {
  return {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...partial,
  };
}

describe('resolveComposerKeyIntent', () => {
  it('ignores non-Enter keys', () => {
    expect(resolveComposerKeyIntent(key({ key: 'a' }), { mode: 'task' })).toEqual({ kind: 'none' });
  });

  it('suppresses submit during IME composition (isComposing or keyCode 229)', () => {
    expect(resolveComposerKeyIntent(key({ key: 'Enter', isComposing: true }), { mode: 'task' })).toEqual({
      kind: 'none',
    });
    expect(resolveComposerKeyIntent(key({ key: 'Enter', keyCode: 229 }), { mode: 'task' })).toEqual({
      kind: 'none',
    });
  });

  it('leaves Shift+Enter free for newline insertion', () => {
    expect(resolveComposerKeyIntent(key({ key: 'Enter', shiftKey: true }), { mode: 'task' })).toEqual({
      kind: 'none',
    });
    expect(shouldPreventDefaultForComposerKey(key({ key: 'Enter', shiftKey: true }), { mode: 'task' })).toBe(
      false,
    );
  });

  it('maps plain Enter to FIFO send in task mode', () => {
    expect(resolveComposerKeyIntent(key({ key: 'Enter' }), { mode: 'task' })).toEqual({ kind: 'send' });
    expect(shouldPreventDefaultForComposerKey(key({ key: 'Enter' }), { mode: 'task' })).toBe(true);
  });

  it('maps Ctrl+Enter and Meta+Enter to sendLiveInput only in task mode (no queue fallback)', () => {
    expect(resolveComposerKeyIntent(key({ key: 'Enter', ctrlKey: true }), { mode: 'task' })).toEqual({
      kind: 'sendLiveInput',
    });
    expect(resolveComposerKeyIntent(key({ key: 'Enter', metaKey: true }), { mode: 'task' })).toEqual({
      kind: 'sendLiveInput',
    });
  });

  it('maps Ctrl+Enter to plain send in draft mode (no live inject path)', () => {
    expect(resolveComposerKeyIntent(key({ key: 'Enter', ctrlKey: true }), { mode: 'draft' })).toEqual({
      kind: 'send',
    });
    expect(resolveComposerKeyIntent(key({ key: 'Enter' }), { mode: 'draft' })).toEqual({ kind: 'send' });
  });
});

describe('buildTaskComposerMessage', () => {
  it('builds host send for FIFO follow-up queueing', () => {
    expect(
      buildTaskComposerMessage(
        { kind: 'send' },
        { taskId: 'task-1', text: '  follow up later  ' },
      ),
    ).toEqual({ type: 'send', taskId: 'task-1', text: 'follow up later' });
  });

  it('builds sendLiveInput only for live inject — never a send/queue message', () => {
    expect(
      buildTaskComposerMessage(
        { kind: 'sendLiveInput' },
        { taskId: 'task-1', text: 'steer now' },
      ),
    ).toEqual({ type: 'sendLiveInput', taskId: 'task-1', instruction: 'steer now' });
  });

  it('refuses empty / whitespace-only payloads for both intents', () => {
    expect(buildTaskComposerMessage({ kind: 'send' }, { taskId: 'task-1', text: '   ' })).toBeNull();
    expect(buildTaskComposerMessage({ kind: 'sendLiveInput' }, { taskId: 'task-1', text: '' })).toBeNull();
  });

  it('refuses task messages without a taskId', () => {
    expect(buildTaskComposerMessage({ kind: 'send' }, { text: 'hello' })).toBeNull();
    expect(buildTaskComposerMessage({ kind: 'sendLiveInput' }, { text: 'hello' })).toBeNull();
  });
});
