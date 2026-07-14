import { renderMarkdown } from './markdown';

export const MAX_MERMAID_DIAGRAMS = 8;
export const MAX_MERMAID_SOURCE_CHARS = 8_000;

export type MermaidFallbackReason = 'malformed' | 'oversized' | 'excess' | 'unsafe-output' | 'renderer-failure';
export interface MermaidDiagram {
  id: string;
  source: string;
  reason?: MermaidFallbackReason;
}
export interface PresentationMarkdownResult {
  html: string;
  diagrams: MermaidDiagram[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Presentation-only preprocessing. Shared chat Markdown remains unaware of Mermaid. */
export function renderPresentationMarkdown(raw: string): PresentationMarkdownResult {
  const diagrams: MermaidDiagram[] = [];
  const normalized = raw.replace(/\r\n?/g, '\n');
  const tokenized = normalized.replace(/^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (_fence, source: string) => {
    const index = diagrams.length;
    const diagram: MermaidDiagram = { id: `mermaid-${index}`, source };
    if (index >= MAX_MERMAID_DIAGRAMS) diagram.reason = 'excess';
    else if (source.length > MAX_MERMAID_SOURCE_CHARS) diagram.reason = 'oversized';
    diagrams.push(diagram);
    return `\nMUSTER_MERMAID_PLACEHOLDER_${index}_END\n`;
  });

  let html = renderMarkdown(tokenized);
  for (let index = 0; index < diagrams.length; index++) {
    const diagram = diagrams[index];
    const marker = `<p>MUSTER_MERMAID_PLACEHOLDER_${index}_END</p>`;
    const reason = diagram.reason ? ` data-mermaid-reason="${diagram.reason}"` : '';
    const placeholder = `<div class="mermaid-diagram" data-mermaid-id="${diagram.id}" data-mermaid-state="pending"${reason}><pre class="code-block"><code class="hljs language-mermaid">${escapeHtml(diagram.source)}</code></pre></div>`;
    html = html.replace(marker, placeholder);
  }
  return { html, diagrams };
}
