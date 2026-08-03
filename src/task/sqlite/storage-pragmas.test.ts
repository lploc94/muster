import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStoreDatabase } from './connection';
import { DbClient } from './client';
import { CURRENT_SCHEMA_STATEMENTS, MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const tempDirs: string[] = [];
const clients: DbClient[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-storage-pragmas-'));
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

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('storage lifecycle pragmas', () => {
  it('claims a blank store as incremental before WAL and bounds its residual WAL', () => {
    const db = openStoreDatabase({ path: tempDbPath() });
    try {
      expect(scalar(db, 'auto_vacuum')).toBe(2);
      expect(scalar(db, 'journal_size_limit')).toBe(JOURNAL_SIZE_LIMIT_BYTES);
    } finally {
      db.close();
    }
  });

  it('preserves a legacy NONE store while applying the connection WAL limit', () => {
    const dbPath = tempDbPath();
    seedLegacyNoneStore(dbPath);
    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(scalar(db, 'auto_vacuum')).toBe(0);
      expect(scalar(db, 'journal_size_limit')).toBe(JOURNAL_SIZE_LIMIT_BYTES);
    } finally {
      db.close();
    }
  });

  it('exposes measured auto-vacuum and journal-size-limit values through the safe pragma RPC', async () => {
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(tempDbPath());

    expect(await client.pragma('auto_vacuum')).toBe(2);
    expect(await client.pragma('journal_size_limit')).toBe(JOURNAL_SIZE_LIMIT_BYTES);
  }, 20_000);
});
