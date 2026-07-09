import { describe, expect, it, vi } from 'vitest';
import type { TaskViewStatus } from './protocol';
import {
  TASK_STATUS_PRESENTATIONS,
  TASK_VIEW_STATUSES,
  getTaskStatusPresentation,
  isTaskStatusTerminal,
  taskStatusLabel,
  type TaskStatusTone,
} from './task-status';

const EXPECTED_STATUSES = [
  'waiting_dependencies',
  'queued',
  'running',
  'waiting_user',
  'waiting_children',
  'blocked',
  'needs_recovery',
  'idle',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const satisfies readonly TaskViewStatus[];

const NON_EMPTY_FIELDS = [
  'label',
  'listCopy',
  'workspaceHeadline',
  'workspaceDetail',
  'composerGuidance',
] as const;

const EXPECTED_TERMINAL_STATUSES = new Set<TaskViewStatus>(['succeeded', 'failed', 'cancelled', 'skipped']);
const EXPECTED_TONES = new Set<TaskStatusTone>(['neutral', 'info', 'attention', 'success', 'warning', 'danger', 'muted']);

describe('task status presentation model', () => {
  it('covers every task view status with complete user-facing copy', () => {
    expect(TASK_VIEW_STATUSES).toEqual(EXPECTED_STATUSES);
    expect(Object.keys(TASK_STATUS_PRESENTATIONS).sort()).toEqual([...EXPECTED_STATUSES].sort());

    for (const status of EXPECTED_STATUSES) {
      const presentation = TASK_STATUS_PRESENTATIONS[status];

      expect(presentation.status).toBe(status);
      expect(EXPECTED_TONES.has(presentation.tone)).toBe(true);
      for (const field of NON_EMPTY_FIELDS) {
        expect(presentation[field].trim(), `${status}.${field}`).not.toBe('');
      }
    }
  });

  it('exposes labels through the presentation lookup', () => {
    expect(taskStatusLabel('waiting_dependencies')).toBe('Waiting on dependencies');
    expect(getTaskStatusPresentation('needs_recovery').workspaceHeadline).toContain('Recovery');
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
      expect(presentation.composerGuidance).toContain('inspect host logs');
    }
  });

  it('matches protocol terminal status semantics', async () => {
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    }));

    const { isTerminalStatus } = await import('./protocol');

    for (const status of EXPECTED_STATUSES) {
      const expected = EXPECTED_TERMINAL_STATUSES.has(status);

      expect(isTaskStatusTerminal(status), status).toBe(expected);
      expect(isTaskStatusTerminal(status), status).toBe(isTerminalStatus(status));
    }
  });
});
