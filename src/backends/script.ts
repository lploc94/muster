import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Backend, NormalizedEvent, RunOptions } from '../types';
import {
  SCRIPT_EXECUTABLE_ALLOWLIST,
  normalizeExecutableName,
  validateAllowlistedExecutable,
} from '../shared/executable-policy';

const DEFAULT_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STDOUT_BYTES = 256 * 1024;
const DEFAULT_STDIN_BYTES = 1024 * 1024;
/** Grace between the polite tree signal and the forced one. */
const KILL_GRACE_MS = 2_000;
/** Hard ceiling on the whole termination sequence, so cancel can never hang. */
const TERMINATION_DEADLINE_MS = KILL_GRACE_MS * 2;

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  // Segment-aware: `..foo.js` is a legal contained name, only a real `..`
  // path segment escapes the root.
  return !rel.split(/[\\/]/).includes('..');
}

async function pathHasNoSymlinkComponents(root: string, candidate: string): Promise<boolean> {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return false;
  let current = root;
  for (const part of rel.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return false;
  }
  return true;
}

function expectedExtensions(interpreter: string): ReadonlySet<string> {
  return normalizeExecutableName(interpreter) === 'node'
    ? new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
    : new Set(['.py']);
}

const MAX_SCRIPT_FILE_BYTES = 8 * 1024 * 1024;

async function sha256File(file: string): Promise<string> {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SCRIPT_FILE_BYTES) {
      throw new Error('script file exceeds the executable size limit');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < info.size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - position),
        position,
      );
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    if (position !== info.size) throw new Error('script file changed while reading');
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const keep = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'LANG', 'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

/**
 * Resolve an allowlisted bare interpreter name to an absolute program path.
 *
 * `spawn` would otherwise re-resolve the bare name at launch time, so the binary that
 * actually runs is whatever `PATH` points at at that instant — not what the allowlist
 * check saw. Resolving here collapses that window and rejects `.cmd`/`.bat` shims, which
 * cannot execute without a shell.
 *
 * Note: `process.execPath` is deliberately not used for `node`. In the VS Code extension
 * host it is the Electron binary (`Code.exe`), which does not run a `.js` argument as a
 * script and hangs instead.
 */
