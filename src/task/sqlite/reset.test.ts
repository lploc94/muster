/**
 * P5-W5 in-place exclusive developer reset contract tests.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { DbClient, DbWorkerError } from './client';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';
import { safeMessageForCode } from './errors';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const clients: DbClient[] = [];
const holders: Worker[] = [];
const tempDirs: string[] = [];

function makeClient(opts: {
  faultCapability?: boolean;
  faultPlan?: {
    code: 'full' | 'readonly' | 'io' | 'busy' | 'corrupt' | 'not_a_database';
    operation: 'write' | 'unknown';
    remaining: number;
  };
} = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(opts.faultCapability ? { faultCapability: true } : {}),
    ...(opts.faultPlan ? { faultPlan: opts.faultPlan } : {}),
  });
  clients.push(client);
  return client;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-reset-'));
  tempDirs.push(dir);
  return dir;
}

async function seedFullGraph(client: DbClient, dbPath: string): Promise<void> {
  await client.open(dbPath);
  for (const ws of ['ws-a', 'ws-b'] as const) {
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      [ws, `key-${ws}`, ws, 'now', 'now'],
    );
    await client.run(
      `INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, ?)`,
      [ws, 5],
    );
    await client.run(
      `INSERT INTO tasks
       (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [`t-${ws}`, ws, 'worker', 'open', 'draft', 'goal', 'grok', 0, 'now', 'now', '{}'],
    );
    await client.run(
      `INSERT INTO turns
       (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      [`turn-${ws}`, ws, `t-${ws}`, 1, 'completed', 'user', 'now', '{}'],
    );
    await client.run(
      `INSERT INTO messages
       (id, workspace_id, task_id, turn_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [`m-${ws}`, ws, `t-${ws}`, `turn-${ws}`, 'user', 'final', `content-${ws}`, 'now', '{}'],
    );
    await client.run(
      `INSERT INTO send_outbox
       (workspace_id, client_request_id, status, payload_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      [ws, `out-${ws}`, 'pending', '{}', 'now', 'now'],
    );
    await client.run(
      `INSERT INTO presentations
       (workspace_id, presentation_id, owner_task_id, root_id, revision, title, markdown, payload_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [ws, `pres-${ws}`, `t-${ws}`, `t-${ws}`, 1, 'Title', '# md', '{}', 'now'],
    );
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(holders.splice(0).map((w) => w.terminate().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('P5-W5 developer reset', () => {
  it('removes multi-workspace graph including turns/presentations and leaves current empty schema', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient();
    await seedFullGraph(client, dbPath);

    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM turns`)).toEqual({ n: 2 });
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM presentations`)).toEqual({
      n: 2,
    });

    const meta = await client.reset();
    expect(meta.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);

    expect(await client.pragma('application_id')).toBe(MUSTER_APPLICATION_ID);
    expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workspaces`)).toEqual({
      n: 0,
    });
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks`)).toEqual({ n: 0 });
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM turns`)).toEqual({ n: 0 });
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)).toEqual({
      n: 0,
    });
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM presentations`)).toEqual({
      n: 0,
    });
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM send_outbox`)).toEqual({
      n: 0,
    });

    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      ['ws-new', 'key-new', 'New', 'now', 'now'],
    );
    await client.run(
      `INSERT INTO tasks
       (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['t-new', 'ws-new', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'],
    );
    expect(await client.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks`)).toEqual({ n: 1 });
    expect(fs.existsSync(dbPath)).toBe(true);
  }, 30_000);

  it('recovery reset rebuilds incompatible Muster-owned schema without normal open', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    // Create a Muster-owned file with wrong user_version (incomplete/incompatible).
    const seed = new DatabaseSync(dbPath);
    seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    seed.exec('PRAGMA user_version = 1');
    seed.exec('CREATE TABLE leftover (id TEXT PRIMARY KEY)');
    seed.prepare(`INSERT INTO leftover (id) VALUES ('x')`).run();
    seed.close();

    const normal = makeClient();
    await expect(normal.open(dbPath)).rejects.toBeInstanceOf(DbWorkerError);
    await normal.close().catch(() => undefined);

    const recovery = makeClient();
    const meta = await recovery.reset({ path: dbPath });
    expect(meta.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    await recovery.close();

    const check = makeClient();
    await check.open(dbPath);
    expect(await check.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
    expect(await check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workspaces`)).toEqual({
      n: 0,
    });
    await expect(
      check.get(`SELECT * FROM leftover`),
    ).rejects.toBeInstanceOf(DbWorkerError);
  }, 30_000);

  it('busy peer writer causes atomic failure with original state intact', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient();
    await seedFullGraph(client, dbPath);
    await client.close();

    const holder = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.dbPath);
      db.exec('PRAGMA busy_timeout = 50');
      db.exec('BEGIN EXCLUSIVE TRANSACTION');
      parentPort.postMessage({ kind: 'locked' });
      setTimeout(() => {
        try { db.exec('ROLLBACK'); db.close(); parentPort.postMessage({ kind: 'released' }); }
        catch (e) { parentPort.postMessage({ kind: 'error', message: String(e) }); }
      }, 3000);
      `,
      { eval: true, workerData: { dbPath } },
    );
    holders.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.on('message', (m: { kind: string }) => {
        if (m.kind === 'locked') resolve();
        if (m.kind === 'error') reject(new Error('holder failed'));
      });
    });

    const resetter = makeClient();
    await resetter.open(dbPath, 200);
    await expect(resetter.reset()).rejects.toBeInstanceOf(DbWorkerError);

    await resetter.close();
    const check = makeClient();
    await check.open(dbPath);
    expect(await check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workspaces`)).toEqual({
      n: 2,
    });
    expect(await check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM turns`)).toEqual({ n: 2 });
  }, 20_000);

  it('idle peer remains on same database identity after reset', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const a = makeClient();
    await seedFullGraph(a, dbPath);
    const b = makeClient();
    await b.open(dbPath);

    const meta = await a.reset();
    expect(meta.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);

    expect(await a.pragma('application_id')).toBe(MUSTER_APPLICATION_ID);
    expect(await b.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
    expect(await b.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workspaces`)).toEqual({ n: 0 });

    await expect(
      b.run(
        `INSERT INTO tasks
         (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ['stale', 'ws-a', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'],
      ),
    ).rejects.toBeInstanceOf(DbWorkerError);

    expect(fs.existsSync(dbPath)).toBe(true);
  }, 30_000);

  it('injected fail-before-commit rolls back and preserves full graph', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const setup = makeClient();
    await seedFullGraph(setup, dbPath);
    await setup.close();

    const client = makeClient({ faultCapability: true });
    await client.open(dbPath);
    await expect(client.reset({ failBeforeCommit: true })).rejects.toMatchObject({
      code: 'io',
    });
    await client.close();
    const check = makeClient();
    await check.open(dbPath);
    expect(await check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workspaces`)).toEqual({
      n: 2,
    });
    expect(await check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM turns`)).toEqual({ n: 2 });
    expect(await check.get<{ n: number }>(`SELECT COUNT(*) AS n FROM presentations`)).toEqual({
      n: 2,
    });
  }, 30_000);

  it('corrupt database fails closed before destructive DDL', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'corrupt.sqlite3');
    // Valid Muster markers then overwrite payload with garbage so open markers
    // may still parse while quick_check fails.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    seed.exec(`PRAGMA user_version = 1`);
    seed.exec('CREATE TABLE leftover (id TEXT PRIMARY KEY)');
    seed.prepare(`INSERT INTO leftover (id) VALUES ('x')`).run();
    seed.close();
    // Truncate mid-file to corrupt pages while keeping a SQLite header.
    const buf = fs.readFileSync(dbPath);
    fs.writeFileSync(dbPath, buf.subarray(0, Math.min(200, buf.length)));

    const before = fs.readFileSync(dbPath);
    const recovery = makeClient();
    await expect(recovery.reset({ path: dbPath })).rejects.toBeInstanceOf(DbWorkerError);
    await recovery.close().catch(() => undefined);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  }, 20_000);

  it('foreign database fails closed without mutation', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'foreign.sqlite3');
    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA application_id = 12345');
    seed.exec('CREATE TABLE alien (id INTEGER PRIMARY KEY)');
    seed.prepare('INSERT INTO alien (id) VALUES (1)').run();
    seed.close();

    const recovery = makeClient();
    await expect(recovery.reset({ path: dbPath })).rejects.toBeInstanceOf(DbWorkerError);
    await recovery.close().catch(() => undefined);

    const again = new DatabaseSync(dbPath);
    try {
      expect(
        Object.values(
          (again.prepare('PRAGMA application_id').get() as Record<string, number>) ?? {},
        )[0],
      ).toBe(12345);
      expect(
        (again.prepare('SELECT COUNT(*) AS n FROM alien').get() as { n: number }).n,
      ).toBe(1);
    } finally {
      again.close();
    }
  }, 20_000);

  it('errors never echo path or content', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient({ faultCapability: true });
    await seedFullGraph(client, dbPath);
    try {
      await client.reset({ failBeforeCommit: true });
      throw new Error('expected reject');
    } catch (error) {
      const err = error as DbWorkerError;
      expect(err.message).toBe(safeMessageForCode(err.code as 'io'));
      expect(JSON.stringify(err.detail)).not.toMatch(/muster\.sqlite3|content-ws|\/Users\//i);
    }
  }, 20_000);
});
