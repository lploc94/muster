import { describe, expect, it } from 'vitest';
import {
  clampPresentationMarkdown,
  isCanonicalInsideRoot,
  isWorkspaceMarkdownHref,
  presentationIdFromFolderAndRelativePath,
  resolveUnderSource,
  resolveWorkspaceMarkdownPath,
  splitMarkdownHref,
  titleFromMarkdownPath,
} from './markdown-file-presentation';
import { PRESENTATION_MARKDOWN_MAX_LENGTH } from '../task/coordinator-tools';

describe('isWorkspaceMarkdownHref', () => {
  it('accepts relative markdown paths', () => {
    expect(isWorkspaceMarkdownHref('docs/plan.md')).toBe(true);
    expect(isWorkspaceMarkdownHref('./docs/PLAN.MD')).toBe(true);
    expect(isWorkspaceMarkdownHref('a/b/c.markdown')).toBe(true);
    expect(isWorkspaceMarkdownHref('notes.mdx')).toBe(true);
  });

  it('rejects non-markdown and external schemes', () => {
    expect(isWorkspaceMarkdownHref('src/foo.ts')).toBe(false);
    expect(isWorkspaceMarkdownHref('https://example.com/a.md')).toBe(false);
    expect(isWorkspaceMarkdownHref('mailto:a@b.com')).toBe(false);
    expect(isWorkspaceMarkdownHref('javascript:alert(1)')).toBe(false);
  });
});

describe('resolveWorkspaceMarkdownPath', () => {
  const root = '/Users/me/proj';
  const folderUri = 'file:///Users/me/proj';
  const folder = { fsPath: root, uri: folderUri };

  it('resolves relative path under workspace', () => {
    const t = resolveWorkspaceMarkdownPath('docs/plan.md', [folder]);
    expect(t).toEqual({
      absolutePath: '/Users/me/proj/docs/plan.md',
      presentationId: presentationIdFromFolderAndRelativePath(folderUri, 'docs/plan.md'),
      title: 'plan',
      sourcePath: 'docs/plan.md',
      sourceFolderUri: folderUri,
    });
  });

  it('rejects path outside workspace', () => {
    expect(resolveWorkspaceMarkdownPath('/etc/passwd.md', [folder])).toBeUndefined();
    expect(resolveWorkspaceMarkdownPath('../outside.md', [folder])).toBeUndefined();
  });

  it('accepts absolute path inside workspace', () => {
    const t = resolveWorkspaceMarkdownPath('/Users/me/proj/docs/x.md', [folder]);
    expect(t?.absolutePath).toBe('/Users/me/proj/docs/x.md');
    expect(t?.title).toBe('x');
    expect(t?.sourcePath).toBe('docs/x.md');
  });

  it('gives distinct ids for a-b vs a/b and multi-root same relative path', () => {
    const a = resolveWorkspaceMarkdownPath('docs/a-b.md', [folder]);
    const b = resolveWorkspaceMarkdownPath('docs/a/b.md', [folder]);
    expect(a?.presentationId).not.toBe(b?.presentationId);
    const r1 = resolveWorkspaceMarkdownPath('notes/plan.md', [
      { fsPath: '/ws/one', uri: 'file:///ws/one' },
    ]);
    const r2 = resolveWorkspaceMarkdownPath('notes/plan.md', [
      { fsPath: '/ws/two', uri: 'file:///ws/two' },
    ]);
    expect(r1?.presentationId).not.toBe(r2?.presentationId);
    expect(r1?.sourceFolderUri).toBe('file:///ws/one');
    expect(r2?.sourceFolderUri).toBe('file:///ws/two');
  });
});

describe('titleFromMarkdownPath', () => {
  it('strips extension', () => {
    expect(titleFromMarkdownPath('docs/My Plan.md')).toBe('My Plan');
  });
});

describe('clampPresentationMarkdown', () => {
  it('clamps oversized bodies', () => {
    const big = 'x'.repeat(PRESENTATION_MARKDOWN_MAX_LENGTH + 10);
    expect(clampPresentationMarkdown(big).length).toBe(PRESENTATION_MARKDOWN_MAX_LENGTH);
  });
});


describe('resolveUnderSource and containment', () => {
  it('treats leading slash as workspace-root relative', () => {
    const r = resolveUnderSource('/docs/plan.md', 'notes/a.md', 'file:///ws', '/ws');
    expect(r?.relativePath).toBe('docs/plan.md');
    expect(r?.absolutePath.replace(/\\/g, '/')).toBe('/ws/docs/plan.md');
  });

  it('splits fragment', () => {
    expect(splitMarkdownHref('docs/a.md#sec-1')).toEqual({ path: 'docs/a.md', fragment: 'sec-1' });
  });

  it('canonical containment uses path.relative', () => {
    expect(isCanonicalInsideRoot('/ws/a.md', '/ws')).toBe(true);
    expect(isCanonicalInsideRoot('/other/a.md', '/ws')).toBe(false);
  });
});
