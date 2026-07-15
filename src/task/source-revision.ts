/**
 * Source-revision token (verify-gate-loop Phase C). Binds a host verdict to the
 * exact working-tree state it was produced against, so a later change (a new
 * commit or a dirty edit) can be detected and the now-stale verdict invalidated.
 *
 * The git invocation is injectable so tests are deterministic and never depend on
 * the real repository. On ANY git error the sentinel {@link NO_GIT_REVISION} is
 * returned (never throws) — a weaker-but-usable token for non-git workspaces. When
 * an untracked entry cannot be bound to its exact content (over the byte cap, or a
 * read fails mid-stream) the distinct sentinel {@link SOURCE_REVISION_UNAVAILABLE}
 * is returned instead of a weak fingerprint, so the host verdict downgrades to
 * `inconclusive` rather than a spurious `pass`.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

/** Sentinel returned when git is unavailable / the cwd is not a repository. */
export const NO_GIT_REVISION = 'no-git';

/**
 * Sentinel returned when an untracked entry cannot be bound to its exact content —
 * it exceeds {@link MAX_UNTRACKED_HASH_BYTES}, or a read failed mid-stream. Distinct
 * from {@link NO_GIT_REVISION}: it means "the tree could not be fingerprinted", which
 * must force a host verdict to `inconclusive` (never a content-unbound `pass`).
 */
export const SOURCE_REVISION_UNAVAILABLE = 'unavailable';

/** Wall-clock budget for a single git probe. Must never hang a tick. */
const GIT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Upper bound on the cumulative bytes of a single untracked file that will be
 * chunk-read and hashed. A regular file whose content exceeds this cap cannot be
 * bound to a content digest without risking excessive work/memory, so the WHOLE
 * revision is reported as {@link SOURCE_REVISION_UNAVAILABLE} (not folded by SIZE —
 * a size-only marker would miss content changes that keep the size, ISSUE 5).
 */
const MAX_UNTRACKED_HASH_BYTES = 5 * 1024 * 1024;

/**
 * Fixed, reusable read buffer for chunked hashing. Reused across every entry and
 * every call so hashing a huge file never loads it whole into memory (fixed 64 KiB
 * footprint). Safe to share: `computeSourceRevision` is fully synchronous, so the
 * buffer is filled and consumed before any other code can observe it.
 */
const UNTRACKED_READ_CHUNK_BYTES = 64 * 1024;
const UNTRACKED_READ_BUFFER = Buffer.allocUnsafe(UNTRACKED_READ_CHUNK_BYTES);

/**
 * Internal marker: this untracked entry cannot be content-bound, so the whole
 * revision must be reported as {@link SOURCE_REVISION_UNAVAILABLE}. Kept distinct
 * from the string contributions folded for openable entries.
 */
const UNAVAILABLE: unique symbol = Symbol('source-revision-unavailable');

/**
 * Runs one `git` invocation and returns its stdout. Throws on any git/exec error.
 * Injected in tests; the default shells out with an explicit argv and `shell:false`
 * (git args here are host-owned constants, never task-supplied — see verification-gate.ts
 * for the untrusted-command path).
 */
export type GitRunner = (args: readonly string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });

/**
 * Compute a per-untracked-entry contribution string to fold into the revision hash,
 * or the {@link UNAVAILABLE} marker if the entry cannot be content-bound.
 *
 * TOCTOU-safe & content-bound (ISSUE 14 / ISSUE 5): the path is OPENED ONCE and every
 * decision is made against the resulting FILE DESCRIPTOR — never a second `stat`/`read`
 * of the same pathname (which a symlink could be swapped under). `O_NOFOLLOW` refuses to
 * open a symlink (fails `ELOOP`) and `O_NONBLOCK` prevents a FIFO/device open from
 * blocking. If the platform does not provide BOTH flags, the entry cannot be opened
 * safely → {@link UNAVAILABLE} (fail-closed). Otherwise:
 *  - symlink (ELOOP): fold `symlink:` + `sha256(readlink target)` — content-bound for a
 *    symlink and NEVER followed; if the readlink itself fails, return {@link UNAVAILABLE}.
 *  - any other open error (permission, race delete, ...): return {@link UNAVAILABLE} — an
 *    unreadable entry has no content-bound token, so fail closed rather than fold a
 *    constant non-content marker (ISSUE 5).
 *  - non-regular fd (FIFO/socket/device/dir): fold `nonfile:<mode>`, never read (a
 *    FIFO/device read would hang).
 *  - regular fd: chunk-read from the fd into a fixed buffer, hashing incrementally, and
 *    fold `content:<digest>`. If cumulative bytes exceed {@link MAX_UNTRACKED_HASH_BYTES},
 *    or a read fails mid-stream, return {@link UNAVAILABLE}.
 * Never throws.
 */
