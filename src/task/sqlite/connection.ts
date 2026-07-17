/**
 * SQLite connection lifecycle + fresh-schema initialization for the global Muster store.
 *
 * Runs INSIDE the DB worker thread only (plan §3.4): `DatabaseSync` is synchronous,
 * so it must never open on the extension-host main thread where a `busy_timeout`
 * stall would freeze the VS Code UI. This module has no VS Code dependency and is
 * unit-testable directly on Node.
 *
 * Open contract (validation-before-mutation):
 * 1. Read-only preflight of application_id / user_version / user schema objects.
 * 2. Reject foreign or incompatible DBs without changing journal mode, application_id,
 *    user_version, schema, or data.
 * 3. Only a truly blank DB may be claimed (stamp + current schema bootstrap).
 * 4. Runtime pragmas including WAL are applied only after ownership is confirmed.
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
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  // node:sqlite currently reports lock failures as ERR_SQLITE_ERROR, so the
  // SQLite message remains part of the predicate. Do not retry foreign-database
  // or permanent schema-incompatibility errors.
  return (
    name === 'BootstrapInProgressError' ||
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

/**
 * Thrown when application_id/user_version look blank but the file already has
 * user schema objects. Muster never silently claims a non-empty foreign file.
 */
export class NonEmptyUnclaimedDatabaseError extends Error {
  constructor() {
    super(
      'SQLite file is unclaimed (application_id=0, user_version=0) but already contains ' +
        'schema objects. Reset or remove the file; Muster will not take ownership.',
    );
    this.name = 'NonEmptyUnclaimedDatabaseError';
  }
}

/**
 * Transient: another host is mid first-open claim. Caller should close and retry
 * within the open budget rather than mutate the file.
 */
export class BootstrapInProgressError extends Error {
  constructor() {
    super('Muster SQLite bootstrap is in progress in another connection; retrying open');
    this.name = 'BootstrapInProgressError';
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

function readJournalMode(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
  return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : 'unknown';
}

/** True when the DB already has any non-internal table/view/index/trigger. */
export function hasUserSchemaObjects(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'`,
    )
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * Connection-local wait policy only. Safe during preflight because busy_timeout is
 * not a durable file mutation (unlike journal_mode / application_id / user_version).
 */
export function applyConnectionBusyTimeout(db: DatabaseSync, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
}

/**
 * Runtime pragmas for an owned Muster connection. WAL is durable and must only run
 * after ownership/schema validation succeeds.
 */
export function applyRuntimePragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  applyConnectionBusyTimeout(db, busyTimeoutMs);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
}

/** @deprecated Prefer applyRuntimePragmas after ownership is confirmed. */
export function applyPragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  applyRuntimePragmas(db, busyTimeoutMs);
}

type PreflightState =
  | { kind: 'current' }
  | { kind: 'blank' }
  | { kind: 'bootstrap_in_progress' };

/**
 * Read-only ownership/schema preflight. Never stamps application_id, never changes
 * journal mode, and never writes schema.
 */
export function preflightDatabase(db: DatabaseSync): PreflightState {
  const applicationId = readScalar(db, 'application_id');
  const userVersion = readScalar(db, 'user_version');

  if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
    throw new ForeignDatabaseError(applicationId);
  }

  if (applicationId === MUSTER_APPLICATION_ID) {
    if (userVersion === SQLITE_SCHEMA_VERSION) {
      return { kind: 'current' };
    }
    // Another host may have stamped ownership and still be writing DDL.
    if (userVersion === 0) {
      return { kind: 'bootstrap_in_progress' };
    }
    throw new IncompatibleSchemaError(userVersion);
  }

  // application_id === 0
  if (userVersion !== 0) {
    throw new IncompatibleSchemaError(userVersion);
  }
  if (hasUserSchemaObjects(db)) {
    throw new NonEmptyUnclaimedDatabaseError();
  }
  return { kind: 'blank' };
}

