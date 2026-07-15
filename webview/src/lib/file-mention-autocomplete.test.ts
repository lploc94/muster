import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_MENTION_SUGGESTION_DEBOUNCE_MS,
  acceptFileMentionSuggestions,
  createFileMentionAutocompleteSession,
  refineActiveFileMentionDirectory,
  replaceActiveFileMentionQuery,
} from './file-mention-autocomplete';
import type { FileMentionSuggestionItem } from './protocol';

const sampleItems: FileMentionSuggestionItem[] = [
  {
    id: 'file:readme.md',
    kind: 'file',
    label: 'readme.md',
    insertionPath: 'readme.md',
  },
  {
    id: 'dir:src',
    kind: 'directory',
    label: 'src',
    insertionPath: 'src',
  },
];

const parentItems: FileMentionSuggestionItem[] = [
  {
    id: 'file:../root.md',
    kind: 'file',
    label: 'root.md',
    insertionPath: '../root.md',
  },
  {
    id: 'dir:../packages',
    kind: 'directory',
    label: 'packages',
    insertionPath: '../packages',
  },
];

describe('replaceActiveFileMentionQuery', () => {
  it('replaces exactly the active @query range with the mention token', () => {
    const text = 'Review @rea more';
    const result = replaceActiveFileMentionQuery(text, { start: 7, end: 11 }, '@readme.md');
    expect(result.text).toBe('Review @readme.md more');
    expect(result.caret).toBe('Review @readme.md'.length);
  });

  it('adds a trailing space when the suffix does not start with whitespace', () => {
    const text = 'See @fi';
    const result = replaceActiveFileMentionQuery(text, { start: 4, end: 7 }, '@file.ts');
    expect(result.text).toBe('See @file.ts ');
    expect(result.caret).toBe('See @file.ts '.length);
  });

  it('does not double spaces when the suffix already has whitespace', () => {
    const text = 'See @fi next';
    const result = replaceActiveFileMentionQuery(text, { start: 4, end: 7 }, '@file.ts');
    expect(result.text).toBe('See @file.ts next');
  });
});

describe('refineActiveFileMentionDirectory', () => {
  it('replaces the active range with @insertionPath/ and keeps autocomplete open for children', () => {
    const text = 'Open @../';
    const result = refineActiveFileMentionDirectory(text, { start: 5, end: 9 }, '../packages');
    expect(result.text).toBe('Open @../packages/');
    expect(result.caret).toBe('Open @../packages/'.length);
  });

  it('normalizes separators and strips trailing slashes from insertionPath', () => {
    const result = refineActiveFileMentionDirectory('@../', { start: 0, end: 4 }, '..\\src\\');
    expect(result.text).toBe('@../src/');
    expect(result.caret).toBe('@../src/'.length);
  });
});

describe('acceptFileMentionSuggestions', () => {
  it('accepts a matching success response and stores items', () => {
    const accepted = acceptFileMentionSuggestions(
      { requestId: 'req-1', relativeQuery: 're', parentDepth: 0 },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: 're',
        items: sampleItems,
      },
    );
    expect(accepted).toEqual({ ok: true, items: sampleItems });
  });

  it('rejects mismatched requestId (stale response)', () => {
    const accepted = acceptFileMentionSuggestions(
      { requestId: 'req-current', relativeQuery: 're', parentDepth: 0 },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-old',
        parentDepth: 0,
        relativeQuery: 're',
        items: sampleItems,
      },
    );
    expect(accepted).toBeNull();
  });

  it('closes on failure envelope without exposing error details', () => {
    const accepted = acceptFileMentionSuggestions(
      { requestId: 'req-1', relativeQuery: '', parentDepth: 0 },
      {
        type: 'fileMentionSuggestions',
        ok: false,
        requestId: 'req-1',
        code: 'listingFailed',
      },
    );
    expect(accepted).toEqual({ ok: false, items: [] });
  });
});

describe('createFileMentionAutocompleteSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces request posts and only keeps the latest scope', () => {
    const posts: unknown[] = [];
    let seq = 0;
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => `req-${++seq}`,
    });

    session.onCaretChange({
      text: '@',
      caret: 1,
      canSend: true,
      taskId: undefined,
    });
    session.onCaretChange({
      text: '@r',
      caret: 2,
      canSend: true,
      taskId: undefined,
    });

    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS - 1);
    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(1);

    // Debounce coalesces keystrokes into a single fire; createRequestId runs once.
    expect(posts).toEqual([
      {
        type: 'requestFileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: 'r',
      },
    ]);
    expect(session.getState().pendingRequestId).toBe('req-1');
    expect(session.getState().activeQuery).toEqual({
      start: 0,
      end: 2,
      parentDepth: 0,
      relativeQuery: 'r',
    });
    session.dispose();
  });

  it('posts parentDepth 1 for @../ and parentDepth 2 for @../../', () => {
    const posts: unknown[] = [];
    let seq = 0;
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => `req-${++seq}`,
    });

    session.onCaretChange({ text: '@../', caret: 4, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(posts).toEqual([
      {
        type: 'requestFileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 1,
        relativeQuery: '',
      },
    ]);

    session.onCaretChange({ text: 'See @../../lib', caret: 14, canSend: true, taskId: 'task-a' });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(posts[1]).toEqual({
      type: 'requestFileMentionSuggestions',
      requestId: 'req-2',
      taskId: 'task-a',
      parentDepth: 2,
      relativeQuery: 'lib',
    });
    session.dispose();
  });

  it('never requests the host for depth-3 traversal tokens', () => {
    const posts: unknown[] = [];
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => 'req-x',
    });

    session.onCaretChange({ text: '@../../../', caret: 10, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(posts).toHaveLength(0);
    expect(session.getState().open).toBe(false);
    expect(session.getState().pendingRequestId).toBeNull();
    session.dispose();
  });

  it('includes optional taskId on task-scoped requests', () => {
    const posts: unknown[] = [];
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => 'req-task',
    });

    session.onCaretChange({
      text: 'open @',
      caret: 6,
      canSend: true,
      taskId: 'task-1',
    });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);

    expect(posts).toEqual([
      {
        type: 'requestFileMentionSuggestions',
        requestId: 'req-task',
        taskId: 'task-1',
        parentDepth: 0,
        relativeQuery: '',
      },
    ]);
    session.dispose();
  });

  it('closes and does not request when the query is invalid or composer is blocked', () => {
    const posts: unknown[] = [];
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => 'req-x',
    });

    session.onCaretChange({
      text: '@ok',
      caret: 3,
      canSend: true,
    });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);

    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-x',
      parentDepth: 0,
      relativeQuery: 'ok',
      items: sampleItems,
    });
    expect(session.getState().open).toBe(true);
    // S02 shows both file and directory rows for navigation.
    expect(session.getState().items).toEqual(sampleItems);

    session.onCaretChange({
      text: 'user@example.com',
      caret: 16,
      canSend: true,
    });
    expect(session.getState().open).toBe(false);
    expect(session.getState().items).toEqual([]);
    expect(session.getState().pendingRequestId).toBeNull();

    session.onCaretChange({
      text: '@blocked',
      caret: 8,
      canSend: false,
    });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(posts).toHaveLength(1); // no new request
    session.dispose();
  });

  it('ignores stale responses and closes on scope reset', () => {
    const posts: unknown[] = [];
    let seq = 0;
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => `req-${++seq}`,
    });

    session.onCaretChange({ text: '@a', caret: 2, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    session.onCaretChange({ text: '@ab', caret: 3, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    // Two fires => req-1 then req-2
    expect(posts).toHaveLength(2);

    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-1',
      parentDepth: 0,
      relativeQuery: 'a',
      items: sampleItems,
    });
    expect(session.getState().open).toBe(false);

    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-2',
      parentDepth: 0,
      relativeQuery: 'ab',
      items: sampleItems,
    });
    expect(session.getState().open).toBe(true);
    expect(session.getState().items).toEqual(sampleItems);

    session.reset();
    expect(session.getState()).toEqual({
      open: false,
      items: [],
      activeQuery: null,
      pendingRequestId: null,
      outcome: 'closed',
    });
    session.dispose();
  });

  it('ignores stale responses from a prior parentDepth or focused task', () => {
    const posts: unknown[] = [];
    let seq = 0;
    const session = createFileMentionAutocompleteSession({
      post: (msg) => posts.push(msg),
      createRequestId: () => `req-${++seq}`,
    });

    session.onCaretChange({ text: '@../', caret: 4, canSend: true, taskId: 'task-a' });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);

    // Late depth-0 response with matching id shape must not paint.
    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-1',
      parentDepth: 0,
      relativeQuery: '',
      items: sampleItems,
    });
    expect(session.getState().open).toBe(false);

    // Matching requestId + query but focus moved to another task.
    session.onCaretChange({ text: '@../', caret: 4, canSend: true, taskId: 'task-b' });
    // Focus change alone does not re-fire until debounce; keep pending scope for task-a
    // by applying a late matching response after focus moved via a new request:
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(posts).toHaveLength(2);

    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-1',
      parentDepth: 1,
      relativeQuery: '',
      items: parentItems,
    });
    expect(session.getState().open).toBe(false);

    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-2',
      parentDepth: 1,
      relativeQuery: '',
      items: parentItems,
    });
    expect(session.getState().open).toBe(true);
    expect(session.getState().items).toEqual(parentItems);
    session.dispose();
  });

  it('shows file and directory items for mouse navigation (S02)', () => {
    const session = createFileMentionAutocompleteSession({
      post: () => {},
      createRequestId: () => 'req-1',
    });
    session.onCaretChange({ text: '@', caret: 1, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-1',
      parentDepth: 0,
      relativeQuery: '',
      items: sampleItems,
    });
    expect(session.getState().items.map((i) => i.kind)).toEqual(['file', 'directory']);
    session.dispose();
  });

  it('tracks loading/ready/empty/error outcomes without clearing draft scope', () => {
    const session = createFileMentionAutocompleteSession({
      post: () => {},
      createRequestId: () => 'req-1',
    });

    expect(session.getState().outcome).toBe('closed');

    session.onCaretChange({ text: '@nope', caret: 5, canSend: true });
    // Debouncing: query is active but not yet requested.
    expect(session.getState().activeQuery?.relativeQuery).toBe('nope');
    expect(session.getState().outcome).toBe('closed');

    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(session.getState().outcome).toBe('loading');
    expect(session.getState().pendingRequestId).toBe('req-1');
    expect(session.getState().open).toBe(false);

    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-1',
      parentDepth: 0,
      relativeQuery: 'nope',
      items: [],
    });
    expect(session.getState().outcome).toBe('empty');
    expect(session.getState().open).toBe(true);
    expect(session.getState().items).toEqual([]);
    // Active query preserved so draft/caret replacement range stays valid.
    expect(session.getState().activeQuery).toEqual({
      start: 0,
      end: 5,
      parentDepth: 0,
      relativeQuery: 'nope',
    });

    session.onCaretChange({ text: '@fail', caret: 5, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    expect(session.getState().outcome).toBe('loading');

    session.onResponse({
      type: 'fileMentionSuggestions',
      ok: false,
      requestId: 'req-1',
      code: 'listingFailed',
    });
    expect(session.getState().outcome).toBe('error');
    expect(session.getState().open).toBe(true);
    expect(session.getState().items).toEqual([]);
    // Never stores host error codes or free-form text.
    expect(JSON.stringify(session.getState())).not.toMatch(/listingFailed|\/Users|C:\\/);

    session.onCaretChange({ text: '@ok', caret: 3, canSend: true });
    vi.advanceTimersByTime(FILE_MENTION_SUGGESTION_DEBOUNCE_MS);
    session.onResponse({
      type: 'fileMentionSuggestions',
      requestId: 'req-1',
      parentDepth: 0,
      relativeQuery: 'ok',
      items: sampleItems,
    });
    expect(session.getState().outcome).toBe('ready');
    expect(session.getState().open).toBe(true);
    expect(session.getState().items).toEqual(sampleItems);

    session.reset();
    expect(session.getState().outcome).toBe('closed');
    expect(session.getState().open).toBe(false);
    session.dispose();
  });
});
