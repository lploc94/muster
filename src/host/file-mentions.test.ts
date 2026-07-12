import { describe, expect, it, vi } from 'vitest';
import { resolveDroppedFileMention } from './file-mentions';

type U = { scheme: string; path: string; fsPath: string };
const uri = (scheme: string, value: string): U => ({ scheme, path: value.replace(/\\/g, '/'), fsPath: value });
const folders = [{ uri: uri('file', '/workspace') }, { uri: uri('vscode-remote', '/remote/ws') }];
function services(stat = vi.fn().mockResolvedValue({ type: 1 })) {
  return {
    workspaceFolders: folders,
    parseUri: (value: string) => {
      const match = /^([a-z][\w+.-]*):\/\/(?:[^/]*)(\/.*)$/i.exec(value);
      if (!match) throw new Error('bad uri');
      return uri(match[1], decodeURIComponent(match[2]));
    },
    fileUri: (value: string) => uri('file', value),
    joinPath: (base: U, value: string) => uri(base.scheme, `${base.path}/${value}`.replace(/\/+/g, '/')),
    stat,
  };
}

describe('dropped file mention resolver', () => {
  it.each([
    [['file:///workspace/src/a%20b.ts'], 'src/a b.ts'],
    [['/workspace/src/a.ts'], 'src/a.ts'],
    [['src/a.ts'], 'src/a.ts'],
    [['# comment\r\nfile:///workspace/README.md'], 'README.md'],
    [['vscode-remote://ssh-remote+box/remote/ws/src/a.ts'], 'src/a.ts'],
  ])('resolves supported candidate %j', async (candidates, expected) => {
    await expect(resolveDroppedFileMention(candidates, services())).resolves.toEqual({ ok: true, path: expected });
  });

  it('accepts absolute paths outside the workspace', async () => {
    await expect(
      resolveDroppedFileMention(['/Users/me/Desktop/notes.md'], services()),
    ).resolves.toEqual({ ok: true, path: '/Users/me/Desktop/notes.md' });
  });

  it('collapses alternate encodings of the same file into one mention', async () => {
    await expect(
      resolveDroppedFileMention(
        ['file:///workspace/src/a.ts', '/workspace/src/a.ts', 'src/a.ts'],
        services(),
      ),
    ).resolves.toEqual({ ok: true, path: 'src/a.ts' });
  });

  it('still mentions a path when stat fails (sandbox / missing file)', async () => {
    await expect(
      resolveDroppedFileMention(
        ['/workspace/missing.ts'],
        services(vi.fn().mockRejectedValue(new Error('ENOENT'))),
      ),
    ).resolves.toEqual({ ok: true, path: 'missing.ts' });
  });

  it.each([
    [null, 'invalidPayload'],
    [Array(17).fill('a'), 'tooManyCandidates'],
    [['src/a.ts', 'src/b.ts'], 'multipleFiles'],
    [['https://example.test/a'], 'unsupportedScheme'],
    [['bad\0path'], 'malformedCandidate'],
    [[`#${'x'.repeat(5000)}\n/workspace/a.ts`], 'malformedCandidate'],
  ])('rejects unsafe input without reflecting it: %j', async (input, code) => {
    const result = await resolveDroppedFileMention(input, services());
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain('/outside/private.txt');
  });

  it('rejects folders when stat reports a directory', async () => {
    await expect(
      resolveDroppedFileMention(['/workspace/src'], services(vi.fn().mockResolvedValue({ type: 2 }))),
    ).resolves.toMatchObject({ ok: false, code: 'notFile' });
  });
});
