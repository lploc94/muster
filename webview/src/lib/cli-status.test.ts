import { describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import {
  cliStatusFromTask,
  deriveCliLastExit,
  deriveCliViewStatus,
  getCliStatusPresentation,
} from './cli-status';

describe('deriveCliViewStatus', () => {
  it('maps generating live turns to running', () => {
    expect(
      deriveCliViewStatus({ lifecycle: 'open', runtimeActivity: 'running' }),
    ).toBe('running');
    expect(
      deriveCliViewStatus({
        lifecycle: 'open',
        runtimeActivity: 'idle',
        threadRunning: true,
      }),
    ).toBe('running');
  });

  it('maps waiting_user / askPending to idle (process on, not generating)', () => {
    expect(
      deriveCliViewStatus({ lifecycle: 'open', runtimeActivity: 'waiting_user' }),
    ).toBe('idle');
    expect(
      deriveCliViewStatus({
        lifecycle: 'open',
        runtimeActivity: 'running',
        askPending: true,
      }),
    ).toBe('idle');
  });

  it('maps queued (not spawned) to not_started', () => {
    expect(deriveCliViewStatus({ lifecycle: 'open', runtimeActivity: 'queued' })).toBe(
      'not_started',
    );
  });

  it('maps post-process orchestration to stopped', () => {
    for (const runtime of [
      'needs_recovery',
      'waiting_children',
      'blocked',
      'awaiting_outcome',
    ] as const) {
      expect(deriveCliViewStatus({ lifecycle: 'open', runtimeActivity: runtime })).toBe('stopped');
    }
  });

  it('uses hadProcess to distinguish idle open not_started vs stopped', () => {
    expect(
      deriveCliViewStatus({ lifecycle: 'open', runtimeActivity: 'idle', hadProcess: false }),
    ).toBe('not_started');
    expect(
      deriveCliViewStatus({ lifecycle: 'open', runtimeActivity: 'idle', hadProcess: true }),
    ).toBe('stopped');
  });

  it('treats hard terminal as stopped when process may have run', () => {
    expect(deriveCliViewStatus({ lifecycle: 'succeeded', runtimeActivity: null })).toBe('stopped');
    expect(
      deriveCliViewStatus({
        lifecycle: 'succeeded',
        runtimeActivity: null,
        hadProcess: false,
      }),
    ).toBe('not_started');
  });
});

describe('deriveCliLastExit', () => {
  it('is null unless stopped', () => {
    expect(deriveCliLastExit({ cliView: 'running', latestTerminalTurnStatus: 'failed' })).toBeNull();
  });

  it('maps terminal turn status when stopped', () => {
    expect(deriveCliLastExit({ cliView: 'stopped', latestTerminalTurnStatus: 'succeeded' })).toBe(
      'ok',
    );
    expect(deriveCliLastExit({ cliView: 'stopped', latestTerminalTurnStatus: 'failed' })).toBe(
      'error',
    );
    expect(deriveCliLastExit({ cliView: 'stopped', latestTerminalTurnStatus: 'interrupted' })).toBe(
      'cancelled',
    );
    expect(deriveCliLastExit({ cliView: 'stopped', latestTerminalTurnStatus: 'cancelled' })).toBe(
      'cancelled',
    );
  });
});

describe('cliStatusFromTask', () => {
  it('reads runtime activity from task summary', () => {
    expect(
      cliStatusFromTask({
        lifecycle: 'open',
        runtimeActivity: 'running',
        viewStatus: 'running',
      }),
    ).toBe('running');
  });
});

describe('getCliStatusPresentation', () => {
  it('has labels for all four process views', () => {
    expect(getCliStatusPresentation('not_started').label).toMatch(/not started/i);
    expect(getCliStatusPresentation('running').label).toMatch(/running/i);
    expect(getCliStatusPresentation('idle').label).toMatch(/idle/i);
    expect(getCliStatusPresentation('stopped').label).toMatch(/stopped/i);
  });
});
