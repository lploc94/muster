<script lang="ts">
  import { post } from '../lib/protocol';
  import { renderMarkdown } from '../lib/markdown';
  import { renderUserTextWithMentions } from '../lib/file-mention-render';
  import { tip } from '../lib/tooltip';

  interface Props {
    role: 'user' | 'assistant';
    text: string;
    streaming?: boolean;
    showFooter?: boolean;
    contextUsage?: { used?: number; size?: number; compacted: boolean } | null;
    /** Basenames of images attached to this message (user role only). */
    attachments?: string[];
  }
  let {
    role,
    text,
    streaming = false,
    showFooter = true,
    contextUsage = null,
    attachments = [],
  }: Props = $props();

  function formatCompact(n: number): string {
    if (n >= 1_000_000) {
      const v = n / 1_000_000;
      const s = v >= 10 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
      return s.replace('.', ',') + 'M';
    }
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return n.toLocaleString();
  }

  const ctxInfo = $derived.by(() => {
    if (!contextUsage) return null;
    if (contextUsage.used !== undefined && contextUsage.size !== undefined && contextUsage.size > 0) {
      const used = contextUsage.used;
      const size = contextUsage.size;
      const remaining = Math.max(0, size - used);
      const pctUsed = Math.min(100, Math.max(0, Math.round((used / size) * 100)));
      const pctRemaining = 100 - pctUsed;
      return {
        used,
        size,
        remaining,
        pctUsed,
        pctRemaining,
        compacted: contextUsage.compacted,
        labelShort: `${pctUsed}% • ${formatCompact(used)}/${formatCompact(size)}${contextUsage.compacted ? ' • compacted' : ''}`,
        labelFull: `${used.toLocaleString()} / ${size.toLocaleString()} used (${pctUsed}%, ${remaining.toLocaleString()} remaining)${contextUsage.compacted ? ' (compacted)' : ''}`,
      };
    }
    if (contextUsage.compacted) {
      return {
        used: 0,
        size: 0,
        remaining: 0,
        pctUsed: 0,
        pctRemaining: 100,
        compacted: true,
        labelShort: 'compacted',
        labelFull: 'Context compacted by Codex',
      };
    }
    return null;
  });
  const circumference = 2 * Math.PI * 6; // r=6

  const rendered = $derived(role === 'assistant' && !streaming ? renderMarkdown(text) : '');
  const userHtml = $derived(role === 'user' ? renderUserTextWithMentions(text) : '');

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
      const mdLink = target.closest('a[data-workspace-md-href]');
      if (mdLink && el.contains(mdLink)) {
        e.preventDefault();
        const url = mdLink.getAttribute('data-workspace-md-href');
        if (url) post({ type: 'openLink', url });
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
    {#if attachments.length > 0}
      <div class="flex flex-wrap gap-1 mb-1 justify-end" role="list" aria-label="Attached images">
        {#each attachments as name (name)}
          <span
            class="attachment-pill inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs opacity-80"
            role="listitem"
            data-testid="attachment-pill"
            style="background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);"
          >
            <span class="codicon codicon-file-media" aria-hidden="true"></span>
            {name}
          </span>
        {/each}
      </div>
    {/if}
    <div
      class="user-message-bubble max-w-[85%] break-words rounded-lg px-3 py-2 text-sm"
      style="background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);"
    >
      {@html userHtml}{#if streaming}<span style="opacity: 0.6;">▋</span>{/if}
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
      <div class="flex items-center justify-between mt-1 pl-1 gap-2 min-w-0">
        <button
          type="button"
          class="icon-btn text-xs opacity-60 hover:opacity-100 flex-shrink-0"
          aria-label={copied ? 'Copied!' : 'Copy message'}
          use:tip={copied ? 'Copied!' : 'Copy message'}
          onclick={copyMessage}
        >
          <span class="codicon {copied ? 'codicon-check' : 'codicon-copy'}"></span>
        </button>

        {#if ctxInfo}
          <div
            class="flex items-center gap-1.5 text-[10px] opacity-60 ml-auto min-w-0"
            data-testid="context-usage"
            title={ctxInfo.labelFull + (ctxInfo.compacted ? ' (compacted)' : '')}
            use:tip={ctxInfo.labelFull + (ctxInfo.compacted ? ' (compacted)' : '')}
          >
            <!-- circular progress: only this remains visible on narrow -->
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              class="flex-shrink-0"
              aria-hidden="true"
            >
              <circle
                cx="7"
                cy="7"
                r="6"
                fill="none"
                stroke="var(--vscode-panel-border)"
                stroke-width="1.8"
                opacity="0.35"
              />
              <circle
                cx="7"
                cy="7"
                r="6"
                fill="none"
                stroke={ctxInfo.pctUsed > 80
                  ? 'var(--vscode-errorForeground)'
                  : ctxInfo.pctUsed > 60
                    ? 'var(--vscode-charts-orange, #ff8800)'
                    : 'var(--vscode-progressBar-background, #0e639c)'}
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-dasharray={`${(ctxInfo.pctUsed / 100) * circumference} ${circumference}`}
                transform="rotate(-90 7 7)"
                opacity="0.9"
              />
            </svg>
            <span class="context-inline-text truncate">
              {ctxInfo.labelShort}
            </span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Khi không đủ chỗ (sidebar hẹp) chỉ hiện vòng tròn */
  @media (max-width: 360px) {
    :global(.context-inline-text) {
      display: none;
    }
  }
</style>
