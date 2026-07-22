import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbClient, DbWorkerError, resolveWorkerPath } from './client';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';

const WORKER_TS = path.join(__dirname, 'worker.ts');
// Under vitest/tsx the worker .ts must be loaded through the tsx ESM loader.
const TSX_ARGV = ['--import', 'tsx'];

const clients: DbClient[] = [];
const tempDirs: string[] = [];

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-dbclient-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('DbClient <-> worker RPC', () => {
  it('opens a DB and round-trips a run/get', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
    expect(await client.pragma('application_id')).toBe(MUSTER_APPLICATION_ID);

    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      ['ws1', 'key1', 'WS One', 'now', 'now'],
    );
    const row = await client.get<{ display_name: string }>(
      'SELECT display_name FROM workspaces WHERE id = ?',
      ['ws1'],
    );
    expect(row?.display_name).toBe('WS One');
  }, 20_000);

  it('commits a transactional batch atomically', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    await client.transaction([
      {
        sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
              VALUES (?,?,?,?,?)`,
        params: ['ws1', 'key1', 'WS', 'now', 'now'],
      },
      {
        sql: `INSERT INTO tasks
              (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        params: ['t1', 'ws1', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'],
      },
    ]);
    const rows = await client.all('SELECT id FROM tasks WHERE workspace_id = ?', ['ws1']);
    expect(rows).toHaveLength(1);
  }, 20_000);

  it('rolls back and skips dependent statements when a conditional first write is unchanged', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    const results = await client.transaction([
      {
        sql: 'UPDATE workspaces SET display_name = ? WHERE id = ?',
        params: ['never', 'missing'],
      },
      {
        sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
              VALUES (?,?,?,?,?)`,
        params: ['must-not-exist', 'key', 'Skipped', 'now', 'now'],
      },
    ], { abortIfFirstUnchanged: true });
    expect(results).toEqual([expect.objectContaining({ changes: 0 })]);
    await expect(client.get('SELECT id FROM workspaces WHERE id = ?', ['must-not-exist'])).resolves.toBeUndefined();
  }, 20_000);

  it('rolls back the whole batch when one statement fails', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    await expect(
      client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws1', 'key1', 'WS', 'now', 'now'],
        },
        // Second statement violates the FK (ghost workspace) → whole batch rolls back.
        {
          sql: `INSERT INTO tasks
                (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: ['t1', 'ghost', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'],
        },
      ]),
    ).rejects.toBeInstanceOf(DbWorkerError);

    // The first insert must NOT survive — the transaction was atomic.
    const rows = await client.all('SELECT id FROM workspaces');
    expect(rows).toHaveLength(0);
  }, 20_000);

  it('surfaces a structured error without leaking SQL params', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    try {
      await client.run('SELECT * FROM nonexistent_table');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DbWorkerError);
      const detail = (error as DbWorkerError).detail;
      // P5-W1: raw SQLite messages never cross the wire; fixed taxonomy only.
      expect(detail.code).toBe('unknown');
      expect(detail.name).toBe('MusterSqliteError');
      expect(detail.operation).toBe('write');
      expect(detail.message).toBe('Muster SQLite storage is temporarily unavailable.');
      expect(JSON.stringify(detail)).not.toMatch(/nonexistent_table|SELECT|FROM/i);
    }
  }, 20_000);

  it('injects a transaction fault at commit boundary and rolls back atomically', async () => {
    // Explicit capability only — ambient env must not arm production clients.
    process.env.MUSTER_SQLITE_FAULT_INJECT = '1';
    process.env.MUSTER_SQLITE_FAULT_CODE = 'full';
    try {
      const ambient = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
      clients.push(ambient);
      await ambient.open(tempDbPath());
      await ambient.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-ambient', 'key-a', 'WS', 'now', 'now'],
        },
      ]);
      expect(await ambient.all('SELECT id FROM workspaces')).toHaveLength(1);

      const faultClient = new DbClient({
        workerPath: WORKER_TS,
        execArgv: TSX_ARGV,
        faultCapability: true,
        faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
      });
      clients.push(faultClient);
      await faultClient.open(tempDbPath());
      await expect(
        faultClient.transaction([
          {
            sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                  VALUES (?,?,?,?,?)`,
            params: ['ws-fault', 'key-fault', 'WS', 'now', 'now'],
          },
        ]),
      ).rejects.toMatchObject({
        detail: {
          code: 'full',
          operation: 'transaction',
          name: 'MusterSqliteError',
          kind: 'operational',
        },
      });
      // Fault exhausted after one shot; a later write succeeds and proves rollback.
      await faultClient.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-ok', 'key-ok', 'WS', 'now', 'now'],
        },
      ]);
      const rows = await faultClient.all<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      expect(rows.map((r) => r.id)).toEqual(['ws-ok']);
    } finally {
      delete process.env.MUSTER_SQLITE_FAULT_INJECT;
      delete process.env.MUSTER_SQLITE_FAULT_CODE;
    }
  }, 20_000);

  it('rejects a pragma outside the read allowlist', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    await expect(client.pragma('table_list')).rejects.toBeInstanceOf(DbWorkerError);
    // A known-safe one still works.
    expect(await client.pragma('foreign_keys')).toBe(1);
  }, 20_000);

  it('two clients on the same DB file both observe committed writes (WAL)', async () => {
    const dbPath = tempDbPath();
    const writer = makeClient();
    const reader = makeClient();
    await writer.open(dbPath);
    await reader.open(dbPath);

    await writer.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      ['ws1', 'key1', 'WS', 'now', 'now'],
    );
    // WAL: a separate connection sees the committed row.
    const row = await reader.get<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', ['ws1']);
    expect(row?.id).toBe('ws1');
  }, 20_000);
});

describe('DbClient terminal latch lifecycle', () => {
  it('rejects every concurrent pending request with the same corrupt code (no hang)', async () => {
    const { Worker } = await import('node:worker_threads');
    const { safeMessageForCode } = await import('./errors');
    // Fake worker: first transaction → corrupt; second stays pending until host terminates.
    const script = `
      const { parentPort } = require('node:worker_threads');
      let n = 0;
      parentPort.on('message', (req) => {
        if (req.kind === 'open') {
          parentPort.postMessage({ kind: 'ok', requestId: req.requestId });
          return;
        }
        if (req.kind === 'transaction') {
          n += 1;
          if (n === 1) {
            parentPort.postMessage({
              kind: 'error',
              requestId: req.requestId,
              name: 'MusterSqliteError',
              code: 'corrupt',
              operation: 'transaction',
              message: ${JSON.stringify(safeMessageForCode('corrupt'))},
              errorKind: 'operational',
            });
            return;
          }
          // leave second hanging; host must rejectAll on fatal
        }
      });
    `;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-fake-worker-'));
    tempDirs.push(dir);
    const workerPath = path.join(dir, 'fake-worker.js');
    fs.writeFileSync(workerPath, script, 'utf8');
    const terminal = { count: 0 };
    const client = new DbClient({
      workerPath,
      onTerminalStorageError: () => {
        terminal.count += 1;
      },
    });
    clients.push(client);
    await client.open(tempDbPath());
    const first = client.transaction([
      { sql: 'SELECT 1', params: [] },
    ]);
    const second = client.transaction([
      { sql: 'SELECT 2', params: [] },
    ]);
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0]?.status).toBe('rejected');
    expect(settled[1]?.status).toBe('rejected');
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      detail: { code: 'corrupt' },
    });
    expect((settled[1] as PromiseRejectedResult).reason).toMatchObject({
      detail: { code: 'corrupt' },
    });
    expect(terminal.count).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    await expect(client.transaction([{ sql: 'SELECT 3' }])).rejects.toMatchObject({
      detail: { code: 'corrupt' },
    });
    expect(terminal.count).toBe(1);
  }, 20_000);

  it('malformed response latches protocol and rejects every pending request', async () => {
    const script = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (req) => {
        if (req.kind === 'open') {
          parentPort.postMessage({ kind: 'ok', requestId: req.requestId });
          return;
        }
        parentPort.postMessage({ kind: 'error', requestId: req.requestId, code: 'full' });
      });
    `;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-fake-worker-'));
    tempDirs.push(dir);
    const workerPath = path.join(dir, 'fake-worker.js');
    fs.writeFileSync(workerPath, script, 'utf8');
    const client = new DbClient({ workerPath });
    clients.push(client);
    await client.open(tempDbPath());
    const a = client.transaction([{ sql: 'SELECT 1' }]);
    const b = client.transaction([{ sql: 'SELECT 2' }]);
    const settled = await Promise.allSettled([a, b]);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      expect((s as PromiseRejectedResult).reason).toMatchObject({
        detail: { code: 'protocol' },
      });
    }
  }, 20_000);

  it('unexpected clean worker exit rejects pending rather than hanging', async () => {
    const script = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (req) => {
        if (req.kind === 'open') {
          parentPort.postMessage({ kind: 'ok', requestId: req.requestId });
          return;
        }
        process.exit(0);
      });
    `;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-fake-worker-'));
    tempDirs.push(dir);
    const workerPath = path.join(dir, 'fake-worker.js');
    fs.writeFileSync(workerPath, script, 'utf8');
    const client = new DbClient({ workerPath });
    clients.push(client);
    await client.open(tempDbPath());
    await expect(client.transaction([{ sql: 'SELECT 1' }])).rejects.toBeInstanceOf(DbWorkerError);
  }, 20_000);
});

describe('resolveWorkerPath', () => {
  it('prefers a sibling compiled worker.js when present (production runtime)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workerpath-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'worker.js'), '// compiled', 'utf8');
    expect(resolveWorkerPath(dir)).toBe(path.join(dir, 'worker.js'));
  });

  it('falls back to worker.ts when no compiled worker exists (dev/tsx runtime)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workerpath-'));
    tempDirs.push(dir);
    expect(resolveWorkerPath(dir)).toBe(path.join(dir, 'worker.ts'));
  });

  it('resolves a real spawnable worker for the current test runtime', async () => {
    // The resolved path must actually boot a worker end-to-end.
    const client = new DbClient({ workerPath: resolveWorkerPath(), execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(tempDbPath());
    expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
  }, 20_000);
});
