import { describe, expect, it } from 'vitest';
import { DbWorkerError } from './client';
import { MusterSqliteError } from './errors';
import {
  diagnoseSqliteError,
  recoveryGuidanceFor,
  redactedDiagnosticLogFields,
} from './diagnostics';
import {
  ForeignDatabaseError,
  IncompatibleSchemaError,
  NonEmptyUnclaimedDatabaseError,
} from './connection';

describe('P5-W2 SQLite diagnostics', () => {
  it('distinguishes foreign, incompatible, nonempty and corrupt without paths', () => {
    expect(diagnoseSqliteError(new ForeignDatabaseError(1), 'open').code).toBe('foreign_database');
    expect(diagnoseSqliteError(new IncompatibleSchemaError(2), 'open').code).toBe(
      'incompatible_schema',
    );
    expect(diagnoseSqliteError(new NonEmptyUnclaimedDatabaseError(), 'open').code).toBe(
      'nonempty_unclaimed',
    );
    expect(diagnoseSqliteError(new MusterSqliteError('corrupt', 'open'), 'open').code).toBe(
      'corrupt',
    );
    expect(diagnoseSqliteError(new MusterSqliteError('not_a_database', 'open'), 'open').code).toBe(
      'not_a_database',
    );
  });

  it('redacts DbWorkerError wire payloads into fixed fields', () => {
    const error = new DbWorkerError({
      name: 'MusterSqliteError',
      code: 'corrupt',
      message: 'database disk image is malformed at /Users/secret/muster.sqlite3',
      operation: 'open',
      kind: 'operational',
    });
    const diagnostic = diagnoseSqliteError(error, 'open');
    expect(diagnostic.message).not.toMatch(/\/Users\/|malformed|secret/i);
    expect(diagnostic.failClosed).toBe(true);
    const log = redactedDiagnosticLogFields(diagnostic);
    expect(log).toEqual({
      code: 'corrupt',
      operation: 'open',
      recoveryAction: 'reveal_storage',
      kind: 'operational',
      failClosed: true,
      terminal: true,
    });
    expect(JSON.stringify(log)).not.toMatch(/\/Users\/|secret|SELECT/i);
  });

  it('treats schema_changed as terminal with Reload Window guidance, not reveal/reset', () => {
    const diagnostic = diagnoseSqliteError(
      new MusterSqliteError('schema_changed', 'transaction'),
      'transaction',
    );
    expect(diagnostic.code).toBe('schema_changed');
    expect(diagnostic.terminal).toBe(true);
    expect(diagnostic.failClosed).toBe(true);
    expect(diagnostic.recoveryAction).toBe('reload_window');
    expect(recoveryGuidanceFor(diagnostic)).toMatch(/reload/i);
    expect(recoveryGuidanceFor(diagnostic)).not.toMatch(/reveal|reset|delete/i);
    expect(diagnostic.message).not.toMatch(/muster_writer_version|SELECT |\/Users\//i);
  });
});
