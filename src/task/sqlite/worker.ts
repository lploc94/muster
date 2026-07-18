/**
 * DB worker thread entrypoint (plan §3.4).
 *
 * Owns the single `DatabaseSync` connection for this extension-host process. All
 * SQLite work — which is synchronous and would otherwise freeze the VS Code event
 * loop under a `busy_timeout` stall — happens here. The host talks to it purely via
 * the typed {@link DbRequest}/{@link DbResponse} RPC over `parentPort`.
 *
 * Backup (P5-W4) may await the native `node:sqlite.backup` Promise; FIFO ordering
 * is preserved by serializing message handling (one in-flight handle at a time).
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { openStoreDatabase } from './connection';
import { backupOpenDatabase } from './backup';
import type { DbRequest, DbResponse, RunResult, SqlValue } from './rpc';
import { isAllowedReadPragma, serializeError } from './rpc';
import type { SqliteOperationClass, SqliteWorkerData } from './errors';
import { MusterInvariantError } from './errors';
import { bootstrapFaultCapability, isFaultCapabilityEnabled, maybeInjectFault } from './fault-inject';

if (!parentPort) {
  throw new Error('sqlite worker must be spawned as a worker_thread');
}
const port = parentPort;

bootstrapFaultCapability(workerData as SqliteWorkerData | undefined);

let db: DatabaseSync | undefined;
/** Path of the currently open store (needed for backup source-identity checks). */
let openPath: string | undefined;
/** Serialize handlers so async backup does not interleave with other RPC. */
let chain: Promise<void> = Promise.resolve();

