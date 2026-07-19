/**
 * In-place exclusive developer reset of a Muster-owned SQLite database (P5-W5).
 *
 * Runs inside the DB worker only. Never unlinks main/WAL/SHM. Foreign/corrupt
 * databases fail closed without mutation. Incompatible Muster-owned schemas are
 * accepted and rebuilt to the current empty schema.
 */
import { DatabaseSync } from 'node:sqlite';
import { findSchemaFingerprintFailure } from './schema-fingerprint';
import {
  CURRENT_SCHEMA_STATEMENTS,
  MUSTER_APPLICATION_ID,
  SQLITE_SCHEMA_VERSION,
} from './schema';
import { MusterInvariantError, MusterSqliteError, mapToMusterSqliteError } from './errors';
import { maybeInjectFault } from './fault-inject';

export type ResetResultMeta = {
  schemaVersion: number;
};

function readScalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

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
 * Read-only ownership probe before any reset mutation.
 * Accepts blank or Muster-owned readable DBs (any user_version / incomplete schema).
 * Rejects foreign and non-empty unclaimed files.
 */
function assertResettableOwnership(db: DatabaseSync): void {
  const applicationId = readScalar(db, 'application_id');
  const userVersion = readScalar(db, 'user_version');
  if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
    throw new MusterSqliteError('foreign_database', 'write');
  }
  if (applicationId === 0 && userVersion === 0 && hasUserSchemaObjects(db)) {
    throw new MusterSqliteError('nonempty_unclaimed', 'write');
  }
  if (applicationId === 0 && userVersion !== 0) {
    // Unclaimed with version markers — not a Muster DB we claim via reset.
    throw new MusterSqliteError('nonempty_unclaimed', 'write');
  }
}

/** Read-only consistency gate before any destructive DDL. */
function assertReadableConsistent(db: DatabaseSync): void {
  try {
    const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
    const ok =
      Array.isArray(quick) &&
      quick.length === 1 &&
      Object.values(quick[0] ?? {})[0] === 'ok';
    if (!ok) {
      throw new MusterSqliteError('corrupt', 'write');
    }
  } catch (error) {
    if (error instanceof MusterSqliteError) throw error;
    throw mapToMusterSqliteError(error, 'write');
  }
}

