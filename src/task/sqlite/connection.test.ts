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
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';

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
      expect((error as Error).message).toMatch(/Reset the Muster development database/);
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
