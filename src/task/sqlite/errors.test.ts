import { describe, expect, it } from 'vitest';
import {
  MusterDomainError,
  MusterInvariantError,
  MusterSqliteError,
  SQLITE_ERROR_CODES,
  SQLITE_PRIMARY,
  mapToMusterSqliteError,
  recoveryActionForCode,
  safeMessageForCode,
  serializeMusterError,
} from './errors';
import { validateRpcErrorPayload } from './protocol';
import {
  ForeignDatabaseError,
  IncompatibleSchemaError,
  NonEmptyUnclaimedDatabaseError,
} from './connection';
import {
  bootstrapFaultCapability,
  getFaultPlanForTests,
  isFaultCapabilityEnabled,
  maybeInjectFault,
  setFaultPlanForTests,
} from './fault-inject';

describe('P5-W1 SQLite error taxonomy', () => {
  it('exposes operational, domain and invariant codes', () => {
    expect(SQLITE_ERROR_CODES).toContain('corrupt');
    expect(SQLITE_ERROR_CODES).toContain('constraint');
    expect(SQLITE_ERROR_CODES).toContain('capacity');
    expect(SQLITE_ERROR_CODES).toContain('invariant');
    expect(SQLITE_ERROR_CODES).toContain('protocol');
  });

  it('maps ownership errors without leaking observed ids into the safe message', () => {
    const foreign = new ForeignDatabaseError(12345);
    const mapped = mapToMusterSqliteError(foreign, 'open');
    expect(mapped).toBeInstanceOf(MusterSqliteError);
    expect(mapped.code).toBe('foreign_database');
    expect(mapped.message).not.toMatch(/12345/);
    expect(mapped.message).not.toMatch(/\/Users\//);

    const incompatible = new IncompatibleSchemaError(3);
    expect(mapToMusterSqliteError(incompatible).message).toMatch(
      /incompatible or incomplete/i,
    );
    expect(mapToMusterSqliteError(incompatible).message).not.toMatch(/\b3\b/);

    const nonempty = new NonEmptyUnclaimedDatabaseError();
    expect(mapToMusterSqliteError(nonempty).code).toBe('nonempty_unclaimed');
  });

  it('classifies node:sqlite shape via numeric primary codes', () => {
    const full = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.FULL, message: 'x' },
      'transaction',
    );
    expect(full).toBeInstanceOf(MusterSqliteError);
    expect(full.code).toBe('full');

    const readonly = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.READONLY, errstr: 'attempt to write a readonly database' },
      'write',
    );
    expect(readonly.code).toBe('readonly');

    const io = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.IOERR | 0x100, message: 'disk I/O error' },
      'write',
    );
    expect(io.code).toBe('io');

    const busy = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.BUSY, message: 'database is locked' },
      'transaction',
    );
    expect(busy.code).toBe('busy');

    const notadb = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.NOTADB, message: 'file is not a database' },
      'open',
    );
    expect(notadb.code).toBe('not_a_database');

    const corrupt = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.CORRUPT, message: 'database disk image is malformed' },
      'open',
    );
    expect(corrupt.code).toBe('corrupt');

    const constraint = mapToMusterSqliteError(
      { code: 'ERR_SQLITE_ERROR', errcode: SQLITE_PRIMARY.CONSTRAINT, message: 'UNIQUE constraint failed' },
      'transaction',
    );
    expect(constraint).toBeInstanceOf(MusterDomainError);
    expect(constraint.code).toBe('constraint');
  });

  it('keeps programmer/invariant Errors as invariant, not operational unknown', () => {
    const invariant = new Error('invalid message payload in SQLite store');
    const mapped = mapToMusterSqliteError(invariant, 'read');
    expect(mapped).toBeInstanceOf(MusterInvariantError);
    expect(mapped.code).toBe('invariant');
    expect(mapped.kind).toBe('invariant');
    const wire = serializeMusterError(invariant, 'read');
    expect(wire.code).toBe('invariant');
    expect(wire.kind).toBe('invariant');
    expect(wire.message).toBe(safeMessageForCode('invariant'));
    expect(wire.message).not.toMatch(/invalid message payload|temporarily unavailable/i);
  });

  it('serializes only fixed code/operation/message/kind on the wire', () => {
    const raw = {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.FULL,
      message: "database or disk is full: INSERT INTO messages VALUES ('secret')",
      name: 'SqliteError',
    };
    const wire = serializeMusterError(raw, 'transaction');
    expect(wire).toEqual({
      name: 'MusterSqliteError',
      code: 'full',
      operation: 'transaction',
      message: safeMessageForCode('full'),
      kind: 'operational',
    });
    expect(JSON.stringify(wire)).not.toMatch(/secret|INSERT|VALUES|\/Users\//i);
  });

  it('validates RPC payloads fail closed and rewrites messages', () => {
    const safe = validateRpcErrorPayload({
      kind: 'error',
      requestId: 1,
      code: 'full',
      operation: 'transaction',
      message: safeMessageForCode('full'),
      name: 'MusterSqliteError',
      errorKind: 'operational',
    });
    expect(safe.message).toBe(safeMessageForCode('full'));
    expect(safe.name).toBe('MusterSqliteError');
    expect(JSON.stringify(safe)).not.toMatch(/secrets|\/Users\//);

    // Raw message in otherwise complete envelope is rejected as protocol.
    const invalidMessage = validateRpcErrorPayload({
      kind: 'error',
      requestId: 1,
      code: 'full',
      operation: 'transaction',
      message: 'SELECT * FROM secrets WHERE path = /Users/me/db',
      name: 'MusterSqliteError',
      errorKind: 'operational',
    });
    expect(invalidMessage.code).toBe('protocol');

    const invalid = validateRpcErrorPayload({
      code: 'SQLITE_FULL',
      operation: 'drop_table',
      message: 'raw',
      stack: 'at evil',
    });
    expect(invalid.code).toBe('protocol');
    expect(invalid.kind).toBe('invariant');
  });

  it('maps recovery actions without filesystem paths', () => {
    expect(recoveryActionForCode('full')).toBe('free_disk_space');
    expect(recoveryActionForCode('busy')).toBe('retry');
    expect(recoveryActionForCode('corrupt')).toBe('reveal_storage');
    expect(recoveryActionForCode('readonly')).toBe('check_permissions');
  });
});

