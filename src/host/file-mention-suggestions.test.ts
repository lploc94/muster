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

  it('rejects parentDepth other than 0 for S01 without reading the filesystem', async () => {
    const readDirectory = vi.fn();
    const result = await listFileMentionSuggestions(
      request({ parentDepth: 1 as 0 }),
      services({ readDirectory }),
    );

    expect(result).toEqual({
      ok: false,
      requestId: 'req-1',
      code: 'invalidRequest',
    });
    expect(readDirectory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(CWD);
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
