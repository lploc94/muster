/**
 * DB worker thread entrypoint (plan §3.4).
 *
 * Owns the single `DatabaseSync` connection for this extension-host process. All
 * SQLite work — which is synchronous and would otherwise freeze the VS Code event
 * loop under a `busy_timeout` stall — happens here. The host talks to it purely via
 * the typed {@link DbRequest}/{@link DbResponse} RPC over `parentPort`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { openStoreDatabase } from './connection';
import type { DbRequest, DbResponse, RunResult, SqlValue } from './rpc';
import { isAllowedReadPragma, serializeError } from './rpc';
import type { SqliteOperationClass, SqliteWorkerData } from './errors';
import { bootstrapFaultCapability, maybeInjectFault } from './fault-inject';

if (!parentPort) {
  throw new Error('sqlite worker must be spawned as a worker_thread');
}
const port = parentPort;

bootstrapFaultCapability(workerData as SqliteWorkerData | undefined);

let db: DatabaseSync | undefined;

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
    default: {
      const _exhaustive: never = req;
      return _exhaustive;
    }
  }
}

function handle(req: DbRequest): DbResponse {
  switch (req.kind) {
    case 'open': {
      maybeInjectFault('open');
      if (db) {
        db.close();
      }
      db = openStoreDatabase({ path: req.path, busyTimeoutMs: req.busyTimeoutMs });
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
    case 'close': {
      if (db) {
        db.close();
        db = undefined;
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
  try {
    port.postMessage(handle(req));
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
});
