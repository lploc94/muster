import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateOrphanLifecycleEvidence } from './m023-s08-orphan-lifecycle-evidence-schema.mjs';

const root = new URL('../', import.meta.url);

async function loadTrackedEvidence() {
  const raw = await readFile(
    new URL('docs/plans/m023-s08-orphan-lifecycle-evidence.json', root),
    'utf8',
  );
  return JSON.parse(raw);
}

test('tracked M023/S08 live orphan lifecycle evidence validates', async () => {
  const evidence = await loadTrackedEvidence();
  assert.deepEqual(validateOrphanLifecycleEvidence(evidence, { requirePass: true }), []);
});
