/**
 * DB worker thread entrypoint (plan §3.4).
 *
 * Owns the single `DatabaseSync` connection for this extension-host process. All
 * SQLite work — which is synchronous and would otherwise freeze the VS Code event
 * loop under a `busy_timeout` stall — happens here. The host talks to it purely via
 * the typed {@link DbRequest}/{@link DbResponse} RPC over `parentPort`.
 *
 * A local FIFO is unnecessary: `worker_threads` delivers messages in order and this
 * handler is synchronous per message, so requests are already serialized. SQLite's
 * WAL coordinates writes ACROSS processes; this worker coordinates writes WITHIN
 * the process.
 */
import { parentPort } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { openStoreDatabase } from './connection';
import type { DbRequest, DbResponse, RunResult, SqlValue } from './rpc';
import { isAllowedReadPragma, serializeError } from './rpc';

if (!parentPort) {
  throw new Error('sqlite worker must be spawned as a worker_thread');
}
const port = parentPort;

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

function handle(req: DbRequest): DbResponse {
  switch (req.kind) {
    case 'open': {
      if (db) {
        db.close();
      }
      db = openStoreDatabase({ path: req.path, busyTimeoutMs: req.busyTimeoutMs });
      return { kind: 'ok', requestId: req.requestId };
    }
    case 'all': {
      const stmt = requireDb().prepare(req.sql);
      const rows = req.params && req.params.length > 0 ? stmt.all(...req.params) : stmt.all();
      return { kind: 'rows', requestId: req.requestId, rows };
    }
    case 'get': {
      const stmt = requireDb().prepare(req.sql);
      const row = req.params && req.params.length > 0 ? stmt.get(...req.params) : stmt.get();
      return { kind: 'row', requestId: req.requestId, row: row ?? null };
    }
    case 'run': {
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
            conn.exec('ROLLBACK');
            return { kind: 'transaction', requestId: req.requestId, results };
          }
        }
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
      // Closed allowlist: refuse any pragma name not explicitly permitted, so a
      // raw `PRAGMA ${string}` can never cross the RPC boundary (audit follow-up).
      if (!isAllowedReadPragma(req.pragma)) {
        throw new Error(`pragma not allowed: ${req.pragma}`);
      }
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
  try {
    port.postMessage(handle(req));
  } catch (error) {
    const serialized = serializeError(error);
    const response: DbResponse = {
      kind: 'error',
      requestId: req.requestId,
      message: serialized.message,
      code: serialized.code,
      name: serialized.name,
    };
    port.postMessage(response);
  }
});
