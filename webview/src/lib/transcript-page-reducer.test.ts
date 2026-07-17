import { describe, expect, it } from 'vitest';
import type { TranscriptItem, TranscriptPageResultMessage } from './protocol';
import {
  applyTranscriptPageResult,
  beginLoadOlder,
  clearOlderPagePending,
  emptyTranscriptPageWindowState,
  ownershipFromTranscript,
  type TranscriptPageWindowState,
} from './transcript-page-reducer';

function user(id: string, text: string): TranscriptItem {
  return { id, kind: 'user', content: text, turnId: `turn-${id}`, order: 0 };
}

function assistant(id: string, text: string, turnId = 'turn-a'): TranscriptItem {
  return { id, kind: 'assistant', content: text, turnId, order: 1 };
}

function tool(id: string, status: 'running' | 'success' | 'error' = 'success'): TranscriptItem {
  return {
    id,
    kind: 'tool',
    turnId: 'turn-a',
    order: 2,
    content: {
      toolCallId: id,
      name: 'bash',
      status,
      input: { cmd: 'echo hi' },
      ...(status === 'success' ? { output: 'hi' } : {}),
    },
  };
}

function reasoning(id: string, turnId: string, content: string): TranscriptItem {
  return { id, kind: 'reasoning', turnId, content };
}

function success(
  requestId: string,
  items: TranscriptItem[],
  page: { hasMoreBefore: boolean; beforeCursor?: string; workspaceRevision: number },
  taskId = 'task-1',
): TranscriptPageResultMessage {
  return {
    type: 'transcriptPageResult',
    requestId,
    taskId,
    ok: true,
    items,
    transcriptPage: {
      hasMoreBefore: page.hasMoreBefore,
      workspaceRevision: page.workspaceRevision,
      ...(page.hasMoreBefore && page.beforeCursor
        ? { beforeCursor: page.beforeCursor }
        : {}),
    },
  };
}

function failure(
  requestId: string,
  code: 'invalidRequest' | 'staleFocus' | 'taskNotFound' | 'invalidCursor' | 'unavailable',
  taskId = 'task-1',
): TranscriptPageResultMessage {
  return {
    type: 'transcriptPageResult',
    requestId,
    taskId,
    ok: false,
    code,
  };
}

function seeded(ids: string[], revision = 5): TranscriptPageWindowState {
  const items = ids.map((id) => ({
    kind: 'user' as const,
    id,
    text: `text-${id}`,
    turnId: `turn-${id}`,
    order: 0,
  }));
  return {
    ...emptyTranscriptPageWindowState(),
    items,
    loadedTranscriptIds: new Set(ids),
    beforeCursor: 'v2.seed',
    hasMoreBefore: true,
    transcriptWorkspaceRevision: revision,
  };
}

