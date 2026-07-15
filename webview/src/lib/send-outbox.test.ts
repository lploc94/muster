import { describe, expect, it } from 'vitest';
import {
  outboxAdd,
  outboxList,
  outboxMarkRejected,
  outboxRejected,
} from './send-outbox';

function stateApi(initial: unknown = {}) {
  let state = initial;
  return {
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
    },
  };
}

describe('send outbox mention bindings', () => {
  it('retains display-to-agent mention bindings when a send is rejected', () => {
    const api = stateApi();
    outboxAdd(api, {
      clientRequestId: 'request-1',
      taskId: 'task-1',
      text: 'Review @config.ts',
      llmText: 'Review @src/private/config.ts',
      mentionBindings: [['@config.ts', 'src/private/config.ts']],
      createdAt: 1,
      status: 'pending',
    });

    const rejected = outboxMarkRejected(api, 'request-1');

    expect(rejected).toMatchObject({
      status: 'rejected',
      mentionBindings: [['@config.ts', 'src/private/config.ts']],
    });
    expect(outboxRejected(api)).toHaveLength(1);
  });

  it('retains skill chips when a send is rejected and drops malformed skill entries', () => {
    const api = stateApi();
    outboxAdd(api, {
      clientRequestId: 'request-skills',
      text: 'Plan the migration',
      skills: ['planning', 'brainstorm'],
      createdAt: 3,
      status: 'pending',
    });

    const rejected = outboxMarkRejected(api, 'request-skills');
    expect(rejected).toMatchObject({
      status: 'rejected',
      skills: ['planning', 'brainstorm'],
    });

    // Malformed persisted skills are filtered to string-only, non-empty values.
    const dirty = stateApi({
      sendOutbox: [
        {
          clientRequestId: 'request-dirty',
          text: 'Retry',
          skills: ['ok', '', 42, null],
          createdAt: 4,
          status: 'rejected',
        },
      ],
    });
    expect(outboxList(dirty)).toEqual([
      expect.objectContaining({ clientRequestId: 'request-dirty', skills: ['ok'] }),
    ]);
  });

  it('drops malformed persisted mention bindings instead of exposing them to Map construction', () => {
    const api = stateApi({
      sendOutbox: [
        {
          clientRequestId: 'request-2',
          text: 'Retry safely',
          mentionBindings: [
            ['@safe.ts', 'src/safe.ts'],
            ['missing-value'],
            [42, 'src/number.ts'],
            null,
          ],
          createdAt: 2,
          status: 'rejected',
        },
      ],
    });

    expect(outboxList(api)).toEqual([
      expect.objectContaining({
        clientRequestId: 'request-2',
        mentionBindings: [['@safe.ts', 'src/safe.ts']],
      }),
    ]);
  });
});
