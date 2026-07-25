import { execFile as nodeExecFile } from 'child_process';
import { promisify } from 'util';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_VERSION_EVIDENCE_MAX,
  type BackendCompatibilityStatus,
  type BackendReadinessCode,
  type BackendReadinessId,
} from '../shared/backend-readiness';

/** Per-command timeout for passive version collection (ms). */
export const VERSION_COMMAND_TIMEOUT_MS = 2500;

/** Hard cap on captured stdout/stderr for version commands. */
export const VERSION_COMMAND_MAX_BUFFER = 16 * 1024;

/** Semver-ish token used for bounded display evidence. */
const VERSION_TOKEN = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export interface BackendVersionSpec {
  backendId: BackendReadinessId;
  /** Fixed argv only — never shell-interpolated. */
  args: readonly string[];
  timeoutMs: number;
  maxBuffer: number;
  parse: (stdout: string) => string | null;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    shell: false;
    encoding: 'utf8';
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

export interface VersionCollectResult {
  versionEvidence: string | null;
  code: BackendReadinessCode;
}

export interface CompatibilityClassifier {
  classify(version: string | null): BackendCompatibilityStatus;
}

/** Optional host-owned compatibility policy keyed by backend. */
export type CompatibilityPolicy = Partial<
  Record<BackendReadinessId, CompatibilityClassifier>
>;

function boundVersionEvidence(token: string | null): string | null {
  if (!token) return null;
  if (token.length === 0 || token.length > BACKEND_READINESS_VERSION_EVIDENCE_MAX) {
    return null;
  }
  return token;
}

function extractVersionToken(stdout: string): string | null {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  const match = VERSION_TOKEN.exec(text);
  return boundVersionEvidence(match ? match[1] : null);
}

export function parseClaudeVersion(stdout: string): string | null {
  return extractVersionToken(stdout);
}

export function parseGrokVersion(stdout: string): string | null {
  return extractVersionToken(stdout);
}

export function parseKiroVersion(stdout: string): string | null {
  return extractVersionToken(stdout);
}

export function parseCodexVersion(stdout: string): string | null {
  return extractVersionToken(stdout);
}

export function parseOpenCodeVersion(stdout: string): string | null {
  return extractVersionToken(stdout);
}

const PARSER_BY_ID: Record<BackendReadinessId, (stdout: string) => string | null> = {
  claude: parseClaudeVersion,
  grok: parseGrokVersion,
  kiro: parseKiroVersion,
  codex: parseCodexVersion,
  opencode: parseOpenCodeVersion,
};

/**
 * Provider-specific fixed argv version specs. Order matches BACKEND_READINESS_IDS.
 * All providers currently use `--version`; parsers remain provider-named so
 * format drift can be handled without a shared fragile regex API surface.
 */
export const BACKEND_VERSION_SPECS: readonly BackendVersionSpec[] = BACKEND_READINESS_IDS.map(
  (backendId) => ({
    backendId,
    args: ['--version'] as const,
    timeoutMs: VERSION_COMMAND_TIMEOUT_MS,
    maxBuffer: VERSION_COMMAND_MAX_BUFFER,
    parse: PARSER_BY_ID[backendId],
  }),
);

const SPEC_BY_ID = new Map(BACKEND_VERSION_SPECS.map((s) => [s.backendId, s]));

/**
 * Host-owned compatibility classification.
 * Production default: unknown when no verified floor/range is configured.
 * Unit fixtures inject known-compatible / known-incompatible policies without
 * inventing production support claims.
 */
export function classifyCompatibility(
  backendId: BackendReadinessId,
  version: string | null,
  policy?: CompatibilityPolicy,
): BackendCompatibilityStatus {
  const classifier = policy?.[backendId];
  if (!classifier) return 'unknown';
  return classifier.classify(version);
}

const defaultExecFile: ExecFileLike = async (file, args, options) => {
  const run = promisify(nodeExecFile) as (
    file: string,
    args: readonly string[],
    options: {
      timeout: number;
      maxBuffer: number;
      shell: boolean;
      encoding: BufferEncoding;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
  const result = await run(file, args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    shell: false,
    encoding: 'utf8',
    env: options.env,
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { killed?: boolean; code?: string | number | null; signal?: string | null };
  if (e.killed === true) return true;
  if (e.code === 'ETIMEDOUT' || e.code === 'ABORT_ERR') return true;
  if (e.signal === 'SIGTERM' || e.signal === 'SIGKILL') return true;
  return false;
}

function isNonZeroExit(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string | number | null }).code;
  return typeof code === 'number' && code !== 0;
}

/**
 * Run a provider-specific version command via injected execFile-style I/O.
 * Shell is always disabled. Failures normalize to bounded codes — never throw.
 */
export async function collectBackendVersion(input: {
  backendId: BackendReadinessId;
  command: string;
  execFile?: ExecFileLike;
  env?: NodeJS.ProcessEnv;
}): Promise<VersionCollectResult> {
  const spec = SPEC_BY_ID.get(input.backendId);
  if (!spec) {
    return { versionEvidence: null, code: 'internal_error' };
  }

  const execFile = input.execFile ?? defaultExecFile;
  try {
    const { stdout } = await execFile(input.command, spec.args, {
      timeout: spec.timeoutMs,
      maxBuffer: spec.maxBuffer,
      shell: false,
      encoding: 'utf8',
      env: input.env,
    });
    const versionEvidence = spec.parse(String(stdout ?? ''));
    if (!versionEvidence) {
      return { versionEvidence: null, code: 'version_unknown' };
    }
    return { versionEvidence, code: 'none' };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { versionEvidence: null, code: 'timeout' };
    }
    if (isNonZeroExit(err)) {
      // Some CLIs write version to stdout even on non-zero exit; try parse first.
      const stdout = String((err as { stdout?: string }).stdout ?? '');
      const versionEvidence = spec.parse(stdout);
      if (versionEvidence) {
        return { versionEvidence, code: 'none' };
      }
      return { versionEvidence: null, code: 'process_exited' };
    }
    // Unexpected errors (ENOENT after detection, thrown mocks, etc.)
    return { versionEvidence: null, code: 'internal_error' };
  }
}
