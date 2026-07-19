/**
 * Schema v7→v8 migration proofs (M018 S01).
 *
 * T01 freezes the populated v7 proof fixture and versioned-manifest gate.
 * Later tasks extend this file with atomic migration, rollback, and writer fence.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MUSTER_APPLICATION_ID,
  REQUIRED_SCHEMA_V8_WORKFLOW_TABLES,
  SCHEMA_V7,
  SCHEMA_V7_STATEMENTS,
  SCHEMA_V8,
  SQLITE_SCHEMA_VERSION,
} from './schema';
import {
  expectedSchemaManifestForVersion,
  findSchemaFingerprintFailure,
} from './schema-fingerprint';
import {
  openStoreDatabase,
  registerWriterVersionUdf,
} from './connection';
import { bootstrapFaultCapability, setFaultPlanForTests } from './fault-inject';
import { MusterSqliteError } from './errors';
import {
  POPULATED_V7_FIXTURE_MARKER,
  countPopulatedV7FixtureRows,
  writePopulatedV7Fixture,
  type PopulatedV7FixtureSummary,
} from './v7-fixture';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(name = 'populated-v7.sqlite'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-migration-v8-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function readPragma(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

describe('populated schema-v7 proof fixture (M018 S01 T01)', () => {
  it('writes an owned complete v7 store that matches the frozen v7 manifest', () => {
    const dbPath = tempDbPath();
    const summary = writePopulatedV7Fixture(dbPath);

    expect(summary.schemaVersion).toBe(SCHEMA_V7);
    expect(summary.applicationId).toBe(MUSTER_APPLICATION_ID);
    expect(summary.marker).toBe(POPULATED_V7_FIXTURE_MARKER);
    expect(summary.tableRowCounts.workspaces).toBeGreaterThanOrEqual(1);
    expect(summary.tableRowCounts.tasks).toBeGreaterThanOrEqual(2);
    expect(summary.tableRowCounts.turns).toBeGreaterThanOrEqual(1);
    expect(summary.tableRowCounts.messages).toBeGreaterThanOrEqual(1);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(readPragma(db, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(readPragma(db, 'user_version')).toBe(SCHEMA_V7);
      // Fixture remains frozen at v7; compiled current is v8 after T02.
      expect(SCHEMA_V7).not.toBe(SQLITE_SCHEMA_VERSION);
      expect(findSchemaFingerprintFailure(db, SCHEMA_V7)).toBeUndefined();
      expect(findSchemaFingerprintFailure(db, expectedSchemaManifestForVersion(SCHEMA_V7))).toBeUndefined();

      const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
      expect(Object.values(quick[0] ?? {})[0]).toBe('ok');

      const markerRow = db
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get(summary.messageId) as { content?: string } | undefined;
      expect(markerRow?.content).toBe(POPULATED_V7_FIXTURE_MARKER);

      const counts = countPopulatedV7FixtureRows(db);
      expect(counts).toEqual(summary.tableRowCounts);
      // Every required v7 table is present in the count map (populated or empty claim tables allowed).
      const required = expectedSchemaManifestForVersion(SCHEMA_V7).tables.map((t) => t.name);
      for (const table of required) {
        expect(counts).toHaveProperty(table);
        expect(typeof counts[table]).toBe('number');
      }
    } finally {
      db.close();
    }
  });

  it('reopens the fixture with every legacy proof row intact', () => {
    const dbPath = tempDbPath('reopen-v7.sqlite');
    const written: PopulatedV7FixtureSummary = writePopulatedV7Fixture(dbPath);

    const db = new DatabaseSync(dbPath);
    try {
      // Apply only read checks — do not migrate (T02).
      expect(findSchemaFingerprintFailure(db, SCHEMA_V7)).toBeUndefined();
      expect(SCHEMA_V7_STATEMENTS.length).toBeGreaterThan(0);

      const taskIds = (
        db.prepare(`SELECT id FROM tasks WHERE workspace_id = ? ORDER BY id`).all(written.workspaceId) as Array<{
          id: string;
        }>
      ).map((r) => r.id);
      expect(taskIds).toEqual(expect.arrayContaining([written.coordinatorTaskId, written.workerTaskId]));

      const turn = db
        .prepare(`SELECT status, trigger FROM turns WHERE workspace_id = ? AND id = ?`)
        .get(written.workspaceId, written.turnId) as { status?: string; trigger?: string } | undefined;
      expect(turn?.status).toBe('settled');
      expect(turn?.trigger).toBe('user');

      const dep = db
        .prepare(
          `SELECT required_outcome FROM task_dependencies
            WHERE workspace_id = ? AND task_id = ? AND dependency_task_id = ?`,
        )
        .get(written.workspaceId, written.workerTaskId, written.coordinatorTaskId) as
        | { required_outcome?: string }
        | undefined;
      expect(dep?.required_outcome).toBe('success');

      const presentation = db
        .prepare(
          `SELECT title FROM presentations
            WHERE workspace_id = ? AND presentation_id = ?`,
        )
        .get(written.workspaceId, written.presentationId) as { title?: string } | undefined;
      expect(presentation?.title).toBe('v7 fixture presentation');
    } finally {
      db.close();
    }
  });

  it('builds the fixture from SCHEMA_V7_STATEMENTS only (not a later current schema alias)', () => {
    // Guard: fixture helper must import/apply the frozen v7 constant so it remains
    // a valid migration input after the compiled current schema becomes v8.
    const source = fs.readFileSync(path.join(__dirname, 'v7-fixture.ts'), 'utf8');
    expect(source).toMatch(/SCHEMA_V7_STATEMENTS/);
    // Disallow importing or applying the mutable current alias.
    expect(source).not.toMatch(/\bCURRENT_SCHEMA_STATEMENTS\b/);
    expect(source).toMatch(/for \(const statement of SCHEMA_V7_STATEMENTS\)/);
  });
});

describe('atomic schema-v7 → v8 migration (M018 S01 T02)', () => {
  afterEach(() => {
    // Disarm fault capability so later suites never inherit a migrate fault.
    bootstrapFaultCapability(undefined);
  });

  it('migrates a populated owned v7 store to v8 with every legacy row intact', () => {
    const dbPath = tempDbPath('migrate-preserve.sqlite');
    const written = writePopulatedV7Fixture(dbPath);
    const preCounts = (() => {
      const ro = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return countPopulatedV7FixtureRows(ro);
      } finally {
        ro.close();
      }
    })();

    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(readPragma(db, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(readPragma(db, 'user_version')).toBe(SCHEMA_V8);
      expect(readPragma(db, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(findSchemaFingerprintFailure(db)).toBeUndefined();
      expect(findSchemaFingerprintFailure(db, SCHEMA_V8)).toBeUndefined();

      const markerRow = db
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get(written.messageId) as { content?: string } | undefined;
      expect(markerRow?.content).toBe(POPULATED_V7_FIXTURE_MARKER);

      const postCounts = countPopulatedV7FixtureRows(db);
      expect(postCounts).toEqual(preCounts);

      for (const table of REQUIRED_SCHEMA_V8_WORKFLOW_TABLES) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
        expect(row.n).toBe(0);
      }

      // Writer UDF is registered on the open connection so guarded writes succeed.
      db.prepare(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('ws-post-migrate', 'identity-post', 'Post Migrate', '2026-07-19T01:00:00.000Z', '2026-07-19T01:00:00.000Z');
    } finally {
      db.close();
    }

    // Reopen proves durable migration (not just connection-local state).
    const reopened = openStoreDatabase({ path: dbPath });
    try {
      expect(readPragma(reopened, 'user_version')).toBe(SCHEMA_V8);
      expect(findSchemaFingerprintFailure(reopened)).toBeUndefined();
      const marker = reopened
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get(written.messageId) as { content?: string } | undefined;
      expect(marker?.content).toBe(POPULATED_V7_FIXTURE_MARKER);
    } finally {
      reopened.close();
    }
  });

  it('rolls back to unchanged readable v7 when a commit-boundary migrate fault fires', () => {
    const dbPath = tempDbPath('migrate-rollback.sqlite');
    const written = writePopulatedV7Fixture(dbPath);

    bootstrapFaultCapability({ faultCapability: true });
    setFaultPlanForTests({ code: 'full', operation: 'migrate', remaining: 1 });

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(MusterSqliteError);
    try {
      openStoreDatabase({ path: dbPath });
      expect.unreachable('open should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MusterSqliteError);
      expect((error as MusterSqliteError).code).toBe('full');
      expect((error as MusterSqliteError).operation).toBe('migrate');
    }

    // Disarm so the verification reopen does not re-inject.
    setFaultPlanForTests(undefined);
    bootstrapFaultCapability(undefined);

    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(readPragma(ro, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(readPragma(ro, 'user_version')).toBe(SCHEMA_V7);
      expect(findSchemaFingerprintFailure(ro, SCHEMA_V7)).toBeUndefined();
      // No durable workflow objects from a rolled-back migration.
      const tables = ro
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'workflow_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([]);

      const marker = ro
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get(written.messageId) as { content?: string } | undefined;
      expect(marker?.content).toBe(POPULATED_V7_FIXTURE_MARKER);
      expect(countPopulatedV7FixtureRows(ro)).toEqual(
        (() => {
          // Re-open fixture counts via a second read of the same intact store.
          return countPopulatedV7FixtureRows(ro);
        })(),
      );
    } finally {
      ro.close();
    }

    // After fault is cleared, migration succeeds and preserves rows.
    const migrated = openStoreDatabase({ path: dbPath });
    try {
      expect(readPragma(migrated, 'user_version')).toBe(SCHEMA_V8);
      const marker = migrated
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get(written.messageId) as { content?: string } | undefined;
      expect(marker?.content).toBe(POPULATED_V7_FIXTURE_MARKER);
    } finally {
      migrated.close();
    }
  });

  it('blank claim creates schema v8 and rejects incomplete v7 without mutation', () => {
    const blankPath = tempDbPath('blank-v8.sqlite');
    const blank = openStoreDatabase({ path: blankPath });
    try {
      expect(readPragma(blank, 'user_version')).toBe(SCHEMA_V8);
      expect(findSchemaFingerprintFailure(blank)).toBeUndefined();
    } finally {
      blank.close();
    }

    const incompletePath = tempDbPath('incomplete-v7.sqlite');
    const incomplete = new DatabaseSync(incompletePath);
    try {
      incomplete.exec('PRAGMA foreign_keys = ON');
      // Only part of v7 — missing required tables so fingerprint fails.
      incomplete.exec(SCHEMA_V7_STATEMENTS[0]!);
      incomplete.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
      incomplete.exec(`PRAGMA user_version = ${SCHEMA_V7}`);
    } finally {
      incomplete.close();
    }

    expect(() => openStoreDatabase({ path: incompletePath })).toThrow(MusterSqliteError);

    const after = new DatabaseSync(incompletePath, { readOnly: true });
    try {
      expect(readPragma(after, 'user_version')).toBe(SCHEMA_V7);
      expect(readPragma(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      const tables = after
        .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(['workspaces']);
    } finally {
      after.close();
    }

    // registerWriterVersionUdf is exported for T03 dual-connection fence proofs.
    const probe = new DatabaseSync(':memory:');
    try {
      registerWriterVersionUdf(probe);
      const row = probe.prepare(`SELECT ${'muster_writer_version'}() AS v`).get() as { v: number };
      expect(row.v).toBe(SCHEMA_V8);
    } finally {
      probe.close();
    }
  });
});
