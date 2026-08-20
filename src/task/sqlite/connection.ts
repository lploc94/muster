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
  MUSTER_WRITER_VERSION_UDF,
  REQUIRED_SCHEMA_TABLES,
  SQLITE_SCHEMA_VERSION,
} from './schema';
import { MusterSqliteError, mapToMusterSqliteError } from './errors';
import { findSchemaFingerprintFailure } from './schema-fingerprint';

export interface OpenOptions {
  /** Filesystem path to `muster.sqlite3` (or ':memory:' in tests). */
  path: string;
  /** busy_timeout in ms (plan §3.4 default 5000). */
  busyTimeoutMs?: number;
}

const OPEN_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
/** Bound residual WAL retained after checkpoints on every owned connection. */
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

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

/**
 * Thrown when the DB file belongs to a different application_id (not Muster's).
 * Wire-safe: message has no path; observed id stays in a non-serialized field.
 */
export class ForeignDatabaseError extends MusterSqliteError {
  constructor(readonly observedApplicationId: number) {
    super('foreign_database', 'open');
    this.name = 'ForeignDatabaseError';
  }
}

/**
 * Thrown when an existing development DB does not match the current schema, or a
 * Muster-owned file is incomplete/corrupt. Always includes developer reset guidance.
 */
export class IncompatibleSchemaError extends MusterSqliteError {
  constructor(readonly observedVersion: number) {
    super('incompatible_schema', 'open');
    this.name = 'IncompatibleSchemaError';
  }
}

/**
 * Thrown when application_id/user_version look blank but the file already has
 * user schema objects. Muster never silently claims a non-empty foreign file.
 */
export class NonEmptyUnclaimedDatabaseError extends MusterSqliteError {
  constructor() {
    super('nonempty_unclaimed', 'open');
    this.name = 'NonEmptyUnclaimedDatabaseError';
  }
}

// Schema version remains the ownership gate; it is not serialized on the RPC wire.
void SQLITE_SCHEMA_VERSION;

/**
 * Register the connection-local writer-version UDF required by write-guard triggers.
 * Stale connections without this UDF (or with a different compiled version) fail closed.
 */
export function registerWriterVersionUdf(db: DatabaseSync): void {
  // deterministic: safe for WHEN-clause evaluation; Number() keeps a stable SQLite numeric.
  db.function(MUSTER_WRITER_VERSION_UDF, { deterministic: true }, () => Number(SQLITE_SCHEMA_VERSION));
}

function readScalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) {
    return 0;
  }
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

/** True when the DB already contains any schema object, including SQLite residue. */
function hasSchemaObjects(db: DatabaseSync): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM sqlite_schema')
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * Bounded current-schema fingerprint: required tables/indexes/triggers AND
 * critical column structure before WAL (P5-W2). Read-only; no integrity_check.
 */
function assertCurrentSchemaComplete(db: DatabaseSync): void {
  try {
    const failure = findSchemaFingerprintFailure(db);
    if (failure) {
      throw new IncompatibleSchemaError(readScalar(db, 'user_version'));
    }
  } catch (error) {
    if (error instanceof IncompatibleSchemaError) throw error;
    // Unterminated quotes / fingerprint scanner failures fail closed.
    throw new IncompatibleSchemaError(readScalar(db, 'user_version'));
  }
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
  db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
}

type ExclusiveOpenDecision = { kind: 'current' } | { kind: 'blank_claimed' };
type ExistingOpenResult = 'current' | false;

/**
 * Private signal: state changed under concurrent first-open (peer bootstrap).
 * Caller closes and reopens a fresh connection — not a permanent ownership error.
 */
class ConcurrentOpenStateChanged extends Error {
  constructor() {
    super('concurrent open state changed after blank preflight');
    this.name = 'ConcurrentOpenStateChanged';
  }
}

/**
 * Authoritative ownership decision under BEGIN EXCLUSIVE.
 * Concurrent first-open losers block on the lock, then re-read post-commit
 * markers in the same exclusive critical section — never misclassify a peer
 * bootstrap as nonempty_unclaimed from a stale pre-claim snapshot.
 * Rejected foreign/incompatible/nonempty paths roll back with zero durable
 * schema/marker mutation.
 */
