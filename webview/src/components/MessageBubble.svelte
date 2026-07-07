<script lang="ts">
  import { tasks } from '../lib/tasks.svelte';
  import hljs from 'highlight.js/lib/core';

  // Register common languages to keep bundle size reasonable
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

  interface Props {
    role: 'user' | 'assistant';
    text: string;
    streaming?: boolean;
    showFooter?: boolean;
  }
  let { role, text, streaming = false, showFooter = true }: Props = $props();

  const currentBackend = $derived(
    role === 'assistant' ? (tasks.focusedTask?.backend ?? 'unknown') : null
  );

  function getBackendIcon(backend: string | null): string {
    if (!backend) return '?';
    const b = backend.toLowerCase();
    if (b.includes('claude')) return 'C';
    if (b.includes('grok')) return 'G';
    if (b.includes('kiro')) return 'K';
    if (b.includes('codex')) return 'X';
    if (b.includes('open')) return 'O';
    return '?';
  }

  function getBackendLabel(backend: string | null): string {
    if (!backend) return 'Assistant';
    const b = backend.toLowerCase();
    if (b.includes('claude')) return '[C] Claude Code CLI';
    if (b.includes('grok')) return '[G] Grok';
    if (b.includes('kiro')) return '[K] Kiro';
    if (b.includes('codex')) return '[X] Codex';
    if (b.includes('open')) return '[O] OpenCode';
    return backend;
  }

  function renderMarkdown(raw: string): string {
    if (!raw) return '';
    // Normalize newlines (some sources send \r\n)
    raw = raw.replace(/\r\n?/g, '\n');
    let html = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const codeBlocks: string[] = [];

    // Fenced code blocks first (with syntax highlighting) - use placeholder to avoid later processing
    html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const language = (lang || '').trim();
      let highlighted = code.trim();

      try {
        if (language && hljs.getLanguage(language)) {
          highlighted = hljs.highlight(highlighted, { language }).value;
        } else {
          highlighted = hljs.highlightAuto(highlighted).value;
        }
      } catch (e) {
        highlighted = code.trim();
      }

      // Preserve original newlines by keeping literal "\n" characters inside
      // <pre><code>. The .markdown-body pre / pre code rules use `white-space: pre`,
      // so line breaks render faithfully. Do NOT convert to <br>: github-markdown-css
      // has `.markdown-body code br { display: none }` which would collapse everything
      // onto a single line.
      const langClass = language ? ` language-${language}` : '';
      const codeId = 'code-' + Date.now() + Math.random().toString(36).slice(2);
      const blockHtml = `
        <div class="code-block-wrapper" data-code-id="${codeId}">
          <button class="code-copy-btn" data-code-id="${codeId}" title="Copy code">
            <span class="codicon codicon-copy"></span>
          </button>
          <pre class="code-block"><code class="hljs${langClass}" data-code-id="${codeId}">${highlighted}</code></pre>
        </div>
      `;
      const i = codeBlocks.length;
      codeBlocks.push(blockHtml);
      return `\x00CODE${i}\x00`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Headers (before lists/paragraphs)
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    // Unordered lists - better grouping
    // Match blocks of lines starting with - or *
    html = html.replace(/^([\-\*] .*(?:\n[\-\*] .*)*)/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map(line => {
          const content = line.replace(/^[\-\*] /, '');
          return `<li>${content}</li>`;
        })
        .join('');
      return `<ul>${items}</ul>`;
    });

    // Paragraphs: split on blank lines
    const parts = html.split(/\n\s*\n/);
    html = parts.map(part => {
      const trimmed = part.trim();
      // Skip if already a block element or a code-block placeholder (must not be wrapped in <p>)
      if (
        trimmed.startsWith('<ul>') ||
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<pre>') ||
        /^\x00CODE\d+\x00$/.test(trimmed)
      ) {
        return part;
      }
      // Convert single newlines to <br> inside paragraph
      const withBreaks = trimmed.replace(/\n/g, '<br>');
      return `<p>${withBreaks}</p>`;
    }).join('');

    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p><br><\/p>/g, '');

    // Restore code blocks
    html = html.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeBlocks[parseInt(i, 10)] || '');

    return html;
  }

  const backendIcon = $derived(getBackendIcon(currentBackend));
  const rendered = $derived(role === 'assistant' ? renderMarkdown(text) : text);

  let copied = $state(false);
  let contentEl: HTMLDivElement | undefined = $state();

  function copyMessage() {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      copied = true;
      setTimeout(() => { copied = false; }, 1200);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copied = true;
      setTimeout(() => { copied = false; }, 1200);
    });
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code).then(() => {
      // could add toast later
    });
  }

  $effect(() => {
    if (!contentEl) return;
    const btns = contentEl.querySelectorAll('.code-copy-btn');
    btns.forEach((btn) => {
      const handler = () => {
        const id = (btn as HTMLElement).dataset.codeId;
        if (!id) return;
        const codeEl = contentEl!.querySelector(`code[data-code-id="${id}"]`);
        if (codeEl) {
          copyCode(codeEl.textContent || '');
          // visual feedback
          const orig = btn.innerHTML;
          btn.innerHTML = '<span class="codicon codicon-check"></span>';
          setTimeout(() => { btn.innerHTML = orig; }, 1200);
        }
      };
      btn.addEventListener('click', handler);
      // cleanup
      return () => btn.removeEventListener('click', handler);
    });
  });
</script>

{#if role === 'user'}
  <div class="flex flex-col items-end">
    <div
      class="max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm"
      style="background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);"
    >
      {text}{#if streaming}<span style="opacity: 0.6;">▋</span>{/if}
    </div>
  </div>
{:else}
  <div class="w-full">
    <!-- GitHub-style Markdown via github-markdown-css -->
    <div class="markdown-body" bind:this={contentEl}>
      {#if streaming}
        <div class="streaming-content whitespace-pre-wrap break-words">
          {text}<span class="streaming-cursor" style="opacity: 0.6;">▋</span>
        </div>
      {:else}
        <div class="markdown-content">
          {@html rendered}
        </div>
      {/if}
    </div>

    <!-- Footer for CLI bubbles - always visible, left aligned -->
    {#if !streaming && showFooter}
      <div class="flex justify-start mt-1 pl-1">
        <button
          type="button"
          class="icon-btn text-xs opacity-60 hover:opacity-100"
          title={copied ? 'Copied!' : 'Copy message'}
          onclick={copyMessage}
        >
          <span class="codicon {copied ? 'codicon-check' : 'codicon-copy'}"></span>
        </button>
      </div>
    {/if}
  </div>
{/if}
