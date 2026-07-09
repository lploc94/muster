import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const auditPath = 'docs/TASK-MODEL-UI-STATE-AUDIT.md';
const packagePath = 'package.json';
const audit = await readFile(auditPath, 'utf8');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

const requiredSections = [
  'Source Map',
  'Current Domain Model',
  'Store and Runtime State',
  'Host Snapshot and Protocol Projection',
  'Webview State and Rendering',
  'Runtime State Contract Baseline',
  'Proof Boundaries and Drift Risks',
  'Failure Modes',
  'Load Profile',
  'Negative Tests',
  'Observability Impact',
  'Downstream Guidance',
];

const requiredSourceClaims = [
  'docs/TASK-MANAGEMENT.md',
  'docs/TASK-MODEL-IMPL-PLAN.md',
  'src/task/types.ts',
  'src/task/derived-status.ts',
  'src/task/store.ts',
  'src/task/engine.ts',
  'src/host/snapshot.ts',
  'src/extension.ts',
  'webview/src/lib/protocol.ts',
  'webview/src/lib/tasks.svelte.ts',
  'webview/src/lib/thread.svelte.ts',
  'webview/src/App.svelte',
  'webview/src/components/TaskList.svelte',
  'webview/src/components/TaskWorkspace.svelte',
  'webview/src/components/Composer.svelte',
];

const forbiddenSourceRoots = ['.gsd/', '.planning/', '.audits/'];

function sectionBody(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^## ${escapedHeading}\\s*$`, 'm');
  const match = markdown.match(pattern);
  if (!match?.index) {
    return '';
  }

  const bodyStart = match.index + match[0].length;
  const rest = markdown.slice(bodyStart);
  const nextHeadingIndex = rest.search(/\n## /);
  return rest.slice(0, nextHeadingIndex === -1 ? undefined : nextHeadingIndex).trim();
}

test('package exposes the audit verifier command used by slice verification', () => {
  assert.equal(
    pkg.scripts?.['test:task-audit'],
    'node --test scripts/verify-task-model-ui-state-audit.test.mjs',
  );
});

test('audit keeps every required contract section populated', () => {
  for (const heading of requiredSections) {
    assert.ok(
      sectionBody(audit, heading).length > 0,
      `Missing or empty ## ${heading} section in ${auditPath}`,
    );
  }
});

test('audit covers the source files that define task runtime and UI state', () => {
  for (const sourcePath of requiredSourceClaims) {
    assert.ok(
      audit.includes(`\`${sourcePath}\``),
      `Expected ${auditPath} to cite ${sourcePath}`,
    );
  }
});

test('audit preserves confidence labels and source-level proof boundaries', () => {
  for (const label of ['[High confidence]', '[Medium confidence]', '[Low confidence]']) {
    assert.ok(audit.includes(label), `Expected ${auditPath} to preserve ${label}`);
  }

  const proofBoundaries = sectionBody(audit, 'Proof Boundaries and Drift Risks');
  assert.match(proofBoundaries, /does not confirm|does not prove|source-level/i);
  assert.match(proofBoundaries, /T03/i);
  assert.match(proofBoundaries, /snapshot/i);
});

test('audit verifier avoids ignored planning/runtime source roots', () => {
  for (const sourceRoot of forbiddenSourceRoots) {
    assert.ok(
      !audit.includes(`\`${sourceRoot}`) && !audit.includes(`\`${sourceRoot.slice(0, -1)}\``),
      `Audit source claims should not depend on ignored root ${sourceRoot}`,
    );
  }
});
