import { describe, expect, it } from 'vitest';
import { NATIVE_FIRST_RUN_UAT_COMMANDS } from './m019-s05-native-first-run';
import {
  isUatModeEnabled,
  readRedactedBridgeHealth,
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

  it('exposes packaging-gate bridgeHealth only under muster.uat.* and only when UAT is enabled', () => {
    expect(UAT_COMMANDS.bridgeHealth).toBe('muster.uat.bridgeHealth');
    expect(UAT_COMMANDS.bridgeHealth.startsWith('muster.uat.')).toBe(true);
    // Production host never registers UAT commands even if env is set.
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(false);
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
