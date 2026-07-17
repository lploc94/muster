import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeSourceRevision,
  NO_GIT_REVISION,
  SOURCE_REVISION_UNAVAILABLE,
  type GitRunner,
} from './source-revision';

// Phase C — source-revision token binds a host verdict to the working-tree state.

/** Platforms without O_NOFOLLOW + O_NONBLOCK (e.g. win32) fail closed for untracked hashing. */
const HAS_SAFE_OPEN_FLAGS = Boolean(
  fs.constants.O_NOFOLLOW && fs.constants.O_NONBLOCK,
);

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('computeSourceRevision (injected runner)', () => {
  it('returns a stable 16-char token across two calls with no change', () => {
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'ls-files') return ''; // no untracked entries
      return ' M src/a.ts\n';
    };
    const first = computeSourceRevision('/repo', run);
    const second = computeSourceRevision('/repo', run);
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
    expect(first).not.toBe(NO_GIT_REVISION);
  });

  it('changes when the dirty (status) output changes', () => {
    const clean: GitRunner = (args) => (args[0] === 'rev-parse' ? 'abc123\n' : '');
    const dirty: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'ls-files') return ''; // no untracked entries
      return ' M src/a.ts\n';
    };
    expect(computeSourceRevision('/repo', clean)).not.toBe(
      computeSourceRevision('/repo', dirty),
    );
  });

  it('changes when HEAD (commit) changes', () => {
    const a: GitRunner = (args) => (args[0] === 'rev-parse' ? 'aaa\n' : '');
    const b: GitRunner = (args) => (args[0] === 'rev-parse' ? 'bbb\n' : '');
    expect(computeSourceRevision('/repo', a)).not.toBe(computeSourceRevision('/repo', b));
  });

  it('changes when tracked CONTENT (git diff HEAD) changes but file names do not (ISSUE 5)', () => {
    // Same HEAD, same porcelain status (same changed file name) but different diff
    // content → the token must move (evidence is bound to content, not just names).
    const runFor = (diff: string): GitRunner => (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return ' M src/a.ts\n';
      if (args[0] === 'ls-files') return ''; // no untracked entries
      return diff; // args[0] === 'diff'
    };
    const v1 = computeSourceRevision('/repo', runFor('@@ -1 +1 @@\n-old\n+new-1\n'));
    const v2 = computeSourceRevision('/repo', runFor('@@ -1 +1 @@\n-old\n+new-2\n'));
    expect(v1).not.toBe(v2);
  });

  it('returns the no-git sentinel when the runner throws (never rethrows)', () => {
    const run: GitRunner = () => {
      throw new Error('not a git repository');
    };
    expect(computeSourceRevision('/nope', run)).toBe(NO_GIT_REVISION);
  });

  it('yields UNAVAILABLE when an untracked entry cannot be opened (race-deleted / unreadable) (ISSUE 5)', () => {
    // git listed an untracked path but it cannot be opened here (no such file on disk — a
    // race delete between `ls-files` and the hash). That open error is NOT a handled
    // symlink, so it must fail closed to the UNAVAILABLE sentinel — never a constant
    // non-content 'error' token that would otherwise fold into a normal (spurious) pass.
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return '';
      if (args[0] === 'diff') return '';
      return 'ghost.txt\0'; // ls-files --others -z: path with no file behind it
    };
    expect(computeSourceRevision('/nonexistent-repo', run)).toBe(SOURCE_REVISION_UNAVAILABLE);
    // Deterministic across calls.
    expect(computeSourceRevision('/nonexistent-repo', run)).toBe(SOURCE_REVISION_UNAVAILABLE);
  });
});

