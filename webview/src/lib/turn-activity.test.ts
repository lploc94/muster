import { describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import {
  deriveTurnActivityState,
  getTurnActivityPresentation,
  turnActivityFromTask,
} from './turn-activity';

describe('deriveTurnActivityState', () => {
  it('maps running / threadRunning to executing', () => {
    expect(deriveTurnActivityState({ lifecycle: 'open', runtimeActivity: 'running' })).toBe(
      'executing',
    );
    expect(
      deriveTurnActivityState({
        lifecycle: 'open',
        runtimeActivity: 'idle',
        threadRunning: true,
      }),
    ).toBe('executing');
  });

  it('maps waiting_user / askPending to waiting_you', () => {
    expect(deriveTurnActivityState({ lifecycle: 'open', runtimeActivity: 'waiting_user' })).toBe(
      'waiting_you',
    );
    expect(
      deriveTurnActivityState({
        lifecycle: 'open',
        runtimeActivity: 'running',
        askPending: true,
      }),
    ).toBe('waiting_you');
  });

  it('maps queued to queued', () => {
    expect(deriveTurnActivityState({ lifecycle: 'open', runtimeActivity: 'queued' })).toBe(
      'queued',
    );
  });

  it('maps needs_recovery to failed_turn', () => {
    expect(deriveTurnActivityState({ lifecycle: 'open', runtimeActivity: 'needs_recovery' })).toBe(
      'failed_turn',
    );
  });

  it('returns null strip for idle / wait orchestration / terminal', () => {
    for (const runtime of [
      'idle',
      'waiting_prerequisites',
      'waiting_children',
      'blocked',
      'awaiting_outcome',
      null,
    ] as const) {
      expect(
        deriveTurnActivityState({ lifecycle: 'open', runtimeActivity: runtime }),
      ).toBe('null');
    }
    expect(deriveTurnActivityState({ lifecycle: 'succeeded', runtimeActivity: null })).toBe(
      'null',
    );
  });
});

describe('turnActivityFromTask', () => {
  it('does not invent recovery chrome when currentTurnActivity key is absent', () => {
    expect(
      turnActivityFromTask({
        lifecycle: 'open',
        runtimeActivity: 'needs_recovery',
        viewStatus: 'needs_recovery',
      } as Parameters<typeof turnActivityFromTask>[0]),
    ).toBe('null');
    expect(
      turnActivityFromTask({
        lifecycle: 'open',
        runtimeActivity: 'running',
        viewStatus: 'running',
      } as Parameters<typeof turnActivityFromTask>[0]),
    ).toBe('null');
  });

  it('allows threadRunning / askPending only when host activity key is absent', () => {
    expect(
      turnActivityFromTask(
        {
          lifecycle: 'open',
          runtimeActivity: 'idle',
          viewStatus: 'idle',
        } as Parameters<typeof turnActivityFromTask>[0],
        { threadRunning: true },
      ),
    ).toBe('executing');
    expect(
      turnActivityFromTask(
        {
          lifecycle: 'open',
          runtimeActivity: 'idle',
          viewStatus: 'idle',
        } as Parameters<typeof turnActivityFromTask>[0],
        { askPending: true },
      ),
    ).toBe('waiting_you');
  });

  it('prefers host currentTurnActivity when present', () => {
    expect(
      turnActivityFromTask({
        lifecycle: 'open',
        runtimeActivity: 'needs_recovery',
        viewStatus: 'needs_recovery',
        currentTurnActivity: { state: 'failed_turn', turnId: 't1', retryable: true },
      }),
    ).toBe('failed_turn');
    expect(
      turnActivityFromTask({
        lifecycle: 'open',
        runtimeActivity: 'idle',
        viewStatus: 'idle',
        currentTurnActivity: null,
      }),
    ).toBe('null');
  });
});

describe('getTurnActivityPresentation', () => {
  it('hides strip for null and uses turn labels without CLI vocabulary', () => {
    expect(getTurnActivityPresentation('null').showStrip).toBe(false);
    expect(getTurnActivityPresentation('executing').label).toBe('Working');
    expect(getTurnActivityPresentation('waiting_you').label).toBe('Waiting for you');
    expect(getTurnActivityPresentation('queued').label).toBe('Queued');
    expect(getTurnActivityPresentation('failed_turn').label).toBe('Could not finish');
    for (const state of ['executing', 'waiting_you', 'queued', 'failed_turn'] as const) {
      const p = getTurnActivityPresentation(state);
      expect(p.label.toLowerCase()).not.toMatch(/cli|process/);
      expect(p.detail.toLowerCase()).not.toMatch(/cli|process/);
    }
  });
});
