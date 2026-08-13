import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IncompatibleSchemaError, openStoreDatabase } from './sqlite/connection';
import { resetDatabaseAtPath } from './sqlite/reset';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './sqlite/schema';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s06-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

function scalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  return Object.values(row)[0] as number;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('M024 S06 schema evidence baseline', () => {
  it('uses schema v5 and requires an explicit reset for an incompatible owned store', () => {
    // Bumped to 5 by immutable workflow-node reuse provenance and exact artifact pins.
    // Reset-only semantics are unchanged: an older store is rejected, never migrated.
    expect(SQLITE_SCHEMA_VERSION).toBe(5);

    const dbPath = tempDbPath();
    const current = openStoreDatabase({ path: dbPath });
    current.close();

    const incompatible = new DatabaseSync(dbPath);
    incompatible.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    incompatible.close();

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);

    const beforeReset = new DatabaseSync(dbPath);
    try {
      expect(scalar(beforeReset, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(beforeReset, 'user_version')).toBe(SQLITE_SCHEMA_VERSION + 1);
    } finally {
      beforeReset.close();
    }

    expect(resetDatabaseAtPath(dbPath)).toEqual({ schemaVersion: SQLITE_SCHEMA_VERSION });

    const reset = openStoreDatabase({ path: dbPath });
    try {
      expect(scalar(reset, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      // Asserted against the constant, not a second literal: the literal pin lives in the
      // SQLITE_SCHEMA_VERSION expectation above, so a bump cannot pass here by accident.
      expect(scalar(reset, 'user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(
        reset.prepare('SELECT COUNT(*) AS n FROM workspaces').get(),
      ).toEqual({ n: 0 });
    } finally {
      reset.close();
    }
  });
});