function exclusiveOpenDecision(db: DatabaseSync): ExclusiveOpenDecision {
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    const applicationId = readScalar(db, 'application_id');
    const userVersion = readScalar(db, 'user_version');

    if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
      throw new ForeignDatabaseError(applicationId);
    }

    if (applicationId === MUSTER_APPLICATION_ID) {
      if (userVersion === SQLITE_SCHEMA_VERSION) {
        assertCurrentSchemaComplete(db);
        db.exec('COMMIT');
        return { kind: 'current' };
      }
      // Additive migration 5 -> 6: global tables (no data loss). Applied under exclusive lock.
      if (userVersion === 5 && SQLITE_SCHEMA_VERSION === 6) {
        // Create global tables if missing (idempotent)
        db.exec(`CREATE TABLE IF NOT EXISTS global_composer_selection (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          backend TEXT NOT NULL,
          model TEXT,
          updated_at TEXT NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS global_backend_verification (
          backend_id TEXT PRIMARY KEY,
          verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
          version TEXT,
          checked_at TEXT NOT NULL
        )`);
        // Recreate writer guards for all tables with new version (drop old 5-triggers)
        for (const table of REQUIRED_SCHEMA_TABLES) {
          for (const event of ['insert', 'update', 'delete'] as const) {
            const name = `trg_wg_${table}_${event}`;
            try { db.exec(`DROP TRIGGER IF EXISTS ${name}`); } catch {}
            db.exec(`CREATE TRIGGER ${name}
BEFORE ${event.toUpperCase()} ON ${table}
WHEN muster_writer_version() IS NULL OR muster_writer_version() <> ${SQLITE_SCHEMA_VERSION}
BEGIN SELECT RAISE(ABORT, 'schema_changed'); END`);
          }
        }
        db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
        assertCurrentSchemaComplete(db);
        db.exec('COMMIT');
        return { kind: 'current' };
      }
      throw new IncompatibleSchemaError(userVersion);
    }

    // application_id === 0
    if (userVersion !== 0) {
      throw new IncompatibleSchemaError(userVersion);
    }
    if (hasSchemaObjects(db)) {
      // Blank preflight saw no objects; exclusive sees objects without Muster
      // markers — peer commit race / header visibility. Reopen fresh.
      db.exec('ROLLBACK');
      throw new ConcurrentOpenStateChanged();
    }

    for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    assertCurrentSchemaComplete(db);
    db.exec('COMMIT');
    return { kind: 'blank_claimed' };
  } catch (error) {
    if (!(error instanceof ConcurrentOpenStateChanged)) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is the real signal
      }
    }
    throw error;
  }
}

/**
 * Read-only ownership probe. Never stamps markers or creates schema.
 * - current Muster → 'current'
 * - blank → false (claim under exclusive)
 * - concurrent schema-without-markers after a blank was observed → ConcurrentOpenStateChanged
 * - genuine non-empty unclaimed on first probe → NonEmptyUnclaimedDatabaseError
 */
function tryOpenExistingCurrent(
  db: DatabaseSync,
  opts: { allowConcurrentNonemptyRetry: boolean },
): ExistingOpenResult {
  const applicationId = readScalar(db, 'application_id');
  const userVersion = readScalar(db, 'user_version');
  if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
    throw new ForeignDatabaseError(applicationId);
  }
  if (applicationId === MUSTER_APPLICATION_ID) {
    if (userVersion === SQLITE_SCHEMA_VERSION) {
      assertCurrentSchemaComplete(db);
      return 'current';
    }
    throw new IncompatibleSchemaError(userVersion);
  }
  if (userVersion !== 0) {
    throw new IncompatibleSchemaError(userVersion);
  }
  // A fresh SQLite file normally has no schema and auto_vacuum NONE. Muster's
  // concurrent first-open path must set INCREMENTAL before BEGIN because SQLite
  // ignores that change after schema pages exist; another contender can therefore
  // observe an empty file in exactly that intermediate state. Treat only an empty
  // NONE/INCREMENTAL file as claimable. FULL mode or any schema object remains
  // foreign residue until ownership markers prove otherwise.
  const autoVacuum = readScalar(db, 'auto_vacuum');
  const hasObjects = hasSchemaObjects(db);
  if (!hasObjects && (autoVacuum === 0 || autoVacuum === 2)) return false;
  if (autoVacuum !== 0 || hasObjects) {
    // Re-read markers once — peer commit can expose schema before header markers.
    const appAgain = readScalar(db, 'application_id');
    const verAgain = readScalar(db, 'user_version');
    if (appAgain === MUSTER_APPLICATION_ID && verAgain === SQLITE_SCHEMA_VERSION) {
      assertCurrentSchemaComplete(db);
      return 'current';
    }
    if (appAgain === 0 && verAgain === 0) {
      // A concurrent peer can publish its full schema pages before this connection
      // observes application_id/user_version. This worker may be arriving after the
      // blank preflight (so `sawBlankPreflight` is false), therefore object presence
      // alone is insufficient to distinguish the race from a foreign DB. Retry only
      // when the *entire* exact Muster fingerprint is visible; foreign, partial, or
      // modified schemas fail closed below without any retry or mutation.
      if (opts.allowConcurrentNonemptyRetry || !findSchemaFingerprintFailure(db)) {
        throw new ConcurrentOpenStateChanged();
      }
    }
    if (appAgain !== 0 && appAgain !== MUSTER_APPLICATION_ID) {
      throw new ForeignDatabaseError(appAgain);
    }
    if (appAgain === MUSTER_APPLICATION_ID) {
      throw new IncompatibleSchemaError(verAgain);
    }
    throw new NonEmptyUnclaimedDatabaseError();
  }
  return false; // blank — claim under exclusive
}

/**
 * Open the store DB with validation-before-mutation:
 * 1. Read-only path for already-owned current DBs (no exclusive).
 * 2. Blank DBs claim under BEGIN EXCLUSIVE (concurrent first-open safe).
 * 3. Runtime pragmas (incl. WAL) only after ownership is confirmed.
 * Rejected databases are closed without durable side effects.
 * Retry is limited to SQLite BUSY/LOCKED contention.
 */
