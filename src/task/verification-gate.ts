/**
 * Host-run verification gate (verify-gate-loop Phase C). Runs a verify task's
 * declared commands ON THE HOST and produces a source-bound `TaskVerdict`
 * (`source:'host'`) that OVERRIDES the worker's self-report at settle time.
 *
 * SECURITY — task-supplied commands are UNTRUSTED-INPUT:
 * - Every command is spawned with `shell:false` and an explicit argv array; a
 *   command containing shell metacharacters/operators is REJECTED (never run) and
 *   recorded as fail evidence.
 * - Each command has a wall-clock timeout; captured output is clamped to a tail.
 * - An empty / all-rejected command set yields `status:'fail'` — NEVER a vacuous
 *   pass. This is the fail-closed contract the dependency gate relies on.
 */

import { spawnSync } from 'child_process';
import { basename } from 'path';
import type { TaskVerdict, VerdictEvidence, VerdictStatus } from './types';
import {
  computeSourceRevision,
  NO_GIT_REVISION,
  SOURCE_REVISION_UNAVAILABLE,
} from './source-revision';

/** Per-command wall-clock budget. An untrusted command must never hang the settle. */
export const VERIFICATION_COMMAND_TIMEOUT_MS = 120_000;
/** Max chars of stdout/stderr tail retained as evidence `observation`. */
export const VERIFICATION_OBSERVATION_MAX = 2_000;
/** Cap on a single command's captured stdout+stderr (defense against runaway output). */
const COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Shell metacharacters / operators that disqualify a task-supplied command.
 * Rejects: `;` `|` `&` `$` backtick `<` `>` `(` `)` `{` `}` and any newline/CR.
 * A command containing any of these could compose or redirect subprocesses and is
 * never executed — treated exactly like Muster's untrusted-input dataflow model.
 */
