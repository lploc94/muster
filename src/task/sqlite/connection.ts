/**
 * SQLite connection lifecycle + fresh-schema initialization for the global Muster store.
 *
 * Runs INSIDE the DB worker thread only (plan §3.4): `DatabaseSync` is synchronous,
 * so it must never open on the extension-host main thread where a `busy_timeout`
 * stall would freeze the VS Code UI. This module has no VS Code dependency and is
 * unit-testable directly on Node.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  CURRENT_SCHEMA_STATEMENTS,
  MUSTER_APPLICATION_ID,
  SQLITE_SCHEMA_VERSION,
} from './schema';

export interface OpenOptions {
  /** Filesystem path to `muster.sqlite3` (or ':memory:' in tests). */
  path: string;
  /** busy_timeout in ms (plan §3.4 default 5000). */
  busyTimeoutMs?: number;
}

const OPEN_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isRetryableOpenLock(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  // node:sqlite currently reports lock failures as ERR_SQLITE_ERROR, so the
  // SQLite message remains part of the predicate. Do not retry arbitrary I/O,
  // foreign-database or schema errors.
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /database (?:table )?is locked|database is busy/i.test(message)
  );
}

function waitBeforeOpenRetry(attempt: number): void {
  // This module runs in the DB worker in production. A short synchronous wait
  // therefore delays only this connection bootstrap, never the extension host.
  const delayMs = Math.min(250, 10 * (2 ** Math.min(attempt, 5)));
  Atomics.wait(OPEN_RETRY_WAIT, 0, 0, delayMs);
}

/** Thrown when the DB file belongs to a different application_id (not Muster's). */
export class ForeignDatabaseError extends Error {
  constructor(readonly observedApplicationId: number) {
    super(
      `SQLite application_id ${observedApplicationId} is not Muster's ` +
        `(${MUSTER_APPLICATION_ID}); refusing to touch a foreign database`,
    );
    this.name = 'ForeignDatabaseError';
  }
}

/** Thrown when an existing development DB does not match the current schema. */
export class IncompatibleSchemaError extends Error {
  constructor(readonly observedVersion: number) {
    super(
      `SQLite schema version ${observedVersion} does not match required version ` +
        `${SQLITE_SCHEMA_VERSION}. Reset the Muster development database and reopen VS Code.`,
    );
    this.name = 'IncompatibleSchemaError';
  }
}

function readScalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) {
    return 0;
  }
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

/**
 * Apply the runtime pragmas from plan §3.4. WAL + foreign_keys are durable per-DB /
 * per-connection settings; synchronous NORMAL + busy_timeout tune write coordination.
 */
export function applyPragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  // Install the wait policy BEFORE journal_mode. Two extension hosts can open a
  // brand-new profile DB concurrently; changing journal mode itself may need the
  // database lock, so setting busy_timeout last would make that race fail fast.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  // journal_mode is persistent once set; issuing it every open is harmless.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
}

/**
 * Verify (or, on a brand-new empty DB, stamp) Muster's `application_id`. A DB that
 * already carries a DIFFERENT non-zero application_id is refused — we never
 * silently take over a file some other tool created (plan §3.4, handoff rule §13:
 * "no silent reset").
 */
export function verifyOrStampApplicationId(db: DatabaseSync): void {
  const observed = readScalar(db, 'application_id');
  if (observed === MUSTER_APPLICATION_ID) {
    return;
  }
  if (observed === 0) {
    // Fresh/blank DB — claim it.
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    return;
  }
  throw new ForeignDatabaseError(observed);
}

/**
 * Initialize the current schema only for a fresh database. Existing databases at
 * another version are rejected: development builds do not carry data migrations.
 * The exclusive transaction still serializes simultaneous first-open attempts.
 */
export function initializeCurrentSchema(db: DatabaseSync): number {
  const current = readScalar(db, 'user_version');
  if (current === SQLITE_SCHEMA_VERSION) {
    return current;
  }
  if (current !== 0) {
    throw new IncompatibleSchemaError(current);
  }
  // BEGIN EXCLUSIVE serializes initialization across processes sharing the WAL.
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    // Re-check under the lock: a racing process may have initialized the DB.
    const underLock = readScalar(db, 'user_version');
    if (underLock === 0) {
      for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
      db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    } else if (underLock !== SQLITE_SCHEMA_VERSION) {
      throw new IncompatibleSchemaError(underLock);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure — original error is the real signal
    }
    throw error;
  }
  return SQLITE_SCHEMA_VERSION;
}

/**
 * Open the store DB with pragmas applied, application_id verified/stamped, and the
 * current schema initialized. Returns the live connection; the caller
 * (DB worker) owns close().
 */
export function openStoreDatabase(opts: OpenOptions): DatabaseSync {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  // A simultaneous first open can fail immediately while multiple connections
  // switch a brand-new file to WAL, before SQLite's busy handler gets a chance to
  // wait. Reopen and re-verify the durable markers within a bounded budget. This
  // also implements the plan's loser-of-initialization-race contract instead of
  // assuming BEGIN EXCLUSIVE alone covers WAL bootstrap.
  const retryDeadline = Date.now() + Math.max(1_000, busyTimeoutMs * 2);
  let attempt = 0;

  for (;;) {
    const db = new DatabaseSync(opts.path);
    try {
      applyPragmas(db, busyTimeoutMs);
      verifyOrStampApplicationId(db);
      initializeCurrentSchema(db);
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // The original initialization error is the actionable failure.
      }
      if (!isRetryableOpenLock(error) || Date.now() >= retryDeadline) {
        throw error;
      }
      waitBeforeOpenRetry(attempt);
      attempt += 1;
    }
  }
}
