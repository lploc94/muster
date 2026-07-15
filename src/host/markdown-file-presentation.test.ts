import { describe, expect, it } from 'vitest';
import {
  clampPresentationMarkdown,
  isWorkspaceMarkdownHref,
  presentationIdFromRelativePath,
  resolveWorkspaceMarkdownPath,
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

  it('resolves relative path under workspace', () => {
    const t = resolveWorkspaceMarkdownPath('docs/plan.md', [root]);
    expect(t).toEqual({
      absolutePath: '/Users/me/proj/docs/plan.md',
      presentationId: presentationIdFromRelativePath('docs/plan.md'),
      title: 'plan',
    });
  });

  it('rejects path outside workspace', () => {
    expect(resolveWorkspaceMarkdownPath('/etc/passwd.md', [root])).toBeUndefined();
    expect(resolveWorkspaceMarkdownPath('../outside.md', [root])).toBeUndefined();
  });

  it('accepts absolute path inside workspace', () => {
    const t = resolveWorkspaceMarkdownPath('/Users/me/proj/docs/x.md', [root]);
    expect(t?.absolutePath).toBe('/Users/me/proj/docs/x.md');
    expect(t?.title).toBe('x');
  });
});

describe('presentationIdFromRelativePath', () => {
  it('produces stable ids', () => {
    expect(presentationIdFromRelativePath('docs/plans/foo.md')).toBe('md:docs-plans-foo.md');
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
