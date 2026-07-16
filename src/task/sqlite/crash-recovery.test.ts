import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { DbClient } from './client';
import { SQLITE_SCHEMA_VERSION } from './schema';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const clients: DbClient[] = [];
const workers: Worker[] = [];
const tempDirs: string[] = [];

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

function tempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

function startUncommittedWriter(dbPath: string): { worker: Worker; written: Promise<void> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      try {
        const db = new DatabaseSync(workerData.dbPath);
        db.exec('BEGIN IMMEDIATE TRANSACTION');
        db.prepare('INSERT INTO crash_probe (id, value) VALUES (?, ?)').run('uncommitted', 'must rollback');
        parentPort.postMessage({ kind: 'written' });
        setInterval(() => {}, 60_000);
      } catch (error) {
        parentPort.postMessage({ kind: 'error', message: String(error && error.message || error) });
      }
    `,
    { eval: true, workerData: { dbPath } },
  );
  workers.push(worker);
  const written = new Promise<void>((resolve, reject) => {
    const onMessage = (message: { kind: string; message?: string }) => {
      if (message.kind === 'written') {
        cleanup();
        resolve();
      } else if (message.kind === 'error') {
        cleanup();
        reject(new Error(message.message ?? 'uncommitted writer failed'));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
  return { worker, written };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(workers.splice(0).map((worker) => worker.terminate().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLite worker/process crash recovery', () => {
  it('rolls back an uncommitted WAL transaction when its worker is terminated', async () => {
    const dbPath = tempDbPath('muster-crash-recovery-');
    const setup = makeClient();
    await setup.open(dbPath);
    await setup.run('CREATE TABLE crash_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await setup.close();

    const crash = startUncommittedWriter(dbPath);
    await crash.written;
    await crash.worker.terminate();

    const reopened = makeClient();
    await reopened.open(dbPath);
    await expect(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM crash_probe')).resolves.toEqual({ n: 0 });
    await expect(reopened.get<{ integrity_check: string }>('PRAGMA integrity_check')).resolves.toEqual({ integrity_check: 'ok' });
    await expect(reopened.get<{ journal_mode: string }>('PRAGMA journal_mode')).resolves.toEqual({ journal_mode: 'wal' });
    expect(await reopened.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
  }, 20_000);

  it('serializes concurrent first-open schema migration across DB workers', async () => {
    const dbPath = tempDbPath('muster-concurrent-migrate-');
    const contenders = Array.from({ length: 4 }, () => makeClient());

    await Promise.all(contenders.map((client) => client.open(dbPath, 10_000)));
    await Promise.all(
      contenders.map(async (client) => {
        expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
        expect(await client.pragma('foreign_keys')).toBe(1);
        await expect(
          client.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'"),
        ).resolves.toEqual({ name: 'workspaces' });
      }),
    );
  }, 30_000);
});
