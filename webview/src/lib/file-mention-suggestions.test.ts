import { describe, expect, it } from 'vitest';
import {
  acceptFileMentionSuggestionResponse,
  type FileMentionSuggestionAcceptScope,
} from './file-mention-suggestions';
import type { FileMentionSuggestionItem, FileMentionSuggestionsMessage } from './protocol';

const items: FileMentionSuggestionItem[] = [
  {
    id: 'file:../root.md',
    kind: 'file',
    label: 'root.md',
    insertionPath: '../root.md',
  },
];

function scope(
  partial: Partial<FileMentionSuggestionAcceptScope> = {},
): FileMentionSuggestionAcceptScope {
  return {
    requestId: 'req-1',
    parentDepth: 1,
    relativeQuery: '',
    taskId: undefined,
    ...partial,
  };
}

function success(
  partial: Partial<Extract<FileMentionSuggestionsMessage, { items: FileMentionSuggestionItem[] }>> = {},
): FileMentionSuggestionsMessage {
  return {
    type: 'fileMentionSuggestions',
    requestId: 'req-1',
    parentDepth: 1,
    relativeQuery: '',
    items,
    ...partial,
  };
}

describe('acceptFileMentionSuggestionResponse', () => {
  it('accepts the latest matching requestId, parentDepth, relativeQuery, and task scope', () => {
    // Host response does not carry taskId; scope taskId is client-side only.
    // Without a focus argument, taskId is not compared (caller may omit focus).
    const accepted = acceptFileMentionSuggestionResponse(
      scope({ taskId: 'task-1' }),
      success(),
    );
    expect(accepted).toEqual({ ok: true, items });
  });

  it('accepts matching success when task scope is draft (no taskId)', () => {
    expect(acceptFileMentionSuggestionResponse(scope(), success())).toEqual({
      ok: true,
      items,
    });
  });

  it('rejects stale requestId without applying items', () => {
    expect(
      acceptFileMentionSuggestionResponse(scope({ requestId: 'req-current' }), success()),
    ).toBeNull();
  });

  it('rejects mismatched parentDepth or relativeQuery (stale active query)', () => {
    expect(
      acceptFileMentionSuggestionResponse(scope({ parentDepth: 2 }), success()),
    ).toBeNull();
    expect(
      acceptFileMentionSuggestionResponse(
        scope({ relativeQuery: 'lib/' }),
        success({ relativeQuery: '' }),
      ),
    ).toBeNull();
  });

  it('rejects when focused task scope changed after the request was issued', () => {
    expect(
      acceptFileMentionSuggestionResponse(
        scope({ taskId: 'task-a', requestId: 'req-1' }),
        // Response arrives after focus moved; caller supplies current focus for comparison.
        success(),
        { focusedTaskId: 'task-b' },
      ),
    ).toBeNull();

    expect(
      acceptFileMentionSuggestionResponse(
        scope({ taskId: 'task-a' }),
        success(),
        { focusedTaskId: 'task-a' },
      ),
    ).toEqual({ ok: true, items });

    expect(
      acceptFileMentionSuggestionResponse(scope({ taskId: undefined }), success(), {
        focusedTaskId: undefined,
      }),
    ).toEqual({ ok: true, items });
  });

  it('closes on failure envelope without free-form details', () => {
    const accepted = acceptFileMentionSuggestionResponse(scope(), {
      type: 'fileMentionSuggestions',
      ok: false,
      requestId: 'req-1',
      code: 'listingFailed',
    });
    expect(accepted).toEqual({ ok: false, items: [] });
  });

  it('rejects failure envelopes with mismatched requestId', () => {
    expect(
      acceptFileMentionSuggestionResponse(scope({ requestId: 'req-current' }), {
        type: 'fileMentionSuggestions',
        ok: false,
        requestId: 'req-old',
        code: 'unavailable',
      }),
    ).toBeNull();
  });
});
