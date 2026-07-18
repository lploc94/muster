/**
 * Awaitable maintenance quiesce for backup-before-reset / developer reset (P5-W5).
 *
 * Distinct from terminal-storage hard quiesce: this path gracefully drains the
 * engine (flush/abort/settle) and closes the DB client so queued RPC settles
 * before reset mutation begins. Failures propagate so reset aborts.
 */

export type MaintenanceEngine = {
  shutdown: () => Promise<void>;
};

export type MaintenanceHost = {
  disposeRevisionPoller: () => void;
};

export type MaintenanceDbClient = {
  close: () => Promise<void>;
};

export type MaintenanceQuiesceInput = {
  productionProvider?: MaintenanceHost | null;
  uatProvider?: MaintenanceHost | null;
  engine?: MaintenanceEngine | null;
  client?: MaintenanceDbClient | null;
  /** Clear module-level host refs after capturing client/engine (sync). */
  clearHostRefs: () => void;
  /** Best-effort cancel bridges / stop writers (no throw required). */
  stopWriters?: () => void | Promise<void>;
};

/**
 * Single-flight awaitable barrier used before reset mutation.
 * Detaches refs first, then drains; first hard failure (engine shutdown / client
 * close) is rethrown so the caller aborts reset.
 */
export async function quiesceForMaintenance(input: MaintenanceQuiesceInput): Promise<void> {
  // Detach host write entrypoints immediately so new commands see undefined refs.
  const engine = input.engine ?? null;
  const client = input.client ?? null;
  try {
    input.productionProvider?.disposeRevisionPoller();
  } catch {
    // best-effort poller dispose
  }
  try {
    input.uatProvider?.disposeRevisionPoller();
  } catch {
    // best-effort
  }
  input.clearHostRefs();

  const errors: unknown[] = [];
  try {
    await input.stopWriters?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    await engine?.shutdown();
  } catch (error) {
    errors.push(error);
  }
  try {
    await client?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}
