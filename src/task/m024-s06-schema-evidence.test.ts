import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IncompatibleSchemaError, openStoreDatabase } from './sqlite/connection';
import { resetDatabaseAtPath } from './sqlite/reset';
import {
  CURRENT_SCHEMA_STATEMENTS,
  MUSTER_APPLICATION_ID,
  SQLITE_SCHEMA_VERSION,
} from './sqlite/schema';

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
  it('uses reset-only schema v7 and refuses schema 6 without mutation', () => {
    expect(SQLITE_SCHEMA_VERSION).toBe(7);

    const dbPath = tempDbPath();
    const current = openStoreDatabase({ path: dbPath });
    current.close();

    const incompatible = new DatabaseSync(dbPath);
    incompatible.exec('PRAGMA user_version = 6');
    const beforeObjects = incompatible
      .prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
    incompatible.close();

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);

    const beforeReset = new DatabaseSync(dbPath);
    try {
      expect(scalar(beforeReset, 'application_id')).toBe(MUSTER_APPLICATION_ID);
      expect(scalar(beforeReset, 'user_version')).toBe(6);
      expect(
        beforeReset
          .prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
          .all(),
      ).toEqual(beforeObjects);
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

  it('contains no in-place migration statements or open-path migration branch', () => {
    expect(CURRENT_SCHEMA_STATEMENTS.some((statement) => /\bALTER\s+TABLE\b/i.test(statement))).toBe(false);
    const source = fs.readFileSync(new URL('./sqlite/connection.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Additive migration|observedVersion\s*===\s*5|\bALTER\s+TABLE\b/i);
  });
});
