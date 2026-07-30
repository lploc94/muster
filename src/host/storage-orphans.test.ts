import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyStorageOrphans,
  readStorageDirectoryEntries,
  removeStorageOrphans,
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

  it('removes only classifier-selected orphans and reports reclaimed bytes', async () => {
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

    await expect(removeStorageOrphans(directory, report)).resolves.toEqual({
      removed: [
        { name: '.muster-tasks.json', bytes: 404 },
        { name: '.lease.turn%3Aaged', bytes: 606 },
      ],
      bytesReclaimed: 1010,
      failedRemovals: 0,
    });
    expect(fs.existsSync(path.join(directory, '.muster-tasks.json'))).toBe(false);
    expect(fs.existsSync(path.join(directory, '.lease.turn%3Aaged'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'muster.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'muster.sqlite3-wal'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'muster.sqlite3-shm'))).toBe(true);
    expect(fs.existsSync(path.join(directory, '.lease.turn%3Afresh'))).toBe(true);
  });

  it('is idempotent and skips a file that disappears after classification', async () => {
    const directory = makeTempDirectory();
    writeFile(directory, '.muster-tasks.json', 404);
    writeFile(directory, '.lease.turn%3Aaged', 606, NOW - STALENESS_MS - 1);
    const report = classifyStorageOrphans(
      await readStorageDirectoryEntries(directory),
      NOW,
      STALENESS_MS,
    );

    fs.rmSync(path.join(directory, '.muster-tasks.json'));
    await expect(removeStorageOrphans(directory, report)).resolves.toEqual({
      removed: [{ name: '.lease.turn%3Aaged', bytes: 606 }],
      bytesReclaimed: 606,
      failedRemovals: 0,
    });
    await expect(removeStorageOrphans(directory, report)).resolves.toEqual({
      removed: [],
      bytesReclaimed: 0,
      failedRemovals: 0,
    });
  });

  it('rejects a non-basename removal entry without touching a path outside storage', async () => {
    const directory = makeTempDirectory();
    const outside = path.join(directory, '..', 'muster-storage-orphans-outside');
    fs.writeFileSync(outside, 'protected');

    await expect(removeStorageOrphans(directory, {
      live: [],
      activeLeases: [],
      deadLegacyStores: [{ name: '../muster-storage-orphans-outside', bytes: 9 }],
      staleLeases: [],
    })).resolves.toEqual({
      removed: [],
      bytesReclaimed: 0,
      failedRemovals: 1,
    });
    expect(fs.readFileSync(outside, 'utf8')).toBe('protected');
    fs.rmSync(outside);
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
