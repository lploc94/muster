import { describe, expect, it } from 'vitest';
import {
  SETTINGS_BACKENDS_FOCUS_ID,
  resolveRevealBackendDiagnosticsAction,
} from './settings-backends-deep-link';

describe('settings-backends deep-link (M019/S03 T03)', () => {
  it('exports the stable focus target id S04 Doctor will open', () => {
    expect(SETTINGS_BACKENDS_FOCUS_ID).toBe('settings-backends');
  });

  it('resolves revealBackendDiagnostics to Agents + Backends focus', () => {
    const action = resolveRevealBackendDiagnosticsAction();
    expect(action).toEqual({
      openSettings: true,
      topicId: 'agents',
      focusTargetId: 'settings-backends',
      requestBackendReadiness: true,
    });
  });

  it('never invents a Connections topic for backend diagnostics', () => {
    const action = resolveRevealBackendDiagnosticsAction();
    expect(action.topicId).not.toBe('connections');
    expect(action.topicId).toBe('agents');
  });
});
