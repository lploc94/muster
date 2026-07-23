/**
 * Phase 5 safe SQLite error contract (P5-W1).
 *
 * Three categories cross the DB worker RPC boundary — never raw SQL, params,
 * paths, stacks, credentials or conversation content:
 *
 * - operational (MusterSqliteError): corrupt/full/busy/…
 * - domain (MusterDomainError): constraint / capacity
 * - invariant (MusterInvariantError): programmer / protocol / malformed payload
 */

/** Operational storage codes. */
export const SQLITE_OPERATIONAL_CODES = [
  'corrupt',
  'not_a_database',
  'full',
  'readonly',
  'io',
  'busy',
  'foreign_database',
  'incompatible_schema',
  'nonempty_unclaimed',
  /** Stale writer blocked by v8 writer-guard triggers / missing writer UDF. */
  'schema_changed',
  'unknown',
] as const;

export type SqliteOperationalCode = (typeof SQLITE_OPERATIONAL_CODES)[number];

/** Domain rule codes (not storage faults). */
export const SQLITE_DOMAIN_CODES = ['constraint', 'capacity'] as const;
export type SqliteDomainCode = (typeof SQLITE_DOMAIN_CODES)[number];

/** Programmer / protocol codes. */
export const SQLITE_INVARIANT_CODES = ['invariant', 'protocol'] as const;
export type SqliteInvariantCode = (typeof SQLITE_INVARIANT_CODES)[number];

export type SqliteErrorCode =
  | SqliteOperationalCode
  | SqliteDomainCode
  | SqliteInvariantCode;

export const SQLITE_ERROR_CODES = [
  ...SQLITE_OPERATIONAL_CODES,
  ...SQLITE_DOMAIN_CODES,
  ...SQLITE_INVARIANT_CODES,
] as const;

export const SQLITE_OPERATION_CLASSES = [
  'open',
  'read',
  'write',
  'transaction',
  'pragma',
  'close',
  'backup',
  'unknown',
] as const;

export type SqliteOperationClass = (typeof SQLITE_OPERATION_CLASSES)[number];

export const SQLITE_FAULT_CODES = [
  'full',
  'readonly',
  'io',
  'busy',
  'corrupt',
  'not_a_database',
] as const;

export type SqliteFaultCode = (typeof SQLITE_FAULT_CODES)[number];

export type SqliteErrorKind = 'operational' | 'domain' | 'invariant';

const CODE_SET = new Set<string>(SQLITE_ERROR_CODES);
const OP_SET = new Set<string>(SQLITE_OPERATION_CLASSES);
const OPERATIONAL_SET = new Set<string>(SQLITE_OPERATIONAL_CODES);
const DOMAIN_SET = new Set<string>(SQLITE_DOMAIN_CODES);
const INVARIANT_SET = new Set<string>(SQLITE_INVARIANT_CODES);

export const SQLITE_ERROR_NAME = 'MusterSqliteError';
export const SQLITE_DOMAIN_NAME = 'MusterDomainError';
export const SQLITE_INVARIANT_NAME = 'MusterInvariantError';

/** SQLite primary result codes (extended code & 0xff). */
export const SQLITE_PRIMARY = {
  BUSY: 5,
  LOCKED: 6,
  READONLY: 8,
  IOERR: 10,
  CORRUPT: 11,
  FULL: 13,
  CONSTRAINT: 19,
  NOTADB: 26,
} as const;

export function kindForCode(code: SqliteErrorCode): SqliteErrorKind {
  if (DOMAIN_SET.has(code)) return 'domain';
  if (INVARIANT_SET.has(code)) return 'invariant';
  return 'operational';
}

export function nameForKind(kind: SqliteErrorKind): string {
  switch (kind) {
    case 'domain':
      return SQLITE_DOMAIN_NAME;
    case 'invariant':
      return SQLITE_INVARIANT_NAME;
    default:
      return SQLITE_ERROR_NAME;
  }
}

