import { describe, expect, it } from 'vitest';
import { isUatModeEnabled } from './uat-commands';

describe('live UAT exposure gate', () => {
  it('never enables mutation commands in a production Extension Host', () => {
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(false);
  });

  it('requires the explicit env flag in a non-production Extension Host', () => {
    expect(isUatModeEnabled(false, {})).toBe(false);
    expect(isUatModeEnabled(false, { MUSTER_UAT_MODE: '0' })).toBe(false);
    expect(isUatModeEnabled(false, { MUSTER_UAT_MODE: '1' })).toBe(true);
  });
});
