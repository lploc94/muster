import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbClient, DbWorkerError } from './client';
import { parseWireSuccessResponse } from './protocol';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const clients: DbClient[] = [];
const tempDirs: string[] = [];

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-reclaim-rpc-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

async function seedAndFreePages(client: DbClient): Promise<void> {
  await client.run('CREATE TABLE reclaim_rpc_fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  const payload = 'x'.repeat(32 * 1024);
  for (let index = 0; index < 48; index += 1) {
    await client.run('INSERT INTO reclaim_rpc_fixture (payload) VALUES (?)', [payload]);
  }
  await client.run('DELETE FROM reclaim_rpc_fixture');
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reclaimStorage RPC', () => {
  it('reclaims the open incremental store and returns numeric-only metadata', async () => {
    const client = makeClient();
    await client.open(tempDbPath());
    await seedAndFreePages(client);

    const before = await client.storageReport();
    expect(before.freelistCount).toBeGreaterThan(0);

    const result = await client.reclaimStorage();

    expect(result).toMatchObject({
      mode: 'incremental',
      fileBytesBefore: expect.any(Number),
      fileBytesAfter: expect.any(Number),
      freelistCountBefore: expect.any(Number),
      freelistCountAfter: expect.any(Number),
      batchesRun: expect.any(Number),
      walCheckpoints: expect.any(Number),
      residualWalBytes: expect.any(Number),
    });
    expect(result.fileBytesAfter).toBeLessThan(result.fileBytesBefore);
    expect(result.freelistCountAfter).toBeLessThan(result.freelistCountBefore);
    expect(JSON.stringify(result)).not.toMatch(/[/\\]/);
    for (const key of ['path', 'dbPath', 'fsPath', 'uri', 'sourcePath']) {
      expect(result as Record<string, unknown>).not.toHaveProperty(key);
    }
  }, 30_000);

  it('rejects malformed reclaim metadata as a protocol failure', async () => {
    const parsed = parseWireSuccessResponse({
      kind: 'reclaim',
      requestId: 1,
      result: {
        mode: 'incremental',
        fileBytesBefore: 8192,
        fileBytesAfter: 4096,
        freelistCountBefore: 1,
        freelistCountAfter: 0,
        batchesRun: 1,
        walCheckpoints: 3,
        residualWalBytes: 0,
        dbPath: '/secret',
      },
    });

    expect(parsed.ok).toBe(false);
  });

  it('rejects a refused result without its required-versus-available diagnostic', () => {
    const parsed = parseWireSuccessResponse({
      kind: 'reclaim',
      requestId: 1,
      result: {
        mode: 'refused',
        fileBytesBefore: 8192,
        fileBytesAfter: 8192,
        freelistCountBefore: 1,
        freelistCountAfter: 1,
        batchesRun: 0,
        walCheckpoints: 1,
        residualWalBytes: 0,
      },
    });

    expect(parsed.ok).toBe(false);
  });

  it('returns a safe worker error when reclaim is requested before open', async () => {
    const client = makeClient();
    await expect(client.reclaimStorage()).rejects.toBeInstanceOf(DbWorkerError);
  });
});
