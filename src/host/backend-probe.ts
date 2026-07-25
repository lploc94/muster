/**
 * Host-only BackendProbeService (M019/S02).
 *
 * Runs an isolated, user-triggered Test Connection against one backend:
 * executable → version → ACP initialize/auth → throwaway session → model catalog.
 *
 * Isolation contract:
 * - Own AcpClient per probe via injected `createClient` factory (never
 *   getSharedAcpClient / peekSharedAcpClient).
 * - Never calls session/prompt.
 * - Never imports task engine/store/repository/outbox/model-catalog modules.
 * - Always disposes the client (success, failure, timeout, cancel, disposeAll).
 * - Single-flight per backend; global concurrency cap of 2.
 * - Bounded per-stage and total deadlines.
 * - Result payloads are closed enums + bounded version evidence only.
 */

import {
  BACKEND_PROBE_SCHEMA_VERSION,
  type BackendProbeProgress,
  type BackendProbeResult,
  type BackendProbeStage,
} from '../shared/backend-probe';
import type {
  BackendCompatibilityStatus,
  BackendReadinessCode,
  BackendReadinessId,
  BackendRecoveryAction,
} from '../shared/backend-readiness';
import {
  commandResolves as defaultCommandResolves,
  resolveBackendCommand,
} from './backend-availability';
import {
  classifyCompatibility as defaultClassifyCompatibility,
  collectBackendVersion,
  type CompatibilityPolicy,
  type VersionCollectResult,
} from './backend-version';
import * as path from 'path';

/** Per-stage deadline for active ACP/version work (ms). */
export const PROBE_STAGE_TIMEOUT_MS = 15_000;

/** Total wall-clock deadline for one probe (ms). */
export const PROBE_TOTAL_TIMEOUT_MS = 45_000;

/** Max concurrent probe processes across all backends. */
export const PROBE_GLOBAL_CONCURRENCY = 2;

/**
 * Minimal ACP client surface the probe needs.
 * Intentionally omits shared-client helpers and keeps prompt optional so
 * production clients satisfy the type while tests can spy on misuse.
 */
export interface ProbeAcpClient {
  ensureConnected(extraEnv?: Record<string, string>): Promise<void>;
  newSession(
    cwd: string,
    mcpServers: readonly unknown[],
    timeoutMs?: number,
  ): Promise<{
    sessionId: string;
    modelConfig?: {
      id: string;
      options?: readonly { value: string; name: string }[];
    };
  }>;
  closeSession?(sessionId: string): Promise<void>;
  dispose(): void;
  /** Must never be invoked by the probe; present only for isolation spies. */
  prompt?(...args: unknown[]): unknown;
}

export interface BackendProbeServiceDeps {
  pathDirs: () => string[];
  resolveCommand: (id: BackendReadinessId) => string;
  commandResolves: (command: string, dirs: string[]) => boolean;
  collectVersion: (
    backendId: BackendReadinessId,
    command: string,
  ) => Promise<VersionCollectResult>;
  classifyCompatibility: (
    backendId: BackendReadinessId,
    version: string | null,
  ) => BackendCompatibilityStatus;
  /** Factory that constructs an OWNED AcpClient for this probe (never shared). */
  createClient: (backendId: BackendReadinessId) => ProbeAcpClient;
  resolveCwd: () => string;
  now: () => Date;
  stageTimeoutMs?: number;
  totalTimeoutMs?: number;
  globalConcurrency?: number;
  /** Bounded host console warning sink (defaults to console.warn). */
  warn?: (message: string) => void;
}

export interface StartBackendProbeInput {
  probeId: string;
  backendId: BackendReadinessId;
  onProgress?: (progress: BackendProbeProgress) => void;
  signal?: AbortSignal;
}

interface InFlightEntry {
  probeId: string;
  backendId: BackendReadinessId;
  promise: Promise<BackendProbeResult>;
  controller: AbortController;
}

