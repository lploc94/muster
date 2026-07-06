<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import ToolCard from './ToolCard.svelte';

  const thread = $derived(threadStore.current);

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
  {#each thread.items as item (item.id)}
    {#if item.kind === 'user'}
      <MessageBubble role="user" text={item.text} />
    {:else if item.kind === 'assistant'}
      <MessageBubble role="assistant" text={item.text} />
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
    <MessageBubble role="assistant" text={thread.streaming.text} streaming />
  {/if}

  {#if thread.items.length === 0 && !thread.streaming}
    <div class="text-center mt-4" style="opacity: 0.6;">No messages yet.</div>
  {/if}
</div>