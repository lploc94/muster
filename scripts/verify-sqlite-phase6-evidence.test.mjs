import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePhase6Evidence } from './sqlite-phase6-evidence-schema.mjs';

const root = new URL('../', import.meta.url);

const LEDGER_MARKERS = [
  'P6-W1',
  'P6-W2',
  'P6-W3',
  'f4c62bc',
  '3558914',
  'loadTranscriptPage',
  'transcriptPageResult',
  'bench:phase6-webview',
  'test:phase6-webview',
  'Phase 6',
  'complete',
  'RepositoryProjection',
  'buildRepositorySnapshot',
  'task-markdown-export',
  'backup',
  'reset',
  'retained',
  'BUDGET PASS',
  'Virtualizer',
];

const FORBIDDEN_DOC = [/\bloadHistory\b/, /\bhistoryChunk\b/];

const DOC_PATHS = [
  'docs/WEBVIEW.md',
  'docs/plans/sqlite-phase6-gate-evidence.vi.md',
  'docs/plans/sqlite-global-storage-refactor.vi.md',
];

async function readTracked(rel) {
  return readFile(new URL(rel, root), 'utf8');
}

function assertLedger(text) {
  assert.ok(text.trim(), 'ledger non-empty');
  for (const m of LEDGER_MARKERS) {
    assert.ok(text.includes(m), `ledger missing marker: ${m}`);
  }
  assert.ok(!/\/Users\/|CANARY_/i.test(text), 'ledger must stay redacted');
  return true;
}

function assertNoLegacyTranscriptAliases(text, path) {
  for (const re of FORBIDDEN_DOC) {
    assert.ok(!re.test(text), `${path} must not contain ${re}`);
  }
}

test('tracked Phase 6 evidence JSON validates', async () => {
  const raw = await readTracked('docs/plans/sqlite-phase6-webview-evidence.json');
  const evidence = JSON.parse(raw);
  assert.deepEqual(validatePhase6Evidence(evidence, { requirePass: true }), []);
});

test('tracked Phase 6 gate ledger declares required markers', async () => {
  assert.equal(assertLedger(await readTracked('docs/plans/sqlite-phase6-gate-evidence.vi.md')), true);
});

test('tracked docs use current transcript protocol terms only', async () => {
  const webview = await readTracked('docs/WEBVIEW.md');
  assert.ok(webview.includes('loadTranscriptPage'));
  assert.ok(webview.includes('transcriptPageResult'));
  for (const path of DOC_PATHS) {
    assertNoLegacyTranscriptAliases(await readTracked(path), path);
  }
});

test('rejects incomplete Phase 6 completion claims', async () => {
  const ledger = await readTracked('docs/plans/sqlite-phase6-gate-evidence.vi.md');
  for (const marker of ['f4c62bc', '3558914', 'complete', 'BUDGET PASS', 'loadTranscriptPage']) {
    assert.throws(() => assertLedger(ledger.split(marker).join('')), /missing marker/);
  }
  assert.throws(() => assertLedger(`${ledger}\n/Users/secret`), /must stay redacted/);
});

/** Strip line/block comments and string literals so symbol checks are code-only. */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

function hasLiveIdentifierUse(src, symbol) {
  const code = stripCommentsAndStrings(src);
  // Import/type/value reference or call/new — not bare prose.
  const importUse = new RegExp(
    `\\bimport\\b[\\s\\S]{0,200}\\b${symbol}\\b|\\b(?:from|typeof|new|extends|implements)\\s+${symbol}\\b|\\b${symbol}\\s*[.(<]`,
  );
  return importUse.test(code);
}

test('caller matrix surfaces exist and have live production callers', async () => {
  /** @type {Array<{ def: string, symbol: string, callers: string[] }>} */
  const surfaces = [
    {
      def: 'src/task/repository-projection.ts',
      symbol: 'RepositoryProjection',
      callers: ['src/task/engine.ts', 'src/host/external-workspace-reconciler.ts'],
    },
    {
      def: 'src/host/repository-snapshot.ts',
      symbol: 'buildRepositorySnapshot',
      callers: ['src/extension.ts'],
    },
    {
      def: 'src/host/workspace-patch.ts',
      symbol: 'projectWorkspacePatches',
      callers: ['src/extension.ts'],
    },
    {
      def: 'src/host/task-markdown-export.ts',
      symbol: 'renderTaskMarkdownExport',
      callers: ['src/host/task-export-route.ts'],
    },
    {
      def: 'src/task/sqlite/backup.ts',
      symbol: 'backupOpenDatabase',
      callers: ['src/task/sqlite/worker.ts'],
    },
    {
      def: 'src/task/sqlite/reset.ts',
      symbol: 'resetOpenDatabase',
      callers: ['src/task/sqlite/worker.ts'],
    },
  ];
  for (const { def, symbol, callers } of surfaces) {
    const defSrc = await readTracked(def);
    assert.ok(
      hasLiveIdentifierUse(defSrc, symbol) || defSrc.includes(`export function ${symbol}`) || defSrc.includes(`export class ${symbol}`) || defSrc.includes(`export async function ${symbol}`),
      `${def} must define/export ${symbol}`,
    );
    let live = false;
    for (const caller of callers) {
      const src = await readTracked(caller);
      if (hasLiveIdentifierUse(src, symbol)) {
        live = true;
        break;
      }
    }
    assert.ok(live, `${symbol} must have a live production caller among ${callers.join(', ')}`);
  }
  // Comment-only mention must not count as a live caller.
  assert.equal(hasLiveIdentifierUse('// RepositoryProjection only', 'RepositoryProjection'), false);
  assert.equal(hasLiveIdentifierUse("const x = 'RepositoryProjection';", 'RepositoryProjection'), false);
  assert.equal(
    hasLiveIdentifierUse("import { RepositoryProjection } from './x';\nnew RepositoryProjection()", 'RepositoryProjection'),
    true,
  );
});

test('evidence commits match approved Phase 6 provenance', async () => {
  const {
    PHASE6_BASELINE_COMMIT,
    PHASE6_W1_COMMIT,
    PHASE6_W2_COMMIT,
    validatePhase6Evidence,
  } = await import('./sqlite-phase6-evidence-schema.mjs');
  const evidence = JSON.parse(await readTracked('docs/plans/sqlite-phase6-webview-evidence.json'));
  assert.ok(PHASE6_BASELINE_COMMIT.startsWith(evidence.baselineCommit.slice(0, 7)));
  assert.ok(PHASE6_W1_COMMIT.startsWith(evidence.w1Commit.slice(0, 7)));
  assert.ok(PHASE6_W2_COMMIT.startsWith(evidence.w2Commit.slice(0, 7)));
  const bad = structuredClone(evidence);
  bad.w1Commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  assert.ok(validatePhase6Evidence(bad).some((f) => /w1Commit/.test(f)));
});
