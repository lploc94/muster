import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '../types';
import {
  makeFakeAcpClient,
  type FakeAcpHarness,
} from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend } from './claude';

describe('ACP run input routing', () => {
  let fake: FakeAcpHarness;

  beforeEach(() => {
    fake = makeFakeAcpClient({ sessionId: 'sess-routing' });
    H.current = fake;
  });

  afterEach(() => {
    H.current = null;
  });

  it('rejects a script input before dispatching an ACP prompt', async () => {
    const events: NormalizedEvent[] = [];
    for await (const event of new ClaudeBackend().run({
      input: { kind: 'script', interpreter: 'node', file: 'script.js', args: [] },
    })) {
      events.push(event);
    }

    expect(fake.calls.prompt).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('acp backend received a script run input'),
      }),
    ]);
  });
});
