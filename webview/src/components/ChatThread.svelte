<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks } from '../lib/tasks.svelte';
  import { backendIcon, backendModelLabel } from '../lib/backends';
  import MessageBubble from './MessageBubble.svelte';
  import ToolCard from './ToolCard.svelte';
  import { tip } from '../lib/tooltip';
  import {
    CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
    isNearBottom as isNearBottomMetrics,
    pinnedAfterUnlock,
    shouldAutoScrollToBottom,
  } from '../lib/chat-scroll';

  interface Props {
    /** When true, freeze transcript scrollTop (e.g. task tree panel open). */
    scrollLocked?: boolean;
  }

  let { scrollLocked = false }: Props = $props();

  const thread = $derived(threadStore.current);
  const currentBackend = $derived(tasks.focusedTask?.backend ?? 'unknown');
  const currentModel = $derived(tasks.focusedTask?.model);
  const currentBackendLabel = $derived(backendModelLabel(currentBackend, currentModel));

  const lastAssistantId = $derived(
    thread.items.filter((it) => it.kind === 'assistant').pop()?.id ?? null,
  );

  let scrollEl: HTMLDivElement | undefined = $state();
  let pinned = $state(true);
  let frozenScrollTop: number | null = $state(null);
  let wasScrollLocked = $state(false);

  function isNearBottom(el: HTMLElement): boolean {
    return isNearBottomMetrics(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
      CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
    );
  }

  function onScroll() {
    if (!scrollEl || scrollLocked) return;
    pinned = isNearBottom(scrollEl);
  }

  function scrollToBottom() {
    if (scrollEl && !scrollLocked) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      pinned = true;
    }
  }

  $effect(() => {
    if (scrollLocked) {
      if (!wasScrollLocked && scrollEl) {
        frozenScrollTop = scrollEl.scrollTop;
      }
      wasScrollLocked = true;
      if (scrollEl && frozenScrollTop !== null) {
        scrollEl.scrollTop = frozenScrollTop;
      }
      return;
    }
    if (wasScrollLocked && scrollEl && frozenScrollTop !== null) {
      scrollEl.scrollTop = frozenScrollTop;
      pinned = pinnedAfterUnlock(
        frozenScrollTop,
        scrollEl.scrollHeight,
        scrollEl.clientHeight,
      );
    }
    wasScrollLocked = false;
    frozenScrollTop = null;
  });

  $effect.pre(() => {
    void thread.items.length;
    void thread.streaming?.text;
    void thread.revision;
    if (scrollEl && !scrollLocked) pinned = isNearBottom(scrollEl);
  });

  $effect(() => {
    void thread.items.length;
    void thread.streaming?.text;
    void thread.revision;
    if (scrollEl && shouldAutoScrollToBottom(pinned, scrollLocked)) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    } else if (scrollEl && scrollLocked && frozenScrollTop !== null) {
      scrollEl.scrollTop = frozenScrollTop;
    }
  });

  // Header (backend chip + reasoning) starts a response block.
  function isBlockStart(index: number): boolean {
    const item = thread.items[index];
    if (item.kind !== 'assistant' && item.kind !== 'tool') return false;
    const prev = index > 0 ? thread.items[index - 1] : null;
    return index === 0 || prev?.kind === 'user';
  }

  function reasoningFor(turnId: string | undefined): string {
    if (!turnId) return '';
    return thread.reasoningByTurn[turnId] ?? '';
  }
</script>

<div class="relative flex-1 min-h-0 flex flex-col">
  <div
    bind:this={scrollEl}
    onscroll={onScroll}
    class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 flex flex-col gap-2"
  >
    {#each thread.items as item, i (item.id)}
      {#if isBlockStart(i)}
        {@const turnId = item.kind === 'assistant' || item.kind === 'tool' ? item.turnId : undefined}
        <div class="flex items-center gap-1.5 mb-1">
          <div
            class="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center border"
            style="border-color: var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-editor-background);"
            use:tip={currentBackendLabel}
          >
            <span class="codicon {backendIcon(currentBackend)} text-[13px]"></span>
          </div>
          <span class="text-[11px] opacity-70 font-medium">{currentBackendLabel}</span>
        </div>

        {#if reasoningFor(turnId)}
          <details class="mb-1 text-xs opacity-70">
            <summary class="cursor-pointer flex items-center gap-1">
              <span class="codicon codicon-lightbulb"></span> Thinking
            </summary>
            <div class="mt-1 pl-5 whitespace-pre-wrap">{reasoningFor(turnId)}</div>
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
      {@const lastItem = thread.items.length > 0 ? thread.items[thread.items.length - 1] : null}
      {#if lastItem?.kind === 'user' || thread.items.length === 0}
        <div class="flex items-center gap-1.5 mb-1">
          <div
            class="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center border"
            style="border-color: var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-editor-background);"
            use:tip={currentBackendLabel}
          >
            <span class="codicon {backendIcon(currentBackend)} text-[13px]"></span>
          </div>
          <span class="text-[11px] opacity-70 font-medium">{currentBackendLabel}</span>
        </div>
        {#if thread.activeTurnId && reasoningFor(thread.activeTurnId)}
          <details class="mb-1 text-xs opacity-70" open>
            <summary class="cursor-pointer flex items-center gap-1">
              <span class="codicon codicon-lightbulb"></span> Thinking
            </summary>
            <div class="mt-1 pl-5 whitespace-pre-wrap">{reasoningFor(thread.activeTurnId)}</div>
          </details>
        {/if}
      {/if}
      <MessageBubble role="assistant" text={thread.streaming.text} streaming />
    {/if}

    {#if thread.items.length === 0 && !thread.streaming}
      <div class="text-center mt-4" style="opacity: 0.6;">No messages yet.</div>
    {/if}
  </div>

  {#if !pinned}
    <button
      type="button"
      class="absolute bottom-2 right-3 icon-btn shadow"
      style="width: 30px; height: 30px; border-radius: 999px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border);"
      aria-label="Scroll to latest"
      use:tip={'Scroll to latest'}
      onclick={scrollToBottom}
    >
      <span class="codicon codicon-arrow-down"></span>
    </button>
  {/if}
</div>
