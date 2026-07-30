import { describe, expect, it } from 'vitest';
import {
  isBoundedToolFileChange,
  stripToolFileChangeEvidenceForRetention,
} from './tool-file-change-contract';

describe('stripToolFileChangeEvidenceForRetention', () => {
  it('removes diff bytes while preserving path, change summary, and provenance markers', () => {
    const source = {
      path: 'src/app.ts',
      oldText: 'one\ntwo\n',
      newText: 'one\nthree\nfour\n',
      truncated: true as const,
      outsideWorkspace: true as const,
    };

    const stripped = stripToolFileChangeEvidenceForRetention(source);

    expect(stripped).toEqual({
      path: 'src/app.ts',
      oldText: null,
      newText: '',
      oldLineCount: 2,
      newLineCount: 3,
      retentionTruncated: true,
      truncated: true,
      outsideWorkspace: true,
    });
    expect(source).toEqual({
      path: 'src/app.ts',
      oldText: 'one\ntwo\n',
      newText: 'one\nthree\nfour\n',
      truncated: true,
      outsideWorkspace: true,
    });
    expect(isBoundedToolFileChange(stripped)).toBe(true);
  });

  it('is idempotent and retains prior summaries without reconstructing diff text', () => {
    const stripped = {
      path: 'src/new-file.ts',
      oldText: null,
      newText: '',
      oldLineCount: 0,
      newLineCount: 4,
      retentionTruncated: true as const,
    };

    expect(stripToolFileChangeEvidenceForRetention(stripped)).toEqual(stripped);
  });

  it('rejects unbounded or malformed evidence rather than producing a trusted stripped marker', () => {
    expect(
      stripToolFileChangeEvidenceForRetention({
        path: '/private/source.ts',
        oldText: 'before',
        newText: 'after',
      }),
    ).toBeUndefined();
    expect(
      stripToolFileChangeEvidenceForRetention({
        path: 'src/app.ts',
        oldText: null,
        newText: '',
        retentionTruncated: true,
        oldLineCount: -1,
        newLineCount: 0,
      }),
    ).toBeUndefined();
  });
});
