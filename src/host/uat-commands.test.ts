import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NATIVE_FIRST_RUN_UAT_COMMANDS } from './m019-s05-native-first-run';
import { isBoundedToolFileChange } from '../shared/tool-file-change-contract';
import {
  buildBridgeClosureObservation,
  isUatModeEnabled,
  readRedactedBridgeHealth,
  readRedactedDeactivateTrace,
  readStorageLifecycleState,
  runRetentionPass,
  seedStorageWorkload,
  UAT_COMMANDS,
} from './uat-commands';

describe('live UAT exposure gate', () => {
  it('requires the explicit MUSTER_UAT_MODE=1 env flag (sole opt-in, including Production)', () => {
    // Production ExtensionMode (CLI-installed VSIX) is allowed when the install
    // gate sets MUSTER_UAT_MODE=1; marketplace users never set this env var.
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(true);
    expect(isUatModeEnabled(true, {})).toBe(false);
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
    expect(UAT_COMMANDS.renderProbe).toBe('muster.uat.renderProbe');
  });

  it('registers the DOM render probe only through the live UAT command surface', () => {
    const extensionSource = readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../../webview/src/App.svelte', import.meta.url), 'utf8');
    expect(extensionSource).toContain('vscode.commands.registerCommand(UAT_COMMANDS.renderProbe');
    expect(extensionSource).toContain('return uatChatProvider.requestRenderProbeForUat();');
    expect(appSource).toContain("type === 'renderProbeRequest'");
    expect(appSource).toContain("type: 'renderProbeResponse'");
    expect(appSource).toContain('collectToolCardRenderObservations(document)');
  });

  it('seeds bounded terminal tool-call evidence through named production repository commands', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, changed: true });
    const result = await seedStorageWorkload({ execute } as never, 'ws');

    expect(result).toEqual({ seededTasks: 2, seededTurns: 6, seededToolCalls: 6 });
    expect(execute).toHaveBeenCalledTimes(10);
    expect(execute.mock.calls.flat().map((command) => command.kind)).toEqual([
      'createTask', 'createTask', ...Array(6).fill('createTurn'),
      'appendTranscriptBatch', 'appendTranscriptBatch',
    ]);
    const settledTranscript = execute.mock.calls[8]![0];
    expect(Date.parse(settledTranscript.toolCalls[0].createdAt)).toBeLessThan(
      Date.now() - 365 * 24 * 60 * 60 * 1_000,
    );
    expect(settledTranscript.toolCalls).toHaveLength(5);
    const retainedChanges = settledTranscript.toolCalls
      .flatMap((call: { fileChanges: Array<{ oldText: string; newText: string }> }) => call.fileChanges);
    expect(retainedChanges).toHaveLength(5);
    expect(retainedChanges.every((change) =>
      isBoundedToolFileChange({ path: 'src/fixture.ts', oldText: change.oldText, newText: change.newText }),
    )).toBe(true);
    expect(settledTranscript.toolCalls.every((call: { output?: string }) =>
      typeof call.output === 'string' && call.output.length > 1_000_000,
    )).toBe(true);
    const activeTranscript = execute.mock.calls[9]![0];
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

  it('exposes packaging-gate bridgeHealth under muster.uat.* when UAT env is set', () => {
    expect(UAT_COMMANDS.bridgeHealth).toBe('muster.uat.bridgeHealth');
    expect(UAT_COMMANDS.bridgeHealth.startsWith('muster.uat.')).toBe(true);
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(true);
  });

  it('exposes packaging-gate runDeactivate + deactivateTrace under muster.uat.* when UAT env is set', () => {
    expect(UAT_COMMANDS.runDeactivate).toBe('muster.uat.runDeactivate');
    expect(UAT_COMMANDS.deactivateTrace).toBe('muster.uat.deactivateTrace');
    expect(UAT_COMMANDS.runDeactivate.startsWith('muster.uat.')).toBe(true);
    expect(UAT_COMMANDS.deactivateTrace.startsWith('muster.uat.')).toBe(true);
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(true);
  });
});

