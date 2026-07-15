// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_MERMAID_DIAGRAMS, MAX_MERMAID_SOURCE_CHARS, renderPresentationMarkdown } from './presentation-markdown';

describe('presentation markdown', () => {
  it('extracts only exact mermaid fences into stable escaped placeholders', () => {
    const result = renderPresentationMarkdown('# Diagram\n```mermaid\ngraph TD\n A[<b>x</b>] --> B\n```\n```Mermaid\nnope\n```');
    expect(result.diagrams).toEqual([{ id: 'mermaid-0', source: 'graph TD\n A[<b>x</b>] --> B' }]);
    expect(result.html).toContain('data-mermaid-id="mermaid-0"');
    expect(result.html).toContain('data-mermaid-state="pending"');
    expect(result.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(result.html).toContain('language-mermaid');
  });

  it('keeps ordinary markdown behavior unchanged', () => {
    const result = renderPresentationMarkdown('```js\nconst x = 1\n```\n\n```unknown\n<x>\n```');
    expect(result.diagrams).toEqual([]);
    expect(result.html).toContain('language-js');
    expect(result.html).toContain('language-unknown');
    expect(result.html).toContain('&lt;x&gt;');
  });

  it('bounds source size and diagram count at boundary plus one', () => {
    const sources = Array.from({ length: MAX_MERMAID_DIAGRAMS + 1 }, (_, i) =>
      i === 0 ? 'x'.repeat(MAX_MERMAID_SOURCE_CHARS + 1) : `graph TD; A${i}-->B${i}`,
    );
    const result = renderPresentationMarkdown(sources.map((s) => `\`\`\`mermaid\n${s}\n\`\`\``).join('\n'));
    expect(result.diagrams[0].reason).toBe('oversized');
    expect(result.diagrams.at(-1)?.reason).toBe('excess');
    expect(result.diagrams).toHaveLength(MAX_MERMAID_DIAGRAMS + 1);
  });
});

describe('presentation TOC and code copy', () => {
  it('assigns collision-safe heading ids and toc entries', () => {
    const result = renderPresentationMarkdown('# Alpha\n\n## Beta\n\n# Alpha\n\n```js\nconst x = 1\n```\n');
    expect(result.toc.map((t) => t.id)).toEqual(['alpha', 'beta', 'alpha-2']);
    expect(result.html).toContain('id="alpha"');
    expect(result.html).toContain('id="alpha-2"');
    expect(result.html).toContain('data-code-copy');
  });

  it('decodes entities in TOC text and slug', () => {
    const result = renderPresentationMarkdown('# Research & Development\n');
    expect(result.toc[0]?.text).toBe('Research & Development');
    expect(result.toc[0]?.id).toBe('research-development');
  });
});
