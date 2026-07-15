/**
 * Bounded remediation policy (verify-gate-loop Phase B). Pure — no engine/store
 * imports. Decides whether a failed verify gate may spawn a bounded remediation
 * task, and guards against thrashing on an identical recurring failure.
 *
 * The engine (`applyVerdictRemediation`) is the only caller; this module holds no
 * state and performs no I/O so it stays trivially unit-testable and deterministic.
 */

import { createHash } from 'crypto';

/** Outcome of a budget check for a recovery `kind`. */
export type RecoveryAction = 'remediate' | 'abort';

/** A single recovery rule: how many auto-remediations a `kind` is allowed. */
interface RecoveryRule {
  /** Max total auto-remediations before the blocked task is sealed. */
  maxUses: number;
  action: 'remediate';
}

/**
 * Recovery rule table keyed by failure `kind`. A verify verdict that fails its
 * gate is `verdict-failed`; it may be auto-remediated at most twice before the
 * loop aborts (seals the blocked task) — no unbounded retries.
 */
export const VERDICT_RECOVERY: Record<string, RecoveryRule> = {
  'verdict-failed': { maxUses: 2, action: 'remediate' },
};

/**
 * Budget decision for `kind` given how many remediations were already spent.
 * Unknown kind or exhausted budget (`budgetUses >= maxUses`) → `'abort'`.
 */
export function selectRecoveryDecision(kind: string, budgetUses: number): RecoveryAction {
  const rule = VERDICT_RECOVERY[kind];
  if (!rule || budgetUses >= rule.maxUses) return 'abort';
  return rule.action;
}

/** Stable short digest of a failure text (sha256 hex, first 16 chars). */
export function failureSignature(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Anti-thrash gate: an identical failure signature recurring for the same blocked
 * task means the previous remediation did not change the outcome, so pause (raise
 * attention) instead of spawning another fix. A new/different signature remediates.
 */
export function decideVerdictRetry(
  prevSig: string | undefined,
  newSig: string,
): 'remediate' | 'pause' {
  return prevSig === newSig ? 'pause' : 'remediate';
}
