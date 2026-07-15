import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  FILE_MENTION_SUGGESTION_MAX_ITEMS,
  FILE_MENTION_SUGGESTION_MAX_QUERY_CHARS,
  listFileMentionSuggestions,
  type FileMentionSuggestionServices,
  type FileMentionSuggestionsRequest,
} from './file-mention-suggestions';

const CWD = path.join(path.sep, 'workspace', 'project');

function entry(
  name: string,
  kind: 'file' | 'directory',
  opts: { hidden?: boolean; symlink?: boolean } = {},
): {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
} {
  return {
    name,
    isFile: () => kind === 'file' && !opts.symlink,
    isDirectory: () => kind === 'directory' && !opts.symlink,
    isSymbolicLink: () => Boolean(opts.symlink),
  };
}

function services(
  overrides: Partial<FileMentionSuggestionServices> = {},
): FileMentionSuggestionServices {
  return {
    resolveCwd: () => CWD,
    readDirectory: vi.fn().mockResolvedValue([
      entry('src', 'directory'),
      entry('README.md', 'file'),
      entry('package.json', 'file'),
      entry('node_modules', 'directory'),
      entry('.git', 'directory'),
      entry('dist', 'directory'),
      entry('out', 'directory'),
      entry('.env', 'file'),
      entry('app.ts', 'file'),
    ]),
    ...overrides,
  };
}

function request(
  partial: Partial<FileMentionSuggestionsRequest> = {},
): FileMentionSuggestionsRequest {
  return {
    requestId: 'req-1',
    parentDepth: 0,
    relativeQuery: '',
    ...partial,
  };
}

