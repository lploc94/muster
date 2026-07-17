<script lang="ts">
  import { tick } from 'svelte';
  import { threadStore } from '../lib/thread.svelte';
  import { tasks } from '../lib/tasks.svelte';
  import { backendIcon, backendModelLabel } from '../lib/backends';
  import MessageBubble from './MessageBubble.svelte';
  import ToolCard from './ToolCard.svelte';
  import { tip } from '../lib/tooltip';
  import { post } from '../lib/protocol';
  import {
    CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
    CHAT_SCROLL_TOP_THRESHOLD_PX,
    capturePrependAnchor,
    decidePrependRestore,
    firstVisibleTranscriptId,
    isNearBottom as isNearBottomMetrics,
    isNearTop,
    pinnedAfterUnlock,
    restorePrependScrollTop,
    shouldAutoScrollToBottom,
    shouldLoadOlder,
    type PrependRestoreAttempt,
    type PrependScrollAnchor,
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
  let wasNearTop = $state(false);
  let restoringPrependAnchor = $state(false);
  let pendingAnchor: PrependScrollAnchor | null = $state(null);
  let pendingRestoreRequestId: string | undefined = $state(undefined);
  let pendingRestoreTaskId: string | undefined = $state(undefined);
  let restoreEpoch = 0;
  let activeRestoreAttempt: PrependRestoreAttempt | null = $state(null);
  let requestSeq = 0;

  function isNearBottom(el: HTMLElement): boolean {
    return isNearBottomMetrics(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
      CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
    );
  }

  function nextRequestId(): string {
    requestSeq += 1;
    const id = `tp-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
    return id.length <= 128 ? id : id.slice(0, 128);
  }

  function captureAnchorFromDom(taskId: string, requestId: string): PrependScrollAnchor | null {
    if (!scrollEl) return null;
    const rows = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-transcript-id]')).map(
      (el) => {
        const rect = el.getBoundingClientRect();
        const parentRect = scrollEl!.getBoundingClientRect();
        const top = rect.top - parentRect.top + scrollEl!.scrollTop;
        return {
          id: el.dataset.transcriptId ?? '',
          top,
          bottom: top + rect.height,
        };
      },
    ).filter((row) => row.id.length > 0);
    const itemId = firstVisibleTranscriptId(rows, scrollEl.scrollTop);
    const item = rows.find((row) => row.id === itemId);
    return {
      ...capturePrependAnchor({
        scrollTop: scrollEl.scrollTop,
        scrollHeight: scrollEl.scrollHeight,
        ...(itemId ? { itemId } : {}),
        ...(item ? { itemTop: item.top } : {}),
      }),
      taskId,
      requestId,
    };
  }

  function requestOlder(force = false): void {
    if (!scrollEl) {
      // Button path may still request without metrics when forced.
      if (!force) return;
    }
    const overflow = scrollEl
      ? scrollEl.scrollHeight > scrollEl.clientHeight + 1
      : false;
    const nearTop = scrollEl ? isNearTop(scrollEl.scrollTop, CHAT_SCROLL_TOP_THRESHOLD_PX) : false;
    if (
      !shouldLoadOlder({
        hasMoreBefore: thread.hasMoreBefore,
        beforeCursor: thread.beforeCursor,
        loading: thread.olderPageLoading,
        scrollLocked,
        nearTop,
        overflow,
        force,
      })
    ) {
      return;
    }
    const requestId = nextRequestId();
    const outbound = threadStore.beginLoadOlder(requestId);
    if (!outbound) return;
    // Bump epoch so any in-flight stale restore closure becomes a no-op.
    restoreEpoch += 1;
    activeRestoreAttempt = null;
    pendingAnchor = captureAnchorFromDom(outbound.taskId, outbound.requestId);
    pendingRestoreRequestId = outbound.requestId;
    pendingRestoreTaskId = outbound.taskId;
    restoringPrependAnchor = true;
    post({
      type: 'loadTranscriptPage',
      requestId: outbound.requestId,
      taskId: outbound.taskId,
      beforeCursor: outbound.beforeCursor,
    });
  }

  function onScroll() {
    if (!scrollEl) return;
    if (scrollLocked) {
      if (frozenScrollTop !== null) scrollEl.scrollTop = frozenScrollTop;
      return;
    }
    pinned = isNearBottom(scrollEl);
    const nearTop = isNearTop(scrollEl.scrollTop, CHAT_SCROLL_TOP_THRESHOLD_PX);
    // Auto-load only when the user scrolls into the top zone (edge-triggered).
    if (nearTop && !wasNearTop) {
      requestOlder(false);
    }
    wasNearTop = nearTop;
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
    if (scrollEl && !scrollLocked && !restoringPrependAnchor) {
      pinned = isNearBottom(scrollEl);
    }
  });

  $effect(() => {
    void thread.items.length;
    void thread.streaming?.text;
    void thread.revision;
    if (scrollEl && shouldAutoScrollToBottom(pinned, scrollLocked, restoringPrependAnchor)) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    } else if (scrollEl && scrollLocked && frozenScrollTop !== null) {
      scrollEl.scrollTop = frozenScrollTop;
    }
  });

  function clearPrependRestore(): void {
    restoreEpoch += 1;
    activeRestoreAttempt = null;
    pendingAnchor = null;
    pendingRestoreRequestId = undefined;
    pendingRestoreTaskId = undefined;
    restoringPrependAnchor = false;
  }

  function applyRestoreFromAnchor(anchor: PrependScrollAnchor): void {
    if (!scrollEl) return;
    let nextItemTop: number | undefined;
    if (anchor.itemId) {
      const el = scrollEl.querySelector<HTMLElement>(
        `[data-transcript-id="${CSS.escape(anchor.itemId)}"]`,
      );
      if (el) {
        const rect = el.getBoundingClientRect();
        const parentRect = scrollEl.getBoundingClientRect();
        nextItemTop = rect.top - parentRect.top + scrollEl.scrollTop;
      }
    }
    scrollEl.scrollTop = restorePrependScrollTop(anchor, {
      nextScrollHeight: scrollEl.scrollHeight,
      nextItemTop,
    });
    pinned = isNearBottom(scrollEl);
  }

  // Restore scroll position after a matching older-page prepend.
  // Capture attempt + epoch before await so focus/hydrate/new-request cancel stale closures.
  $effect(() => {
    const appliedId = thread.lastAppliedRequestId;
    const anchor = pendingAnchor;
    const expectedId = pendingRestoreRequestId;
    const expectedTaskId = pendingRestoreTaskId;
    // Track lock synchronously so unlock can re-run this effect.
    const lockedNow = scrollLocked;
    if (!appliedId || !anchor || !expectedId || !expectedTaskId || appliedId !== expectedId) {
      return;
    }
    if (lockedNow) {
      // Keep anchor + auto-bottom suppression; unlock re-runs this effect.
      return;
    }
    const attemptEpoch = restoreEpoch;
    const attempt: PrependRestoreAttempt = {
      requestId: expectedId,
      taskId: expectedTaskId,
      anchor,
      epoch: attemptEpoch,
    };
    activeRestoreAttempt = attempt;
    let cancelled = false;
    void (async () => {
      await tick();
      if (cancelled) return;
      const decision = decidePrependRestore({
        attempt,
        currentEpoch: restoreEpoch,
        currentTaskId: threadStore.currentTaskId,
        pendingRestoreRequestId,
        pendingAnchor,
        lastAppliedRequestId: thread.lastAppliedRequestId,
        scrollLocked,
      });
      if (decision === 'wait_unlock') {
        // Lock flipped during tick — keep anchor; unlock re-runs effect.
        if (activeRestoreAttempt === attempt) activeRestoreAttempt = null;
        return;
      }
      if (decision !== 'restore' || !scrollEl) {
        // Stale/cancelled: only clear if this attempt still owns the restore slot.
        // Never clear a newer request's anchor.
        if (
          activeRestoreAttempt === attempt ||
          (pendingRestoreRequestId === attempt.requestId && restoreEpoch === attemptEpoch)
        ) {
          clearPrependRestore();
        }
        return;
      }
      applyRestoreFromAnchor(anchor);
      if (
        activeRestoreAttempt === attempt ||
        (pendingRestoreRequestId === attempt.requestId && restoreEpoch === attemptEpoch)
      ) {
        clearPrependRestore();
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // Focus change drops local prepend anchor for the previous window.
  $effect(() => {
    void threadStore.currentTaskId;
    clearPrependRestore();
    wasNearTop = false;
  });

  // Same-task hydrate/reset/error invalidates the pending request without changing
  // currentTaskId. Drop the local anchor so auto-scroll is not suppressed forever.
  $effect(() => {
    const expectedId = pendingRestoreRequestId;
    if (!expectedId) return;
    const stillPending = thread.pendingRequestId === expectedId;
    const applied = thread.lastAppliedRequestId === expectedId;
    if (!stillPending && !applied) {
      clearPrependRestore();
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
    {#if thread.hasMoreBefore || thread.olderPageLoading || thread.olderPageError}
      <div class="flex flex-col items-center gap-1 py-1">
        {#if thread.olderPageLoading}
          <div class="text-[11px] opacity-70">Loading earlier messages…</div>
        {:else if thread.olderPageError}
          <button
            type="button"
            class="text-[11px] underline opacity-80"
            onclick={() => requestOlder(true)}
          >
            Retry loading earlier messages
          </button>
        {:else if thread.hasMoreBefore}
          <button
            type="button"
            class="text-[11px] underline opacity-80"
            onclick={() => requestOlder(true)}
          >
            Load earlier messages
          </button>
        {/if}
      </div>
    {/if}

    {#each thread.items as item, i (item.id)}
      <div data-transcript-id={item.id} class="flex flex-col gap-2">
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
      </div>
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