/**
 * Claim a blank DB under exclusive lock: create current schema, stamp application_id
 * and user_version. Concurrent first-open losers re-read under the lock and accept a
 * completed bootstrap without rewriting DDL.
 *
 * Note: some PRAGMAs are not fully transactional. user_version is set last as the
 * "schema ready" marker; peers that observe Muster application_id with user_version=0
 * treat that as bootstrap-in-progress and retry without mutating.
 */
export function claimAndBootstrapBlankDatabase(db: DatabaseSync): void {
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    const applicationId = readScalar(db, 'application_id');
    const userVersion = readScalar(db, 'user_version');

    if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
      throw new ForeignDatabaseError(applicationId);
    }
    if (applicationId === MUSTER_APPLICATION_ID) {
      if (userVersion === SQLITE_SCHEMA_VERSION) {
        db.exec('COMMIT');
        return;
      }
      if (userVersion === 0) {
        throw new BootstrapInProgressError();
      }
      throw new IncompatibleSchemaError(userVersion);
    }
    if (userVersion !== 0) {
      throw new IncompatibleSchemaError(userVersion);
    }
    if (hasUserSchemaObjects(db)) {
      throw new NonEmptyUnclaimedDatabaseError();
    }

    // Claim ownership before DDL so concurrent readers never see unclaimed tables.
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
    // Ready marker last: peers treat MUSTER + user_version=0 as in-progress.
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure — original error is the real signal
    }
    throw error;
  }
}

/**
 * @deprecated Prefer preflightDatabase + claimAndBootstrapBlankDatabase via openStoreDatabase.
 * Kept for unit tests that exercise the schema-only path after ownership is already valid.
 */
export function verifyOrStampApplicationId(db: DatabaseSync): void {
  const observed = readScalar(db, 'application_id');
  if (observed === MUSTER_APPLICATION_ID) {
    return;
  }
  if (observed === 0) {
    if (hasUserSchemaObjects(db) || readScalar(db, 'user_version') !== 0) {
      if (readScalar(db, 'user_version') !== 0) {
        throw new IncompatibleSchemaError(readScalar(db, 'user_version'));
      }
      throw new NonEmptyUnclaimedDatabaseError();
    }
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    return;
  }
  throw new ForeignDatabaseError(observed);
}

/**
 * @deprecated Prefer claimAndBootstrapBlankDatabase. Only bootstraps schema for blank DBs
 * that already passed ownership preflight; does not stamp application_id.
 */
export function initializeCurrentSchema(db: DatabaseSync): number {
  const current = readScalar(db, 'user_version');
  if (current === SQLITE_SCHEMA_VERSION) {
    return current;
  }
  if (current !== 0) {
    throw new IncompatibleSchemaError(current);
  }
  if (hasUserSchemaObjects(db)) {
    throw new NonEmptyUnclaimedDatabaseError();
  }
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    const underLock = readScalar(db, 'user_version');
    if (underLock === 0) {
      if (hasUserSchemaObjects(db)) {
        throw new NonEmptyUnclaimedDatabaseError();
      }
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
 * Open the store DB with validation-before-mutation:
 * preflight → claim/bootstrap blank only → runtime pragmas (incl. WAL).
 * Rejected databases are closed without durable side effects.
 */
export function openStoreDatabase(opts: OpenOptions): DatabaseSync {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  // Concurrent first-open may observe bootstrap-in-progress or lock contention.
  // Reopen and re-verify durable markers within a bounded budget.
  const retryDeadline = Date.now() + Math.max(1_000, busyTimeoutMs * 2);
  let attempt = 0;

  for (;;) {
    const db = new DatabaseSync(opts.path);
    try {
      // Connection-local only — does not mutate durable journal/application markers.
      applyConnectionBusyTimeout(db, busyTimeoutMs);
      const preflight = preflightDatabase(db);
      if (preflight.kind === 'bootstrap_in_progress') {
        throw new BootstrapInProgressError();
      }
      if (preflight.kind === 'blank') {
        claimAndBootstrapBlankDatabase(db);
      }
      // WAL / foreign_keys / synchronous only after ownership is confirmed.
      applyRuntimePragmas(db, busyTimeoutMs);
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

/** Test helper: journal mode without opening through the production path. */
export function inspectJournalMode(db: DatabaseSync): string {
  return readJournalMode(db);
}