describe('listFileMentionSuggestions', () => {
  it('lists the current directory non-recursively with directories first and relative paths only', async () => {
    const result = await listFileMentionSuggestions(request(), services());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requestId).toBe('req-1');
    expect(result.parentDepth).toBe(0);
    expect(result.relativeQuery).toBe('');
    // Directories first, then files; labels are relative only.
    expect(result.items.map((item) => item.kind)).toEqual([
      'directory',
      'file',
      'file',
      'file',
    ]);
    expect(result.items[0]).toEqual({
      id: 'dir:src',
      kind: 'directory',
      label: 'src',
      insertionPath: 'src',
    });
    const fileLabels = result.items.slice(1).map((item) => item.label);
    expect(fileLabels).toEqual(
      [...fileLabels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
    expect([...fileLabels].sort()).toEqual(['README.md', 'app.ts', 'package.json'].sort());
    for (const item of result.items) {
      expect(item.insertionPath).toBe(item.label);
      expect(item.insertionPath).not.toContain(path.sep);
      expect(item.insertionPath.startsWith('/')).toBe(false);
    }

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toMatch(/[A-Za-z]:\\/);
    expect(serialized).not.toContain('/workspace/');
  });

  it('filters by relative query prefix case-insensitively', async () => {
    const result = await listFileMentionSuggestions(
      request({ relativeQuery: 're' }),
      services(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.label)).toEqual(['README.md']);
    expect(result.relativeQuery).toBe('re');
  });

  it('filters nested relative query prefixes under the current directory only', async () => {
    const readDirectory = vi.fn().mockResolvedValue([
      entry('utils', 'directory'),
      entry('utils.ts', 'file'),
      entry('app.ts', 'file'),
    ]);

    const result = await listFileMentionSuggestions(
      request({ relativeQuery: 'u' }),
      services({ readDirectory }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.label)).toEqual(['utils', 'utils.ts']);
    expect(readDirectory).toHaveBeenCalledTimes(1);
    expect(readDirectory).toHaveBeenCalledWith(CWD);
  });

  it('uses task cwd from the injectable resolver, never a webview-supplied path', async () => {
    const taskCwd = path.join(path.sep, 'tasks', 'alpha');
    const resolveCwd = vi.fn().mockReturnValue(taskCwd);
    const readDirectory = vi.fn().mockResolvedValue([entry('note.md', 'file')]);

    const result = await listFileMentionSuggestions(
      request({ taskId: 'task-1' }),
      services({ resolveCwd, readDirectory }),
    );

    expect(resolveCwd).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(readDirectory).toHaveBeenCalledWith(taskCwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([
      {
        id: 'file:note.md',
        kind: 'file',
        label: 'note.md',
        insertionPath: 'note.md',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(taskCwd);
  });

  it('rejects parentDepth outside 0..2 without reading the filesystem', async () => {
    const readDirectory = vi.fn();
    for (const parentDepth of [-1, 3, 1.5, Number.NaN]) {
      const result = await listFileMentionSuggestions(
        request({ parentDepth }),
        services({ readDirectory }),
      );

      expect(result).toEqual({
        ok: false,
        requestId: 'req-1',
        code: 'invalidRequest',
      });
    }
    expect(readDirectory).not.toHaveBeenCalled();
    expect(JSON.stringify({ parentDepth: 3 })).not.toContain(CWD);
  });

  it('lists parent depth 1 relative to authoritative cwd with ../ insertion prefixes', async () => {
    const parentDir = path.normalize(path.join(CWD, '..'));
    const readDirectory = vi.fn().mockResolvedValue([
      entry('sibling', 'directory'),
      entry('root.md', 'file'),
      entry('node_modules', 'directory'),
    ]);

    const result = await listFileMentionSuggestions(
      request({ parentDepth: 1, relativeQuery: '' }),
      services({ readDirectory }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parentDepth).toBe(1);
    expect(readDirectory).toHaveBeenCalledWith(parentDir);
    expect(result.items).toEqual([
      {
        id: 'dir:../sibling',
        kind: 'directory',
        label: 'sibling',
        insertionPath: '../sibling',
      },
      {
        id: 'file:../root.md',
        kind: 'file',
        label: 'root.md',
        insertionPath: '../root.md',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(CWD);
    expect(JSON.stringify(result)).not.toContain(parentDir);
  });

  it('lists grandparent depth 2 and directory-refined children under that scope', async () => {
    const grandparent = path.normalize(path.join(CWD, '..', '..'));
    const libDir = path.normalize(path.join(grandparent, 'lib'));
    const readDirectory = vi.fn().mockResolvedValue([
      entry('util.ts', 'file'),
      entry('nested', 'directory'),
    ]);

    const result = await listFileMentionSuggestions(
      request({ parentDepth: 2, relativeQuery: 'lib/u' }),
      services({ readDirectory }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parentDepth).toBe(2);
    expect(result.relativeQuery).toBe('lib/u');
    expect(readDirectory).toHaveBeenCalledWith(libDir);
    expect(result.items).toEqual([
      {
        id: 'file:../../lib/util.ts',
        kind: 'file',
        label: 'util.ts',
        insertionPath: '../../lib/util.ts',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(grandparent);
  });

  it('refines nested directories under depth 0 without whole-tree enumeration', async () => {
    const srcDir = path.join(CWD, 'src');
    const readDirectory = vi.fn().mockResolvedValue([
      entry('utils', 'directory'),
      entry('app.ts', 'file'),
      entry('unused.ts', 'file'),
    ]);

    const result = await listFileMentionSuggestions(
      request({ parentDepth: 0, relativeQuery: 'src/' }),
      services({ readDirectory }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readDirectory).toHaveBeenCalledTimes(1);
    expect(readDirectory).toHaveBeenCalledWith(srcDir);
    expect(result.items.map((item) => item.insertionPath)).toEqual([
      'src/utils',
      'src/app.ts',
      'src/unused.ts',
    ]);
  });

  it('returns listingFailed without paths when an intermediate directory is a symlink escape', async () => {
    const readDirectory = vi.fn();
    const isDirectorySymlink = vi.fn(async (dirPath: string) =>
      dirPath === path.join(CWD, 'escape'),
    );

    const result = await listFileMentionSuggestions(
      request({ parentDepth: 0, relativeQuery: 'escape/x' }),
      services({ readDirectory, isDirectorySymlink }),
    );

    expect(result).toEqual({
      ok: false,
      requestId: 'req-1',
      code: 'listingFailed',
    });
    expect(readDirectory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(CWD);
    expect(JSON.stringify(result)).not.toContain('escape');
  });

  it.each([
    '../secret',
    './hidden',
    'src/../x',
    '/etc/passwd',
    'C:\\Windows',
    '\\\\server\\share',
    'a\0b',
    'a\nb',
  ])('rejects unsafe relativeQuery %j without filesystem access', async (relativeQuery) => {
    const readDirectory = vi.fn();
    const result = await listFileMentionSuggestions(
      request({ relativeQuery }),
      services({ readDirectory }),
    );

    expect(result).toEqual({
      ok: false,
      requestId: 'req-1',
      code: 'invalidRequest',
    });
    expect(readDirectory).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toContain('ENOENT');
    // Never echo the unsafe query payload back to the caller.
    if (!relativeQuery.includes('\0') && !relativeQuery.includes('\n')) {
      expect(serialized).not.toContain(relativeQuery);
    }
  });

  it('rejects oversized relative queries', async () => {
    const readDirectory = vi.fn();
    const relativeQuery = 'a'.repeat(FILE_MENTION_SUGGESTION_MAX_QUERY_CHARS + 1);
    const result = await listFileMentionSuggestions(
      request({ relativeQuery }),
      services({ readDirectory }),
    );

    expect(result).toMatchObject({ ok: false, requestId: 'req-1', code: 'invalidRequest' });
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it('rejects blank requestId and never returns absolute paths', async () => {
    const result = await listFileMentionSuggestions(
      request({ requestId: '   ' }),
      services(),
    );

    expect(result).toEqual({
      ok: false,
      requestId: '',
      code: 'invalidRequest',
    });
    expect(JSON.stringify(result)).not.toContain(CWD);
  });

  it('returns unavailable when cwd cannot be resolved', async () => {
    const result = await listFileMentionSuggestions(
      request(),
      services({ resolveCwd: () => undefined }),
    );

    expect(result).toEqual({
      ok: false,
      requestId: 'req-1',
      code: 'unavailable',
    });
  });

  it('returns listingFailed without raw filesystem errors when readdir fails', async () => {
    const readDirectory = vi.fn().mockRejectedValue(new Error(`ENOENT: ${CWD}/missing`));
    const result = await listFileMentionSuggestions(request(), services({ readDirectory }));

    expect(result).toEqual({
      ok: false,
      requestId: 'req-1',
      code: 'listingFailed',
    });
    expect(JSON.stringify(result)).not.toContain(CWD);
    expect(JSON.stringify(result)).not.toContain('ENOENT');
    expect(JSON.stringify(result)).not.toContain('missing');
  });

  it('skips symlinks and hidden/build directories', async () => {
    const readDirectory = vi.fn().mockResolvedValue([
      entry('link-dir', 'directory', { symlink: true }),
      entry('link-file', 'file', { symlink: true }),
      entry('.cache', 'directory'),
      entry('node_modules', 'directory'),
      entry('coverage', 'directory'),
      entry('build', 'directory'),
      entry('src', 'directory'),
      entry('ok.ts', 'file'),
    ]);

    const result = await listFileMentionSuggestions(request(), services({ readDirectory }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.label)).toEqual(['src', 'ok.ts']);
  });

  it(`caps results at ${FILE_MENTION_SUGGESTION_MAX_ITEMS} after sort`, async () => {
    const dirs = Array.from({ length: 60 }, (_, i) =>
      entry(`dir-${String(i).padStart(2, '0')}`, 'directory'),
    );
    const files = Array.from({ length: 30 }, (_, i) =>
      entry(`file-${String(i).padStart(2, '0')}.ts`, 'file'),
    );
    const readDirectory = vi.fn().mockResolvedValue([...files, ...dirs]);

    const result = await listFileMentionSuggestions(request(), services({ readDirectory }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(FILE_MENTION_SUGGESTION_MAX_ITEMS);
    // Directories sort before files; with 60 dirs the cap is all directories.
    expect(result.items.every((item) => item.kind === 'directory')).toBe(true);
    expect(result.items[0]?.label).toBe('dir-00');
    expect(result.items.some((item) => item.kind === 'file')).toBe(false);
  });

  it('returns empty items for a valid query with no matches', async () => {
    const result = await listFileMentionSuggestions(
      request({ relativeQuery: 'zzz' }),
      services(),
    );

    expect(result).toEqual({
      ok: true,
      requestId: 'req-1',
      parentDepth: 0,
      relativeQuery: 'zzz',
      items: [],
    });
  });
});
