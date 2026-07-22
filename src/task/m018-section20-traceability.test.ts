import { describe, expect, it } from 'vitest';
import {
  SECTION_20_REQUIREMENT_IDS,
  SECTION_20_TRACEABILITY,
} from './m018-section20-traceability';

describe('M018 section 20 requirement traceability', () => {
  it('maps every normative invariant, transaction boundary, continuation rule, and audit finding', () => {
    const mapped = SECTION_20_TRACEABILITY.map((item) => item.requirementId);
    expect(mapped).toHaveLength(new Set(mapped).size);
    expect([...mapped].sort()).toEqual([...SECTION_20_REQUIREMENT_IDS].sort());
  });

  it('uses named observable tests or structural proofs for every requirement', () => {
    for (const item of SECTION_20_TRACEABILITY) {
      expect(item.targetTest.trim().length).toBeGreaterThan(8);
      expect(['behavior', 'constraint']).toContain(item.proof);
      expect(['planned', 'implemented']).toContain(item.status);
    }
  });
});
