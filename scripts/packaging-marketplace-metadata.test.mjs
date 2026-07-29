/**
 * M022/S03 T01 — marketplace metadata contract.
 *
 * R036 remaining criteria: a real 128×128 icon, categories beyond ["Other"],
 * and a root CHANGELOG.md whose release heading matches package.json version.
 * Both the icon and CHANGELOG must not be excluded by .vscodeignore so they
 * actually ship in the VSIX.
 *
 * Fixture-backed node:test — never invokes vsce, the Extension Host, or network.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Marketplace categories we accept as non-placeholder for Muster. */
const REQUIRED_NON_OTHER_CATEGORIES = ['AI', 'Chat'];

/**
 * Parse PNG IHDR width/height without external deps.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 */
export function readPngIhdrDimensions(buf) {
  assert.ok(Buffer.isBuffer(buf) && buf.length >= 33, 'PNG buffer too short for IHDR');
  assert.equal(
    buf.subarray(0, 8).equals(PNG_SIGNATURE),
    true,
    'file must start with the PNG signature',
  );
  const length = buf.readUInt32BE(8);
  const type = buf.subarray(12, 16).toString('ascii');
  assert.equal(type, 'IHDR', `first PNG chunk must be IHDR, got ${type}`);
  assert.equal(length, 13, 'IHDR data length must be 13');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

/**
 * True when a .vscodeignore line would exclude the given relative path.
 * Handles exact matches, trailing-slash directories, and simple ** globs used
 * in this repo's ignore file. Does not reimplement the full minimatch engine.
 * @param {string} pattern
 * @param {string} relPath posix-style relative path from repo root
 */
export function vscodeIgnorePatternExcludes(pattern, relPath) {
  const raw = pattern.trim();
  if (!raw || raw.startsWith('#')) return false;
  const p = raw.replace(/\\/g, '/');
  const target = relPath.replace(/\\/g, '/');

  if (p === target) return true;
  if (p.endsWith('/') && (target === p.slice(0, -1) || target.startsWith(p))) return true;

  // directory/** style
  if (p.endsWith('/**')) {
    const prefix = p.slice(0, -3);
    if (target === prefix || target.startsWith(`${prefix}/`)) return true;
  }

  // bare directory without slash means that path and descendants in vsce
  if (!p.includes('*') && !p.includes('?') && !p.includes('.')) {
    if (target === p || target.startsWith(`${p}/`)) return true;
  }

  // simple * and ** file globs against the basename or full path
  if (p.includes('*')) {
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    if (re.test(target) || re.test(path.posix.basename(target))) return true;
  }

  return false;
}

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

function readVscodeIgnorePatterns() {
  const text = readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf8');
  return text.split(/\r?\n/);
}

describe('M022/S03 T01 marketplace metadata helpers (negative)', () => {
  it('rejects non-PNG buffers when reading IHDR dimensions', () => {
    assert.throws(
      () => readPngIhdrDimensions(Buffer.alloc(40, 0)),
      /PNG signature/,
    );
    assert.throws(
      () => readPngIhdrDimensions(Buffer.from([1, 2, 3])),
      /too short/,
    );
  });

  it('detects .vscodeignore patterns that would exclude protected paths', () => {
    assert.equal(vscodeIgnorePatternExcludes('CHANGELOG.md', 'CHANGELOG.md'), true);
    assert.equal(vscodeIgnorePatternExcludes('resources/**', 'resources/icon.png'), true);
    assert.equal(vscodeIgnorePatternExcludes('*.png', 'resources/icon.png'), true);
    assert.equal(vscodeIgnorePatternExcludes('docs/**', 'CHANGELOG.md'), false);
    assert.equal(vscodeIgnorePatternExcludes('scripts/**', 'resources/icon.png'), false);
  });
});

describe('M022/S03 T01 marketplace metadata', () => {
  it('declares icon as resources/icon.png and the file is a ≥128×128 PNG', () => {
    const pkg = readPackageJson();
    assert.equal(pkg.icon, 'resources/icon.png', 'package.json icon must be resources/icon.png');

    const iconPath = path.join(REPO_ROOT, 'resources', 'icon.png');
    assert.equal(existsSync(iconPath), true, 'resources/icon.png must exist');

    const buf = readFileSync(iconPath);
    const { width, height } = readPngIhdrDimensions(buf);
    assert.ok(width >= 128, `icon width must be ≥128, got ${width}`);
    assert.ok(height >= 128, `icon height must be ≥128, got ${height}`);
  });

  it('uses real marketplace categories beyond Other (AI + Chat)', () => {
    const pkg = readPackageJson();
    const categories = pkg.categories;
    assert.ok(Array.isArray(categories), 'categories must be an array');
    for (const required of REQUIRED_NON_OTHER_CATEGORIES) {
      assert.ok(
        categories.includes(required),
        `categories must include "${required}"; got ${JSON.stringify(categories)}`,
      );
    }
    const nonOther = categories.filter((c) => c !== 'Other');
    assert.ok(
      nonOther.length >= 2,
      `categories must contain at least two non-Other entries; got ${JSON.stringify(categories)}`,
    );
  });

  it('ships a root CHANGELOG.md with a release heading for the package version', () => {
    const pkg = readPackageJson();
    const version = pkg.version;
    assert.equal(typeof version, 'string', 'package.json version must be a string');

    const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
    assert.equal(existsSync(changelogPath), true, 'CHANGELOG.md must exist at repo root');

    const text = readFileSync(changelogPath, 'utf8');
    // Accept "# 0.1.0", "## [0.1.0]", "## 0.1.0 - 2026-…", etc.
    const headingRe = new RegExp(
      `^#{1,3}\\s*\\[?${version.replace(/\./g, '\\.')}\\]?\\b`,
      'm',
    );
    assert.match(
      text,
      headingRe,
      `CHANGELOG.md must contain a release heading for version ${version}`,
    );
  });

  it('does not exclude resources/icon.png or CHANGELOG.md via .vscodeignore', () => {
    const patterns = readVscodeIgnorePatterns();
    const protectedPaths = ['resources/icon.png', 'CHANGELOG.md'];
    for (const rel of protectedPaths) {
      const hit = patterns.find((line) => vscodeIgnorePatternExcludes(line, rel));
      assert.equal(
        hit,
        undefined,
        `${rel} must not be excluded by .vscodeignore (matched pattern: ${JSON.stringify(hit)})`,
      );
    }
  });
});
