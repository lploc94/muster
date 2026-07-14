/**
 * Contract smoke for interrupt-and-send (replaces concurrent live-inject product path).
 * Run: npm run test:live-inject-smoke
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function read(rel) {
  return readFile(path.join(root, rel), 'utf8');
}

function extractCase(source, caseName) {
  const start = source.indexOf(`case '${caseName}'`);
  assert.ok(start >= 0, `missing case '${caseName}'`);
  const next = source.indexOf("case '", start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

test('package.main points at dist runtime artifact', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.main, './dist/src/extension.js');
});

test('SOURCE sendLiveInput is interruptAndSend (no liveInputResult / live_inject)', async () => {
  const src = await read('src/extension.ts');
  const live = extractCase(src, 'sendLiveInput');
  assert.match(live, /interruptAndSend/);
  assert.match(live, /postSnapshot/);
  assert.doesNotMatch(live, /routeSendLiveInput/);
  assert.doesNotMatch(live, /type:\s*'liveInputResult'/);
  assert.doesNotMatch(live, /delivery:\s*'live_inject'/);
  assert.doesNotMatch(live, /engine\.sendLiveInput/);
});

test('engine exposes interruptAndSend and no tryDispatchQueuedLiveInject', async () => {
  const engine = await read('src/task/engine.ts');
  assert.match(engine, /interruptAndSend\(/);
  assert.match(engine, /reserveQueuedFollowUp/);
  assert.doesNotMatch(engine, /tryDispatchQueuedLiveInject/);
  assert.doesNotMatch(engine, /delivery:\s*'live_inject'/);
  assert.match(engine, /interruptConfidence/);
});

test('AcpClient force-settle marks cancelConfidence forced', async () => {
  const client = await read('src/backends/acp-client.ts');
  assert.match(client, /cancelConfidence:\s*'forced'/);
  assert.match(client, /cancelConfidence\?/);
});

test('TaskTurn has interruptConfidence not live_inject delivery', async () => {
  const types = await read('src/task/types.ts');
  assert.match(types, /interruptConfidence\?/);
  assert.doesNotMatch(types, /live_inject/);
});

test('composer copy describes interrupt and send', async () => {
  const composer = await read('webview/src/components/Composer.svelte');
  assert.match(composer, /interrupts and sends/i);
  assert.doesNotMatch(composer, /injects live input/i);
});

test('mvp interrupt-and-send script exists', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(
    pkg.scripts['mvp:grok-interrupt-and-send'],
    'tsx scripts/test-grok-interrupt-and-send.ts',
  );
  await stat(path.join(root, 'scripts/test-grok-interrupt-and-send.ts'));
});
