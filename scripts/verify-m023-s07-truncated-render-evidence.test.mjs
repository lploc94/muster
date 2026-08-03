import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateTruncatedRenderEvidence } from './m023-s07-truncated-render-evidence-schema.mjs';

const root = new URL('../', import.meta.url);
const evidenceUrl = new URL('docs/plans/m023-s07-truncated-render-evidence.json', root);

async function loadTrackedEvidence() {
  return JSON.parse(await readFile(evidenceUrl, 'utf8'));
}

test('tracked M023/S07 ledger is a live Extension Development Host DOM PASS', async () => {
  const evidence = await loadTrackedEvidence();
  assert.deepEqual(validateTruncatedRenderEvidence(evidence, { requirePass: true }), []);
});

test('live host timeout diagnostics retain only bounded observation counts', async () => {
  const host = await readFile(new URL('scripts/m023-s07-truncated-render-host.ts', root), 'utf8');
  assert.match(host, /last observation: files=/);
  assert.doesNotMatch(host, /JSON\.stringify\(candidate\)/);
});

test('disposable live-host workspace configures the production retention setting for the four-turn fixture', async () => {
  const runner = await readFile(new URL('scripts/run-m023-s07-truncated-render-uat.mjs', root), 'utf8');
  assert.match(runner, /maxRetainedTurnsPerTask/);
  assert.match(runner, /JSON\.stringify\(\{\s*'muster\.retention\.maxRetainedTurnsPerTask': 1\s*}\)/);
});

test('live host refreshes the focused transcript after retention before requesting the DOM probe', async () => {
  const host = await readFile(new URL('scripts/m023-s07-truncated-render-host.ts', root), 'utf8');
  const retentionIndex = host.indexOf('await command(UAT_COMMANDS.runRetentionPass)');
  const clearFocusIndex = host.indexOf('await command(UAT_COMMANDS.focusTask, { taskId: null })', retentionIndex);
  const focusIndex = host.indexOf('await command(UAT_COMMANDS.focusTask, { taskId: ACTIVE_TASK_ID })', clearFocusIndex);
  const probeIndex = host.indexOf('UAT_COMMANDS.renderProbe');
  assert.ok(retentionIndex >= 0 && clearFocusIndex > retentionIndex && focusIndex > clearFocusIndex && probeIndex > focusIndex);
  assert.doesNotMatch(host, /UAT_COMMANDS\.loadOlderTranscript/);
});

test('VSIX ignore rules retain the compiled UAT host entry while excluding other scripts', async () => {
  const ignore = await readFile(new URL('.vscodeignore', root), 'utf8');
  assert.match(ignore, /^dist\/scripts\/\*\*$/m);
  assert.match(ignore, /^!dist\/scripts\/m023-s07-truncated-render-host\.js$/m);
});

test('storage documentation distinguishes the M023/S07 live DOM proof from fixture coverage', async () => {
  const [guide, pkg] = await Promise.all([
    readFile(new URL('docs/SQLITE-STORAGE.md', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
  ]);
  assert.match(guide, /## 10\. Retention-truncated file-change rendering proof/);
  assert.match(guide, /live Extension Development Host DOM/i);
  assert.match(guide, /does not record diff bodies, message bodies, session IDs, or absolute paths/i);
  assert.match(guide, /MUSTER_UAT_MODE=1/);
  assert.match(pkg, /"test:m023-s07-render-evidence": "node --test scripts\/verify-m023-s07-truncated-render-evidence\.test\.mjs"/);
});

test('a BLOCKED ledger cannot satisfy the tracked M023/S07 live-proof verifier', async () => {
  const evidence = await loadTrackedEvidence();
  const blocked = {
    ...evidence,
    ok: false,
    verdict: 'BLOCKED',
    blockedReason: 'Live host unavailable.',
  };
  delete blocked.provenance;
  delete blocked.observation;
  delete blocked.contentSafety;
  assert.ok(validateTruncatedRenderEvidence(blocked, { requirePass: true }).length > 0);
});