export function safeMessageForCode(code: SqliteErrorCode): string {
  switch (code) {
    case 'corrupt':
      return 'Muster SQLite database is corrupt and cannot be opened.';
    case 'not_a_database':
      return 'Muster storage file is not a SQLite database.';
    case 'full':
      return 'Muster could not write because the disk is full.';
    case 'readonly':
      return 'Muster could not write because the database is read-only.';
    case 'io':
      return 'Muster hit a disk I/O error while accessing SQLite storage.';
    case 'busy':
      return 'Muster SQLite storage is busy; the operation timed out.';
    case 'foreign_database':
      return 'Muster refused to open a database owned by another application.';
    case 'incompatible_schema':
      return 'Muster development database schema is incompatible or incomplete.';
    case 'nonempty_unclaimed':
      return 'Muster refused to claim a non-empty unclaimed SQLite file; reset or remove it.';
    case 'schema_changed':
      return 'Muster storage schema was upgraded in another window. Reload this window to continue.';
    case 'constraint':
      return 'Muster rejected the write because a database constraint was violated.';
    case 'capacity':
      return 'Muster send outbox capacity reached.';
    case 'invariant':
      return 'Muster hit an internal storage invariant error.';
    case 'protocol':
      return 'Muster received an invalid SQLite worker protocol response.';
    case 'unknown':
    default:
      return 'Muster SQLite storage is temporarily unavailable.';
  }
}

export type SqliteRecoveryAction =
  | 'none'
  | 'retry'
  | 'reveal_storage'
  | 'free_disk_space'
  | 'check_permissions'
  | 'close_other_windows'
  | 'reload_window';

export function recoveryActionForCode(code: SqliteErrorCode): SqliteRecoveryAction {
  switch (code) {
    case 'busy':
      return 'retry';
    case 'full':
      return 'free_disk_space';
    case 'readonly':
      return 'check_permissions';
    case 'schema_changed':
      return 'reload_window';
    case 'corrupt':
    case 'not_a_database':
    case 'incompatible_schema':
    case 'nonempty_unclaimed':
    case 'foreign_database':
      return 'reveal_storage';
    default:
      return 'none';
  }
}

/** True for storage faults that must latch the client terminal (no further writes). */
export function isTerminalStorageCode(code: SqliteErrorCode): boolean {
  return (
    code === 'corrupt' ||
    code === 'not_a_database' ||
    code === 'schema_changed'
  );
}

export type SafeSerializedDbError = {
  name: string;
  code: SqliteErrorCode;
  operation: SqliteOperationClass;
  message: string;
  kind: SqliteErrorKind;
};

export class MusterSqliteError extends Error {
  readonly code: SqliteOperationalCode;
  readonly operation: SqliteOperationClass;
  readonly kind = 'operational' as const;

  constructor(code: SqliteOperationalCode, operation: SqliteOperationClass = 'unknown') {
    super(safeMessageForCode(code));
    this.name = SQLITE_ERROR_NAME;
    this.code = code;
    this.operation = operation;
  }
}

export class MusterDomainError extends Error {
  readonly code: SqliteDomainCode;
  readonly operation: SqliteOperationClass;
  readonly kind = 'domain' as const;

  constructor(code: SqliteDomainCode, operation: SqliteOperationClass = 'unknown') {
    super(safeMessageForCode(code));
    this.name = SQLITE_DOMAIN_NAME;
    this.code = code;
    this.operation = operation;
  }
}

export class MusterInvariantError extends Error {
  readonly code: SqliteInvariantCode;
  readonly operation: SqliteOperationClass;
  readonly kind = 'invariant' as const;

  constructor(code: SqliteInvariantCode = 'invariant', operation: SqliteOperationClass = 'unknown') {
    super(safeMessageForCode(code));
    this.name = SQLITE_INVARIANT_NAME;
    this.code = code;
    this.operation = operation;
  }
}

export type MusterBoundaryError =
  | MusterSqliteError
  | MusterDomainError
  | MusterInvariantError;

export function isSqliteErrorCode(value: unknown): value is SqliteErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

