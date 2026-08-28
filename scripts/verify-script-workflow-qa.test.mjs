import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relative) => readFile(new URL(relative, root), 'utf8');

test('script workflow QA plan maps requirements to automated and native evidence', async () => {
  const plan = await read('docs/qa/script-workflow-qa-plan.md');
  for (const id of [
    'CAT-01', 'CAT-05', 'CMP-01', 'CMP-02', 'EXE-01', 'EXE-06',
    'SEC-01', 'SEC-05', 'DUR-01', 'DUR-02', 'REG-01',
  ]) assert.match(plan, new RegExp(`\\b${id}\\b`), `missing QA requirement ${id}`);
  assert.match(plan, /test:script-workflow-native-uat/);
  assert.match(plan, /Exploratory UI checklist/);
  assert.match(plan, /Do not record bearer tokens/);
});

test('native evidence records a real packaged Extension Host PASS', async () => {
  const evidence = await read('docs/uat/script-workflow-native-evidence.md');
  assert.match(evidence, /^# Script Workflow Native Host QA Evidence$/m);
  assert.match(evidence, /^- Verdict: PASS$/m);
  assert.match(evidence, /VS Code `1\.135\.0`, `extension-development-host`/);
  assert.match(evidence, /npm run test:script-workflow-native-uat/);
  assert.match(evidence, /host_run_disabled/);
  assert.match(evidence, /zero ACP session claims/);
  assert.match(evidence, /does not claim pixel-level or human visual approval/);
});

test('package scripts and native runner keep the reproducible QA path', async () => {
  const [manifestText, runner, host, fixture] = await Promise.all([
    read('package.json'),
    read('scripts/run-script-workflow-native-uat.mjs'),
    read('scripts/script-workflow-native-host.ts'),
    read('src/host/script-workflow-uat-fixture.ts'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(manifest.scripts['test:script-workflow-qa'], /script-workflow\.test\.ts/);
  assert.match(manifest.scripts['test:script-workflow-native-uat'], /run-script-workflow-native-uat\.mjs/);
  assert.match(manifest.scripts['test:script-workflow-acceptance'], /test:script-workflow-native-uat/);
  assert.match(runner, /createVSIX/);
  assert.match(runner, /runTests/);
  assert.match(host, /UAT_COMMANDS\.runScriptWorkflowQa/);
  for (const proof of [
    'workspaceShadowsGlobal', 'staleRefRejected', 'disabledStartRejected',
    'globalBundleExecuted', 'packageIntegrityRejected', 'exactStdoutPreserved',
    'failRunFailedOnce', 'noAcpSessionClaims',
  ]) assert.match(fixture, new RegExp(proof));
});
