import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./sqlite-two-window-live-uat.ts', import.meta.url), 'utf8');

test('M023 S05 lifecycle scenario uses activated UAT commands and records the four evidence snapshots', () => {
  for (const command of [
    'muster.uat.seedStorageWorkload',
    'muster.uat.storageLifecycleState',
    'muster.uat.runRetentionPass',
  ]) {
    assert.match(source, new RegExp(`UAT_COMMANDS\\.[A-Za-z]+|${command.replaceAll('.', '\\.')}`));
    assert.ok(source.includes(command), `missing ${command}`);
  }
  assert.match(source, /const lifecycleBefore = await cmd<StorageLifecycleState>\(UAT_COMMANDS\.storageLifecycleState\)/);
  assert.match(source, /const lifecycleAfterSeed = await cmd<StorageLifecycleState>\(UAT_COMMANDS\.storageLifecycleState\)/);
  assert.match(source, /const lifecycleAfterRetention = await cmd<StorageLifecycleState>\([\s\S]*UAT_COMMANDS\.storageLifecycleState/);
  assert.match(source, /direct UAT pass must not fabricate scheduler completion evidence/);
  assert.match(source, /const lifecyclePeerAfterRetention = await peer<StorageLifecycleState>\([\s\S]*UAT_COMMANDS\.storageLifecycleState/);
  assert.match(source, /scheduledPassTarget = lifecycleAfterSeed\.retention\.completedPasses \+ 2/);
  assert.match(source, /retentionTruncatedEntries === 4/);
  assert.match(source, /storageLifecycle: \{[\s\S]*before: lifecycleBefore[\s\S]*afterSeed: lifecycleAfterSeed[\s\S]*afterRetention: lifecycleAfterRetention[\s\S]*peerAfterRetention: lifecyclePeerAfterRetention/);
  assert.match(source, /lifecyclePeerAfterRetention\.storage\.fileBytes,\s*lifecycleAfterRetention\.storage\.fileBytes/);
});

test('M023 S05 packaged runner enables the UAT schedule and emits schema-valid lifecycle evidence', async () => {
  const runner = await readFile(new URL('./run-sqlite-two-window-live-uat.mjs', import.meta.url), 'utf8');
  assert.match(runner, /MUSTER_RETENTION_INTERVAL_MS: '1000'/);
  assert.match(runner, /m023-s05-storage-lifecycle-evidence\.json/);
  assert.match(runner, /kind: 'm023-s05-storage-lifecycle-live-uat'/);
  assert.match(runner, /canaryStoredInEvidence: false/);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['test:m023-s05-storage-lifecycle-live-uat'], 'node scripts/run-sqlite-two-window-live-uat.mjs');
});
