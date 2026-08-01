/**
 * M022/S05 T04 — marketplace listing credibility machine checks (D071).
 *
 * Objective substrate for the marketplace listing: icon PNG dimensions,
 * required README section headings, and a CHANGELOG release heading that
 * matches package.json version. Pure evaluation helpers take buffers/strings
 * so node:test can fixture them; `runListingCredibilityFromRoot` is the thin
 * filesystem adapter for the live tree and for `npm run test:m022-s05`.
 *
 * Human judgement lives separately in
 * docs/uat/m022-s05/marketplace-listing-signoff.md and is enforced by
 * scripts/verify-m022-s05-listing-signoff.test.mjs.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marketplace minimum icon edge length in pixels. */
export const REQUIRED_ICON_MIN_PX = 128;

/**
 * Required top-level README sections for listing credibility.
 * Patterns match ATFM headings such as `## Features (current & planned)`.
 *
 * @type {readonly { id: string, label: string, pattern: RegExp }[]}
 */
export const REQUIRED_README_SECTIONS = Object.freeze([
  {
    id: 'features',
    label: 'Features',
    pattern: /^#{1,3}\s+Features\b/im,
  },
  {
    id: 'prerequisites',
    label: 'Prerequisites',
    pattern: /^#{1,3}\s+Prerequisites\b/im,
  },
  {
    id: 'documentation',
    label: 'Documentation',
    pattern: /^#{1,3}\s+Documentation\b/im,
  },
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parse PNG IHDR width/height without external deps.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 */
export function readPngIhdrDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    throw new Error('PNG buffer too short for IHDR');
  }
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('file must start with the PNG signature');
  }
  const length = buf.readUInt32BE(8);
  const type = buf.subarray(12, 16).toString('ascii');
  if (type !== 'IHDR') {
    throw new Error(`first PNG chunk must be IHDR, got ${type}`);
  }
  if (length !== 13) {
    throw new Error('IHDR data length must be 13');
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

/**
 * @param {Buffer} pngBuffer
 * @returns {{ ok: boolean, width: number | null, height: number | null, failures: string[] }}
 */
export function evaluateIconCredibility(pngBuffer) {
  const failures = [];
  try {
    const { width, height } = readPngIhdrDimensions(pngBuffer);
    if (width < REQUIRED_ICON_MIN_PX || height < REQUIRED_ICON_MIN_PX) {
      failures.push(
        `icon dimensions must be ≥${REQUIRED_ICON_MIN_PX}×${REQUIRED_ICON_MIN_PX}; got ${width}×${height}`,
      );
    }
    return {
      ok: failures.length === 0,
      width,
      height,
      failures,
    };
  } catch (err) {
    failures.push(`icon is not a readable PNG: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, width: null, height: null, failures };
  }
}

/**
 * @param {string} readmeText
 * @returns {{ ok: boolean, missingSections: string[], failures: string[] }}
 */
export function evaluateReadmeCredibility(readmeText) {
  const text = typeof readmeText === 'string' ? readmeText : '';
  const missingSections = [];
  const failures = [];

  if (!text.trim()) {
    failures.push('README.md is empty');
    return {
      ok: false,
      missingSections: REQUIRED_README_SECTIONS.map((s) => s.id),
      failures,
    };
  }

  for (const section of REQUIRED_README_SECTIONS) {
    if (!section.pattern.test(text)) {
      missingSections.push(section.id);
      failures.push(`README.md missing required section heading: ${section.label}`);
    }
  }

  return {
    ok: failures.length === 0,
    missingSections,
    failures,
  };
}

/**
 * @param {string} changelogText
 * @param {string} version
 * @returns {{ ok: boolean, version: string, failures: string[] }}
 */
export function evaluateChangelogCredibility(changelogText, version) {
  const failures = [];
  const ver = typeof version === 'string' ? version.trim() : '';
  if (!ver) {
    failures.push('package.json version is missing');
    return { ok: false, version: ver, failures };
  }

  const text = typeof changelogText === 'string' ? changelogText : '';
  if (!text.trim()) {
    failures.push('CHANGELOG.md is empty');
    return { ok: false, version: ver, failures };
  }

  // Accept "# 0.1.0", "## [0.1.0]", "## 0.1.0 - 2026-…", etc.
  const escaped = ver.replace(/\./g, '\\.');
  const headingRe = new RegExp(`^#{1,3}\\s*\\[?${escaped}\\]?\\b`, 'm');
  if (!headingRe.test(text)) {
    failures.push(`CHANGELOG.md must contain a release heading for version ${ver}`);
  }

  return {
    ok: failures.length === 0,
    version: ver,
    failures,
  };
}

/**
 * @param {{
 *   iconBuffer: Buffer,
 *   readmeText: string,
 *   changelogText: string,
 *   version: string,
 * }} input
 */
export function evaluateListingCredibility(input) {
  const icon = evaluateIconCredibility(input.iconBuffer);
  const readme = evaluateReadmeCredibility(input.readmeText);
  const changelog = evaluateChangelogCredibility(input.changelogText, input.version);
  const failures = [...icon.failures, ...readme.failures, ...changelog.failures];
  return {
    ok: icon.ok && readme.ok && changelog.ok,
    icon,
    readme,
    changelog,
    failures,
  };
}

/**
 * Filesystem adapter: evaluate the live (or fixture) tree.
 * @param {string} rootDir
 */
export async function runListingCredibilityFromRoot(rootDir) {
  const failures = [];
  /** @type {Buffer | null} */
  let iconBuffer = null;
  /** @type {string} */
  let readmeText = '';
  /** @type {string} */
  let changelogText = '';
  /** @type {string} */
  let version = '';

  try {
    const pkgRaw = await readFile(path.join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    version = typeof pkg.version === 'string' ? pkg.version : '';
    if (!version) failures.push('package.json version is missing');
  } catch (err) {
    failures.push(
      `unable to read package.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    iconBuffer = await readFile(path.join(rootDir, 'resources', 'icon.png'));
  } catch (err) {
    failures.push(
      `unable to read resources/icon.png: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    readmeText = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  } catch (err) {
    failures.push(
      `unable to read README.md: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    changelogText = await readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
  } catch (err) {
    failures.push(
      `unable to read CHANGELOG.md: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!iconBuffer) {
    return {
      ok: false,
      icon: { ok: false, width: null, height: null, failures: ['resources/icon.png missing'] },
      readme: evaluateReadmeCredibility(readmeText),
      changelog: evaluateChangelogCredibility(changelogText, version),
      failures,
    };
  }

  const result = evaluateListingCredibility({
    iconBuffer,
    readmeText,
    changelogText,
    version,
  });
  return {
    ...result,
    failures: [...failures, ...result.failures],
    ok: failures.length === 0 && result.ok,
  };
}

// CLI entry: node scripts/packaging-listing-credibility.mjs
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = process.cwd();
  const result = await runListingCredibilityFromRoot(root);
  if (!result.ok) {
    for (const [i, failure] of result.failures.entries()) {
      console.error(`${i + 1}. ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          icon: { width: result.icon.width, height: result.icon.height },
          readmeMissing: result.readme.missingSections,
          changelogVersion: result.changelog.version,
        },
        null,
        2,
      ),
    );
  }
}