describe('computeSourceRevision (real git repo)', () => {
  it('is stable with no change, moves on a dirty edit, and hits the sentinel off-repo', () => {
    const repo = tempDir('muster-source-rev-repo-');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const rev1 = computeSourceRevision(repo);
    const rev2 = computeSourceRevision(repo);
    expect(rev1).toHaveLength(16);
    expect(rev1).not.toBe(NO_GIT_REVISION);
    // Stable across calls with no working-tree change.
    expect(rev1).toBe(rev2);

    // A dirty edit moves the token (captures working-tree state).
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    expect(computeSourceRevision(repo)).not.toBe(rev1);

    // A directory that is not a git repo → sentinel.
    const plain = tempDir('muster-source-rev-plain-');
    expect(computeSourceRevision(plain)).toBe(NO_GIT_REVISION);
  });

  it.skipIf(!HAS_SAFE_OPEN_FLAGS)(
    'folds UNTRACKED file content into the token — a new/edited untracked file moves it (ISSUE 5)',
    () => {
    const repo = tempDir('muster-source-rev-untracked-');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const clean = computeSourceRevision(repo);

    // A brand-new UNTRACKED file must move the token (git diff HEAD does not cover it).
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'v1\n');
    const withUntracked = computeSourceRevision(repo);
    expect(withUntracked).not.toBe(clean);
    expect(withUntracked).not.toBe(NO_GIT_REVISION);

    // Editing the untracked file's CONTENT (same name) must move it again.
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'v2\n');
    const editedUntracked = computeSourceRevision(repo);
    expect(editedUntracked).not.toBe(withUntracked);

    // Stable when nothing changes.
    expect(computeSourceRevision(repo)).toBe(editedUntracked);
  },
  );

  it.skipIf(!HAS_SAFE_OPEN_FLAGS)(
    'hashes a dangling SYMLINK by its TARGET (never follows/hangs) and moves on target change (ISSUE 5/14)',
    () => {
    const repo = tempDir('muster-source-rev-symlink-');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const clean = computeSourceRevision(repo);

    // A dangling SYMLINK is opened with O_NOFOLLOW (fails ELOOP → never followed) and
    // folded by `sha256(readlink target)` — content-bound for the link, no crash/hang.
    const link = path.join(repo, 'link');
    fs.symlinkSync('/nonexistent/target-a', link);
    const withA = computeSourceRevision(repo);
    expect(withA).not.toBe(clean);
    expect(withA).not.toBe(NO_GIT_REVISION);
    expect(withA).not.toBe(SOURCE_REVISION_UNAVAILABLE);
    // Deterministic across repeated calls.
    expect(computeSourceRevision(repo)).toBe(withA);

    // Repoint the symlink at a DIFFERENT target (same link name) → the token moves
    // because the contribution is bound to the link target, not merely its type/mode.
    fs.unlinkSync(link);
    fs.symlinkSync('/nonexistent/target-b', link);
    const withB = computeSourceRevision(repo);
    expect(withB).not.toBe(withA);
    expect(withB).not.toBe(SOURCE_REVISION_UNAVAILABLE);
  },
  );

  it.skipIf(!HAS_SAFE_OPEN_FLAGS)(
    'folds a FIFO/special untracked entry as nonfile and never hangs (ISSUE 14)',
    () => {
    // git ls-files does NOT surface a FIFO, so inject the untracked list to exercise the
    // non-regular branch directly against a REAL FIFO on disk. The entry is opened
    // O_RDONLY|O_NONBLOCK (no blocking) and fstat'd (non-regular) — it is NEVER read (a
    // FIFO read would hang), so this test completing at all proves it does not hang.
    const dir = tempDir('muster-source-rev-fifo-');
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return '';
      if (args[0] === 'diff') return '';
      return 'pipe\0'; // ls-files --others -z
    };
    const token = computeSourceRevision(dir, run);
    expect(token).toHaveLength(16);
    expect(token).not.toBe(NO_GIT_REVISION);
    expect(token).not.toBe(SOURCE_REVISION_UNAVAILABLE);
    // Deterministic (mode-based marker) across calls.
    expect(computeSourceRevision(dir, run)).toBe(token);
  },
  );

  it('yields UNAVAILABLE for an untracked file over the byte cap, deterministically (ISSUE 5/14)', () => {
    const repo = tempDir('muster-source-rev-oversized-');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const clean = computeSourceRevision(repo);

    // A regular untracked file > MAX_UNTRACKED_HASH_BYTES (5 MiB) cannot be content-bound
    // → the WHOLE revision is the distinct UNAVAILABLE sentinel (not a weak size-only
    // fingerprint). Created sparsely via ftruncate so the test allocates no real 6 MB.
    const big = path.join(repo, 'big.bin');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, 6 * 1024 * 1024);
    fs.closeSync(fd);
    const over = computeSourceRevision(repo);
    expect(over).toBe(SOURCE_REVISION_UNAVAILABLE);
    // Deterministic (not a spurious token that thrashes across ticks).
    expect(computeSourceRevision(repo)).toBe(SOURCE_REVISION_UNAVAILABLE);
    expect(over).not.toBe(clean);
  });

  it.skipIf(!HAS_SAFE_OPEN_FLAGS)(
    'is CONTENT-bound (not size-bound) for a multi-chunk under-cap untracked file (ISSUE 5)',
    () => {
    const repo = tempDir('muster-source-rev-content-');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    // ~195 KiB > one 64 KiB read chunk → exercises the chunked read loop across chunks.
    const blob = path.join(repo, 'blob.bin');
    const size = 200_000;
    fs.writeFileSync(blob, Buffer.alloc(size, 0x41)); // all 'A'
    const v1 = computeSourceRevision(repo);
    expect(v1).not.toBe(SOURCE_REVISION_UNAVAILABLE);

    // Flip ONE byte, keeping the SIZE identical → the token must move (bound to CONTENT,
    // not size — this is the ISSUE 5 regression a size-only marker would have missed).
    const changed = Buffer.alloc(size, 0x41);
    changed[size - 1] = 0x42; // 'B'
    fs.writeFileSync(blob, changed);
    const v2 = computeSourceRevision(repo);
    expect(v2).not.toBe(v1);
    expect(v2).not.toBe(SOURCE_REVISION_UNAVAILABLE);
    // Stable when nothing changes.
    expect(computeSourceRevision(repo)).toBe(v2);
  },
  );
});

