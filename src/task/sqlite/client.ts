/**
 * Host-side DB worker client (plan §3.4).
 *
 * Spawns the DB worker thread, sends typed {@link DbRequest}s, and resolves typed
 * responses as promises. This is the ONLY object the extension host uses to reach
 * SQLite — it never opens `DatabaseSync` on the main thread.
 */
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  BackupResultMeta,
  DbRequest,
  DbResponse,
  RunResult,
  SqlStatement,
  SqlValue,
} from './rpc';
import {
  MusterSqliteError,
  isTerminalStorageCode,
  mapToMusterSqliteError,
  type SafeSerializedDbError,
  type SqliteFaultPlan,
  type SqliteWorkerData,
} from './errors';
import {
  makeProtocolError,
  parseWireErrorResponse,
  parseWireSuccessResponse,
} from './protocol';

/**
 * Resolve the DB worker script for the CURRENT runtime.
 */
export function resolveWorkerPath(dir: string = __dirname): string {
  const js = path.join(dir, 'worker.js');
  if (fs.existsSync(js)) {
    return js;
  }
  return path.join(dir, 'worker.ts');
}

type PendingRequest = DbRequest extends infer R
  ? R extends { requestId: number }
    ? Omit<R, 'requestId'>
    : never
  : never;

export class DbWorkerError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly kind: string;

  constructor(readonly detail: SafeSerializedDbError) {
    super(detail.message);
    this.name = 'DbWorkerError';
    this.code = detail.code;
    this.operation = detail.operation;
    this.kind = detail.kind;
  }
}

interface Pending {
  resolve: (value: DbResponse) => void;
  reject: (error: Error) => void;
}

export interface DbClientOptions {
  workerPath: string;
  execArgv?: string[];
  /**
   * Explicit test/UAT fault capability. Production callers never set this.
   * Ambient MUSTER_SQLITE_FAULT_* env is ignored without this flag.
   */
  faultCapability?: boolean;
  faultPlan?: SqliteFaultPlan;
  /** Called once when storage latches terminal (corrupt / not_a_database / protocol). */
  onTerminalStorageError?: (error: DbWorkerError) => void;
}

