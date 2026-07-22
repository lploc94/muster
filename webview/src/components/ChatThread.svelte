<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import {
    Virtualizer,
    elementScroll,
    measureElement,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
  } from '@tanstack/svelte-virtual';
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
    isNearBottom as isNearBottomMetrics,
    pinnedAfterScroll,
    pinnedAfterUnlock,
    shouldAutoScrollToBottom,
    type PrependRestoreAttempt,
    type PrependScrollAnchor,
  } from '../lib/chat-scroll';
  import {
    CHAT_VIRTUAL_OVERSCAN,
    createTranscriptEstimateSize,
    firstVisibleVirtualItemId,
    isBlockStartAtIndex,
    lastAssistantId,
    restoreVirtualPrependOffset,
    shouldRequestOlderFromVirtualTop,
  } from '../lib/chat-virtualization';

  interface Props {
    /** When true, freeze transcript scrollTop (e.g. task tree panel open). */
    scrollLocked?: boolean;
  }

  let { scrollLocked = false }: Props = $props();

  const thread = $derived(threadStore.current);
  const currentBackend = $derived(tasks.focusedTask?.backend ?? 'unknown');
  const currentModel = $derived(tasks.focusedTask?.model);
  const currentBackendLabel = $derived(backendModelLabel(currentBackend, currentModel));
  const lastAssistantIdValue = $derived(lastAssistantId(thread.items));

  let scrollEl: HTMLDivElement | undefined = $state();
  let headerEl: HTMLDivElement | undefined = $state();
  let footerEl: HTMLDivElement | undefined = $state();
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
  let headerHeight = $state(0);
  let footerHeight = $state(0);
  let previousScrollTop = 0;

  // Non-reactive virtualizer owner (avoids $effect ↔ store feedback loops).
  let virtualizer: Virtualizer<HTMLDivElement, HTMLElement> | null = null;
  let virtualizerCleanup: (() => void) | null = null;
  let virtualizerTaskId: string | null = null;
  let lastVirtualSignature = '';
  let virtualItems = $state<VirtualItem[]>([]);
  let totalSize = $state(0);
  /** Stable measured heights by transcript id (survives virtual unmount). */
  const measuredHeightById = new Map<string, number>();
  /**
   * When true, measureElement returns frozen/estimated heights so the one-shot
   * prepend delta is stable. Independent of restore ownership so we can unfreeze,
   * remeasure, and identity-refine before clearing the pending anchor.
   */
  let freezeMeasurements = false;

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

  function refineActivePrependAnchor(): number {
    if (!scrollEl || !restoringPrependAnchor || !pendingAnchor) return 0;
    // Never fight a locked transcript scroller (task-tree panel open).
    if (scrollLocked) return Number.POSITIVE_INFINITY;
    pinned = false;
    const itemId = pendingAnchor.itemId;
    const target = pendingAnchor.itemTop ?? 0;
    if (!itemId) return 0;

    const queryAnchor = (): HTMLElement | null =>
      scrollEl!.querySelector<HTMLElement>(
        `[data-transcript-id="${CSS.escape(itemId)}"]`,
      );

    let el = queryAnchor();
    if (!el && virtualizer) {
      const index = thread.items.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        const offset = virtualizer.getOffsetForIndex(index, 'start');
        if (offset) {
          scrollEl.scrollTop = Math.max(0, offset[0] - target);
        }
        // Force layout so the virtual range updates before re-query.
        void scrollEl.offsetHeight;
        el = queryAnchor();
      }
    }
    if (!el) return Number.POSITIVE_INFINITY;

    // Pure-DOM correction: re-query after every scrollTop write because the
    // virtualizer may recycle/remount nodes when the offset changes.
    for (let i = 0; i < 8; i += 1) {
      el = queryAnchor();
      if (!el) return Number.POSITIVE_INFINITY;
      const current =
        el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
      const delta = current - target;
      if (Math.abs(delta) <= 0.5) return Math.abs(delta);
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta);
      void scrollEl.offsetHeight;
    }
    el = queryAnchor();
    if (!el) return Number.POSITIVE_INFINITY;
    const after =
      el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    return Math.abs(after - target);
  }

  function publishVirtualSnapshot(): void {
    if (!virtualizer) {
      if (virtualItems.length !== 0 || totalSize !== 0) {
        virtualItems = [];
        totalSize = 0;
        lastVirtualSignature = '';
      }
      return;
    }
    const items = virtualizer.getVirtualItems();
    const size = virtualizer.getTotalSize();
    const signature = `${size}|${items.map((row) => `${String(row.key)}:${row.start}:${row.size}`).join(',')}`;
    if (signature === lastVirtualSignature) return;
    lastVirtualSignature = signature;
    virtualItems = items;
    totalSize = size;
    // While a prepend restore is in flight, re-lock the anchor after every
    // measurement-driven range/size change (variable-height settle).
    if (restoringPrependAnchor) {
      refineActivePrependAnchor();
    }
  }

  function disposeVirtualizer(): void {
    virtualizerCleanup?.();
    virtualizerCleanup = null;
    virtualizer = null;
    virtualizerTaskId = null;
    lastVirtualSignature = '';
    virtualItems = [];
    totalSize = 0;
    measuredHeightById.clear();
    freezeMeasurements = false;
  }

  function estimateSizeForIndex(index: number): number {
    const item = thread.items[index];
    if (item) {
      const measured = measuredHeightById.get(item.id);
      if (measured && measured > 0) return measured;
    }
    return createTranscriptEstimateSize(thread.items, thread.reasoningByTurn)(index);
  }

  function createChatVirtualizer(count: number): void {
    if (!scrollEl) return;
    disposeVirtualizer();
    virtualizerTaskId = threadStore.currentTaskId;
    const instance = new Virtualizer<HTMLDivElement, HTMLElement>({
      count,
      getScrollElement: () => scrollEl ?? null,
      estimateSize: estimateSizeForIndex,
      overscan: CHAT_VIRTUAL_OVERSCAN,
      // Load chrome and streaming footer live outside the measured track.
      paddingStart: 0,
      paddingEnd: 0,
      getItemKey: (index) => thread.items[index]?.id ?? index,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      measureElement: (element, entry, v) => {
        const id = element.getAttribute('data-transcript-id') ?? '';
        const indexAttr = element.getAttribute('data-index');
        const index = indexAttr != null ? Number(indexAttr) : -1;
        // Freeze is independent of restore ownership: during the initial delta we
        // keep a stable baseline; after settle we unfreeze and remeasure while the
        // pending anchor is still refined.
        if (freezeMeasurements) {
          if (id && measuredHeightById.has(id)) return measuredHeightById.get(id)!;
          if (index >= 0) return estimateSizeForIndex(index);
          return measureElement(element, entry, v);
        }
        const raw = measureElement(element, entry, v);
        if (id && raw > 0) {
          const next = Math.round(raw);
          const prev = measuredHeightById.get(id);
          if (prev !== next) measuredHeightById.set(id, next);
          return next;
        }
        return raw;
      },
      // Prefer our id-keyed measured map via estimateSize; still allow live measure.
      useCachedMeasurements: false,
      onChange: () => {
        publishVirtualSnapshot();
      },
    });
    // Disable TanStack auto-adjust only while prepend restoration owns the anchor.
    setScrollAdjustEnabled(instance, false);
    virtualizer = instance;
    virtualizerCleanup = instance._didMount();
    instance._willUpdate();
    publishVirtualSnapshot();
  }

  function setScrollAdjustEnabled(
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
    enabled: boolean,
  ): void {
    const target = instance as Virtualizer<HTMLDivElement, HTMLElement> & {
      shouldAdjustScrollPositionOnItemSizeChange?: (() => boolean) | undefined;
    };
    if (enabled) {
      delete target.shouldAdjustScrollPositionOnItemSizeChange;
    } else {
      target.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    }
  }

  function syncVirtualizerOptions(): void {
    if (!scrollEl) return;
    const count = thread.items.length;
    const taskId = threadStore.currentTaskId;
    if (!virtualizer || virtualizerTaskId !== taskId) {
      createChatVirtualizer(count);
      return;
    }
    virtualizer.setOptions({
      ...virtualizer.options,
      count,
      getScrollElement: () => scrollEl ?? null,
      estimateSize: estimateSizeForIndex,
      overscan: CHAT_VIRTUAL_OVERSCAN,
      paddingStart: 0,
      paddingEnd: 0,
      getItemKey: (index) => thread.items[index]?.id ?? index,
      useCachedMeasurements: false,
      onChange: () => {
        publishVirtualSnapshot();
      },
    });
    // Keep auto-adjust off while a prepend restore is in flight.
    setScrollAdjustEnabled(virtualizer, !(freezeMeasurements || restoringPrependAnchor));
    virtualizer._willUpdate();
    publishVirtualSnapshot();
  }

  /** Content Y of a settled row (includes sticky header offset when present). */
  function captureAnchorFromVirtual(taskId: string, requestId: string): PrependScrollAnchor | null {
    if (!scrollEl) return null;
    // Capture the first row whose bottom is past the viewport top, including a
    // signed viewport offset (may be negative when partially clipped).
    const scrollRect = scrollEl.getBoundingClientRect();
    let itemId: string | undefined;
    let itemTop: number | undefined;
    const rows = Array.from(
      scrollEl.querySelectorAll<HTMLElement>('[data-transcript-id]'),
    );
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > scrollRect.top + 1 && row.dataset.transcriptId) {
        itemId = row.dataset.transcriptId;
        itemTop = rect.top - scrollRect.top;
        break;
      }
    }
    if (!itemId && virtualizer) {
      const vrows = virtualizer.getVirtualItems().map((row) => ({
        id: String(row.key),
        start: row.start,
        end: row.end,
      }));
      itemId = firstVisibleVirtualItemId(vrows, scrollEl.scrollTop);
      itemTop = 0;
    }
    return {
      ...capturePrependAnchor({
        scrollTop: scrollEl.scrollTop,
        scrollHeight: virtualizer?.getTotalSize() ?? scrollEl.scrollHeight,
        ...(itemId ? { itemId } : {}),
        ...(itemTop !== undefined ? { itemTop } : {}),
      }),
      taskId,
      requestId,
    };
  }

  function requestOlder(force = false): void {
    if (!scrollEl && !force) return;
    const overflow = scrollEl ? scrollEl.scrollHeight > scrollEl.clientHeight + 1 : false;
    const scrollOffset = scrollEl?.scrollTop ?? 0;
    if (
      !shouldRequestOlderFromVirtualTop({
        hasMoreBefore: thread.hasMoreBefore,
        beforeCursor: thread.beforeCursor,
        loading: thread.olderPageLoading,
        scrollLocked,
        scrollOffset,
        topThresholdPx: CHAT_SCROLL_TOP_THRESHOLD_PX,
        overflow,
        force,
      })
    ) {
      return;
    }
    const requestId = nextRequestId();
    const outbound = threadStore.beginLoadOlder(requestId);
    if (!outbound) return;
    restoreEpoch += 1;
    activeRestoreAttempt = null;
    // Loading older must never fight stick-to-bottom.
    pinned = false;
    // Seed measured heights for currently mounted rows, then freeze measurement
    // so the upcoming total-size delta is stable.
    if (virtualizer && scrollEl) {
      for (const row of Array.from(
        scrollEl.querySelectorAll<HTMLElement>('[data-transcript-id]'),
      )) {
        virtualizer.measureElement(row);
      }
      virtualizer._willUpdate();
      publishVirtualSnapshot();
    }
    freezeMeasurements = true;
    // Capture the current first-visible row and its signed viewport offset as-is.
    pendingAnchor = captureAnchorFromVirtual(outbound.taskId, outbound.requestId);
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

  function onWheel(event: WheelEvent): void {
    if (!scrollLocked && event.deltaY < 0) {
      pinned = false;
      if (scrollEl) previousScrollTop = scrollEl.scrollTop;
    }
  }

  function onScroll() {
    if (!scrollEl) return;
    if (scrollLocked) {
      if (frozenScrollTop !== null) scrollEl.scrollTop = frozenScrollTop;
      previousScrollTop = scrollEl.scrollTop;
      return;
    }
    const scrollTop = scrollEl.scrollTop;
    pinned = pinnedAfterScroll(
      pinned,
      previousScrollTop,
      scrollTop,
      scrollEl.scrollHeight,
      scrollEl.clientHeight,
    );
    previousScrollTop = scrollTop;
    const nearTop = scrollEl.scrollTop <= CHAT_SCROLL_TOP_THRESHOLD_PX;
    if (nearTop && !wasNearTop) {
      requestOlder(false);
    }
    wasNearTop = nearTop;
  }

  /** Programmatic scroll that keeps TanStack's offset in lockstep with the DOM. */
  function setScrollOffset(offset: number): void {
    if (!scrollEl) return;
    const clamped = Math.max(0, offset);
    scrollEl.scrollTop = clamped;
    virtualizer?.scrollToOffset(clamped, { behavior: 'auto' });
    publishVirtualSnapshot();
  }

  function scrollToBottom() {
    if (!scrollEl || scrollLocked) return;
    pinned = true;
    const go = (): void => {
      if (!scrollEl) return;
      // Mount the last settled row first, then pin to the full scroller end so the
      // external streaming footer (outside the virtual track) is also visible.
      if (virtualizer && thread.items.length > 0) {
        virtualizer.scrollToIndex(thread.items.length - 1, { align: 'end' });
      }
      const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      scrollEl.scrollTop = max;
      publishVirtualSnapshot();
    };
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
  }

  function scrollToStart(): void {
    if (!scrollEl || scrollLocked) return;
    pinned = false;
    restoringPrependAnchor = false;
    const go = (): void => {
      if (!scrollEl) return;
      if (virtualizer && thread.items.length > 0) {
        // Reset offset first so range math starts from the top.
        virtualizer.scrollToOffset(0, { behavior: 'auto' });
        virtualizer.scrollToIndex(0, { align: 'start' });
      }
      scrollEl.scrollTop = 0;
      publishVirtualSnapshot();
    };
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
  }

  function scrollPinnedToLatest(): void {
    if (!scrollEl || !shouldAutoScrollToBottom(pinned, scrollLocked, restoringPrependAnchor)) {
      return;
    }
    if (virtualizer && thread.items.length > 0) {
      virtualizer.scrollToIndex(thread.items.length - 1, { align: 'end' });
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
    requestAnimationFrame(() => {
      if (!scrollEl || !shouldAutoScrollToBottom(pinned, scrollLocked, restoringPrependAnchor)) {
        return;
      }
      if (virtualizer && thread.items.length > 0) {
        virtualizer.scrollToIndex(thread.items.length - 1, { align: 'end' });
      }
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
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
      pinned = pinnedAfterUnlock(frozenScrollTop, scrollEl.scrollHeight, scrollEl.clientHeight);
      // Resume a pending prepend restore that waited out the lock.
      if (restoringPrependAnchor && pendingAnchor) {
        refineActivePrependAnchor();
      }
    }
    wasScrollLocked = false;
    frozenScrollTop = null;
  });

  $effect.pre(() => {
    void thread.items.length;
    void thread.streaming?.text;
    void thread.revision;
    if (scrollEl && !scrollLocked && !restoringPrependAnchor && pinned && !isNearBottom(scrollEl)) {
      pinned = false;
    }
  });

  // Sync virtualizer when the settled list / chrome padding changes.
  $effect(() => {
    void thread.items.length;
    void thread.revision;
    void footerHeight;
    void scrollEl;
    void threadStore.currentTaskId;
    if (!scrollEl) {
      untrack(() => disposeVirtualizer());
      return;
    }
    untrack(() => {
      const wasRestoring = restoringPrependAnchor && !!pendingAnchor && !scrollLocked;
      const prevInstance = virtualizer;
      const prevCount = prevInstance?.options.count ?? 0;
      const prevTotal = prevInstance?.getTotalSize() ?? 0;
      const prevOffset = scrollEl?.scrollTop ?? 0;
      syncVirtualizerOptions();
      // When the settled list grows during a restore on the same virtualizer
      // instance, apply the total-size delta immediately (classic reverse
      // infinite scroll). Identity refine then corrects estimate→measured drift.
      if (
        wasRestoring &&
        virtualizer &&
        scrollEl &&
        prevInstance === virtualizer &&
        prevTotal > 0 &&
        thread.items.length > prevCount
      ) {
        const nextTotal = virtualizer.getTotalSize();
        const delta = nextTotal - prevTotal;
        if (delta > 0) {
          // One-shot reverse-infinite-scroll delta on the DOM scroller only.
          scrollEl.scrollTop = prevOffset + delta;
        }
        // Defer identity refine so the browser applies the new scrollTop first.
        requestAnimationFrame(() => {
          refineActivePrependAnchor();
        });
      } else if (wasRestoring) {
        refineActivePrependAnchor();
      } else if (pinned && !restoringPrependAnchor && !scrollLocked && thread.items.length > 0) {
        void tick().then(() => scrollPinnedToLatest());
      }
    });
  });

  // Streaming / revision auto-pin (does not recreate the virtualizer).
  $effect(() => {
    void thread.streaming?.text;
    void thread.revision;
    void thread.items.length;
    if (scrollEl && shouldAutoScrollToBottom(pinned, scrollLocked, restoringPrependAnchor)) {
      untrack(() => scrollPinnedToLatest());
    } else if (scrollEl && scrollLocked && frozenScrollTop !== null) {
      scrollEl.scrollTop = frozenScrollTop;
    }
  });

  // Measure loading chrome + streaming footer so padding participates in total size.
  $effect(() => {
    void thread.hasMoreBefore;
    void thread.olderPageLoading;
    void thread.olderPageError;
    void thread.streaming?.text;
    void thread.items.length;
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target === headerEl) {
                const next = Math.round(entry.contentRect.height);
                if (next !== headerHeight) headerHeight = next;
              } else if (entry.target === footerEl) {
                const next = Math.round(entry.contentRect.height);
                if (next !== footerHeight) footerHeight = next;
              }
            }
          })
        : null;
    if (headerEl) {
      ro?.observe(headerEl);
      const h = headerEl.offsetHeight;
      if (h !== headerHeight) headerHeight = h;
    }
    if (footerEl) {
      ro?.observe(footerEl);
      const h = footerEl.offsetHeight;
      if (h !== footerHeight) footerHeight = h;
    }
    return () => ro?.disconnect();
  });

  function finishPrependRestoreState(): void {
    restoreEpoch += 1;
    activeRestoreAttempt = null;
    pendingAnchor = null;
    pendingRestoreRequestId = undefined;
    pendingRestoreTaskId = undefined;
    restoringPrependAnchor = false;
    freezeMeasurements = false;
  }

  /**
   * End prepend restore ownership.
   * - Default (cancel/stale/focus): clear immediately.
   * - `{ remeasure: true }` after a successful settle: keep the anchor identity
   *   through a deferred resizeItem pass so actual heights replace frozen
   *   estimates, refine once more, then clear.
   */
  function clearPrependRestore(options?: { remeasure?: boolean }): void {
    const remeasure = options?.remeasure === true && !!pendingAnchor && restoringPrependAnchor;
    freezeMeasurements = false;
    // Seed id→height immediately for estimateSize lookups.
    if (scrollEl) {
      for (const row of Array.from(
        scrollEl.querySelectorAll<HTMLElement>('[data-transcript-id]'),
      )) {
        const id = row.getAttribute('data-transcript-id');
        if (!id) continue;
        const h = Math.round(row.getBoundingClientRect().height);
        if (h > 0) measuredHeightById.set(id, h);
      }
    }
    if (!remeasure || !virtualizer || !scrollEl) {
      finishPrependRestoreState();
      if (virtualizer) setScrollAdjustEnabled(virtualizer, true);
      return;
    }
    // Keep pendingAnchor + restoringPrependAnchor through deferred resize.
    setScrollAdjustEnabled(virtualizer, false);
    const v = virtualizer;
    const el = scrollEl;
    const epochAtSchedule = restoreEpoch;
    requestAnimationFrame(() => {
      if (virtualizer !== v || !el || restoreEpoch !== epochAtSchedule) return;
      const idToIndex = new Map(thread.items.map((it, i) => [it.id, i] as const));
      for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-id]'))) {
        const id = row.getAttribute('data-transcript-id');
        if (!id) continue;
        const h = Math.round(row.getBoundingClientRect().height);
        if (h <= 0) continue;
        measuredHeightById.set(id, h);
        const index = idToIndex.get(id);
        if (index == null) continue;
        try {
          v.resizeItem(index, h);
        } catch {
          // ignore dispose races
        }
      }
      // Correct identity offset after cache updates, then drop restore ownership.
      if (restoringPrependAnchor && pendingAnchor) {
        refineActivePrependAnchor();
      }
      finishPrependRestoreState();
      setScrollAdjustEnabled(v, true);
      publishVirtualSnapshot();
    });
  }

  function applyRestoreFromAnchor(_anchor: PrependScrollAnchor): void {
    // Identity lock on the frozen/estimate baseline after the one-shot total-size
    // delta. Measurement stays frozen until clear so RO cannot fight the lock.
    refineActivePrependAnchor();
    let frames = 0;
    const tickPlace = (): void => {
      if (scrollLocked) {
        // Keep ownership; unlock path re-runs restore.
        return;
      }
      frames += 1;
      const err = refineActivePrependAnchor();
      if (err <= 1.5) return;
      if (frames < 60) requestAnimationFrame(tickPlace);
    };
    requestAnimationFrame(() => requestAnimationFrame(tickPlace));
  }

  // Restore scroll position after a matching older-page prepend.
  $effect(() => {
    const appliedId = thread.lastAppliedRequestId;
    const anchor = pendingAnchor;
    const expectedId = pendingRestoreRequestId;
    const expectedTaskId = pendingRestoreTaskId;
    const lockedNow = scrollLocked;
    void thread.items.length;
    void totalSize;
    if (!appliedId || !anchor || !expectedId || !expectedTaskId || appliedId !== expectedId) {
      return;
    }
    if (lockedNow) return;
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
      // Ensure the virtualizer has the prepended count before measuring.
      untrack(() => syncVirtualizerOptions());
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
        if (activeRestoreAttempt === attempt) activeRestoreAttempt = null;
        return;
      }
      if (decision !== 'restore' || !scrollEl) {
        if (
          activeRestoreAttempt === attempt ||
          (pendingRestoreRequestId === attempt.requestId && restoreEpoch === attemptEpoch)
        ) {
          clearPrependRestore();
        }
        return;
      }
      if (scrollLocked) {
        // Identity still valid; unlock re-runs this effect via scrollLocked dep.
        if (activeRestoreAttempt === attempt) activeRestoreAttempt = null;
        return;
      }
      applyRestoreFromAnchor(anchor);
      // Keep auto-scroll suppressed until the anchor's viewport offset is stable
      // under variable-height ResizeObserver measurements (or we time out).
      const deadline = performance.now() + 2000;
      await new Promise<void>((resolve) => {
        const step = () => {
          if (cancelled) {
            resolve();
            return;
          }
          if (scrollLocked) {
            // Wait for unlock rather than clearing ownership.
            requestAnimationFrame(step);
            return;
          }
          const err = refineActivePrependAnchor();
          if (err <= 1.5) {
            resolve();
            return;
          }
          if (performance.now() >= deadline) {
            resolve();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      if (cancelled) return;
      if (scrollLocked) {
        // Still locked after settle loop — keep anchor for unlock restore.
        if (activeRestoreAttempt === attempt) activeRestoreAttempt = null;
        return;
      }
      if (
        activeRestoreAttempt === attempt ||
        (pendingRestoreRequestId === attempt.requestId && restoreEpoch === attemptEpoch)
      ) {
        // Successful settle: remeasure with anchor held through deferred resize.
        clearPrependRestore({ remeasure: true });
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
    untrack(() => disposeVirtualizer());
    pinned = true;
  });

  // Same-task hydrate/reset/error invalidates the pending request without changing currentTaskId.
  $effect(() => {
    const expectedId = pendingRestoreRequestId;
    if (!expectedId) return;
    const stillPending = thread.pendingRequestId === expectedId;
    const applied = thread.lastAppliedRequestId === expectedId;
    if (!stillPending && !applied) {
      clearPrependRestore();
    }
  });

  onMount(() => {
    // Test/debug hook: Playwright drives virtualizer-aligned scrolls via CustomEvent.
    function onMusterChatScroll(event: Event): void {
      const detail = (event as CustomEvent<{ to?: 'start' | 'end' | number }>).detail;
      if (!detail) return;
      if (detail.to === 'start') scrollToStart();
      else if (detail.to === 'end') scrollToBottom();
      else if (typeof detail.to === 'number' && virtualizer) {
        pinned = false;
        virtualizer.scrollToIndex(detail.to, { align: 'start' });
        const offset = virtualizer.getOffsetForIndex(detail.to, 'start');
        if (offset) setScrollOffset(offset[0]);
      }
    }
    window.addEventListener('muster-chat-scroll', onMusterChatScroll);
    return () => window.removeEventListener('muster-chat-scroll', onMusterChatScroll);
  });

  onDestroy(() => {
    disposeVirtualizer();
  });

  function reasoningFor(turnId: string | undefined): string {
    if (!turnId) return '';
    return thread.reasoningByTurn[turnId] ?? '';
  }

  function measureVirtualRow(node: HTMLElement) {
    virtualizer?.measureElement(node);
    return {
      update() {
        virtualizer?.measureElement(node);
      },
    };
  }
</script>

<div class="relative flex-1 min-h-0 flex flex-col">
  {#if thread.hasMoreBefore || thread.olderPageLoading || thread.olderPageError}
    <!-- Outside the scroller so it never participates in virtual offsets. -->
    <div
      bind:this={headerEl}
      class="flex-shrink-0 p-2 border-b"
      style="min-height: 40px; border-color: var(--vscode-panel-border);"
      data-testid="chat-thread-load-chrome"
    >
      <div class="flex flex-col items-center justify-center gap-1 py-1 min-h-[24px]">
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
    </div>
  {:else}
    <div bind:this={headerEl} class="h-0 overflow-hidden" aria-hidden="true"></div>
  {/if}

  <div
    bind:this={scrollEl}
    onscroll={onScroll}
    onwheel={onWheel}
    class="relative flex-1 min-h-0 overflow-y-auto overscroll-contain"
    data-testid="chat-thread-scroll"
  >
    <div class="relative w-full" style={`height: ${totalSize}px;`}>
      {#each virtualItems as vRow (vRow.key)}
        {@const item = thread.items[vRow.index]}
        {#if item}
          {@const blockStart = isBlockStartAtIndex(thread.items, vRow.index)}
          {@const turnId =
            item.kind === 'assistant' || item.kind === 'tool' ? item.turnId : undefined}
          <div
            data-transcript-id={item.id}
            data-index={vRow.index}
            class="absolute top-0 left-0 w-full px-2"
            style={`transform: translateY(${vRow.start}px);`}
            use:measureVirtualRow
          >
            <div class="flex flex-col gap-2 pb-2">
              {#if blockStart}
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
                <MessageBubble
                  role="assistant"
                  text={item.text}
                  showFooter={item.id === lastAssistantIdValue}
                />
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
          </div>
        {/if}
      {/each}
    </div>

    <!-- Streaming / empty state sits in normal flow after the virtual track. -->
    <div bind:this={footerEl} class="px-2 pb-2">
      {#if thread.streaming}
        {@const lastItem =
          thread.items.length > 0 ? thread.items[thread.items.length - 1] : null}
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
