/**
 * M022/S05 T02 — install Extension Host smoke contract.
 *
 * Pure node:test coverage for the install host-smoke surface. Does not launch
 * VS Code. Asserts:
 * - the smoke source reports extensionPath (install-vs-dev origin input)
 * - the smoke reuses the S04 bridgeClosure key set
 * - a healthy install-host payload is consumable by parseInstallHostResult
 * - development-path extensionPath can never green the install gate
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  classifyInstalledOrigin,
  parseInstallHostResult,
  buildInstallGateEvidence,
} from './packaging-install-result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_TS = path.join(ROOT, 'scripts', 'packaging-install-host-smoke.ts');
const SMOKE_JS = path.join(ROOT, 'dist', 'scripts', 'packaging-install-host-smoke.js');

const HEALTHY_BRIDGE = Object.freeze({ port: 45123, status: 'ok', generation: 1 });
const HEALTHY_CLOSURE = Object.freeze({
  port: 45123,
  trace: 'present',
  bridgeClosed: true,
  postExitProbe: 'refused',
  phase: 'ok',
});

/**
 * Fixture matching the install host-smoke result shape (what T03 runner reads).
 * @param {Record<string, unknown>} [overrides]
 */
function healthyInstallHostResult(overrides = {}) {
  return {
    kind: 'm022-s05-install-host-smoke',
    ok: true,
    activation: 'ok',
    extensionPath: '/tmp/muster-extensions-dir/tlelabs.muster-0.1.0',
    bridge: { ...HEALTHY_BRIDGE },
    bridgePhase: 'ok',
    bridgeClosure: { ...HEALTHY_CLOSURE },
    entrypoints: [
      {
        path: 'extension/dist/src/extension.js',
        present: true,
        resolved: true,
        phase: 'ok',
      },
      {
        path: 'extension/dist/src/task/sqlite/worker.js',
        present: true,
        resolved: true,
        phase: 'ok',
      },
      {
        path: 'extension/dist/src/bridge/mcp-stdio-proxy.js',
        present: true,
        resolved: true,
        phase: 'ok',
      },
    ],
    ...overrides,
  };
}

