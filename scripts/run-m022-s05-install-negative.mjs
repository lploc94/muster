/**
 * M022/S05 T03 — corrupted-VSIX fail-closed drill (D071).
 *
 * 1. Package a clean VSIX via createVSIX into a temp dir.
 * 2. Rezip a corrupted copy with extension/dist/src/extension.js removed.
 * 3. Invoke the install gate against the corrupted VSIX with --evidence at a
 *    temp path so docs/plans/m022-s05-install-gate-evidence.json is never
 *    clobbered by a run designed to fail.
 * 4. Require a non-zero exit and a typed phase from the closed set
 *    {install-rejected, activation-failed, bridge-unreachable}.
 * 5. Mutate zero tracked files; write
 *    docs/plans/m022-s05-install-negative-evidence.json.
 *
 * Self-diagnosing: always prints gate exit code, observed phase, and whether
 * the positive evidence path was left untouched — even on abort.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createVSIX } from '@vscode/vsce';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const TRACKED_INSTALL_EVIDENCE_REL = 'docs/plans/m022-s05-install-gate-evidence.json';
const TRACKED_INSTALL_EVIDENCE_PATH = path.join(root, TRACKED_INSTALL_EVIDENCE_REL);
const NEGATIVE_EVIDENCE_REL = 'docs/plans/m022-s05-install-negative-evidence.json';
const NEGATIVE_EVIDENCE_PATH = path.join(root, NEGATIVE_EVIDENCE_REL);
const REMOVED_ENTRY = 'extension/dist/src/extension.js';
const NEGATIVE_PHASES = new Set([
  'install-rejected',
  'activation-failed',
  'bridge-unreachable',
]);

/** @type {{
 *   gateExitCode: number | null,
 *   gatePhase: string | null,
 *   trackedInstallEvidenceShaBefore: string | null,
 *   trackedInstallEvidenceShaAfter: string | null,
 *   trackedInstallEvidenceUnchanged: boolean | null,
 *   cleaned: boolean,
 * }} */
const drillState = {
  gateExitCode: null,
  gatePhase: null,
  trackedInstallEvidenceShaBefore: null,
  trackedInstallEvidenceShaAfter: null,
  trackedInstallEvidenceUnchanged: null,
  cleaned: false,
};

/**
 * @param {string} label
 * @param {unknown} value
 */
function log(label, value) {
  console.log(`[m022-s05-install-negative] ${label}: ${String(value)}`);
}

/**
 * @param {string | null} filePath
 * @returns {string | null}
 */
