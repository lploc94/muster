import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePhase6Evidence } from './sqlite-phase6-evidence-schema.mjs';

const root = new URL('../', import.meta.url);

async function loadTracked() {
  const raw = await readFile(new URL('docs/plans/sqlite-phase6-webview-evidence.json', root), 'utf8');
  return JSON.parse(raw);
}

test('tracked Phase 6 evidence validates', async () => {
  const evidence = await loadTracked();
  assert.deepEqual(validatePhase6Evidence(evidence, { requirePass: true }), []);
});

test('rejects missing chat fixture / excessive mounted rows / FAIL', async () => {
  const base = await loadTracked();
  {
    const bad = structuredClone(base);
    delete bad.fixture.transcriptItems;
    assert.ok(validatePhase6Evidence(bad).some((f) => /transcriptItems/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.metrics.chat.peakMountedRows = 999;
    assert.ok(validatePhase6Evidence(bad).some((f) => /peakMountedRows/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.metrics.tree.peakMountedRows = 500;
    assert.ok(validatePhase6Evidence(bad).some((f) => /peakMountedRows/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.ok = false;
    bad.verdict = 'FAIL';
    assert.ok(
      validatePhase6Evidence(bad, { requirePass: true }).some((f) => /requirePass/.test(f)),
    );
  }
});

test('rejects unknown keys, sensitive content, self-referential w3 commit', async () => {
  const base = await loadTracked();
  {
    const bad = structuredClone(base);
    bad.extra = true;
    assert.ok(validatePhase6Evidence(bad).some((f) => /unknown root key/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.w3Commit = 'abc1234';
    assert.ok(validatePhase6Evidence(bad).some((f) => /self-referential/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('/Users/secret/path');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('/home/alice/secret');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('UPDATE tasks SET goal="x"');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('DELETE FROM tasks');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('Error: boom\n    at foo (src/x.ts:1:1)');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('{"taskId":"secret-task"}');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('at async foo (foo.js:1:1)');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('UPDATE "tasks" SET goal="x"');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.commands.push('UPDATE [tasks] SET goal="x"');
    assert.ok(validatePhase6Evidence(bad).some((f) => /sensitive/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.contentSafety.secret = 'oops';
    assert.ok(validatePhase6Evidence(bad).some((f) => /contentSafety unknown/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.metrics.chat.peakMountedRows = 79.5;
    assert.ok(validatePhase6Evidence(bad).some((f) => /non-negative integer/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.thresholds.maxDomPeakDelta = 1;
    bad.metrics.chat.peakDomNodes = bad.metrics.chat.baselineDomNodes + 2;
    assert.ok(validatePhase6Evidence(bad).length > 0);
  }
  {
    const bad = structuredClone(base);
    bad.fixture.contentClasses = [null, null, null];
    assert.ok(validatePhase6Evidence(bad).some((f) => /contentClasses/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.metrics.chat.retainedDeltaBytes = 99;
    assert.ok(validatePhase6Evidence(bad).some((f) => /retainedDeltaBytes/.test(f)));
  }
  {
    const bad = structuredClone(base);
    bad.metrics.chat.finalUsedBytes = bad.metrics.chat.baselineUsedBytes * 3;
    bad.metrics.chat.retainedDeltaBytes = Math.max(
      0,
      bad.metrics.chat.finalUsedBytes - bad.metrics.chat.baselineUsedBytes,
    );
    assert.ok(validatePhase6Evidence(bad).some((f) => /1\.5x/.test(f)));
  }
});
