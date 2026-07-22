import * as fs from 'node:fs';
import * as path from 'node:path';
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

  it('resolves every implemented behavior to an exact test and every constraint to source evidence', () => {
    for (const item of SECTION_20_TRACEABILITY) {
      const sourcePath = path.join(__dirname, item.targetFile);
      expect(fs.existsSync(sourcePath), `${item.requirementId}: ${item.targetFile}`).toBe(true);
      const source = fs.readFileSync(sourcePath, 'utf8');
      expect(item.targetTest.trim().length).toBeGreaterThan(8);
      expect(['behavior', 'constraint']).toContain(item.proof);
      expect(['planned', 'implemented']).toContain(item.status);
      if (item.proof === 'behavior') {
        expect(item.targetFile.endsWith('.test.ts')).toBe(true);
        expect(
          source.includes(`it('${item.targetTest}'`)
          || source.includes(`it(\"${item.targetTest}\"`)
          || source.includes(`it(\`${item.targetTest}\``),
          `${item.requirementId}: ${item.targetTest}`,
        ).toBe(true);
      } else {
        expect(item.targetFile.endsWith('.test.ts')).toBe(false);
        expect(source, `${item.requirementId}: ${item.targetTest}`).toContain(item.targetTest);
      }
    }
  });
});
