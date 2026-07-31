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
  assert.match(source, /completedPasses=\$\{lastState\.retention\.completedPasses\}/);
  assert.match(source, /failedPasses=\$\{lastState\.retention\.failedPasses\}/);
  assert.match(source, /truncatedEntries=\$\{lastState\.retentionTruncatedEntries\}/);
  assert.match(source, /retentionTruncatedEntries === 4/);
  assert.match(source, /assert\.equal\(identityA\.userVersion, 2, 'schema version drifted'\)/);
  assert.match(source, /assert\.equal\(identityB\.userVersion, 2, 'peer schema version drifted'\)/);
  assert.match(source, /entry\.clientRequestId === 'uat-outbox-pending' && entry\.status === 'rejected'/);
  assert.match(source, /entry\.clientRequestId === 'uat-outbox-reject' && entry\.status === 'rejected'/);
  assert.match(source, /recovered pending entry was rejected; explicit rejection persisted; durable surfaces restored/);
  assert.match(source, /durableOk=\$\{durableOk\} identityOk=\$\{identityOk\} tasksOk=\$\{tasksOk\}/);
  assert.match(source, /outboxCount=\$\{lastDurable\.sendOutbox\.length\}/);
  assert.match(source, /presentationPresent=\$\{lastDurable\.presentation !== undefined\}/);
  assert.match(
    source,
    /const identityB2 = await peer<DbIdentity>\(UAT_COMMANDS\.identity\);[\s\S]*await peer\('muster\.openChat'\);[\s\S]*waitForPeerDurableSurfaces\('fresh-host durable restoration'/,
  );
  assert.doesNotMatch(source, /const \[durable, state\] = await Promise\.all\(\[\s*peer<DurableSurfaces>/);
  assert.match(source, /storageLifecycle: \{[\s\S]*before: lifecycleBefore[\s\S]*afterSeed: lifecycleAfterSeed[\s\S]*afterRetention: lifecycleAfterRetention[\s\S]*peerAfterRetention: lifecyclePeerAfterRetention/);
  assert.match(source, /lifecyclePeerAfterRetention\.storage\.fileBytes,\s*lifecycleAfterRetention\.storage\.fileBytes/);
});

test('M023 S05 packaged runner enables the UAT schedule and emits schema-valid lifecycle evidence', async () => {
  const runner = await readFile(new URL('./run-sqlite-two-window-live-uat.mjs', import.meta.url), 'utf8');
  assert.match(runner, /MUSTER_RETENTION_INTERVAL_MS: role === 'A' \? '1000' : '300000'/);
  assert.match(runner, /m023-s05-storage-lifecycle-evidence\.json/);
  assert.match(runner, /kind: 'm023-s05-storage-lifecycle-live-uat'/);
  assert.match(runner, /canaryStoredInEvidence: false/);
  assert.match(runner, /db\.userVersion !== 2/);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['test:m023-s05-storage-lifecycle-live-uat'], 'node scripts/run-sqlite-two-window-live-uat.mjs');
});

test('two-window runner uses a Windows junction for shared local global storage', async () => {
  const runner = await readFile(new URL('./run-sqlite-two-window-live-uat.mjs', import.meta.url), 'utf8');
  assert.match(runner, /process\.platform === 'win32' \? 'junction' : 'dir'/);
});
