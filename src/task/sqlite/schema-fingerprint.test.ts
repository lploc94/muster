import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_STATEMENTS } from './schema';
import {
  captureSchemaManifest,
  expectedSchemaManifest,
  findSchemaFingerprintFailure,
  normalizeSchemaSql,
} from './schema-fingerprint';

function applyCurrentSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
  return db;
}

describe('current schema manifest', () => {
  it('matches the only supported clean-break schema', () => {
    const db = applyCurrentSchema();
    try {
      expect(findSchemaFingerprintFailure(db)).toBeUndefined();
      expect(captureSchemaManifest(db)).toEqual(expectedSchemaManifest());
    } finally {
      db.close();
    }
  });

  it('rejects missing and extra schema objects', () => {
    const incomplete = new DatabaseSync(':memory:');
    try {
      expect(findSchemaFingerprintFailure(incomplete)?.reason).toBe('missing_table');
    } finally {
      incomplete.close();
    }

    const extra = applyCurrentSchema();
    try {
      extra.exec('CREATE TABLE unexpected_table (id TEXT PRIMARY KEY)');
      expect(findSchemaFingerprintFailure(extra)).toEqual({
        reason: 'extra_table',
        object: 'unexpected_table',
      });
    } finally {
      extra.close();
    }
  });

  it('preserves quoted CHECK literals during SQL normalization', () => {
    const a = normalizeSchemaSql(`CHECK (release_state IN ('draft', 'released'))`);
    const b = normalizeSchemaSql(`CHECK (release_state IN ('DRAFT', 'released'))`);
    expect(a).not.toBe(b);
  });
});
