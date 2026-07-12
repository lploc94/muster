import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMPORT_DROPPED_FILE_MAX_BYTES,
  importDroppedFileBytes,
  sanitizeDroppedFileName,
} from './import-dropped-file';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('sanitizeDroppedFileName', () => {
  it('keeps unicode names and strips path traversal', () => {
    expect(sanitizeDroppedFileName('../../Ảnh màn hình 2026.png')).toBe('Ảnh màn hình 2026.png');
    expect(sanitizeDroppedFileName('a/b\\c.png')).toBe('c.png');
  });
});

describe('importDroppedFileBytes', () => {
  it('writes bytes and returns an absolute path under mkdtemp', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-import-test-'));
    dirs.push(tmpDir);
    const data = new TextEncoder().encode('hello drop');
    const result = importDroppedFileBytes('notes.txt', data, { tmpDir, now: 42 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path.includes('notes.txt')).toBe(true);
    expect(path.basename(path.dirname(result.path)).startsWith('muster-drop-')).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('hello drop');
    dirs.push(path.dirname(result.path));
  });

  it('allows empty files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-import-empty-'));
    dirs.push(tmpDir);
    const result = importDroppedFileBytes('empty.txt', new Uint8Array(0), { tmpDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.readFileSync(result.path).byteLength).toBe(0);
    dirs.push(path.dirname(result.path));
  });

  it('rejects oversized payloads', () => {
    const big = new Uint8Array(IMPORT_DROPPED_FILE_MAX_BYTES + 1);
    expect(importDroppedFileBytes('big.bin', big).ok).toBe(false);
  });
});
