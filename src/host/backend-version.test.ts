import { describe, it, expect } from 'vitest';
import {
  BACKEND_VERSION_SPECS,
  VERSION_COMMAND_MAX_BUFFER,
  VERSION_COMMAND_TIMEOUT_MS,
  collectBackendVersion,
  parseClaudeVersion,
  parseCodexVersion,
  parseGrokVersion,
  parseKiroVersion,
  parseOpenCodeVersion,
  classifyCompatibility,
  type ExecFileLike,
  type CompatibilityPolicy,
} from './backend-version';
import { BACKEND_READINESS_IDS } from '../shared/backend-readiness';

describe('BACKEND_VERSION_SPECS', () => {
  it('covers every allowlisted backend exactly once in readiness order', () => {
    expect(BACKEND_VERSION_SPECS.map((s) => s.backendId)).toEqual([...BACKEND_READINESS_IDS]);
  });

  it('uses fixed argv arrays with no shell interpolation tokens', () => {
    for (const spec of BACKEND_VERSION_SPECS) {
      expect(Array.isArray(spec.args)).toBe(true);
      expect(spec.args.length).toBeGreaterThan(0);
      for (const arg of spec.args) {
        expect(arg).not.toMatch(/[;&|`$]/);
        expect(arg.includes('${')).toBe(false);
      }
      expect(spec.timeoutMs).toBe(VERSION_COMMAND_TIMEOUT_MS);
      expect(spec.maxBuffer).toBe(VERSION_COMMAND_MAX_BUFFER);
    }
  });
});

describe('provider version parsers', () => {
  it('parses Claude version evidence', () => {
    expect(parseClaudeVersion('2.1.4 (Claude Code)\n')).toBe('2.1.4');
    expect(parseClaudeVersion('claude 1.0.0')).toBe('1.0.0');
  });

  it('parses Grok version evidence', () => {
    expect(parseGrokVersion('grok 0.12.3\n')).toBe('0.12.3');
    expect(parseGrokVersion('0.9.1')).toBe('0.9.1');
  });

  it('parses Kiro version evidence', () => {
    expect(parseKiroVersion('kiro-cli 1.2.0\n')).toBe('1.2.0');
  });

  it('parses Codex version evidence', () => {
    expect(parseCodexVersion('codex-cli 0.45.0\n')).toBe('0.45.0');
    expect(parseCodexVersion('codex 0.50.1')).toBe('0.50.1');
  });

  it('parses OpenCode version evidence', () => {
    expect(parseOpenCodeVersion('opencode 1.3.2\n')).toBe('1.3.2');
  });

  it('returns null for empty or unparseable output', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('   \n')).toBeNull();
    expect(parseClaudeVersion('not a version string')).toBeNull();
    expect(parseGrokVersion('error: unknown')).toBeNull();
  });

  it('rejects overlong version tokens rather than smuggling unbounded evidence', () => {
    const long = `1.0.0${'x'.repeat(80)}`;
    expect(parseClaudeVersion(long)).toBeNull();
  });
});

describe('classifyCompatibility', () => {
  it('reports unknown by default when no host policy floor/range is configured', () => {
    expect(classifyCompatibility('claude', '2.1.4')).toBe('unknown');
    expect(classifyCompatibility('claude', null)).toBe('unknown');
  });

  it('honors injected known-compatible and known-incompatible policies in fixtures', () => {
    const policy: CompatibilityPolicy = {
      claude: {
        classify(version) {
          if (!version) return 'unknown';
          if (version.startsWith('0.')) return 'incompatible';
          return 'compatible';
        },
      },
    };
    expect(classifyCompatibility('claude', '2.1.4', policy)).toBe('compatible');
    expect(classifyCompatibility('claude', '0.9.0', policy)).toBe('incompatible');
    expect(classifyCompatibility('claude', null, policy)).toBe('unknown');
    // Unconfigured providers stay unknown — no invented support claims.
    expect(classifyCompatibility('grok', '1.0.0', policy)).toBe('unknown');
  });
});

describe('collectBackendVersion', () => {
  function makeExec(result: {
    stdout?: string;
    stderr?: string;
    error?: NodeJS.ErrnoException & { killed?: boolean; code?: string | number | null };
  }): ExecFileLike {
    return async () => {
      if (result.error) throw result.error;
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    };
  }

  it('returns parsed version evidence on success with code none', async () => {
    const result = await collectBackendVersion({
      backendId: 'claude',
      command: 'claude',
      execFile: makeExec({ stdout: '2.1.4 (Claude Code)\n' }),
    });
    expect(result).toEqual({
      versionEvidence: '2.1.4',
      code: 'none',
    });
  });

  it('normalizes timeout to version_unknown with timeout code', async () => {
    const err = Object.assign(new Error('timeout'), { killed: true, code: 'ETIMEDOUT' });
    const result = await collectBackendVersion({
      backendId: 'claude',
      command: 'claude',
      execFile: makeExec({ error: err }),
    });
    expect(result).toEqual({ versionEvidence: null, code: 'timeout' });
  });

  it('normalizes non-zero exit to version_unknown with process_exited', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const result = await collectBackendVersion({
      backendId: 'grok',
      command: 'grok',
      execFile: makeExec({ error: err, stdout: '' }),
    });
    expect(result).toEqual({ versionEvidence: null, code: 'process_exited' });
  });

  it('normalizes empty and unparseable output to version_unknown', async () => {
    const empty = await collectBackendVersion({
      backendId: 'codex',
      command: 'codex',
      execFile: makeExec({ stdout: '' }),
    });
    expect(empty).toEqual({ versionEvidence: null, code: 'version_unknown' });

    const junk = await collectBackendVersion({
      backendId: 'opencode',
      command: 'opencode',
      execFile: makeExec({ stdout: 'something weird' }),
    });
    expect(junk).toEqual({ versionEvidence: null, code: 'version_unknown' });
  });

  it('invokes execFile with fixed argv, shell disabled, timeout, and maxBuffer', async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: {
        timeout?: number;
        maxBuffer?: number;
        shell?: boolean | string;
        encoding?: BufferEncoding;
      };
    }> = [];
    const execFile: ExecFileLike = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '1.2.3\n', stderr: '' };
    };
    await collectBackendVersion({
      backendId: 'kiro',
      command: 'kiro-cli',
      execFile,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('kiro-cli');
    expect(calls[0].args).toEqual(['--version']);
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.timeout).toBe(VERSION_COMMAND_TIMEOUT_MS);
    expect(calls[0].options.maxBuffer).toBe(VERSION_COMMAND_MAX_BUFFER);
    expect(calls[0].options.encoding).toBe('utf8');
  });

  it('never throws — always returns a bounded diagnostic result', async () => {
    const result = await collectBackendVersion({
      backendId: 'claude',
      command: 'claude',
      execFile: async () => {
        throw new Error('unexpected boom');
      },
    });
    expect(result.versionEvidence).toBeNull();
    expect(result.code === 'version_unknown' || result.code === 'internal_error').toBe(true);
  });
});
