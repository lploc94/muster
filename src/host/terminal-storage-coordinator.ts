/**
 * Production terminal-storage quiesce coordinator (P5-W2).
 *
 * Stops the real production revision poller (not only the UAT alias), hard-quiesces
 * the engine with zero repository writes, and clears host refs. UI is left to the
 * caller so activation can show exactly one diagnostic.
 */

export type TerminalStorageHost = {
  disposeRevisionPoller: () => void;
};

export type TerminalStorageEngine = {
  quiesceForTerminalStorage: () => void;
};

export function applyTerminalStorageQuiesce(input: {
  productionProvider?: TerminalStorageHost | null;
  uatProvider?: TerminalStorageHost | null;
  engine?: TerminalStorageEngine | null;
  clearHostRefs: () => void;
}): void {
  try {
    input.productionProvider?.disposeRevisionPoller();
  } catch {
    // best-effort
  }
  try {
    input.uatProvider?.disposeRevisionPoller();
  } catch {
    // best-effort
  }
  try {
    input.engine?.quiesceForTerminalStorage();
  } catch {
    // best-effort — must not write after terminal latch
  }
  input.clearHostRefs();
}
