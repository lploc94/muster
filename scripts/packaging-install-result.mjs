/**
 * M022/S05 T01 — pure install-gate result contract.
 *
 * Classifies whether an Extension Host loaded Muster from a real CLI install
 * (`extensions-dir`) or from extensionDevelopmentPath (`development-path`).
 * Pure data + pure functions only — no filesystem, subprocess, or editor APIs.
 *
 * Downstream (T02/T03) runners feed host-smoke JSON and install CLI output into
 * these helpers so the tracked evidence artifact cannot silently re-prove the
 * S01–S04 development-path host smoke while looking green.
 */

/** @typedef {'extensions-dir' | 'development-path' | 'unknown'} InstalledOrigin */
/** @typedef {'ok' | 'package-failed' | 'install-rejected' | 'host-launch-failed' | 'activation-failed' | 'bridge-unreachable' | 'closure-failed' | 'origin-not-installed'} InstallGatePhase */

/** @type {readonly InstalledOrigin[]} */
export const INSTALLED_ORIGINS = Object.freeze([
  'extensions-dir',
  'development-path',
  'unknown',
]);

/** @type {readonly InstallGatePhase[]} */
export const INSTALL_GATE_PHASES = Object.freeze([
  'ok',
  'package-failed',
  'install-rejected',
  'host-launch-failed',
  'activation-failed',
  'bridge-unreachable',
  'closure-failed',
  'origin-not-installed',
]);

/** Exact S04 bridgeClosure key set — extra or missing keys reject the object. */
const BRIDGE_CLOSURE_KEYS = Object.freeze([
  'port',
  'trace',
  'bridgeClosed',
  'postExitProbe',
  'phase',
]);

/**
 * Normalize a filesystem path for origin comparison.
 * Converts backslashes to forward slashes and strips a trailing slash.
 * Lowercasing is opt-in via `{ caseInsensitive: true }` so the helper stays
 * platform-pure and unit-testable both ways (callers pass
 * `process.platform === 'win32'` when they want Windows semantics).
 *
 * @param {unknown} p
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {string}
 */
export function normalizePath(p, options = {}) {
  if (typeof p !== 'string' || p.length === 0) {
    return '';
  }
  let s = p.replace(/\\/g, '/');
  // Collapse repeated separators (except a leading // for UNC-style).
  s = s.replace(/([^:]\/)\/+/g, '$1');
  if (s.length > 1 && s.endsWith('/')) {
    s = s.replace(/\/+$/, '');
  }
  if (options.caseInsensitive === true) {
    s = s.toLowerCase();
  }
  return s;
}

/**
 * True when `child` is equal to `parent` or a strict descendant using a
 * trailing-separator guard (so `/tmp/ext` is not a parent of `/tmp/extra`).
 *
 * @param {string} child normalized
 * @param {string} parent normalized
 * @returns {boolean}
 */
function isEqualOrDescendant(child, parent) {
  if (!child || !parent) {
    return false;
  }
  if (child === parent) {
    return true;
  }
  return child.startsWith(`${parent}/`);
}

/**
 * True when `child` is a strict descendant of `parent` (not equal).
 *
 * @param {string} child normalized
 * @param {string} parent normalized
 * @returns {boolean}
 */
function isStrictDescendant(child, parent) {
  if (!child || !parent) {
    return false;
  }
  return child.startsWith(`${parent}/`);
}

/**
 * Classify where the loaded extension was resolved from.
 *
 * - `extensions-dir` only when extensionPath is a strict descendant of
 *   extensionsDir AND is NOT under repoRoot.
 * - `development-path` when extensionPath is equal to or under repoRoot.
 * - `unknown` for empty inputs or a path under neither.
 *
 * @param {{
 *   extensionPath?: unknown,
 *   extensionsDir?: unknown,
 *   repoRoot?: unknown,
 *   caseInsensitive?: boolean,
 * }} args
 * @returns {InstalledOrigin}
 */
