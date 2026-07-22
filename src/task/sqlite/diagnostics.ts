/**
 * Host-side SQLite open/runtime diagnostics (P5-W2).
 *
 * Maps DB-boundary errors into a fixed, redacted diagnostic. Never includes
 * filesystem paths, SQL, params, stacks or conversation content. Recovery UI
 * may resolve the path from host context separately when the user needs it.
 */

import {
  MusterDomainError,
  MusterInvariantError,
  MusterSqliteError,
  isSqliteErrorCode,
  isSqliteOperationClass,
  isTerminalStorageCode,
  recoveryActionForCode,
  safeMessageForCode,
  type SqliteErrorCode,
  type SqliteErrorKind,
  type SqliteOperationClass,
  type SqliteRecoveryAction,
} from './errors';
import type { DbWorkerError } from './client';

export type SqliteDiagnostic = {
  code: SqliteErrorCode;
  operation: SqliteOperationClass;
  message: string;
  recoveryAction: SqliteRecoveryAction;
  kind: SqliteErrorKind;
  /** True when the host must not start engine/scheduler/poller/writer. */
  failClosed: boolean;
  /** True when storage is latched terminal (corrupt / not a database / schema_changed). */
  terminal: boolean;
};

export function diagnoseSqliteError(
  error: unknown,
  operation: SqliteOperationClass = 'unknown',
): SqliteDiagnostic {
  if (
    error instanceof MusterSqliteError ||
    error instanceof MusterDomainError ||
    error instanceof MusterInvariantError
  ) {
    return {
      code: error.code,
      operation: error.operation,
      message: error.message,
      recoveryAction: recoveryActionForCode(error.code),
      kind: error.kind,
      failClosed: true,
      terminal: isTerminalStorageCode(error.code),
    };
  }

  const detail = (error as DbWorkerError | undefined)?.detail;
  if (detail && isSqliteErrorCode(detail.code)) {
    const code = detail.code;
    const op = isSqliteOperationClass(detail.operation) ? detail.operation : operation;
    const kind =
      detail.kind === 'domain' || detail.kind === 'invariant' || detail.kind === 'operational'
        ? detail.kind
        : code === 'constraint' || code === 'capacity'
          ? 'domain'
          : code === 'invariant' || code === 'protocol'
            ? 'invariant'
            : 'operational';
    return {
      code,
      operation: op,
      message: safeMessageForCode(code),
      recoveryAction: recoveryActionForCode(code),
      kind,
      failClosed: true,
      terminal: isTerminalStorageCode(code),
    };
  }

  if (isSqliteErrorCode((error as { code?: unknown }).code)) {
    const code = (error as { code: SqliteErrorCode }).code;
    return {
      code,
      operation,
      message: safeMessageForCode(code),
      recoveryAction: recoveryActionForCode(code),
      kind: code === 'constraint' || code === 'capacity' ? 'domain' : 'operational',
      failClosed: true,
      terminal: isTerminalStorageCode(code),
    };
  }

  return {
    code: 'unknown',
    operation,
    message: safeMessageForCode('unknown'),
    recoveryAction: recoveryActionForCode('unknown'),
    kind: 'operational',
    failClosed: true,
    terminal: false,
  };
}

/** Stable log fields only — never path/SQL/content. */
export function redactedDiagnosticLogFields(
  diagnostic: SqliteDiagnostic,
): Record<string, string | boolean> {
  return {
    code: diagnostic.code,
    operation: diagnostic.operation,
    recoveryAction: diagnostic.recoveryAction,
    kind: diagnostic.kind,
    failClosed: diagnostic.failClosed,
    terminal: diagnostic.terminal,
  };
}

/**
 * User-facing recovery guidance (no path, no repeated diagnostic.message).
 * Reveal is inspect-only; coordinated reset is W5 — never instruct partial file deletes.
 */
export function recoveryGuidanceFor(diagnostic: SqliteDiagnostic): string {
  switch (diagnostic.recoveryAction) {
    case 'reveal_storage':
      if (diagnostic.code === 'incompatible_schema') {
        return 'Choose Reset Muster Data to rebuild an empty current database. This permanently deletes all Muster conversations and tasks in this VS Code profile. Close other Muster windows first; do not manually delete main/-wal/-shm files separately.';
      }
      return 'You can reveal the Muster global storage folder to inspect the database. Close every Muster window before any manual handling; do not delete main/-wal/-shm files separately.';
    case 'reload_window':
      return 'Reload this window to continue with the upgraded schema.';
    case 'free_disk_space':
      return 'Free disk space and try the operation again.';
    case 'check_permissions':
      return 'Check that the Muster storage location is writable.';
    case 'retry':
      return 'Retry the operation. If it keeps failing, close other Muster windows and try again.';
    case 'close_other_windows':
      return 'Close other Muster windows that may be holding the database and try again.';
    default:
      return '';
  }
}
