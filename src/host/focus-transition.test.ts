import { describe, expect, it } from 'vitest';
import { LatestFocusTransition } from './focus-transition';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('LatestFocusTransition', () => {
  it('prevents an older focus request from applying after a newer flush finishes', async () => {
    const transitions = new LatestFocusTransition();
    const firstFlush = deferred();
    const applied: string[] = [];

    const first = transitions.run(
      () => firstFlush.promise,
      async () => {
        applied.push('first');
      },
    );
    const second = transitions.run(
      async () => undefined,
      async () => {
        applied.push('second');
      },
    );

    await expect(second).resolves.toBe(true);
    firstFlush.resolve();
    await expect(first).resolves.toBe(false);
    expect(applied).toEqual(['second']);
  });
});
