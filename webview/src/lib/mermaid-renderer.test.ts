// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { initialize, render } = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize, render } }));

import {
  inlineMermaidSvgStyles,
  renderMermaidDiagram,
  sanitizeMermaidSvg,
} from './mermaid-renderer';

describe('strict Mermaid renderer', () => {
  beforeEach(() => {
    initialize.mockClear();
    render.mockReset();
    document.body.className = '';
    document.body.innerHTML = '';
  });

  it('initializes strictly once and renders programmatically', async () => {
    render.mockResolvedValue({ svg: '<svg viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>' });
    const first = await renderMermaidDiagram({ id: 'mermaid-0', source: 'graph TD; A-->B' });
    const second = await renderMermaidDiagram({ id: 'mermaid-1', source: 'graph TD; B-->C' });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false }),
    );
    expect(first.state).toBe('rendered');
    expect(second.state).toBe('rendered');
  });

  it('selects mermaid dark theme for vscode-dark body class', async () => {
    document.body.classList.add('vscode-dark');
    render.mockResolvedValue({ svg: '<svg viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>' });
    await renderMermaidDiagram({ id: 'mermaid-theme', source: 'graph TD; A-->B' });
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('keeps ordinary attributed SVG after sanitize (regression for stripped \s)', () => {
    const svg =
      '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><g class="node"><rect fill="#252526" stroke="#007fd4"/><text fill="#d4d4d4">A</text></g></svg>';
    const clean = sanitizeMermaidSvg(svg);
    expect(clean).not.toBeNull();
    expect(clean!).toMatch(/^<svg[\s>]/i);
    expect(clean!).toContain('fill="#252526"');
    expect(clean!).toContain('>A</text>');
  });

  it('rejects active or externally linked SVG output', () => {
    for (const svg of [
      '<svg><script>alert(1)</script></svg>',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
      '<svg onload="x"><path/></svg>',
      '<svg><a href="javascript:x"><path/></a></svg>',
      '<svg><use href="https://evil.test/x.svg#x"/></svg>',
    ])
      expect(sanitizeMermaidSvg(svg)).toBeNull();
  });

  it('inlines computed presentation attrs and drops style tags before sanitize', async () => {
    const styled = [
      '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
      '<style>.n{fill:#252526;stroke:#007fd4}.l{fill:#d4d4d4;color:#d4d4d4}</style>',
      '<g class="node"><rect class="n" width="10" height="8"/><text class="l" x="2" y="6">Start</text></g>',
      '</svg>',
    ].join('');
    const inlined = inlineMermaidSvgStyles(styled);
    expect(inlined).not.toMatch(/<style/i);
    expect(inlined.toLowerCase()).toMatch(/fill=/);
    const safe = sanitizeMermaidSvg(inlined);
    expect(safe).not.toBeNull();
    expect(safe!).not.toMatch(/<style/i);
    expect(safe!.toLowerCase()).toMatch(/fill=/);

    render.mockResolvedValue({ svg: styled });
    document.body.classList.add('vscode-dark');
    const outcome = await renderMermaidDiagram({ id: 'inline-0', source: 'graph TD; A-->B' });
    expect(outcome.state).toBe('rendered');
    if (outcome.state === 'rendered') {
      expect(outcome.svg).not.toMatch(/<style/i);
      expect(outcome.svg.toLowerCase()).toMatch(/fill=/);
    }
  });

  it('returns reason-coded readable fallbacks for bounds and renderer failures', async () => {
    expect(await renderMermaidDiagram({ id: 'x', source: 'a', reason: 'oversized' })).toEqual({
      state: 'fallback',
      reason: 'oversized',
      source: 'a',
    });
    render.mockRejectedValueOnce(new Error('parse detail with hostile source'));
    const failed = await renderMermaidDiagram({ id: 'y', source: '<script>x</script>' });
    expect(failed).toEqual({ state: 'fallback', reason: 'malformed', source: '<script>x</script>' });
  });

  it('classifies unsafe renderer output locally', async () => {
    render.mockResolvedValue({ svg: '<svg><script>x</script></svg>' });
    expect(await renderMermaidDiagram({ id: 'z', source: 'graph TD; A-->B' })).toEqual({
      state: 'fallback',
      reason: 'unsafe-output',
      source: 'graph TD; A-->B',
    });
  });
});