export function classifyInstalledOrigin({
  extensionPath,
  extensionsDir,
  repoRoot,
  caseInsensitive = false,
} = {}) {
  const opts = { caseInsensitive: caseInsensitive === true };
  const ext = normalizePath(extensionPath, opts);
  const dir = normalizePath(extensionsDir, opts);
  const root = normalizePath(repoRoot, opts);

  if (!ext || !dir || !root) {
    return 'unknown';
  }

  // Development-path wins when the host resolved under the repository.
  if (isEqualOrDescendant(ext, root)) {
    return 'development-path';
  }

  if (isStrictDescendant(ext, dir) && !isEqualOrDescendant(ext, root)) {
    return 'extensions-dir';
  }

  return 'unknown';
}

/**
 * Collapse whitespace, strip path-like / secret-like fragments, then bound.
 *
 * @param {unknown} text
 * @param {number} [maxLen=300]
 * @returns {string}
 */
export function redactInstallDetail(text, maxLen = 300) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  const limit =
    typeof maxLen === 'number' && Number.isFinite(maxLen) && maxLen > 0
      ? Math.floor(maxLen)
      : 300;

  let s = text.replace(/\s+/g, ' ').trim();

  // file:// URLs first (may embed drive or POSIX paths).
  s = s.replace(/file:\/\/\S*/gi, '[redacted]');
  // Windows drive-letter paths (backslash or forward slash).
  s = s.replace(/[A-Za-z]:(?:\\+|\/)[^\s]*/g, '[redacted]');
  // UNC paths.
  s = s.replace(/\\\\[^\s]+/g, '[redacted]');
  // Common absolute POSIX prefixes that leak machine layout.
  s = s.replace(/(?:\/home|\/Users|\/tmp)\/[^\s]*/g, '[redacted]');
  // Secret-like tokens.
  s = s.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
  s = s.replace(/\bBearer\s+\S+/gi, '[redacted]');

  if (s.length > limit) {
    s = s.slice(0, limit);
  }
  return s;
}

/**
 * Fail-closed parse of the install host-smoke JSON.
 * bridgeClosure is accepted only with exactly the S04 key set.
 *
 * @param {unknown} raw
 * @returns {{
 *   ok: boolean,
 *   activation: 'ok' | 'failed',
 *   installedOrigin: InstalledOrigin,
 *   bridge: { port: number, status: 'ok' | 'stopping' | 'unavailable' } | null,
 *   bridgeClosure: {
 *     port: number,
 *     trace: 'present' | 'missing',
 *     bridgeClosed: boolean,
 *     postExitProbe: 'refused' | 'still-serving' | 'unknown',
 *     phase: string,
 *   } | null,
 *   phase: InstallGatePhase,
 *   extensionPath?: string,
 * }}
 */
