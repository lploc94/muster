import { describe, expect, it } from 'vitest';
import { parseHostSendRequest } from './send-request';
import { SEND_OUTBOX_TEXT_MAX } from '../task/repository';

describe('parseHostSendRequest', () => {
  const valid = {
    type: 'send',
    clientRequestId: 'request-1',
    taskId: 'task-1',
    text: '@plan',
    llmText: '/workspace/docs/plan.md',
    backend: 'grok',
    model: 'grok-4',
    skills: ['review'],
    mentionBindings: [['@plan', '/workspace/docs/plan.md']],
  } as const;

  it('accepts the exact current durable-send shape', () => {
    expect(parseHostSendRequest(valid)).toEqual({
      ok: true,
      value: {
        ...valid,
        skills: ['review'],
        mentionBindings: [['@plan', '/workspace/docs/plan.md']],
      },
    });
  });

  it('rejects missing correlation, extra keys, malformed bindings, and oversized content', () => {
    expect(parseHostSendRequest({ ...valid, clientRequestId: undefined }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, legacy: true }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, mentionBindings: [['x']] }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, skills: ['bad skill'] }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, text: 'x'.repeat(SEND_OUTBOX_TEXT_MAX + 1) }).ok).toBe(false);
  });

  it('returns only a validated correlation on rejection', () => {
    expect(parseHostSendRequest({ ...valid, backend: 'unknown' })).toEqual({
      ok: false,
      clientRequestId: 'request-1',
      taskId: 'task-1',
    });
    expect(parseHostSendRequest({ ...valid, clientRequestId: 'bad id', backend: 'unknown' })).toEqual({
      ok: false,
      taskId: 'task-1',
    });
  });
});
