import { describe, expect, it } from 'vitest';
import {
  decideVerdictRetry,
  failureSignature,
  selectRecoveryDecision,
  VERDICT_RECOVERY,
} from './recovery-policy';

describe('selectRecoveryDecision', () => {
  it('remediates while budget uses are below maxUses', () => {
    expect(selectRecoveryDecision('verdict-failed', 0)).toBe('remediate');
    expect(selectRecoveryDecision('verdict-failed', 1)).toBe('remediate');
  });

  it('aborts once budget is exhausted at maxUses', () => {
    expect(VERDICT_RECOVERY['verdict-failed'].maxUses).toBe(2);
    expect(selectRecoveryDecision('verdict-failed', 2)).toBe('abort');
    expect(selectRecoveryDecision('verdict-failed', 3)).toBe('abort');
  });

  it('aborts on an unknown kind (no rule)', () => {
    expect(selectRecoveryDecision('mystery-kind', 0)).toBe('abort');
  });
});

describe('failureSignature', () => {
  it('is a stable 16-char hex digest', () => {
    const sig = failureSignature('unit tests failed: 2 red');
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
    expect(failureSignature('unit tests failed: 2 red')).toBe(sig);
  });

  it('differs for different failure text', () => {
    expect(failureSignature('a')).not.toBe(failureSignature('b'));
  });
});

describe('decideVerdictRetry', () => {
  it('pauses when the identical failure signature recurs (anti-thrash)', () => {
    const sig = failureSignature('same failure');
    expect(decideVerdictRetry(sig, sig)).toBe('pause');
  });

  it('remediates on a first-seen (undefined prev) signature', () => {
    expect(decideVerdictRetry(undefined, failureSignature('first'))).toBe('remediate');
  });

  it('remediates when the failure signature changed', () => {
    expect(decideVerdictRetry(failureSignature('old'), failureSignature('new'))).toBe('remediate');
  });
});
