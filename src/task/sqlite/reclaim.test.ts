import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStoreDatabase } from './connection';
import { CURRENT_SCHEMA_STATEMENTS, MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';
import { MusterSqliteError } from './errors';
import {
  INCREMENTAL_VACUUM_BATCH_PAGES,
  MAX_INCREMENTAL_VACUUM_BATCHES,
  reclaimOpenDatabase,
} from './reclaim';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-reclaim-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

function scalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  return Number(Object.values(row)[0]);
}

function seedLegacyNoneStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
  } finally {
    db.close();
  }
}

function seedAndFreePages(db: DatabaseSync, count = 48, bytesEach = 32 * 1024): void {
  db.exec('CREATE TABLE reclaim_fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO reclaim_fixture (payload) VALUES (?)');
  const payload = 'x'.repeat(bytesEach);
  for (let index = 0; index < count; index += 1) insert.run(payload);
  db.exec('DELETE FROM reclaim_fixture');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('worker-local SQLite page reclamation', () => {
  it('incrementally reclaims freed pages in bounded batches without creating a copy', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    try {
      seedAndFreePages(db);
      const freelistBefore = scalar(db, 'freelist_count');
      expect(scalar(db, 'auto_vacuum')).toBe(2);
      expect(freelistBefore).toBeGreaterThan(0);

      const result = reclaimOpenDatabase(db, dbPath);

      expect(result.mode).toBe('incremental');
      expect(result.fileBytesBefore).toBeGreaterThan(0);
      expect(result.fileBytesAfter).toBeLessThan(result.fileBytesBefore);
      expect(result.freelistCountAfter).toBeLessThan(freelistBefore);
      expect(result.batchesRun).toBeGreaterThan(0);
      expect(result.batchesRun).toBeLessThanOrEqual(16);
      expect(result.walCheckpoints).toBeGreaterThan(0);
      expect(result.residualWalBytes).toBeGreaterThanOrEqual(0);
      expect(fs.readdirSync(path.dirname(dbPath)).sort()).toEqual([
        'muster.sqlite3',
        'muster.sqlite3-shm',
        'muster.sqlite3-wal',
      ]);
    } finally {
      db.close();
    }
  });

  it('caps one incremental run at the configured number of page batches', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    try {
      // 600 × 32 KiB produces more than the 16 × 256-page invocation limit.
      seedAndFreePages(db, 600);
      const result = reclaimOpenDatabase(db, dbPath);

      expect(result.mode).toBe('incremental');
      expect(result.batchesRun).toBe(MAX_INCREMENTAL_VACUUM_BATCHES);
      expect(INCREMENTAL_VACUUM_BATCH_PAGES).toBe(256);
      expect(result.freelistCountAfter).toBeGreaterThan(0);
      expect(result.walCheckpoints).toBe(1 + (MAX_INCREMENTAL_VACUUM_BATCHES * 2));
    } finally {
      db.close();
    }
  }, 30_000);

  it('bubbles a blocked WAL checkpoint as a safe busy write error', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath, busyTimeoutMs: 25 });
    const reader = new DatabaseSync(dbPath);
    try {
      seedAndFreePages(db);
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM reclaim_fixture').get();

      expect(() => reclaimOpenDatabase(db, dbPath)).toThrow(
        expect.objectContaining({
          name: MusterSqliteError.name,
          code: 'busy',
          operation: 'write',
        }),
      );
    } finally {
      try {
        reader.exec('ROLLBACK');
      } finally {
        reader.close();
        db.close();
      }
    }
  });

  it('refuses legacy NONE full compaction before VACUUM when twice the file size is unavailable', () => {
    const dbPath = tempDbPath();
    seedLegacyNoneStore(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      seedAndFreePages(db);
      const freelistBefore = scalar(db, 'freelist_count');
      const fileBytesBefore = fs.statSync(dbPath).size;
      expect(scalar(db, 'auto_vacuum')).toBe(0);
      expect(freelistBefore).toBeGreaterThan(0);

      const result = reclaimOpenDatabase(db, dbPath, { availableBytes: 0 });

      expect(result.mode).toBe('refused');
      expect(result.requiredBytes).toBe(result.fileBytesBefore * 2);
      expect(result.availableBytes).toBe(0);
      expect(result.fileBytesAfter).toBe(result.fileBytesBefore);
      expect(result.freelistCountAfter).toBe(freelistBefore);
      expect(result.batchesRun).toBe(0);
      expect(result.walCheckpoints).toBe(1);
      expect(fs.statSync(dbPath).size).toBeGreaterThanOrEqual(fileBytesBefore);
    } finally {
      db.close();
    }
  });

  it('fully compacts a legacy NONE store once the preflight has enough free space', () => {
    const dbPath = tempDbPath();
    seedLegacyNoneStore(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      seedAndFreePages(db);
      const result = reclaimOpenDatabase(db, dbPath, { availableBytes: Number.MAX_SAFE_INTEGER });

      expect(result.mode).toBe('full');
      expect(result.fileBytesAfter).toBeLessThan(result.fileBytesBefore);
      expect(result.freelistCountAfter).toBeLessThan(result.freelistCountBefore);
      expect(result.batchesRun).toBe(1);
      expect(result.walCheckpoints).toBe(2);
      expect(result.requiredBytes).toBe(result.fileBytesBefore * 2);
      expect(result.availableBytes).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      db.close();
    }
  });

  it('reports a checkpointed WAL baseline even when there are no free pages', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    try {
      // Create committed WAL content without freeing database pages. The pass is
      // still a page-reclaim noop, but the caller must see that checkpointing
      // reclaimed the WAL rather than receive a misleading zero baseline.
      db.exec('CREATE TABLE wal_only_fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      db.prepare('INSERT INTO wal_only_fixture (payload) VALUES (?)').run('x'.repeat(128 * 1024));
      const walBefore = fs.statSync(`${dbPath}-wal`).size;
      expect(walBefore).toBeGreaterThan(0);

      const result = reclaimOpenDatabase(db, dbPath);

      expect(result.mode).toBe('noop');
      expect(result.batchesRun).toBe(0);
      expect(result.walCheckpoints).toBe(1);
      expect(result.freelistCountBefore).toBe(0);
      expect(result.walBytesBefore).toBe(walBefore);
      expect(result.residualWalBytes).toBeLessThan(result.walBytesBefore);
      expect(result.freelistCountAfter).toBe(0);
    } finally {
      db.close();
    }
  });
});
