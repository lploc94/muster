/**
 * M022/S05 T01 — pure install-gate result contract.
 *
 * Discriminates installed-extension origin (extensions-dir) from
 * extensionDevelopmentPath (development-path) so the install gate cannot
 * silently re-prove S01–S04 host smoke. Pure node:test — no fs I/O beyond
 * reading this module's own source for the purity assertion, no vscode.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INSTALLED_ORIGINS,
  INSTALL_GATE_PHASES,
  normalizePath,
  classifyInstalledOrigin,
  redactInstallDetail,
  parseInstallHostResult,
  buildInstallGateEvidence,
} from './packaging-install-result.mjs';

const MODULE_PATH = fileURLToPath(new URL('./packaging-install-result.mjs', import.meta.url));

const HEALTHY_BRIDGE = Object.freeze({ port: 41234, status: 'ok' });
const HEALTHY_CLOSURE = Object.freeze({
  port: 41234,
  trace: 'present',
  bridgeClosed: true,
  postExitProbe: 'refused',
  phase: 'ok',
});

/**
 * @param {Partial<Parameters<typeof buildInstallGateEvidence>[0]>} overrides
 */
function healthyEvidenceArgs(overrides = {}) {
  return {
    installExitCode: 0,
    installDetail: 'Extension installed successfully',
    installedOrigin: 'extensions-dir',
    activation: 'ok',
    bridge: { ...HEALTHY_BRIDGE },
    bridgeClosure: { ...HEALTHY_CLOSURE },
    vscodeVersion: '1.96.0',
    platform: 'linux',
    phase: 'ok',
    generatedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 1200,
    ...overrides,
  };
}

describe('INSTALLED_ORIGINS / INSTALL_GATE_PHASES', () => {
  it('exports frozen closed enums', () => {
    assert.deepEqual([...INSTALLED_ORIGINS], [
      'extensions-dir',
      'development-path',
      'unknown',
    ]);
    assert.deepEqual([...INSTALL_GATE_PHASES], [
      'ok',
      'package-failed',
      'install-rejected',
      'host-launch-failed',
      'activation-failed',
      'bridge-unreachable',
      'closure-failed',
      'origin-not-installed',
    ]);
    assert.ok(Object.isFrozen(INSTALLED_ORIGINS));
    assert.ok(Object.isFrozen(INSTALL_GATE_PHASES));
  });
});

describe('normalizePath', () => {
  it('converts backslashes to forward slashes and strips trailing slash', () => {
    assert.equal(normalizePath('C:\\Users\\x\\ext\\'), 'C:/Users/x/ext');
    assert.equal(normalizePath('/tmp/ext/'), '/tmp/ext');
  });

  it('lowercases only when caseInsensitive is true', () => {
    assert.equal(normalizePath('C:\\Users\\X', { caseInsensitive: true }), 'c:/users/x');
    assert.equal(normalizePath('C:\\Users\\X', { caseInsensitive: false }), 'C:/Users/X');
    assert.equal(normalizePath('C:\\Users\\X'), 'C:/Users/X');
  });
});

describe('classifyInstalledOrigin', () => {
  const repoRoot = '/home/runner/work/muster';
  const extensionsDir = '/tmp/muster-extensions-dir';
  const installedPath = `${extensionsDir}/hiepnh.muster-0.1.0`;

  it('returns extensions-dir for a path inside a temp extensions dir outside the repo', () => {
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: installedPath,
        extensionsDir,
        repoRoot,
      }),
      'extensions-dir',
    );
  });

  it('returns development-path when extensionPath is under repoRoot (core negative)', () => {
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: `${repoRoot}/dist/extension`,
        extensionsDir,
        repoRoot,
      }),
      'development-path',
    );
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: repoRoot,
        extensionsDir,
        repoRoot,
      }),
      'development-path',
    );
  });

  it('rejects prefix-collision: /x/ext is not a parent of /x/extra/muster', () => {
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: '/x/extra/muster',
        extensionsDir: '/x/ext',
        repoRoot: '/home/runner/work/muster',
      }),
      'unknown',
    );
  });

  it('caseInsensitive: true matches differing drive-letter case; false does not', () => {
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: 'C:\\Users\\runner\\exts\\hiepnh.muster-0.1.0',
        extensionsDir: 'c:\\Users\\runner\\exts',
        repoRoot: 'D:\\_Dev\\muster',
        caseInsensitive: true,
      }),
      'extensions-dir',
    );
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: 'C:\\Users\\runner\\exts\\hiepnh.muster-0.1.0',
        extensionsDir: 'c:\\Users\\runner\\exts',
        repoRoot: 'D:\\_Dev\\muster',
        caseInsensitive: false,
      }),
      'unknown',
    );
  });

  it('returns unknown for empty/missing inputs', () => {
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: '',
        extensionsDir,
        repoRoot,
      }),
      'unknown',
    );
    assert.equal(
      classifyInstalledOrigin({
        extensionPath: installedPath,
        extensionsDir: '',
        repoRoot,
      }),
      'unknown',
    );
  });
});

describe('redactInstallDetail', () => {
  it('erases Windows drive paths, /home/ paths, file:// URLs, and sk- tokens', () => {
    const input =
      'fail C:\\Users\\runner\\.vscode\\ext /home/runner/secret file://C:/tmp/x sk-abc123TOKEN rest';
    const out = redactInstallDetail(input);
    assert.equal(out.includes('C:\\Users'), false);
    assert.equal(out.includes('/home/runner'), false);
    assert.equal(out.includes('file://'), false);
    assert.equal(out.includes('sk-abc123TOKEN'), false);
    assert.match(out, /\[redacted\]/);
  });

  it('bounds output to maxLen (default 300)', () => {
    const long = 'word '.repeat(200);
    const out = redactInstallDetail(long);
    assert.ok(out.length <= 300);
  });

  it('redacts UNC and Bearer tokens', () => {
    const out = redactInstallDetail('see \\\\server\\share and Bearer abc.def.ghi done');
    assert.equal(out.includes('\\\\server'), false);
    assert.equal(out.includes('Bearer abc'), false);
    assert.match(out, /\[redacted\]/);
  });
});

