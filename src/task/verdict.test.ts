import { describe, expect, it } from 'vitest';
import {
  coerceVerdictStatus,
  normalizeVerdict,
  renderVerdictForPrompt,
  VERDICT_CRITERIA_MAX,
  VERDICT_CRITERION_LABEL_MAX,
  VERDICT_RATIONALE_MAX,
  type VerdictInput,
} from './verdict';

const AT = '2026-07-15T00:00:00.000Z';

describe('coerceVerdictStatus', () => {
  it.each(['pass', 'fail', 'inconclusive'] as const)('keeps valid status %s', (s) => {
    expect(coerceVerdictStatus(s)).toBe(s);
  });

  it.each([undefined, null, '', 'PASS', 'ok', 42, {}, 'passed'])(
    'coerces malformed %s to inconclusive',
    (raw) => {
      expect(coerceVerdictStatus(raw)).toBe('inconclusive');
    },
  );
});

describe('normalizeVerdict', () => {
  it('returns undefined for an absent input (no verdict)', () => {
    expect(normalizeVerdict(undefined, { at: AT })).toBeUndefined();
  });

  it('stamps source=worker + at and keeps a valid status', () => {
    const v = normalizeVerdict({ status: 'pass', rationale: 'all green' }, { at: AT });
    expect(v).toEqual({ status: 'pass', source: 'worker', at: AT, rationale: 'all green' });
  });

  it('fail-closes a malformed status to inconclusive without throwing', () => {
    const v = normalizeVerdict({ status: 'bogus' } as VerdictInput, { at: AT });
    expect(v?.status).toBe('inconclusive');
  });

  it('treats an empty verdict object as inconclusive (explicit but shapeless)', () => {
    const v = normalizeVerdict({}, { at: AT });
    expect(v).toEqual({ status: 'inconclusive', source: 'worker', at: AT });
  });

  it('accepts an explicit host source', () => {
    const v = normalizeVerdict({ status: 'fail' }, { at: AT, source: 'host' });
    expect(v?.source).toBe('host');
  });

  it('clamps the rationale and drops an empty one', () => {
    const long = 'x'.repeat(VERDICT_RATIONALE_MAX + 50);
    expect(normalizeVerdict({ status: 'fail', rationale: long }, { at: AT })?.rationale?.length).toBe(
      VERDICT_RATIONALE_MAX,
    );
    expect(normalizeVerdict({ status: 'fail', rationale: '' }, { at: AT })?.rationale).toBeUndefined();
  });

  it('normalizes, caps, and coerces criteria (labels clamped, bad status → inconclusive)', () => {
    const criteria = Array.from({ length: VERDICT_CRITERIA_MAX + 5 }, (_, i) => ({
      label: `c${i}`,
      status: i === 0 ? 'weird' : 'pass',
      detail: i === 0 ? 'why' : undefined,
    }));
    const v = normalizeVerdict({ status: 'pass', criteria }, { at: AT });
    expect(v?.criteria?.length).toBe(VERDICT_CRITERIA_MAX);
    expect(v?.criteria?.[0]).toEqual({ label: 'c0', status: 'inconclusive', detail: 'why' });
    // Over-long labels clamp.
    const longLabel = 'y'.repeat(VERDICT_CRITERION_LABEL_MAX + 20);
    const v2 = normalizeVerdict(
      { status: 'pass', criteria: [{ label: longLabel, status: 'pass' }] },
      { at: AT },
    );
    expect(v2?.criteria?.[0].label.length).toBe(VERDICT_CRITERION_LABEL_MAX);
  });
});

describe('renderVerdictForPrompt', () => {
  it('returns empty string when absent', () => {
    expect(renderVerdictForPrompt(undefined)).toBe('');
  });

  it('renders status, rationale, and criteria lines', () => {
    const text = renderVerdictForPrompt({
      status: 'fail',
      source: 'worker',
      at: AT,
      rationale: 'tests failed',
      criteria: [
        { label: 'builds', status: 'pass' },
        { label: 'unit tests', status: 'fail', detail: '3 failing' },
      ],
    });
    expect(text).toContain('status: fail');
    expect(text).toContain('rationale: tests failed');
    expect(text).toContain('- [pass] builds');
    expect(text).toContain('- [fail] unit tests — 3 failing');
  });
});
