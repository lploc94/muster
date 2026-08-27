import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedEvent, RunOptions } from '../types';
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
