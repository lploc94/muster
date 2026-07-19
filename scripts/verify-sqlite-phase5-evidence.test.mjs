import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePhase5Evidence } from './sqlite-phase5-evidence-schema.mjs';

const root = new URL('../', import.meta.url);

const LEDGER_MARKERS = [
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
  'corrupt_open',
  'BUDGET PASS',
  'backup=vacuum',
  'backup=api',
];

async function readTracked(name) {
  return readFile(new URL(name, root), 'utf8');
}

function assertLedger(text) {
  assert.ok(typeof text === 'string' && text.trim(), 'ledger must be non-empty');
  for (const marker of LEDGER_MARKERS) {
    assert.ok(text.includes(marker), `ledger missing marker: ${marker}`);
  }
  assert.ok(!/\/Users\/|CANARY_|sessionId=/i.test(text), 'ledger must stay redacted');
  return true;
}

test('tracked Phase 5 packaged fault evidence validates', async () => {
  const raw = await readTracked('docs/plans/sqlite-phase5-packaged-fault-uat-evidence.json');
  const evidence = JSON.parse(raw);
  assert.deepEqual(validatePhase5Evidence(evidence, { requirePass: true }), []);
});

test('tracked Phase 5 gate ledger declares required gates and runtimes', async () => {
  assert.equal(assertLedger(await readTracked('docs/plans/sqlite-phase5-gate-evidence.vi.md')), true);
});

test('rejects incomplete Phase 5 completion claims', async () => {
  const ledger = await readTracked('docs/plans/sqlite-phase5-gate-evidence.vi.md');
  for (const marker of [
    'bench:phase4-release:assert',
    '1.101.0',
    'stable',
    'test:sqlite-packaged-fault-uat',
    'test:sqlite-two-window-live-uat',
    'redacted',
    'complete',
    'BUDGET PASS',
  ]) {
    assert.throws(
      () => assertLedger(ledger.split(marker).join('')),
      /missing marker/,
    );
  }
  assert.throws(
    () => assertLedger(`${ledger}\n/Users/secret/muster.sqlite3`),
    /must stay redacted/,
  );
});