/**
 * Production deps: inventory + version from S01, isolated AcpClient factory.
 * Callers must supply `createClient` (typically `new AcpClient(configFor(id))`)
 * so this module never imports shared-client helpers or model-catalog.
 */
export function createDefaultBackendProbeDeps(options: {
  createClient: (backendId: BackendReadinessId) => ProbeAcpClient;
  resolveCwd: () => string;
  compatibilityPolicy?: CompatibilityPolicy;
  warn?: (message: string) => void;
}): BackendProbeServiceDeps {
  const policy = options.compatibilityPolicy;
  return {
    pathDirs: () => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    resolveCommand: resolveBackendCommand,
    commandResolves: defaultCommandResolves,
    collectVersion: (backendId, command) => collectBackendVersion({ backendId, command }),
    classifyCompatibility: (backendId, version) =>
      defaultClassifyCompatibility(backendId, version, policy),
    createClient: options.createClient,
    resolveCwd: options.resolveCwd,
    now: () => new Date(),
    stageTimeoutMs: PROBE_STAGE_TIMEOUT_MS,
    totalTimeoutMs: PROBE_TOTAL_TIMEOUT_MS,
    globalConcurrency: PROBE_GLOBAL_CONCURRENCY,
    warn: options.warn ?? ((msg) => console.warn(msg)),
  };
}

function isAuthErrorMessage(message: string): boolean {
  return (
    /\blogin\b/i.test(message) ||
    /\bauth(?:enticate|entication)?\b/i.test(message) ||
    /\bcredential/i.test(message) ||
    /\bapi[-_]?key\b/i.test(message) ||
    /\bnot authenticated\b/i.test(message) ||
    /\bunauthori[sz]ed\b/i.test(message)
  );
}

