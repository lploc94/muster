/**
 * Host-side DB worker client (plan §3.4).
 *
 * Spawns the DB worker thread, sends typed {@link DbRequest}s, and resolves typed
 * responses as promises. This is the ONLY object the extension host uses to reach
 * SQLite — it never opens `DatabaseSync` on the main thread. Requests are matched
 * to responses by a monotonic `requestId`; the worker replies to each exactly once.
 *
 * The worker script path differs by runtime: compiled `dist/.../worker.js` in a
 * packaged extension, or the `.ts` source under tsx in tests/dev. The caller passes
 * the resolved path so this module stays environment-agnostic and testable.
 */
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  DbRequest,
  DbResponse,
  RunResult,
  SqlStatement,
  SqlValue,
} from './rpc';

/**
 * Resolve the DB worker script for the CURRENT runtime.
 *
 * In a packaged/compiled extension this module is `dist/.../sqlite/client.js` and
 * the worker sits next to it as `worker.js`. Under tsx (tests/dev) `__dirname` is
 * the `.ts` source dir and only `worker.ts` exists. We prefer the sibling `.js`
 * (production) and fall back to `.ts` (dev) so callers never hard-code a path that
 * only works in one runtime — the packaging correctness gap the audit flagged.
 */
export function resolveWorkerPath(dir: string = __dirname): string {
  const js = path.join(dir, 'worker.js');
  if (fs.existsSync(js)) {
    return js;
  }
  return path.join(dir, 'worker.ts');
}

/**
 * A request minus its `requestId`, preserving the discriminated union. A plain
 * `Omit<DbRequest, 'requestId'>` collapses the union and drops each variant's own
 * properties (`sql`, `path`, …), so it must be distributed over the union first.
 */
type PendingRequest = DbRequest extends infer R
  ? R extends { requestId: number }
    ? Omit<R, 'requestId'>
    : never
  : never;

export class DbWorkerError extends Error {
  constructor(readonly detail: { name: string; code?: string; message: string }) {
    super(detail.message);
    this.name = 'DbWorkerError';
  }
}

interface Pending {
  resolve: (value: DbResponse) => void;
  reject: (error: Error) => void;
}

export interface DbClientOptions {
  /** Resolved path to the worker script (dist worker.js in prod, worker.ts in tests). */
  workerPath: string;
  /** Optional execArgv for the worker (tests pass tsx loader flags). */
  execArgv?: string[];
}

export class DbClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private closed = false;
  private fatalError: Error | undefined;

  constructor(opts: DbClientOptions) {
    this.worker = new Worker(opts.workerPath, {
      ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
    });
    this.worker.on('message', (res: DbResponse) => this.onMessage(res));
    this.worker.on('error', (err: unknown) =>
      this.onFatal(err instanceof Error ? err : new Error(String(err))),
    );
    this.worker.on('exit', (code) => {
      if (code !== 0 && !this.closed) {
        this.onFatal(new Error(`sqlite worker exited unexpectedly with code ${code}`));
      }
    });
  }

  private onMessage(res: DbResponse): void {
    const pending = this.pending.get(res.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(res.requestId);
    if (res.kind === 'error') {
      pending.reject(new DbWorkerError({ name: res.name, code: res.code, message: res.message }));
      return;
    }
    pending.resolve(res);
  }

  /** Reject every in-flight request when the worker dies; no request hangs forever. */
  private onFatal(error: Error): void {
    this.fatalError = error;
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(req: PendingRequest): Promise<DbResponse> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    if (this.closed) {
      return Promise.reject(new Error('DbClient is closed'));
    }
    const requestId = this.nextRequestId++;
    const full = { ...req, requestId } as DbRequest;
    return new Promise<DbResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(full);
    });
  }

  async open(path: string, busyTimeoutMs?: number): Promise<void> {
    await this.send({ kind: 'open', path, ...(busyTimeoutMs ? { busyTimeoutMs } : {}) });
  }

  async all<T = unknown>(sql: string, params?: SqlValue[]): Promise<T[]> {
    const res = await this.send({ kind: 'all', sql, ...(params ? { params } : {}) });
    return res.kind === 'rows' ? (res.rows as T[]) : [];
  }

  async get<T = unknown>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
    const res = await this.send({ kind: 'get', sql, ...(params ? { params } : {}) });
    if (res.kind === 'row') {
      return (res.row as T | null) ?? undefined;
    }
    return undefined;
  }

  async run(sql: string, params?: SqlValue[]): Promise<RunResult> {
    const res = await this.send({ kind: 'run', sql, ...(params ? { params } : {}) });
    return res.kind === 'run' ? res.result : { changes: 0, lastInsertRowid: 0 };
  }

  /** Run an ordered statement batch inside one IMMEDIATE transaction (all-or-nothing). */
  async transaction(statements: SqlStatement[]): Promise<void> {
    await this.send({ kind: 'transaction', statements });
  }

  async pragma(pragma: string): Promise<number> {
    const res = await this.send({ kind: 'pragma', pragma });
    return res.kind === 'scalar' ? res.value : 0;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.send({ kind: 'close' });
    } catch {
      // worker may already be gone; terminate regardless
    }
    this.closed = true;
    await this.worker.terminate();
  }
}