describe('readRedactedBridgeHealth', () => {
  it('returns only port/status/generation and strips secrets and workspace paths', () => {
    const redacted = readRedactedBridgeHealth({
      port: 41234,
      status: 'ok',
      generation: 2,
      // Sensitive fields that must never leak into packaging-gate evidence.
      bearerToken: 'sk-secret-token',
      credentialId: 'cred-abc',
      workspacePath: 'C:\\Users\\dev\\project',
      dbPath: '/tmp/muster.db',
    });

    expect(redacted).toEqual({ port: 41234, status: 'ok', generation: 2 });
    expect(Object.keys(redacted).sort()).toEqual(['generation', 'port', 'status']);
    expect(JSON.stringify(redacted)).not.toMatch(/sk-secret|cred-abc|Users|muster\.db/i);
  });

  it('reports unavailable when the bridge has not started', () => {
    expect(readRedactedBridgeHealth(null)).toEqual({
      port: 0,
      status: 'unavailable',
      generation: 0,
    });
    expect(readRedactedBridgeHealth(undefined)).toEqual({
      port: 0,
      status: 'unavailable',
      generation: 0,
    });
  });

  it('preserves stopping status when the bridge is closing with a still-bound port', () => {
    expect(
      readRedactedBridgeHealth({
        port: 3000,
        status: 'stopping',
        generation: 1,
      }),
    ).toEqual({ port: 3000, status: 'stopping', generation: 1 });
  });

  it('derives ok from a positive port when status is omitted', () => {
    expect(readRedactedBridgeHealth({ port: 5555, generation: 3 })).toEqual({
      port: 5555,
      status: 'ok',
      generation: 3,
    });
  });

  it('treats non-finite or missing port/generation as zero', () => {
    expect(
      readRedactedBridgeHealth({
        port: Number.NaN,
        generation: 'nope' as unknown as number,
        status: 'ok',
      }),
    ).toEqual({ port: 0, status: 'unavailable', generation: 0 });
  });
});

describe('readRedactedDeactivateTrace', () => {
  it('returns only port and bridgeClosed and strips tokens/paths/env', () => {
    const redacted = readRedactedDeactivateTrace({
      port: 63197,
      bridgeClosed: true,
      bearerToken: 'sk-secret-token',
      workspacePath: 'C:\\Users\\dev\\project',
      env: { MUSTER_BRIDGE_TOKEN: 'tok' },
      dbPath: '/tmp/muster.db',
    });

    expect(redacted).toEqual({ port: 63197, bridgeClosed: true });
    expect(Object.keys(redacted).sort()).toEqual(['bridgeClosed', 'port']);
    expect(JSON.stringify(redacted)).not.toMatch(/sk-secret|Users|muster\.db|MUSTER_BRIDGE_TOKEN|tok/i);
  });

  it('defaults missing source to port 0 and bridgeClosed false', () => {
    expect(readRedactedDeactivateTrace(null)).toEqual({ port: 0, bridgeClosed: false });
    expect(readRedactedDeactivateTrace(undefined)).toEqual({ port: 0, bridgeClosed: false });
  });

  it('coerces non-boolean bridgeClosed and non-finite port', () => {
    expect(
      readRedactedDeactivateTrace({
        port: Number.NaN,
        bridgeClosed: 'yes' as unknown as boolean,
      }),
    ).toEqual({ port: 0, bridgeClosed: false });
    expect(
      readRedactedDeactivateTrace({
        port: 4000,
        bridgeClosed: false,
      }),
    ).toEqual({ port: 4000, bridgeClosed: false });
  });
});

describe('buildBridgeClosureObservation', () => {
  it('reports phase ok only when trace present, bridgeClosed, and postExitProbe refused', () => {
    expect(
      buildBridgeClosureObservation({
        port: 63197,
        trace: 'present',
        bridgeClosed: true,
        postExitProbe: 'refused',
      }),
    ).toEqual({
      port: 63197,
      trace: 'present',
      bridgeClosed: true,
      postExitProbe: 'refused',
      phase: 'ok',
    });
  });

  it('types not-closed / still-serving / trace-missing / deactivate-failed phases', () => {
    expect(
      buildBridgeClosureObservation({
        port: 1,
        trace: 'missing',
        bridgeClosed: false,
        postExitProbe: 'unknown',
      }).phase,
    ).toBe('trace-missing');
    expect(
      buildBridgeClosureObservation({
        port: 1,
        trace: 'present',
        bridgeClosed: false,
        postExitProbe: 'refused',
      }).phase,
    ).toBe('not-closed');
    expect(
      buildBridgeClosureObservation({
        port: 1,
        trace: 'present',
        bridgeClosed: true,
        postExitProbe: 'still-serving',
      }).phase,
    ).toBe('still-serving');
    expect(
      buildBridgeClosureObservation({
        port: 1,
        trace: 'present',
        bridgeClosed: true,
        postExitProbe: 'refused',
        deactivateFailed: true,
      }).phase,
    ).toBe('deactivate-failed');
  });
});