export function isSqliteOperationClass(value: unknown): value is SqliteOperationClass {
  return typeof value === 'string' && OP_SET.has(value);
}

export function isSqliteOperationalCode(value: unknown): value is SqliteOperationalCode {
  return typeof value === 'string' && OPERATIONAL_SET.has(value);
}

function primaryCodeFromError(error: {
  code?: unknown;
  errcode?: unknown;
  extendedCode?: unknown;
}): number | undefined {
  const errcode =
    typeof error.errcode === 'number'
      ? error.errcode
      : typeof error.extendedCode === 'number'
        ? error.extendedCode
        : undefined;
  if (typeof errcode === 'number' && Number.isFinite(errcode)) {
    return errcode & 0xff;
  }
  return undefined;
}

/**
 * Map a thrown value into the safe boundary taxonomy.
 * Prefers node:sqlite numeric primary codes (ERR_SQLITE_ERROR + errcode).
 */
export function mapToMusterSqliteError(
  error: unknown,
  operation: SqliteOperationClass = 'unknown',
): MusterBoundaryError {
  if (
    error instanceof MusterSqliteError ||
    error instanceof MusterDomainError ||
    error instanceof MusterInvariantError
  ) {
    return error;
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    operation?: unknown;
    errcode?: unknown;
    extendedCode?: unknown;
    errstr?: unknown;
  };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message =
    typeof candidate.message === 'string' ? candidate.message : String(error ?? '');
  const errstr = typeof candidate.errstr === 'string' ? candidate.errstr : '';
  const combined = `${code} ${message} ${errstr}`;
  const primary = primaryCodeFromError(candidate);

  if (name === 'ForeignDatabaseError' || code === 'foreign_database') {
    return new MusterSqliteError('foreign_database', operation === 'unknown' ? 'open' : operation);
  }
  if (name === 'IncompatibleSchemaError' || code === 'incompatible_schema') {
    return new MusterSqliteError(
      'incompatible_schema',
      operation === 'unknown' ? 'open' : operation,
    );
  }
  if (name === 'NonEmptyUnclaimedDatabaseError' || code === 'nonempty_unclaimed') {
    return new MusterSqliteError(
      'nonempty_unclaimed',
      operation === 'unknown' ? 'open' : operation,
    );
  }
  if (
    (name === SQLITE_ERROR_NAME || name === SQLITE_DOMAIN_NAME || name === SQLITE_INVARIANT_NAME) &&
    isSqliteErrorCode(code)
  ) {
    const op = isSqliteOperationClass(candidate.operation) ? candidate.operation : operation;
    if (DOMAIN_SET.has(code)) return new MusterDomainError(code as SqliteDomainCode, op);
    if (INVARIANT_SET.has(code)) return new MusterInvariantError(code as SqliteInvariantCode, op);
    return new MusterSqliteError(code as SqliteOperationalCode, op);
  }

  // Primary path: node:sqlite numeric primary result code.
  if (primary === SQLITE_PRIMARY.FULL || code === 'SQLITE_FULL') {
    return new MusterSqliteError('full', operation);
  }
  if (primary === SQLITE_PRIMARY.READONLY || code === 'SQLITE_READONLY') {
    return new MusterSqliteError('readonly', operation);
  }
  if (primary === SQLITE_PRIMARY.IOERR || code.startsWith('SQLITE_IOERR')) {
    return new MusterSqliteError('io', operation);
  }
  if (
    primary === SQLITE_PRIMARY.BUSY ||
    primary === SQLITE_PRIMARY.LOCKED ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === 'SQLITE_BUSY_SNAPSHOT'
  ) {
    return new MusterSqliteError('busy', operation);
  }
  if (primary === SQLITE_PRIMARY.NOTADB || code === 'SQLITE_NOTADB') {
    return new MusterSqliteError(
      'not_a_database',
      operation === 'unknown' ? 'open' : operation,
    );
  }
  if (primary === SQLITE_PRIMARY.CORRUPT || code === 'SQLITE_CORRUPT') {
    return new MusterSqliteError('corrupt', operation === 'unknown' ? 'open' : operation);
  }
  if (primary === SQLITE_PRIMARY.CONSTRAINT || code.startsWith('SQLITE_CONSTRAINT')) {
    // Writer-guard RAISE(ABORT, 'schema_changed') surfaces as CONSTRAINT_TRIGGER.
    if (/\bschema_changed\b/i.test(combined)) {
      return new MusterSqliteError('schema_changed', operation);
    }
    if (/capacity/i.test(combined)) {
      return new MusterDomainError('capacity', operation);
    }
    return new MusterDomainError('constraint', operation);
  }

  // Conservative message fallback (secondary only).
  // Stale v7 connections lack muster_writer_version(); treat as schema_changed fence.
  if (
    /\bschema_changed\b/i.test(combined) ||
    /no such function:\s*muster_writer_version/i.test(combined)
  ) {
    return new MusterSqliteError('schema_changed', operation);
  }
  if (/send outbox capacity reached/i.test(combined)) {
    return new MusterDomainError('capacity', operation);
  }
  if (/file is not a database|not a database|file is encrypted or is not a database/i.test(combined)) {
    return new MusterSqliteError(
      'not_a_database',
      operation === 'unknown' ? 'open' : operation,
    );
  }
  if (/database disk image is malformed/i.test(combined)) {
    return new MusterSqliteError('corrupt', operation === 'unknown' ? 'open' : operation);
  }
  if (/database or disk is full/i.test(combined)) {
    return new MusterSqliteError('full', operation);
  }
  if (/readonly database/i.test(combined)) {
    return new MusterSqliteError('readonly', operation);
  }
  if (/disk i\/o error|i\/o error/i.test(combined)) {
    return new MusterSqliteError('io', operation);
  }
  if (/database (?:table )?is locked|database is busy/i.test(combined)) {
    return new MusterSqliteError('busy', operation);
  }
  if (/unique constraint|foreign key constraint|constraint failed/i.test(combined)) {
    return new MusterDomainError('constraint', operation);
  }

  // Deliberate programmer/invariant Error — keep as invariant, not operational unknown.
  if (error instanceof Error && !code.startsWith('SQLITE_') && code !== 'ERR_SQLITE_ERROR') {
    return new MusterInvariantError('invariant', operation);
  }

  return new MusterSqliteError('unknown', operation);
}

