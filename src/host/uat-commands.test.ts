import { describe, expect, it, vi } from 'vitest';
import { NATIVE_FIRST_RUN_UAT_COMMANDS } from './m019-s05-native-first-run';
import { isBoundedToolFileChange } from '../shared/tool-file-change-contract';
import {
  isUatModeEnabled,
  readStorageLifecycleState,
  runRetentionPass,
  seedStorageWorkload,
  UAT_COMMANDS,
} from './uat-commands';

describe('live UAT exposure gate', () => {
  it('never enables mutation commands in a production Extension Host', () => {
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(false);
  });

  it('requires the explicit env flag in a non-production Extension Host', () => {
    expect(isUatModeEnabled(false, {})).toBe(false);
    expect(isUatModeEnabled(false, { MUSTER_UAT_MODE: '0' })).toBe(false);
    expect(isUatModeEnabled(false, { MUSTER_UAT_MODE: '1' })).toBe(true);
  });

  it('includes M019/S05 native first-run command ids only under muster.uat.*', () => {
    expect(UAT_COMMANDS.refreshReadiness).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.refreshReadiness);
    expect(UAT_COMMANDS.probeBackend).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.probeBackend);
    expect(UAT_COMMANDS.runDoctor).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.runDoctor);
    expect(UAT_COMMANDS.acceptFirstTask).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.acceptFirstTask);
    expect(UAT_COMMANDS.nativeFirstRunCleanup).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.cleanup);
    for (const id of Object.values(NATIVE_FIRST_RUN_UAT_COMMANDS)) {
      expect(id.startsWith('muster.uat.')).toBe(true);
    }
  });

  it('names the storage lifecycle commands only in the UAT namespace', () => {
    expect(UAT_COMMANDS.seedStorageWorkload).toBe('muster.uat.seedStorageWorkload');
    expect(UAT_COMMANDS.storageLifecycleState).toBe('muster.uat.storageLifecycleState');
    expect(UAT_COMMANDS.runRetentionPass).toBe('muster.uat.runRetentionPass');
  });

  it('seeds bounded terminal tool-call evidence through named production repository commands', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, changed: true });
    const result = await seedStorageWorkload({ execute } as never, 'ws');

    expect(result).toEqual({ seededTasks: 2, seededTurns: 5, seededToolCalls: 5 });
    expect(execute).toHaveBeenCalledTimes(9);
    expect(execute.mock.calls.flat().map((command) => command.kind)).toEqual([
      'createTask', 'createTask', ...Array(5).fill('createTurn'),
      'appendTranscriptBatch', 'appendTranscriptBatch',
    ]);
    const settledTranscript = execute.mock.calls[7]![0];
    expect(Date.parse(settledTranscript.toolCalls[0].createdAt)).toBeLessThan(
      Date.now() - 365 * 24 * 60 * 60 * 1_000,
    );
    expect(settledTranscript.toolCalls).toHaveLength(4);
    const retainedChanges = settledTranscript.toolCalls
      .flatMap((call: { fileChanges: Array<{ oldText: string; newText: string }> }) => call.fileChanges);
    expect(retainedChanges).toHaveLength(4);
    expect(retainedChanges.every((change) =>
      isBoundedToolFileChange({ path: 'src/fixture.ts', oldText: change.oldText, newText: change.newText }),
    )).toBe(true);
    expect(settledTranscript.toolCalls.every((call: { output?: string }) =>
      typeof call.output === 'string' && call.output.length > 1_000_000,
    )).toBe(true);
    const activeTranscript = execute.mock.calls[8]![0];
    expect(activeTranscript.toolCalls[0].turnId).toContain('active');
    expect(activeTranscript.toolCalls[0].fileChanges[0]).toMatchObject({ oldText: 'live-before', newText: 'live-after' });
    expect(settledTranscript.taskId).toBe('uat-storage-seed-active');
  });

  it('returns numeric-and-enum-only lifecycle state from injected production surfaces', async () => {
    const state = await readStorageLifecycleState({
      repository: {
        listTasks: async () => [{ id: 'seeded-task' }],
        listToolCalls: async () => [
          { fileChanges: [{ retentionTruncated: true }, { retentionTruncated: true }] },
          { fileChanges: [{ retentionTruncated: true }] },
          { fileChanges: [{ retentionTruncated: false }] },
        ],
      } as never,
      sqliteClient: {
        storageReport: async () => ({
          fileBytes: 2048, walBytes: 32, shmBytes: 16, pageCount: 8, freelistCount: 2,
          pageSize: 4096, autoVacuum: 2, tableBytesSource: 'dbstat', tables: [{ name: 'tool_calls', bytes: 1024 }],
        }),
        get: async (sql: string) => ({ count: { tasks: 1, turns: 4, messages: 5, operations: 6 }[sql.match(/FROM (\w+)/)?.[1] ?? ''] ?? 0 }),
      } as never,
      retentionReport: {
        snapshot: () => ({
          completedPasses: 2, failedPasses: 1,
          completedPassDetails: [{ ordinal: 1 }, { ordinal: 2 }],
        }),
      },
      workspaceId: 'ws',
    });

    expect(state).toEqual({
      storage: {
        fileBytes: 2048, walBytes: 32, shmBytes: 16, pageCount: 8, freelistCount: 2,
        pageSize: 4096, autoVacuum: 2, tableBytesSource: 'dbstat', tables: [{ name: 'tool_calls', bytes: 1024 }],
      },
      retention: { completedPasses: 2, failedPasses: 1, latestPassOrdinal: 2 },
      durableRows: { tasks: 1, turns: 4, messages: 5, operations: 6 },
      retentionTruncatedEntries: 3,
    });
    expect(Object.values(state).flatMap((value) => typeof value === 'string' ? [value] : [])).toEqual([]);
  });

  it('bubbles a direct retention failure so the command caller can record it', async () => {
    await expect(runRetentionPass(async () => {
      throw new Error('storage unavailable');
    })).rejects.toThrow('storage unavailable');
  });
});