describe('parseInstallHostResult', () => {
  const validClosure = {
    port: 9,
    trace: 'present',
    bridgeClosed: true,
    postExitProbe: 'refused',
    phase: 'ok',
  };

  it('fail-closed on null, string, and empty object', () => {
    for (const raw of [null, 'nope', {}]) {
      const r = parseInstallHostResult(raw);
      assert.equal(r.ok, false);
      assert.equal(r.activation, 'failed');
      assert.equal(r.installedOrigin, 'unknown');
      assert.equal(r.bridge, null);
      assert.equal(r.bridgeClosure, null);
      assert.equal(r.phase, 'activation-failed');
    }
  });

  it('rejects bridgeClosure missing postExitProbe or carrying an extra key', () => {
    const missingProbe = parseInstallHostResult({
      activation: 'ok',
      bridge: { port: 1, status: 'ok' },
      bridgeClosure: {
        port: 1,
        trace: 'present',
        bridgeClosed: true,
        phase: 'ok',
      },
    });
    assert.equal(missingProbe.bridgeClosure, null);

    const extraKey = parseInstallHostResult({
      activation: 'ok',
      bridge: { port: 1, status: 'ok' },
      bridgeClosure: { ...validClosure, secret: 'nope' },
    });
    assert.equal(extraKey.bridgeClosure, null);
  });

  it('accepts a well-formed host result with exact S04 bridgeClosure keys', () => {
    const r = parseInstallHostResult({
      activation: 'ok',
      extensionPath: '/tmp/exts/hiepnh.muster-0.1.0',
      bridge: { port: 9, status: 'ok', generation: 1 },
      bridgeClosure: validClosure,
    });
    assert.equal(r.activation, 'ok');
    assert.equal(r.bridge?.port, 9);
    assert.equal(r.bridge?.status, 'ok');
    assert.deepEqual(r.bridgeClosure, validClosure);
    assert.equal(r.extensionPath, '/tmp/exts/hiepnh.muster-0.1.0');
  });
});

describe('buildInstallGateEvidence', () => {
  it('yields ok:true only when all install-origin conditions hold', () => {
    const evidence = buildInstallGateEvidence(healthyEvidenceArgs());
    assert.equal(evidence.kind, 'm022-s05-install-gate');
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.installedOrigin, 'extensions-dir');
    assert.equal(evidence.installExitCode, 0);
    assert.equal(evidence.activation, 'ok');
    assert.equal(evidence.bridge.status, 'ok');
    assert.ok(evidence.bridge.port > 0);
    assert.equal(evidence.bridgeClosure.phase, 'ok');
    assert.equal(evidence.phase, 'ok');
  });

  it('dev-path origin cannot produce ok:true even when everything else is healthy', () => {
    const evidence = buildInstallGateEvidence(
      healthyEvidenceArgs({
        installedOrigin: 'development-path',
        phase: 'origin-not-installed',
      }),
    );
    assert.equal(evidence.ok, false);
    assert.equal(evidence.installedOrigin, 'development-path');
    assert.equal(evidence.phase, 'origin-not-installed');
  });

  it('yields ok:false for each single-field failure', () => {
    const cases = [
      healthyEvidenceArgs({ installExitCode: 1, phase: 'install-rejected' }),
      healthyEvidenceArgs({ activation: 'failed', phase: 'activation-failed' }),
      healthyEvidenceArgs({ bridge: null, phase: 'bridge-unreachable' }),
      healthyEvidenceArgs({
        bridge: { port: 0, status: 'ok' },
        phase: 'bridge-unreachable',
      }),
      healthyEvidenceArgs({
        bridgeClosure: { ...HEALTHY_CLOSURE, phase: 'not-closed' },
        phase: 'closure-failed',
      }),
    ];
    for (const args of cases) {
      const evidence = buildInstallGateEvidence(args);
      assert.equal(evidence.ok, false, `expected ok:false for phase=${args.phase}`);
    }
  });

  it('redacts installDetail and never smuggles unlisted keys or machine paths', () => {
    const evidence = buildInstallGateEvidence(
      healthyEvidenceArgs({
        installDetail: 'CLI said C:\\Users\\runner\\.vscode\\extensions boom',
        // @ts-expect-error intentional smuggle attempt
        secretToken: 'sk-should-not-appear',
        absolutePath: '/home/runner/work/muster',
      }),
    );
    assert.equal(evidence.installStderrExcerpt.includes('C:\\Users'), false);
    assert.match(evidence.installStderrExcerpt, /\[redacted\]/);
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('C:\\\\Users'), false);
    assert.equal(serialized.includes('/home/runner'), false);
    assert.equal(serialized.includes('sk-should-not-appear'), false);
    assert.equal(Object.hasOwn(evidence, 'secretToken'), false);
    assert.equal(Object.hasOwn(evidence, 'absolutePath'), false);
    assert.equal(Object.hasOwn(evidence, 'installDetail'), false);
  });
});

describe('module purity', () => {
  it('source contains no node:fs, node:child_process, or vscode require', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    assert.equal(source.includes('node:fs'), false);
    assert.equal(source.includes('node:child_process'), false);
    assert.equal(source.includes("require('vscode')"), false);
    assert.equal(source.includes('require("vscode")'), false);
    assert.equal(source.includes("from 'vscode'"), false);
    assert.equal(source.includes('from "vscode"'), false);
  });
});
