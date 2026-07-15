import { renderMarkdown } from './markdown';

export const MAX_MERMAID_DIAGRAMS = 8;
export const MAX_MERMAID_SOURCE_CHARS = 8_000;

export type MermaidFallbackReason =
  | 'malformed'
  | 'oversized'
  | 'excess'
  | 'unsafe-output'
  | 'renderer-failure';
export interface MermaidDiagram {
  id: string;
  source: string;
  reason?: MermaidFallbackReason;
}
export interface PresentationTocEntry {
  id: string;
  level: 1 | 2 | 3;
  text: string;
}
export interface PresentationMarkdownResult {
  html: string;
  diagrams: MermaidDiagram[];
  toc: PresentationTocEntry[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(html: string): string {
  if (typeof document !== 'undefined') {
    const el = document.createElement('textarea');
    el.innerHTML = html;
    return el.value;
  }
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

/** Add heading ids + TOC + code-copy wrappers after sanitized markdown. */
export function enhancePresentationHtml(html: string): {
  html: string;
  toc: PresentationTocEntry[];
} {
  const used = new Map<string, number>();
  const toc: PresentationTocEntry[] = [];
  let next = html.replace(/<h([1-3])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_m, levelStr, attrs, inner) => {
    const level = Number(levelStr) as 1 | 2 | 3;
    const text = stripTags(inner);
    let id = slugify(text);
    const count = (used.get(id) ?? 0) + 1;
    used.set(id, count);
    if (count > 1) id = `${id}-${count}`;
    toc.push({ id, level, text });
    const extra = attrs && !/\sid=/.test(attrs) ? attrs : attrs || '';
    return `<h${level}${extra} id="${escapeHtml(id)}">${inner}</h${level}>`;
  });

  // Wrap fenced code blocks (not already wrapped) with a copy control.
  next = next.replace(
    /<pre class="code-block">([\s\S]*?)<\/pre>/g,
    (_m, inner) =>
      `<div class="code-block-wrap"><button type="button" class="code-copy-btn" data-code-copy aria-label="Copy code">Copy</button><pre class="code-block">${inner}</pre></div>`,
  );

  return { html: next, toc };
}

/** Presentation-only preprocessing. Shared chat Markdown remains unaware of Mermaid. */
export function renderPresentationMarkdown(raw: string): PresentationMarkdownResult {
  const diagrams: MermaidDiagram[] = [];
  const normalized = raw.replace(/\r\n?/g, '\n');
  const tokenized = normalized.replace(
    /^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm,
    (_fence, source: string) => {
      const index = diagrams.length;
      const diagram: MermaidDiagram = { id: `mermaid-${index}`, source };
      if (index >= MAX_MERMAID_DIAGRAMS) diagram.reason = 'excess';
      else if (source.length > MAX_MERMAID_SOURCE_CHARS) diagram.reason = 'oversized';
      diagrams.push(diagram);
      return `\nMUSTER_MERMAID_PLACEHOLDER_${index}_END\n`;
    },
  );

  let html = renderMarkdown(tokenized);
  for (let index = 0; index < diagrams.length; index++) {
    const diagram = diagrams[index];
    const marker = `<p>MUSTER_MERMAID_PLACEHOLDER_${index}_END</p>`;
    const reason = diagram.reason ? ` data-mermaid-reason="${diagram.reason}"` : '';
    const placeholder = `<div class="mermaid-diagram" data-mermaid-id="${diagram.id}" data-mermaid-state="pending"${reason}><pre class="code-block"><code class="hljs language-mermaid">${escapeHtml(diagram.source)}</code></pre></div>`;
    html = html.replace(marker, placeholder);
  }
  const enhanced = enhancePresentationHtml(html);
  return { html: enhanced.html, diagrams, toc: enhanced.toc };
}
