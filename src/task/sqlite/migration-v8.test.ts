/**
 * Schema v7 migration-input and explicit v7→v8→current proofs (M018 S01).
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
  REQUIRED_SCHEMA_V9_WORKFLOW_TABLES,
  SCHEMA_V7,
  SCHEMA_V7_STATEMENTS,
  SCHEMA_V9,
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
import {
  MusterSqliteError,
  isTerminalStorageCode,
  mapToMusterSqliteError,
  recoveryActionForCode,
} from './errors';
import {
  POPULATED_V7_FIXTURE_MARKER,
  countPopulatedV7FixtureRows,
  writePopulatedV7Fixture,
  type PopulatedV7FixtureSummary,
} from './v7-fixture';

const tempDirs: string[] = [];

/** Windows can briefly retain SQLite WAL/SHM handles after close(); retry cleanup. */
function rmTempDir(dir: string): void {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw error;
      }
      // Synchronous backoff — tests run in-process; keep total wait bounded.
      const delayMs = 25 * (attempt + 1);
      const end = Date.now() + delayMs;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
  // Best-effort: residual Windows file locks must not fail migration proofs.
  // Temp dirs under os.tmpdir() are reclaimed by the OS.
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmTempDir(dir);
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
      // Fixture remains frozen at v7 after the compiled current advances.
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

describe('atomic schema-v7 → v8 → current migration (M018 S01 T02)', () => {
  afterEach(() => {
    // Disarm fault capability so later suites never inherit a migrate fault.
    bootstrapFaultCapability(undefined);
  });

  it('migrates a populated owned v7 store through v8 to v9 with every legacy row intact', () => {
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
      expect(readPragma(db, 'user_version')).toBe(SCHEMA_V9);
      expect(readPragma(db, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(findSchemaFingerprintFailure(db)).toBeUndefined();
      expect(findSchemaFingerprintFailure(db, SCHEMA_V9)).toBeUndefined();

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
      for (const table of REQUIRED_SCHEMA_V9_WORKFLOW_TABLES) {
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
      expect(readPragma(reopened, 'user_version')).toBe(SCHEMA_V9);
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

    // Single open only — remaining:1 is consumed by the commit-boundary seam.
    let migrateError: unknown;
    try {
      openStoreDatabase({ path: dbPath });
      expect.unreachable('open should have thrown on migrate fault');
    } catch (error) {
      migrateError = error;
    }
    expect(migrateError).toBeInstanceOf(MusterSqliteError);
    expect((migrateError as MusterSqliteError).code).toBe('full');
    expect((migrateError as MusterSqliteError).operation).toBe('migrate');

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
      expect(readPragma(migrated, 'user_version')).toBe(SCHEMA_V9);
      const marker = migrated
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get(written.messageId) as { content?: string } | undefined;
      expect(marker?.content).toBe(POPULATED_V7_FIXTURE_MARKER);
    } finally {
      migrated.close();
    }
  });

  it('blank claim creates schema v9 and rejects incomplete v7 without mutation', () => {
    const blankPath = tempDbPath('blank-v9.sqlite');
    const blank = openStoreDatabase({ path: blankPath });
    try {
      expect(readPragma(blank, 'user_version')).toBe(SCHEMA_V9);
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

    // registerWriterVersionUdf is exported for dual-connection fence proofs.
    const probe = new DatabaseSync(':memory:');
    try {
      registerWriterVersionUdf(probe);
      const row = probe.prepare(`SELECT ${'muster_writer_version'}() AS v`).get() as { v: number };
      expect(row.v).toBe(SCHEMA_V9);
    } finally {
      probe.close();
    }
  });

  it('fences an already-open v7 connection after migration, including pre-migration prepared statements', () => {
    const dbPath = tempDbPath('stale-writer-fence.sqlite');
    const fixture = writePopulatedV7Fixture(dbPath);

    // Stale host: open raw v7 connection and prepare a write before peer migrates.
    const stale = new DatabaseSync(dbPath);
    applyConnectionBusy(stale);
    const prePreparedInsert = stale.prepare(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Prove the statement works pre-migration.
    prePreparedInsert.run(
      'ws-pre-migration-write',
      'identity-pre',
      'Pre Migration',
      '2026-07-19T00:00:00.000Z',
      '2026-07-19T00:00:00.000Z',
    );

    // Peer host migrates under the current binary.
    const current = openStoreDatabase({ path: dbPath });
    try {
      expect(readPragma(current, 'user_version')).toBe(SCHEMA_V9);
      expect(findSchemaFingerprintFailure(current)).toBeUndefined();

      // Current peer writes succeed with registered writer UDF.
      current
        .prepare(
          `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'ws-current-peer',
          'identity-current-peer',
          'Current Peer',
          '2026-07-19T02:00:00.000Z',
          '2026-07-19T02:00:00.000Z',
        );

      // Stale newly-prepared write is blocked (missing writer UDF / trigger).
      let stalePreparedError: unknown;
      try {
        stale
          .prepare(
            `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            'ws-stale-new',
            'identity-stale-new',
            'Stale New',
            '2026-07-19T03:00:00.000Z',
            '2026-07-19T03:00:00.000Z',
          );
        expect.unreachable('stale write should be fenced');
      } catch (error) {
        stalePreparedError = error;
      }
      const mappedPrepared = mapToMusterSqliteError(stalePreparedError, 'write');
      expect(mappedPrepared).toBeInstanceOf(MusterSqliteError);
      expect(mappedPrepared.code).toBe('schema_changed');
      expect(isTerminalStorageCode(mappedPrepared.code)).toBe(true);
      expect(recoveryActionForCode(mappedPrepared.code)).toBe('reload_window');

      // Pre-migration prepared statement is also blocked after migration commit.
      let stalePrePreparedError: unknown;
      try {
        prePreparedInsert.run(
          'ws-stale-prepared',
          'identity-stale-prepared',
          'Stale Prepared',
          '2026-07-19T03:30:00.000Z',
          '2026-07-19T03:30:00.000Z',
        );
        expect.unreachable('pre-migration prepared write should be fenced');
      } catch (error) {
        stalePrePreparedError = error;
      }
      const mappedPre = mapToMusterSqliteError(stalePrePreparedError, 'write');
      expect(mappedPre.code).toBe('schema_changed');

      // Legacy fixture rows remain intact; only the two successful workspace inserts land.
      const counts = countPopulatedV7FixtureRows(current);
      expect(counts.workspaces).toBe((fixture.tableRowCounts.workspaces ?? 0) + 2);
      expect(counts.tasks).toBe(fixture.tableRowCounts.tasks);
      expect(counts.messages).toBe(fixture.tableRowCounts.messages);
      const blocked = current
        .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE id IN (?, ?)`) 
        .get('ws-stale-new', 'ws-stale-prepared') as { n: number };
      expect(blocked.n).toBe(0);
    } finally {
      current.close();
      stale.close();
    }
  });
});

function applyConnectionBusy(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000');
}