export function serializeBoundaryError(
  error: MusterBoundaryError,
): SafeSerializedDbError {
  return {
    name: nameForKind(error.kind),
    code: error.code,
    operation: error.operation,
    message: error.message,
    kind: error.kind,
  };
}

export function serializeMusterError(
  error: unknown,
  operation: SqliteOperationClass = 'unknown',
): SafeSerializedDbError {
  return serializeBoundaryError(mapToMusterSqliteError(error, operation));
}

export function boundaryErrorFromPayload(payload: SafeSerializedDbError): MusterBoundaryError {
  if (payload.kind === 'domain') {
    return new MusterDomainError(payload.code as SqliteDomainCode, payload.operation);
  }
  if (payload.kind === 'invariant') {
    return new MusterInvariantError(payload.code as SqliteInvariantCode, payload.operation);
  }
  return new MusterSqliteError(payload.code as SqliteOperationalCode, payload.operation);
}

/** Explicit test/UAT fault plan (never read from ambient env in production). */
export type SqliteFaultPlan = {
  code: SqliteFaultCode;
  operation: SqliteOperationClass;
  remaining: number;
};

export function faultErrorForPlan(plan: SqliteFaultPlan): MusterSqliteError {
  return new MusterSqliteError(plan.code, plan.operation);
}

/**
 * Worker bootstrap capability. Production workers receive `{}`.
 * Test harnesses pass `{ faultCapability: true, faultPlan?: ... }` via workerData.
 */
export type SqliteWorkerData = {
  faultCapability?: boolean;
  faultPlan?: SqliteFaultPlan;
};
