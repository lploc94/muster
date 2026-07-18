/**
 * Typed request/response protocol between the extension host and the DB worker
 * (plan §3.4). `DatabaseSync` is synchronous, so it lives on a worker thread; the
 * host never touches the connection directly. A `busy_timeout` stall then blocks
 * the worker, not the VS Code event loop.
 *
 * The repository layer builds named domain commands from these worker-owned
 * transaction primitives. SQL never crosses into engine/snapshot code, and no
 * callback is serialized over the RPC boundary.
 */

/** Bound parameter value. No content/path is ever interpolated into SQL (plan §3.4). */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A single prepared statement invocation. */
export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * Pragmas the worker will read via RPC. A closed allowlist: even though every
 * caller is internal today, a raw `PRAGMA ${string}` over the RPC boundary is an
 * injection surface we refuse to keep open (audit follow-up). Extend deliberately.
 */
export const ALLOWED_READ_PRAGMAS = [
  'user_version',
  'application_id',
  'data_version',
  'journal_mode',
  'foreign_keys',
  'synchronous',
  'busy_timeout',
] as const;

export type ReadPragma = (typeof ALLOWED_READ_PRAGMAS)[number];

export function isAllowedReadPragma(value: string): value is ReadPragma {
  return (ALLOWED_READ_PRAGMAS as readonly string[]).includes(value);
}

/** Safe backup result metadata only — never paths or row content (P5-W4). */
export type BackupResultMeta = {
  mechanism: 'api' | 'vacuum';
  schemaVersion: number;
  workspaceRevision: number;
  byteSize: number;
};

export type DbRequest =
  | { kind: 'open'; requestId: number; path: string; busyTimeoutMs?: number }
  | { kind: 'all'; requestId: number; sql: string; params?: SqlValue[] }
  | { kind: 'get'; requestId: number; sql: string; params?: SqlValue[] }
  | { kind: 'run'; requestId: number; sql: string; params?: SqlValue[] }
  | {
      /**
       * Run an ordered list of statements inside a single IMMEDIATE transaction.
       * Any failure rolls back the whole batch. This is the write primitive named
       * commands are built on — it keeps writes short and off the main thread.
       */
      kind: 'transaction';
      requestId: number;
      statements: SqlStatement[];
      /**
       * Conditional write guard. If the first statement affects no row, the
       * worker rolls the IMMEDIATE transaction back and returns that one result
       * without evaluating later statements. This lets repository commands use
       * optimistic guards without a race or partial aggregate write.
       */
      abortIfFirstUnchanged?: boolean;
      /** Additional statement indexes whose zero-change result aborts the
       * transaction. Used when an operation claim precedes a revision fence. */
      abortIfUnchangedAt?: number[];
    }
  | { kind: 'pragma'; requestId: number; pragma: string }
  | {
      /**
       * SQLite-aware live backup (P5-W4). Destination path stays on the worker;
       * the host only receives redacted metadata. Cancellation is a request-scoped
       * SharedArrayBuffer Int32 (0=run, 1=cancel) observed before publish.
       */
      kind: 'backup';
      requestId: number;
      destinationPath: string;
      overwrite: boolean;
      cancellationFlag?: SharedArrayBuffer;
      /** Test-only force of mechanism (ignored without fault capability). */
      forceMechanism?: 'api' | 'vacuum';
      /** Test-only: set cancel flag after snapshot (fault capability). */
      armCancelAfterSnapshot?: boolean;
      /** Test-only: corrupt temp before verify (fault capability). */
      corruptBeforeVerify?: boolean;
      /** Test-only fail after verify before publish (fault capability). */
      failBeforePublish?: boolean;
      /** Test-only fail during publish after verify (fault capability). */
      failDuringPublish?: boolean;
      /** Test-only progress barrier flag (fault capability). */
      progressFlag?: SharedArrayBuffer;
    }
  | { kind: 'close'; requestId: number };

export interface RunResult {
  /** Rows changed by the last statement. */
  changes: number;
  /** Last inserted rowid (bigint from node:sqlite, normalized to number when safe). */
  lastInsertRowid: number;
}

export type DbResponse =
  | { kind: 'ok'; requestId: number }
  | { kind: 'rows'; requestId: number; rows: unknown[] }
  | { kind: 'row'; requestId: number; row: unknown }
  | { kind: 'run'; requestId: number; result: RunResult }
  /** Results are in the same order as the submitted transaction statements. */
  | { kind: 'transaction'; requestId: number; results: RunResult[] }
  | { kind: 'scalar'; requestId: number; value: number }
  | { kind: 'backup'; requestId: number; result: BackupResultMeta }
  | {
      kind: 'error';
      requestId: number;
      /**
       * Safe boundary envelope only (P5-W1). Fixed code + operation class +
       * category; message is always rewritten from the taxonomy table.
       */
      message: string;
      code: string;
      name: string;
      operation: string;
      errorKind: string;
    };

/** Serializable error shape for crossing the worker boundary without leaking params. */
export interface SerializedDbError {
  message: string;
  code: string;
  name: string;
  operation: string;
  errorKind: string;
}

export {
  mapToMusterSqliteError,
  serializeMusterError,
  type SqliteErrorCode,
  type SqliteOperationClass,
} from './errors';

export { validateRpcErrorPayload, makeProtocolError } from './protocol';

import { serializeMusterError, type SqliteOperationClass } from './errors';

/**
 * Serialize any thrown value into a safe RPC error. Raw SQLite messages, SQL,
 * params and paths are never copied onto the wire.
 */
export function serializeError(
  error: unknown,
  operation: SqliteOperationClass = 'unknown',
): SerializedDbError {
  const safe = serializeMusterError(error, operation);
  return {
    message: safe.message,
    code: safe.code,
    name: safe.name,
    operation: safe.operation,
    errorKind: safe.kind,
  };
}
