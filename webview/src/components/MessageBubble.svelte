<script lang="ts">
  import { tasks } from '../lib/tasks.svelte';

  interface Props {
    role: 'user' | 'assistant';
    text: string;
    streaming?: boolean;
  }
  let { role, text, streaming = false }: Props = $props();

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
    let html = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Fenced code blocks
    html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const language = lang || '';
      return `<pre class="code-block"><code class="lang-${language}">${code.trim()}</code></pre>`;
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

    // Headers
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    // Unordered lists
    html = html.replace(/^\- (.*$)/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');

    // Paragraphs and line breaks
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';

    // Clean empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p><br><\/p>/g, '');

    return html;
  }

  const backendIcon = $derived(getBackendIcon(currentBackend));
  const rendered = $derived(role === 'assistant' ? renderMarkdown(text) : text);

  let copied = $state(false);

  function copyMessage() {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      copied = true;
      setTimeout(() => { copied = false; }, 1200);
    }).catch(() => {
      // fallback
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
    <!-- Avatar + name on top -->
    <div class="flex items-center gap-1.5 mb-1">
      <div
        class="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold border"
        style="border-color: var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-editor-background);"
        title={currentBackend || 'assistant'}
      >
        {backendIcon}
      </div>
      <span class="text-[11px] opacity-70 font-medium">
        {getBackendLabel(currentBackend)}
      </span>
    </div>

    <!-- Message content (full width for CLI, no bubble limit) -->
    <div class="prose prose-sm text-sm leading-relaxed px-1 py-1">
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
    {#if !streaming}
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
