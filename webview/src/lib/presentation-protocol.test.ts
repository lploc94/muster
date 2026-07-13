import { describe, expect, it, vi } from 'vitest';
import {
  applyPresentationUpdate,
  parsePersistedPresentation,
  parsePresentationRevealRequest,
  parsePresentationRevealResult,
  parsePresentationUpdate,
} from './presentation-protocol';

// protocol.ts acquires the webview API at import time; stub for node tests.
vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import {
  formatLiveInputDeliveredMessage,
  isExtMessage,
  isTaskScopedBannerVisible,
  type OutMessage,
  post,
} from './protocol';
import { vscode } from './vscode';

describe('presentation browser protocol', () => {
  it('accepts only exact identity-free linked-chat requests and typed results', () => {
    expect(parsePresentationRevealRequest({ type: 'revealLinkedChat' })).toEqual({ type: 'revealLinkedChat' });
    expect(parsePresentationRevealRequest({ type: 'revealLinkedChat', ownerTaskId: 'forged' })).toBeUndefined();
    expect(parsePresentationRevealResult({ type: 'revealLinkedChatResult', status: 'success' })).toEqual({ type: 'revealLinkedChatResult', status: 'success' });
    expect(parsePresentationRevealResult({ type: 'revealLinkedChatResult', status: 'failure', error: 'secret' })).toBeUndefined();
  });

  it('accepts an exact, bounded presentation update from the host', () => {
    const document = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 1,
      title: 'Release notes',
      markdown: '# Ready',
    };

    expect(parsePresentationUpdate({ type: 'presentationUpdate', document })).toEqual(document);
  });

  it('restores only an exact, bounded persisted presentation document', () => {
    const document = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 2,
      title: 'Persisted release notes',
      markdown: '# Restored',
    };

    expect(parsePersistedPresentation(document)).toEqual(document);
    expect(parsePersistedPresentation({ ...document, injected: true })).toBeUndefined();
    expect(parsePersistedPresentation({ ...document, markdown: '' })).toBeUndefined();
  });

  it('rejects unknown message or document fields', () => {
    const document = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 1,
      title: 'Release notes',
      markdown: '# Ready',
      injected: true,
    };

    expect(parsePresentationUpdate({ type: 'presentationUpdate', document })).toBeUndefined();
    expect(
      parsePresentationUpdate({ type: 'presentationUpdate', document: { ...document, injected: undefined }, extra: true }),
    ).toBeUndefined();
  });

  it('preserves the last accepted document for malformed, stale, or identity-conflicting updates', () => {
    const current = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 2,
      title: 'Accepted title',
      markdown: '# Accepted body',
    };
    const rejected = [
      { type: 'presentationUpdate', document: { ...current, revision: 3, markdown: '' } },
      { type: 'presentationUpdate', document: { ...current, revision: 2, title: 'Stale title' } },
      { type: 'presentationUpdate', document: { ...current, revision: 3, presentationId: 'other' } },
      { type: 'presentationUpdate', document: { ...current, revision: 3, ownerTaskId: 'other-task' } },
    ];

    for (const message of rejected) {
      expect(applyPresentationUpdate(current, message)).toBe(current);
    }
  });

  it.each([
    ['non-object message', null],
    ['wrong message type', { type: 'snapshot', document: {} }],
    ['invalid presentation ID', { presentationId: 'contains spaces' }],
    ['empty owner task ID', { ownerTaskId: '' }],
    ['zero revision', { revision: 0 }],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty title', { title: '' }],
    ['oversized title', { title: 't'.repeat(201) }],
    ['empty Markdown', { markdown: '' }],
    ['oversized Markdown', { markdown: 'm'.repeat(100_001) }],
  ])('rejects %s at the browser trust boundary', (_label, value) => {
    const document = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 1,
      title: 'Release notes',
      markdown: '# Ready',
      ...(typeof value === 'object' && value !== null ? value : {}),
    };
    const message = value === null ? null : { type: 'presentationUpdate', document };

    expect(parsePresentationUpdate(message)).toBeUndefined();
  });
});

describe('live-input host protocol (S01 integration surface)', () => {
  it('exposes sendLiveInput as a typed OutMessage distinct from continueTask', () => {
    vi.mocked(vscode.postMessage).mockClear();
    const live: OutMessage = {
      type: 'sendLiveInput',
      taskId: 'task-1',
      instruction: 'live nudge',
    };
    post(live);
    expect(vscode.postMessage).toHaveBeenCalledWith(live);
    expect(live.type).not.toBe('continueTask');
  });

  it('accepts delivered liveInputResult and commandError refusal shapes', () => {
    expect(
      isExtMessage({
        type: 'liveInputResult',
        taskId: 'task-1',
        code: 'delivered',
        sessionId: 'sess-1',
      }),
    ).toBe(true);
    expect(
      isExtMessage({
        type: 'commandError',
        taskId: 'task-1',
        message: 'Live input unsupported: no capability',
      }),
    ).toBe(true);
  });

  it('formats delivered live-input acknowledgements for the App notice banner', () => {
    expect(formatLiveInputDeliveredMessage('sess-1').toLowerCase()).toContain('delivered');
    expect(isTaskScopedBannerVisible('task-1', 'task-1')).toBe(true);
    expect(isTaskScopedBannerVisible('task-1', 'other')).toBe(false);
  });
});
