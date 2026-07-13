import { describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import type { TaskRuntimeActivity } from './protocol';
import {
  LIFECYCLE_PRESENTATIONS,
  RUNTIME_PRESENTATIONS,
  TASK_LIFECYCLE_STATES,
  TASK_RUNTIME_ACTIVITIES,
  TASK_VIEW_STATUSES,
  getLifecyclePresentation,
  getTaskPresentation,
  getTaskStatusPresentation,
  isHardTerminal,
  isSoftTerminal,
  isTaskStatusTerminal,
  runtimeBlocksComposer,
  taskStatusLabel,
  type TaskStatusTone,
} from './task-status';

const EXPECTED_RUNTIME = [
  'waiting_dependencies',
  'queued',
  'running',
  'waiting_user',
  'waiting_children',
  'blocked',
  'needs_recovery',
  'idle',
  'awaiting_outcome',
] as const satisfies readonly TaskRuntimeActivity[];

const EXPECTED_TONES = new Set<TaskStatusTone>([
  'neutral',
  'info',
  'attention',
  'success',
  'warning',
  'danger',
  'muted',
]);

const NON_EMPTY_FIELDS = [
  'label',
  'listCopy',
  'workspaceHeadline',
  'workspaceDetail',
  'composerGuidance',
] as const;

describe('task status dual-axis presentation', () => {
  it('covers every lifecycle and runtime activity with complete copy', () => {
    expect(TASK_LIFECYCLE_STATES).toEqual(['open', 'succeeded', 'failed', 'cancelled', 'skipped']);
    expect(TASK_RUNTIME_ACTIVITIES).toEqual(EXPECTED_RUNTIME);

    for (const lifecycle of TASK_LIFECYCLE_STATES) {
      const presentation = LIFECYCLE_PRESENTATIONS[lifecycle];
      expect(presentation.key).toBe(lifecycle);
      expect(EXPECTED_TONES.has(presentation.tone)).toBe(true);
      for (const field of NON_EMPTY_FIELDS) {
        expect(presentation[field].trim(), `${lifecycle}.${field}`).not.toBe('');
      }
    }

    for (const activity of EXPECTED_RUNTIME) {
      const presentation = RUNTIME_PRESENTATIONS[activity];
      expect(presentation.key).toBe(activity);
      expect(EXPECTED_TONES.has(presentation.tone)).toBe(true);
      for (const field of NON_EMPTY_FIELDS) {
        expect(presentation[field].trim(), `${activity}.${field}`).not.toBe('');
      }
    }
  });

  it('shows lifecycle Open with runtime activity when task is open', () => {
    const presentation = getTaskPresentation({
      lifecycle: 'open',
      runtimeActivity: 'running',
      viewStatus: 'running',
    });

    expect(presentation.lifecycle.label).toBe('Open');
    expect(presentation.runtime?.label).toBe('Running');
    expect(presentation.label).toBe('Running');
    expect(presentation.listCopy).toContain('Open');
    expect(presentation.workspaceDetail).toContain('CLI process');
  });

  it('uses failed lifecycle (soft) without treating it as hard terminal', () => {
    const presentation = getTaskPresentation({
      lifecycle: 'failed',
      runtimeActivity: null,
      viewStatus: 'failed',
    });

    expect(presentation.label).toBe('Failed');
    expect(presentation.composerGuidance).toMatch(/reopen/i);
    expect(isSoftTerminal('failed')).toBe(true);
    expect(isHardTerminal('failed')).toBe(false);
    expect(isTaskStatusTerminal('failed')).toBe(false);
  });

  it('marks succeeded/cancelled/skipped as hard terminal with reopen guidance', () => {
    for (const lifecycle of ['succeeded', 'cancelled', 'skipped'] as const) {
      expect(isHardTerminal(lifecycle)).toBe(true);
      expect(isTaskStatusTerminal(lifecycle)).toBe(true);
      const guidance = getLifecyclePresentation(lifecycle).composerGuidance;
      expect(guidance).toMatch(new RegExp(`This task is ${lifecycle}`, 'i'));
      expect(guidance).toMatch(/reopen/i);
      expect(guidance).toMatch(/new message|Sending/i);
    }
  });

  it('exposes labels through the presentation lookup', () => {
    expect(taskStatusLabel('waiting_dependencies')).toBe('Waiting on dependencies');
    expect(getTaskStatusPresentation('needs_recovery').workspaceHeadline).toMatch(/recovery/i);
  });

  it('falls back safely for malformed host values', () => {
    const presentation = getTaskStatusPresentation('mystery_status');

    expect(presentation.status).toBe('idle');
    expect(presentation.label).toBe('Unknown status');
    expect(presentation.tone).toBe('muted');
    expect(presentation.workspaceDetail).toContain('mystery_status');
    expect(presentation.composerGuidance).toContain('inspect host logs');
  });

  it('falls back safely for missing host status values', () => {
    for (const missingStatus of [null, undefined, ''] as const) {
      const presentation = getTaskStatusPresentation(missingStatus);

      expect(presentation.status).toBe('idle');
      expect(presentation.label).toBe('Unknown status');
      expect(presentation.tone).toBe('muted');
      expect(presentation.workspaceDetail).toContain('missing');
    }
  });

  it('keeps composer open while running or queued for FIFO follow-ups and live inject', () => {
    expect(runtimeBlocksComposer('running')).toBe(false);
    expect(runtimeBlocksComposer('queued')).toBe(false);
    expect(runtimeBlocksComposer('idle')).toBe(false);
    expect(runtimeBlocksComposer(null)).toBe(false);
    expect(runtimeBlocksComposer('awaiting_outcome')).toBe(false);
  });

  it('still blocks composer for recovery, ask-user, and dependency gates', () => {
    expect(runtimeBlocksComposer('waiting_user')).toBe(true);
    expect(runtimeBlocksComposer('needs_recovery')).toBe(true);
    expect(runtimeBlocksComposer('waiting_dependencies')).toBe(true);
    expect(runtimeBlocksComposer('waiting_children')).toBe(true);
  });

  it('describes queue and live-inject affordances while a turn is running', () => {
    const presentation = getTaskPresentation({
      lifecycle: 'open',
      runtimeActivity: 'running',
      viewStatus: 'running',
    });
    expect(presentation.composerGuidance).toMatch(/Enter queues/i);
    expect(presentation.composerGuidance).toMatch(/Ctrl\+Enter/i);
    expect(presentation.composerGuidance).not.toMatch(/disabled while a turn is running/i);
  });

  it('matches protocol hard-terminal helpers', async () => {
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    }));

    const { isHardTerminalLifecycle, isSoftTerminalLifecycle } = await import('./protocol');

    for (const status of TASK_VIEW_STATUSES) {
      expect(isTaskStatusTerminal(status), status).toBe(isHardTerminalLifecycle(status));
    }
    expect(isSoftTerminalLifecycle('failed')).toBe(true);
    expect(isSoftTerminalLifecycle('succeeded')).toBe(false);
  });
});
