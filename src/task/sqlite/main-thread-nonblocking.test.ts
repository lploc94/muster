import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { DbClient } from './client';

/**
 * Phase 1 responsiveness gate.
 *
 * This deliberately uses TWO SQLite workers and a real write lock. The holder
 * starts `BEGIN IMMEDIATE`, writes a row and keeps the transaction open for just
 * over five seconds. The production DbClient then waits in its own worker's
 * busy_timeout while a timer on the test/extension-host thread must keep firing.
 */
const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const HOLD_MS = 5_100;

const clients: DbClient[] = [];
const holders: Worker[] = [];
const tempDirs: string[] = [];

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-lock-heartbeat-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

type HolderMessage = { kind: 'locked' | 'released' | 'error'; message?: string };

function waitForMessage(worker: Worker, kind: HolderMessage['kind']): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: HolderMessage) => {
      if (message.kind === 'error') {
        cleanup();
        reject(new Error(message.message ?? 'write-lock holder failed'));
        return;
      }
      if (message.kind !== kind) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`write-lock holder exited with code ${code}`));
      }
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function startWriteLockHolder(dbPath: string, holdMs: number): {
  worker: Worker;
  locked: Promise<void>;
  released: Promise<void>;
} {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      let db;
      try {
        db = new DatabaseSync(workerData.dbPath);
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('BEGIN IMMEDIATE TRANSACTION');
        db.prepare('INSERT INTO lock_probe (id) VALUES (?)').run('holder');
        parentPort.postMessage({ kind: 'locked' });
        setTimeout(() => {
          try {
            db.exec('COMMIT');
            db.close();
            parentPort.postMessage({ kind: 'released' });
          } catch (error) {
            parentPort.postMessage({ kind: 'error', message: String(error && error.message || error) });
          }
        }, workerData.holdMs);
      } catch (error) {
        try { db && db.close(); } catch {}
        parentPort.postMessage({ kind: 'error', message: String(error && error.message || error) });
      }
    `,
    { eval: true, workerData: { dbPath, holdMs } },
  );
  holders.push(worker);
  return {
    worker,
    locked: waitForMessage(worker, 'locked'),
    released: waitForMessage(worker, 'released'),
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(holders.splice(0).map((worker) => worker.terminate().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('main thread stays responsive during SQLite lock contention', () => {
  it('keeps heartbeat/UI work running while another worker holds a five-second write lock', async () => {
    const dbPath = tempDbPath();
    const contender = makeClient();
    await contender.open(dbPath, 7_000);
    await contender.run('CREATE TABLE lock_probe (id TEXT PRIMARY KEY)');

    const holder = startWriteLockHolder(dbPath, HOLD_MS);
    await holder.locked;

    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
    }, 25);
    const started = Date.now();
    try {
      const result = await contender.run('INSERT INTO lock_probe (id) VALUES (?)', ['contender']);
      const elapsed = Date.now() - started;

      expect(result.changes).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(7_000);
      expect(beats).toBeGreaterThan((elapsed / 25) * 0.5);
    } finally {
      clearInterval(timer);
    }

    await holder.released;
    await expect(contender.get<{ n: number }>('SELECT COUNT(*) AS n FROM lock_probe')).resolves.toEqual({ n: 2 });
  }, 15_000);
});
