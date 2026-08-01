/**
 * M022/S05 T04 — marketplace listing credibility machine checks.
 *
 * Objective substrate for icon / README / CHANGELOG (D071). Fixture-backed
 * node:test — never invokes vsce, Extension Host, or network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_ICON_MIN_PX,
  REQUIRED_README_SECTIONS,
  evaluateChangelogCredibility,
  evaluateIconCredibility,
  evaluateListingCredibility,
  evaluateReadmeCredibility,
  readPngIhdrDimensions,
  runListingCredibilityFromRoot,
} from './packaging-listing-credibility.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal PNG-signature + IHDR buffer with the given dimensions.
 * Enough for the pure dimension reader; not a complete image file.
 * @param {number} width
 * @param {number} height
 */
function makePngIhdrBuffer(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const VALID_README = [
  '# Muster',
  '',
  '## Features',
  'Coordinates multiple AI coding CLIs.',
  '',
  '## Prerequisites',
  '- VS Code 1.101+',
  '',
  '## Documentation',
  'See docs/.',
  '',
].join('\n');

describe('M022/S05 T04 listing credibility pure helpers (negative)', () => {
  it('rejects non-PNG buffers when reading IHDR dimensions', () => {
    assert.throws(() => readPngIhdrDimensions(Buffer.alloc(40, 0)), /PNG signature/);
    assert.throws(() => readPngIhdrDimensions(Buffer.from([1, 2, 3])), /too short/);
  });

  it('fails icon credibility when dimensions are below the marketplace minimum', () => {
    const result = evaluateIconCredibility(makePngIhdrBuffer(64, 64));
    assert.equal(result.ok, false);
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.ok(result.failures.some((f) => /128/.test(f)));
  });

  it('fails README credibility when a required section heading is missing', () => {
    const missingDocs = VALID_README.replace('## Documentation', '## Docs elsewhere');
    const result = evaluateReadmeCredibility(missingDocs);
    assert.equal(result.ok, false);
    assert.ok(result.missingSections.includes('documentation'));
    assert.ok(result.failures.some((f) => /Documentation/i.test(f)));
  });

  it('fails CHANGELOG credibility when no release heading matches package version', () => {
    const result = evaluateChangelogCredibility('# Changelog\n\n## 9.9.9\n\n- nothing\n', '0.1.0');
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => /0\.1\.0/.test(f)));
  });

  it('aggregate evaluateListingCredibility is fail-closed when any item fails', () => {
    const result = evaluateListingCredibility({
      iconBuffer: makePngIhdrBuffer(128, 128),
      readmeText: VALID_README,
      changelogText: '# Changelog\n\n## 0.0.1\n',
      version: '0.1.0',
    });
    assert.equal(result.ok, false);
    assert.equal(result.icon.ok, true);
    assert.equal(result.readme.ok, true);
    assert.equal(result.changelog.ok, false);
  });
});

describe('M022/S05 T04 listing credibility pure helpers (positive)', () => {
  it(`accepts icon at exactly ${REQUIRED_ICON_MIN_PX}×${REQUIRED_ICON_MIN_PX}`, () => {
    const result = evaluateIconCredibility(makePngIhdrBuffer(128, 128));
    assert.equal(result.ok, true);
    assert.equal(result.width, 128);
    assert.equal(result.height, 128);
    assert.deepEqual(result.failures, []);
  });

  it('accepts README with all required section ids present', () => {
    assert.ok(REQUIRED_README_SECTIONS.length >= 3);
    const result = evaluateReadmeCredibility(VALID_README);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingSections, []);
  });

  it('accepts CHANGELOG release headings in common marketplace forms', () => {
    for (const text of [
      '## 0.1.0\n\n- ship\n',
      '## [0.1.0] - 2026-07-01\n\n- ship\n',
      '# 0.1.0\n',
    ]) {
      const result = evaluateChangelogCredibility(text, '0.1.0');
      assert.equal(result.ok, true, `expected ok for: ${JSON.stringify(text)}`);
    }
  });

  it('aggregate evaluateListingCredibility is ok when all items pass', () => {
    const result = evaluateListingCredibility({
      iconBuffer: makePngIhdrBuffer(256, 256),
      readmeText: VALID_README,
      changelogText: '## 0.1.0\n\n- ok\n',
      version: '0.1.0',
    });
    assert.equal(result.ok, true);
    assert.equal(result.icon.ok, true);
    assert.equal(result.readme.ok, true);
    assert.equal(result.changelog.ok, true);
  });
});

describe('M022/S05 T04 listing credibility against the live repo tree', () => {
  it('passes for the tracked icon, README, CHANGELOG, and package.json version', async () => {
    const result = await runListingCredibilityFromRoot(REPO_ROOT);
    assert.equal(result.ok, true, result.failures.join('\n'));

    // Cross-check the live icon is a real PNG at marketplace size.
    const iconBuf = readFileSync(path.join(REPO_ROOT, 'resources', 'icon.png'));
    const dims = readPngIhdrDimensions(iconBuf);
    assert.ok(dims.width >= REQUIRED_ICON_MIN_PX);
    assert.ok(dims.height >= REQUIRED_ICON_MIN_PX);
  });
});
