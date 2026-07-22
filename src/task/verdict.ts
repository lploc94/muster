/**
 * Verify verdict helpers (verify-gate-loop Phase A). Pure — no engine/store I/O.
 *
 * A verdict is produced by a worker and carried on
 * `TaskResultV1.verdict`. All normalization is fail-closed: an absent/malformed
 * status coerces to `'inconclusive'` so a gate never treats garbage as `pass`.
 */

import type { TaskVerdict, VerdictCriterion, VerdictStatus } from './types';

/** Max chars retained in a verdict rationale. */
export const VERDICT_RATIONALE_MAX = 500;
/** Max chars retained in a single criterion label. */
export const VERDICT_CRITERION_LABEL_MAX = 200;
/** Max chars retained in a single criterion detail. */
export const VERDICT_CRITERION_DETAIL_MAX = 500;
/** Max criteria retained on a verdict. */
export const VERDICT_CRITERIA_MAX = 16;

const VERDICT_STATUSES: ReadonlySet<VerdictStatus> = new Set([
  'pass',
  'fail',
  'inconclusive',
]);

/**
 * Untrusted verdict payload as extracted at the tool boundary (worker-supplied).
 * Timeless by construction so the disposition command fingerprint stays stable
 * across idempotent retries — the `at`/`source` stamps are applied at normalize time.
 */
export interface VerdictCriterionInput {
  label?: string;
  status?: string;
  detail?: string;
}
export interface VerdictInput {
  status?: string;
  rationale?: string;
  criteria?: VerdictCriterionInput[];
}

/** Coerce any token to a VerdictStatus; unknown/malformed → 'inconclusive' (fail-closed). */
export function coerceVerdictStatus(raw: unknown): VerdictStatus {
  return typeof raw === 'string' && VERDICT_STATUSES.has(raw as VerdictStatus)
    ? (raw as VerdictStatus)
    : 'inconclusive';
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export interface NormalizeVerdictOptions {
  /** ISO timestamp stamped as `verdict.at` (deterministic; supplied by the caller). */
  at: string;
  /** Producer of the verdict. Default `'worker'` (Phase A). */
  source?: 'worker' | 'host';
}

/**
 * Normalize an (untrusted) verdict input into a TaskVerdict.
 * Returns `undefined` when `input` is absent so the gate treats "no verdict" as
 * not-pass. A malformed/absent status coerces to `'inconclusive'`; rationale and
 * criteria are clamped. Never throws / never rejects.
 */
export function normalizeVerdict(
  input: VerdictInput | undefined,
  options: NormalizeVerdictOptions,
): TaskVerdict | undefined {
  if (!input) return undefined;
  const verdict: TaskVerdict = {
    status: coerceVerdictStatus(input.status),
    source: options.source ?? 'worker',
    at: options.at,
  };
  if (typeof input.rationale === 'string' && input.rationale.length > 0) {
    verdict.rationale = clamp(input.rationale, VERDICT_RATIONALE_MAX);
  }
  if (input.criteria && input.criteria.length > 0) {
    const criteria: VerdictCriterion[] = [];
    for (const raw of input.criteria.slice(0, VERDICT_CRITERIA_MAX)) {
      const label =
        typeof raw.label === 'string' ? clamp(raw.label, VERDICT_CRITERION_LABEL_MAX) : '';
      const criterion: VerdictCriterion = {
        label,
        status: coerceVerdictStatus(raw.status),
      };
      if (typeof raw.detail === 'string' && raw.detail.length > 0) {
        criterion.detail = clamp(raw.detail, VERDICT_CRITERION_DETAIL_MAX);
      }
      criteria.push(criterion);
    }
    if (criteria.length > 0) verdict.criteria = criteria;
  }
  return verdict;
}

/**
 * Render a verdict as plain text for injection as an untrusted bound input
 * (`status` + optional `rationale` + criteria lines). Empty string when absent.
 */
export function renderVerdictForPrompt(verdict: TaskVerdict | undefined): string {
  if (!verdict) return '';
  const lines: string[] = [`status: ${verdict.status}`];
  if (verdict.rationale) lines.push(`rationale: ${verdict.rationale}`);
  if (verdict.criteria && verdict.criteria.length > 0) {
    lines.push('criteria:');
    for (const c of verdict.criteria) {
      lines.push(`- [${c.status}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}