export class DbClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private closed = false;
  /** First latched fatal wins; never overwritten by exit/unknown. */
  private fatalError: DbWorkerError | undefined;
  private terminalNotified = false;
  private intentionalTerminate = false;
  private readonly onTerminalStorageError?: (error: DbWorkerError) => void;
  private readonly faultCapability: boolean;

  constructor(opts: DbClientOptions) {
    this.faultCapability = opts.faultCapability === true;
    this.onTerminalStorageError = opts.onTerminalStorageError;
    const data: SqliteWorkerData = this.faultCapability
      ? {
          faultCapability: true,
          ...(opts.faultPlan ? { faultPlan: opts.faultPlan } : {}),
        }
      : {};
    this.worker = new Worker(opts.workerPath, {
      ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
      workerData: data,
    });
    this.worker.on('message', (res: unknown) => this.onMessage(res));
    this.worker.on('error', (err: unknown) => this.onFatal(err, { fromWorker: true }));
    this.worker.on('exit', (code) => {
      if (this.intentionalTerminate || this.closed) {
        return;
      }
      // Unexpected exit (including clean code 0) must fail closed and reject pending.
      this.onFatal(new MusterSqliteError('unknown', 'unknown'), { fromWorker: true });
      void code;
    });
  }

  private sanitizeFatal(error: unknown): DbWorkerError {
    const mapped = mapToMusterSqliteError(error, 'unknown');
    return new DbWorkerError({
      name: mapped.name,
      code: mapped.code,
      operation: mapped.operation,
      message: mapped.message,
      kind: mapped.kind,
    });
  }

  private notifyTerminalOnce(error: DbWorkerError): void {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    try {
      this.onTerminalStorageError?.(error);
    } catch {
      // Host callback must never break the latch path.
    }
  }

  /**
   * Latch first fatal. Intentional terminate after latch does not overwrite.
   * Terminal storage codes and protocol fatals both latch.
   * Every pending request is rejected with the same first-fatal error.
   */
  private latchFatal(error: DbWorkerError, options?: { terminate?: boolean }): void {
    if (this.fatalError) {
      // First fatal wins — never overwrite corrupt with unknown.
      this.rejectAll(this.fatalError);
      return;
    }
    this.fatalError = error;
    this.notifyTerminalOnce(error);
    this.rejectAll(error);
    if (options?.terminate !== false) {
      this.intentionalTerminate = true;
      void this.worker.terminate();
    }
  }

  private rejectAll(error: DbWorkerError): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onFatal(error: unknown, _meta?: { fromWorker?: boolean }): void {
    if (this.fatalError) {
      // Already latched — reject any stragglers with the original code.
      this.rejectAll(this.fatalError);
      return;
    }
    const safe = this.sanitizeFatal(error);
    this.latchFatal(safe, { terminate: false });
    this.rejectAll(safe);
  }

  private onMessage(raw: unknown): void {
    // Error envelope?
    if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'error') {
      const parsed = parseWireErrorResponse(raw);
      if (!parsed.ok) {
        const err = new DbWorkerError(parsed.payload);
        this.latchFatal(err);
        this.rejectAll(err);
        return;
      }
      const pending = this.pending.get(parsed.requestId);
      if (!pending) {
        // Stale/unknown response id after fatal is ignored; otherwise protocol.
        if (!this.fatalError) {
          const err = new DbWorkerError(makeProtocolError());
          this.latchFatal(err);
          this.rejectAll(err);
        }
        return;
      }
      this.pending.delete(parsed.requestId);
      const err = new DbWorkerError(parsed.payload);
      // Artifact verification failures on backup must not latch the live source
      // client (P5-W4): corrupt/not_a_database there refers to the temp artifact.
      const terminalBackupArtifact =
        parsed.payload.operation === 'backup' &&
        isTerminalStorageCode(parsed.payload.code);
      if (
        (isTerminalStorageCode(parsed.payload.code) || parsed.payload.code === 'protocol') &&
        !terminalBackupArtifact
      ) {
        // Re-queue current request so latchFatal rejectAll settles it with peers.
        this.pending.set(parsed.requestId, pending);
        this.latchFatal(err);
        return;
      }
      pending.reject(err);
      return;
    }

    const success = parseWireSuccessResponse(raw);
    if (!success.ok) {
      const err = new DbWorkerError(success.payload);
      this.latchFatal(err);
      this.rejectAll(err);
      return;
    }
    const res = success.response;
    const pending = this.pending.get(res.requestId);
    if (!pending) {
      if (!this.fatalError) {
        const err = new DbWorkerError(makeProtocolError());
        this.latchFatal(err);
        this.rejectAll(err);
      }
      return;
    }
    this.pending.delete(res.requestId);
    pending.resolve(res);
  }

  private send(req: PendingRequest): Promise<DbResponse> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    if (this.closed) {
      return Promise.reject(
        new DbWorkerError({
          name: 'MusterInvariantError',
          code: 'invariant',
          operation: 'close',
          message: 'Muster hit an internal storage invariant error.',
          kind: 'invariant',
        }),
      );
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
    if (res.kind !== 'rows') {
      throw new DbWorkerError(makeProtocolError());
    }
    return res.rows as T[];
  }

  async get<T = unknown>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
    const res = await this.send({ kind: 'get', sql, ...(params ? { params } : {}) });
    if (res.kind !== 'row') {
      throw new DbWorkerError(makeProtocolError());
    }
    return (res.row as T | null) ?? undefined;
  }

  async run(sql: string, params?: SqlValue[]): Promise<RunResult> {
    const res = await this.send({ kind: 'run', sql, ...(params ? { params } : {}) });
    if (res.kind !== 'run') {
      throw new DbWorkerError(makeProtocolError());
    }
    return res.result;
  }

  async transaction(
    statements: SqlStatement[],
    options: { abortIfFirstUnchanged?: boolean; abortIfUnchangedAt?: number[] } = {},
  ): Promise<RunResult[]> {
    const res = await this.send({ kind: 'transaction', statements, ...options });
    if (res.kind !== 'transaction') {
      throw new DbWorkerError(makeProtocolError());
    }
    return res.results;
  }

  async pragma(pragma: string): Promise<number> {
    const res = await this.send({ kind: 'pragma', pragma });
    if (res.kind !== 'scalar') {
      throw new DbWorkerError(makeProtocolError());
    }
    return res.value;
  }

  /**
   * SQLite-aware live backup (P5-W4). All SQLite/filesystem work runs in the
   * worker. Returns only redacted metadata — never paths or row content.
   *
   * `cancellationFlag` is a request-scoped SharedArrayBuffer holding one Int32
   * (0=run, non-zero=cancel). The host marks it with Atomics.store; the worker
   * observes it before work, during native progress, and before publication.
   */
  async backup(
    destinationPath: string,
    options: {
      overwrite?: boolean;
      cancellationFlag?: SharedArrayBuffer;
      /** Test/UAT only — ignored without faultCapability. */
      forceMechanism?: 'api' | 'vacuum';
      armCancelAfterSnapshot?: boolean;
      corruptBeforeVerify?: boolean;
      failBeforePublish?: boolean;
      failDuringPublish?: boolean;
      progressFlag?: SharedArrayBuffer;
    } = {},
  ): Promise<BackupResultMeta> {
    const res = await this.send({
      kind: 'backup',
      destinationPath,
      overwrite: options.overwrite === true,
      ...(options.cancellationFlag ? { cancellationFlag: options.cancellationFlag } : {}),
      ...(this.faultCapability && options.forceMechanism
        ? { forceMechanism: options.forceMechanism }
        : {}),
      ...(this.faultCapability && options.armCancelAfterSnapshot
        ? { armCancelAfterSnapshot: true }
        : {}),
      ...(this.faultCapability && options.corruptBeforeVerify
        ? { corruptBeforeVerify: true }
        : {}),
      ...(this.faultCapability && options.failBeforePublish
        ? { failBeforePublish: true }
        : {}),
      ...(this.faultCapability && options.failDuringPublish
        ? { failDuringPublish: true }
        : {}),
      ...(this.faultCapability && options.progressFlag
        ? { progressFlag: options.progressFlag }
        : {}),
    });
    if (res.kind !== 'backup') {
      throw new DbWorkerError(makeProtocolError());
    }
    return res.result;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      if (!this.fatalError) {
        await this.send({ kind: 'close' });
      }
    } catch {
      // worker may already be gone
    }
    this.closed = true;
    this.intentionalTerminate = true;
    await this.worker.terminate();
  }
}
