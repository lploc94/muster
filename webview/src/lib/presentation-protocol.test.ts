import { describe, expect, it, vi } from 'vitest';
import {
  applyPresentationUpdate,
  parsePersistedPresentationState,
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

    expect(parsePresentationUpdate({ type: 'presentationUpdate', document, rootId: 'task-root' })).toEqual({
      document,
      rootId: 'task-root',
    });
  });

  it('accepts optional host and coordinator fields and envelope restore', () => {
    const document = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 1,
      title: 'Release notes',
      markdown: '# Ready',
      kind: 'plan' as const,
      summary: 'Ship notes',
      sourcePath: 'docs/plan.md',
      sourceFolderUri: 'file:///ws',
      updatedAt: '2026-07-15T00:00:00.000Z',
    };
    expect(parsePresentationUpdate({ type: 'presentationUpdate', document, rootId: 'root-1' })).toEqual({
      document,
      rootId: 'root-1',
    });
    expect(
      parsePersistedPresentationState({
        rootId: 'root-1',
        document,
      }),
    ).toEqual({ rootId: 'root-1', document });
    expect(
      parsePresentationUpdate({
        type: 'presentationUpdate',
        document: { ...document, sourcePath: document.sourcePath },
        rootId: 'bad id',
      }),
    ).toBeUndefined();
  });

  it('restores only an exact, bounded persisted presentation document', () => {
    const document = {
      presentationId: 'release-notes',
      ownerTaskId: 'task-root',
      revision: 2,
      title: 'Persisted release notes',
      markdown: '# Restored',
    };

    expect(parsePersistedPresentationState(document)).toBeUndefined();
    expect(parsePersistedPresentationState({ rootId: 'task-root', document })).toEqual({
      rootId: 'task-root',
      document,
    });
    expect(parsePersistedPresentationState({ rootId: 'task-root', document, injected: true })).toBeUndefined();
    expect(parsePersistedPresentationState({ rootId: 'task-root', document: { ...document, markdown: '' } })).toBeUndefined();
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

    expect(parsePresentationUpdate({ type: 'presentationUpdate', document, rootId: 'task-root' })).toBeUndefined();
    expect(
      parsePresentationUpdate({ type: 'presentationUpdate', document: { ...document, injected: undefined }, rootId: 'task-root', extra: true }),
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
      { type: 'presentationUpdate', document: { ...current, revision: 3, markdown: '' }, rootId: 'task-root' },
      { type: 'presentationUpdate', document: { ...current, revision: 2, title: 'Stale title' }, rootId: 'task-root' },
      { type: 'presentationUpdate', document: { ...current, revision: 3, presentationId: 'other' }, rootId: 'task-root' },
      { type: 'presentationUpdate', document: { ...current, revision: 3, ownerTaskId: 'other-task' }, rootId: 'task-root' },
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
    const message = value === null ? null : { type: 'presentationUpdate', document, rootId: 'task-root' };

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


});
