import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  commandResolves,
  BACKEND_PROVIDER_REGISTRY,
  resolveBackendCommand,
  detectAvailableBackends,
} from './backend-availability';
import { BACKEND_READINESS_IDS } from '../shared/backend-readiness';

describe('BACKEND_PROVIDER_REGISTRY', () => {
  it('is ordered exactly as BACKEND_READINESS_IDS', () => {
    expect(BACKEND_PROVIDER_REGISTRY.map((e) => e.id)).toEqual([...BACKEND_READINESS_IDS]);
  });

  it('resolves allowlisted commands without absolute path leakage helpers', () => {
    for (const entry of BACKEND_PROVIDER_REGISTRY) {
      const command = resolveBackendCommand(entry.id);
      expect(typeof command).toBe('string');
      expect(command.length).toBeGreaterThan(0);
    }
  });

  it('honors CLAUDE_CODE_EXECUTABLE and CODEX_PATH overrides', () => {
    const prevClaude = process.env.CLAUDE_CODE_EXECUTABLE;
    const prevCodex = process.env.CODEX_PATH;
    try {
      process.env.CLAUDE_CODE_EXECUTABLE = '/tmp/custom-claude';
      process.env.CODEX_PATH = '/tmp/custom-codex';
      expect(resolveBackendCommand('claude')).toBe('/tmp/custom-claude');
      expect(resolveBackendCommand('codex')).toBe('/tmp/custom-codex');
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
      else process.env.CLAUDE_CODE_EXECUTABLE = prevClaude;
      if (prevCodex === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = prevCodex;
    }
  });
});

describe('commandResolves', () => {
  let dir: string;
  const exe = 'muster-fake-cli';
  const plain = 'muster-not-exec';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-avail-'));
    fs.writeFileSync(path.join(dir, exe), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, plain), 'data', { mode: 0o644 });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves an executable on the search path', () => {
    expect(commandResolves(exe, [dir])).toBe(true);
  });

  it('does not resolve a missing command', () => {
    expect(commandResolves('definitely-not-here-xyz', [dir])).toBe(false);
  });

  it('does not resolve a non-executable file (posix)', () => {
    if (process.platform === 'win32') return; // win32 ignores the exec bit
    expect(commandResolves(plain, [dir])).toBe(false);
  });

  it('resolves an absolute path to an executable', () => {
    expect(commandResolves(path.join(dir, exe), [])).toBe(true);
  });

  it('does not resolve an absolute path to a non-executable (posix)', () => {
    if (process.platform === 'win32') return;
    expect(commandResolves(path.join(dir, plain), [])).toBe(false);
  });

  it('searches every provided directory', () => {
    expect(commandResolves(exe, ['/no/such/dir', dir])).toBe(true);
  });
});

describe('detectAvailableBackends', () => {
  it('returns only backends whose commands resolve on PATH (order preserved)', async () => {
    // Smoke: function returns a subset of allowlisted ids without throwing.
    const available = await detectAvailableBackends();
    expect(Array.isArray(available)).toBe(true);
    for (const id of available) {
      expect(BACKEND_READINESS_IDS).toContain(id);
    }
    // Order of available list follows registry order (subset of readiness order).
    const positions = available.map((id) => BACKEND_READINESS_IDS.indexOf(id as typeof BACKEND_READINESS_IDS[number]));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
