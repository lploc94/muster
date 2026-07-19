import { describe, expect, it, beforeEach } from 'vitest';
import {
  outboxAdd,
  outboxList,
  outboxMarkRejected,
  outboxRejected,
  outboxReplaceAll,
  outboxRemove,
} from './send-outbox';

describe('send outbox (memory only)', () => {
  beforeEach(() => {
    outboxReplaceAll([]);
  });

  it('retains display-to-agent mention bindings when a send is rejected', () => {
    outboxAdd(undefined, {
      clientRequestId: 'request-1',
      taskId: 'task-1',
      text: 'Review @config.ts',
      llmText: 'Review @src/private/config.ts',
      mentionBindings: [['@config.ts', 'src/private/config.ts']],
      createdAt: 1,
      status: 'pending',
    });

    const rejected = outboxMarkRejected(undefined, 'request-1');

    expect(rejected).toMatchObject({
      status: 'rejected',
      mentionBindings: [['@config.ts', 'src/private/config.ts']],
    });
    expect(outboxRejected(undefined)).toHaveLength(1);
  });

  it('retains skill chips when a send is rejected and drops malformed skill entries', () => {
    outboxAdd(undefined, {
      clientRequestId: 'request-skills',
      text: 'Plan the migration',
      skills: ['planning', 'brainstorm'],
      createdAt: 3,
      status: 'pending',
    });

    const rejected = outboxMarkRejected(undefined, 'request-skills');
    expect(rejected).toMatchObject({
      status: 'rejected',
      skills: ['planning', 'brainstorm'],
    });

    outboxReplaceAll([
      {
        clientRequestId: 'request-dirty',
        text: 'Retry',
        skills: ['ok', '', 42 as unknown as string, null as unknown as string],
        createdAt: 4,
        status: 'rejected',
      },
    ]);
    expect(outboxList()).toEqual([
      expect.objectContaining({ clientRequestId: 'request-dirty', skills: ['ok'] }),
    ]);
  });

  it('drops malformed mention bindings and never uses setState', () => {
    outboxReplaceAll([
      {
        clientRequestId: 'request-2',
        text: 'Retry safely',
        mentionBindings: [
          ['@safe.ts', 'src/safe.ts'],
          ['missing-value'] as unknown as [string, string],
          [42 as unknown as string, 'src/number.ts'],
        ],
        createdAt: 2,
        status: 'rejected',
      },
    ]);

    expect(outboxList()).toEqual([
      expect.objectContaining({
        clientRequestId: 'request-2',
        mentionBindings: [['@safe.ts', 'src/safe.ts']],
      }),
    ]);
    outboxRemove(undefined, 'request-2');
    expect(outboxList()).toEqual([]);
  });
});