describe('packaging-install-host-smoke source contract', () => {
  it('exists as a TypeScript Extension Host entry', () => {
    assert.equal(existsSync(SMOKE_TS), true, `missing ${SMOKE_TS}`);
    const src = readFileSync(SMOKE_TS, 'utf8');
    assert.match(src, /export async function run\s*\(/);
    assert.match(src, /import \* as vscode from ['"]vscode['"]/);
  });

  it('uses a dedicated install host-smoke kind (not the S01 packaging kind)', () => {
    const src = readFileSync(SMOKE_TS, 'utf8');
    assert.match(src, /m022-s05-install-host-smoke/);
    assert.doesNotMatch(src, /m022-s01-packaging-host-smoke/);
  });

  it('records resolved extensionPath on every host result for origin classification', () => {
    const src = readFileSync(SMOKE_TS, 'utf8');
    // Must read the installed extension's path from vscode
    assert.match(src, /extension\.extensionPath/);
    // Result type and write path must carry extensionPath (type field + object keys)
    assert.match(src, /extensionPath\s*:/);
    // Fail-closed / success paths still include extensionPath when known
    // (explicit key or ES shorthand property on result / fail() payloads)
    assert.match(
      src,
      /extensionPath\s*:\s*(?:partial\.extensionPath|extensionPath)|(?:,|\{)\s*extensionPath\s*,/,
    );
    // Success result object includes extensionPath
    assert.match(src, /const result:[\s\S]*?extensionPath[\s\S]*?writeResult\(result\)/);
  });

  it('reuses the S04 bridge-closure proof (runDeactivate + exact key set)', () => {
    const src = readFileSync(SMOKE_TS, 'utf8');
    assert.match(src, /muster\.uat\.runDeactivate/);
    assert.match(src, /muster\.uat\.bridgeHealth/);
    for (const key of ['port', 'trace', 'bridgeClosed', 'postExitProbe', 'phase']) {
      assert.match(
        src,
        new RegExp(key),
        `bridgeClosure must observe ${key}`,
      );
    }
    // Closure is never inferred from process exit alone
    assert.match(src, /postExitProbe/);
    assert.match(src, /ECONNREFUSED|refused/);
  });

  it('requires MUSTER_UAT_MODE and writes MUSTER_PACKAGING_HOST_RESULT_OUT', () => {
    const src = readFileSync(SMOKE_TS, 'utf8');
    assert.match(src, /MUSTER_UAT_MODE/);
    assert.match(src, /MUSTER_PACKAGING_HOST_RESULT_OUT/);
  });

  it('looks up the published extension id tlelabs.muster (installed, not dev-path-only)', () => {
    const src = readFileSync(SMOKE_TS, 'utf8');
    assert.match(src, /getExtension\(\s*['"]tlelabs\.muster['"]\s*\)/);
  });
});

describe('install host result ↔ install-gate contract', () => {
  it('parseInstallHostResult accepts a healthy install-host payload with extensionPath', () => {
    const raw = healthyInstallHostResult();
    const parsed = parseInstallHostResult(raw);
    assert.equal(parsed.activation, 'ok');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.phase, 'ok');
    assert.equal(parsed.extensionPath, raw.extensionPath);
    assert.equal(parsed.bridge?.port, 45123);
    assert.equal(parsed.bridgeClosure?.phase, 'ok');
    assert.equal(parsed.bridgeClosure?.postExitProbe, 'refused');
  });

  it('rejects bridgeClosure with extra keys (exact S04 key set only)', () => {
    const raw = healthyInstallHostResult({
      bridgeClosure: {
        ...HEALTHY_CLOSURE,
        leakedToken: 'sk-test',
      },
    });
    const parsed = parseInstallHostResult(raw);
    assert.equal(parsed.bridgeClosure, null);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.phase, 'closure-failed');
  });

  it('development-path extensionPath cannot produce install-gate ok:true', () => {
    const repoRoot = '/home/runner/work/muster';
    const extensionsDir = '/tmp/muster-extensions-dir';
    const raw = healthyInstallHostResult({
      extensionPath: `${repoRoot}/dist/extension`,
    });
    const parsed = parseInstallHostResult(raw);
    const origin = classifyInstalledOrigin({
      extensionPath: parsed.extensionPath,
      extensionsDir,
      repoRoot,
    });
    assert.equal(origin, 'development-path');
    const evidence = buildInstallGateEvidence({
      installExitCode: 0,
      installDetail: 'ok',
      installedOrigin: origin,
      activation: parsed.activation,
      bridge: parsed.bridge,
      bridgeClosure: parsed.bridgeClosure,
      vscodeVersion: '1.96.0',
      platform: 'linux',
      phase: 'ok',
      generatedAt: '2026-07-29T00:00:00.000Z',
      durationMs: 1,
    });
    assert.equal(evidence.ok, false);
    assert.equal(evidence.installedOrigin, 'development-path');
  });

  it('extensions-dir extensionPath can produce install-gate ok:true', () => {
    const repoRoot = '/home/runner/work/muster';
    const extensionsDir = '/tmp/muster-extensions-dir';
    const extensionPath = `${extensionsDir}/tlelabs.muster-0.1.0`;
    const raw = healthyInstallHostResult({ extensionPath });
    const parsed = parseInstallHostResult(raw);
    const origin = classifyInstalledOrigin({
      extensionPath: parsed.extensionPath,
      extensionsDir,
      repoRoot,
    });
    assert.equal(origin, 'extensions-dir');
    const evidence = buildInstallGateEvidence({
      installExitCode: 0,
      installDetail: 'Extension installed successfully',
      installedOrigin: origin,
      activation: parsed.activation,
      bridge: parsed.bridge,
      bridgeClosure: parsed.bridgeClosure,
      vscodeVersion: '1.96.0',
      platform: 'linux',
      phase: 'ok',
      generatedAt: '2026-07-29T00:00:00.000Z',
      durationMs: 1200,
    });
    assert.equal(evidence.ok, true);
    assert.equal(evidence.installedOrigin, 'extensions-dir');
  });

  it('missing activation fails closed without pretending install origin is ok', () => {
    const raw = healthyInstallHostResult({
      ok: false,
      activation: 'failed',
      bridge: null,
      bridgePhase: 'activation',
      bridgeClosure: null,
      extensionPath: null,
      detail: 'packaged tlelabs.muster was not discovered',
    });
    const parsed = parseInstallHostResult(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.activation, 'failed');
    assert.equal(parsed.phase, 'activation-failed');
  });
});

describe('compiled install host smoke output', () => {
  it('dist/scripts/packaging-install-host-smoke.js is emitted by tsc when present', () => {
    // Soft contract during edit loop: if tsc has run, the artifact must exist and export run.
    // Verify command in the plan hard-requires it after `npx tsc -p .`.
    if (!existsSync(SMOKE_JS)) {
      // Still assert the source path is correct so the tsc outDir mapping is obvious.
      assert.equal(
        path.relative(ROOT, SMOKE_TS).replace(/\\/g, '/'),
        'scripts/packaging-install-host-smoke.ts',
      );
      return;
    }
    const st = statSync(SMOKE_JS);
    assert.ok(st.isFile());
    assert.ok(st.size > 0);
    const js = readFileSync(SMOKE_JS, 'utf8');
    assert.match(js, /m022-s05-install-host-smoke/);
    assert.match(js, /extensionPath/);
    assert.match(js, /exports\.run|function run/);
  });
});