function fileSha256(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * @param {string} cleanVsixPath
 * @param {string} corruptedVsixPath
 */
function writeCorruptedVsix(cleanVsixPath, corruptedVsixPath) {
  const zip = new AdmZip(cleanVsixPath);
  const before = zip.getEntries().map((e) => String(e.entryName ?? '').replaceAll('\\', '/'));
  if (!before.includes(REMOVED_ENTRY)) {
    throw new Error(
      `clean VSIX is missing ${REMOVED_ENTRY}; cannot corrupt what is not present`,
    );
  }
  const entry = zip.getEntry(REMOVED_ENTRY);
  if (!entry) {
    const alt = zip
      .getEntries()
      .find(
        (e) =>
          String(e.entryName ?? '').replaceAll('\\', '/') === REMOVED_ENTRY,
      );
    if (!alt) {
      throw new Error(`could not locate zip entry ${REMOVED_ENTRY}`);
    }
    zip.deleteFile(alt);
  } else {
    zip.deleteFile(entry);
  }
  zip.writeZip(corruptedVsixPath);

  const check = new AdmZip(corruptedVsixPath);
  const after = check
    .getEntries()
    .map((e) => String(e.entryName ?? '').replaceAll('\\', '/'));
  if (after.includes(REMOVED_ENTRY)) {
    throw new Error(`corruption failed: ${REMOVED_ENTRY} still present in rezipped VSIX`);
  }
  log('corrupted-entry-removed', REMOVED_ENTRY);
  log('corrupted-entry-count', after.length);
}

/**
 * @param {string} vsixPath
 * @param {string} tempEvidencePath
 * @returns {{ exitCode: number, combined: string, phase: string | null }}
 */
function runInstallGate(vsixPath, tempEvidencePath) {
  const runner = path.join(root, 'scripts', 'run-m022-s05-install-gate.mjs');
  const result = spawnSync(
    process.execPath,
    [runner, '--vsix', vsixPath, '--evidence', tempEvidencePath],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : result.signal
        ? 1
        : result.error
          ? 1
          : 1;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}${
    result.error ? `\n${result.error.message}` : ''
  }`;

  /** @type {string | null} */
  let phase = null;
  if (existsSync(tempEvidencePath)) {
    try {
      const ev = JSON.parse(readFileSync(tempEvidencePath, 'utf8'));
      if (ev && typeof ev.phase === 'string') {
        phase = ev.phase;
      }
    } catch {
      phase = null;
    }
  }
  if (!phase) {
    const m = combined.match(/\[m022-s05-install-gate\] phase:\s*(\S+)/);
    if (m) phase = m[1];
  }
  return { exitCode, combined, phase };
}

/**
 * @param {{
 *   ok: boolean,
 *   gateExitCode: number,
 *   gatePhase: string,
 *   durationMs: number,
 * }} args
 */
function writeNegativeEvidence({ ok, gateExitCode, gatePhase, durationMs }) {
  const evidence = {
    kind: 'm022-s05-install-negative',
    ok,
    corruption: 'removed-extension-entry',
    removedEntry: REMOVED_ENTRY,
    gateExitCode,
    gatePhase,
    trackedFilesMutated: 0,
    evidenceTarget: 'temp',
    generatedAt: new Date().toISOString(),
    durationMs,
  };
  mkdirSync(path.dirname(NEGATIVE_EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    NEGATIVE_EVIDENCE_PATH,
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
  log('wrote-evidence', NEGATIVE_EVIDENCE_REL);
}

async function main() {
  const started = Date.now();
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'muster-s05-install-neg-'));
  const cleanVsixPath = path.join(scratchDir, 'clean.vsix');
  const corruptedVsixPath = path.join(scratchDir, 'corrupted.vsix');
  const tempEvidencePath = path.join(scratchDir, 'install-gate-temp-evidence.json');

  drillState.trackedInstallEvidenceShaBefore = fileSha256(TRACKED_INSTALL_EVIDENCE_PATH);
  log('tracked-install-evidence-present-before', existsSync(TRACKED_INSTALL_EVIDENCE_PATH));

  try {
    log('stage', 'createVSIX (clean)');
    await createVSIX({
      cwd: root,
      packagePath: cleanVsixPath,
      dependencies: true,
      allowMissingRepository: false,
    });
    if (!existsSync(cleanVsixPath)) {
      throw new Error('createVSIX did not produce a clean VSIX for corruption');
    }
    log('clean-vsix', 'ok');

    log('stage', 'corrupt-vsix');
    writeCorruptedVsix(cleanVsixPath, corruptedVsixPath);

    log('stage', 'run-install-gate-against-corrupted-vsix');
    log(
      'command-expected-to-fail',
      'node scripts/run-m022-s05-install-gate.mjs --vsix <corrupted> --evidence <temp>',
    );
    const { exitCode, combined, phase } = runInstallGate(
      corruptedVsixPath,
      tempEvidencePath,
    );
    drillState.gateExitCode = exitCode;
    drillState.gatePhase = phase;
    log('gateExitCode', exitCode);
    log('gatePhase', phase ?? '<missing>');
    const excerpt = combined.replace(/\s+/g, ' ').trim().slice(0, 500);
    log('gate-output-excerpt', excerpt);

    drillState.trackedInstallEvidenceShaAfter = fileSha256(TRACKED_INSTALL_EVIDENCE_PATH);
    drillState.trackedInstallEvidenceUnchanged =
      drillState.trackedInstallEvidenceShaBefore ===
      drillState.trackedInstallEvidenceShaAfter;
    log(
      'tracked-install-evidence-unchanged',
      drillState.trackedInstallEvidenceUnchanged,
    );

    const phaseOk = typeof phase === 'string' && NEGATIVE_PHASES.has(phase);
    const exitOk = exitCode !== 0;
    const noClobber = drillState.trackedInstallEvidenceUnchanged === true;
    const ok = exitOk && phaseOk && noClobber;

    writeNegativeEvidence({
      ok,
      gateExitCode: exitCode,
      gatePhase: phaseOk && phase ? phase : phase || 'activation-failed',
      durationMs: Date.now() - started,
    });

    if (!exitOk) {
      throw new Error(
        `expected non-zero install-gate exit for corrupted VSIX; got ${exitCode}`,
      );
    }
    if (!phaseOk) {
      throw new Error(
        `expected typed phase in {${[...NEGATIVE_PHASES].join(', ')}}; got ${String(phase)}`,
      );
    }
    if (!noClobber) {
      throw new Error(
        `${TRACKED_INSTALL_EVIDENCE_REL} was modified by the negative drill — evidence must route to temp only`,
      );
    }

    log('verdict', 'fail-closed-ok');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', message);
    if (!existsSync(NEGATIVE_EVIDENCE_PATH) || drillState.gateExitCode !== null) {
      try {
        writeNegativeEvidence({
          ok: false,
          gateExitCode: drillState.gateExitCode ?? 1,
          gatePhase:
            drillState.gatePhase && NEGATIVE_PHASES.has(drillState.gatePhase)
              ? drillState.gatePhase
              : 'activation-failed',
          durationMs: Date.now() - started,
        });
      } catch {
        // ignore secondary write failure
      }
    }
    process.exitCode = 1;
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
      drillState.cleaned = true;
      log('cleanup', 'ok');
    } catch (cleanupErr) {
      log(
        'cleanup-failed',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      );
    }
    log('gateExitCode-final', drillState.gateExitCode);
    log('gatePhase-final', drillState.gatePhase);
    log(
      'tracked-install-evidence-unchanged-final',
      drillState.trackedInstallEvidenceUnchanged,
    );
  }
}

main().catch((err) => {
  console.error(
    '[m022-s05-install-negative] fatal:',
    err instanceof Error ? err.stack || err.message : err,
  );
  process.exitCode = 1;
});
