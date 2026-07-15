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
/** Workspace-relative / file: paths ending in markdown — opened as presentation tabs by the host. */
const WORKSPACE_MD_PATH = /^(?:file:\/\/\/?)?(?:\.\/)?[A-Za-z0-9_./@%+\- ]+\.(?:md|markdown|mdx)(?:[?#][^\s]*)?$/i;

/** True when href is a workspace markdown path (not http/mailto). Exported for tests. */
export function isWorkspaceMarkdownLinkHref(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || trimmed.includes('\0')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^file:/i.test(trimmed)) return false;
  return WORKSPACE_MD_PATH.test(trimmed);
}

/**
 * Bare path to a markdown file in prose (not already a markdown link).
 * Requires a path-like prefix (/, ./, file:, or drive) so plain words are not eaten.
 * Spaces in path segments are not supported for bare paths (use a markdown link).
 * Trailing punctuation such as `):` or `,` is allowed after the path (not consumed).
 */
const BARE_MD_PATH =
  /(?<!\]\()(?<!["'`=])((?:file:\/\/\/[^\s]+\.(?:md|markdown|mdx)|(?:\.\/|\/|[A-Za-z]:[\\/])[A-Za-z0-9_./@%+\-]+\.(?:md|markdown|mdx)))(?=$|[\s),.:;!?'"\]])/gi;

/**
 * Turn bare `…/plan.md` paths into markdown links so they become clickable
 * workspace-md presentation targets after sanitize.
 */
export function linkifyBareMarkdownPaths(text: string): string {
  if (!text) return text;
  return text.replace(BARE_MD_PATH, (match, path: string, offset: number, full: string) => {
    // Skip fenced code blocks (odd number of ``` before match).
    const before = full.slice(0, offset);
    const fenceCount = (before.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) return match;
    // Skip inline code spans.
    const lastBacktick = before.lastIndexOf('`');
    if (lastBacktick >= 0) {
      const afterTick = before.slice(lastBacktick + 1);
      if (!afterTick.includes('`') && full.indexOf('`', offset) >= 0) return match;
    }
    // Already part of a markdown link destination.
    if (/\]\([^)]*$/.test(before.slice(-40))) return match;
    const href = path.trim();
    if (!isWorkspaceMarkdownLinkHref(href) && !/^\/|^[A-Za-z]:[\\/]|^file:/i.test(href)) {
      return match;
    }
    // Label: basename for long absolute paths.
    const label = href.replace(/\\/g, '/').split('/').pop() || href;
    return `[${label}](${href})`;
  });
}

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
      if (raw && isWorkspaceMarkdownLinkHref(raw)) {
        // Host opens as a presentation tab (see App openLink → handleOpenLink).
        el.setAttribute('data-workspace-md-href', raw);
        el.setAttribute('href', raw);
        el.setAttribute('class', [el.getAttribute('class'), 'workspace-md-link'].filter(Boolean).join(' '));
        el.removeAttribute('target');
        el.setAttribute('rel', 'noopener');
        return;
      }
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
    'href', 'target', 'rel', 'data-external-href', 'data-workspace-md-href',
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
  const normalized = linkifyBareMarkdownPaths(raw.replace(/\r\n?/g, '\n'));
  const html = marked.parse(normalized, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
