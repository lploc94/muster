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
 *
 * Concurrent first-open is serialized by BEGIN EXCLUSIVE inside the claim path.
 * Peers either wait on the lock or observe the post-commit state
 * (Muster application_id + current user_version). They never observe a durable
 * partial claim, and they never retry a persisted incomplete Muster DB.
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
  // Retry only real SQLite lock contention. Permanent ownership/schema failures
  // must surface immediately with reset guidance.
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

/**
 * Thrown when an existing development DB does not match the current schema, or a
 * Muster-owned file is incomplete/corrupt. Always includes developer reset guidance.
 */
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

function readScalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) {
    return 0;
  }
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

/** True when the DB already has any non-internal table/view/index/trigger. */
function hasUserSchemaObjects(db: DatabaseSync): boolean {
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
function applyConnectionBusyTimeout(db: DatabaseSync, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
}

/**
 * Runtime pragmas for an owned Muster connection. WAL is durable and must only run
 * after ownership/schema validation succeeds.
 */
function applyRuntimePragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  applyConnectionBusyTimeout(db, busyTimeoutMs);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
}

type PreflightState = { kind: 'current' } | { kind: 'blank' };

/**
 * Read-only ownership/schema preflight. Never stamps application_id, never changes
 * journal mode, and never writes schema.
 */
function preflightDatabase(db: DatabaseSync): PreflightState {
  const applicationId = readScalar(db, 'application_id');
  const userVersion = readScalar(db, 'user_version');

  if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
    throw new ForeignDatabaseError(applicationId);
  }

  if (applicationId === MUSTER_APPLICATION_ID) {
    // Owned file must already be fully current. Incomplete owned DBs
    // (including user_version=0) fail closed with reset guidance — they are not
    // "bootstrap in progress", because exclusive claim commits atomically.
    if (userVersion === SQLITE_SCHEMA_VERSION) {
      return { kind: 'current' };
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
 * and user_version. Concurrent first-open losers block on the exclusive lock, then
 * re-read post-commit markers and accept a completed bootstrap without rewriting DDL.
 */
function claimAndBootstrapBlankDatabase(db: DatabaseSync): void {
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
      throw new IncompatibleSchemaError(userVersion);
    }
    if (userVersion !== 0) {
      throw new IncompatibleSchemaError(userVersion);
    }
    if (hasUserSchemaObjects(db)) {
      throw new NonEmptyUnclaimedDatabaseError();
    }

    for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
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
 * Open the store DB with validation-before-mutation:
 * preflight → claim/bootstrap blank only → runtime pragmas (incl. WAL).
 * Rejected databases are closed without durable side effects.
 * Retry is limited to SQLite BUSY/LOCKED contention.
 */
export function openStoreDatabase(opts: OpenOptions): DatabaseSync {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  // Concurrent first-open may contend on BEGIN EXCLUSIVE. Reopen within a budget
  // only for real lock errors; permanent ownership/schema failures fail immediately.
  const retryDeadline = Date.now() + Math.max(1_000, busyTimeoutMs * 2);
  let attempt = 0;

  for (;;) {
    const db = new DatabaseSync(opts.path);
    try {
      // Connection-local only — does not mutate durable journal/application markers.
      applyConnectionBusyTimeout(db, busyTimeoutMs);
      const preflight = preflightDatabase(db);
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
