import { describe, expect, it } from 'vitest';
import { NATIVE_FIRST_RUN_UAT_COMMANDS } from './m019-s05-native-first-run';
import { isUatModeEnabled, UAT_COMMANDS } from './uat-commands';

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
});