async function resolveInterpreter(executable: string): Promise<string> {
  const searchPath = process.env.PATH ?? process.env.Path ?? '';
  // Real executable images only, in PATHEXT precedence order.
  const extensions = process.platform === 'win32' ? ['.EXE', '.COM', ''] : [''];
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${executable}${ext}`);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Keep scanning the remaining PATH entries.
      }
    }
  }
  throw new Error(`interpreter not found on PATH: ${executable}`);
}

/**
 * Terminate the interpreter *and* anything it spawned. `child.kill()` alone signals only
 * the direct child, so a script that ignores SIGTERM keeps running and its descendants
 * outlive it.
 */
function killProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Windows kill() has no group semantics; taskkill /T walks the tree.
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      });
      killer.unref();
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    return;
  }
  // Spawned detached, so the interpreter leads its own process group and the
  // negative pid reaches every descendant.
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
  }
}

async function resolveScriptPath(scriptRoot: string, file: string, interpreter: string): Promise<string> {
  if (!file || /[\x00-\x1f\x7f]/.test(file)) {
    throw new Error('script file must be a non-empty package-relative path');
  }
  const root = await realpath(scriptRoot);
  const normalized = file.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new Error('script file must be a non-empty package-relative path');
  }
  const unresolved = resolve(root, normalized);
  if (!isWithin(root, unresolved)) throw new Error('script file escapes the package root');
  if (!(await pathHasNoSymlinkComponents(root, unresolved))) {
    throw new Error('script path contains a symbolic link');
  }

  let script: string;
  try {
    script = await realpath(unresolved);
  } catch {
    throw new Error('script file does not exist');
  }
  if (!isWithin(root, script)) throw new Error('script file resolves outside the package root');
  const info = await stat(script);
  if (!info.isFile()) throw new Error('script path is not a regular file');
  if (!expectedExtensions(interpreter).has(extname(script).toLowerCase())) {
    throw new Error('script extension does not match the interpreter');
  }
  return script;
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

export class ScriptBackend implements Backend {
  readonly name = 'script';
  readonly capabilities = {
    supportsReasoning: false,
    supportsDetailedToolEvents: false,
    supportsMCP: false,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    if (options.input.kind !== 'script') {
      yield { type: 'error', message: 'script backend received an agent run input' };
      return;
    }
    const policy = options.localExecution;
    if (!policy?.authorize()) {
      yield { type: 'error', message: 'local script execution is not authorized', meta: { code: 'host_run_denied' } };
      return;
    }
    const executable = validateAllowlistedExecutable(
      options.input.interpreter,
      SCRIPT_EXECUTABLE_ALLOWLIST,
    );
    if (!executable.ok) {
      yield { type: 'error', message: executable.reason, meta: { code: 'interpreter_denied' } };
      return;
    }
    if (options.input.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      yield { type: 'error', message: 'script args contain an invalid value', meta: { code: 'invalid_args' } };
      return;
    }
    const cwd = options.cwd;
    if (!cwd) {
      yield { type: 'error', message: 'script execution requires a workspace cwd', meta: { code: 'invalid_cwd' } };
      return;
    }
    const scriptRoot = policy.scriptRoot ?? cwd;

    let script: string;
    try {
      script = await resolveScriptPath(scriptRoot, options.input.file, options.input.interpreter);
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'invalid script file',
        meta: { code: 'invalid_script_path' },
      };
      return;
    }
    if (options.signal?.aborted) {
      yield { type: 'error', message: 'script execution cancelled', isCancellation: true };
      return;
    }
    if (!policy.authorize()) {
      yield { type: 'error', message: 'local script execution is not authorized', meta: { code: 'host_run_denied' } };
      return;
    }

    try {
      await options.onBeforePrompt?.();
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'failed to persist script dispatch boundary',
        meta: { code: 'dispatch_boundary_failed' },
      };
      return;
    }
    // Re-read the live setting after the durable boundary and immediately before spawn.
    if (!policy.authorize()) {
      yield { type: 'error', message: 'local script execution is not authorized', meta: { code: 'host_run_denied' } };
      return;
    }
    // Abort can land while `onBeforePrompt` is awaited. Adding a listener to an
    // already-aborted signal never replays the event, so without this recheck a
    // cancelled run would still spawn and complete all of its side effects.
    if (options.signal?.aborted) {
      yield { type: 'error', message: 'script execution cancelled', isCancellation: true };
      return;
    }

    const stdin = options.input.stdin ?? '';
    const maxStdinBytes = Math.max(1, policy.maxStdinBytes ?? DEFAULT_STDIN_BYTES);
    if (Buffer.byteLength(stdin, 'utf8') > maxStdinBytes) {
      yield {
        type: 'error',
        message: 'script stdin exceeds the workflow input limit',
        meta: { code: 'stdin_limit' },
      };
      return;
    }

    let program: string;
    try {
      program = await resolveInterpreter(executable.executable);
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'interpreter not found',
        meta: { code: 'interpreter_denied' },
      };
      return;
    }

    if (!policy.authorize()) {
      yield { type: 'error', message: 'local script execution is not authorized', meta: { code: 'host_run_denied' } };
      return;
    }
    if (options.signal?.aborted) {
      yield { type: 'error', message: 'script execution cancelled', isCancellation: true };
      return;
    }

    try {
      // Re-resolve after interpreter setup so the final path check is adjacent to
      // the integrity checks and the side-effecting spawn.
      script = await resolveScriptPath(scriptRoot, options.input.file, options.input.interpreter);
      if (policy.expectedScriptSha256 !== undefined) {
        const actual = await sha256File(script);
        if (actual !== policy.expectedScriptSha256) {
          yield {
            type: 'error',
            message: 'predefined workflow script changed after definition',
            meta: { code: 'script_integrity_mismatch' },
          };
          return;
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'script integrity validation failed',
        meta: { code: 'invalid_script_path' },
      };
      return;
    }

    // This is the final asynchronous package/script verification before the
    // authorization and cancellation fences immediately preceding spawn.
    if (policy.verifyPackageIntegrity) {
      try {
        await policy.verifyPackageIntegrity();
      } catch (error) {
        yield {
          type: 'error',
          message: error instanceof Error ? error.message : 'script package integrity validation failed',
          meta: { code: 'package_integrity_mismatch' },
        };
        return;
      }
    }
    if (!policy.authorize()) {
      yield { type: 'error', message: 'local script execution is not authorized', meta: { code: 'host_run_denied' } };
      return;
    }
    if (options.signal?.aborted) {
      yield { type: 'error', message: 'script execution cancelled', isCancellation: true };
      return;
    }

    const maxStdoutBytes = Math.max(1, policy.maxStdoutBytes || DEFAULT_STDOUT_BYTES);
    const maxStderrBytes = Math.max(1, policy.maxStderrBytes ?? DEFAULT_STDERR_BYTES);
    const timeoutMs = Math.max(1, policy.timeoutMs || DEFAULT_TIMEOUT_MS);
    const isTypeScript = ['.ts', '.cts', '.mts'].includes(extname(script).toLowerCase());
    const child = spawn(program, [
      ...(isTypeScript ? ['--experimental-strip-types'] : []),
      script,
      ...options.input.args,
    ], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeChildEnvironment(),
      // Own process group on POSIX so termination reaches descendants too.
      detached: process.platform !== 'win32',
    });

    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let stderrTail: Buffer = Buffer.alloc(0);
    let outputExceeded = false;
    let timedOut = false;
    let cancelled = false;

    // Escalating, deadline-bounded termination. A script may trap SIGTERM and never
    // exit, so the forced signal follows a grace period and the awaited settle carries
    // its own ceiling: cancel, timeout and overflow can never hang on a stubborn child.
    let forceTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let armDeadline = (): void => undefined;
    const abandoned = new Promise<{ kind: 'abandoned' }>((done) => {
      armDeadline = () => {
        if (deadlineTimer !== undefined) return;
        deadlineTimer = setTimeout(() => done({ kind: 'abandoned' }), TERMINATION_DEADLINE_MS);
        deadlineTimer.unref?.();
      };
    });
    const terminate = () => {
      killProcessTree(child, false);
      if (forceTimer === undefined) {
        forceTimer = setTimeout(() => killProcessTree(child, true), KILL_GRACE_MS);
        forceTimer.unref?.();
      }
      armDeadline();
    };

    child.stdout.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrTail = appendTail(stderrTail, chunk, maxStderrBytes);
    });

    const abort = () => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const terminalPromise = new Promise<
      | { kind: 'close'; code: number | null }
      | { kind: 'error'; message: string }
    >((done) => {
      child.once('error', () => done({ kind: 'error', message: 'failed to spawn script interpreter' }));
      child.once('close', (code) => done({ kind: 'close', code }));
    });
    // A script may close stdin before consuming the bounded workflow payload.
    // Ignore that pipe error and let the process terminal event decide outcome.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');

    const terminal = await Promise.race([terminalPromise, abandoned]);
    clearTimeout(timer);
    clearTimeout(forceTimer);
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', abort);

    if (cancelled || options.signal?.aborted) {
      yield { type: 'error', message: 'script execution cancelled', isCancellation: true };
      return;
    }
    if (timedOut) {
      yield { type: 'error', message: 'script execution timed out', meta: { code: 'script_timeout' } };
      return;
    }
    if (outputExceeded) {
      yield { type: 'error', message: 'script stdout exceeds workflow artifact limit', meta: { code: 'stdout_limit' } };
      return;
    }
    if (terminal.kind === 'abandoned') {
      yield {
        type: 'error',
        message: 'script process did not exit after termination',
        meta: { code: 'termination_timeout' },
      };
      return;
    }
    if (terminal.kind === 'error' || terminal.code === null) {
      yield {
        type: 'error',
        message: terminal.kind === 'error' ? terminal.message : 'script process ended without an exit code',
        meta: { code: 'spawn_failed' },
      };
      return;
    }

    yield {
      type: 'processCompleted',
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: stderrTail.toString('utf8'),
      exitCode: terminal.code,
    };
    yield { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: terminal.code } };
  }
}
