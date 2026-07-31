import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateStorageLifecycleEvidence } from './m023-s05-storage-lifecycle-evidence-schema.mjs';

const root = new URL('../', import.meta.url);

async function loadTrackedEvidence() {
  const raw = await readFile(
    new URL('docs/plans/m023-s05-storage-lifecycle-evidence.json', root),
    'utf8',
  );
  return JSON.parse(raw);
}

test('tracked M023/S05 live storage lifecycle evidence validates', async () => {
  const evidence = await loadTrackedEvidence();
  assert.deepEqual(validateStorageLifecycleEvidence(evidence, { requirePass: true }), []);
});
