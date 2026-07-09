import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandResolves } from './backend-availability';

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
