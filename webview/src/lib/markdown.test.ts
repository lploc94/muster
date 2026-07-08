// @vitest-environment jsdom
//
// XSS regression suite for the assistant-message markdown sanitizer.
//
// The pipeline (see markdown.ts) is: marked parses the input, raw author HTML is
// escaped to visible text at the parser level, DOMPurify then enforces a strict
// tag/attribute allowlist, and an afterSanitizeAttributes hook drops any link
// whose protocol is not http/https/mailto (surviving links are re-tagged with
// data-external-href so the host opens them). This suite feeds the ACTUAL
// exported renderMarkdown() malicious inputs and asserts no executable/dangerous
// artifact materializes, while confirming legitimate markdown still renders.
//
// Environment note: jsdom (not happy-dom) — happy-dom fails to run DOMPurify's
// URI filtering, letting a `javascript:` href survive. See vitest.config.ts.

import { describe, test, expect } from 'vitest';
import { renderMarkdown } from './markdown';

/**
 * Parse sanitized output the same way the webview's `{@html}` binding would:
 * assign it to innerHTML and inspect the resulting live DOM. innerHTML never
 * executes scripts, so any <script>/<img>/on*-handler that materializes here is
 * a genuine sanitizer failure — this is the real "did it neutralize?" check.
 */
function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

/** True if any element in the tree carries an on* event-handler attribute. */
function hasEventHandlerAttr(root: HTMLElement): boolean {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) {
        return true;
      }
    }
  }
  return false;
}

const DANGEROUS_TAGS = 'script, img, iframe, object, embed, form, style, svg, link, base, meta';

/** Assert the rendered DOM contains no dangerous elements and no event handlers. */
function expectNeutralized(out: string): HTMLElement {
  const dom = parse(out);
  expect(dom.querySelectorAll(DANGEROUS_TAGS).length).toBe(0);
  expect(hasEventHandlerAttr(dom)).toBe(false);
  return dom;
}

describe('renderMarkdown — neutralizes XSS vectors', () => {
  test('<script> is escaped to inert text, not a script element', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expectNeutralized(out);
    // Raw HTML is escaped at the parser level → no live open tag survives.
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;'); // proves it became visible text
  });

  test('mixed-case <ScRiPt> is also escaped (no case-based bypass)', () => {
    const out = renderMarkdown('<ScRiPt>alert(1)</ScRiPt>');
    expectNeutralized(out);
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('&lt;ScRiPt&gt;');
  });

  test('pre-escaped &lt;script&gt; stays escaped (no double-decode into a tag)', () => {
    const out = renderMarkdown('&lt;script&gt;alert(1)&lt;/script&gt;');
    expectNeutralized(out);
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  test('<img onerror=...> yields no img element and no onerror handler', () => {
    const out = renderMarkdown('<img src=x onerror="alert(1)">');
    const dom = expectNeutralized(out);
    expect(dom.querySelector('img')).toBeNull();
    // The literal text "onerror" may appear as escaped body text, but it must
    // never be a live open tag or a real attribute.
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img'); // escaped to text
  });

  test('javascript: link has its href stripped', () => {
    const out = renderMarkdown('[x](javascript:alert(1))');
    const dom = expectNeutralized(out);
    const a = dom.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.hasAttribute('href')).toBe(false); // protocol not allowlisted
    expect(a!.hasAttribute('data-external-href')).toBe(false);
    expect(out).not.toContain('javascript:');
    expect(a!.textContent).toBe('x'); // link text is preserved
  });

  test('mixed-case JaVaScRiPt: link is stripped too', () => {
    const out = renderMarkdown('[x](JaVaScRiPt:alert(1))');
    const dom = expectNeutralized(out);
    const a = dom.querySelector('a');
    expect(a!.hasAttribute('href')).toBe(false);
    expect(out).not.toMatch(/javascript:/i);
  });

  test('data:text/html link has its href stripped', () => {
    const out = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
    const dom = expectNeutralized(out);
    const a = dom.querySelector('a');
    expect(a!.hasAttribute('href')).toBe(false);
    expect(out).not.toContain('data:text/html');
    expect(out).not.toContain('<script');
  });

  test('<iframe> is escaped, not rendered', () => {
    const out = renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expectNeutralized(out);
    expect(out).not.toContain('<iframe');
    expect(out).toContain('&lt;iframe');
  });

  test('<object> is escaped, not rendered', () => {
    const out = renderMarkdown('<object data="evil.swf"></object>');
    expectNeutralized(out);
    expect(out).not.toContain('<object');
    expect(out).toContain('&lt;object');
  });

  test('<embed> is escaped, not rendered', () => {
    const out = renderMarkdown('<embed src="evil.swf">');
    expectNeutralized(out);
    expect(out).not.toContain('<embed');
    expect(out).toContain('&lt;embed');
  });

  test('<form> is escaped, not rendered', () => {
    const out = renderMarkdown('<form action="https://evil.example"><input></form>');
    expectNeutralized(out);
    expect(out).not.toContain('<form');
    expect(out).toContain('&lt;form');
  });

  test('inline <style> is escaped, not rendered', () => {
    const out = renderMarkdown('<style>body{background:url(javascript:alert(1))}</style>');
    expectNeutralized(out);
    expect(out).not.toContain('<style');
    expect(out).toContain('&lt;style&gt;');
  });

  test('onclick on a raw <a> tag never becomes a live handler', () => {
    const out = renderMarkdown('<a href="https://ok.example" onclick="alert(1)">x</a>');
    const dom = expectNeutralized(out);
    // The whole author <a> is escaped to text, so no anchor element exists at
    // all — the tag boundaries are entities, so "onclick" is inert body text and
    // never a live attribute (already asserted by expectNeutralized above).
    expect(dom.querySelector('a')).toBeNull();
    expect(out).not.toContain('<a'); // no live anchor open tag
    expect(out).toContain('&lt;a'); // escaped to text instead
  });

  test('onmouseover on a raw <p> tag never becomes a live handler', () => {
    const out = renderMarkdown('<p onmouseover="alert(1)">hover</p>');
    expectNeutralized(out);
    expect(out).toContain('&lt;p onmouseover'); // escaped to text
  });

  test('<svg><script> payload is escaped, no svg/script elements', () => {
    const out = renderMarkdown('<svg><script>alert(1)</script></svg>');
    const dom = expectNeutralized(out);
    expect(dom.querySelector('svg')).toBeNull();
    expect(dom.querySelector('script')).toBeNull();
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<script');
  });

  test('<svg onload=...> payload is escaped, no svg element or handler', () => {
    const out = renderMarkdown('<svg onload="alert(1)"></svg>');
    const dom = expectNeutralized(out);
    expect(dom.querySelector('svg')).toBeNull();
    expect(out).not.toContain('<svg');
  });
});

