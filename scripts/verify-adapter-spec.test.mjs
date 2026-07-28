/**
 * M021 S04 — adapter-versus-engine ownership contract for file-change evidence.
 *
 * Locks the documented split:
 * - adapters may cap retained file count and set `fileChangesOmitted`
 * - engine re-bounds with trusted cwd, adds engine omissions to upstream,
 *   and owns path classification plus remaining text/line/aggregate bounds
 * - present-only `outsideWorkspace: true` is engine-owned classification
 *
 * Rejects the stale claim that the engine is the only layer allowed to add
 * `fileChangesOmitted`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SPEC_PATH = new URL('../docs/ADAPTER-SPEC.md', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

/** Required positive ownership phrases (case-insensitive where noted). */
const requiredPhrases = [
  {
    name: 'adapters may cap retained file count',
    pattern: /adapters?\s+may\s+cap\s+retained\s+file\s+count/i,
  },
  {
    name: 'adapters may set fileChangesOmitted',
    pattern: /adapters?[\s\S]{0,120}fileChangesOmitted/i,
  },
  {
    name: 'engine re-bounds with trusted cwd',
    pattern: /engine\s+re-?bounds?\s+with\s+(?:the\s+)?trusted\s+cwd/i,
  },
  {
    name: 'engine adds omissions to upstream omissions',
    pattern: /adds?\s+engine\s+omissions?\s+to\s+upstream\s+omissions?/i,
  },
  {
    name: 'engine owns path classification',
    pattern: /owns\s+path\s+classification/i,
  },
  {
    name: 'engine owns remaining text/line/aggregate bounds',
    pattern:
      /(?:owns|remaining)\s+(?:path\s+classification\s+plus\s+)?(?:remaining\s+)?text\s*\/\s*line\s*\/\s*aggregate\s+bounds/i,
  },
  {
    name: 'present-only outsideWorkspace marker',
    pattern: /outsideWorkspace\??:\s*true/i,
  },
];

/** Stale claims that over-assign fileChangesOmitted solely to the engine. */
const forbiddenClaims = [
  {
    label: 'engine is the only layer allowed to add fileChangesOmitted',
    pattern:
      /only\s+layer\s+allowed\s+to\s+add[\s\S]{0,80}fileChangesOmitted/i,
  },
];

/**
 * @param {string} spec
 * @param {string} [packageJson]
 */
export function validateAdapterSpecOwnership(spec, packageJson) {
  assert.ok(typeof spec === 'string' && spec.trim().length > 0, 'ADAPTER-SPEC.md must be non-empty');

  for (const { name, pattern } of requiredPhrases) {
    assert.match(spec, pattern, `ADAPTER-SPEC.md missing ownership contract: ${name}`);
  }

  for (const { label, pattern } of forbiddenClaims) {
    assert.ok(!pattern.test(spec), `ADAPTER-SPEC.md still claims: ${label}`);
  }

  // ToolFileChange surface must document the present-only marker.
  assert.match(
    spec,
    /interface\s+ToolFileChange[\s\S]*?outsideWorkspace\??:\s*true/i,
    'ToolFileChange must document present-only outsideWorkspace?: true',
  );

  if (packageJson !== undefined) {
    assert.match(
      packageJson,
      /"test:m021-s04"\s*:/,
      'package.json must expose test:m021-s04 for the M021 S04 proof gate',
    );
  }

  return true;
}

const validFixture = `
Adapters may cap retained file count and set \`fileChangesOmitted\` at the adapter edge.
The engine re-bounds with the trusted cwd, adds engine omissions to upstream omissions,
and owns path classification plus remaining text/line/aggregate bounds.

export interface ToolFileChange {
  path: string;
  oldText: string | null;
  newText: string;
  truncated?: boolean;
  outsideWorkspace?: true;
}
`;

const staleFixture = `
Adapters must preserve diffs; the engine canonicalizes paths, bounds retained
bytes/lines/file count, and is the only layer allowed to add \`truncated\` or
\`fileChangesOmitted\` metadata before persistence or host emission.

export interface ToolFileChange {
  path: string;
  oldText: string | null;
  newText: string;
  truncated?: boolean;
}
`;

test('tracked ADAPTER-SPEC documents adapter/engine file-change ownership split', async () => {
  const [spec, packageJson] = await Promise.all([
    readFile(SPEC_PATH, 'utf8'),
    readFile(PACKAGE_PATH, 'utf8'),
  ]);
  assert.equal(validateAdapterSpecOwnership(spec, packageJson), true);
});

test('accepts a complete ownership fixture', () => {
  assert.equal(validateAdapterSpecOwnership(validFixture), true);
});

test('rejects the stale only-layer-allowed fileChangesOmitted claim', () => {
  assert.throws(
    () => validateAdapterSpecOwnership(staleFixture),
    /only layer allowed to add|missing ownership contract|outsideWorkspace/,
  );
});

test('rejects omission of adapter file-count cap ownership', () => {
  const missingCap = validFixture.replace(
    /Adapters may cap retained file count and set `fileChangesOmitted` at the adapter edge\./,
    'Adapters must preserve raw diffs without capping.',
  );
  assert.throws(
    () => validateAdapterSpecOwnership(missingCap),
    /missing ownership contract: adapters may cap retained file count/,
  );
});

test('rejects ToolFileChange without outsideWorkspace marker', () => {
  const missingMarker = validFixture.replace(
    /outsideWorkspace\?: true;\n/,
    '',
  );
  assert.throws(
    () => validateAdapterSpecOwnership(missingMarker),
    /outsideWorkspace/,
  );
});
