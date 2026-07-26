import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOOL_FILE_CHANGE_TEXT_MAX,
  TOOL_FILE_CHANGE_TRUNCATION_SUFFIX,
  TOOL_FILE_CHANGES_MAX_FILES,
  boundToolFileChanges,
  sanitizeToolFileChangePath,
  type BoundedToolFileChange,
} from './tool-file-changes';

function change(
  pathValue: string,
  oldText: string | null = 'old',
  newText = 'new',
): BoundedToolFileChange {
  return { path: pathValue, oldText, newText };
}

describe('constants', () => {
  it('mirrors the webview protocol outer bounds', () => {
    expect(TOOL_FILE_CHANGES_MAX_FILES).toBe(32);
    expect(TOOL_FILE_CHANGE_TEXT_MAX).toBe(262_144);
    expect(TOOL_FILE_CHANGE_TRUNCATION_SUFFIX).toBe('\n… truncated');
  });
});

describe('sanitizeToolFileChangePath', () => {
  it('relativizes absolute paths under cwd to POSIX workspace-relative paths', () => {
    const cwd = path.resolve('/workspace/project');
    const abs = path.join(cwd, 'src', 'app.ts');
    expect(sanitizeToolFileChangePath(abs, cwd)).toBe('src/app.ts');
  });

  it('returns "." when the path is the cwd itself', () => {
    const cwd = path.resolve('/workspace/project');
    expect(sanitizeToolFileChangePath(cwd, cwd)).toBe('.');
  });

  it('degrades absolute paths outside cwd to basename', () => {
    const cwd = path.resolve('/workspace/project');
    expect(sanitizeToolFileChangePath('/tmp/outside.ts', cwd)).toBe('outside.ts');
  });

  it('never leaves a Windows drive-prefixed path intact', () => {
    const sanitized = sanitizeToolFileChangePath('C:\\Users\\dev\\secret\\file.ts');
    expect(sanitized).toBe('file.ts');
    expect(sanitized).not.toMatch(/^[A-Za-z]:/);
    expect(sanitized).not.toContain('\\');
    expect(sanitized).not.toContain('Users');
  });

  it('strips NUL bytes before other handling', () => {
    expect(sanitizeToolFileChangePath('src/\0app.ts')).toBe('src/app.ts');
  });

  it('normalizes already-relative paths to POSIX separators', () => {
    expect(sanitizeToolFileChangePath('src\\lib\\util.ts')).toBe('src/lib/util.ts');
  });

  it('returns empty string for whitespace-only input after strip', () => {
    expect(sanitizeToolFileChangePath('   ')).toBe('');
  });
});