export function parseInstallHostResult(raw) {
  /** @type {const} */
  const failClosed = {
    ok: false,
    activation: /** @type {const} */ ('failed'),
    installedOrigin: /** @type {const} */ ('unknown'),
    bridge: null,
    bridgeClosure: null,
    phase: /** @type {const} */ ('activation-failed'),
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...failClosed };
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (Object.keys(obj).length === 0) {
    return { ...failClosed };
  }

  /** @type {'ok' | 'failed'} */
  const activation = obj.activation === 'ok' ? 'ok' : 'failed';

  /** @type {{ port: number, status: 'ok' | 'stopping' | 'unavailable' } | null} */
  let bridge = null;
  if (obj.bridge && typeof obj.bridge === 'object' && !Array.isArray(obj.bridge)) {
    const b = /** @type {Record<string, unknown>} */ (obj.bridge);
    const port = typeof b.port === 'number' && Number.isFinite(b.port) ? b.port : 0;
    /** @type {'ok' | 'stopping' | 'unavailable'} */
    let status = 'unavailable';
    if (b.status === 'ok' || b.status === 'stopping' || b.status === 'unavailable') {
      status = b.status;
    } else if (port > 0) {
      status = 'ok';
    }
    bridge = { port, status };
  }

  /** @type {typeof failClosed.bridgeClosure} */
  let bridgeClosure = null;
  if (
    obj.bridgeClosure &&
    typeof obj.bridgeClosure === 'object' &&
    !Array.isArray(obj.bridgeClosure)
  ) {
    const c = /** @type {Record<string, unknown>} */ (obj.bridgeClosure);
    const keys = Object.keys(c).sort();
    const expected = [...BRIDGE_CLOSURE_KEYS].sort();
    const exactKeys =
      keys.length === expected.length && keys.every((k, i) => k === expected[i]);

    if (exactKeys) {
      const cPort = typeof c.port === 'number' && Number.isFinite(c.port) ? c.port : NaN;
      const cTrace = c.trace === 'present' || c.trace === 'missing' ? c.trace : null;
      const cClosed = typeof c.bridgeClosed === 'boolean' ? c.bridgeClosed : null;
      const cProbe =
        c.postExitProbe === 'refused' ||
        c.postExitProbe === 'still-serving' ||
        c.postExitProbe === 'unknown'
          ? c.postExitProbe
          : null;
      const cPhase = typeof c.phase === 'string' && c.phase.length > 0 ? c.phase : null;

      if (
        Number.isFinite(cPort) &&
        cTrace !== null &&
        cClosed !== null &&
        cProbe !== null &&
        cPhase !== null
      ) {
        bridgeClosure = {
          port: cPort,
          trace: cTrace,
          bridgeClosed: cClosed,
          postExitProbe: cProbe,
          phase: cPhase,
        };
      }
    }
  }

  const extensionPath =
    typeof obj.extensionPath === 'string' && obj.extensionPath.length > 0
      ? obj.extensionPath
      : undefined;

  const bridgeListening = bridge !== null && bridge.status === 'ok' && bridge.port > 0;
  const bridgeClosureOk =
    bridgeClosure !== null &&
    bridgeClosure.phase === 'ok' &&
    bridgeClosure.trace === 'present' &&
    bridgeClosure.bridgeClosed === true &&
    bridgeClosure.postExitProbe === 'refused' &&
    bridgeClosure.port > 0;

  /** @type {InstallGatePhase} */
  let phase = 'activation-failed';
  if (activation !== 'ok') {
    phase = 'activation-failed';
  } else if (!bridgeListening) {
    phase = 'bridge-unreachable';
  } else if (!bridgeClosureOk) {
    phase = 'closure-failed';
  } else {
    phase = 'ok';
  }

  const ok = activation === 'ok' && bridgeListening && bridgeClosureOk && phase === 'ok';

  return {
    ok,
    activation,
    installedOrigin: 'unknown',
    bridge,
    bridgeClosure,
    phase,
    ...(extensionPath !== undefined ? { extensionPath } : {}),
  };
}

/**
 * Build the closed install-gate evidence object field by field.
 * `ok` is derived — never trusted from the caller — and is true only when
 * installExitCode===0, installedOrigin==='extensions-dir', activation==='ok',
 * bridge.status==='ok' with port>0, bridgeClosure.phase==='ok', and phase==='ok'.
 *
 * @param {{
 *   installExitCode?: unknown,
 *   installDetail?: unknown,
 *   installedOrigin?: unknown,
 *   activation?: unknown,
 *   bridge?: unknown,
 *   bridgeClosure?: unknown,
 *   vscodeVersion?: unknown,
 *   platform?: unknown,
 *   phase?: unknown,
 *   generatedAt?: unknown,
 *   durationMs?: unknown,
 * }} args
 */
