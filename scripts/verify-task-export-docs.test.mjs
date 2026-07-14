import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const required = {
  'docs/WEBVIEW.md': [
    '## 15. Task / chat Markdown export',
    'Export task/chat',
    '`exportTask`',
    '`exportResult`',
    'basename-only',
    'sourceRevision',
    'commandError',
    'cancel produces no webview message',
    'Local unit and Playwright checks are supportive only',
    'Extension Development Host',
    'muster-task-export/v1',
  ],
  'docs/TASK-MANAGEMENT.md': [
    '## 18. Task Markdown export',
    'muster-task-export/v1',
    'user/assistant',
    'tool',
    'reasoning',
    'point-in-time',
    'not a backup',
    'exportTask',
    'exportResult',
    'basename-only',
    'silent cancel',
    'sanitized',
    'task-export.md',
  ],
  'docs/README.md': [
    'task Markdown export',
    'Task-export live-host evidence',
  ],
  'README.md': [
    'docs/TASK-MANAGEMENT.md',
    'Markdown export',
  ],
  'CONTRIBUTING.md': [
    '## Task export verification and live-host evidence',
    'npm run test:task-export-docs',
    'npm run test:task-export-live-evidence',
    'e2e/muster-webview-state.spec.ts',
    'Extension Development Host',
    'ENVIRONMENT BLOCKED',
    'docs/uat/m009-s03/task-export-live-host-evidence.md',
    'supportive only',
    'absolute paths',
    'credentials',
    'transcript',
  ],
  'package.json': [
    '"test:task-export-docs": "node --test scripts/verify-task-export-docs.test.mjs"',
  ],
};

const forbiddenClaims = [
  {
    // Affirmative overclaim only — do not match denials like
    // "Playwright checks ... do not prove native Save As".
    pattern:
      /(?:local|unit|Playwright|browser) (?:tests?|checks?|gates?) (?:prove|guarantee|establish) (?:the )?(?:live[- ]host|native Save As)/i,
    label: 'unconditional local-as-live-host proof',
  },
  {
    pattern: /export (?:is|provides) (?:a )?(?:full )?(?:backup|restore) format/i,
    label: 'export as backup/restore format',
  },
  {
    pattern: /exportResult\.fileName (?:is|includes|contains) (?:an )?absolute/i,
    label: 'absolute path in exportResult.fileName',
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

  const webview = files['docs/WEBVIEW.md'];
  const exportSectionStart = webview.indexOf('## 15. Task / chat Markdown export');
  assert.ok(exportSectionStart >= 0, 'WEBVIEW.md missing task export section');
  // Section runs until next ## or end of file.
  const nextHeading = webview.indexOf('\n## ', exportSectionStart + 1);
  const exportSection =
    nextHeading >= 0 ? webview.slice(exportSectionStart, nextHeading) : webview.slice(exportSectionStart);
  assert.match(
    exportSection,
    /focused task/i,
    'WEBVIEW.md export section must scope export to the focused task',
  );
  assert.match(
    exportSection,
    /basename/i,
    'WEBVIEW.md export section must document basename-only success notice',
  );
  assert.doesNotMatch(
    exportSection,
    /exportResult\.fileName is an absolute path/i,
    'WEBVIEW.md must not claim absolute exportResult.fileName',
  );

  const taskMgmt = files['docs/TASK-MANAGEMENT.md'];
  const taskExportStart = taskMgmt.indexOf('## 18. Task Markdown export');
  assert.ok(taskExportStart >= 0, 'TASK-MANAGEMENT.md missing task export section');
  const nextTaskHeading = taskMgmt.indexOf('\n## ', taskExportStart + 1);
  const taskExportSection =
    nextTaskHeading >= 0
      ? taskMgmt.slice(taskExportStart, nextTaskHeading)
      : taskMgmt.slice(taskExportStart);
  assert.match(
    taskExportSection,
    /omit|omits|omitted|only/i,
    'TASK-MANAGEMENT.md must describe allowlisted conversation content',
  );
  assert.match(
    taskExportSection,
    /Save As/i,
    'TASK-MANAGEMENT.md must document native Save As ownership',
  );

  const combined = Object.values(files).join('\n');
  for (const { pattern, label } of forbiddenClaims) {
    assert.ok(!pattern.test(combined), `forbidden task-export claim: ${label}`);
  }

  return true;
}

async function trackedFiles() {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(required).map(async (name) => [name, await readFile(new URL(name, root), 'utf8')]),
    ),
  );
}

test('tracked documentation defines and exposes the complete task Markdown export contract', async () => {
  assert.equal(validate(await trackedFiles()), true);
});

test('rejects omitted protocol, allowlist, proof-boundary, and operating markers', async () => {
  const files = await trackedFiles();
  // Only strip markers from a file that actually requires them, so validate
  // fails on the required-marker loop (not a coincidental secondary assertion).
  for (const marker of [
    '`exportTask`',
    'muster-task-export/v1',
    'Local unit and Playwright checks are supportive only',
    'ENVIRONMENT BLOCKED',
    'silent cancel',
  ]) {
    const owner = Object.keys(required).find(
      (name) => required[name].includes(marker) && files[name].includes(marker),
    );
    assert.ok(owner, `fixture marker owner missing: ${marker}`);
    assert.throws(
      () => validate({ ...files, [owner]: files[owner].split(marker).join('') }),
      /missing contract marker/,
    );
  }
});

test('rejects documentation that promotes local proof to live Save As or claims backup/absolute paths', async () => {
  const files = await trackedFiles();
  // Inject into the task-export section so the fixture is unambiguous.
  const overclaim = files['CONTRIBUTING.md'].replace(
    'Those results are **supportive only**.',
    'Those results are **supportive only**. Playwright tests prove the live-host native Save As path.',
  );
  assert.notEqual(overclaim, files['CONTRIBUTING.md'], 'overclaim fixture must mutate CONTRIBUTING.md');
  assert.throws(
    () => validate({ ...files, 'CONTRIBUTING.md': overclaim }),
    /forbidden task-export claim: unconditional local-as-live-host proof/,
  );

  const backupClaim = files['docs/TASK-MANAGEMENT.md'].replace(
    'not a backup',
    'export is a full backup format; not a backup',
  );
  assert.throws(
    () => validate({ ...files, 'docs/TASK-MANAGEMENT.md': backupClaim }),
    /forbidden task-export claim: export as backup\/restore format/,
  );

  const absolutePathClaim = files['docs/WEBVIEW.md'].replace(
    'basename-only',
    'basename-only. exportResult.fileName is an absolute path.',
  );
  assert.throws(
    () => validate({ ...files, 'docs/WEBVIEW.md': absolutePathClaim }),
    /must not claim absolute exportResult\.fileName|forbidden task-export claim/,
  );
});