const SHELL_METACHARACTERS = /[;|&$`<>(){}\n\r]/;

/**
 * ALL control characters + NUL + DEL (0x00–0x1f, 0x7f). A command carrying any of
 * these could smuggle argument injection / terminal escapes past the metachar filter
 * (this superset also covers `\n`/`\r`). Rejected without execution — fail-closed.
 */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/**
 * Allowlist of known verification runners, matched against `basename(argv[0])`.
 * A command whose executable is NOT one of these is NEVER executed (recorded as fail
 * evidence). This is the second layer of defense on top of the host-authorization
 * flag: even a workspace-trusted, host-authorized run may only invoke vetted runners.
 * Deliberately EXCLUDES general shells / interpreters that can execute arbitrary code
 * from a string (`sh`, `bash`, `zsh`, `env`, `eval`, ...).
 */
export const VERIFICATION_EXECUTABLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'node',
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'eslint',
  'prettier',
  'biome',
  'make',
  'cargo',
  'go',
  'python',
  'python3',
  'pytest',
  'ruff',
  'deno',
  'bun',
]);

/** Normalize argv[0] to a bare, lowercased executable name for allowlist matching. */
function executableName(arg0: string): string {
  return basename(arg0).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * Shape of an acceptable BARE executable name (argv[0]). A POSITIVE allowlist-shape
 * check: argv[0] must be exactly one bare token — a leading alphanumeric followed by
 * alphanumerics, `.`, `_`, or `-`. This inherently REJECTS any path separator (`/` or
 * `\`), a leading `.` (`./npm`, `.hidden`), whitespace, AND a drive/colon token such as
 * `C:npm` — a Windows drive-relative form that has no separator, does not start with
 * `.`, and is NOT `path.isAbsolute()`, so it slipped past the old separator blocklist and
 * would resolve to an attacker-planted binary on drive C:. Only a bare name is ever
 * matched against the allowlist and spawned (spawnSync resolves it via PATH); anything
 * that fails this shape is recorded as fail evidence and never executed.
 */
const BARE_EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SanitizedCommand {
  ok: boolean;
  /** Parsed argv (argv[0] is the executable). Empty when rejected. */
  argv: string[];
  /** Reason the command was rejected (present only when `ok` is false). */
  reason?: string;
}

/**
 * Split a command string into an argv array, REJECTING it if empty or if it
 * contains any shell metacharacter/operator. Never throws.
 */
export function sanitizeVerificationCommand(cmd: string): SanitizedCommand {
  if (typeof cmd !== 'string') {
    return { ok: false, argv: [], reason: 'command is not a string' };
  }
  const trimmed = cmd.trim();
  if (trimmed.length === 0) {
    return { ok: false, argv: [], reason: 'empty command' };
  }
  if (CONTROL_CHARACTERS.test(cmd)) {
    return { ok: false, argv: [], reason: 'command contains control characters' };
  }
  if (SHELL_METACHARACTERS.test(cmd)) {
    return { ok: false, argv: [], reason: 'command contains shell metacharacters' };
  }
  const argv = trimmed.split(/\s+/).filter((token) => token.length > 0);
  if (argv.length === 0) {
    return { ok: false, argv: [], reason: 'empty command' };
  }
  // POSITIVE allowlist-shape check: argv[0] must be a single bare executable name.
  // This rejects (without execution) any path separator, a leading `.`, whitespace, AND
  // a Windows drive-relative token like `C:npm` (no separator, not path.isAbsolute())
  // that the old blocklist let through. Only a bare name reaches the allowlist below,
  // closing the basename-spoof hole (`./npm` / `/tmp/npm` / `C:npm`).
  if (!BARE_EXECUTABLE_NAME.test(argv[0])) {
    return {
      ok: false,
      argv: [],
      reason: `executable must be a bare name (no path component): ${argv[0]}`,
    };
  }
  if (!VERIFICATION_EXECUTABLE_ALLOWLIST.has(executableName(argv[0]))) {
    return {
      ok: false,
      argv: [],
      reason: `executable not allowlisted: ${executableName(argv[0])}`,
    };
  }
  return { ok: true, argv };
}

/** Outcome of running one sanitized argv. Injected in tests. */
export interface CommandOutcome {
  /** Process exit code, or `null` when killed (timeout/signal) or failed to spawn. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => CommandOutcome;

const defaultCommandRunner: CommandRunner = (argv, cwd, timeoutMs) => {
  const [file, ...args] = argv;
  const res = spawnSync(file, args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    // CRITICAL: never a shell string. Explicit argv only.
    shell: false,
    windowsHide: true,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  return {
    status: typeof res.status === 'number' ? res.status : null,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
};

/** Keep the LAST `max` chars (the tail is where failures usually surface). */
function clampTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function buildRationale(evidence: readonly VerdictEvidence[], runnable: boolean): string {
  if (!runnable) return 'no runnable verification command discovered';
  const failed = evidence.filter((e) => e.status !== 'pass');
  return failed.length === 0
    ? `all ${evidence.length} verification command(s) passed`
    : `${failed.length}/${evidence.length} verification command(s) failed`;
}

export interface RunVerificationGateOptions {
  /** Injectable command runner (default: `spawnSync` with `shell:false`). */
  runCommand?: CommandRunner;
  /** Injectable source-revision computation (default: real git probe). */
  computeRevision?: (cwd: string) => string;
  /** ISO stamp for the verdict (default: `new Date().toISOString()`). */
  now?: string;
  /** Per-command timeout override. */
  timeoutMs?: number;
  /** Observation tail cap override. */
  observationMax?: number;
}

/**
 * Run the declared verification commands on the host and return a source-bound
 * host verdict. Overall `status` is `pass` iff at least one command ran and every
 * command exited 0; otherwise `fail` (fail-closed). Never throws.
 */
export function runVerificationGate(
  commands: readonly string[],
  cwd: string,
  options: RunVerificationGateOptions = {},
): { verdict: TaskVerdict } {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const computeRevision = options.computeRevision ?? computeSourceRevision;
  const timeoutMs = options.timeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS;
  const observationMax = options.observationMax ?? VERIFICATION_OBSERVATION_MAX;
  const at = options.now ?? new Date().toISOString();

  // Revision probes are wrapped: even an injected/real probe that throws must never
  // escape the gate (fail-closed, not fail-open).
  const safeRevision = (): string => {
    try {
      return computeRevision(cwd);
    } catch {
      return NO_GIT_REVISION;
    }
  };

  // Capture the source revision BEFORE running commands so the verdict can be bound to
  // the exact tree the checks observed (and drift during the run can be detected).
  const revisionBefore = safeRevision();

  const evidence: VerdictEvidence[] = [];
  for (const raw of commands ?? []) {
    const command = typeof raw === 'string' ? raw : String(raw);
    const sanitized = sanitizeVerificationCommand(command);
    if (!sanitized.ok) {
      // Rejected WITHOUT execution — fail-closed evidence.
      evidence.push({
        command,
        exitCode: null,
        status: 'fail',
        observation: clampTail(`rejected: ${sanitized.reason}`, observationMax),
      });
      continue;
    }
    const startedAt = Date.now();
    let outcome: CommandOutcome;
    try {
      outcome = runCommand(sanitized.argv, cwd, timeoutMs);
    } catch (err) {
      // A runner that throws (spawn failure, injected fault) becomes fail evidence —
      // the gate itself never throws.
      const message = err instanceof Error ? err.message : String(err);
      evidence.push({
        command,
        exitCode: null,
        status: 'fail',
        durationMs: Date.now() - startedAt,
        observation: clampTail(`command threw: ${message}`, observationMax),
      });
      continue;
    }
    const durationMs = Date.now() - startedAt;
    const exitCode = typeof outcome.status === 'number' ? outcome.status : null;
    const status: VerdictStatus = exitCode === 0 ? 'pass' : 'fail';
    const combined = `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`;
    const observation = combined.length > 0 ? clampTail(combined, observationMax) : undefined;
    const item: VerdictEvidence = { command, exitCode, status, durationMs };
    if (observation !== undefined) item.observation = observation;
    evidence.push(item);
  }

  // No runnable command discovered → fail (never a vacuous pass).
  const runnable = evidence.length > 0;
  let status: VerdictStatus =
    runnable && evidence.every((e) => e.status === 'pass') ? 'pass' : 'fail';
  let rationale = buildRationale(evidence, runnable);

  // Re-capture AFTER the run. A `pass` is only honored when the source could be bound
  // and did not move during verification. An `unavailable` revision on EITHER side means
  // the tree could not be fingerprinted, so the evidence cannot be bound to a source →
  // downgrade to `inconclusive` (never a content-unbound pass). Otherwise, any observable
  // drift downgrades too (the evidence is no longer bound to a stable tree). A `no-git`
  // sentinel cannot prove drift, so it never triggers a false downgrade.
  const revisionAfter = safeRevision();
  if (status === 'pass') {
    const unbindable =
      revisionBefore === SOURCE_REVISION_UNAVAILABLE ||
      revisionAfter === SOURCE_REVISION_UNAVAILABLE;
    const drifted =
      revisionBefore !== NO_GIT_REVISION &&
      revisionAfter !== NO_GIT_REVISION &&
      revisionBefore !== revisionAfter;
    if (unbindable) {
      status = 'inconclusive';
      rationale = 'verification source revision unavailable';
    } else if (drifted) {
      status = 'inconclusive';
      rationale = 'verification source changed during run';
    }
  }

  const verdict: TaskVerdict = {
    status,
    source: 'host',
    testedRevision: revisionBefore,
    evidence,
    rationale,
    at,
  };
  return { verdict };
}
