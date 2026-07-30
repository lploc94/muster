import { describe, expect, it, vi } from 'vitest';
import {
  formatRetentionReportLines,
  RetentionReport,
} from './sqlite-maintenance-commands';
import { RetentionScheduler } from './retention-scheduler';

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('retention storage report', () => {
  it('records a completed pass with numeric and enum-only storage evidence', async () => {
    const report = new RetentionReport();
    const scheduler = new RetentionScheduler({
      runPass: async () => ({
        tasksVisited: 3,
        entriesStripped: 7,
        toolCallsBytesBefore: 8192,
        toolCallsBytesAfter: 4096,
        reclaimMode: 'incremental',
        fileBytesBefore: 16384,
        fileBytesAfter: 8192,
      }),
      onPassCompleted: (pass) => report.recordCompleted(pass),
      schedule: vi.fn(() => 1),
      clearSchedule: vi.fn(),
    });

    scheduler.start();
    await settle();

    expect(formatRetentionReportLines(report.snapshot())).toEqual([
      'Muster retention report',
      'completed_passes: 1',
      'failed_passes: 0',
      'retention_pass: 1',
      'tasks_visited: 3',
      'entries_stripped: 7',
      'tool_calls_bytes_before: 8192',
      'tool_calls_bytes_after: 4096',
      'reclaim_mode: incremental',
      'file_bytes_before: 16384',
      'file_bytes_after: 8192',
    ]);
    expect(formatRetentionReportLines(report.snapshot()).join('\n')).not.toMatch(/[\\/]|secret|sqlite/i);
    scheduler.dispose();
  });

  it('retains a numbered block for every completed pass until the host reloads', () => {
    const report = new RetentionReport();
    report.recordCompleted({
      tasksVisited: 1, entriesStripped: 2, toolCallsBytesBefore: 8, toolCallsBytesAfter: 4,
      reclaimMode: 'noop', fileBytesBefore: 16, fileBytesAfter: 16,
    });
    report.recordCompleted({
      tasksVisited: 3, entriesStripped: 4, toolCallsBytesBefore: 12, toolCallsBytesAfter: 6,
      reclaimMode: 'incremental', fileBytesBefore: 32, fileBytesAfter: 16,
    });

    expect(formatRetentionReportLines(report.snapshot())).toEqual(expect.arrayContaining([
      'completed_passes: 2',
      'retention_pass: 1',
      'retention_pass: 2',
    ]));
  });

  it('records a failed pass rather than silently swallowing a scheduler error', async () => {
    const report = new RetentionReport();
    const scheduler = new RetentionScheduler({
      runPass: async () => {
        throw new Error('SQLITE_FULL: /secret/muster.sqlite3');
      },
      onPassFailed: () => report.recordFailure(),
      schedule: vi.fn(() => 1),
      clearSchedule: vi.fn(),
    });

    scheduler.start();
    await settle();

    expect(formatRetentionReportLines(report.snapshot())).toEqual([
      'Muster retention report',
      'completed_passes: 0',
      'failed_passes: 1',
    ]);
    scheduler.dispose();
  });
});
