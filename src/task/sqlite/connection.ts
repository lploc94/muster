/**
 * SQLite connection lifecycle + schema migration for the global Muster store.
 *
 * Runs INSIDE the DB worker thread only (plan §3.4): `DatabaseSync` is synchronous,
 * so it must never open on the extension-host main thread where a `busy_timeout`
 * stall would freeze the VS Code UI. This module has no VS Code dependency and is
 * unit-testable directly on Node.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  MUSTER_APPLICATION_ID,
  SCHEMA_V1_STATEMENTS,
  SQLITE_SCHEMA_VERSION,
} from './schema';

export interface OpenOptions {
  /** Filesystem path to `muster.sqlite3` (or ':memory:' in tests). */
  path: string;
  /** busy_timeout in ms (plan §3.4 default 5000). */
  busyTimeoutMs?: number;
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

/** Thrown when the on-disk schema is newer than this build supports. */
export class SchemaTooNewError extends Error {
  constructor(readonly observedVersion: number) {
    super(
      `SQLite schema version ${observedVersion} is newer than supported ` +
        `${SQLITE_SCHEMA_VERSION}; refusing to downgrade`,
    );
    this.name = 'SchemaTooNewError';
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
  // journal_mode is persistent once set; issuing it every open is harmless.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
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
 * Run schema migrations up to {@link SQLITE_SCHEMA_VERSION} inside a single
 * exclusive transaction, keyed by `PRAGMA user_version`. A process that loses the
 * cross-process race blocks on the exclusive lock, then re-reads user_version and
 * finds nothing to do (plan §3.4: "process thua race phải reopen/verify version,
 * không chạy lại DDL dựa trên state cũ"). All v1 DDL is `IF NOT EXISTS`, so even a
 * torn prior attempt converges.
 */
export function migrateToLatest(db: DatabaseSync): number {
  const current = readScalar(db, 'user_version');
  if (current > SQLITE_SCHEMA_VERSION) {
    throw new SchemaTooNewError(current);
  }
  if (current === SQLITE_SCHEMA_VERSION) {
    return current;
  }
  // BEGIN EXCLUSIVE serializes migration across processes sharing the WAL.
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    // Re-check under the exclusive lock: a racing process may have migrated while
    // we waited to acquire it.
    const underLock = readScalar(db, 'user_version');
    if (underLock < SQLITE_SCHEMA_VERSION) {
      if (underLock < 1) {
        for (const stmt of SCHEMA_V1_STATEMENTS) {
          db.exec(stmt);
        }
      }
      // user_version cannot be bound as a parameter; the value is a validated const.
      db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
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
 * schema migrated to the latest version. Returns the live connection; the caller
 * (DB worker) owns close().
 */
export function openStoreDatabase(opts: OpenOptions): DatabaseSync {
  const db = new DatabaseSync(opts.path);
  try {
    applyPragmas(db, opts.busyTimeoutMs ?? 5000);
    verifyOrStampApplicationId(db);
    migrateToLatest(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
