import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

/**
 * Mechanical contract for M008 queue + live-inject operator docs.
 * Markers must appear in the named tracked files; forbidden claims must not.
 */
const required = {
  'docs/WEBVIEW.md': [
    '## 14. Queued follow-ups and live inject',
    'Enter',
    'Ctrl+Enter',
    '`send`',
    '`sendLiveInput`',
    'FIFO',
    '`queuedTurns`',
    '`editQueuedTurn`',
    '`deleteQueuedTurn`',
    '`liveInputResult`',
    '`commandError`',
    'no queue fallback',
    'composer stays editable',
    'Shift+Enter',
    'IME',
    'Local unit and Playwright checks are supportive only',
    'Extension Development Host',
  ],
  'docs/TASK-MANAGEMENT.md': [
    '## 9.1 Multi-queued FIFO follow-ups and live inject',
    'FIFO',
    '`send`',
    '`sendLiveInput`',
    'distinct queued turn',
    'one active (running) turn per task',
    'multiple queued follow-ups',
    '`queuedTurns`',
    '`editQueuedTurn`',
    '`deleteQueuedTurn`',
    '`liveInputResult`',
    '`commandError`',
    'no queue fallback',
    'stale',
  ],
  'docs/README.md': [
    'queued follow-ups and live inject',
  ],
  'CONTRIBUTING.md': [
    '## Queue and live-inject verification',
    'npm run test:queue-live-inject-docs',
    'e2e/muster-webview-state.spec.ts',
    'Enter',
    'Ctrl+Enter',
    'sendLiveInput',
    'queuedTurns',
    'supportive only',
  ],
  'package.json': [
    '"test:queue-live-inject-docs": "node --test scripts/verify-queue-live-inject-docs.test.mjs"',
  ],
};

const forbiddenClaims = [
  {
    pattern: /at most one queued or active turn per task/i,
    label: 'single-queue invariant (superseded by multi-queue FIFO)',
  },
  {
    pattern: /Disabled while a turn is in-flight/i,
    label: 'hard disable composer while in-flight',
  },
  {
    pattern: /do not inject into the live process except via `submitAsk`/i,
    label: 'submitAsk-only live inject',
  },
  {
    pattern: /Ctrl\+Enter (?:queues|creates a queued turn|falls? through to queue)/i,
    label: 'Ctrl+Enter queue fallback',
  },
  {
    pattern: /sendLiveInput (?:queues|falls? through to (?:queue|continueTask))/i,
    label: 'sendLiveInput queue fallback',
  },
];

function validate(files) {
  for (const [name, markers] of Object.entries(required)) {
    const text = files[name];
    assert.ok(typeof text === 'string' && text.trim(), `Missing documentation file: ${name}`);
    for (const marker of markers) {
      assert.ok(text.includes(marker), `${name} missing contract marker: ${marker}`);
    }
  }

  const combined = Object.values(files).join('\n');
  for (const { pattern, label } of forbiddenClaims) {
    assert.ok(!pattern.test(combined), `forbidden queue/live-inject claim: ${label}`);
  }

  const webview = files['docs/WEBVIEW.md'];
  const sectionStart = webview.indexOf('## 14. Queued follow-ups and live inject');
  assert.ok(sectionStart >= 0, 'WEBVIEW.md missing queue/live-inject section');
  // Section runs until next ## heading or end
  const after = webview.slice(sectionStart + 1);
  const nextHeading = after.search(/\n## /);
  const section = nextHeading >= 0 ? after.slice(0, nextHeading) : after;
  assert.match(section, /Enter queues/i, 'WEBVIEW.md must document Enter → FIFO queue');
  assert.match(section, /Ctrl\+Enter/i, 'WEBVIEW.md must document Ctrl+Enter live inject');
  assert.match(section, /no queue fallback/i, 'WEBVIEW.md must state live inject has no queue fallback');
  assert.match(section, /commandError/i, 'WEBVIEW.md must document refusal via commandError');
  assert.match(section, /liveInputResult/i, 'WEBVIEW.md must document delivered liveInputResult');

  const taskMgmt = files['docs/TASK-MANAGEMENT.md'];
  const tmStart = taskMgmt.indexOf('## 9.1 Multi-queued FIFO follow-ups and live inject');
  assert.ok(tmStart >= 0, 'TASK-MANAGEMENT.md missing multi-queue section');
  const tmAfter = taskMgmt.slice(tmStart + 1);
  const tmNext = tmAfter.search(/\n## /);
  const tmSection = tmNext >= 0 ? tmAfter.slice(0, tmNext) : tmAfter;
  assert.match(tmSection, /multiple queued follow-ups/i, 'TASK-MANAGEMENT.md must allow multi-queue');
  assert.match(tmSection, /sendLiveInput/i, 'TASK-MANAGEMENT.md must document sendLiveInput');
  assert.match(tmSection, /editQueuedTurn/i, 'TASK-MANAGEMENT.md must document editQueuedTurn');

  return true;
}

async function trackedFiles() {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(required).map(async (name) => [name, await readFile(new URL(name, root), 'utf8')]),
    ),
  );
}

test('tracked documentation defines the queue and live-inject operating contract', async () => {
  assert.equal(validate(await trackedFiles()), true);
});

test('rejects omitted protocol, keyboard, and feedback markers', async () => {
  const files = await trackedFiles();
  for (const marker of [
    '`sendLiveInput`',
    '`queuedTurns`',
    'no queue fallback',
    'npm run test:queue-live-inject-docs',
  ]) {
    const owner = Object.keys(required).find((name) => files[name].includes(marker));
    assert.ok(owner, `fixture marker owner missing: ${marker}`);
    assert.throws(
      () => validate({ ...files, [owner]: files[owner].split(marker).join('') }),
      /missing contract marker/,
    );
  }
});

test('rejects superseded single-queue and hard-disable claims', async () => {
  const files = await trackedFiles();
  assert.throws(
    () =>
      validate({
        ...files,
        'docs/TASK-MANAGEMENT.md': `${files['docs/TASK-MANAGEMENT.md']}\nThere may be at most one queued or active turn per task.\n`,
      }),
    /single-queue invariant/,
  );
  assert.throws(
    () =>
      validate({
        ...files,
        'docs/WEBVIEW.md': `${files['docs/WEBVIEW.md']}\nDisabled while a turn is in-flight (turnStart received).\n`,
      }),
    /hard disable composer while in-flight/,
  );
  assert.throws(
    () =>
      validate({
        ...files,
        'docs/WEBVIEW.md': `${files['docs/WEBVIEW.md']}\nCtrl+Enter queues a follow-up turn.\n`,
      }),
    /Ctrl\+Enter queue fallback/,
  );
});