describe('boundToolFileChanges', () => {
  it('returns {} for undefined input so absence stays byte-identical', () => {
    expect(boundToolFileChanges(undefined)).toEqual({});
  });

  it('returns {} for empty array input', () => {
    expect(boundToolFileChanges([])).toEqual({});
  });

  it('passes three entries through unchanged without truncated or omitted', () => {
    const input = [change('a.ts'), change('b.ts'), change('c.ts')];
    const result = boundToolFileChanges(input);
    expect(result.fileChanges).toEqual([
      { path: 'a.ts', oldText: 'old', newText: 'new' },
      { path: 'b.ts', oldText: 'old', newText: 'new' },
      { path: 'c.ts', oldText: 'old', newText: 'new' },
    ]);
    expect(result).not.toHaveProperty('fileChangesOmitted');
    for (const entry of result.fileChanges ?? []) {
      expect(entry).not.toHaveProperty('truncated');
    }
  });

  it('keeps the first 32 of 40 entries and reports fileChangesOmitted: 8', () => {
    const input = Array.from({ length: 40 }, (_, i) => change(`f${i}.ts`));
    const result = boundToolFileChanges(input);
    expect(result.fileChanges).toHaveLength(TOOL_FILE_CHANGES_MAX_FILES);
    expect(result.fileChanges?.[0]?.path).toBe('f0.ts');
    expect(result.fileChanges?.[31]?.path).toBe('f31.ts');
    expect(result.fileChangesOmitted).toBe(8);
  });

  it('clips oversized newText, sets truncated: true, and stays within the bound', () => {
    const huge = 'x'.repeat(TOOL_FILE_CHANGE_TEXT_MAX + 50);
    const result = boundToolFileChanges([change('big.ts', 'old', huge)]);
    const entry = result.fileChanges?.[0];
    expect(entry).toBeDefined();
    expect(entry!.truncated).toBe(true);
    expect(entry!.newText.length).toBeLessThanOrEqual(TOOL_FILE_CHANGE_TEXT_MAX);
    expect(entry!.newText.endsWith(TOOL_FILE_CHANGE_TRUNCATION_SUFFIX)).toBe(true);
    expect(entry!.oldText).toBe('old');
  });

  it('clips oversized oldText alone and sets truncated: true', () => {
    const huge = 'y'.repeat(TOOL_FILE_CHANGE_TEXT_MAX + 10);
    const result = boundToolFileChanges([change('old-big.ts', huge, 'new')]);
    const entry = result.fileChanges?.[0];
    expect(entry).toBeDefined();
    expect(entry!.truncated).toBe(true);
    expect(entry!.oldText!.length).toBeLessThanOrEqual(TOOL_FILE_CHANGE_TEXT_MAX);
    expect(entry!.oldText!.endsWith(TOOL_FILE_CHANGE_TRUNCATION_SUFFIX)).toBe(true);
    expect(entry!.newText).toBe('new');
  });

  it('preserves oldText null for file creates', () => {
    const result = boundToolFileChanges([change('created.ts', null, 'body')]);
    expect(result.fileChanges?.[0]).toEqual({
      path: 'created.ts',
      oldText: null,
      newText: 'body',
    });
  });

  it('sanitizes absolute in-cwd paths to workspace-relative POSIX paths', () => {
    const cwd = path.resolve('/workspace/project');
    const abs = path.join(cwd, 'src', 'main.ts');
    const result = boundToolFileChanges([change(abs)], { cwd });
    expect(result.fileChanges?.[0]?.path).toBe('src/main.ts');
  });

  it('degrades absolute outside-cwd paths to basename', () => {
    const cwd = path.resolve('/workspace/project');
    const result = boundToolFileChanges([change('/etc/passwd')], { cwd });
    expect(result.fileChanges?.[0]?.path).toBe('passwd');
  });

  it('never lets a Windows drive-prefixed path survive with host home layout', () => {
    const result = boundToolFileChanges([
      change('C:\\Users\\alice\\AppData\\Local\\secret.ts', 'a', 'b'),
    ]);
    const p = result.fileChanges?.[0]?.path ?? '';
    expect(p).toBe('secret.ts');
    expect(p).not.toMatch(/^[A-Za-z]:/);
    expect(p).not.toContain('Users');
    expect(p).not.toContain('\\');
  });

  it('strips NUL from paths during bounding', () => {
    const result = boundToolFileChanges([change('src/\0evil.ts')]);
    expect(result.fileChanges?.[0]?.path).toBe('src/evil.ts');
  });

  it('drops entries whose sanitized path is empty', () => {
    const result = boundToolFileChanges([change('   '), change('kept.ts')]);
    expect(result.fileChanges).toEqual([{ path: 'kept.ts', oldText: 'old', newText: 'new' }]);
    expect(result).not.toHaveProperty('fileChangesOmitted');
  });

  it('returns {} when every entry is dropped', () => {
    expect(boundToolFileChanges([change(''), change('  ')])).toEqual({});
  });

  it('does not mutate the input array or entries', () => {
    const input: BoundedToolFileChange[] = [
      { path: 'a.ts', oldText: 'old', newText: 'new' },
      { path: 'b.ts', oldText: 'old', newText: 'new' },
    ];
    const snapshot = structuredClone(input);
    boundToolFileChanges(input);
    expect(input).toEqual(snapshot);
  });

  it('never emits truncated: false', () => {
    const result = boundToolFileChanges([change('ok.ts')]);
    expect(Object.prototype.hasOwnProperty.call(result.fileChanges?.[0], 'truncated')).toBe(false);
  });

  it('counts only file-count overflow as omitted, not empty-path drops', () => {
    // 1 empty + 33 valid → keep 32 valid, omit 1 valid (empty does not count toward omitted).
    const input = [change(''), ...Array.from({ length: 33 }, (_, i) => change(`f${i}.ts`))];
    const result = boundToolFileChanges(input);
    expect(result.fileChanges).toHaveLength(32);
    expect(result.fileChangesOmitted).toBe(1);
  });
});
