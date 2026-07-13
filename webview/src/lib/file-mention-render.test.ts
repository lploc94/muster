import { describe, expect, it } from 'vitest';
import { findFileMentions, renderUserTextWithMentions } from './file-mention-render';

describe('findFileMentions', () => {
  it('finds unquoted and quoted workspace mentions', () => {
    expect(findFileMentions('See @src/a.ts and @"docs/my file.md" please')).toEqual([
      { raw: '@src/a.ts', path: 'src/a.ts', index: 4, length: 9 },
      { raw: '@"docs/my file.md"', path: 'docs/my file.md', index: 18, length: 18 },
    ]);
  });

  it('ignores bare @ without a path-like token', () => {
    expect(findFileMentions('email me @ later')).toEqual([]);
  });
});

describe('renderUserTextWithMentions', () => {
  it('escapes HTML and wraps mentions in chips', () => {
    const html = renderUserTextWithMentions('Fix <b>@src/a.ts</b> and @"docs/x y.md"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('<span class="file-mention" title="src/a.ts">@src/a.ts</span>');
    expect(html).toContain(
      '<span class="file-mention" title="docs/x y.md">@&quot;docs/x y.md&quot;</span>',
    );
    expect(html).not.toContain('<b>');
  });

  it('preserves plain text segments including newlines', () => {
    expect(renderUserTextWithMentions('a\nb')).toBe('a\nb');
  });

  it('returns empty string for empty input', () => {
    expect(renderUserTextWithMentions('')).toBe('');
  });
});
