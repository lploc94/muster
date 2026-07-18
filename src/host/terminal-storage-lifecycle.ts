/**
 * Exactly-once terminal storage reporting lifecycle (P5-W2).
 *
 * Separates synchronous quiesce from async diagnostic/UI/close so activation
 * and runtime share one report promise without double-logging.
 */

export type TerminalStorageLifecycleDiagnostic = {
  code: string;
  message: string;
  recoveryAction?: string;
  [key: string]: unknown;
};

export type TerminalStorageLifecycleDeps<TDiag extends TerminalStorageLifecycleDiagnostic = TerminalStorageLifecycleDiagnostic> = {
  diagnose: (error: unknown, operation: 'open' | 'unknown') => TDiag;
  redactedLogFields: (diagnostic: TDiag) => Record<string, unknown>;
  log: (channel: string, fields: Record<string, unknown>) => void;
  quiesce: () => void;
  closeDoomed: (doomed: unknown) => Promise<void>;
  showError: (message: string, action?: string) => Promise<string | undefined>;
  revealStorage: () => Promise<void>;
  guidanceFor: (diagnostic: TDiag) => string | undefined;
};

export type TerminalStorageLifecycle = {
  /** Synchronous host stop — safe to call multiple times. */
  quiesceSync: () => void;
  /** Mark activation open complete (runtime callbacks may report UI). */
  markActivationReady: () => void;
  /** Pending activation error, if any. */
  takePendingActivationError: () => unknown | undefined;
  /**
   * Handle the DbClient terminal callback. `doomed` is captured by the caller
   * before synchronous quiesce clears host references.
   *
   * During activation this stores the error for the activation catch. At
   * runtime it returns the shared exactly-once report promise.
   */
  handleTerminalSignal: (error: unknown, doomed?: unknown) => Promise<void> | undefined;
  /**
   * Exactly-once report. Concurrent callers share the same promise.
   * During activation (not ready), callers should only quiesce + store; catch reports.
   */
  reportOnce: (
    error: unknown,
    options: { operation: 'open' | 'unknown'; doomed?: unknown; showUi: boolean },
  ) => Promise<void>;
};

export function createTerminalStorageLifecycle<
  TDiag extends TerminalStorageLifecycleDiagnostic = TerminalStorageLifecycleDiagnostic,
>(deps: TerminalStorageLifecycleDeps<TDiag>): TerminalStorageLifecycle {
  let terminalQuiesced = false;
  let terminalReported = false;
  let terminalReportPromise: Promise<void> | undefined;
  let storageActivationReady = false;
  let pendingActivationTerminalError: unknown;

  const quiesceSync = (): void => {
    if (terminalQuiesced) return;
    terminalQuiesced = true;
    deps.quiesce();
  };

  const reportOnce = (
    error: unknown,
    options: { operation: 'open' | 'unknown'; doomed?: unknown; showUi: boolean },
  ): Promise<void> => {
    // Assign promise synchronously so concurrent callers share one report.
    if (terminalReportPromise) return terminalReportPromise;
    if (terminalReported) return Promise.resolve();
    terminalReported = true;
    terminalReportPromise = (async () => {
      quiesceSync();
      const diagnostic = deps.diagnose(error, options.operation);
      deps.log('sqlite.storage.terminal', deps.redactedLogFields(diagnostic));
      try {
        await deps.closeDoomed(options.doomed);
      } catch {
        // best-effort
      }
      if (!options.showUi) return;
      const guidance = deps.guidanceFor(diagnostic);
      const message = [diagnostic.message, guidance].filter(Boolean).join(' ');
      if (diagnostic.recoveryAction === 'reveal_storage') {
        const choice = await deps.showError(message, 'Reveal Storage Folder');
        if (choice === 'Reveal Storage Folder') {
          try {
            await deps.revealStorage();
          } catch {
            // Cancel is a strict no-op (no reset/delete).
          }
        }
      } else {
        void deps.showError(message);
      }
    })();
    return terminalReportPromise;
  };

  return {
    quiesceSync,
    markActivationReady: () => {
      storageActivationReady = true;
    },
    takePendingActivationError: () => {
      const err = pendingActivationTerminalError;
      pendingActivationTerminalError = undefined;
      return err;
    },
    handleTerminalSignal: (error, doomed) => {
      quiesceSync();
      if (!storageActivationReady) {
        pendingActivationTerminalError = error;
        return undefined;
      }
      return reportOnce(error, {
        operation: 'unknown',
        ...(doomed !== undefined ? { doomed } : {}),
        showUi: true,
      });
    },
    reportOnce,
  };
}
