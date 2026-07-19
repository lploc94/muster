import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ForeignDatabaseError,
  IncompatibleSchemaError,
  NonEmptyUnclaimedDatabaseError,
  openStoreDatabase,
} from './connection';
import { MusterSqliteError } from './errors';
import { diagnoseSqliteError } from './diagnostics';
import {
  MUSTER_APPLICATION_ID,
  REQUIRED_SCHEMA_TABLES,
  REQUIRED_SCHEMA_TRIGGERS,
  SQLITE_SCHEMA_VERSION,
} from './schema';
import { normalizeSchemaSql } from './schema-fingerprint';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-sqlite-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  return Object.values(row)[0] as number;
}

function journalMode(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  return row.journal_mode.toLowerCase();
}

function reopenReadonly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

describe('openStoreDatabase', () => {
  it('creates the file, stamps application_id, and initializes the current schema', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(scalar(db, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(db, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(journalMode(db)).toBe('wal');
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('workspaces');
      expect(tables).toContain('tasks');
      expect(tables).toContain('turns');
      expect(tables).toContain('messages');
      expect(tables).toContain('tool_calls');
      expect(tables).toContain('reasoning_segments');
      expect(tables).toContain('change_log');
      expect(tables).toContain('change_feed_watermarks');
      expect(tables).toContain('send_outbox');
      expect(tables).toContain('presentations');
      expect(tables).not.toContain('migration_state');
      expect(tables).toContain('turn_inputs');
      expect(tables).toContain('session_claims');
      expect(tables).toContain('resource_claims');
      expect(tables).toContain('turn_cancel_requests');
    } finally {
      db.close();
    }
  });

  it('applies WAL journal mode only after claiming a blank database', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      expect(journalMode(db)).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('reopening a current store is a no-op', () => {
    const dbPath = tempDbPath();
    const first = openStoreDatabase({ path: dbPath });
    first.close();
    const second = openStoreDatabase({ path: dbPath });
    try {
      expect(scalar(second, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(scalar(second, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(journalMode(second)).toBe('wal');
    } finally {
      second.close();
    }
  });

  it('rejects foreign application_id without mutating journal mode or markers', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec('PRAGMA application_id = 12345');
      seed.exec('CREATE TABLE foreign_table (id INTEGER PRIMARY KEY)');
      seed.close();
    }

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(ForeignDatabaseError);

    const after = reopenReadonly(dbPath);
    try {
      expect(scalar(after, 'application_id')).toBe(12345);
      expect(scalar(after, 'user_version')).toBe(0);
      expect(journalMode(after)).toBe('delete');
      const tables = after
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(['foreign_table']);
    } finally {
      after.close();
    }
  });

  it('rejects unclaimed incompatible user_version without stamping application_id or WAL', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec('PRAGMA user_version = 1');
      seed.close();
    }

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);

    const after = reopenReadonly(dbPath);
    try {
      expect(scalar(after, 'application_id')).toBe(0);
      expect(scalar(after, 'user_version')).toBe(1);
      expect(journalMode(after)).toBe('delete');
    } finally {
      after.close();
    }
  });

  it('rejects unclaimed non-empty version-0 DB without stamping or WAL', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec('CREATE TABLE leftover (id INTEGER PRIMARY KEY)');
      seed.close();
    }

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(NonEmptyUnclaimedDatabaseError);

    const after = reopenReadonly(dbPath);
    try {
      expect(scalar(after, 'application_id')).toBe(0);
      expect(scalar(after, 'user_version')).toBe(0);
      expect(journalMode(after)).toBe('delete');
      const tables = after
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(['leftover']);
    } finally {
      after.close();
    }
  });

  it('rejects existing Muster DB with wrong schema version without migration', () => {
    const dbPath = tempDbPath();
    {
      const seed = openStoreDatabase({ path: dbPath });
      seed.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
      rewrite.close();
    }

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);

    const after = reopenReadonly(dbPath);
    try {
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(after, 'user_version')).toBe(SQLITE_SCHEMA_VERSION + 1);
      expect(journalMode(after)).toBe('wal');
    } finally {
      after.close();
    }
  });

  it('rejects incomplete owned Muster DB (application_id set, user_version=0) without mutation or retry', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
      seed.exec('PRAGMA user_version = 0');
      seed.close();
    }

    const started = Date.now();
    expect(() => openStoreDatabase({ path: dbPath, busyTimeoutMs: 5_000 })).toThrow(
      IncompatibleSchemaError,
    );
    // Permanent ownership failure must not burn the busy-timeout retry budget.
    expect(Date.now() - started).toBeLessThan(1_000);

    try {
      openStoreDatabase({ path: dbPath, busyTimeoutMs: 5_000 });
      expect.unreachable('openStoreDatabase should have rejected incomplete owned DB');
    } catch (error) {
      expect(error).toBeInstanceOf(IncompatibleSchemaError);
      expect((error as Error).message).toMatch(/incompatible or incomplete/i);
    }

    const after = reopenReadonly(dbPath);
    try {
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(after, 'user_version')).toBe(0);
      expect(journalMode(after)).toBe('delete');
      const tables = after
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual([]);
    } finally {
      after.close();
    }
  });

  it('rejects garbage/not-a-database files without creating a Muster store', () => {
    const dbPath = tempDbPath();
    const original = Buffer.from('this is not a sqlite database at all');
    fs.writeFileSync(dbPath, original);

    try {
      openStoreDatabase({ path: dbPath });
      expect.unreachable('garbage file must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(MusterSqliteError);
      expect((error as MusterSqliteError).code).toBe('not_a_database');
      expect((error as MusterSqliteError).operation).toBe('open');
      expect(JSON.stringify(error)).not.toMatch(/\/Users\/|SELECT|INSERT/i);
    }

    const after = fs.readFileSync(dbPath);
    expect(Buffer.compare(after, original)).toBe(0);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('rejects truncated/corrupt owned Muster DB without rename/reset/bootstrap', () => {
    const dbPath = tempDbPath();
    {
      const seed = openStoreDatabase({ path: dbPath });
      seed.close();
    }
    // Truncate mid-file so the header may still look SQLite-ish but pages are broken.
    const original = fs.readFileSync(dbPath);
    const truncated = original.subarray(0, Math.min(200, Math.floor(original.length / 4)));
    fs.writeFileSync(dbPath, truncated);

    try {
      openStoreDatabase({ path: dbPath });
      expect.unreachable('truncated owned DB must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(MusterSqliteError);
      const code = (error as MusterSqliteError).code;
      expect(['corrupt', 'not_a_database']).toContain(code);
      const diagnostic = diagnoseSqliteError(error, 'open');
      expect(diagnostic.failClosed).toBe(true);
      expect(diagnostic.recoveryAction).toBe('reveal_storage');
      expect(diagnostic.message).not.toMatch(/\/Users\/|SELECT|INSERT/i);
    }

    const after = fs.readFileSync(dbPath);
    expect(Buffer.compare(after, truncated)).toBe(0);
    expect(after.length).toBe(truncated.length);
  });

  it('rejects owned current markers with missing schema before WAL', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
      seed.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      // Zero Muster tables — markers alone must not open.
      seed.close();
    }
    const before = fs.readFileSync(dbPath);

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);

    const after = reopenReadonly(dbPath);
    try {
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(after, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(journalMode(after)).toBe('delete');
    } finally {
      after.close();
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects owned current DB with correct object names but wrong columns before WAL', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
      seed.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      // All required names, but every table is a stub (x INTEGER) — not current schema.
      for (const name of REQUIRED_SCHEMA_TABLES) {
        seed.exec(`CREATE TABLE ${name} (x INTEGER)`);
      }
      seed.exec(
        `CREATE TRIGGER ${REQUIRED_SCHEMA_TRIGGERS[0]} BEFORE INSERT ON send_outbox BEGIN SELECT 1; END`,
      );
      seed.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    const after = reopenReadonly(dbPath);
    try {
      expect(journalMode(after)).toBe('delete');
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      const cols = after.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual(['x']);
    } finally {
      after.close();
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects exact column names with all-BLOB types, wrong PK, no FK, dummy indexes/triggers before WAL', async () => {
    // Verified residual: name-only fingerprint previously opened this as WAL.
    const { expectedSchemaManifest } = await import('./schema-fingerprint');
    const expected = expectedSchemaManifest();
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
      seed.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      for (const table of expected.tables) {
        const colDefs = table.columns
          .map((col, i) => `${col.name} BLOB${i === 0 ? ' PRIMARY KEY' : ''}`)
          .join(', ');
        seed.exec(`CREATE TABLE ${table.name} (${colDefs})`);
      }
      // Same-name indexes all pointing at workspaces(id)
      for (const indexName of [
        'idx_change_log_workspace_revision',
        'idx_tasks_workspace_parent',
        'idx_tasks_workspace_lifecycle',
        'idx_turns_task_sequence',
        'idx_turns_workspace_status',
        'idx_messages_task_created',
        'idx_messages_turn',
        'idx_runtime_claims_expiry',
        'idx_send_outbox_workspace_status',
        'idx_reasoning_turn_order',
        'idx_tool_calls_turn_order',
        'idx_turn_inputs_turn_order',
        'idx_session_claims_turn',
        'idx_resource_claims_turn',
        'idx_turn_cancel_requests_task',
        'idx_presentations_workspace_owner',
        'idx_presentation_operations_document',
      ]) {
        seed.exec(`CREATE INDEX ${indexName} ON workspaces(id)`);
      }
      seed.exec(
        `CREATE TRIGGER ${REQUIRED_SCHEMA_TRIGGERS[0]} BEFORE INSERT ON send_outbox BEGIN SELECT 1; END`,
      );
      seed.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    const after = reopenReadonly(dbPath);
    try {
      expect(journalMode(after)).toBe('delete');
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(after, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      after.close();
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects same-name index with wrong target columns and dummy trigger before WAL', () => {
    const dbPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: dbPath });
      good.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      rewrite.exec('DROP INDEX idx_tasks_workspace_parent');
      rewrite.exec('CREATE INDEX idx_tasks_workspace_parent ON workspaces(id)');
      rewrite.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    {
      const after = reopenReadonly(dbPath);
      try {
        expect(journalMode(after)).toBe('delete');
      } finally {
        after.close();
      }
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);

    const triggerPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: triggerPath });
      good.close();
      const rewrite = new DatabaseSync(triggerPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      rewrite.exec('DROP TRIGGER trg_send_outbox_capacity');
      rewrite.exec(
        `CREATE TRIGGER trg_send_outbox_capacity BEFORE INSERT ON send_outbox BEGIN SELECT 1; END`,
      );
      rewrite.close();
    }
    const beforeTrig = fs.readFileSync(triggerPath);
    expect(() => openStoreDatabase({ path: triggerPath })).toThrow(IncompatibleSchemaError);
    expect(Buffer.compare(fs.readFileSync(triggerPath), beforeTrig)).toBe(0);
  });

  it('rejects trigger literal whitespace change while preserving bytes and DELETE journal', () => {
    expect(normalizeSchemaSql("RAISE(ABORT, 'send outbox capacity reached')")).not.toBe(
      normalizeSchemaSql("RAISE(ABORT, 'send  outbox capacity reached')"),
    );
    expect(normalizeSchemaSql("SELECT 'IF NOT EXISTS' AS x")).toContain("'IF NOT EXISTS'");
    expect(normalizeSchemaSql("SELECT 'a''b' AS x")).toContain("'a''b'");

    const dbPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: dbPath });
      good.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      rewrite.exec('DROP TRIGGER trg_send_outbox_capacity');
      rewrite.exec(
        `CREATE TRIGGER trg_send_outbox_capacity
           BEFORE INSERT ON send_outbox
           WHEN NOT EXISTS (
                  SELECT 1 FROM send_outbox
                   WHERE workspace_id = NEW.workspace_id
                     AND client_request_id = NEW.client_request_id
                )
            AND (SELECT COUNT(*) FROM send_outbox WHERE workspace_id = NEW.workspace_id) >= 32
           BEGIN
             SELECT RAISE(ABORT, 'send  outbox capacity reached');
           END`,
      );
      rewrite.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    const after = reopenReadonly(dbPath);
    try {
      expect(journalMode(after)).toBe('delete');
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(after, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      after.close();
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects CHECK literal case change while preserving bytes and DELETE journal', () => {
    const dbPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: dbPath });
      good.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      // Recreate tasks with uppercase CHECK literals ('DRAFT' vs 'draft').
      rewrite.exec('PRAGMA foreign_keys = OFF');
      rewrite.exec('ALTER TABLE tasks RENAME TO tasks_old');
      rewrite.exec(`CREATE TABLE tasks (
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id TEXT,
        role TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        release_state TEXT NOT NULL CHECK (release_state IN ('DRAFT', 'RELEASED')),
        goal TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, parent_id)
          REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
      )`);
      rewrite.exec('INSERT INTO tasks SELECT * FROM tasks_old');
      rewrite.exec('DROP TABLE tasks_old');
      rewrite.close();
    }
    // Malformed CHECK rejects normal lowercase insert.
    {
      const probe = new DatabaseSync(dbPath);
      probe.exec('PRAGMA foreign_keys = ON');
      probe
        .prepare(
          `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
           VALUES (?,?,?,?,?)`,
        )
        .run('ws-check', 'k-check', 'WS', 'now', 'now');
      expect(() =>
        probe
          .prepare(
            `INSERT INTO tasks
             (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run('t1', 'ws-check', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'),
      ).toThrow(/CHECK/i);
      probe.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    const after = reopenReadonly(dbPath);
    try {
      expect(journalMode(after)).toBe('delete');
      expect(scalar(after, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(after, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      after.close();
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects same-name index with COLLATE NOCASE DESC independently', () => {
    const dbPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: dbPath });
      good.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      rewrite.exec('DROP INDEX idx_tasks_workspace_parent');
      rewrite.exec(
        'CREATE INDEX idx_tasks_workspace_parent ON tasks(workspace_id COLLATE NOCASE, parent_id DESC)',
      );
      rewrite.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    {
      const after = reopenReadonly(dbPath);
      try {
        expect(journalMode(after)).toBe('delete');
      } finally {
        after.close();
      }
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects unexpected extra table and view before WAL', () => {
    const dbPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: dbPath });
      good.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      rewrite.exec('CREATE TABLE unexpected_extra (id TEXT PRIMARY KEY)');
      rewrite.exec('CREATE VIEW unexpected_view AS SELECT id FROM workspaces');
      rewrite.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    {
      const after = reopenReadonly(dbPath);
      try {
        expect(journalMode(after)).toBe('delete');
      } finally {
        after.close();
      }
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects combined CHECK case + COLLATE index + extra table (round-3 residual repro)', () => {
    const dbPath = tempDbPath();
    {
      const good = openStoreDatabase({ path: dbPath });
      good.close();
      const rewrite = new DatabaseSync(dbPath);
      rewrite.exec('PRAGMA journal_mode = DELETE');
      rewrite.exec('DROP INDEX idx_tasks_workspace_parent');
      rewrite.exec(
        'CREATE INDEX idx_tasks_workspace_parent ON tasks(workspace_id COLLATE NOCASE, parent_id DESC)',
      );
      rewrite.exec('CREATE TABLE unexpected_extra (id TEXT PRIMARY KEY)');
      rewrite.close();
    }
    const before = fs.readFileSync(dbPath);
    // Must NOT open as WAL.
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    const after = reopenReadonly(dbPath);
    try {
      expect(journalMode(after)).toBe('delete');
    } finally {
      after.close();
    }
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);
  });

  it('rejects removed/altered FK and removed CHECK before WAL', () => {
    const dbPath = tempDbPath();
    {
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
      seed.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      // Minimal workspaces + tasks without FK/CHECK.
      seed.exec(`CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      )`);
      seed.exec(`CREATE TABLE tasks (
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        release_state TEXT NOT NULL,
        goal TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )`);
      for (const name of REQUIRED_SCHEMA_TABLES) {
        if (name === 'workspaces' || name === 'tasks') continue;
        seed.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`);
      }
      seed.close();
    }
    const before = fs.readFileSync(dbPath);
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    expect(Buffer.compare(fs.readFileSync(dbPath), before)).toBe(0);

    // Valid fresh DB still reopens.
    const valid = openStoreDatabase({ path: tempDbPath() });
    try {
      expect(journalMode(valid)).toBe('wal');
      expect(scalar(valid, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      valid.close();
    }
  });

  it('maps foreign/incompatible/nonempty diagnostics distinctly without empty-store continuation', () => {
    const foreignPath = tempDbPath();
    {
      const seed = new DatabaseSync(foreignPath);
      seed.exec('PRAGMA application_id = 999');
      seed.exec('CREATE TABLE foreign_table (id INTEGER PRIMARY KEY)');
      seed.close();
    }
    try {
      openStoreDatabase({ path: foreignPath });
      expect.unreachable();
    } catch (error) {
      const d = diagnoseSqliteError(error, 'open');
      expect(d.code).toBe('foreign_database');
      expect(d.failClosed).toBe(true);
    }

    const incompatiblePath = tempDbPath();
    {
      const seed = openStoreDatabase({ path: incompatiblePath });
      seed.close();
      const rewrite = new DatabaseSync(incompatiblePath);
      rewrite.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 2}`);
      rewrite.close();
    }
    try {
      openStoreDatabase({ path: incompatiblePath });
      expect.unreachable();
    } catch (error) {
      const d = diagnoseSqliteError(error, 'open');
      expect(d.code).toBe('incompatible_schema');
      expect(d.recoveryAction).toBe('reveal_storage');
    }

    // Valid reopen still works on a fresh path (no global empty fallback).
    const valid = openStoreDatabase({ path: tempDbPath() });
    try {
      expect(scalar(valid, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(valid, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      valid.close();
    }
  });

  it('converges concurrent first-open claims on one valid schema', async () => {
    const dbPath = tempDbPath();
    const { DbClient } = await import('./client');
    const workerPath = path.join(__dirname, 'worker.ts');
    const contenders = Array.from({ length: 4 }, () =>
      new DbClient({ workerPath, execArgv: ['--import', 'tsx'] }),
    );
    try {
      await Promise.all(contenders.map((client) => client.open(dbPath, 10_000)));
      await Promise.all(
        contenders.map(async (client) => {
          expect(await client.pragma('application_id')).toBe(MUSTER_APPLICATION_ID);
          expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
          await expect(
            client.get<{ journal_mode: string }>('PRAGMA journal_mode'),
          ).resolves.toEqual({ journal_mode: 'wal' });
          await expect(
            client.get<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
            ),
          ).resolves.toEqual({ name: 'workspaces' });
        }),
      );
    } finally {
      await Promise.all(contenders.map((client) => client.close()));
    }
  }, 30_000);

  it('converges concurrent first-open under stress (30 rounds × 8 workers)', async () => {
    const { DbClient } = await import('./client');
    const workerPath = path.join(__dirname, 'worker.ts');
    for (let round = 0; round < 30; round++) {
      const dbPath = tempDbPath();
      const contenders = Array.from({ length: 8 }, () =>
        new DbClient({ workerPath, execArgv: ['--import', 'tsx'] }),
      );
      try {
        await Promise.all(contenders.map((client) => client.open(dbPath, 15_000)));
        for (const client of contenders) {
          expect(await client.pragma('application_id')).toBe(MUSTER_APPLICATION_ID);
          expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
          await expect(
            client.get<{ journal_mode: string }>('PRAGMA journal_mode'),
          ).resolves.toEqual({ journal_mode: 'wal' });
        }
      } finally {
        await Promise.all(contenders.map((client) => client.close().catch(() => undefined)));
      }
    }
  }, 180_000);

  it('still rejects genuine pre-created nonempty-unclaimed immediately', () => {
    const dbPath = tempDbPath();
    {
      const foreign = new DatabaseSync(dbPath);
      foreign.exec('CREATE TABLE alien (id INTEGER PRIMARY KEY)');
      foreign.close();
    }
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(NonEmptyUnclaimedDatabaseError);
  });

  it('rejects tasks that do not match the current release-state contract', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      db.prepare(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
      ).run('ws-current', 'current-contract', 'Current', 'now', 'now');
      const insert = db.prepare(
        `INSERT INTO tasks
         (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      expect(() => insert.run(
        'missing-release', 'ws-current', 'worker', 'open', null, 'g', 'grok', 0, 'now', 'now', '{}',
      )).toThrow(/NOT NULL/);
      expect(() => insert.run(
        'invalid-release', 'ws-current', 'worker', 'open', 'legacy', 'g', 'grok', 0, 'now', 'now', '{}',
      )).toThrow(/CHECK constraint/);
    } finally {
      db.close();
    }
  });
});

describe('foreign_keys enforcement', () => {
  it('rejects a child row whose workspace FK is missing', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks
             (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run('t1', 'ghost-ws', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('cascades task delete to its turns', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      db.prepare(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
      ).run('ws1', 'key1', 'WS', 'now', 'now');
      db.prepare(
        `INSERT INTO tasks
         (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run('t1', 'ws1', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}');
      db.prepare(
        `INSERT INTO turns
         (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run('turn1', 'ws1', 't1', 0, 'queued', 'user', 'now', '{}');

      db.prepare('DELETE FROM tasks WHERE workspace_id=? AND id=?').run('ws1', 't1');
      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM turns WHERE workspace_id=?')
        .get('ws1') as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('composite identity', () => {
  it('allows the same task id under two different workspaces', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      for (const ws of ['ws1', 'ws2']) {
        db.prepare(
          `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
           VALUES (?,?,?,?,?)`,
        ).run(ws, `key-${ws}`, ws, 'now', 'now');
        db.prepare(
          `INSERT INTO tasks
           (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run('shared-id', ws, 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}');
      }
      const rows = db.prepare('SELECT workspace_id FROM tasks WHERE id=?').all('shared-id');
      expect(rows).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
