// Markdown rendering + sanitization for assistant messages.
// See docs/WEBVIEW-IMPROVEMENT-PLAN.md §5.3.
//
// Security model (the webview also runs under a strict CSP as defense-in-depth):
// - Raw HTML the model/tool emits is escaped to visible text at the parser level
//   (renderer.html / codespan pass-through), so author-supplied tags never render.
// - DOMPurify sanitizes the generated HTML against a strict allowlist; script /
//   style / iframe / img are forbidden (images are stripped this pass).
// - Link protocols are allowlisted (http/https/mailto); other hrefs are dropped.
//   Surviving links are marked with data-external-href so clicks open via the host.

import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);

/** Above this size we never highlight (avoids freezing the webview). */
const MAX_HIGHLIGHT_CHARS = 20_000;
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const marked = new Marked({
  gfm: true,
  breaks: true,
});

marked.use({
  renderer: {
    // Escape any raw HTML (block or inline) to visible text — no author HTML renders.
    html(token: { text: string }): string {
      return escapeHtml(token.text);
    },
    code({ text, lang }: Tokens.Code): string {
      const language = (lang || '').trim().toLowerCase();
      const langClass = language ? ` language-${escapeHtml(language)}` : '';
      let inner: string;
      if (language && hljs.getLanguage(language) && text.length <= MAX_HIGHLIGHT_CHARS) {
        try {
          inner = hljs.highlight(text, { language }).value;
        } catch {
          inner = escapeHtml(text);
        }
      } else {
        // Explicit-language only; unknown or oversized blocks fall back to plaintext.
        inner = escapeHtml(text);
      }
      return `<pre class="code-block"><code class="hljs${langClass}">${inner}</code></pre>`;
    },
  },
});

let hookInstalled = false;
function installHook(): void {
  if (hookInstalled) {
    return;
  }
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      const el = node as HTMLElement & { href?: string };
      const raw = el.getAttribute('href');
      let ok = false;
      if (raw) {
        try {
          const proto = new URL(raw, 'https://muster.invalid/').protocol;
          ok = ALLOWED_LINK_PROTOCOLS.has(proto);
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        el.removeAttribute('href');
        return;
      }
      // Navigation is intercepted; the host opens it externally (see App/openLink).
      el.setAttribute('data-external-href', raw!);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'span', 'a', 'code', 'pre',
    'strong', 'em', 'del', 'blockquote',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'input', // GFM task-list checkboxes (disabled)
  ],
  ALLOWED_ATTR: [
    'href', 'target', 'rel', 'data-external-href',
    'class', 'data-lang',
    'type', 'checked', 'disabled', // task-list checkboxes
    'align', // table cell alignment
  ],
  FORBID_TAGS: ['img', 'script', 'style', 'iframe', 'object', 'embed', 'form'],
  ALLOW_DATA_ATTR: false,
};

/** Render markdown to sanitized HTML safe for `{@html}`. */
export function renderMarkdown(raw: string): string {
  if (!raw) {
    return '';
  }
  installHook();
  const normalized = raw.replace(/\r\n?/g, '\n');
  const html = marked.parse(normalized, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