function hashUntrackedEntry(abs: string): string | typeof UNAVAILABLE {
  // These flags carry the whole safety guarantee: O_NOFOLLOW refuses to open a symlink
  // (closes the TOCTOU swap window) and O_NONBLOCK stops a FIFO/device open from hanging.
  // On a platform lacking EITHER (undefined or 0), opening without it would silently drop
  // that protection (ISSUE 14) — so fail closed: report the whole revision UNAVAILABLE
  // rather than open unsafely. Checked LAZILY here (this runs only when there IS an
  // untracked entry to hash), so a clean/empty untracked set still yields a normal token
  // on any platform, flags or not.
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
  const O_NONBLOCK = fs.constants.O_NONBLOCK;
  if (!O_NOFOLLOW || !O_NONBLOCK) return UNAVAILABLE;
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    // A symlink is refused by O_NOFOLLOW with ELOOP. Hash the link TARGET string —
    // content-bound for a symlink, and the target is NEVER followed/opened.
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ELOOP') {
      try {
        const target = fs.readlinkSync(abs);
        return `symlink:${createHash('sha256').update(target).digest('hex')}`;
      } catch {
        // readlink failed after ELOOP: the symlink cannot be content-bound → UNAVAILABLE
        // (fail-closed → inconclusive), never a constant non-content token (ISSUE 5).
        return UNAVAILABLE;
      }
    }
    // Any other open failure (permission, race delete, ...): the entry cannot be
    // content-bound → UNAVAILABLE (fail-closed → inconclusive), never a constant
    // non-content 'error' token (ISSUE 5).
    return UNAVAILABLE;
  }
  try {
    // Stat the FILE DESCRIPTOR, not the path — closes the TOCTOU window: the fd is
    // pinned to the exact inode we opened, so nothing swapped in at `abs` can redirect
    // the subsequent read.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      // FIFO / socket / device / dir opened read-only: never read (a FIFO/device read
      // would block indefinitely). Fold a stable type marker (the mode carries the
      // file-type bits) so the path still moves the token without touching "content".
      return `nonfile:${st.mode}`;
    }
    // Regular file: chunk-read from the fd into the FIXED reusable buffer, updating a
    // running digest until read returns 0. Never loads the whole file into memory.
    const digest = createHash('sha256');
    let total = 0;
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(fd, UNTRACKED_READ_BUFFER, 0, UNTRACKED_READ_BUFFER.length, null);
      if (bytesRead > 0) {
        total += bytesRead;
        // Over the cap: the revision cannot be bound to content → UNAVAILABLE (never a
        // weak size-only fingerprint). Stop reading immediately.
        if (total > MAX_UNTRACKED_HASH_BYTES) return UNAVAILABLE;
        digest.update(UNTRACKED_READ_BUFFER.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
    return `content:${digest.digest('hex')}`;
  } catch {
    // fstat/read failed mid-stream: the entry cannot be content-bound → UNAVAILABLE.
    return UNAVAILABLE;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Compute a 16-char token capturing HEAD commit + working-tree state:
 * `sha256(git rev-parse HEAD + '\n' + git status --porcelain=v1 + '\n' + git diff HEAD
 * + folded untracked file content).slice(0,16)`.
 * The `git diff HEAD` term hashes the actual CONTENT of tracked changes (staged +
 * unstaged) so the token reflects what changed, not merely which file names changed.
 * UNTRACKED files are then folded by CONTENT too: `git ls-files --others
 * --exclude-standard -z` yields their paths, which are sorted for determinism and, for
 * each, `path + '\0' + <contribution>` is mixed in (see {@link hashUntrackedEntry} for
 * the TOCTOU-safe, content-bound contribution) — so creating or editing an untracked
 * file moves the token (a new untracked test/artifact must invalidate a stale host
 * verdict). If ANY untracked entry cannot be content-bound (over the byte cap, or a read
 * fails mid-stream) the whole revision is {@link SOURCE_REVISION_UNAVAILABLE} rather than
 * a weak fingerprint. Returns {@link NO_GIT_REVISION} on any git error (never throws).
 */
export function computeSourceRevision(
  cwd: string,
  run: GitRunner = defaultGitRunner,
): string {
  try {
    const head = run(['rev-parse', 'HEAD'], cwd).trim();
    const status = run(['status', '--porcelain=v1'], cwd);
    const diff = run(['diff', 'HEAD'], cwd);
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'], cwd);

    const hash = createHash('sha256').update(`${head}\n${status}\n${diff}`);

    // Fold untracked file CONTENT deterministically: split the NUL-delimited list,
    // drop empties, SORT the paths (stable regardless of git's emission order), then
    // mix in `path + '\0' + <contribution>` for each.
    const untrackedPaths = untracked
      .split('\0')
      .filter((p) => p.length > 0)
      .sort();
    for (const rel of untrackedPaths) {
      const abs = join(cwd, rel);
      const contribution = hashUntrackedEntry(abs);
      if (contribution === UNAVAILABLE) {
        // An entry that cannot be content-bound makes the whole revision unbindable:
        // return the distinct sentinel so the host verdict goes `inconclusive`, never
        // a content-unbound `pass`.
        return SOURCE_REVISION_UNAVAILABLE;
      }
      hash.update(`\n${rel}\0${contribution}`);
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    // Not a git repo, git missing, or the probe failed: weaker sentinel, never throw.
    return NO_GIT_REVISION;
  }
}
