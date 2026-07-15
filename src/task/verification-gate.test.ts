import { describe, expect, it, vi } from 'vitest';
import {
  runVerificationGate,
  sanitizeVerificationCommand,
  VERIFICATION_OBSERVATION_MAX,
  type CommandRunner,
  type RunVerificationGateOptions,
} from './verification-gate';
import { SOURCE_REVISION_UNAVAILABLE } from './source-revision';

// Phase C — host verification gate. Commands are UNTRUSTED-INPUT: sanitized,
// spawned with shell:false, clamped, and fail-closed on empty/rejected sets.

const NOW = '2026-07-06T12:00:00.000Z';

/** Options that keep the gate fully deterministic (no real git / no real spawn). */
function det(runCommand?: CommandRunner) {
  return {
    now: NOW,
    computeRevision: () => 'rev-fixed',
    ...(runCommand ? { runCommand } : {}),
  };
}

describe('sanitizeVerificationCommand', () => {
  it('accepts a clean command and splits it into argv', () => {
    expect(sanitizeVerificationCommand('npm run test')).toEqual({
      ok: true,
      argv: ['npm', 'run', 'test'],
    });
  });

  it('rejects an empty / whitespace-only command', () => {
    expect(sanitizeVerificationCommand('').ok).toBe(false);
    expect(sanitizeVerificationCommand('   ').ok).toBe(false);
  });

  it('rejects every shell metacharacter / operator', () => {
    for (const bad of [
      'npm; rm -rf /',
      'npm | b',
      'npm & b',
      'npm $HOME',
      'npm `id`',
      'npm < f',
      'npm > f',
      'npm (b)',
      'npm {b}',
      'npm\nb',
      'npm\rb',
    ]) {
      expect(sanitizeVerificationCommand(bad).ok, bad).toBe(false);
    }
  });

  it('rejects ALL control characters + NUL + DEL (ISSUE 7)', () => {
    for (const bad of ['npm\x00test', 'npm\x07test', 'npm\ttest', 'npm\x1btest', 'npm\x7ftest']) {
      expect(sanitizeVerificationCommand(bad).ok, JSON.stringify(bad)).toBe(false);
      expect(sanitizeVerificationCommand(bad).reason).toContain('control');
    }
  });

  it('rejects an executable that is not on the allowlist (ISSUE 1)', () => {
    // General shells / interpreters that run arbitrary strings are never allowlisted.
    for (const bad of ['sh -c whoami', 'bash script.sh', 'zsh', 'env X=1 npm test', 'ls -la']) {
      const res = sanitizeVerificationCommand(bad);
      expect(res.ok, bad).toBe(false);
      expect(res.reason).toContain('not allowlisted');
    }
  });

  it('rejects a path-qualified argv[0] even if its basename is allowlisted (ISSUE 1 round 2)', () => {
    // A directory component could point argv[0] at an attacker-planted binary that
    // merely SHARES a basename with a real runner. Only a BARE name is accepted.
    for (const bad of [
      '/usr/local/bin/npm test',
      './node_modules/.bin/vitest run',
      './npm test',
      '../npm test',
      'node_modules/.bin/npm test',
      '.hidden test',
      'C:\\tools\\npm test',
      'sub\\dir\\npm test',
    ]) {
      const res = sanitizeVerificationCommand(bad);
      expect(res.ok, bad).toBe(false);
      expect(res.reason, bad).toContain('bare name');
    }
  });

  it('rejects a Windows drive-relative / colon-bearing argv[0] (ISSUE 1 re-review)', () => {
    // `C:npm` is a Windows DRIVE-RELATIVE token: it has no path separator, does not
    // start with `.`, and is NOT path.isAbsolute() — so the old separator blocklist let
    // it through, yet on Windows it would resolve against the cwd of drive C:. The
    // positive bare-name shape rejects any argv[0] containing `:`.
    for (const bad of ['C:npm', 'C:npm test', 'd:node build.js', 'x:tsc run']) {
      const res = sanitizeVerificationCommand(bad);
      expect(res.ok, bad).toBe(false);
      expect(res.reason, bad).toContain('bare name');
    }
  });

  it('rejects drive-relative / path-qualified / metachar argv[0] but accepts bare runners (ISSUE 1 re-review)', () => {
    // Consolidated proof for the re-review: every disallowed shape is rejected...
    for (const bad of ['C:npm', './npm', '/usr/bin/npm', 'npm;rm']) {
      expect(sanitizeVerificationCommand(bad).ok, bad).toBe(false);
    }
    // ...while a bare, allowlisted runner is still accepted (resolved via PATH).
    for (const good of ['npm', 'node', 'tsc']) {
      expect(sanitizeVerificationCommand(good).ok, good).toBe(true);
    }
  });

  it('still accepts a BARE allowlisted executable (resolved via PATH)', () => {
    expect(sanitizeVerificationCommand('npm run test').ok).toBe(true);
    expect(sanitizeVerificationCommand('vitest run').ok).toBe(true);
    // A bare Windows-style extension is stripped for allowlist matching, still accepted.
    expect(sanitizeVerificationCommand('npm.cmd test').ok).toBe(true);
  });
});

