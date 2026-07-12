import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import type { MermaidDiagram, MermaidFallbackReason } from './presentation-markdown';

export type MermaidRenderOutcome =
  | { state: 'rendered'; svg: string }
  | { state: 'fallback'; reason: MermaidFallbackReason; source: string };

const SVG_TAGS = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'clipPath', 'linearGradient', 'stop', 'title', 'desc'];
const SVG_ATTRS = ['viewBox', 'width', 'height', 'class', 'id', 'role', 'aria-label', 'aria-labelledby', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-start', 'marker-end', 'offset', 'stop-color', 'stop-opacity', 'clip-path'];

let initialized = false;
function initialize(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });
  initialized = true;
}

/** Returns null rather than attempting to repair any active SVG capability. */
export function sanitizeMermaidSvg(svg: string): string | null {
  if (/<\s*(?:script|foreignObject|a|use)\b/i.test(svg)
    || /\son[a-z]+\s*=/i.test(svg)
    || /\s(?:href|xlink:href|src)\s*=\s*["']?\s*(?:javascript:|https?:|data:)/i.test(svg)) return null;
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    ALLOWED_TAGS: SVG_TAGS,
    ALLOWED_ATTR: SVG_ATTRS,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'foreignObject', 'a', 'use', 'image', 'style'],
  });
  return /^<svg(?:\s|>)/i.test(clean.trim()) ? clean : null;
}

export async function renderMermaidDiagram(diagram: MermaidDiagram): Promise<MermaidRenderOutcome> {
  if (diagram.reason) return { state: 'fallback', reason: diagram.reason, source: diagram.source };
  try {
    initialize();
    const { svg } = await mermaid.render(`muster-${diagram.id}`, diagram.source);
    const safe = sanitizeMermaidSvg(svg);
    return safe ? { state: 'rendered', svg: safe } : { state: 'fallback', reason: 'unsafe-output', source: diagram.source };
  } catch (error) {
    const malformed = error instanceof Error && /parse|syntax|lexical/i.test(error.message);
    return { state: 'fallback', reason: malformed ? 'malformed' : 'renderer-failure', source: diagram.source };
  }
}