function normalizeRowid(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function requireDb(): DatabaseSync {
  if (!db) {
    throw new Error('database not open');
  }
  return db;
}

function runStatement(sql: string, params: SqlValue[] | undefined): RunResult {
  const stmt = requireDb().prepare(sql);
  const info = params && params.length > 0 ? stmt.run(...params) : stmt.run();
  return {
    changes: normalizeRowid(info.changes),
    lastInsertRowid: normalizeRowid(info.lastInsertRowid),
  };
}

function operationFor(req: DbRequest): SqliteOperationClass {
  switch (req.kind) {
    case 'open':
      return 'open';
    case 'close':
      return 'close';
    case 'pragma':
      return 'pragma';
    case 'all':
    case 'get':
      return 'read';
    case 'run':
      return 'write';
    case 'transaction':
      return 'transaction';
    case 'backup':
      return 'backup';
    default: {
      const _exhaustive: never = req;
      return _exhaustive;
    }
  }
}

/**
 * Exact backup-request guard (P5-W4). Rejects extra keys and invalid optional
 * fields before any filesystem/SQLite work.
 */
function parseBackupRequest(req: Extract<DbRequest, { kind: 'backup' }>): {
  destinationPath: string;
  overwrite: boolean;
  cancellationFlag?: SharedArrayBuffer;
  forceMechanism?: 'api' | 'vacuum';
  armCancelAfterSnapshot?: boolean;
  corruptBeforeVerify?: boolean;
  failBeforePublish?: boolean;
  failDuringPublish?: boolean;
  progressFlag?: SharedArrayBuffer;
} {
  const allowed = new Set([
    'kind',
    'requestId',
    'destinationPath',
    'overwrite',
    'cancellationFlag',
    'forceMechanism',
    'armCancelAfterSnapshot',
    'corruptBeforeVerify',
    'failBeforePublish',
    'failDuringPublish',
    'progressFlag',
  ]);
  for (const key of Object.keys(req)) {
    if (!allowed.has(key)) {
      throw new MusterInvariantError('protocol', 'backup');
    }
  }
  if (!Number.isSafeInteger(req.requestId) || req.requestId < 1) {
    throw new MusterInvariantError('protocol', 'backup');
  }
  if (typeof req.destinationPath !== 'string' || req.destinationPath.trim() === '') {
    throw new MusterInvariantError('protocol', 'backup');
  }
  if (typeof req.overwrite !== 'boolean') {
    throw new MusterInvariantError('protocol', 'backup');
  }
  let cancellationFlag: SharedArrayBuffer | undefined;
  if (req.cancellationFlag !== undefined) {
    if (!(req.cancellationFlag instanceof SharedArrayBuffer)) {
      throw new MusterInvariantError('protocol', 'backup');
    }
    if (req.cancellationFlag.byteLength !== Int32Array.BYTES_PER_ELEMENT) {
      throw new MusterInvariantError('protocol', 'backup');
    }
    cancellationFlag = req.cancellationFlag;
  }
  let progressFlag: SharedArrayBuffer | undefined;
  if (req.progressFlag !== undefined) {
    if (!(req.progressFlag instanceof SharedArrayBuffer)) {
      throw new MusterInvariantError('protocol', 'backup');
    }
    if (req.progressFlag.byteLength !== Int32Array.BYTES_PER_ELEMENT) {
      throw new MusterInvariantError('protocol', 'backup');
    }
    progressFlag = req.progressFlag;
  }
  if (
    req.forceMechanism !== undefined &&
    req.forceMechanism !== 'api' &&
    req.forceMechanism !== 'vacuum'
  ) {
    throw new MusterInvariantError('protocol', 'backup');
  }
  for (const flag of [
    'armCancelAfterSnapshot',
    'corruptBeforeVerify',
    'failBeforePublish',
    'failDuringPublish',
  ] as const) {
    const value = req[flag];
    if (value !== undefined && value !== true) {
      throw new MusterInvariantError('protocol', 'backup');
    }
  }
  return {
    destinationPath: req.destinationPath,
    overwrite: req.overwrite,
    ...(cancellationFlag ? { cancellationFlag } : {}),
    ...(req.forceMechanism ? { forceMechanism: req.forceMechanism } : {}),
    ...(req.armCancelAfterSnapshot ? { armCancelAfterSnapshot: true } : {}),
    ...(req.corruptBeforeVerify ? { corruptBeforeVerify: true } : {}),
    ...(req.failBeforePublish ? { failBeforePublish: true } : {}),
    ...(req.failDuringPublish ? { failDuringPublish: true } : {}),
    ...(progressFlag ? { progressFlag } : {}),
  };
}

async function handle(req: DbRequest): Promise<DbResponse> {
  switch (req.kind) {
    case 'open': {
      maybeInjectFault('open');
      if (db) {
        db.close();
        db = undefined;
        openPath = undefined;
      }
      db = openStoreDatabase({ path: req.path, busyTimeoutMs: req.busyTimeoutMs });
      openPath = req.path;
      return { kind: 'ok', requestId: req.requestId };
    }
    case 'all': {
      maybeInjectFault('read');
      const stmt = requireDb().prepare(req.sql);
      const rows = req.params && req.params.length > 0 ? stmt.all(...req.params) : stmt.all();
      return { kind: 'rows', requestId: req.requestId, rows };
    }
    case 'get': {
      maybeInjectFault('read');
      const stmt = requireDb().prepare(req.sql);
      const row = req.params && req.params.length > 0 ? stmt.get(...req.params) : stmt.get();
      return { kind: 'row', requestId: req.requestId, row: row ?? null };
    }
    case 'run': {
      maybeInjectFault('write');
      return { kind: 'run', requestId: req.requestId, result: runStatement(req.sql, req.params) };
    }
    case 'transaction': {
      const conn = requireDb();
      // IMMEDIATE acquires the write lock up front so a busy DB fails fast into the
      // busy_timeout wait rather than mid-batch after partial work.
      conn.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const results: RunResult[] = [];
        for (const stmt of req.statements) {
          results.push(runStatement(stmt.sql, stmt.params));
          const shouldAbort =
            (req.abortIfFirstUnchanged && results.length === 1 && results[0]?.changes === 0) ||
            (req.abortIfUnchangedAt?.includes(results.length - 1) && results.at(-1)?.changes === 0);
          if (shouldAbort) {
            // Conditional no-op: rollback before any commit-boundary fault.
            conn.exec('ROLLBACK');
            return { kind: 'transaction', requestId: req.requestId, results };
          }
        }
        // Commit-boundary fault: statements already ran inside the open txn so
        // rollback proves real write-path durability (P5-W3).
        maybeInjectFault('transaction');
        conn.exec('COMMIT');
        return { kind: 'transaction', requestId: req.requestId, results };
      } catch (error) {
        try {
          conn.exec('ROLLBACK');
        } catch {
          // ignore rollback failure — the original error is the real signal
        }
        throw error;
      }
    }
    case 'pragma': {
      if (!isAllowedReadPragma(req.pragma)) {
        throw new Error(`pragma not allowed: ${req.pragma}`);
      }
      maybeInjectFault('pragma');
      const row = requireDb().prepare(`PRAGMA ${req.pragma}`).get() as
        | Record<string, number>
        | undefined;
      const value = row ? (Object.values(row)[0] as number) : 0;
      return { kind: 'scalar', requestId: req.requestId, value: typeof value === 'number' ? value : 0 };
    }
    case 'backup': {
      const conn = requireDb();
      if (!openPath) {
        throw new MusterInvariantError('invariant', 'backup');
      }
      const parsed = parseBackupRequest(req);
      const testOpts = isFaultCapabilityEnabled()
        ? {
            ...(parsed.forceMechanism ? { forceMechanism: parsed.forceMechanism } : {}),
            ...(parsed.armCancelAfterSnapshot ? { armCancelAfterSnapshot: true } : {}),
            ...(parsed.corruptBeforeVerify ? { corruptBeforeVerify: true } : {}),
            ...(parsed.failBeforePublish ? { failBeforePublish: true } : {}),
            ...(parsed.failDuringPublish ? { failDuringPublish: true } : {}),
            ...(parsed.progressFlag ? { progressFlag: parsed.progressFlag } : {}),
          }
        : {};
      const result = await backupOpenDatabase(conn, openPath, {
        destinationPath: parsed.destinationPath,
        overwrite: parsed.overwrite,
        ...(parsed.cancellationFlag ? { cancellationFlag: parsed.cancellationFlag } : {}),
        ...testOpts,
      });
      return { kind: 'backup', requestId: req.requestId, result };
    }
    case 'close': {
      if (db) {
        db.close();
        db = undefined;
        openPath = undefined;
      }
      return { kind: 'ok', requestId: req.requestId };
    }
    default: {
      const _exhaustive: never = req;
      return _exhaustive;
    }
  }
}

port.on('message', (req: DbRequest) => {
  const operation = operationFor(req);
  chain = chain
    .then(async () => {
      try {
        port.postMessage(await handle(req));
      } catch (error) {
        const serialized = serializeError(error, operation);
        const response: DbResponse = {
          kind: 'error',
          requestId: req.requestId,
          message: serialized.message,
          code: serialized.code,
          name: serialized.name,
          operation: serialized.operation,
          errorKind: serialized.errorKind,
        };
        port.postMessage(response);
      }
    })
    .catch(() => {
      // Individual request errors are already posted; keep the chain alive.
    });
});
