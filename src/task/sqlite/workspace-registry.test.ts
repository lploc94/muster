import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbClient } from './client';
import { WorkspaceRegistry } from './workspace-registry';

const clients: DbClient[] = [];
const dirs: string[] = [];

async function clientFor(dbPath: string): Promise<DbClient> {
  const client = new DbClient({ workerPath: path.join(__dirname, 'worker.ts'), execArgv: ['--import', 'tsx'] });
  clients.push(client);
  await client.open(dbPath);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceRegistry', () => {
  it('converges concurrent registries on one UUID and records location aliases', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workspace-registry-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    // Open sequentially. The test below is about registry contention;
    // concurrent fresh-file creation has its own connection test suite.
    const firstClient = await clientFor(dbPath);
    const secondClient = await clientFor(dbPath);
    const identity = {
      identityKey: 'multi-folders:stable',
      displayName: 'Repo +1',
      locations: ['file:///repo-a', 'file:///repo-b'],
    };
    const [left, right] = await Promise.all([
      new WorkspaceRegistry(firstClient).getOrCreate(identity, '2026-07-16T00:00:00.000Z'),
      new WorkspaceRegistry(secondClient).getOrCreate(identity, '2026-07-16T00:00:01.000Z'),
    ]);
    expect(left.id).toBe(right.id);
    await expect(firstClient.all('SELECT canonical_uri FROM workspace_locations WHERE workspace_id = ? ORDER BY canonical_uri', [left.id]))
      .resolves.toEqual([{ canonical_uri: 'file:///repo-a' }, { canonical_uri: 'file:///repo-b' }]);
  }, 20_000);
});
