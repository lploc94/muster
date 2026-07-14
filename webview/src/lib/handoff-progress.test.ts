import { describe, expect, it, vi } from 'vitest';

// protocol.ts transitively imports ./vscode (acquireVsCodeApi at module load).
vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import type { HandoffProgress, TaskSummary } from './protocol';
import {
  canRequestRuntimeHandoff,
  formatHandoffBinding,
  formatHandoffProgressLabel,
  handoffPhaseLabel,
  isHandoffInFlight,
  isHandoffProgressInFlight,
  isHandoffTerminal,
} from './handoff-progress';

const baseProgress: HandoffProgress = {
  operationId: 'hop-1',
  phase: 'preparing_receiver',
  source: { backend: 'claude', model: 'sonnet' },
  target: { backend: 'codex', model: 'gpt-5' },
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:01.000Z',
};

const baseTask: TaskSummary = {
  id: 'task-1',
  parentId: null,
  goal: 'Ship handoff UX',
  role: 'coordinator',
  lifecycle: 'open',
  runtimeActivity: 'idle',
  viewStatus: 'idle',
  currentTurnActivity: null,
  updatedAt: '2026-07-14T00:00:00.000Z',
  backend: 'claude',
  model: 'sonnet',
};

describe('handoff progress phase helpers', () => {
  it('treats intermediate phases as in-flight and terminal phases as settled', () => {
    for (const phase of [
      'requested',
      'exporting_context',
      'summarizing_source',
      'preparing_receiver',
      'transferring',
    ] as const) {
      expect(isHandoffInFlight(phase), phase).toBe(true);
      expect(isHandoffTerminal(phase), phase).toBe(false);
    }

    for (const phase of ['completed', 'failed', 'cancelled'] as const) {
      expect(isHandoffInFlight(phase), phase).toBe(false);
      expect(isHandoffTerminal(phase), phase).toBe(true);
    }

    expect(isHandoffInFlight(undefined)).toBe(false);
    expect(isHandoffInFlight(null)).toBe(false);
    expect(isHandoffTerminal(undefined)).toBe(false);
  });

  it('reads in-flight state from progress objects', () => {
    expect(isHandoffProgressInFlight(baseProgress)).toBe(true);
    expect(isHandoffProgressInFlight({ ...baseProgress, phase: 'completed' })).toBe(false);
    expect(isHandoffProgressInFlight(undefined)).toBe(false);
  });
});

describe('handoff progress labels', () => {
  it('formats source/target bindings with backend and optional model only', () => {
    expect(formatHandoffBinding({ backend: 'claude', model: 'sonnet' })).toBe('[Claude] sonnet');
    expect(formatHandoffBinding({ backend: 'codex' })).toBe('Codex');
  });

  it('labels every known phase for chrome copy', () => {
    expect(handoffPhaseLabel('requested')).toMatch(/switch|request/i);
    expect(handoffPhaseLabel('exporting_context')).toMatch(/export/i);
    expect(handoffPhaseLabel('summarizing_source')).toMatch(/summar/i);
    expect(handoffPhaseLabel('preparing_receiver')).toMatch(/prepar/i);
    expect(handoffPhaseLabel('transferring')).toMatch(/transfer/i);
    expect(handoffPhaseLabel('completed')).toMatch(/complete/i);
    expect(handoffPhaseLabel('failed')).toMatch(/fail/i);
    expect(handoffPhaseLabel('cancelled')).toMatch(/cancel/i);
  });

  it('builds chrome label from phase + bindings without secret-bearing fields', () => {
    const label = formatHandoffProgressLabel(baseProgress);
    expect(label).toMatch(/prepar/i);
    expect(label).toContain('[Claude] sonnet');
    expect(label).toContain('[Codex] gpt-5');
    expect(label).not.toContain('sessionId');
    expect(label).not.toContain('digest');
    expect(label).not.toContain(baseProgress.operationId);
  });

  it('appends bounded failure message for failed phase only', () => {
    const failed = formatHandoffProgressLabel({
      ...baseProgress,
      phase: 'failed',
      failure: {
        code: 'receiver_init_failed',
        message: 'Target CLI refused the handoff.',
        at: '2026-07-14T00:00:02.000Z',
      },
    });
    expect(failed).toMatch(/fail/i);
    expect(failed).toContain('Target CLI refused the handoff.');
    expect(failed).not.toContain('receiver_init_failed');

    const completed = formatHandoffProgressLabel({ ...baseProgress, phase: 'completed' });
    expect(completed).not.toContain('Target CLI');
  });
});

describe('canRequestRuntimeHandoff', () => {
  it('allows idle open tasks without an in-flight handoff', () => {
    expect(canRequestRuntimeHandoff(baseTask)).toBe(true);
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        handoffProgress: { ...baseProgress, phase: 'completed' },
      }),
    ).toBe(true);
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        handoffProgress: { ...baseProgress, phase: 'failed' },
      }),
    ).toBe(true);
  });

  it('refuses missing tasks, non-open lifecycle, busy runtime, and in-flight handoff', () => {
    expect(canRequestRuntimeHandoff(undefined)).toBe(false);
    expect(canRequestRuntimeHandoff(null)).toBe(false);
    expect(canRequestRuntimeHandoff({ ...baseTask, lifecycle: 'succeeded' })).toBe(false);
    expect(canRequestRuntimeHandoff({ ...baseTask, lifecycle: 'failed' })).toBe(false);
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        runtimeActivity: 'running',
        viewStatus: 'running',
      }),
    ).toBe(false);
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        runtimeActivity: 'waiting_user',
        viewStatus: 'waiting_user',
      }),
    ).toBe(false);
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        handoffProgress: baseProgress,
      }),
    ).toBe(false);
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        handoffProgress: { ...baseProgress, phase: 'transferring' },
      }),
    ).toBe(false);
  });

  it('never treats same-binding checks as a chrome concern (host refuses)', () => {
    // Webview may post a same-binding pick; host route refuses with commandError.
    // canRequest only gates idle/open/in-flight — not source===target equality.
    expect(
      canRequestRuntimeHandoff({
        ...baseTask,
        backend: 'claude',
        model: 'sonnet',
      }),
    ).toBe(true);
  });
});
