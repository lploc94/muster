import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { Backend, NormalizedEvent, RunOptions } from '../types';
import {
  SCRIPT_EXECUTABLE_ALLOWLIST,
  normalizeExecutableName,
  validateAllowlistedExecutable,
} from '../shared/executable-policy';

const DEFAULT_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STDOUT_BYTES = 256 * 1024;

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function expectedExtensions(interpreter: string): ReadonlySet<string> {
  return normalizeExecutableName(interpreter) === 'node'
    ? new Set(['.js', '.cjs', '.mjs'])
    : new Set(['.py']);
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

async function resolveScriptPath(cwd: string, file: string, interpreter: string): Promise<string> {
  if (!file || isAbsolute(file) || file.includes('\0')) {
    throw new Error('script file must be a non-empty workspace-relative path');
  }
  const workspace = await realpath(cwd);
  const unresolved = resolve(workspace, file);
  if (!isWithin(workspace, unresolved)) throw new Error('script file escapes the workspace');

  let script: string;
  try {
    script = await realpath(unresolved);
  } catch {
    throw new Error('script file does not exist');
  }
  if (!isWithin(workspace, script)) throw new Error('script file resolves outside the workspace');
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

    let script: string;
    try {
      script = await resolveScriptPath(cwd, options.input.file, options.input.interpreter);
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

    const maxStdoutBytes = Math.max(1, policy.maxStdoutBytes || DEFAULT_STDOUT_BYTES);
    const maxStderrBytes = Math.max(1, policy.maxStderrBytes ?? DEFAULT_STDERR_BYTES);
    const timeoutMs = Math.max(1, policy.timeoutMs || DEFAULT_TIMEOUT_MS);
    const child = spawn(executable.executable, [script, ...options.input.args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeChildEnvironment(),
    });

    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let stderrTail: Buffer = Buffer.alloc(0);
    let outputExceeded = false;
    let timedOut = false;
    let cancelled = false;

    child.stdout.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        outputExceeded = true;
        child.kill();
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
      child.kill();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
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
    child.stdin.end(options.input.stdin ?? '', 'utf8');

    const terminal = await terminalPromise;
    clearTimeout(timer);
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
