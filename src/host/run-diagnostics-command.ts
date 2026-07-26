/**
 * Muster: Run Diagnostics (M019/S04 Doctor entry).
 *
 * Pure dependency-injected command handler — no VS Code imports.
 * Production wires BackendReadinessService refresh + chat view open +
 * revealBackendDiagnostics post; tests inject fakes.
 *
 * Order is intentional: refresh the shared readiness snapshot first, then
 * open the Muster chat view, then post the S03 deep-link so Agents → Backends
 * receives the refreshed evidence. Cancel-safe: once cancelled, open/reveal
 * are skipped; refresh already in flight is not aborted (passive inventory).
 */

export const MUSTER_RUN_DIAGNOSTICS_COMMAND = 'muster.runDiagnostics';
export const MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE = 'Muster: Run Diagnostics';

/** Host command that focuses the Muster activity-bar webview (same as openChat). */
export const MUSTER_OPEN_CHAT_VIEW_COMMAND = 'workbench.view.extension.muster';

export type RunDiagnosticsCommandResult =
  | { kind: 'success' }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: 'refresh_failed' | 'open_failed' | 'reveal_failed' };

export type RunDiagnosticsCommandDeps = {
  /**
   * Refresh BackendReadinessService and publish the settled
   * backendReadinessSnapshot to the webview. Must not mutate tasks/sessions.
   */
  refreshAndPublishReadiness: () => Promise<void>;
  /** Open / focus the Muster chat webview (typically workbench.view.extension.muster). */
  openChatView: () => unknown;
  /** Post { type: 'revealBackendDiagnostics' } (type key only — S03 contract). */
  postRevealBackendDiagnostics: () => void;
  /** Optional cancel token; when true after refresh, open/reveal are skipped. */
  isCancellationRequested?: () => boolean;
};

/**
 * Doctor entry: refresh shared readiness, open Muster chat, deep-link to
 * Agents → Backends. Fail-closed on refresh/open/reveal errors without
 * leaking raw messages. No task/session/outbox mutation.
 */
export async function handleRunDiagnosticsCommand(
  deps: RunDiagnosticsCommandDeps,
): Promise<RunDiagnosticsCommandResult> {
  if (deps.isCancellationRequested?.()) {
    return { kind: 'cancelled' };
  }

  try {
    await deps.refreshAndPublishReadiness();
  } catch {
    return { kind: 'error', code: 'refresh_failed' };
  }

  if (deps.isCancellationRequested?.()) {
    return { kind: 'cancelled' };
  }

  try {
    await deps.openChatView();
  } catch {
    return { kind: 'error', code: 'open_failed' };
  }

  if (deps.isCancellationRequested?.()) {
    return { kind: 'cancelled' };
  }

  try {
    deps.postRevealBackendDiagnostics();
  } catch {
    return { kind: 'error', code: 'reveal_failed' };
  }

  return { kind: 'success' };
}