describe('beginLoadOlder', () => {
  it('starts a single in-flight request when cursor/hasMore allow it', () => {
    const state = seeded(['u2', 'u3']);
    const result = beginLoadOlder(state, { taskId: 'task-1', requestId: 'req-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.beforeCursor).toBe('v2.seed');
    expect(result.state.olderPageLoading).toBe(true);
    expect(result.state.pendingRequestId).toBe('req-1');
    expect(result.state.olderPageError).toBeUndefined();
  });

  it('refuses when locked by no_more / no_cursor / in_flight / no_task', () => {
    expect(
      beginLoadOlder(seeded(['u1']), { taskId: null, requestId: 'req-1' }).ok,
    ).toBe(false);
    const noMore = beginLoadOlder(
      { ...seeded(['u1']), hasMoreBefore: false },
      { taskId: 'task-1', requestId: 'req-1' },
    );
    expect(noMore.ok).toBe(false);
    if (noMore.ok) return;
    expect(noMore.reason).toBe('no_more');
    const noCursor = beginLoadOlder(
      { ...seeded(['u1']), beforeCursor: undefined },
      { taskId: 'task-1', requestId: 'req-1' },
    );
    expect(noCursor.ok).toBe(false);
    if (noCursor.ok) return;
    expect(noCursor.reason).toBe('no_cursor');
    const loading = beginLoadOlder(seeded(['u1']), { taskId: 'task-1', requestId: 'req-1' });
    expect(loading.ok).toBe(true);
    if (!loading.ok) return;
    const inFlight = beginLoadOlder(loading.state, { taskId: 'task-1', requestId: 'req-2' });
    expect(inFlight.ok).toBe(false);
    if (inFlight.ok) return;
    expect(inFlight.reason).toBe('in_flight');
  });
});

describe('applyTranscriptPageResult', () => {
  it('prepends older items in host order and advances page metadata', () => {
    const pending = beginLoadOlder(seeded(['u2', 'u3']), {
      taskId: 'task-1',
      requestId: 'req-1',
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [user('u0', 'oldest'), user('u1', 'older')],
        { hasMoreBefore: true, beforeCursor: 'v2.next', workspaceRevision: 7 },
      ),
      'task-1',
    );
    expect(applied.applied).toBe(true);
    expect(applied.kind).toBe('success');
    expect(applied.state.items.map((i) => i.id)).toEqual(['u0', 'u1', 'u2', 'u3']);
    expect(applied.state.beforeCursor).toBe('v2.next');
    expect(applied.state.hasMoreBefore).toBe(true);
    expect(applied.state.transcriptWorkspaceRevision).toBe(7);
    expect(applied.state.olderPageLoading).toBe(false);
    expect(applied.state.lastAppliedRequestId).toBe('req-1');
  });

  it('replays the same success as a no-op after first apply', () => {
    const pending = beginLoadOlder(seeded(['u2']), {
      taskId: 'task-1',
      requestId: 'req-1',
    });
    if (!pending.ok) throw new Error('expected pending');
    const msg = success(
      'req-1',
      [user('u1', 'older')],
      { hasMoreBefore: false, workspaceRevision: 6 },
    );
    const first = applyTranscriptPageResult(pending.state, msg, 'task-1');
    expect(first.applied).toBe(true);
    const second = applyTranscriptPageResult(first.state, msg, 'task-1');
    expect(second.applied).toBe(false);
    expect(second.kind).toBe('noop');
    expect(second.state.items.map((i) => i.id)).toEqual(['u1', 'u2']);
  });

  it('lets existing IDs win over overlapping older-page content', () => {
    const base = {
      ...seeded(['a1']),
      items: [
        {
          kind: 'assistant' as const,
          id: 'a1',
          text: 'live newer text',
          turnId: 'turn-a',
          order: 1,
        },
      ],
      loadedTranscriptIds: new Set(['a1']),
    };
    const pending = beginLoadOlder(base, { taskId: 'task-1', requestId: 'req-1' });
    if (!pending.ok) throw new Error('expected pending');
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [assistant('a1', 'stale older text'), user('u0', 'older user')],
        { hasMoreBefore: false, workspaceRevision: 6 },
      ),
      'task-1',
    );
    expect(applied.state.items.map((i) => i.id)).toEqual(['u0', 'a1']);
    const a1 = applied.state.items.find((i) => i.id === 'a1');
    expect(a1 && a1.kind === 'assistant' ? a1.text : null).toBe('live newer text');
  });

  it('treats currently rendered item IDs as owned even if ownership set lagged', () => {
    // Live commitStreaming/tool paths historically could leave an item in
    // `items` without seeding loadedTranscriptIds — still must not duplicate.
    const base: TranscriptPageWindowState = {
      ...seeded([]),
      items: [
        {
          kind: 'assistant',
          id: 'live-a1',
          text: 'live stream text',
          turnId: 'turn-a',
          order: 1,
        },
      ],
      loadedTranscriptIds: new Set(),
      beforeCursor: 'v2.seed',
      hasMoreBefore: true,
    };
    const pending = beginLoadOlder(base, { taskId: 'task-1', requestId: 'req-1' });
    if (!pending.ok) throw new Error('expected pending');
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [assistant('live-a1', 'stale older text'), user('u0', 'older')],
        { hasMoreBefore: false, workspaceRevision: 2 },
      ),
      'task-1',
    );
    expect(applied.state.items.map((i) => i.id)).toEqual(['u0', 'live-a1']);
    const live = applied.state.items.find((i) => i.id === 'live-a1');
    expect(live && live.kind === 'assistant' ? live.text : null).toBe('live stream text');
  });

  it('does not overwrite existing live tool content', () => {
    const base: TranscriptPageWindowState = {
      ...seeded([]),
      items: [
        {
          kind: 'tool',
          id: 'tool-1',
          name: 'bash',
          status: 'running',
          input: { cmd: 'live' },
          turnId: 'turn-a',
          order: 2,
        },
      ],
      loadedTranscriptIds: new Set(['tool-1']),
      beforeCursor: 'v2.seed',
      hasMoreBefore: true,
    };
    const pending = beginLoadOlder(base, { taskId: 'task-1', requestId: 'req-1' });
    if (!pending.ok) throw new Error('expected pending');
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [tool('tool-1', 'success'), user('u0', 'older')],
        { hasMoreBefore: false, workspaceRevision: 2 },
      ),
      'task-1',
    );
    const t = applied.state.items.find((i) => i.id === 'tool-1');
    expect(t && t.kind === 'tool' ? t.status : null).toBe('running');
    expect(t && t.kind === 'tool' ? t.input : null).toEqual({ cmd: 'live' });
  });

  it('does not overwrite live reasoning when ownership id is the turn id', () => {
    // Live reasoningDelta owns activeTurnId as the entity id (not backend messageId).
    const base: TranscriptPageWindowState = {
      ...seeded(['u1']),
      reasoningByTurn: { 'turn-live': 'live stream reasoning' },
      loadedTranscriptIds: new Set(['u1', 'turn-live']),
      beforeCursor: 'v2.seed',
      hasMoreBefore: true,
    };
    const pending = beginLoadOlder(base, { taskId: 'task-1', requestId: 'req-1' });
    if (!pending.ok) throw new Error('expected pending');
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [reasoning('turn-live', 'turn-live', 'stale older reasoning'), user('u0', 'older')],
        { hasMoreBefore: false, workspaceRevision: 2 },
      ),
      'task-1',
    );
    expect(applied.state.reasoningByTurn['turn-live']).toBe('live stream reasoning');
    expect(applied.state.items.map((i) => i.id)).toEqual(['u0', 'u1']);
  });

  it('dedupes reasoning by entity id and never overwrites existing turn reasoning', () => {
    const base: TranscriptPageWindowState = {
      ...seeded(['u1']),
      reasoningByTurn: { 'turn-a': 'live reasoning' },
      loadedTranscriptIds: new Set(['u1', 'r-live']),
      beforeCursor: 'v2.seed',
      hasMoreBefore: true,
    };
    const pending = beginLoadOlder(base, { taskId: 'task-1', requestId: 'req-1' });
    if (!pending.ok) throw new Error('expected pending');
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [
          reasoning('r-old', 'turn-a', 'older reasoning'),
          reasoning('r-new-turn', 'turn-b', 'first'),
          reasoning('r-new-turn-2', 'turn-b', 'second canonical'),
        ],
        { hasMoreBefore: false, workspaceRevision: 3 },
      ),
      'task-1',
    );
    expect(applied.state.reasoningByTurn['turn-a']).toBe('live reasoning');
    // Within an older page for a turn with no prior reasoning, last row wins
    // (hydrate canonical). Existing/live turns are never overwritten.
    expect(applied.state.reasoningByTurn['turn-b']).toBe('second canonical');
    expect(applied.state.loadedTranscriptIds.has('r-old')).toBe(true);
    expect(applied.state.loadedTranscriptIds.has('r-new-turn')).toBe(true);
  });

  it('no-ops stale task/request responses and does not clear a newer pending request', () => {
    const pending = beginLoadOlder(seeded(['u2']), {
      taskId: 'task-1',
      requestId: 'req-new',
    });
    if (!pending.ok) throw new Error('expected pending');
    const staleTask = applyTranscriptPageResult(
      pending.state,
      success(
        'req-new',
        [user('u1', 'x')],
        { hasMoreBefore: false, workspaceRevision: 1 },
        'other-task',
      ),
      'task-1',
    );
    expect(staleTask.applied).toBe(false);
    expect(staleTask.state.pendingRequestId).toBe('req-new');

    const staleRequest = applyTranscriptPageResult(
      pending.state,
      success(
        'req-old',
        [user('u1', 'x')],
        { hasMoreBefore: false, workspaceRevision: 1 },
      ),
      'task-1',
    );
    expect(staleRequest.applied).toBe(false);
    expect(staleRequest.state.pendingRequestId).toBe('req-new');
    expect(staleRequest.state.olderPageLoading).toBe(true);
  });

  it('does not let revision go backwards', () => {
    const pending = beginLoadOlder(seeded(['u2'], 10), {
      taskId: 'task-1',
      requestId: 'req-1',
    });
    if (!pending.ok) throw new Error('expected pending');
    const applied = applyTranscriptPageResult(
      pending.state,
      success(
        'req-1',
        [user('u1', 'older')],
        { hasMoreBefore: false, workspaceRevision: 4 },
      ),
      'task-1',
    );
    expect(applied.state.transcriptWorkspaceRevision).toBe(10);
  });

  it('matching error clears loading and allows retry', () => {
    const pending = beginLoadOlder(seeded(['u2']), {
      taskId: 'task-1',
      requestId: 'req-1',
    });
    if (!pending.ok) throw new Error('expected pending');
    const errored = applyTranscriptPageResult(
      pending.state,
      failure('req-1', 'unavailable'),
      'task-1',
    );
    expect(errored.applied).toBe(true);
    expect(errored.kind).toBe('error');
    expect(errored.state.olderPageLoading).toBe(false);
    expect(errored.state.olderPageError).toBe('unavailable');
    expect(errored.state.pendingRequestId).toBeUndefined();
    const retry = beginLoadOlder(errored.state, { taskId: 'task-1', requestId: 'req-2' });
    expect(retry.ok).toBe(true);
  });

  it('focus/hydrate clear invalidates pending response', () => {
    const pending = beginLoadOlder(seeded(['u2']), {
      taskId: 'task-1',
      requestId: 'req-1',
    });
    if (!pending.ok) throw new Error('expected pending');
    const cleared = clearOlderPagePending(pending.state);
    const late = applyTranscriptPageResult(
      cleared,
      success(
        'req-1',
        [user('u1', 'older')],
        { hasMoreBefore: false, workspaceRevision: 2 },
      ),
      'task-1',
    );
    expect(late.applied).toBe(false);
    expect(late.state.items.map((i) => i.id)).toEqual(['u2']);
  });
});

describe('ownershipFromTranscript', () => {
  it('includes reasoning entity ids', () => {
    const ids = ownershipFromTranscript([
      user('u1', 'a'),
      reasoning('r1', 'turn-a', 'think'),
    ]);
    expect([...ids].sort()).toEqual(['r1', 'u1']);
  });
});
