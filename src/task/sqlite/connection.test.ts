import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPragmas,
  ForeignDatabaseError,
  IncompatibleSchemaError,
  initializeCurrentSchema,
  openStoreDatabase,
  verifyOrStampApplicationId,
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

describe('openStoreDatabase', () => {
  it('creates the file, stamps application_id, and initializes the current schema', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(scalar(db, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(db, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      // All v1 tables exist.
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
      expect(tables).not.toContain('migration_state');
      expect(tables).toContain('turn_inputs');
      expect(tables).toContain('session_claims');
      expect(tables).toContain('resource_claims');
      expect(tables).toContain('turn_cancel_requests');
    } finally {
      db.close();
    }
  });

  it('applies WAL journal mode', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe('wal');
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
    } finally {
      second.close();
    }
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
      // A task referencing a non-existent workspace must be rejected by the FK.
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

describe('verifyOrStampApplicationId', () => {
  it('refuses a foreign non-zero application_id', () => {
    const db = new DatabaseSync(tempDbPath());
    try {
      db.exec('PRAGMA application_id = 12345');
      expect(() => verifyOrStampApplicationId(db)).toThrow(ForeignDatabaseError);
    } finally {
      db.close();
    }
  });
});

describe('initializeCurrentSchema', () => {
  it('refuses an older schema instead of migrating its data', () => {
    const db = new DatabaseSync(tempDbPath());
    try {
      applyPragmas(db, 5000);
      verifyOrStampApplicationId(db);
      db.exec('PRAGMA user_version = 1');
      expect(() => initializeCurrentSchema(db)).toThrow(IncompatibleSchemaError);
      expect(scalar(db, 'user_version')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('refuses a schema newer than current', () => {
    const db = new DatabaseSync(tempDbPath());
    try {
      applyPragmas(db, 5000);
      db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
      expect(() => initializeCurrentSchema(db)).toThrow(IncompatibleSchemaError);
    } finally {
      db.close();
    }
  });

  it('initializes a fresh database atomically', () => {
    const db = new DatabaseSync(tempDbPath());
    try {
      applyPragmas(db, 5000);
      expect(scalar(db, 'user_version')).toBe(0);
      initializeCurrentSchema(db);
      expect(scalar(db, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
