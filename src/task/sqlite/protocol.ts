/**
 * Strict RPC wire validators (P5-W1). Exact keys/types only — never invent success
 * from malformed payloads and never forward raw error text.
 */

import {
  MusterInvariantError,
  isSqliteErrorCode,
  isSqliteOperationClass,
  kindForCode,
  nameForKind,
  safeMessageForCode,
  serializeBoundaryError,
  type SafeSerializedDbError,
  type SqliteErrorCode,
  type SqliteOperationClass,
} from './errors';
import type { BackupResultMeta, DbResponse, ResetResultMeta, RunResult } from './rpc';
import { SQLITE_WORKFLOW_ENVELOPE_MAX_BYTES } from '../content-limits';
import type { RepositoryCommandResult } from '../repository';

export function makeProtocolError(
  operation: SqliteOperationClass = 'unknown',
): SafeSerializedDbError {
  return serializeBoundaryError(new MusterInvariantError('protocol', operation));
}

/** requestId must be a safe integer >= 1 (0 is never a valid live request). */
function isSafeRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Non-negative safe int for changes / lastInsertRowid. */
function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function exactKeys(obj: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(obj);
  if (keys.length !== required.length) return false;
  const set = new Set(required);
  return keys.every((k) => set.has(k));
}

/**
 * Strict error envelope validation.
 * Exact keys: kind, requestId, name, code, operation, message, errorKind
 */
export function parseWireErrorResponse(input: unknown): {
  ok: true;
  requestId: number;
  payload: SafeSerializedDbError;
} | { ok: false; payload: SafeSerializedDbError } {
  if (!input || typeof input !== 'object') {
    return { ok: false, payload: makeProtocolError() };
  }
  const obj = input as Record<string, unknown>;
  if (
    !exactKeys(obj, [
      'kind',
      'requestId',
      'name',
      'code',
      'operation',
      'message',
      'errorKind',
    ])
  ) {
    return { ok: false, payload: makeProtocolError() };
  }
  if (obj.kind !== 'error' || !isSafeRequestId(obj.requestId)) {
    return { ok: false, payload: makeProtocolError() };
  }
  if (!isSqliteErrorCode(obj.code) || !isSqliteOperationClass(obj.operation)) {
    return { ok: false, payload: makeProtocolError() };
  }
  const code = obj.code as SqliteErrorCode;
  const operation = obj.operation as SqliteOperationClass;
  const kind = kindForCode(code);
  const expectedName = nameForKind(kind);
  const expectedMessage = safeMessageForCode(code);
  if (obj.name !== expectedName) {
    return { ok: false, payload: makeProtocolError(operation) };
  }
  if (obj.errorKind !== kind) {
    return { ok: false, payload: makeProtocolError(operation) };
  }
  if (obj.message !== expectedMessage) {
    return { ok: false, payload: makeProtocolError(operation) };
  }
  return {
    ok: true,
    requestId: obj.requestId,
    payload: {
      name: expectedName,
      code,
      operation,
      message: expectedMessage,
      kind,
    },
  };
}

function parseRunResult(value: unknown): RunResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (!exactKeys(obj, ['changes', 'lastInsertRowid'])) return undefined;
  if (!isSafeNonNegativeInt(obj.changes) || !isSafeNonNegativeInt(obj.lastInsertRowid)) {
    return undefined;
  }
  return { changes: obj.changes, lastInsertRowid: obj.lastInsertRowid };
}

