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

  it('retains attachment paths when a send is rejected so a retry re-sends the images', () => {
    outboxAdd(undefined, {
      clientRequestId: 'request-images',
      taskId: 'task-1',
      text: 'look at these',
      attachments: [
        'C:\\Users\\dev\\AppData\\Local\\Temp\\muster-drop-x\\shot.png',
        '/var/folders/tmp/muster-drop-y/diagram.jpeg',
      ],
      createdAt: 2,
      status: 'pending',
    });

    // Losing these on retry would silently send a text-only prompt: the images
    // were part of the original send and the user gets no notice they vanished.
    expect(outboxMarkRejected(undefined, 'request-images')).toMatchObject({
      status: 'rejected',
      attachments: [
        'C:\\Users\\dev\\AppData\\Local\\Temp\\muster-drop-x\\shot.png',
        '/var/folders/tmp/muster-drop-y/diagram.jpeg',
      ],
    });
  });

  it('bounds and de-duplicates attachments restored from the host snapshot', () => {
    outboxReplaceAll([
      {
        clientRequestId: 'request-dirty-images',
        text: 'Retry',
        attachments: [
          '/tmp/a.png',
          '/tmp/a.png',
          42 as unknown as string,
          '',
          '/tmp/b.png',
          '/tmp/c.png',
          '/tmp/d.png',
          '/tmp/e.png',
        ],
        createdAt: 4,
        status: 'rejected',
      },
    ]);

    // Mirrors the host cap in src/host/send-request.ts: a snapshot row that
    // disagrees would otherwise be replayed into a send the host rejects whole.
    expect(outboxList()).toEqual([
      expect.objectContaining({
        clientRequestId: 'request-dirty-images',
        attachments: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png', '/tmp/d.png'],
      }),
    ]);
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
