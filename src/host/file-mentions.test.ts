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

  it.each([
    [null, 'invalidPayload'],
    [Array(17).fill('a'), 'tooManyCandidates'],
    [['a', 'b'], 'multipleFiles'],
    [['https://example.test/a'], 'unsupportedScheme'],
    [['/outside/private.txt'], 'outsideWorkspace'],
    [['bad\0path'], 'malformedCandidate'],
    [[`#${'x'.repeat(5000)}\n/workspace/a.ts`], 'malformedCandidate'],
  ])('rejects unsafe input without reflecting it: %j', async (input, code) => {
    const result = await resolveDroppedFileMention(input, services());
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain('/outside/private.txt');
  });

  it('rejects folders and sanitizes filesystem failures', async () => {
    await expect(resolveDroppedFileMention(['/workspace/src'], services(vi.fn().mockResolvedValue({ type: 2 })))).resolves.toMatchObject({ ok: false, code: 'notFile' });
    await expect(resolveDroppedFileMention(['/workspace/missing'], services(vi.fn().mockRejectedValue(new Error('/secret'))))).resolves.toEqual({ ok: false, code: 'unavailable', message: 'Unable to read the dropped file.' });
  });
});
