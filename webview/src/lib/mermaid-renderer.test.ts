// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { initialize, render } = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize, render } }));

import { renderMermaidDiagram, sanitizeMermaidSvg } from './mermaid-renderer';

describe('strict Mermaid renderer', () => {
  beforeEach(() => { initialize.mockClear(); render.mockReset(); });

  it('initializes strictly once and renders programmatically', async () => {
    render.mockResolvedValue({ svg: '<svg viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>' });
    const first = await renderMermaidDiagram({ id: 'mermaid-0', source: 'graph TD; A-->B' });
    const second = await renderMermaidDiagram({ id: 'mermaid-1', source: 'graph TD; B-->C' });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false }));
    expect(first.state).toBe('rendered');
    expect(second.state).toBe('rendered');
  });

  it('rejects active or externally linked SVG output', () => {
    for (const svg of [
      '<svg><script>alert(1)</script></svg>',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
      '<svg onload="x"><path/></svg>',
      '<svg><a href="javascript:x"><path/></a></svg>',
      '<svg><use href="https://evil.test/x.svg#x"/></svg>',
    ]) expect(sanitizeMermaidSvg(svg)).toBeNull();
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
    expect(await renderMermaidDiagram({ id: 'z', source: 'graph TD; A-->B' })).toEqual({ state: 'fallback', reason: 'unsafe-output', source: 'graph TD; A-->B' });
  });
});
