import assert from 'node:assert/strict';
import test from 'node:test';
import { runRepositoryBoundarySmoke } from './repository-boundary-smoke.mjs';

test('repository source boundary is clean', async () => {
  const result = await runRepositoryBoundarySmoke();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});
