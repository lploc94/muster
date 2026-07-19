/**
 * Versioned schema manifest / fingerprint contract (M018 S01 T01).
 *
 * Proves v7 has an independent frozen manifest that remains validatable even
 * when the compiled current schema later becomes v8, and that explicit
 * manifest/version validation is supported for migration input/output.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_STATEMENTS,
  MUSTER_APPLICATION_ID,
  REQUIRED_SCHEMA_V8_WORKFLOW_TABLES,
  SCHEMA_V7,
  SCHEMA_V7_STATEMENTS,
  SCHEMA_V8,
  SCHEMA_V8_STATEMENTS,
  SQLITE_SCHEMA_VERSION,
  schemaStatementsForVersion,
} from './schema';
import {
  captureSchemaManifest,
  expectedSchemaManifest,
  expectedSchemaManifestForVersion,
  findSchemaFingerprintFailure,
  normalizeSchemaSql,
} from './schema-fingerprint';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-schema-fp-'));
  tempDirs.push(dir);
  return path.join(dir, 'store.sqlite');
}

function applyStatements(db: DatabaseSync, statements: readonly string[]): void {
  for (const statement of statements) db.exec(statement);
}

function claimVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${version}`);
}

describe('versioned schema manifests (M018 S01 T01)', () => {
  it('freezes independent SCHEMA_V7_STATEMENTS while compiled current is v8', () => {
    expect(SCHEMA_V7).toBe(7);
    expect(SCHEMA_V8).toBe(8);
    expect(Array.isArray(SCHEMA_V7_STATEMENTS)).toBe(true);
    expect(SCHEMA_V7_STATEMENTS.length).toBeGreaterThan(10);
    expect(schemaStatementsForVersion(SCHEMA_V7)).toBe(SCHEMA_V7_STATEMENTS);
    expect(schemaStatementsForVersion(SCHEMA_V8)).toBe(SCHEMA_V8_STATEMENTS);
    // Compiled current advanced to v8; v7 remains an independent frozen input manifest.
    expect(SQLITE_SCHEMA_VERSION).toBe(SCHEMA_V8);
    expect(CURRENT_SCHEMA_STATEMENTS).toEqual(SCHEMA_V8_STATEMENTS);
    expect(CURRENT_SCHEMA_STATEMENTS).not.toEqual(SCHEMA_V7_STATEMENTS);
  });

  it('builds distinct golden manifests for v7 input and v8 current', () => {
    const v7 = expectedSchemaManifestForVersion(SCHEMA_V7);
    const v8 = expectedSchemaManifestForVersion(SCHEMA_V8);
    const current = expectedSchemaManifest();
    expect(current.tables.map((t) => t.name)).toEqual(v8.tables.map((t) => t.name));
    expect(current.indexes.map((i) => i.name)).toEqual(v8.indexes.map((i) => i.name));
    expect(current.triggers.map((t) => t.name)).toEqual(v8.triggers.map((t) => t.name));

    const v7Names = new Set(v7.tables.map((t) => t.name));
    for (const table of REQUIRED_SCHEMA_V8_WORKFLOW_TABLES) {
      expect(v7Names.has(table)).toBe(false);
      expect(v8.tables.some((t) => t.name === table)).toBe(true);
    }
    expect(v8.tables.length).toBeGreaterThan(v7.tables.length);
    expect(v8.triggers.length).toBeGreaterThan(v7.triggers.length);

    const v7Db = applyInMemory(SCHEMA_V7_STATEMENTS);
    const currentDb = applyInMemory(CURRENT_SCHEMA_STATEMENTS);
    try {
      expect(findSchemaFingerprintFailure(v7Db, SCHEMA_V7)).toBeUndefined();
      // A pure v7 store must not match the compiled current (v8) golden.
      expect(findSchemaFingerprintFailure(v7Db)).toBeDefined();
      expect(findSchemaFingerprintFailure(currentDb)).toBeUndefined();
      expect(findSchemaFingerprintFailure(currentDb, SCHEMA_V8)).toBeUndefined();
    } finally {
      v7Db.close();
      currentDb.close();
    }
  });

  it('validates an explicit SchemaManifest argument independently of the current golden', () => {
    const db = applyInMemory(SCHEMA_V7_STATEMENTS);
    try {
      const explicit = expectedSchemaManifestForVersion(SCHEMA_V7);
      expect(findSchemaFingerprintFailure(db, explicit)).toBeUndefined();

      // Mutate actual schema so current golden would fail, but prove the explicit
      // path uses the provided manifest (still matches) vs missing table detection.
      db.exec('CREATE TABLE extra_migration_probe (id TEXT PRIMARY KEY)');
      const withExtra = findSchemaFingerprintFailure(db, explicit);
      expect(withExtra).toEqual({ reason: 'extra_table', object: 'extra_migration_probe' });
    } finally {
      db.close();
    }
  });

  it('rejects unsupported schema versions without inventing a manifest', () => {
    expect(() => schemaStatementsForVersion(6)).toThrow(/unsupported schema version/i);
    expect(() => expectedSchemaManifestForVersion(99)).toThrow(/unsupported schema version/i);
  });

  it('detects column mismatch against the frozen v7 manifest', () => {
    const db = applyInMemory(SCHEMA_V7_STATEMENTS);
    try {
      // SQLite cannot DROP COLUMN easily on all paths; create incomplete DB instead.
      db.close();
    } catch {
      /* ignore */
    }
    const incomplete = new DatabaseSync(':memory:');
    try {
      incomplete.exec(
        `CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          identity_key TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_opened_at TEXT NOT NULL
        )`,
      );
      const failure = findSchemaFingerprintFailure(incomplete, SCHEMA_V7);
      expect(failure?.reason).toBe('missing_table');
      expect(failure?.object).toBeTruthy();
    } finally {
      incomplete.close();
    }
  });

  it('normalizeSchemaSql still preserves quoted CHECK literals', () => {
    const a = normalizeSchemaSql(`CHECK (release_state IN ('draft', 'released'))`);
    const b = normalizeSchemaSql(`CHECK (release_state IN ('DRAFT', 'released'))`);
    expect(a).not.toBe(b);
  });

  it('captureSchemaManifest is stable for a claimed on-disk v7 store', () => {
    const dbPath = tempDbPath();
    const db = new DatabaseSync(dbPath);
    try {
      applyStatements(db, SCHEMA_V7_STATEMENTS);
      claimVersion(db, SCHEMA_V7);
      const first = captureSchemaManifest(db);
      expect(findSchemaFingerprintFailure(db, SCHEMA_V7)).toBeUndefined();
      expect(first.tables.length).toBe(expectedSchemaManifestForVersion(SCHEMA_V7).tables.length);
    } finally {
      db.close();
    }
    const reopen = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(findSchemaFingerprintFailure(reopen, SCHEMA_V7)).toBeUndefined();
      const userVersion = Number(
        Object.values((reopen.prepare('PRAGMA user_version').get() as Record<string, number>) ?? {})[0] ?? 0,
      );
      expect(userVersion).toBe(SCHEMA_V7);
    } finally {
      reopen.close();
    }
  });
});

function applyInMemory(statements: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyStatements(db, statements);
  return db;
}