export function buildInstallGateEvidence(args = {}) {
  const installExitCode =
    typeof args.installExitCode === 'number' && Number.isFinite(args.installExitCode)
      ? args.installExitCode
      : -1;

  /** @type {InstalledOrigin} */
  let installedOrigin = 'unknown';
  if (
    args.installedOrigin === 'extensions-dir' ||
    args.installedOrigin === 'development-path' ||
    args.installedOrigin === 'unknown'
  ) {
    installedOrigin = args.installedOrigin;
  }

  /** @type {'ok' | 'failed'} */
  const activation = args.activation === 'ok' ? 'ok' : 'failed';

  /** @type {{ port: number, status: 'ok' | 'stopping' | 'unavailable' } | null} */
  let bridge = null;
  if (args.bridge && typeof args.bridge === 'object' && !Array.isArray(args.bridge)) {
    const b = /** @type {Record<string, unknown>} */ (args.bridge);
    const port = typeof b.port === 'number' && Number.isFinite(b.port) ? b.port : 0;
    /** @type {'ok' | 'stopping' | 'unavailable'} */
    let status = 'unavailable';
    if (b.status === 'ok' || b.status === 'stopping' || b.status === 'unavailable') {
      status = b.status;
    }
    bridge = { port, status };
  }

  /** @type {{
   *   port: number,
   *   trace: 'present' | 'missing',
   *   bridgeClosed: boolean,
   *   postExitProbe: 'refused' | 'still-serving' | 'unknown',
   *   phase: string,
   * } | null} */
  let bridgeClosure = null;
  if (
    args.bridgeClosure &&
    typeof args.bridgeClosure === 'object' &&
    !Array.isArray(args.bridgeClosure)
  ) {
    const c = /** @type {Record<string, unknown>} */ (args.bridgeClosure);
    const keys = Object.keys(c).sort();
    const expected = [...BRIDGE_CLOSURE_KEYS].sort();
    const exactKeys =
      keys.length === expected.length && keys.every((k, i) => k === expected[i]);
    if (exactKeys) {
      const cPort = typeof c.port === 'number' && Number.isFinite(c.port) ? c.port : 0;
      const cTrace = c.trace === 'present' || c.trace === 'missing' ? c.trace : 'missing';
      const cClosed = c.bridgeClosed === true;
      const cProbe =
        c.postExitProbe === 'refused' ||
        c.postExitProbe === 'still-serving' ||
        c.postExitProbe === 'unknown'
          ? c.postExitProbe
          : 'unknown';
      const cPhase =
        c.phase === 'ok' ||
        c.phase === 'deactivate-failed' ||
        c.phase === 'trace-missing' ||
        c.phase === 'not-closed' ||
        c.phase === 'still-serving' ||
        c.phase === 'probe-unknown'
          ? c.phase
          : 'trace-missing';
      bridgeClosure = {
        port: cPort,
        trace: cTrace,
        bridgeClosed: cClosed,
        postExitProbe: cProbe,
        phase: cPhase,
      };
    }
  }

  /** @type {InstallGatePhase} */
  let phase = 'activation-failed';
  if (
    args.phase === 'ok' ||
    args.phase === 'package-failed' ||
    args.phase === 'install-rejected' ||
    args.phase === 'host-launch-failed' ||
    args.phase === 'activation-failed' ||
    args.phase === 'bridge-unreachable' ||
    args.phase === 'closure-failed' ||
    args.phase === 'origin-not-installed'
  ) {
    phase = args.phase;
  }

  const vscodeVersion =
    typeof args.vscodeVersion === 'string' ? args.vscodeVersion : 'unknown';
  const platform = typeof args.platform === 'string' ? args.platform : 'unknown';
  const generatedAt =
    typeof args.generatedAt === 'string' && args.generatedAt.length > 0
      ? args.generatedAt
      : new Date(0).toISOString();
  const durationMs =
    typeof args.durationMs === 'number' && Number.isFinite(args.durationMs)
      ? Math.max(0, Math.floor(args.durationMs))
      : 0;

  const installStderrExcerpt = redactInstallDetail(args.installDetail);

  const bridgeOk = bridge !== null && bridge.status === 'ok' && bridge.port > 0;
  // phase === 'ok' alone is not proof: a caller can hand us a self-inconsistent
  // closure such as { bridgeClosed: false, postExitProbe: 'still-serving',
  // phase: 'ok' }. Recompute from the observed fields so contradictory input
  // fails closed instead of minting evidence.ok === true.
  const bridgeClosureOk =
    bridgeClosure !== null &&
    bridgeClosure.phase === 'ok' &&
    bridgeClosure.trace === 'present' &&
    bridgeClosure.bridgeClosed === true &&
    bridgeClosure.postExitProbe === 'refused' &&
    bridgeClosure.port > 0;

  const ok =
    installExitCode === 0 &&
    installedOrigin === 'extensions-dir' &&
    activation === 'ok' &&
    bridgeOk &&
    bridgeClosureOk &&
    phase === 'ok';

  return {
    kind: 'm022-s05-install-gate',
    schemaVersion: 1,
    ok,
    installExitCode,
    installStderrExcerpt,
    installedOrigin,
    activation,
    bridge,
    bridgeClosure,
    vscodeVersion,
    platform,
    phase,
    generatedAt,
    durationMs,
  };
}
