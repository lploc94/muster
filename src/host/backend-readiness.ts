import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendCompatibilityStatus,
  type BackendReadinessCode,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
  type BackendRecoveryAction,
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

/** Max concurrent version subprocesses during a single refresh. */
export const VERSION_COLLECTION_CONCURRENCY = 3;

export interface BackendReadinessServiceDeps {
  /** PATH search directories for passive inventory. */
  pathDirs: () => string[];
  /** Resolve inventory command for a backend. */
  resolveCommand: (id: BackendReadinessId) => string;
  /** Executable presence check (no spawn). */
  commandResolves: (command: string, dirs: string[]) => boolean;
  /** Bounded version collection (injected for tests). */
  collectVersion: (
    backendId: BackendReadinessId,
    command: string,
  ) => Promise<VersionCollectResult>;
  /** Host-owned compatibility policy. */
  classifyCompatibility: (
    backendId: BackendReadinessId,
    version: string | null,
  ) => BackendCompatibilityStatus;
  now: () => Date;
  createCorrelationId: () => string;
}

/**
 * Build production deps for passive inventory + version collection.
 * Does not invoke ACP, model catalog, task engine, or session paths.
 */
export function createDefaultBackendReadinessDeps(options?: {
  compatibilityPolicy?: CompatibilityPolicy;
}): BackendReadinessServiceDeps {
  const policy = options?.compatibilityPolicy;
  return {
    pathDirs: () => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    resolveCommand: resolveBackendCommand,
    commandResolves: defaultCommandResolves,
    collectVersion: (backendId, command) =>
      collectBackendVersion({ backendId, command }),
    classifyCompatibility: (backendId, version) =>
      defaultClassifyCompatibility(backendId, version, policy),
    now: () => new Date(),
    createCorrelationId: () => randomUUID(),
  };
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function missingRecord(backendId: BackendReadinessId, checkedAt: string): BackendReadinessRecord {
  return {
    backendId,
    state: 'missing',
    code: 'executable_missing',
    recoveryAction: 'install',
    compatibility: 'unknown',
    versionEvidence: null,
    checkedAt,
  };
}

function buildPresentRecord(
  backendId: BackendReadinessId,
  version: VersionCollectResult,
  compatibility: BackendCompatibilityStatus,
  checkedAt: string,
): BackendReadinessRecord {
  if (compatibility === 'incompatible') {
    return {
      backendId,
      state: 'incompatible',
      code: 'version_incompatible',
      recoveryAction: 'update',
      compatibility: 'incompatible',
      versionEvidence: version.versionEvidence,
      checkedAt,
    };
  }

  // S01: never emit ready/testing/auth_required. Detected executables settle as
  // installed_unverified (or failed only for unexpected internal collapse).
  let code: BackendReadinessCode = version.code;
  let recoveryAction: BackendRecoveryAction = 'none';

  if (code === 'timeout' || code === 'process_exited' || code === 'internal_error') {
    // Keep selectable honesty: executable is present; version evidence failed.
    // Map to installed_unverified with the specific diagnostic code.
    recoveryAction = code === 'timeout' ? 'retry' : 'none';
  } else if (code === 'version_unknown') {
    recoveryAction = 'none';
  } else if (code === 'none') {
    recoveryAction = 'none';
  }

  return {
    backendId,
    state: 'installed_unverified',
    code,
    recoveryAction,
    compatibility,
    versionEvidence: version.versionEvidence,
    checkedAt,
  };
}

/**
 * Host-only passive BackendReadinessService.
 *
 * - refresh(): runs inventory + bounded version collection for all five backends
 * - peek(): last settled snapshot (or null)
 *
 * S01 never produces ready/testing/auth states. Failures settle into bounded
 * diagnostic records — never thrown or omitted.
 */
export class BackendReadinessService {
  private last: BackendReadinessSnapshot | null = null;

  constructor(private readonly deps: BackendReadinessServiceDeps) {}

  /** Last settled snapshot, or null before the first successful refresh. */
  peek(): BackendReadinessSnapshot | null {
    return this.last;
  }

  /**
   * Run passive inventory + version collection and cache the settled snapshot.
   * @param correlationId optional external correlation (refresh request id)
   */
  async refresh(correlationId?: string): Promise<BackendReadinessSnapshot> {
    const checkedAt = this.deps.now().toISOString();
    const corr = correlationId ?? this.deps.createCorrelationId();
    const dirs = this.deps.pathDirs();

    const backends = await mapPool(
      BACKEND_READINESS_IDS,
      VERSION_COLLECTION_CONCURRENCY,
      async (backendId) => {
        try {
          const command = this.deps.resolveCommand(backendId);
          const present = this.deps.commandResolves(command, dirs);
          if (!present) {
            return missingRecord(backendId, checkedAt);
          }

          let version: VersionCollectResult;
          try {
            version = await this.deps.collectVersion(backendId, command);
          } catch {
            version = { versionEvidence: null, code: 'internal_error' };
          }

          const compatibility = this.deps.classifyCompatibility(
            backendId,
            version.versionEvidence,
          );
          return buildPresentRecord(backendId, version, compatibility, checkedAt);
        } catch {
          // Absolute last resort: never omit a record or throw from refresh.
          return {
            backendId,
            state: 'failed' as const,
            code: 'internal_error' as const,
            recoveryAction: 'retry' as const,
            compatibility: 'unknown' as const,
            versionEvidence: null,
            checkedAt,
          };
        }
      },
    );

    const snapshot: BackendReadinessSnapshot = {
      schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
      correlationId: corr,
      phase: 'settled',
      checkedAt,
      backends,
    };
    this.last = snapshot;
    return snapshot;
  }
}