function parseWorkflowMutationResult(value: unknown): RepositoryCommandResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    'ok',
    'changed',
    'reason',
    'operation',
    'conflict',
    'messageId',
    'turnId',
    'deletedMessageIds',
    'affectedTaskIds',
    'presentationStatus',
  ]);
  if (!Object.keys(obj).every((key) => allowed.has(key)) || typeof obj.ok !== 'boolean') {
    return undefined;
  }
  if (obj.changed !== undefined && typeof obj.changed !== 'boolean') return undefined;
  if (
    obj.reason !== undefined &&
    (typeof obj.reason !== 'string' || obj.reason.length === 0 || obj.reason.length > 1024)
  ) {
    return undefined;
  }
  if (obj.conflict !== undefined && typeof obj.conflict !== 'boolean') return undefined;
  if (obj.messageId !== undefined &&
    (typeof obj.messageId !== 'string' || obj.messageId.length === 0 || obj.messageId.length > 512)) {
    return undefined;
  }
  if (obj.turnId !== undefined &&
    (typeof obj.turnId !== 'string' || obj.turnId.length === 0 || obj.turnId.length > 512)) {
    return undefined;
  }
  if (obj.deletedMessageIds !== undefined && (
    !Array.isArray(obj.deletedMessageIds) ||
    obj.deletedMessageIds.length > 10_000 ||
    !obj.deletedMessageIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
  )) {
    return undefined;
  }
  if (obj.affectedTaskIds !== undefined && (
    !Array.isArray(obj.affectedTaskIds) ||
    obj.affectedTaskIds.length > 10_000 ||
    !obj.affectedTaskIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
  )) {
    return undefined;
  }
  const presentationStatuses = new Set([
    'committed',
    'idempotent',
    'op_conflict',
    'stale_revision',
    'owner_mismatch',
  ]);
  if (obj.presentationStatus !== undefined &&
    (typeof obj.presentationStatus !== 'string' || !presentationStatuses.has(obj.presentationStatus))) {
    return undefined;
  }
  if (obj.operation !== undefined) {
    if (!obj.operation || typeof obj.operation !== 'object' || Array.isArray(obj.operation)) return undefined;
    try {
      if (
        Buffer.byteLength(JSON.stringify(obj.operation), 'utf8') >
        SQLITE_WORKFLOW_ENVELOPE_MAX_BYTES
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return {
    ok: obj.ok,
    ...(typeof obj.changed === 'boolean' ? { changed: obj.changed } : {}),
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
    ...(obj.operation && typeof obj.operation === 'object'
      ? { operation: obj.operation as RepositoryCommandResult['operation'] }
      : {}),
    ...(typeof obj.conflict === 'boolean' ? { conflict: obj.conflict } : {}),
    ...(typeof obj.messageId === 'string' ? { messageId: obj.messageId } : {}),
    ...(typeof obj.turnId === 'string' ? { turnId: obj.turnId } : {}),
    ...(Array.isArray(obj.deletedMessageIds)
      ? { deletedMessageIds: obj.deletedMessageIds as string[] }
      : {}),
    ...(Array.isArray(obj.affectedTaskIds)
      ? { affectedTaskIds: obj.affectedTaskIds as string[] }
      : {}),
    ...(typeof obj.presentationStatus === 'string'
      ? { presentationStatus: obj.presentationStatus as NonNullable<RepositoryCommandResult['presentationStatus']> }
      : {}),
  };
}

/**
 * Strict success response validation. Rejects extra keys, NaN, missing nested fields.
 */
export function parseWireSuccessResponse(input: unknown): {
  ok: true;
  response: DbResponse;
} | { ok: false; payload: SafeSerializedDbError } {
  if (!input || typeof input !== 'object') {
    return { ok: false, payload: makeProtocolError() };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !isSafeRequestId(obj.requestId)) {
    return { ok: false, payload: makeProtocolError() };
  }
  const requestId = obj.requestId;

  switch (obj.kind) {
    case 'ok': {
      if (!exactKeys(obj, ['kind', 'requestId'])) {
        return { ok: false, payload: makeProtocolError() };
      }
      return { ok: true, response: { kind: 'ok', requestId } };
    }
    case 'rows': {
      if (!exactKeys(obj, ['kind', 'requestId', 'rows']) || !Array.isArray(obj.rows)) {
        return { ok: false, payload: makeProtocolError() };
      }
      return { ok: true, response: { kind: 'rows', requestId, rows: obj.rows } };
    }
    case 'row': {
      if (!exactKeys(obj, ['kind', 'requestId', 'row'])) {
        return { ok: false, payload: makeProtocolError() };
      }
      // row may be null for empty get
      return { ok: true, response: { kind: 'row', requestId, row: obj.row } };
    }
    case 'run': {
      if (!exactKeys(obj, ['kind', 'requestId', 'result'])) {
        return { ok: false, payload: makeProtocolError() };
      }
      const result = parseRunResult(obj.result);
      if (!result) return { ok: false, payload: makeProtocolError() };
      return { ok: true, response: { kind: 'run', requestId, result } };
    }
    case 'transaction': {
      if (!exactKeys(obj, ['kind', 'requestId', 'results']) || !Array.isArray(obj.results)) {
        return { ok: false, payload: makeProtocolError() };
      }
      const results: RunResult[] = [];
      for (const entry of obj.results) {
        const parsed = parseRunResult(entry);
        if (!parsed) return { ok: false, payload: makeProtocolError() };
        results.push(parsed);
      }
      return { ok: true, response: { kind: 'transaction', requestId, results } };
    }
    case 'workflowMutation': {
      if (!exactKeys(obj, ['kind', 'requestId', 'result'])) {
        return { ok: false, payload: makeProtocolError() };
      }
      const result = parseWorkflowMutationResult(obj.result);
      if (!result) return { ok: false, payload: makeProtocolError() };
      return { ok: true, response: { kind: 'workflowMutation', requestId, result } };
    }
    case 'scalar': {
      if (!exactKeys(obj, ['kind', 'requestId', 'value']) || !isFiniteNumber(obj.value)) {
        return { ok: false, payload: makeProtocolError() };
      }
      return { ok: true, response: { kind: 'scalar', requestId, value: obj.value } };
    }
    case 'backup': {
      if (!exactKeys(obj, ['kind', 'requestId', 'result'])) {
        return { ok: false, payload: makeProtocolError() };
      }
      const result = parseBackupResult(obj.result);
      if (!result) return { ok: false, payload: makeProtocolError() };
      return { ok: true, response: { kind: 'backup', requestId, result } };
    }
    case 'reset': {
      if (!exactKeys(obj, ['kind', 'requestId', 'result'])) {
        return { ok: false, payload: makeProtocolError() };
      }
      const result = parseResetResult(obj.result);
      if (!result) return { ok: false, payload: makeProtocolError() };
      return { ok: true, response: { kind: 'reset', requestId, result } };
    }
    default:
      return { ok: false, payload: makeProtocolError() };
  }
}

function parseResetResult(value: unknown): ResetResultMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (!exactKeys(obj, ['schemaVersion'])) return undefined;
  if (!Number.isSafeInteger(obj.schemaVersion) || (obj.schemaVersion as number) < 1) {
    return undefined;
  }
  return { schemaVersion: obj.schemaVersion as number };
}

function parseBackupResult(value: unknown): BackupResultMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (
    !exactKeys(obj, ['mechanism', 'schemaVersion', 'workspaceRevision', 'byteSize'])
  ) {
    return undefined;
  }
  if (obj.mechanism !== 'api' && obj.mechanism !== 'vacuum') return undefined;
  if (
    !Number.isSafeInteger(obj.schemaVersion) ||
    !Number.isSafeInteger(obj.workspaceRevision) ||
    !Number.isSafeInteger(obj.byteSize)
  ) {
    return undefined;
  }
  if (
    (obj.schemaVersion as number) < 0 ||
    (obj.workspaceRevision as number) < 0 ||
    (obj.byteSize as number) <= 0
  ) {
    return undefined;
  }
  return {
    mechanism: obj.mechanism,
    schemaVersion: obj.schemaVersion as number,
    workspaceRevision: obj.workspaceRevision as number,
    byteSize: obj.byteSize as number,
  };
}

/**
 * Strict validation entry. Incomplete envelopes fail closed as protocol —
 * never rewrite a partial `{code:'full'}` into a successful operational parse.
 */
export function validateRpcErrorPayload(input: unknown): SafeSerializedDbError {
  if (input && typeof input === 'object' && (input as { kind?: unknown }).kind === 'error') {
    const parsed = parseWireErrorResponse(input);
    return parsed.ok ? parsed.payload : parsed.payload;
  }
  return makeProtocolError();
}
