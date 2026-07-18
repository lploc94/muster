/**
 * Smoke for src/backends/acp-fault-harness.testkit.ts (T02).
 * Run: node --import tsx scripts/smoke-acp-fault-harness.mjs
 */
import assert from 'node:assert/strict';
import {
  makeFakeAcpFaultClient,
  MUSTER_DISPOSITION_TOOLS,
} from '../src/backends/acp-fault-harness.testkit.ts';

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('ACP fault harness smoke');

  const harness = makeFakeAcpFaultClient({
    sessionIdQueue: ['sess-A', 'sess-B'],
  });

  // Pre-mark A as sticky MCP-failed before either session is created.
  harness.markSessionMcpFailed('sess-A', 'initialize failed');

  check('process starts alive', () => {
    assert.equal(harness.isProcessAlive(), true);
  });

  const a = await harness.client.newSession('/tmp', []);
  const b = await harness.client.newSession('/tmp', []);

  check('session ids from queue', () => {
    assert.equal(a.sessionId, 'sess-A');
    assert.equal(b.sessionId, 'sess-B');
  });

  check('A is MCP-failed sticky', () => {
    assert.equal(harness.isSessionMcpFailed('sess-A'), true);
    assert.equal(harness.isSessionMcpReady('sess-A'), false);
    assert.equal(harness.mcpFailureReason('sess-A'), 'initialize failed');
  });

  check('B is healthy / ready', () => {
    assert.equal(harness.isSessionMcpFailed('sess-B'), false);
    assert.equal(harness.isSessionMcpReady('sess-B'), true);
  });

  const toolsA = harness.toolCatalogFor('sess-A').map((t) => t.name);
  const toolsB = harness.toolCatalogFor('sess-B').map((t) => t.name);

  check('A missing Muster disposition tools', () => {
    for (const name of MUSTER_DISPOSITION_TOOLS) {
      assert.equal(toolsA.includes(name), false, `A should lack ${name}`);
    }
  });

  check('B has Muster disposition tools', () => {
    for (const name of MUSTER_DISPOSITION_TOOLS) {
      assert.equal(toolsB.includes(name), true, `B should have ${name}`);
    }
  });

  // Multi-session sinks + prompt resolution while process stays alive.
  const updatesA = [];
  const updatesB = [];
  harness.client.registerSessionSink('sess-A', (u) => updatesA.push(u));
  harness.client.registerSessionSink('sess-B', (u) => updatesB.push(u));

  const promptA = harness.client.prompt('sess-A', [{ type: 'text', text: 'a' }]);
  const promptB = harness.client.prompt('sess-B', [{ type: 'text', text: 'b' }]);

  harness.push('sess-B', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello-B' },
  });
  harness.push('sess-A', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello-A' },
  });

  harness.resolve('sess-A', { stopReason: 'end_turn' });
  harness.resolve('sess-B', { stopReason: 'end_turn' });

  const [ra, rb] = await Promise.all([promptA, promptB]);

  check('both sessions resolve end_turn', () => {
    assert.deepEqual(ra, { stopReason: 'end_turn' });
    assert.deepEqual(rb, { stopReason: 'end_turn' });
  });

  check('session isolation of push routing', () => {
    assert.equal(updatesA.length, 1);
    assert.equal(updatesB.length, 1);
    assert.match(JSON.stringify(updatesA[0]), /hello-A/);
    assert.match(JSON.stringify(updatesB[0]), /hello-B/);
  });

  check('MCP failure stays sticky after prompt', () => {
    assert.equal(harness.isSessionMcpFailed('sess-A'), true);
    assert.equal(harness.isSessionMcpReady('sess-A'), false);
  });

  check('process still alive after A MCP failure', () => {
    assert.equal(harness.isProcessAlive(), true);
  });

  check('cancel not auto-fired', () => {
    assert.equal(harness.calls.cancel.length, 0);
  });

  check('call recording preserved', () => {
    assert.ok(harness.calls.newSession.length >= 2);
    assert.ok(harness.calls.prompt.length >= 2);
    assert.ok(harness.callOrder.includes('newSession'));
    assert.ok(harness.callOrder.includes('prompt'));
  });

  // Sticky: marking after create also works.
  const h2 = makeFakeAcpFaultClient({ sessionIdQueue: ['s1'] });
  await h2.client.newSession('/tmp', []);
  assert.equal(h2.isSessionMcpFailed('s1'), false);
  h2.markSessionMcpFailed('s1');
  check('post-create mark is sticky', () => {
    assert.equal(h2.isSessionMcpFailed('s1'), true);
    for (const name of MUSTER_DISPOSITION_TOOLS) {
      assert.equal(
        h2.toolCatalogFor('s1').some((t) => t.name === name),
        false,
      );
    }
  });

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nALL SMOKE PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