export function openStoreDatabase(opts: OpenOptions): DatabaseSync {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  // Concurrent first-open may contend on BEGIN EXCLUSIVE. Reopen within a budget
  // only for real lock errors; permanent ownership/schema failures fail immediately.
  const retryDeadline = Date.now() + Math.max(1_000, busyTimeoutMs * 2);
  let attempt = 0;
  /** After a blank preflight, concurrent schema-without-markers may retry. */
  let sawBlankPreflight = false;
  /** Bounded retries for concurrent schema/marker visibility. */
  let concurrentStateRetries = 0;
  let fingerprintRetries = 0;
  const MAX_CONCURRENT_STATE_RETRIES = 3;
  const MAX_FINGERPRINT_RETRIES = 6;

  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(opts.path);
      // Connection-local only — does not mutate durable journal/application markers.
      applyConnectionBusyTimeout(db, busyTimeoutMs);
      const existing = tryOpenExistingCurrent(db, {
        allowConcurrentNonemptyRetry: sawBlankPreflight,
      });
      if (!existing) {
        sawBlankPreflight = true;
        // Fresh connection for exclusive claim so page cache cannot retain a
        // pre-peer-commit blank snapshot across BEGIN EXCLUSIVE.
        try {
          db.close();
        } catch {
          // continue with a new connection regardless
        }
        db = new DatabaseSync(opts.path);
        applyConnectionBusyTimeout(db, busyTimeoutMs);
        // SQLite ignores auto_vacuum changes inside BEGIN. The prior preflight
        // established this file was blank; configure it before any schema pages
        // or WAL exist. Concurrent first-open peers make the same idempotent
        // choice, then exclusiveOpenDecision revalidates ownership before DDL.
        db.exec('PRAGMA auto_vacuum = INCREMENTAL');
        exclusiveOpenDecision(db);
      }
      // Writer UDF must be registered before any guarded write on this connection.
      registerWriterVersionUdf(db);
      // WAL / foreign_keys / synchronous only after ownership is confirmed.
      applyRuntimePragmas(db, busyTimeoutMs);
      return db;
    } catch (error) {
      if (db) {
        try {
          db.close();
        } catch {
          // The original initialization error is the actionable failure.
        }
      }
      if (error instanceof ConcurrentOpenStateChanged) {
        if (
          concurrentStateRetries >= MAX_CONCURRENT_STATE_RETRIES ||
          Date.now() >= retryDeadline
        ) {
          // A real peer publishes markers quickly. A stable exact schema without
          // ownership markers is unclaimed and must not consume the full deadline.
          throw new NonEmptyUnclaimedDatabaseError();
        }
        concurrentStateRetries += 1;
        waitBeforeOpenRetry(attempt);
        attempt += 1;
        continue;
      }
      // Additive migration 5 -> 6: retry via exclusive migration instead of failing closed.
      if (
        error instanceof IncompatibleSchemaError &&
        error.observedVersion === 5 &&
        SQLITE_SCHEMA_VERSION === 6
      ) {
        let migDb: DatabaseSync | undefined;
        try {
          migDb = new DatabaseSync(opts.path);
          applyConnectionBusyTimeout(migDb, busyTimeoutMs);
          // exclusiveOpenDecision handles 5->6 migration under lock; reuse it directly.
          exclusiveOpenDecision(migDb);
          // Migration succeeded — reopen as current.
          waitBeforeOpenRetry(attempt);
          attempt += 1;
          continue;
        } catch (migError) {
          if (migError instanceof MusterSqliteError) throw migError;
          if (isRetryableOpenLock(migError) && Date.now() < retryDeadline) {
            waitBeforeOpenRetry(attempt);
            attempt += 1;
            continue;
          }
          throw mapToMusterSqliteError(migError, 'open');
        } finally {
          if (migDb) {
            try { migDb.close(); } catch {}
          }
        }
      }
      // Concurrent first-open can briefly fail fingerprint while a peer finishes
      // bootstrap/WAL. Cap retries so permanently incompatible current-marker
      // DBs still fail closed quickly.
      if (
        error instanceof IncompatibleSchemaError &&
        error.observedVersion === SQLITE_SCHEMA_VERSION &&
        fingerprintRetries < MAX_FINGERPRINT_RETRIES &&
        Date.now() < retryDeadline
      ) {
        fingerprintRetries += 1;
        waitBeforeOpenRetry(attempt);
        attempt += 1;
        continue;
      }
      // Ownership errors already carry the safe taxonomy; map physical open failures
      // (garbage/not-a-database/corrupt) without retrying permanent conditions.
      if (error instanceof MusterSqliteError) {
        throw error;
      }
      if (!isRetryableOpenLock(error) || Date.now() >= retryDeadline) {
        throw mapToMusterSqliteError(error, 'open');
      }
      waitBeforeOpenRetry(attempt);
      attempt += 1;
    }
  }
}
