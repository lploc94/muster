<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks } from '../lib/tasks.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import ToolCard from './ToolCard.svelte';

  const thread = $derived(threadStore.current);

  const currentBackend = $derived(tasks.focusedTask?.backend ?? 'unknown');

  const lastAssistantId = $derived(
    thread.items.filter((it) => it.kind === 'assistant').pop()?.id ?? null
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

  let scrollEl: HTMLDivElement | undefined;
  let pinned = true;
  const BOTTOM_THRESHOLD_PX = 80;

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  $effect.pre(() => {
    void thread.items.length;
    void thread.streaming?.text;
    if (scrollEl) pinned = isNearBottom(scrollEl);
  });

  $effect(() => {
    void thread.items.length;
    void thread.streaming?.text;
    if (scrollEl && pinned) scrollEl.scrollTop = scrollEl.scrollHeight;
  });
</script>

<div
  bind:this={scrollEl}
  class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 flex flex-col gap-2"
>
  {#each thread.items as item, i (item.id)}
    {@const prev = i > 0 ? thread.items[i-1] : null}
    {#if (item.kind === 'assistant' || item.kind === 'tool') && (i === 0 || prev?.kind === 'user')}
      <!-- Header for this CLI turn, once at the beginning of the response block -->
      <div class="flex items-center gap-1.5 mb-1">
        <div
          class="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold border"
          style="border-color: var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-editor-background);"
          title={currentBackend || 'assistant'}
        >
          {getBackendIcon(currentBackend)}
        </div>
        <span class="text-[11px] opacity-70 font-medium">
          {getBackendLabel(currentBackend)}
        </span>
      </div>

      {#if thread.reasoning}
        <details class="mb-1 text-xs opacity-70">
          <summary class="cursor-pointer flex items-center gap-1">
            <span class="codicon codicon-lightbulb"></span> Thinking
          </summary>
          <div class="mt-1 pl-5 whitespace-pre-wrap">{thread.reasoning}</div>
        </details>
      {/if}
    {/if}

    {#if item.kind === 'user'}
      <MessageBubble role="user" text={item.text} />
    {:else if item.kind === 'assistant'}
      <MessageBubble role="assistant" text={item.text} showFooter={item.id === lastAssistantId} />
    {:else if item.kind === 'tool'}
      <ToolCard tool={item} />
    {:else if item.kind === 'error'}
      <div
        class="rounded px-2 py-1 text-xs whitespace-pre-wrap"
        style={item.isCancellation
          ? 'color: var(--vscode-descriptionForeground);'
          : 'color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));'}
      >{item.isCancellation ? 'Cancelled' : item.message}</div>
    {/if}
  {/each}

  {#if thread.streaming}
    {@const lastItem = thread.items.length > 0 ? thread.items[thread.items.length-1] : null}
    {#if lastItem?.kind === 'user' || thread.items.length === 0}
      <!-- Header before streaming if this turn just started -->
      <div class="flex items-center gap-1.5 mb-1">
        <div
          class="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold border"
          style="border-color: var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-editor-background);"
          title={currentBackend || 'assistant'}
        >
          {getBackendIcon(currentBackend)}
        </div>
        <span class="text-[11px] opacity-70 font-medium">
          {getBackendLabel(currentBackend)}
        </span>
      </div>
    {/if}
    <MessageBubble role="assistant" text={thread.streaming.text} streaming />
  {/if}

  {#if thread.items.length === 0 && !thread.streaming}
    <div class="text-center mt-4" style="opacity: 0.6;">No messages yet.</div>
  {/if}
</div>