describe('runVerificationGate', () => {
  it('passes when the single command exits 0', () => {
    const run: CommandRunner = () => ({ status: 0, stdout: 'ok', stderr: '' });
    const { verdict } = runVerificationGate(['npm test'], '/repo', det(run));
    expect(verdict.status).toBe('pass');
    expect(verdict.source).toBe('host');
    expect(verdict.testedRevision).toBe('rev-fixed');
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence?.[0]).toMatchObject({
      command: 'npm test',
      exitCode: 0,
      status: 'pass',
    });
  });

  it('fails when any command exits nonzero', () => {
    const run: CommandRunner = (argv) => ({
      status: argv[0] === 'npm' ? 0 : 1,
      stdout: '',
      stderr: 'boom',
    });
    const { verdict } = runVerificationGate(['npm test', 'jest'], '/repo', det(run));
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence?.map((e) => e.status)).toEqual(['pass', 'fail']);
  });

  it('fails (never a vacuous pass) when no command is supplied', () => {
    const run = vi.fn<Parameters<CommandRunner>, ReturnType<CommandRunner>>();
    const { verdict } = runVerificationGate([], '/repo', det(run));
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a metacharacter command WITHOUT executing it', () => {
    const run = vi.fn<Parameters<CommandRunner>, ReturnType<CommandRunner>>(() => ({
      status: 0,
      stdout: '',
      stderr: '',
    }));
    const { verdict } = runVerificationGate(['rm -rf / ; echo hi'], '/repo', det(run));
    expect(run).not.toHaveBeenCalled();
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence?.[0]).toMatchObject({ exitCode: null, status: 'fail' });
    expect(verdict.evidence?.[0].observation).toContain('rejected');
  });

  it('clamps a captured observation to the tail', () => {
    const huge = 'x'.repeat(VERIFICATION_OBSERVATION_MAX + 5_000) + 'TAIL';
    const run: CommandRunner = () => ({ status: 1, stdout: huge, stderr: '' });
    const { verdict } = runVerificationGate(['node build.js'], '/repo', det(run));
    const obs = verdict.evidence?.[0].observation ?? '';
    expect(obs.length).toBe(VERIFICATION_OBSERVATION_MAX);
    // Tail is retained (that is where failures usually surface).
    expect(obs.endsWith('TAIL')).toBe(true);
  });

  it('treats a killed / non-spawn command (null status) as fail', () => {
    const run: CommandRunner = () => ({ status: null, stdout: '', stderr: 'timed out' });
    const { verdict } = runVerificationGate(['vitest run'], '/repo', det(run));
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence?.[0]).toMatchObject({ exitCode: null, status: 'fail' });
  });

  it('rejects a non-allowlisted executable WITHOUT executing it (ISSUE 1)', () => {
    const run = vi.fn<Parameters<CommandRunner>, ReturnType<CommandRunner>>(() => ({
      status: 0,
      stdout: '',
      stderr: '',
    }));
    const { verdict } = runVerificationGate(['ls -la'], '/repo', det(run));
    expect(run).not.toHaveBeenCalled();
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence?.[0]).toMatchObject({ exitCode: null, status: 'fail' });
    expect(verdict.evidence?.[0].observation).toContain('not allowlisted');
  });

  it('never throws when the runner throws — records fail evidence instead (ISSUE 7)', () => {
    const run: CommandRunner = () => {
      throw new Error('spawn EACCES');
    };
    let verdict!: ReturnType<typeof runVerificationGate>['verdict'];
    expect(() => {
      verdict = runVerificationGate(['npm test'], '/repo', det(run)).verdict;
    }).not.toThrow();
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence?.[0]).toMatchObject({ exitCode: null, status: 'fail' });
    expect(verdict.evidence?.[0].observation).toContain('command threw');
  });

  it('never throws when the revision probe throws — falls back to no-git (ISSUE 7)', () => {
    const run: CommandRunner = () => ({ status: 0, stdout: '', stderr: '' });
    const opts: RunVerificationGateOptions = {
      now: NOW,
      runCommand: run,
      computeRevision: () => {
        throw new Error('git blew up');
      },
    };
    let verdict!: ReturnType<typeof runVerificationGate>['verdict'];
    expect(() => {
      verdict = runVerificationGate(['npm test'], '/repo', opts).verdict;
    }).not.toThrow();
    // Both probes fell back to the sentinel → identical → no false drift; command passed.
    expect(verdict.status).toBe('pass');
    expect(verdict.testedRevision).toBe('no-git');
  });

  it('downgrades a pass to inconclusive when the source moves during the run (ISSUE 5)', () => {
    const run: CommandRunner = () => ({ status: 0, stdout: 'ok', stderr: '' });
    let calls = 0;
    const opts: RunVerificationGateOptions = {
      now: NOW,
      runCommand: run,
      // Before-run revision differs from after-run revision → source drifted.
      computeRevision: () => (calls++ === 0 ? 'rev-before' : 'rev-after'),
    };
    const { verdict } = runVerificationGate(['npm test'], '/repo', opts);
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.rationale).toBe('verification source changed during run');
    // The before-revision is the one the verdict is bound to.
    expect(verdict.testedRevision).toBe('rev-before');
  });

  it('passes when the source is identical before and after the run (ISSUE 5)', () => {
    const run: CommandRunner = () => ({ status: 0, stdout: 'ok', stderr: '' });
    const { verdict } = runVerificationGate(['npm test'], '/repo', det(run));
    expect(verdict.status).toBe('pass');
    expect(verdict.testedRevision).toBe('rev-fixed');
  });

  it('downgrades a pass to inconclusive when the source revision is UNAVAILABLE (ISSUE 5/14)', () => {
    const run: CommandRunner = () => ({ status: 0, stdout: 'ok', stderr: '' });
    // The tree could not be fingerprinted (e.g. an untracked file over the byte cap):
    // the evidence cannot be bound to a source, so a pass must NOT be honored.
    const opts: RunVerificationGateOptions = {
      now: NOW,
      runCommand: run,
      computeRevision: () => SOURCE_REVISION_UNAVAILABLE,
    };
    const { verdict } = runVerificationGate(['npm test'], '/repo', opts);
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.rationale).toContain('unavailable');
    expect(verdict.testedRevision).toBe(SOURCE_REVISION_UNAVAILABLE);
  });
});