describe('computeSourceRevision (missing O_NOFOLLOW/O_NONBLOCK safety flags)', () => {
  // The real fs.constants entries are non-writable/non-configurable, so a flag-less
  // platform is simulated by re-importing the module against a mocked `fs` whose
  // `constants.O_NOFOLLOW` is 0. Scoped to this block via vi.doMock + a fresh dynamic
  // import, then torn down, so no other test sees the mock.
  async function importWithoutNofollow(): Promise<typeof import('./source-revision')> {
    vi.resetModules();
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        default: actual,
        // Drop O_NOFOLLOW (undefined/0) — the platform lacks the no-follow guarantee.
        constants: { ...actual.constants, O_NOFOLLOW: 0 },
      };
    });
    return import('./source-revision');
  }

  afterEach(() => {
    vi.doUnmock('fs');
    vi.resetModules();
  });

  it('fails closed to UNAVAILABLE when an untracked entry needs hashing but a safety flag is missing — yet the SAME entry hashes normally when the flag IS present (ISSUE 14)', async () => {
    // A genuinely OPENABLE regular untracked file, so the outcome turns on the flag guard
    // alone (not on an open failure). With the flag missing the guard fires BEFORE any
    // open → UNAVAILABLE; with real flags the same entry opens and hashes to a token.
    const dir = tempDir('muster-source-rev-noflag-');
    fs.writeFileSync(path.join(dir, 'real.txt'), 'content\n');
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return '';
      if (args[0] === 'diff') return '';
      return 'real.txt\0'; // ls-files --others -z: an openable regular file to hash
    };
    const mod = await importWithoutNofollow();
    expect(mod.computeSourceRevision(dir, run)).toBe(mod.SOURCE_REVISION_UNAVAILABLE);
    // Control on real flags (statically imported, unmocked fs): the SAME entry opens and
    // hashes to a normal token — proving the missing flag, not the open, forces the fail.
    // On platforms that lack the flags natively (win32), product already fail-closes; the
    // mock path above still proves the guard. Skip the control when flags are unavailable.
    if (!HAS_SAFE_OPEN_FLAGS) return;
    const token = computeSourceRevision(dir, run);
    expect(token).toHaveLength(16);
    expect(token).not.toBe(SOURCE_REVISION_UNAVAILABLE);
  });

  it('still yields a normal token on the same flag-less platform when the untracked set is EMPTY (ISSUE 14 — lazy)', async () => {
    const mod = await importWithoutNofollow();
    // No untracked entries → the flag guard is never reached → normal token, so host
    // verification keeps working on platforms without these flags whenever it is safe.
    const noUntracked: GitRunner = (args) => (args[0] === 'rev-parse' ? 'abc123\n' : '');
    const token = mod.computeSourceRevision('/repo', noUntracked);
    expect(token).toHaveLength(16);
    expect(token).not.toBe(mod.SOURCE_REVISION_UNAVAILABLE);
    expect(token).not.toBe(mod.NO_GIT_REVISION);
  });
});