describe('P5-W1 fault-injection seam capability gate', () => {
  it('ignores plans without explicit capability', () => {
    bootstrapFaultCapability(undefined);
    expect(isFaultCapabilityEnabled()).toBe(false);
    setFaultPlanForTests({ code: 'full', operation: 'transaction', remaining: 1 });
    expect(getFaultPlanForTests()).toBeUndefined();
    expect(() => maybeInjectFault('transaction')).not.toThrow();
  });

  it('injects only when capability is enabled', () => {
    bootstrapFaultCapability({
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
    });
    expect(isFaultCapabilityEnabled()).toBe(true);
    expect(() => maybeInjectFault('transaction')).toThrow(MusterSqliteError);
    expect(getFaultPlanForTests()).toBeUndefined();
    expect(() => maybeInjectFault('transaction')).not.toThrow();

    setFaultPlanForTests({ code: 'busy', operation: 'transaction', remaining: 1 });
    expect(() => maybeInjectFault('read')).not.toThrow();
    expect(() => maybeInjectFault('transaction')).toThrow(/busy|timed out/i);
    bootstrapFaultCapability(undefined);
  });

  it('does not register production settings/commands for fault control', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const packageJson = JSON.parse(
      await fs.readFile(path.join(__dirname, '../../../package.json'), 'utf8'),
    ) as {
      contributes?: {
        commands?: Array<{ command: string }>;
        configuration?: { properties?: Record<string, unknown> };
      };
    };
    const commands = packageJson.contributes?.commands?.map((c) => c.command) ?? [];
    const configKeys = Object.keys(packageJson.contributes?.configuration?.properties ?? {});
    expect(commands.some((c) => /fault|inject/i.test(c))).toBe(false);
    expect(configKeys.some((k) => /fault|inject/i.test(k))).toBe(false);
    expect(commands.some((c) => c.startsWith('muster.uat.'))).toBe(false);
  });
});
