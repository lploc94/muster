import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyStorageOrphans,
  readStorageDirectoryEntries,
} from './storage-orphans';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const STALENESS_MS = 60_000;
const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-storage-orphans-'));
  tempDirectories.push(directory);
  return directory;
}

function writeFile(directory: string, name: string, bytes: number, mtimeMs = NOW): void {
  const file = path.join(directory, name);
  fs.writeFileSync(file, Buffer.alloc(bytes));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('storage orphan classification', () => {
  it('partitions live files, the legacy store, and leases without returning paths', async () => {
    const directory = makeTempDirectory();
    writeFile(directory, 'muster.sqlite3', 101);
    writeFile(directory, 'muster.sqlite3-wal', 202);
    writeFile(directory, 'muster.sqlite3-shm', 303);
    writeFile(directory, '.muster-tasks.json', 404);
    writeFile(directory, '.lease.turn%3Afresh', 505, NOW - STALENESS_MS + 1);
    writeFile(directory, '.lease.turn%3Aaged', 606, NOW - STALENESS_MS - 1);

    const report = classifyStorageOrphans(
      await readStorageDirectoryEntries(directory),
      NOW,
      STALENESS_MS,
    );

    expect(report.live).toEqual([
      { name: 'muster.sqlite3', bytes: 101 },
      { name: 'muster.sqlite3-shm', bytes: 303 },
      { name: 'muster.sqlite3-wal', bytes: 202 },
    ]);
    expect(report.deadLegacyStores).toEqual([{ name: '.muster-tasks.json', bytes: 404 }]);
    expect(report.activeLeases).toEqual([{ name: '.lease.turn%3Afresh', bytes: 505 }]);
    expect(report.staleLeases).toEqual([{ name: '.lease.turn%3Aaged', bytes: 606 }]);

    const classifiedNames = Object.values(report).flat().map((file) => file.name);
    expect(new Set(classifiedNames).size).toBe(classifiedNames.length);
    expect(classifiedNames).not.toContain(directory);
    expect(JSON.stringify(report)).not.toContain(directory);
  });

  it('returns no classifications for an empty directory', async () => {
    const report = classifyStorageOrphans(
      await readStorageDirectoryEntries(makeTempDirectory()),
      NOW,
      STALENESS_MS,
    );

    expect(report).toEqual({
      live: [],
      deadLegacyStores: [],
      activeLeases: [],
      staleLeases: [],
    });
  });

  it('treats a missing directory as an empty listing', async () => {
    const directory = path.join(os.tmpdir(), `muster-storage-orphans-missing-${Date.now()}`);

    expect(await readStorageDirectoryEntries(directory)).toEqual([]);
  });
});
