import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOOL_FILE_CHANGE_PATH_MAX_BYTES,
  TOOL_FILE_CHANGE_SIDE_MAX_BYTES,
  TOOL_FILE_CHANGE_SIDE_MAX_LINES,
  TOOL_FILE_CHANGES_MAX_FILES,
  TOOL_FILE_CHANGES_TOTAL_MAX_BYTES,
  isBoundedToolFileChange,
  isBoundedToolFileChanges,
  utf8ByteLength,
} from './tool-file-change-contract';
import {
  TOOL_FILE_CHANGE_TEXT_MAX,
  boundToolFileChanges,
  classifyToolFileChangePath,
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
    expect(TOOL_FILE_CHANGE_TEXT_MAX).toBe(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
    expect(TOOL_FILE_CHANGE_PATH_MAX_BYTES).toBeLessThan(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
    expect(TOOL_FILE_CHANGES_TOTAL_MAX_BYTES).toBeGreaterThan(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
  });
});

describe('sanitizeToolFileChangePath', () => {
  it('relativizes absolute paths under cwd to POSIX workspace-relative paths', () => {
    const cwd = path.resolve('/workspace/project');
    const abs = path.join(cwd, 'src', 'app.ts');
    expect(sanitizeToolFileChangePath(abs, cwd)).toBe('src/app.ts');
  });

  it('rejects the workspace root because it is not a file identity', () => {
    const cwd = path.resolve('/workspace/project');
    expect(sanitizeToolFileChangePath(cwd, cwd)).toBe('');
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

  it('rejects control and bidi characters instead of silently rewriting them', () => {
    for (const unsafe of [
      'src/\0app.ts',
      'src/\napp.ts',
      'src/\u001bapp.ts',
      'src/\u202eapp.ts',
      'src/\u2066app.ts',
    ]) {
      expect(sanitizeToolFileChangePath(unsafe)).toBe('');
    }
  });

  it('degrades traversal outside cwd to a basename-only path', () => {
    const cwd = path.resolve('/workspace/project');
    expect(sanitizeToolFileChangePath('../Users/alice/secret.ts', cwd)).toBe('secret.ts');
    expect(sanitizeToolFileChangePath('../../etc/passwd', cwd)).toBe('passwd');
  });

  it('preserves valid child segments whose names merely start with two dots', () => {
    const cwd = path.resolve('/workspace/project');
    expect(sanitizeToolFileChangePath(path.join(cwd, '..config', 'a.ts'), cwd)).toBe(
      '..config/a.ts',
    );
  });

  it('rejects paths over the UTF-8 path byte bound', () => {
    expect(sanitizeToolFileChangePath(`${'é'.repeat(TOOL_FILE_CHANGE_PATH_MAX_BYTES)}.ts`)).toBe('');
  });

  it('normalizes already-relative paths to POSIX separators', () => {
    expect(sanitizeToolFileChangePath('src\\lib\\util.ts')).toBe('src/lib/util.ts');
  });

  it('returns empty string for whitespace-only input after strip', () => {
    expect(sanitizeToolFileChangePath('   ')).toBe('');
  });
});

describe('classifyToolFileChangePath', () => {
  it('marks absolute paths outside cwd as outsideWorkspace without leaking host layout', () => {
    const cwd = path.resolve('/workspace/project');
    expect(classifyToolFileChangePath('/tmp/outside.ts', cwd)).toEqual({
      path: 'outside.ts',
      outsideWorkspace: true,
    });
    expect(classifyToolFileChangePath('/tmp/outside.ts', cwd).path).not.toContain('tmp');
  });

  it('marks traversal that resolves outside cwd as outsideWorkspace', () => {
    const cwd = path.resolve('/workspace/project');
    expect(classifyToolFileChangePath('../Users/alice/secret.ts', cwd)).toEqual({
      path: 'secret.ts',
      outsideWorkspace: true,
    });
    expect(classifyToolFileChangePath('../../etc/passwd', cwd)).toEqual({
      path: 'passwd',
      outsideWorkspace: true,
    });
  });

  it('marks Windows drive and UNC paths degraded to basename as outsideWorkspace', () => {
    expect(classifyToolFileChangePath('C:\\Users\\dev\\secret\\file.ts')).toEqual({
      path: 'file.ts',
      outsideWorkspace: true,
    });
    expect(classifyToolFileChangePath('\\\\fileserver\\share\\secret.ts')).toEqual({
      path: 'secret.ts',
      outsideWorkspace: true,
    });
  });

  it('does not mark proven in-workspace absolute paths', () => {
    const cwd = path.resolve('/workspace/project');
    const abs = path.join(cwd, 'src', 'app.ts');
    expect(classifyToolFileChangePath(abs, cwd)).toEqual({ path: 'src/app.ts' });
    expect(classifyToolFileChangePath(abs, cwd)).not.toHaveProperty('outsideWorkspace');
  });

  it('does not mark ordinary relative in-workspace paths', () => {
    expect(classifyToolFileChangePath('src/lib/util.ts')).toEqual({ path: 'src/lib/util.ts' });
    expect(classifyToolFileChangePath('src\\lib\\util.ts')).toEqual({ path: 'src/lib/util.ts' });
  });
});

describe('outsideWorkspace marker contract', () => {
  it('accepts present-only outsideWorkspace: true on a safe relative path', () => {
    expect(
      isBoundedToolFileChange({
        path: 'secret.ts',
        oldText: 'a',
        newText: 'b',
        outsideWorkspace: true,
      }),
    ).toBe(true);
  });

  it('rejects malformed outsideWorkspace values and unknown keys (fail closed)', () => {
    expect(
      isBoundedToolFileChange({
        path: 'secret.ts',
        oldText: 'a',
        newText: 'b',
        outsideWorkspace: false,
      }),
    ).toBe(false);
    expect(
      isBoundedToolFileChange({
        path: 'secret.ts',
        oldText: 'a',
        newText: 'b',
        outsideWorkspace: 'true',
      }),
    ).toBe(false);
    expect(
      isBoundedToolFileChange({
        path: 'secret.ts',
        oldText: 'a',
        newText: 'b',
        outsideWorkspace: 1,
      }),
    ).toBe(false);
    expect(
      isBoundedToolFileChange({
        path: 'secret.ts',
        oldText: 'a',
        newText: 'b',
        hostPath: '/tmp/secret.ts',
      }),
    ).toBe(false);
  });

  it('accepts ordinary entries without the marker and still rejects raw absolute paths', () => {
    expect(
      isBoundedToolFileChange({ path: 'src/app.ts', oldText: null, newText: 'x' }),
    ).toBe(true);
    expect(
      isBoundedToolFileChange({
        path: '/tmp/outside.ts',
        oldText: null,
        newText: 'x',
        outsideWorkspace: true,
      }),
    ).toBe(false);
  });

  it('accepts arrays that mix marked and unmarked entries under existing budgets', () => {
    expect(
      isBoundedToolFileChanges([
        { path: 'src/app.ts', oldText: 'a', newText: 'b' },
        { path: 'secret.ts', oldText: 'a', newText: 'b', outsideWorkspace: true },
      ]),
    ).toBe(true);
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
    expect(utf8ByteLength(entry!.newText)).toBeLessThanOrEqual(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
    expect(entry!.newText).not.toContain('… truncated');
    expect(entry!.oldText).toBe('old');
  });

  it('clips oversized oldText alone and sets truncated: true', () => {
    const huge = 'y'.repeat(TOOL_FILE_CHANGE_TEXT_MAX + 10);
    const result = boundToolFileChanges([change('old-big.ts', huge, 'new')]);
    const entry = result.fileChanges?.[0];
    expect(entry).toBeDefined();
    expect(entry!.truncated).toBe(true);
    expect(utf8ByteLength(entry!.oldText!)).toBeLessThanOrEqual(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
    expect(entry!.oldText).not.toContain('… truncated');
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

  it('degrades absolute outside-cwd paths to basename and marks outsideWorkspace', () => {
    const cwd = path.resolve('/workspace/project');
    const result = boundToolFileChanges([change('/etc/passwd')], { cwd });
    expect(result.fileChanges?.[0]).toEqual({
      path: 'passwd',
      oldText: 'old',
      newText: 'new',
      outsideWorkspace: true,
    });
  });

  it('never lets a Windows drive-prefixed path survive with host home layout', () => {
    const result = boundToolFileChanges([
      change('C:\\Users\\alice\\AppData\\Local\\secret.ts', 'a', 'b'),
    ]);
    const entry = result.fileChanges?.[0];
    expect(entry?.path).toBe('secret.ts');
    expect(entry?.outsideWorkspace).toBe(true);
    expect(entry?.path).not.toMatch(/^[A-Za-z]:/);
    expect(entry?.path).not.toContain('Users');
    expect(entry?.path).not.toContain('\\');
  });

  it('marks traversal outside cwd without exposing host layout', () => {
    const cwd = path.resolve('/workspace/project');
    const result = boundToolFileChanges(
      [change('../Users/alice/secret.ts', 'a', 'b')],
      { cwd },
    );
    expect(result.fileChanges?.[0]).toEqual({
      path: 'secret.ts',
      oldText: 'a',
      newText: 'b',
      outsideWorkspace: true,
    });
  });

  it('does not mark proven in-workspace absolute paths', () => {
    const cwd = path.resolve('/workspace/project');
    const abs = path.join(cwd, 'src', 'main.ts');
    const result = boundToolFileChanges([change(abs)], { cwd });
    expect(result.fileChanges?.[0]).toEqual({
      path: 'src/main.ts',
      oldText: 'old',
      newText: 'new',
    });
    expect(result.fileChanges?.[0]).not.toHaveProperty('outsideWorkspace');
  });

  it('preserves an already-true outsideWorkspace marker when rebounding without cwd', () => {
    const result = boundToolFileChanges([
      {
        path: 'secret.ts',
        oldText: 'a',
        newText: 'b',
        outsideWorkspace: true,
      },
    ]);
    expect(result.fileChanges?.[0]).toEqual({
      path: 'secret.ts',
      oldText: 'a',
      newText: 'b',
      outsideWorkspace: true,
    });
  });

  it('never emits outsideWorkspace: false', () => {
    const result = boundToolFileChanges([change('ok.ts')]);
    expect(
      Object.prototype.hasOwnProperty.call(result.fileChanges?.[0], 'outsideWorkspace'),
    ).toBe(false);
  });

  it('omits unsafe paths and reports every omission honestly', () => {
    const result = boundToolFileChanges([
      change('src/\0evil.ts'),
      change('src/\u202esecret.ts'),
      change('kept.ts'),
    ]);
    expect(result.fileChanges).toEqual([{ path: 'kept.ts', oldText: 'old', newText: 'new' }]);
    expect(result.fileChangesOmitted).toBe(2);
  });

  it('drops entries whose sanitized path is empty and reports the omission', () => {
    const result = boundToolFileChanges([change('   '), change('kept.ts')]);
    expect(result.fileChanges).toEqual([{ path: 'kept.ts', oldText: 'old', newText: 'new' }]);
    expect(result.fileChangesOmitted).toBe(1);
  });

  it('retains an omission marker when every unsafe entry is dropped', () => {
    expect(boundToolFileChanges([change(''), change('  ')])).toEqual({ fileChangesOmitted: 2 });
  });

  it('clips multibyte sides by UTF-8 bytes without splitting a code point', () => {
    const result = boundToolFileChanges([
      change('emoji.ts', null, '🙂'.repeat(TOOL_FILE_CHANGE_SIDE_MAX_BYTES)),
    ]);
    const entry = result.fileChanges?.[0];
    expect(entry?.truncated).toBe(true);
    expect(utf8ByteLength(entry?.newText ?? '')).toBeLessThanOrEqual(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
    expect(entry?.newText.endsWith('🙂')).toBe(true);
    expect(entry?.newText).not.toContain('�');
  });

  it('clips newline-dense evidence by logical line count', () => {
    const result = boundToolFileChanges([
      change('dense.ts', '', 'x\n'.repeat(TOOL_FILE_CHANGE_SIDE_MAX_LINES + 100)),
    ]);
    const entry = result.fileChanges?.[0];
    expect(entry?.truncated).toBe(true);
    expect((entry?.newText.match(/\n/g) ?? []).length).toBeLessThanOrEqual(
      TOOL_FILE_CHANGE_SIDE_MAX_LINES,
    );
  });

  it('omits whole entries that exceed the aggregate retained-byte bound', () => {
    const side = 'x'.repeat(TOOL_FILE_CHANGE_SIDE_MAX_BYTES);
    const input = Array.from({ length: 8 }, (_, index) =>
      change(`large-${index}.ts`, side, side),
    );
    const result = boundToolFileChanges(input);
    const retainedBytes = (result.fileChanges ?? []).reduce(
      (total, entry) =>
        total +
        utf8ByteLength(entry.path) +
        (entry.oldText === null ? 0 : utf8ByteLength(entry.oldText)) +
        utf8ByteLength(entry.newText),
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(TOOL_FILE_CHANGES_TOTAL_MAX_BYTES);
    expect(result.fileChangesOmitted).toBeGreaterThan(0);
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

  it('counts unsafe entries and file-count overflow in the aggregate omitted marker', () => {
    // 1 unsafe + 33 valid → keep 32 valid, omit 2 total.
    const input = [change(''), ...Array.from({ length: 33 }, (_, i) => change(`f${i}.ts`))];
    const result = boundToolFileChanges(input);
    expect(result.fileChanges).toHaveLength(32);
    expect(result.fileChangesOmitted).toBe(2);
  });
});
