/**
 * McpReadinessSupervisor — pure-ish readiness gate for turnId+attemptId.
 *
 * Decides mcp_ready against the credentialed expected tool catalog and current
 * bridge generation (invariants 1 and 12). Free of TaskStore/engine imports so
 * S05/S06 and unit tests stay dependency-light.
 *
 * Failure taxonomy is stable for S06 recovery consumers.
 */

/** Stable failure codes for readiness evaluation (ready is not a failure). */
export type McpReadinessFailureCode =
  | 'wrong_catalog'
  | 'stale_attempt'
  | 'missing_evidence'
  | 'generation_mismatch'
  | 'setup_in_progress'
  | 'not_initialized';

export type McpReadinessResult =
  | {
      ok: true;
      turnId: string;
      attemptId: string;
      generation: number;
      toolNames: readonly string[];
    }
  | {
      ok: false;
      code: McpReadinessFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

/** Observation shape compatible with BridgeMcpObservation (server.ts T02). */
export type ReadinessObservationPhase = 'initialize' | 'list_tools';

export interface ReadinessObservation {
  phase: ReadinessObservationPhase;
  toolNames?: string[];
  credentialId: string;
  turnId: string;
  attemptId: string;
  generation: number;
  timestamp: number;
}

export interface BeginAttemptParams {
  turnId: string;
  attemptId: string;
  expectedToolNames: ReadonlySet<string> | readonly string[];
  bridgeGeneration: number;
}

interface AttemptState {
  attemptId: string;
  expectedToolNames: ReadonlySet<string>;
  /** Generation registered at beginAttempt. */
  beginGeneration: number;
  /** Last list_tools catalog (unique sorted names). */
  observedToolNames?: readonly string[];
  /** Generation stamped on the last list_tools observation. */
  observedGeneration?: number;
  /**
   * True when the last list_tools observation was accepted as valid evidence
   * for its generation (not marked generation_mismatch at record time).
   */
  evidenceValid: boolean;
  stale: boolean;
}

export interface McpReadinessDebugSnapshot {
  bridgeGeneration: number | null;
  turns: Record<
    string,
    {
      liveAttemptId: string | null;
      attempts: Array<{
        attemptId: string;
        stale: boolean;
        beginGeneration: number;
        expectedToolNames: string[];
        observedToolNames?: string[];
        observedGeneration?: number;
        evidenceValid: boolean;
      }>;
    }
  >;
}

function uniqueSorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

function setsEqualExact(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const name of a) {
    if (!b.has(name)) return false;
  }
  return true;
}

function toNameSet(names: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (names instanceof Set) {
    return new Set(names);
  }
  return new Set(names);
}

function fail(
  code: McpReadinessFailureCode,
  message: string,
  detail?: Record<string, unknown>,
): McpReadinessResult {
  return detail ? { ok: false, code, message, detail } : { ok: false, code, message };
}

export class McpReadinessSupervisor {
  /** turnId → live attempt id (most recent beginAttempt). */
  private readonly liveByTurn = new Map<string, string>();
  /** Composite turnId::attemptId → attempt state. */
  private readonly attempts = new Map<string, AttemptState>();
  /**
   * Latest known bridge generation (from beginAttempt / noteBridgeGeneration).
   * When set, evaluate(bridgeGeneration) must match this value or is generation_mismatch.
   */
  private bridgeGeneration: number | null = null;

  private key(turnId: string, attemptId: string): string {
    return `${turnId}::${attemptId}`;
  }

  /**
   * Register the live expected catalog for this attempt.
   * Supersedes any prior attempt for the same turnId (marks old attempt stale).
   */
  beginAttempt(params: BeginAttemptParams): void {
    const { turnId, attemptId, bridgeGeneration } = params;
    const expectedToolNames = toNameSet(params.expectedToolNames);

    const priorLive = this.liveByTurn.get(turnId);
    if (priorLive && priorLive !== attemptId) {
      const prior = this.attempts.get(this.key(turnId, priorLive));
      if (prior) {
        prior.stale = true;
      }
    }

    this.liveByTurn.set(turnId, attemptId);
    this.attempts.set(this.key(turnId, attemptId), {
      attemptId,
      expectedToolNames,
      beginGeneration: bridgeGeneration,
      evidenceValid: false,
      stale: false,
    });

    this.bridgeGeneration = bridgeGeneration;
  }

  /**
   * Accept list_tools / initialize evidence.
   * Ignores stale_attempt observations (attemptId not live for that turn).
   * On wrong generation, records generation_mismatch rather than ready.
   */
  recordObservation(obs: ReadinessObservation): void {
    const live = this.liveByTurn.get(obs.turnId);
    if (!live || live !== obs.attemptId) {
      // Stale attempt report — ignore; evaluate will surface stale_attempt for that id.
      return;
    }

    const state = this.attempts.get(this.key(obs.turnId, obs.attemptId));
    if (!state || state.stale) {
      return;
    }

    if (obs.phase === 'initialize') {
      // Initialize alone does not prove catalog readiness (invariant 12 needs tools/list).
      return;
    }

    if (obs.phase !== 'list_tools') {
      return;
    }

    const knownGen = this.bridgeGeneration ?? state.beginGeneration;
    state.observedToolNames = uniqueSorted(obs.toolNames ?? []);
    state.observedGeneration = obs.generation;

    if (obs.generation !== knownGen) {
      // Wrong generation: keep observation for diagnostics, mark invalid.
      state.evidenceValid = false;
      return;
    }

    state.evidenceValid = true;
  }

