import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const requiredMappings = {
  R040: ['docs/plans/m023-s05-storage-lifecycle-evidence.json'],
  R041: ['docs/plans/m023-s05-storage-lifecycle-evidence.json'],
  R042: ['docs/plans/m023-s05-storage-lifecycle-evidence.json'],
  R043: ['docs/plans/m023-s05-storage-lifecycle-evidence.json'],
  R044: ['docs/plans/m023-s05-storage-lifecycle-evidence.json'],
  R045: ['docs/plans/m023-s08-orphan-lifecycle-evidence.json'],
  R046: ['scripts/verify-uninstall-entrypoint.test.mjs'],
};

function mappedReferences(markdown, id) {
  const heading = `## ${id}`;
  const start = markdown.indexOf(heading);
  const next = markdown.indexOf('\n## ', start + heading.length);
  const section = start >= 0 ? markdown.slice(start, next >= 0 ? next : undefined) : '';
  return [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

async function assertTrackedFile(path) {
  await access(new URL(path, root));
}

async function validateRequirementEvidence(markdown, assertFile = assertTrackedFile) {
  assert.match(markdown, /^# M023 requirement evidence$/m);

  for (const [id, expectedReferences] of Object.entries(requiredMappings)) {
    const references = mappedReferences(markdown, id);
    assert.ok(references.length > 0, `missing evidence mapping: ${id}`);
    for (const expected of expectedReferences) {
      assert.ok(references.includes(expected), `${id} missing required evidence reference: ${expected}`);
    }
    for (const reference of references.filter((value) => value.startsWith('docs/'))) {
      await assertFile(reference);
    }
  }
}

async function loadTrackedFiles() {
  return readFile(new URL('docs/plans/m023-requirement-evidence.md', root), 'utf8');
}

test('tracked M023 requirement evidence maps R040 through R046 to existing artifacts', async () => {
  await validateRequirementEvidence(await loadTrackedFiles());
});

test('rejects missing mappings and missing artifact files', async () => {
  const markdown = await loadTrackedFiles();
  await assert.rejects(
    validateRequirementEvidence(markdown.replace('## R046', '## Missing R046')),
    /missing evidence mapping: R046/,
  );
  await assert.rejects(
    validateRequirementEvidence(markdown, async (reference) => {
      if (reference === 'docs/plans/m023-s08-orphan-lifecycle-evidence.json') {
        throw new Error(`missing artifact file: ${reference}`);
      }
    }),
    /missing artifact file: docs\/plans\/m023-s08-orphan-lifecycle-evidence\.json/,
  );
});
