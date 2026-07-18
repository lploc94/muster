import { describe, expect, it } from 'vitest';
import {
  makeProtocolError,
  parseWireErrorResponse,
  parseWireSuccessResponse,
  validateRpcErrorPayload,
} from './protocol';
import { safeMessageForCode } from './errors';

describe('strict RPC wire validation', () => {
  it('rejects requestId 0 as protocol', () => {
    expect(
      parseWireErrorResponse({
        kind: 'error',
        requestId: 0,
        name: 'MusterSqliteError',
        code: 'full',
        operation: 'transaction',
        message: safeMessageForCode('full'),
        errorKind: 'operational',
      }).ok,
    ).toBe(false);
    expect(parseWireSuccessResponse({ kind: 'ok', requestId: 0 }).ok).toBe(false);
  });

  it('accepts exact error envelopes only', () => {
    const ok = parseWireErrorResponse({
      kind: 'error',
      requestId: 1,
      name: 'MusterSqliteError',
      code: 'full',
      operation: 'transaction',
      message: safeMessageForCode('full'),
      errorKind: 'operational',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.code).toBe('full');
    }
  });

  it('rejects missing/extra keys, wrong message, and inconsistent kind/name', () => {
    expect(
      parseWireErrorResponse({
        kind: 'error',
        requestId: 1,
        code: 'full',
        operation: 'transaction',
        message: safeMessageForCode('full'),
        errorKind: 'operational',
        // missing name
      }).ok,
    ).toBe(false);

    expect(
      parseWireErrorResponse({
        kind: 'error',
        requestId: 1,
        name: 'MusterSqliteError',
        code: 'full',
        operation: 'transaction',
        message: 'database or disk is full: secret',
        errorKind: 'operational',
      }).ok,
    ).toBe(false);

    expect(
      parseWireErrorResponse({
        kind: 'error',
        requestId: 1,
        name: 'MusterSqliteError',
        code: 'full',
        operation: 'transaction',
        message: safeMessageForCode('full'),
        errorKind: 'domain',
      }).ok,
    ).toBe(false);

    expect(
      parseWireErrorResponse({
        kind: 'error',
        requestId: 1,
        name: 'MusterSqliteError',
        code: 'full',
        operation: 'transaction',
        message: safeMessageForCode('full'),
        errorKind: 'operational',
        stack: 'at evil',
      }).ok,
    ).toBe(false);
  });

  it('validates success shapes and rejects partial/extra nested results', () => {
    expect(
      parseWireSuccessResponse({ kind: 'ok', requestId: 1 }).ok,
    ).toBe(true);
    expect(
      parseWireSuccessResponse({ kind: 'ok', requestId: 1, extra: true }).ok,
    ).toBe(false);
    expect(
      parseWireSuccessResponse({ kind: 'rows', requestId: 1, rows: [] }).ok,
    ).toBe(true);
    expect(
      parseWireSuccessResponse({ kind: 'rows', requestId: 1 }).ok,
    ).toBe(false);
    expect(
      parseWireSuccessResponse({
        kind: 'run',
        requestId: 1,
        result: { changes: 1, lastInsertRowid: 2 },
      }).ok,
    ).toBe(true);
    expect(
      parseWireSuccessResponse({
        kind: 'run',
        requestId: 1,
        result: { changes: Number.NaN, lastInsertRowid: 2 },
      }).ok,
    ).toBe(false);
    expect(
      parseWireSuccessResponse({
        kind: 'transaction',
        requestId: 1,
        results: [{ changes: 0, lastInsertRowid: 0 }, { changes: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      parseWireSuccessResponse({ kind: 'scalar', requestId: 1, value: Number.POSITIVE_INFINITY }).ok,
    ).toBe(false);
    expect(
      parseWireSuccessResponse({ kind: 'row', requestId: 1, row: null }).ok,
    ).toBe(true);
    expect(
      parseWireSuccessResponse({
        kind: 'backup',
        requestId: 1,
        result: {
          mechanism: 'vacuum',
          schemaVersion: 7,
          workspaceRevision: 3,
          byteSize: 1024,
        },
      }).ok,
    ).toBe(true);
    expect(
      parseWireSuccessResponse({
        kind: 'backup',
        requestId: 1,
        result: {
          mechanism: 'api',
          schemaVersion: 7,
          workspaceRevision: 3,
          byteSize: 0,
        },
      }).ok,
    ).toBe(false);
    expect(
      parseWireSuccessResponse({
        kind: 'backup',
        requestId: 1,
        result: {
          mechanism: 'vacuum',
          schemaVersion: 7,
          workspaceRevision: 3,
          byteSize: 1024,
          path: '/secret',
        },
      }).ok,
    ).toBe(false);
  });

  it('makeProtocolError is fixed and redacted', () => {
    const p = makeProtocolError('transaction');
    expect(p.code).toBe('protocol');
    expect(p.kind).toBe('invariant');
    expect(JSON.stringify(p)).not.toMatch(/SELECT|\/Users\/|stack/i);
  });

  it('validateRpcErrorPayload does not rewrite incomplete envelopes into operational codes', () => {
    const partial = validateRpcErrorPayload({ code: 'full' });
    // Without full envelope this is protocol, not a rewritten full error.
    expect(partial.code).toBe('protocol');
  });
});
