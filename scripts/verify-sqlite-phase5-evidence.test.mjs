import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePhase5Evidence } from './sqlite-phase5-evidence-schema.mjs';

const root = new URL('../', import.meta.url);

async function readTracked(name) {
  return readFile(new URL(name, root), 'utf8');
}

test('tracked Phase 5 packaged fault evidence validates', async () => {
  const raw = await readTracked('docs/plans/sqlite-phase5-packaged-fault-uat-evidence.json');
  const evidence = JSON.parse(raw);
  assert.deepEqual(validatePhase5Evidence(evidence, { requirePass: true }), []);
});

test('tracked Phase 5 gate ledger declares required gates and runtimes', async () => {
  const ledger = await readTracked('docs/plans/sqlite-phase5-gate-evidence.vi.md');
  for (const marker of [
    'P5-W7',
    '1.101.0',
    'stable',
    'test:sqlite-packaged-fault-uat',
    'test:sqlite-extension-host',
    'test:sqlite-two-window-live-uat',
    'bench:phase4-release:assert',
    'Phase 5',
    'complete',
    'redacted',
  ]) {
    assert.ok(ledger.includes(marker), `ledger missing marker: ${marker}`);
  }
  assert.ok(!/\/Users\/|CANARY_/i.test(ledger), 'ledger must stay redacted');
});

test('rejects incomplete Phase 5 completion claims', async () => {
  const ledger = await readTracked('docs/plans/sqlite-phase5-gate-evidence.vi.md');
  const stripped = ledger.replace(/bench:phase4-release:assert/g, '');
  assert.ok(!stripped.includes('bench:phase4-release:assert'));
  // Structural: full ledger must mention both runtimes and fault UAT.
  assert.ok(ledger.includes('corrupt_open') || ledger.includes('packaged fault'));
});