  /**
   * Invalidate prior ready evidence when bridge generation advances
   * (e.g. after close+listen restart).
   */
  noteBridgeGeneration(generation: number): void {
    this.bridgeGeneration = generation;
    // Evidence from a prior generation is no longer valid for readiness.
    for (const state of this.attempts.values()) {
      if (state.observedGeneration !== undefined && state.observedGeneration !== generation) {
        state.evidenceValid = false;
      }
    }
  }

  /**
   * Returns ready only when:
   * - attempt is the live attempt for turnId
   * - bridgeGeneration matches supervisor-tracked generation and accepted evidence
   * - observed tool name set equals expected set (order-independent exact equality)
   */
  evaluate(turnId: string, attemptId: string, bridgeGeneration: number): McpReadinessResult {
    const live = this.liveByTurn.get(turnId);
    if (!live) {
      return fail('not_initialized', `no attempt registered for turnId=${turnId}`, {
        turnId,
        attemptId,
      });
    }

    const state = this.attempts.get(this.key(turnId, attemptId));
    if (!state) {
      return fail('not_initialized', `no attempt state for turnId=${turnId} attemptId=${attemptId}`, {
        turnId,
        attemptId,
      });
    }

    if (state.stale || live !== attemptId) {
      return fail(
        'stale_attempt',
        `attemptId=${attemptId} is not the live attempt for turnId=${turnId} (live=${live})`,
        { turnId, attemptId, liveAttemptId: live },
      );
    }

    // When the supervisor tracks a bridge generation, evaluate must use that generation.
    // Prevents ready on a stale evaluate(gen=old) after noteBridgeGeneration advanced.
    if (this.bridgeGeneration !== null && bridgeGeneration !== this.bridgeGeneration) {
      return fail(
        'generation_mismatch',
        `evaluate generation=${bridgeGeneration} does not match bridge generation=${this.bridgeGeneration}`,
        {
          turnId,
          attemptId,
          evaluateGeneration: bridgeGeneration,
          bridgeGeneration: this.bridgeGeneration,
        },
      );
    }

    if (state.observedToolNames === undefined || state.observedGeneration === undefined) {
      return fail(
        'missing_evidence',
        `no list_tools evidence for turnId=${turnId} attemptId=${attemptId}`,
        { turnId, attemptId },
      );
    }

    if (!state.evidenceValid || state.observedGeneration !== bridgeGeneration) {
      return fail(
        'generation_mismatch',
        `observed generation=${state.observedGeneration} does not match bridge generation=${bridgeGeneration}`,
        {
          turnId,
          attemptId,
          observedGeneration: state.observedGeneration,
          bridgeGeneration,
          evidenceValid: state.evidenceValid,
        },
      );
    }

    const observedSet = new Set(state.observedToolNames);
    if (!setsEqualExact(observedSet, state.expectedToolNames)) {
      return fail(
        'wrong_catalog',
        `observed tool catalog does not exactly match expected for turnId=${turnId} attemptId=${attemptId}`,
        {
          turnId,
          attemptId,
          expected: uniqueSorted(state.expectedToolNames),
          observed: [...state.observedToolNames],
        },
      );
    }

    return {
      ok: true,
      turnId,
      attemptId,
      generation: bridgeGeneration,
      toolNames: uniqueSorted(state.expectedToolNames),
    };
  }

  /** Test/diagnostics snapshot — never includes tokens. */
  getDebugSnapshot(): McpReadinessDebugSnapshot {
    const turns: McpReadinessDebugSnapshot['turns'] = {};
    const turnIds = new Set<string>();
    for (const turnId of this.liveByTurn.keys()) {
      turnIds.add(turnId);
    }
    for (const key of this.attempts.keys()) {
      const sep = key.indexOf('::');
      if (sep > 0) turnIds.add(key.slice(0, sep));
    }

    for (const turnId of turnIds) {
      const attempts: McpReadinessDebugSnapshot['turns'][string]['attempts'] = [];
      for (const [key, state] of this.attempts) {
        if (!key.startsWith(`${turnId}::`)) continue;
        attempts.push({
          attemptId: state.attemptId,
          stale: state.stale,
          beginGeneration: state.beginGeneration,
          expectedToolNames: uniqueSorted(state.expectedToolNames),
          observedToolNames: state.observedToolNames ? [...state.observedToolNames] : undefined,
          observedGeneration: state.observedGeneration,
          evidenceValid: state.evidenceValid,
        });
      }
      turns[turnId] = {
        liveAttemptId: this.liveByTurn.get(turnId) ?? null,
        attempts,
      };
    }

    return {
      bridgeGeneration: this.bridgeGeneration,
      turns,
    };
  }
}
