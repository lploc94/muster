import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const IMPORT_DROPPED_FILE_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB
/** Prune imported drops older than this age when writing a new one. */
export const IMPORT_DROPPED_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DROP_DIR_PREFIX = 'muster-drop-';

export type ImportDroppedFileResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

/** Strip path separators and control chars from a user-supplied file name. */
export function sanitizeDroppedFileName(name: string): string {
  // Normalize separators first so basename works the same on posix/win32.
  const normalized = name.replace(/\\/g, '/');
  const base = path.posix
    .basename(normalized)
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return 'dropped-file';
  // Keep unicode letters (e.g. Vietnamese screenshot names); cap length.
  return base.length > 180 ? base.slice(0, 180) : base;
}

function isSafeOwnedDropDir(full: string, uid: number | undefined): boolean {
  try {
    const st = fs.lstatSync(full);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    // POSIX ownership/mode checks are meaningful only when getuid exists.
    // On Windows, temp dir modes are not unix-permission accurate (often 666),
    // so require only that the path is a real non-symlink directory.
    if (typeof uid === 'number') {
      if (typeof st.uid === 'number' && st.uid !== uid) return false;
      // Reject world/group-writable drop dirs when mode is available.
      if (typeof st.mode === 'number' && (st.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Best-effort prune of previous per-drop directories under os.tmpdir(). */
export function pruneStaleMusterDrops(
  tmpDir: string,
  now: number,
  maxAgeMs: number,
  uid?: number,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DROP_DIR_PREFIX)) continue;
    const full = path.join(tmpDir, entry.name);
    if (!isSafeOwnedDropDir(full, uid)) continue;
    try {
      const st = fs.lstatSync(full);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Persist raw drop bytes under an owner-only temp directory and return the absolute path.
 * Used when the webview cannot see OS absolute paths (VS Code sandbox).
 *
 * Each import uses `mkdtempSync` directly under the system temp dir (no shared
 * predictable parent that another user could pre-create as a symlink).
 */
export function importDroppedFileBytes(
  fileName: string,
  data: Uint8Array,
  options?: { tmpDir?: string; now?: number },
): ImportDroppedFileResult {
  if (!(data instanceof Uint8Array)) {
    return { ok: false, message: 'Dropped file data is missing.' };
  }
  const bytes = data;
  // Empty files are valid (placeholder configs); still materialize a path.
  if (bytes.byteLength > IMPORT_DROPPED_FILE_MAX_BYTES) {
    return {
      ok: false,
      message: `Dropped file is too large (max ${Math.floor(IMPORT_DROPPED_FILE_MAX_BYTES / (1024 * 1024))} MB).`,
    };
  }

  const now = options?.now ?? Date.now();
  const tmpDir = options?.tmpDir ?? os.tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

  pruneStaleMusterDrops(tmpDir, now, IMPORT_DROPPED_FILE_MAX_AGE_MS, uid);

  let sessionDir: string;
  try {
    sessionDir = fs.mkdtempSync(path.join(tmpDir, DROP_DIR_PREFIX));
    try {
      fs.chmodSync(sessionDir, 0o700);
    } catch {
      /* best-effort */
    }
    if (!isSafeOwnedDropDir(sessionDir, uid)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return { ok: false, message: 'Unable to create a secure folder for the dropped file.' };
    }
  } catch {
    return { ok: false, message: 'Unable to create a folder for the dropped file.' };
  }

  const safe = sanitizeDroppedFileName(fileName);
  const dest = path.join(sessionDir, safe);
  try {
    fs.writeFileSync(dest, Buffer.from(bytes), { flag: 'wx', mode: 0o600 });
  } catch {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, message: 'Unable to save the dropped file.' };
  }

  // Always absolute, forward slashes for stable mentions on all platforms.
  return { ok: true, path: dest.replace(/\\/g, '/') };
}
