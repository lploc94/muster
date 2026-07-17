import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import type { MermaidDiagram, MermaidFallbackReason } from './presentation-markdown';

export type MermaidRenderOutcome =
  | { state: 'rendered'; svg: string }
  | { state: 'fallback'; reason: MermaidFallbackReason; source: string };

const SVG_TAGS = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'clipPath', 'linearGradient', 'stop', 'title', 'desc'];
const SVG_ATTRS = ['viewBox', 'width', 'height', 'class', 'id', 'role', 'aria-label', 'aria-labelledby', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-start', 'marker-end', 'offset', 'stop-color', 'stop-opacity', 'clip-path'];

let initialized = false;
let initializedTheme: 'dark' | 'default' | null = null;

function resolveMermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'default';
  const body = document.body;
  if (!body) return 'default';
  if (
    body.classList.contains('vscode-dark') ||
    body.classList.contains('vscode-high-contrast')
  ) {
    return 'dark';
  }
  return 'default';
}

function initialize(): void {
  const theme = resolveMermaidTheme();
  if (initialized && initializedTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme,
  });
  initialized = true;
  initializedTheme = theme;
}

/**
 * Expand embedded SVG <style> rules into presentation attributes so DOMPurify
 * can keep FORBID_TAGS including 'style' without black-on-black nodes/labels.
 * Browser path uses getComputedStyle; non-DOM environments leave SVG unchanged.
 */
export function inlineMermaidSvgStyles(svg: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return svg;
  }
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText =
    'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;';
  holder.innerHTML = svg;
  document.body.appendChild(holder);
  try {
    const svgEl = holder.querySelector('svg');
    if (!svgEl) return svg;
    const props = [
      'fill',
      'stroke',
      'stroke-width',
      'opacity',
      'fill-opacity',
      'font-size',
      'font-family',
      'font-weight',
      'text-anchor',
      'dominant-baseline',
      'stop-color',
      'stop-opacity',
    ];
    for (const el of Array.from(svgEl.querySelectorAll('*'))) {
      if (el.tagName.toLowerCase() === 'style') continue;
      const cs = getComputedStyle(el);
      for (const prop of props) {
        const val = cs.getPropertyValue(prop)?.trim();
        if (!val || val === 'none' || val === 'normal') continue;
        if (
          (prop === 'fill' || prop === 'stroke') &&
          (val === 'rgba(0, 0, 0, 0)' || val === 'transparent')
        ) {
          continue;
        }
        el.setAttribute(prop, val);
      }
      if (/^text|tspan$/i.test(el.tagName)) {
        const fill = el.getAttribute('fill');
        if (!fill || fill === 'none' || fill === 'currentColor') {
          const color = cs.color?.trim();
          if (color && color !== 'rgba(0, 0, 0, 0)') {
            el.setAttribute('fill', color);
          }
        }
      }
    }
    svgEl.querySelectorAll('style').forEach((node) => node.remove());
    return svgEl.outerHTML;
  } catch {
    return svg;
  } finally {
    holder.remove();
  }
}

/** Returns null rather than attempting to repair any active SVG capability. */
export function sanitizeMermaidSvg(svg: string): string | null {
  if (/<s*(?:script|foreignObject|a|use)/i.test(svg)
    || /son[a-z]+s*=/i.test(svg)
    || /s(?:href|xlink:href|src)s*=s*["']?s*(?:javascript:|https?:|data:)/i.test(svg)) return null;
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    ALLOWED_TAGS: SVG_TAGS,
    ALLOWED_ATTR: SVG_ATTRS,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'foreignObject', 'a', 'use', 'image', 'style'],
  });
  return /^<svg(?:s|>)/i.test(clean.trim()) ? clean : null;
}

export async function renderMermaidDiagram(diagram: MermaidDiagram): Promise<MermaidRenderOutcome> {
  if (diagram.reason) return { state: 'fallback', reason: diagram.reason, source: diagram.source };
  try {
    initialize();
    const { svg } = await mermaid.render(`muster-${diagram.id}`, diagram.source);
    const inlined = inlineMermaidSvgStyles(svg);
    const safe = sanitizeMermaidSvg(inlined);
    return safe ? { state: 'rendered', svg: safe } : { state: 'fallback', reason: 'unsafe-output', source: diagram.source };
  } catch (error) {
    const malformed = error instanceof Error && /parse|syntax|lexical/i.test(error.message);
    return { state: 'fallback', reason: malformed ? 'malformed' : 'renderer-failure', source: diagram.source };
  }
}
