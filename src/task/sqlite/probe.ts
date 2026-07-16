/**
 * Activation feature-probe for `node:sqlite` (plan §3.5).
 *
 * The extension declares `engines.vscode: ^1.101.0` (VS Code 1.101 ships a Node 22
 * extension host, where `node:sqlite` exists). A fork/host that claims compatibility
 * but lacks the module must fail LOUDLY with an upgrade instruction — never silently
 * fall back to the JSON store (that would create two writable sources, plan §3.5).
 */

export interface ProbeResult {
  available: boolean;
  /** Present only when unavailable — a user-facing, non-secret upgrade message. */
  reason?: string;
}

/** Human-facing guidance when the runtime lacks `node:sqlite`. */
export const NODE_SQLITE_MISSING_MESSAGE =
  'Muster requires the built-in node:sqlite module, available in the VS Code 1.101+ ' +
  'extension host (Node 22). This host does not provide it. Update VS Code (or your ' +
  'remote/server host) to 1.101 or newer.';

/**
 * Probe whether `node:sqlite` can be required in this runtime. Uses a dynamic
 * `require` so a missing module surfaces as a caught error here rather than an
 * unhandled import failure at module load. Never throws.
 */
export function probeNodeSqlite(
  requireFn: (id: string) => unknown = defaultRequire,
): ProbeResult {
  try {
    const mod = requireFn('node:sqlite') as { DatabaseSync?: unknown };
    if (mod && typeof mod.DatabaseSync === 'function') {
      return { available: true };
    }
    return { available: false, reason: NODE_SQLITE_MISSING_MESSAGE };
  } catch {
    return { available: false, reason: NODE_SQLITE_MISSING_MESSAGE };
  }
}

function defaultRequire(id: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(id);
}