function isProcessExitMessage(message: string): boolean {
  return /\bexited\b/i.test(message) || /\bexit(?:ed)? \(code/i.test(message);
}

function isTimeoutMessage(message: string): boolean {
  return /\btimeout\b/i.test(message) || /\btimed out\b/i.test(message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

class ProbeAbortError extends Error {
  readonly kind: 'cancelled' | 'timeout';
  constructor(kind: 'cancelled' | 'timeout', message: string) {
    super(message);
    this.name = 'ProbeAbortError';
    this.kind = kind;
  }
}

function makeResult(input: {
  probeId: string;
  backendId: BackendReadinessId;
  outcome: BackendProbeResult['outcome'];
  code: BackendReadinessCode;
  recoveryAction: BackendRecoveryAction;
  compatibility: BackendCompatibilityStatus;
  versionEvidence: string | null;
  lastStage: BackendProbeStage;
  modelCatalogAvailable: boolean;
  checkedAt: string;
}): BackendProbeResult {
  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: input.probeId,
    backendId: input.backendId,
    outcome: input.outcome,
    code: input.code,
    recoveryAction: input.recoveryAction,
    compatibility: input.compatibility,
    versionEvidence: input.versionEvidence,
    lastStage: input.lastStage,
    modelCatalogAvailable: input.modelCatalogAvailable,
    checkedAt: input.checkedAt,
  };
}

/**
 * Host-only active probe service.
 *
 * - start(): runs one isolated probe (or joins the in-flight one for that backend)
 * - cancel(backendId): aborts the in-flight probe
 * - disposeAll(): aborts every in-flight probe (extension deactivate / webview dispose)
 * - isInFlight(backendId): observability for single-flight map
 */
export class BackendProbeService {
  private readonly inFlight = new Map<BackendReadinessId, InFlightEntry>();
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly stageTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly globalConcurrency: number;
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: BackendProbeServiceDeps) {
    this.stageTimeoutMs = deps.stageTimeoutMs ?? PROBE_STAGE_TIMEOUT_MS;
    this.totalTimeoutMs = deps.totalTimeoutMs ?? PROBE_TOTAL_TIMEOUT_MS;
    this.globalConcurrency = deps.globalConcurrency ?? PROBE_GLOBAL_CONCURRENCY;
    this.warn = deps.warn ?? ((msg) => console.warn(msg));
  }

  isInFlight(backendId: BackendReadinessId): boolean {
    return this.inFlight.has(backendId);
  }

  /**
   * Start (or join) a probe for `backendId`.
   * Duplicate starts for the same backend join the in-flight promise and report
   * that probe's identity rather than spawning a second process.
   */
  start(input: StartBackendProbeInput): Promise<BackendProbeResult> {
    const existing = this.inFlight.get(input.backendId);
    if (existing) {
      return existing.promise;
    }

    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const entry: InFlightEntry = {
      probeId: input.probeId,
      backendId: input.backendId,
      controller,
      promise: null as unknown as Promise<BackendProbeResult>,
    };

    const promise = this.runProbe(input, controller.signal).finally(() => {
      const current = this.inFlight.get(input.backendId);
      if (current === entry) {
        this.inFlight.delete(input.backendId);
      }
    });

    entry.promise = promise;
    this.inFlight.set(input.backendId, entry);
    return promise;
  }

  /** Abort the in-flight probe for this backend. Returns true if one was active. */
  cancel(backendId: BackendReadinessId): boolean {
    const entry = this.inFlight.get(backendId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Abort every in-flight probe (extension deactivate / webview replacement). */
  disposeAll(): void {
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (this.activeCount < this.globalConcurrency) {
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const tryAcquire = (): void => {
        if (signal.aborted) {
          reject(new ProbeAbortError('cancelled', 'probe cancelled while waiting for slot'));
          return;
        }
        if (this.activeCount < this.globalConcurrency) {
          this.activeCount += 1;
          resolve();
          return;
        }
        this.waiters.push(tryAcquire);
      };
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(tryAcquire);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new ProbeAbortError('cancelled', 'probe cancelled while waiting for slot'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(tryAcquire);
      // Re-check in case a slot freed between the initial check and push.
      if (this.activeCount < this.globalConcurrency) {
        const idx = this.waiters.indexOf(tryAcquire);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          signal.removeEventListener('abort', onAbort);
          this.activeCount += 1;
          resolve();
        }
      }
    });
  }

  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  private emitProgress(
    input: StartBackendProbeInput,
    stage: BackendProbeStage,
  ): void {
    const progress: BackendProbeProgress = {
      schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
      probeId: input.probeId,
      backendId: input.backendId,
      stage,
      startedAt: this.deps.now().toISOString(),
    };
    try {
      input.onProgress?.(progress);
    } catch {
      // Progress listeners must not break the probe.
    }
  }

  private warnFailure(
    backendId: BackendReadinessId,
    stage: BackendProbeStage,
    code: BackendReadinessCode,
  ): void {
    // Bounded: backend id + stage + stable code only — never raw error/stderr/paths.
    this.warn(
      `Muster: backend probe failed backend=${backendId} stage=${stage} code=${code}`,
    );
  }

  private async withDeadlines<T>(
    work: Promise<T>,
    signal: AbortSignal,
    stageTimeoutMs: number,
    totalDeadlineAt: number,
  ): Promise<T> {
    if (signal.aborted) {
      throw new ProbeAbortError('cancelled', 'probe cancelled');
    }
    const remainingTotal = Math.max(1, totalDeadlineAt - Date.now());
    const budget = Math.min(stageTimeoutMs, remainingTotal);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = (): void => {
        finish(() => reject(new ProbeAbortError('cancelled', 'probe cancelled')));
      };
      const timer = setTimeout(() => {
        finish(() => reject(new ProbeAbortError('timeout', 'probe stage timed out')));
      }, budget);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(err)),
      );
    });
  }

  private async runProbe(
    input: StartBackendProbeInput,
    signal: AbortSignal,
  ): Promise<BackendProbeResult> {
    const checkedAt = this.deps.now().toISOString();
    const totalDeadlineAt = Date.now() + this.totalTimeoutMs;
    let lastStage: BackendProbeStage = 'executable';
    let versionEvidence: string | null = null;
    let compatibility: BackendCompatibilityStatus = 'unknown';
    let client: ProbeAcpClient | null = null;
    let slotHeld = false;

    const fail = (
      outcome: BackendProbeResult['outcome'],
      code: BackendReadinessCode,
      recoveryAction: BackendRecoveryAction,
      stage: BackendProbeStage,
      opts?: { modelCatalogAvailable?: boolean },
    ): BackendProbeResult => {
      if (outcome !== 'cancelled' && outcome !== 'ready') {
        this.warnFailure(input.backendId, stage, code);
      }
      return makeResult({
        probeId: input.probeId,
        backendId: input.backendId,
        outcome,
        code,
        recoveryAction,
        compatibility,
        versionEvidence,
        lastStage: stage,
        modelCatalogAvailable: opts?.modelCatalogAvailable ?? false,
        checkedAt: this.deps.now().toISOString(),
      });
    };

    try {
      // --- Stage: executable ---
      lastStage = 'executable';
      this.emitProgress(input, 'executable');
      if (signal.aborted) {
        return fail('cancelled', 'cancelled', 'none', lastStage);
      }
      const command = this.deps.resolveCommand(input.backendId);
      const dirs = this.deps.pathDirs();
      const present = this.deps.commandResolves(command, dirs);
      if (!present) {
        return fail('failed', 'executable_missing', 'install', 'executable');
      }

      // --- Stage: version ---
      lastStage = 'version';
      this.emitProgress(input, 'version');
      if (signal.aborted) {
        return fail('cancelled', 'cancelled', 'none', lastStage);
      }

      let version: VersionCollectResult;
      try {
        version = await this.withDeadlines(
          this.deps.collectVersion(input.backendId, command),
          signal,
          this.stageTimeoutMs,
          totalDeadlineAt,
        );
      } catch (err) {
        if (err instanceof ProbeAbortError) {
          return fail(
            err.kind === 'cancelled' ? 'cancelled' : 'failed',
            err.kind === 'cancelled' ? 'cancelled' : 'timeout',
            err.kind === 'cancelled' ? 'none' : 'retry',
            lastStage,
          );
        }
        version = { versionEvidence: null, code: 'internal_error' };
      }

      versionEvidence = version.versionEvidence;
      if (version.code === 'timeout') {
        return fail('failed', 'timeout', 'retry', 'version');
      }
      if (version.code === 'process_exited') {
        return fail('failed', 'process_exited', 'retry', 'version');
      }
      if (version.code === 'internal_error') {
        return fail('failed', 'internal_error', 'retry', 'version');
      }
      // version_unknown and none continue — unknown versions remain probeable.

      compatibility = this.deps.classifyCompatibility(input.backendId, versionEvidence);
      if (compatibility === 'incompatible') {
        return fail('incompatible', 'version_incompatible', 'update', 'version');
      }

      // Global concurrency gate before spawning ACP.
      await this.acquireSlot(signal);
      slotHeld = true;

      // --- Stage: initialize + authenticate (ensureConnected) ---
      lastStage = 'initialize';
      this.emitProgress(input, 'initialize');
      if (signal.aborted) {
        return fail('cancelled', 'cancelled', 'none', lastStage);
      }

      try {
        client = this.deps.createClient(input.backendId);
      } catch {
        return fail('failed', 'internal_error', 'retry', 'initialize');
      }

      // Progress for authenticate is emitted just before ensureConnected so a
      // slow auth path is distinguishable from initialize hang. ensureConnected
      // covers both initialize and optional authenticate.
      this.emitProgress(input, 'authenticate');
      lastStage = 'authenticate';

      try {
        await this.withDeadlines(
          client.ensureConnected(),
          signal,
          this.stageTimeoutMs,
          totalDeadlineAt,
        );
      } catch (err) {
        if (err instanceof ProbeAbortError) {
          return fail(
            err.kind === 'cancelled' ? 'cancelled' : 'failed',
            err.kind === 'cancelled' ? 'cancelled' : 'timeout',
            err.kind === 'cancelled' ? 'none' : 'retry',
            lastStage === 'authenticate' ? 'initialize' : lastStage,
          );
        }
        const msg = errorMessage(err);
        if (isAuthErrorMessage(msg)) {
          return fail('auth_required', 'auth_required', 'login', 'authenticate');
        }
        if (isProcessExitMessage(msg)) {
          return fail('failed', 'process_exited', 'retry', 'initialize');
        }
        if (isTimeoutMessage(msg)) {
          return fail('failed', 'timeout', 'retry', 'initialize');
        }
        return fail('failed', 'acp_initialize_failed', 'retry', 'initialize');
      }

      // Successful handshake — treat authenticate as completed.
      lastStage = 'authenticate';

      // --- Stage: session (throwaway, no prompt) ---
      lastStage = 'session';
      this.emitProgress(input, 'session');
      if (signal.aborted) {
        return fail('cancelled', 'cancelled', 'none', lastStage);
      }

      let session: {
        sessionId: string;
        modelConfig?: {
          id: string;
          options?: readonly { value: string; name: string }[];
        };
      };
      try {
        const cwd = this.deps.resolveCwd();
        session = await this.withDeadlines(
          client.newSession(cwd, [], this.stageTimeoutMs),
          signal,
          this.stageTimeoutMs,
          totalDeadlineAt,
        );
      } catch (err) {
        if (err instanceof ProbeAbortError) {
          return fail(
            err.kind === 'cancelled' ? 'cancelled' : 'failed',
            err.kind === 'cancelled' ? 'cancelled' : 'timeout',
            err.kind === 'cancelled' ? 'none' : 'retry',
            'session',
          );
        }
        const msg = errorMessage(err);
        if (isAuthErrorMessage(msg)) {
          return fail('auth_required', 'auth_required', 'login', 'session');
        }
        if (isProcessExitMessage(msg)) {
          return fail('failed', 'process_exited', 'retry', 'session');
        }
        return fail('failed', 'session_probe_failed', 'retry', 'session');
      }

      // Best-effort close of the throwaway session before dispose.
      if (session.sessionId && client.closeSession) {
        try {
          await client.closeSession(session.sessionId);
        } catch {
          // Not all agents support session/close.
        }
      }

      // --- Stage: model_catalog (evidence from session/new, no second process) ---
      lastStage = 'model_catalog';
      this.emitProgress(input, 'model_catalog');
      const modelCatalogAvailable = Boolean(
        session.modelConfig &&
          Array.isArray(session.modelConfig.options) &&
          session.modelConfig.options.length > 0,
      );

      return makeResult({
        probeId: input.probeId,
        backendId: input.backendId,
        outcome: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility,
        versionEvidence,
        lastStage: 'model_catalog',
        modelCatalogAvailable,
        checkedAt: this.deps.now().toISOString() || checkedAt,
      });
    } catch (err) {
      if (err instanceof ProbeAbortError) {
        return fail(
          err.kind === 'cancelled' ? 'cancelled' : 'failed',
          err.kind === 'cancelled' ? 'cancelled' : 'timeout',
          err.kind === 'cancelled' ? 'none' : 'retry',
          lastStage,
        );
      }
      return fail('failed', 'internal_error', 'retry', lastStage);
    } finally {
      if (client) {
        try {
          client.dispose();
        } catch {
          // Dispose must not throw out of the probe.
        }
      }
      if (slotHeld) {
        this.releaseSlot();
      }
    }
  }
}
