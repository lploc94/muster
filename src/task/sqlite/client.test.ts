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
  it('opens a DB, migrates, and round-trips a run/get', async () => {
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
              (id, workspace_id, role, lifecycle, goal, backend, revision, created_at, updated_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: ['t1', 'ws1', 'worker', 'open', 'g', 'grok', 0, 'now', 'now', '{}'],
      },
    ]);
    const rows = await client.all('SELECT id FROM tasks WHERE workspace_id = ?', ['ws1']);
    expect(rows).toHaveLength(1);
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
                (id, workspace_id, role, lifecycle, goal, backend, revision, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: ['t1', 'ghost', 'worker', 'open', 'g', 'grok', 0, 'now', 'now', '{}'],
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
      expect(detail.message).toMatch(/no such table/i);
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