describe('renderMarkdown — legitimate markdown still renders', () => {
  test('bold and italic', () => {
    const out = renderMarkdown('**bold** and _italic_');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
  });

  test('headings', () => {
    const out = renderMarkdown('# Heading');
    const dom = parse(out);
    expect(dom.querySelector('h1')?.textContent).toBe('Heading');
  });

  test('unordered lists', () => {
    const out = renderMarkdown('- a\n- b');
    const dom = parse(out);
    const items = Array.from(dom.querySelectorAll('ul > li')).map((li) => li.textContent);
    expect(items).toEqual(['a', 'b']);
  });

  test('inline code', () => {
    const out = renderMarkdown('use `const x = 1`');
    expect(out).toContain('<code>const x = 1</code>');
  });

  test('fenced code blocks (highlighted)', () => {
    const out = renderMarkdown('```js\nconst x = 1;\n```');
    const dom = parse(out);
    const code = dom.querySelector('pre.code-block > code.hljs');
    expect(code).not.toBeNull();
    expect(code!.className).toContain('language-js');
    expect(code!.textContent).toContain('const x = 1;');
  });

  test('https link renders and is routed through the host', () => {
    const out = renderMarkdown('[site](https://example.com)');
    const dom = parse(out);
    const a = dom.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://example.com');
    // Marked with the host-routing hook: allowlisted links get these markers.
    expect(a!.getAttribute('data-external-href')).toBe('https://example.com');
    expect(a!.getAttribute('target')).toBe('_blank');
    expect(a!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a!.textContent).toBe('site');
  });

  test('mailto link is allowlisted and routed through the host', () => {
    const out = renderMarkdown('[mail](mailto:a@b.com)');
    const dom = parse(out);
    const a = dom.querySelector('a');
    expect(a!.getAttribute('href')).toBe('mailto:a@b.com');
    expect(a!.getAttribute('data-external-href')).toBe('mailto:a@b.com');
  });
});