function dropAllUserObjects(db: DatabaseSync): void {
  const objects = db
    .prepare(
      `SELECT type, name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'view', 'trigger', 'index')
       ORDER BY
         CASE type
           WHEN 'trigger' THEN 0
           WHEN 'index' THEN 1
           WHEN 'view' THEN 2
           WHEN 'table' THEN 3
           ELSE 4
         END,
         name`,
    )
    .all() as Array<{ type: string; name: string }>;

  for (const obj of objects) {
    const name = obj.name.replace(/"/g, '""');
    if (obj.type === 'table') {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    } else if (obj.type === 'view') {
      db.exec(`DROP VIEW IF EXISTS "${name}"`);
    } else if (obj.type === 'trigger') {
      db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    } else if (obj.type === 'index') {
      db.exec(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}

function bootstrapCurrentSchema(db: DatabaseSync): void {
  for (const statement of CURRENT_SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
}

/** Exported for worker post-commit reopen verification. */
export function verifyResetCommittedConnection(db: DatabaseSync): void {
  assertResettableOwnership(db);
  assertReadableConsistent(db);
  verifyResetResult(db);
}

function verifyResetResult(db: DatabaseSync): void {
  if (readScalar(db, 'application_id') !== MUSTER_APPLICATION_ID) {
    throw new MusterSqliteError('foreign_database', 'write');
  }
  if (readScalar(db, 'user_version') !== SQLITE_SCHEMA_VERSION) {
    throw new MusterSqliteError('incompatible_schema', 'write');
  }
  // Rebuild always targets the compiled current schema (v8+).
  const fingerprint = findSchemaFingerprintFailure(db, SQLITE_SCHEMA_VERSION);
  if (fingerprint) {
    throw new MusterSqliteError('incompatible_schema', 'write');
  }
  const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
  const ok =
    Array.isArray(quick) &&
    quick.length === 1 &&
    Object.values(quick[0] ?? {})[0] === 'ok';
  if (!ok) {
    throw new MusterSqliteError('corrupt', 'write');
  }
  const ws = db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).get() as { n: number };
  if ((ws?.n ?? 0) !== 0) {
    throw new MusterInvariantError('invariant', 'write');
  }
}

export type ResetOptions = {
  /** Test-only: throw before COMMIT after rebuild. */
  failBeforeCommit?: boolean;
};

/**
 * Exclusive in-place reset of an already-open connection.
 * FK enforcement is disabled *before* BEGIN EXCLUSIVE (SQLite ignores
 * foreign_keys changes inside a transaction).
 */
export function resetOpenDatabase(
  db: DatabaseSync,
  options: ResetOptions = {},
): ResetResultMeta {
  assertResettableOwnership(db);
  // Fail closed on physical corruption *before* any drop/DDL mutation.
  assertReadableConsistent(db);

  // Must run outside any transaction — SQLite ignores in-txn foreign_keys changes.
  db.exec('PRAGMA foreign_keys = OFF');
  let committed = false;
  try {
    db.exec('BEGIN EXCLUSIVE TRANSACTION');
    try {
      assertResettableOwnership(db);
      dropAllUserObjects(db);
      bootstrapCurrentSchema(db);
      verifyResetResult(db);
      maybeInjectFault('write');
      if (options.failBeforeCommit) {
        throw new MusterSqliteError('io', 'write');
      }
      db.exec('COMMIT');
      committed = true;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // original error is the signal
      }
      throw error;
    }
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    } catch {
      // best-effort post-commit pragmas
    }
    // Re-verify the committed connection state before reporting success.
    assertResettableOwnership(db);
    assertReadableConsistent(db);
    verifyResetResult(db);
    return { schemaVersion: SQLITE_SCHEMA_VERSION };
  } catch (error) {
    try {
      db.exec('PRAGMA foreign_keys = ON');
    } catch {
      // best-effort
    }
    throw mapToMusterSqliteError(error, 'write');
  } finally {
    if (!committed) {
      try {
        db.exec('PRAGMA foreign_keys = ON');
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Open a database path for reset without current-schema bootstrap validation.
 * Rejects foreign / non-empty-unclaimed / physical corrupt files.
 * Accepts blank and any Muster-owned file (including incompatible user_version).
 */
export function openDatabaseForReset(filePath: string, busyTimeoutMs = 5000): DatabaseSync {
  if (!filePath || filePath === ':memory:') {
    throw new MusterInvariantError('invariant', 'write');
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(filePath);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    assertResettableOwnership(db);
    assertReadableConsistent(db);
    return db;
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // original error
      }
    }
    throw mapToMusterSqliteError(error, 'write');
  }
}

/**
 * Full reset path used by the worker `reset` RPC: open for reset → exclusive rebuild.
 * Closes the connection when `closeAfter` is true (standalone recovery open).
 */
export function resetDatabaseAtPath(
  filePath: string,
  options: ResetOptions & { busyTimeoutMs?: number; existingDb?: DatabaseSync } = {},
): ResetResultMeta {
  if (options.existingDb) {
    return resetOpenDatabase(options.existingDb, options);
  }
  const db = openDatabaseForReset(filePath, options.busyTimeoutMs);
  let result: ResetResultMeta;
  try {
    result = resetOpenDatabase(db, options);
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
  // Reopen committed file independently before reporting success.
  const verify = openDatabaseForReset(filePath, options.busyTimeoutMs);
  try {
    assertReadableConsistent(verify);
    verifyResetResult(verify);
  } finally {
    try {
      verify.close();
    } catch {
      // best-effort
    }
  }
  return result;
}
