/**
 * Storage accounting contract (M023/S01/T01).
 *
 * The `storageReport` request kind is the single byte-accounting instrument the
 * rest of M023 measures itself against. These tests pin four properties:
 *   1. page-level aggregates come from a real database, not a fixture;
 *   2. per-table bytes rank by payload size and stay bounded by pageCount*pageSize;
 *   3. an unavailable `dbstat` degrades to a labelled estimate instead of throwing;
 *   4. nothing path-shaped crosses the worker boundary (BackupResultMeta precedent).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbClient, DbWorkerError } from './client';
import { parseWireSuccessResponse } from './protocol';
import type { StorageReportMeta } from './rpc';

const WORKER_TS = path.join(__dirname, 'worker.ts');
// Under vitest/tsx the worker .ts must be loaded through the tsx ESM loader.
const TSX_ARGV = ['--import', 'tsx'];

const clients: DbClient[] = [];
const tempDirs: string[] = [];

function makeClient(opts: { faultCapability?: boolean } = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(opts.faultCapability ? { faultCapability: true } : {}),
  });
  clients.push(client);
  return client;
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-storage-report-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

/** Seed one workspace plus `count` tasks carrying `bytesEach` of TEXT payload. */
async function seedBulkyTasks(
  client: DbClient,
  count: number,
  bytesEach: number,
): Promise<void> {
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES (?,?,?,?,?)`,
    ['ws1', 'key1', 'WS One', 'now', 'now'],
  );
  const payload = JSON.stringify({ blob: 'x'.repeat(bytesEach) });
  for (let i = 0; i < count; i += 1) {
    await client.run(
      `INSERT INTO tasks (
         id, workspace_id, parent_id, role, lifecycle, release_state, goal,
         backend, model, revision, created_at, updated_at, payload_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `task-${i}`,
        'ws1',
        null,
        'worker',
        'active',
        'draft',
        'goal',
        'claude',
        null,
        1,
        'now',
        'now',
        payload,
      ],
    );
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('storageReport page-level accounting', () => {
  it('reports file, wal, shm bytes and page aggregates for a real database', async () => {
    const client = makeClient();
    await client.open(tempDbPath());

    const report = await client.storageReport();

    expect(report.fileBytes).toBeGreaterThan(0);
    expect(report.walBytes).toBeGreaterThanOrEqual(0);
    expect(report.shmBytes).toBeGreaterThanOrEqual(0);
    expect(report.pageSize).toBeGreaterThan(0);
    expect(report.pageCount).toBeGreaterThan(0);
    expect(report.freelistCount).toBeGreaterThanOrEqual(0);
    expect([0, 1, 2]).toContain(report.autoVacuum);
    expect(['dbstat', 'estimated']).toContain(report.tableBytesSource);
    // A fresh store still carries the Muster schema, so tables are never empty.
    expect(report.tables.length).toBeGreaterThan(0);
  }, 30_000);

  it('ranks bulky tables above empty ones and stays bounded by pageCount*pageSize', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    await seedBulkyTasks(client, 40, 4096);

    const report = await client.storageReport();

    const names = report.tables.map((t) => t.name);
    expect(names).toContain('tasks');
    const tasksIndex = names.indexOf('tasks');
    const emptyIndex = names.indexOf('send_outbox');
    expect(emptyIndex).toBeGreaterThan(-1);
    expect(tasksIndex).toBeLessThan(emptyIndex);

    const bytes = report.tables.map((t) => t.bytes);
    const sortedDescending = [...bytes].sort((a, b) => b - a);
    expect(bytes).toEqual(sortedDescending);

    const total = bytes.reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(report.pageCount * report.pageSize);
  }, 30_000);

  it('never sends a filesystem path across the worker boundary', async () => {
    const client = makeClient();
    const dbPath = tempDbPath();
    await client.open(dbPath);
    await seedBulkyTasks(client, 2, 128);

    const report = await client.storageReport();
    const wire = JSON.stringify(report);

    expect(wire).not.toContain(os.tmpdir());
    expect(wire).not.toContain('muster.sqlite3');
    expect(wire).not.toMatch(/[/\\]/);
    for (const key of ['path', 'dbPath', 'fsPath', 'uri', 'destinationPath']) {
      expect(report as Record<string, unknown>).not.toHaveProperty(key);
    }
  }, 30_000);
});

describe('storageReport degradation', () => {
  it('falls back to a labelled estimate when dbstat is unavailable', async () => {
    const client = makeClient({ faultCapability: true });
    await client.open(tempDbPath());
    await seedBulkyTasks(client, 20, 2048);

    const report = await client.storageReport({ forceTableBytesSource: 'estimated' });

    expect(report.tableBytesSource).toBe('estimated');
    expect(report.tables.length).toBeGreaterThan(0);
    expect(report.tables.map((t) => t.name)).toContain('tasks');
    expect(report.tables[0].bytes).toBeGreaterThan(0);
    const bytes = report.tables.map((t) => t.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
  }, 30_000);

  it('ignores the estimate override without fault capability', async () => {
    const client = makeClient();
    await client.open(tempDbPath());

    const report = await client.storageReport({ forceTableBytesSource: 'estimated' });

    expect(report.tableBytesSource).toBe('dbstat');
  }, 30_000);

  it('rejects a storageReport requested before open', async () => {
    const client = makeClient();

    await expect(client.storageReport()).rejects.toBeInstanceOf(DbWorkerError);
  }, 30_000);
});

describe('storageReport wire validation', () => {
  const valid: StorageReportMeta = {
    fileBytes: 4096,
    walBytes: 0,
    shmBytes: 0,
    pageCount: 1,
    freelistCount: 0,
    pageSize: 4096,
    autoVacuum: 0,
    tableBytesSource: 'dbstat',
    tables: [
      { name: 'tasks', bytes: 2048 },
      { name: 'turns', bytes: 1024 },
    ],
  };

  function wire(result: unknown): unknown {
    return { kind: 'storageReport', requestId: 1, result };
  }

  it('accepts a well-formed payload', () => {
    const parsed = parseWireSuccessResponse(wire(valid));
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['missing key', { ...valid, pageSize: undefined }],
    ['extra key', { ...valid, dbPath: '/tmp/muster.sqlite3' }],
    ['NaN byte count', { ...valid, fileBytes: Number.NaN }],
    ['negative bytes', { ...valid, walBytes: -1 }],
    ['fractional page count', { ...valid, pageCount: 1.5 }],
    ['unknown byte source', { ...valid, tableBytesSource: 'guessed' }],
    ['out-of-range autoVacuum', { ...valid, autoVacuum: 3 }],
    ['tables not an array', { ...valid, tables: {} }],
    ['table entry missing bytes', { ...valid, tables: [{ name: 'tasks' }] }],
    ['table entry with extra key', { ...valid, tables: [{ name: 'tasks', bytes: 1, path: 'x' }] }],
    ['ascending table order', { ...valid, tables: [{ name: 'a', bytes: 1 }, { name: 'b', bytes: 9 }] }],
  ])('rejects %s', (_label, result) => {
    const parsed = parseWireSuccessResponse(wire(result));
    expect(parsed.ok).toBe(false);
  });
});
