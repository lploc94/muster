<script lang="ts">
  import { post } from '../lib/protocol';
  import { renderMarkdown } from '../lib/markdown';
  import { tip } from '../lib/tooltip';

  interface Props {
    role: 'user' | 'assistant';
    text: string;
    streaming?: boolean;
    showFooter?: boolean;
  }
  let { role, text, streaming = false, showFooter = true }: Props = $props();

  const rendered = $derived(role === 'assistant' && !streaming ? renderMarkdown(text) : '');

  let copied = $state(false);
  let contentEl: HTMLDivElement | undefined = $state();
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function copyMessage() {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => flashCopied(),
      () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flashCopied();
      },
    );
  }

  function flashCopied() {
    copied = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied = false;
    }, 1200);
  }

  // Inject a copy button into each code block AFTER sanitized HTML is rendered
  // (so it is not part of {@html} and cannot be stripped by DOMPurify).
  $effect(() => {
    void rendered;
    const el = contentEl;
    if (!el) return;
    el.querySelectorAll('pre.code-block').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML = '<span class="codicon codicon-copy"></span>';
      pre.appendChild(btn);
    });
  });

  // Single delegated click listener (no per-element listeners → no leak).
  $effect(() => {
    const el = contentEl;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const copyBtn = target.closest('.code-copy-btn');
      if (copyBtn && el.contains(copyBtn)) {
        e.preventDefault();
        const code = copyBtn.closest('pre.code-block')?.querySelector('code');
        if (code) {
          navigator.clipboard.writeText(code.textContent ?? '');
          const orig = copyBtn.innerHTML;
          copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
          setTimeout(() => {
            copyBtn.innerHTML = orig;
          }, 1200);
        }
        return;
      }
      const link = target.closest('a[data-external-href]');
      if (link && el.contains(link)) {
        e.preventDefault();
        const url = link.getAttribute('data-external-href');
        if (url) post({ type: 'openLink', url });
      }
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  });

  $effect(() => {
    return () => {
      if (copyTimer) clearTimeout(copyTimer);
    };
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

    {#if !streaming && showFooter}
      <div class="flex justify-start mt-1 pl-1">
        <button
          type="button"
          class="icon-btn text-xs opacity-60 hover:opacity-100"
          aria-label={copied ? 'Copied!' : 'Copy message'}
          use:tip={copied ? 'Copied!' : 'Copy message'}
          onclick={copyMessage}
        >
          <span class="codicon {copied ? 'codicon-check' : 'codicon-copy'}"></span>
        </button>
      </div>
    {/if}
  </div>
{/if}
