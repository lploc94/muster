/**
 * Stable deep-link contract for Agents → Backends (M019/S03).
 *
 * Pure / I/O-free. S04 Doctor posts revealBackendDiagnostics; App resolves the
 * navigation through this helper so the focus target id cannot drift between
 * the host message handler and the BackendsSettings DOM id.
 */
import type { SettingsTopicId } from './settings-topics';

/** Stable DOM id / focus target for the Agents → Backends section. */
export const SETTINGS_BACKENDS_FOCUS_ID = 'settings-backends' as const;

export type RevealBackendDiagnosticsAction = {
  openSettings: true;
  topicId: SettingsTopicId;
  focusTargetId: typeof SETTINGS_BACKENDS_FOCUS_ID;
  /** Request a fresh passive inventory when opening diagnostics. */
  requestBackendReadiness: true;
};

/**
 * Resolve the host→webview revealBackendDiagnostics message into Settings
 * navigation. Always lands on Agents (D054) and the settings-backends target.
 */
export function resolveRevealBackendDiagnosticsAction(): RevealBackendDiagnosticsAction {
  return {
    openSettings: true,
    topicId: 'agents',
    focusTargetId: SETTINGS_BACKENDS_FOCUS_ID,
    requestBackendReadiness: true,
  };
}
