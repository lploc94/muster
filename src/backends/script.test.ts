import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedEvent, RunOptions, VerifiedScriptPackageSnapshot } from '../types';
import { ScriptBackend } from './script';

const dirs: string[] = [];
const pythonExecutable = ['python', 'python3'].find((candidate) =>
  spawnSync(candidate, ['--version'], { shell: false, windowsHide: true }).status === 0);

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muster-script-backend-'));
  dirs.push(dir);
  return dir;
}

function options(cwd: string, file: string, over: Partial<RunOptions> = {}): RunOptions {
  return {
    input: { kind: 'script', interpreter: 'node', file, args: [], stdin: '' },
    cwd,
    localExecution: {
      authorize: () => true,
      timeoutMs: 5_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 4 * 1024,
    },
    ...over,
  };
}

async function collect(runOptions: RunOptions): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of new ScriptBackend().run(runOptions)) events.push(event);
  return events;
}

function snapshotPackage(root: string, files: readonly string[]): VerifiedScriptPackageSnapshot {
  const snapshotRoot = workspace();
  for (const file of files) {
    const target = join(snapshotRoot, ...file.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(join(root, ...file.split('/'))));
  }
  return {
    scriptRoot: snapshotRoot,
    dispose: async () => rmSync(snapshotRoot, { recursive: true, force: true }),
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('ScriptBackend', () => {
  it('runs a real JS file with exact stdout, separate stderr, stdin, and literal argv', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'run.js'), [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(input + '|' + process.argv[2]);",
      "  process.stderr.write('diagnostic-only');",
      "  process.exitCode = 7;",
      "});",
    ].join('\n'));
    const runOptions = options(cwd, 'run.js');
    runOptions.input = {
      kind: 'script', interpreter: 'node', file: 'run.js', args: ['a;$(literal)'], stdin: '{"value":1}',
    };
    const events = await collect(runOptions);
    expect(events).toEqual([
      { type: 'processCompleted', stdout: '{"value":1}|a;$(literal)', stderr: 'diagnostic-only', exitCode: 7 },
      { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: 7 } },
    ]);
  });

  it('treats empty stdout as a successful process result', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'empty.js'), "process.stderr.write('note')");
    expect(await collect(options(cwd, 'empty.js'))).toEqual([
      { type: 'processCompleted', stdout: '', stderr: 'note', exitCode: 0 },
      { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: 0 } },
    ]);
  });

  it('runs TypeScript from an explicit package root while keeping process cwd separate', async () => {
    const cwd = workspace();
    const packageRoot = join(cwd, 'global-package');
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
    const source = 'const value: string = "package"; process.stdout.write(value + "|" + process.cwd());';
    const script = join(packageRoot, 'scripts', 'run.ts');
    writeFileSync(script, source);
    writeFileSync(join(cwd, 'scripts-shadow.ts'), 'process.stdout.write("workspace-shadow");');
    const runOptions = options(cwd, 'scripts/run.ts', {
      localExecution: {
        ...options(cwd, 'scripts/run.ts').localExecution!,
        scriptRoot: packageRoot,
        expectedScriptSha256: createHash('sha256').update(source).digest('hex'),
      },
    });
    await expect(collect(runOptions)).resolves.toEqual([
      {
        type: 'processCompleted',
        stdout: `package|${realpathSync(cwd)}`,
        stderr: '',
        exitCode: 0,
      },
      { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: 0 } },
    ]);

    writeFileSync(script, 'const value: string = "changed"; process.stdout.write(value);');
    await expect(collect(runOptions)).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        meta: { code: 'script_integrity_mismatch' },
      }),
    ]);
  });

  it('fails closed when the predefined package changes at the dispatch boundary', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'package.js'), 'process.stdout.write("must-not-run");');
    const runOptions = options(cwd, 'package.js', {
      localExecution: {
        ...options(cwd, 'package.js').localExecution!,
        verifyPackageIntegrity: async () => {
          throw new Error('predefined workflow package changed after definition');
        },
      },
    });
    await expect(collect(runOptions)).resolves.toEqual([
      {
        type: 'error',
        message: 'predefined workflow package changed after definition',
        meta: { code: 'package_integrity_mismatch' },
      },
    ]);
  });

  it('executes only the immutable verified package snapshot and removes it after termination', async () => {
    const cwd = workspace();
    const packageRoot = join(cwd, 'mutable-package');
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
    const scriptSource = [
      "const helper = require('./helper.cjs');",
      "process.stdout.write(helper + '|' + process.cwd());",
    ].join('\n');
    writeFileSync(join(packageRoot, 'scripts', 'run.cjs'), scriptSource);
    writeFileSync(join(packageRoot, 'scripts', 'helper.cjs'), "module.exports = 'verified';");
    let snapshotRoot: string | undefined;
    const runOptions = options(cwd, 'scripts/run.cjs', {
      localExecution: {
        ...options(cwd, 'scripts/run.cjs').localExecution!,
        scriptRoot: packageRoot,
        expectedScriptSha256: createHash('sha256').update(scriptSource).digest('hex'),
        verifyPackageIntegrity: async () => {
          const snapshot = snapshotPackage(packageRoot, ['scripts/run.cjs', 'scripts/helper.cjs']);
          snapshotRoot = snapshot.scriptRoot;
          writeFileSync(join(packageRoot, 'scripts', 'run.cjs'), 'process.stdout.write("swapped-script")');
          writeFileSync(join(packageRoot, 'scripts', 'helper.cjs'), "module.exports = 'swapped-helper';");
          return snapshot;
        },
      },
    });

    await expect(collect(runOptions)).resolves.toEqual([
      {
        type: 'processCompleted',
        stdout: `verified|${realpathSync(cwd)}`,
        stderr: '',
        exitCode: 0,
      },
      { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: 0 } },
    ]);
    expect(snapshotRoot).toBeDefined();
    expect(existsSync(snapshotRoot!)).toBe(false);
  });

  it('rechecks authorization and cancellation after asynchronous package verification', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'late.js'), 'process.stdout.write("must-not-run");');
    let authorized = true;
    const runOptions = options(cwd, 'late.js', {
      signal: (() => {
        const controller = new AbortController();
        return controller.signal;
      })(),
      localExecution: {
        ...options(cwd, 'late.js').localExecution!,
        authorize: () => authorized,
        verifyPackageIntegrity: async () => {
          const snapshot = snapshotPackage(cwd, ['late.js']);
          authorized = false;
          await Promise.resolve();
          return snapshot;
        },
      },
    });
    await expect(collect(runOptions)).resolves.toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'host_run_denied' } }),
    ]);

    const controller = new AbortController();
    const cancelled = options(cwd, 'late.js', {
      signal: controller.signal,
      localExecution: {
        ...options(cwd, 'late.js').localExecution!,
        verifyPackageIntegrity: async () => {
          const snapshot = snapshotPackage(cwd, ['late.js']);
          controller.abort();
          await Promise.resolve();
          return snapshot;
        },
      },
    });
    await expect(collect(cancelled)).resolves.toEqual([
      expect.objectContaining({ type: 'error', isCancellation: true }),
    ]);
  });

  it.skipIf(pythonExecutable === undefined)('runs a real Python file through the same typed contract', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'run.py'), [
      'import sys',
      'data = sys.stdin.read()',
      'sys.stdout.write(data + "|py")',
      'sys.stderr.write("python diagnostic")',
    ].join('\n'));
    const runOptions = options(cwd, 'run.py');
    runOptions.input = {
      kind: 'script', interpreter: pythonExecutable!, file: 'run.py', args: [], stdin: 'input',
    };
    expect(await collect(runOptions)).toEqual([
      { type: 'processCompleted', stdout: 'input|py', stderr: 'python diagnostic', exitCode: 0 },
      { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: 0 } },
    ]);
  });

  it('fails closed for disabled host run and workspace escapes', async () => {
    const cwd = workspace();
    let marked = false;
    const denied = options(cwd, 'missing.js', {
      localExecution: { authorize: () => false, timeoutMs: 100, maxStdoutBytes: 100 },
      onBeforePrompt: () => { marked = true; },
    });
    expect(await collect(denied)).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'host_run_denied' } }),
    ]);
    expect(marked).toBe(false);

    const escaped = options(cwd, '../outside.js');
    expect(await collect(escaped)).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'invalid_script_path' } }),
    ]);
  });

  it.skipIf(process.platform === 'win32')('rejects intermediate symlinks in the script path', async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    writeFileSync(join(cwd, 'scripts', 'run.js'), 'process.stdout.write("must-not-run")');
    symlinkSync(join(cwd, 'scripts'), join(cwd, 'alias'), 'dir');

    expect(await collect(options(cwd, 'alias/run.js'))).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'invalid_script_path' } }),
    ]);
  });

  it('kills stdout that exceeds the artifact bound', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'large.js'), "process.stdout.write('x'.repeat(4096))");
    const runOptions = options(cwd, 'large.js');
    runOptions.localExecution!.maxStdoutBytes = 32;
    expect(await collect(runOptions)).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'stdout_limit' } }),
    ]);
  });

  it('times out and cancels long-running processes without a terminal result', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'hang.js'), 'setInterval(() => {}, 1_000)');

    const timed = options(cwd, 'hang.js');
    timed.localExecution!.timeoutMs = 100;
    expect(await collect(timed)).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'script_timeout' } }),
    ]);

    const controller = new AbortController();
    const cancelled = options(cwd, 'hang.js', { signal: controller.signal });
    const cancelTimer = setTimeout(() => controller.abort(), 100);
    try {
      expect(await collect(cancelled)).toEqual([
        expect.objectContaining({
          type: 'error',
          isCancellation: true,
          message: 'script execution cancelled',
        }),
      ]);
    } finally {
      clearTimeout(cancelTimer);
    }
  });

  it('rechecks live authorization after the durable boundary and never spawns if revoked', async () => {
    const cwd = workspace();
    const marker = join(cwd, 'spawned.txt');
    writeFileSync(join(cwd, 'marker.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`);
    let authorized = true;
    const runOptions = options(cwd, 'marker.js', {
      onBeforePrompt: () => { authorized = false; },
    });
    runOptions.localExecution!.authorize = () => authorized;

    expect(await collect(runOptions)).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'host_run_denied' } }),
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it('does not inherit arbitrary host secrets and retains only the configured stderr tail', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'environment.js'), [
      "process.stdout.write(process.env.MUSTER_QA_SECRET || 'filtered');",
      "process.stderr.write('0123456789');",
    ].join('\n'));
    const previous = process.env.MUSTER_QA_SECRET;
    process.env.MUSTER_QA_SECRET = 'must-not-cross-process-boundary';
    const runOptions = options(cwd, 'environment.js');
    runOptions.localExecution!.maxStderrBytes = 4;
    try {
      expect(await collect(runOptions)).toEqual([
        { type: 'processCompleted', stdout: 'filtered', stderr: '6789', exitCode: 0 },
        { type: 'turnCompleted', meta: { executorKind: 'script', exitCode: 0 } },
      ]);
    } finally {
      if (previous === undefined) delete process.env.MUSTER_QA_SECRET;
      else process.env.MUSTER_QA_SECRET = previous;
    }
  });

  it('rejects agent input, denied interpreters, and interpreter-extension mismatches', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'wrong.py'), 'print("wrong")');
    expect(await collect({
      ...options(cwd, 'wrong.py'),
      input: { kind: 'agent', prompt: 'not a script' },
    })).toEqual([
      expect.objectContaining({ type: 'error', message: 'script backend received an agent run input' }),
    ]);
    expect(await collect({
      ...options(cwd, 'wrong.py'),
      input: { kind: 'script', interpreter: 'bash', file: 'wrong.py', args: [] },
    })).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'interpreter_denied' } }),
    ]);
    expect(await collect(options(cwd, 'wrong.py'))).toEqual([
      expect.objectContaining({ type: 'error', meta: { code: 'invalid_script_path' } }),
    ]);
  });
});
