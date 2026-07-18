<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    Virtualizer,
    elementScroll,
    measureElement,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
  } from '@tanstack/svelte-virtual';
  import ChatThread from './ChatThread.svelte';
  import Composer from './Composer.svelte';
  import AskCard from './AskCard.svelte';
  import { tasks } from '../lib/tasks.svelte';
  import { threadStore } from '../lib/thread.svelte';
  import { effectiveRuntimeActivity, post } from '../lib/protocol';
  import {
    getLifecyclePresentation,
    getTaskPresentation,
  } from '../lib/task-status';
  import type { PendingAsk, TaskLifecycleState } from '../lib/protocol';
  import { buildDeleteQueuedTurnMessage, queuedTurnControlState } from '../lib/queued-turns';
  import { selectTask as navSelectTask } from '../lib/task-nav';
  import {
    breadcrumbPath,
    buildTaskTree,
    defaultCollapsedIds,
    expandPathInCollapsed,
    flattenTaskTreeCollapsible,
    taskRoleIcon,
    type TaskTreeNode,
  } from '../lib/task-tree';
  import { tip } from '../lib/tooltip';

  /** Fixed estimate for a compact tree row (matches min-height + padding). */
  const TREE_ROW_ESTIMATE_PX = 32;
  const TREE_VIRTUAL_OVERSCAN = 12;

  interface Props {
    pendingAsk: PendingAsk | null;
    activeTurnId: string | null;
    submissionError?: string;
    submissionVersion?: number;
  }

  let { pendingAsk = null, activeTurnId = null, submissionError, submissionVersion = 0 }: Props = $props();

  let retryInstruction = $state('');
  let continueMessage = $state('');
  /** The task whose inline lifecycle menu is open. */
  let statusMenuTaskId = $state<string | null>(null);
  let taskChromeRegion = $state<HTMLElement | undefined>(undefined);
  /** Collapsed = selected task is the header; expanded = owning-root tree. */
  let treeExpanded = $state(false);
  /** User overrides for twistie collapse; null = use defaultCollapsedIds. */
  let collapsedOverride = $state<Set<string> | null>(null);
  let treeScrollEl: HTMLDivElement | undefined = $state();
  let treeVirtualizer: Virtualizer<HTMLDivElement, HTMLElement> | null = null;
  let treeVirtualizerCleanup: (() => void) | null = null;
  let treeVirtualItems = $state<VirtualItem[]>([]);
  let treeTotalSize = $state(0);
  let lastTreeSignature = '';

  const focused = $derived(tasks.focusedTask);
  /** Navigation may move optimistically; transcript focus remains snapshot-atomic. */
  const navigationTask = $derived(
    (tasks.pendingFocusTaskId ? tasks.tasks.get(tasks.pendingFocusTaskId) : undefined) ?? focused,
  );
  const thread = $derived(threadStore.current);
  const presentation = $derived(focused ? getTaskPresentation(focused) : null);
  const runtime = $derived(focused ? effectiveRuntimeActivity(focused) : null);
  const treeForest = $derived(buildTaskTree(tasks.subtree));
  const focusedPath = $derived(
    focused ? breadcrumbPath(focused, tasks.subtree) : [],
  );
  const collapsedIds = $derived.by(() => {
    if (collapsedOverride) return collapsedOverride;
    const base = defaultCollapsedIds(treeForest, 2);
    return focused ? expandPathInCollapsed(base, focusedPath) : base;
  });
  const treeRows = $derived(flattenTaskTreeCollapsible(treeForest, collapsedIds));
  const visibleTreeRows = $derived.by(() => {
    if (treeExpanded) return treeRows;
    if (!navigationTask) return [];
    // The collapsed chrome is sourced from focus, never from the flattened tree.
    // That matters when a child is selected while its owning root remains row 0.
    return [{ task: navigationTask, depth: 0, children: [] as TaskTreeNode[] }];
  });

  function publishTreeSnapshot(): void {
    if (!treeVirtualizer) {
      treeVirtualItems = [];
      treeTotalSize = 0;
      lastTreeSignature = '';
      return;
    }
    const items = treeVirtualizer.getVirtualItems();
    const size = treeVirtualizer.getTotalSize();
    const signature = `${size}|${items.map((r) => `${String(r.key)}:${r.start}:${r.size}`).join(',')}`;
    if (signature === lastTreeSignature) return;
    lastTreeSignature = signature;
    treeVirtualItems = items;
    treeTotalSize = size;
    // Close status menu if its row left the mounted window (prevents recycled identity leak).
    if (statusMenuTaskId) {
      const mounted = new Set(items.map((r) => String(r.key)));
      if (!mounted.has(statusMenuTaskId)) statusMenuTaskId = null;
    }
  }

  function disposeTreeVirtualizer(): void {
    treeVirtualizerCleanup?.();
    treeVirtualizerCleanup = null;
    treeVirtualizer = null;
    treeVirtualItems = [];
    treeTotalSize = 0;
    lastTreeSignature = '';
  }

  function captureTreeScrollAnchor(): { taskId: string; offset: number } | null {
    if (!treeScrollEl || !treeVirtualizer) return null;
    const items = treeVirtualizer.getVirtualItems();
    if (items.length === 0) return null;
    const scrollTop = treeScrollEl.scrollTop;
    // First row whose bottom is past the viewport top.
    const first = items.find((it) => it.start + it.size > scrollTop) ?? items[0];
    if (!first) return null;
    return { taskId: String(first.key), offset: scrollTop - first.start };
  }

  function restoreTreeScrollAnchor(anchor: { taskId: string; offset: number } | null): void {
    if (!anchor || !treeScrollEl || !treeVirtualizer) return;
    const index = treeRows.findIndex((row) => row.task.id === anchor.taskId);
    if (index < 0) return;
    const offsetPair = treeVirtualizer.getOffsetForIndex(index, 'start');
    const start = offsetPair?.[0] ?? index * TREE_ROW_ESTIMATE_PX;
    treeScrollEl.scrollTop = Math.max(0, start + anchor.offset);
  }

  function syncTreeVirtualizer(count: number): void {
    if (!treeScrollEl || !treeExpanded) {
      disposeTreeVirtualizer();
      return;
    }
    if (!treeVirtualizer) {
      const instance = new Virtualizer<HTMLDivElement, HTMLElement>({
        count,
        getScrollElement: () => treeScrollEl ?? null,
        estimateSize: () => TREE_ROW_ESTIMATE_PX,
        overscan: TREE_VIRTUAL_OVERSCAN,
        getItemKey: (index) => treeRows[index]?.task.id ?? index,
        observeElementRect,
        observeElementOffset,
        scrollToFn: elementScroll,
        measureElement,
        useCachedMeasurements: false,
        onChange: () => publishTreeSnapshot(),
      });
      treeVirtualizer = instance;
      treeVirtualizerCleanup = instance._didMount();
      instance._willUpdate();
      publishTreeSnapshot();
      return;
    }
    // Preserve first-visible task identity + offset across count/key changes
    // (patch-before-viewport / collapse) so scrollTop alone does not jump rows.
    const anchor = captureTreeScrollAnchor();
    treeVirtualizer.setOptions({
      ...treeVirtualizer.options,
      count,
      getScrollElement: () => treeScrollEl ?? null,
      estimateSize: () => TREE_ROW_ESTIMATE_PX,
      overscan: TREE_VIRTUAL_OVERSCAN,
      getItemKey: (index) => treeRows[index]?.task.id ?? index,
      onChange: () => publishTreeSnapshot(),
    });
    treeVirtualizer._willUpdate();
    restoreTreeScrollAnchor(anchor);
    publishTreeSnapshot();
  }

  function measureTreeRow(node: HTMLElement) {
    treeVirtualizer?.measureElement(node);
    return {
      update() {
        treeVirtualizer?.measureElement(node);
      },
    };
  }

  // Keep the expanded tree virtualizer aligned with flattened row count.
  $effect(() => {
    void treeExpanded;
    void treeRows.length;
    void treeScrollEl;
    void statusMenuTaskId;
    if (!treeExpanded) {
      disposeTreeVirtualizer();
      return;
    }
    syncTreeVirtualizer(treeRows.length);
  });

  // Scroll focused/pending navigation into view when the expanded tree changes.
  $effect(() => {
    if (!treeExpanded || !treeVirtualizer) return;
    const targetId = navigationTask?.id;
    if (!targetId) return;
    const index = treeRows.findIndex((row) => row.task.id === targetId);
    if (index < 0) return;
    treeVirtualizer.scrollToIndex(index, { align: 'auto' });
    publishTreeSnapshot();
  });

  onDestroy(() => {
    disposeTreeVirtualizer();
  });

  function statusButtonTip(task: NonNullable<typeof focused>): string {
    const taskPresentation = getTaskPresentation(task);
    const taskRuntime = effectiveRuntimeActivity(task);
    const parts = [
      taskPresentation.lifecycle.workspaceHeadline,
      taskPresentation.lifecycle.workspaceDetail,
    ].filter(Boolean);
    if (taskRuntime !== 'idle' && task.lifecycle === 'open' && taskPresentation.runtime) {
      parts.push(`Orchestration: ${taskPresentation.runtime.label}`);
    }
    if (task.hasOutcomeProposal && task.lifecycle === 'open') {
      parts.push('Agent proposed done — task stays open; chat to continue.');
    }
    if (task.continuationOf) parts.push('Continuation of prior task');
    parts.push('Click to change status.');
    return parts.join(' ');
  }
  /** Preview source: thread user bubbles keyed by message id (host transcript projection). */
  const queuedTurnControls = $derived(
    tasks.queuedTurns.map((turn) =>
      queuedTurnControlState(turn, thread.items, tasks.queuedTurns),
    ),
  );

  type LifecycleAction = {
    lifecycle: TaskLifecycleState;
    label: string;
    description: string;
  };

  function lifecycleActions(current: TaskLifecycleState | string): LifecycleAction[] {
    const actions: LifecycleAction[] = [];
    if (current === 'open') {
      actions.push(
        { lifecycle: 'succeeded', label: 'Mark done', description: 'Seal task as succeeded' },
        { lifecycle: 'failed', label: 'Mark failed', description: 'Soft-fail; can reopen later' },
        { lifecycle: 'cancelled', label: 'Cancel task', description: 'Cancel this task and children' },
        { lifecycle: 'skipped', label: 'Skip', description: 'Won’t perform this task' },
      );
    } else if (current === 'failed') {
      actions.push(
        { lifecycle: 'open', label: 'Reopen', description: 'Continue on the same task' },
        { lifecycle: 'succeeded', label: 'Mark done', description: 'Seal as succeeded' },
        { lifecycle: 'cancelled', label: 'Cancel task', description: 'Cancel this task and children' },
        { lifecycle: 'skipped', label: 'Skip', description: 'Won’t perform' },
      );
    } else if (
      current === 'succeeded' ||
      current === 'cancelled' ||
      current === 'skipped'
    ) {
      // Hard terminal: reopen same task id, or user creates a new task separately.
      actions.push({
        lifecycle: 'open',
        label: 'Reopen',
        description: 'Open this task again and continue on the same id',
      });
    }
    return actions;
  }

  function setLifecycle(taskId: string, lifecycle: TaskLifecycleState) {
    statusMenuTaskId = null;
    post({ type: 'setTaskLifecycle', taskId, lifecycle });
  }

  $effect(() => {
    if (!statusMenuTaskId) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && taskChromeRegion?.contains(target)) return;
      statusMenuTaskId = null;
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  // Reset twistie overrides when the focused task identity changes.
  $effect(() => {
    void focused?.id;
    collapsedOverride = null;
    statusMenuTaskId = null;
  });

  $effect(() => {
    if (!tasks.draftMode) return;
    treeExpanded = false;
  });

  $effect(() => {
    if (!treeExpanded) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      treeExpanded = false;
      statusMenuTaskId = null;
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function toggleCollapse(taskId: string, hasChildren: boolean) {
    if (!hasChildren) return;
    const next = new Set<string>(collapsedIds);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    collapsedOverride = next;
  }

  function activateTreeNode(taskId: string) {
    if (taskId === navigationTask?.id) {
      toggleTreeChrome();
      return;
    }
    navSelectTask(taskId);
  }

  function toggleTreeChrome(): void {
    treeExpanded = !treeExpanded;
    statusMenuTaskId = null;
  }

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    if (trimmed.length <= 48) return trimmed || '(no goal)';
    return `${trimmed.slice(0, 45)}…`;
  }

  function lifecycleClass(lifecycle: string): string {
    return `task-status task-status--${getLifecyclePresentation(lifecycle).tone}`;
  }

  function lifecycleIcon(lifecycle: string): string {
    switch (lifecycle) {
      case 'succeeded':
        return 'codicon-pass-filled';
      case 'failed':
        return 'codicon-error';
      case 'cancelled':
        return 'codicon-circle-slash';
      case 'skipped':
        return 'codicon-debug-step-over';
      default:
        return 'codicon-circle-large-outline';
    }
  }

  const showResume = $derived(
    !!focused &&
      focused.lifecycle === 'open' &&
      !!activeTurnId &&
      (runtime === 'queued' || runtime === 'waiting_dependencies'),
  );
  const showFailedTurnCard = $derived(
    !!focused &&
      focused.lifecycle === 'open' &&
      focused.currentTurnActivity?.state === 'failed_turn',
  );
  const showUncertainCard = $derived(
    !!focused &&
      focused.lifecycle === 'open' &&
      focused.currentTurnActivity?.state === 'uncertain',
  );
  const recoveryTurnId = $derived(
    focused?.currentTurnActivity &&
      (focused.currentTurnActivity.state === 'failed_turn' ||
        focused.currentTurnActivity.state === 'uncertain')
      ? focused.currentTurnActivity.turnId
      : activeTurnId,
  );
  /** Sealed task: composer stays enabled; hint that send (or Reopen) restores open. */
  const showTerminalReopenHint = $derived(
    !!focused &&
      (focused.lifecycle === 'failed' ||
        focused.lifecycle === 'succeeded' ||
        focused.lifecycle === 'cancelled' ||
        focused.lifecycle === 'skipped'),
  );
  const hasRetryableTurn = $derived(!!activeTurnId);
  // Phase B: free-form send stays open after failed turns; only host readOnly locks.
  const composerReadOnly = $derived(!!focused && thread.readOnly);

  function resumeQueued(): void {
    if (!focused || !activeTurnId) return;
    post({ type: 'resumeQueuedTurn', taskId: focused.id, turnId: activeTurnId });
  }

  function submitRetry(): void {
    if (!focused || !recoveryTurnId) return;
    const instruction = retryInstruction.trim() || 'Retry the previous instruction.';
    post({ type: 'retryTurn', taskId: focused.id, turnId: recoveryTurnId, instruction });
    retryInstruction = '';
  }

  function submitRunAgain(): void {
    if (!focused || !recoveryTurnId) return;
    // Explicit replay authorization: reuse original turn inputs (not silent).
    post({
      type: 'retryTurn',
      taskId: focused.id,
      turnId: recoveryTurnId,
      instruction: 'Run again',
      reuseOriginalInputs: true,
    });
  }

  function submitContinue(): void {
    if (!focused) return;
    const instruction = continueMessage.trim();
    if (!instruction) return;
    post({ type: 'continueTask', taskId: focused.id, instruction });
    continueMessage = '';
  }

  function continueAsNewTask(): void {
    if (!focused) return;
    tasks.openContinuationDraft(focused.id);
    post({ type: 'newTask' });
  }

  /**
   * Edit = pull text into the composer message box and remove the queue row.
   * User revises in the composer and Enter re-queues (or Ctrl+Enter injects).
   */
  function editQueuedTurnToComposer(turnId: string, previewText: string): void {
    if (!focused) return;
    if (!tasks.queuedTurns.some((turn) => turn.turnId === turnId)) return;
    const message = buildDeleteQueuedTurnMessage(focused.id, turnId, { locked: false });
    if (!message) return;
    tasks.setCommandError(null);
    // Optimistic: drop row immediately, load text into composer.
    tasks.removeQueuedTurnLocally(turnId);
    tasks.prefillComposer(previewText);
    post(message);
  }

  function submitDeleteQueuedTurn(turnId: string): void {
    if (!focused) return;
    if (!tasks.queuedTurns.some((turn) => turn.turnId === turnId)) return;
    const message = buildDeleteQueuedTurnMessage(focused.id, turnId, { locked: false });
    if (!message) return;
    tasks.setCommandError(null);
    tasks.removeQueuedTurnLocally(turnId);
    post(message);
  }

</script>

<div class="flex-1 min-w-0 min-h-0 flex flex-col">
  {#if tasks.draftMode}
    <div class="task-workspace-banner task-workspace-banner--neutral" data-task-status="draft">
      <div class="min-w-0 flex-1">
        <div class="font-semibold text-sm">
          New task
        </div>
        <div class="task-workspace-detail" style="margin-top: 2px;">
          First message creates the coordinator task.
        </div>
      </div>
    </div>
    <ChatThread />
    <Composer mode="draft" {pendingAsk} />
  {:else if focused && presentation}
    <div
      bind:this={taskChromeRegion}
      class="task-chrome"
      data-testid="task-chrome"
      data-task-lifecycle={focused.lifecycle}
      data-task-status={focused.lifecycle}
      data-tree-expanded={treeExpanded ? 'true' : 'false'}
    >
      <div
        id="task-chrome-tree"
        class="task-tree-panel__list"
        class:task-tree-panel__list--virtual={treeExpanded}
        role="navigation"
        aria-label="Current task tree"
        data-testid="task-chrome-tree"
        bind:this={treeScrollEl}
      >
        {#if treeExpanded}
          <div class="task-tree-panel__virtual-sizer" style={`height: ${treeTotalSize}px;`}>
            {#each treeVirtualItems as vRow (vRow.key)}
              {@const row = treeRows[vRow.index]}
              {#if row}
                {@const nodePresentation = getTaskPresentation(row.task)}
                {@const isFocused = row.task.id === navigationTask?.id}
                {@const hasChildren = row.children.length > 0}
                {@const isCollapsed = collapsedIds.has(row.task.id)}
                {@const menuOpen = statusMenuTaskId === row.task.id}
                {@const isChromeToggle = row.task.id === treeRows[0]?.task.id}
                <div
                  class="task-tree-panel__item task-tree-panel__virtual-row"
                  data-index={vRow.index}
                  style={`transform: translateY(${vRow.start}px);`}
                  use:measureTreeRow
                >
                  <div
                    class="task-tree-panel__row"
                    class:task-tree-panel__row--focused={isFocused}
                    style={`padding-left: ${6 + Math.min(row.depth, 4) * 12}px`}
                  >
                    {#if isChromeToggle}
                      <button
                        type="button"
                        class="task-tree-panel__twistie task-tree-panel__chrome-toggle"
                        aria-label={`${treeExpanded ? 'Collapse' : 'Expand'} task tree`}
                        aria-expanded={treeExpanded ? 'true' : 'false'}
                        aria-controls="task-chrome-tree"
                        data-testid="task-tree-summary"
                        use:tip={treeExpanded ? 'Collapse task tree' : `Expand task tree (${tasks.subtree.length})`}
                        onclick={toggleTreeChrome}
                      >
                        <span
                          class="codicon"
                          class:codicon-chevron-right={!treeExpanded}
                          class:codicon-chevron-down={treeExpanded}
                          aria-hidden="true"
                        ></span>
                      </button>
                    {:else if hasChildren}
                      <button
                        type="button"
                        class="task-tree-panel__twistie"
                        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${row.task.goal}`}
                        aria-expanded={isCollapsed ? 'false' : 'true'}
                        data-testid="task-tree-collapse"
                        data-task-id={row.task.id}
                        onclick={() => toggleCollapse(row.task.id, true)}
                      >
                        <span
                          class="codicon"
                          class:codicon-chevron-right={isCollapsed}
                          class:codicon-chevron-down={!isCollapsed}
                          aria-hidden="true"
                        ></span>
                      </button>
                    {:else}
                      <span class="task-tree-panel__twistie task-tree-panel__twistie--spacer" aria-hidden="true"></span>
                    {/if}
                    <button
                      type="button"
                      class="task-tree-panel__select"
                      aria-current={isFocused ? 'page' : undefined}
                      aria-expanded={isFocused ? (treeExpanded ? 'true' : 'false') : undefined}
                      aria-controls={isFocused ? 'task-chrome-tree' : undefined}
                      aria-label={`${row.task.goal}${isFocused ? ', current task' : ''}`}
                      data-testid="task-tree-row"
                      data-task-id={row.task.id}
                      data-tree-depth={row.depth}
                      onclick={() => activateTreeNode(row.task.id)}
                    >
                      <span
                        class="codicon task-tree-panel__role {taskRoleIcon(row.task.role)}"
                        aria-hidden="true"
                      ></span>
                      <span class="task-tree-panel__goal" use:tip={row.task.goal}>{shortGoal(row.task.goal)}</span>
                    </button>
                    <button
                      type="button"
                      class={`task-tree-panel__status-btn ${lifecycleClass(row.task.lifecycle)}`}
                      data-task-lifecycle={row.task.lifecycle}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen ? 'true' : 'false'}
                      aria-label={`Task status: ${nodePresentation.lifecycle.label}. Change status for ${row.task.goal}.`}
                      use:tip={statusButtonTip(row.task)}
                      onclick={() => (statusMenuTaskId = menuOpen ? null : row.task.id)}
                    >
                      <span class={`codicon ${lifecycleIcon(row.task.lifecycle)}`} aria-hidden="true"></span>
                      <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
                    </button>
                  </div>
                  {#if menuOpen}
                    <div
                      class="task-tree-panel__status-menu"
                      role="menu"
                      aria-label={`Set status for ${row.task.goal}`}
                      style={`margin-left: ${30 + Math.min(row.depth, 4) * 12}px`}
                    >
                      {#each lifecycleActions(row.task.lifecycle) as action (action.lifecycle)}
                        <button
                          type="button"
                          class="task-status-menu__item"
                          role="menuitem"
                          title={action.description}
                          onclick={() => setLifecycle(row.task.id, action.lifecycle)}
                        >
                          <span class="task-status-menu__item-label">{action.label}</span>
                          <span class="task-status-menu__item-desc">{action.description}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {:else}
          {#each visibleTreeRows as row (row.task.id)}
            {@const nodePresentation = getTaskPresentation(row.task)}
            {@const isFocused = row.task.id === navigationTask?.id}
            {@const menuOpen = statusMenuTaskId === row.task.id}
            <div class="task-tree-panel__item">
              <div
                class="task-tree-panel__row"
                class:task-tree-panel__row--focused={isFocused}
                style="padding-left: 6px"
              >
                <button
                  type="button"
                  class="task-tree-panel__twistie task-tree-panel__chrome-toggle"
                  aria-label="Expand task tree"
                  aria-expanded="false"
                  aria-controls="task-chrome-tree"
                  data-testid="task-tree-summary"
                  use:tip={`Expand task tree (${tasks.subtree.length})`}
                  onclick={toggleTreeChrome}
                >
                  <span class="codicon codicon-chevron-right" aria-hidden="true"></span>
                </button>
                <button
                  type="button"
                  class="task-tree-panel__select"
                  aria-current={isFocused ? 'page' : undefined}
                  aria-expanded="false"
                  aria-controls="task-chrome-tree"
                  aria-label={`${row.task.goal}${isFocused ? ', current task' : ''}`}
                  data-testid="task-tree-row"
                  data-task-id={row.task.id}
                  onclick={() => activateTreeNode(row.task.id)}
                >
                  <span
                    class="codicon task-tree-panel__role {taskRoleIcon(row.task.role)}"
                    aria-hidden="true"
                  ></span>
                  <span class="task-tree-panel__goal" use:tip={row.task.goal}>{shortGoal(row.task.goal)}</span>
                </button>
                <button
                  type="button"
                  class={`task-tree-panel__status-btn ${lifecycleClass(row.task.lifecycle)}`}
                  data-task-lifecycle={row.task.lifecycle}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen ? 'true' : 'false'}
                  aria-label={`Task status: ${nodePresentation.lifecycle.label}. Change status for ${row.task.goal}.`}
                  use:tip={statusButtonTip(row.task)}
                  onclick={() => (statusMenuTaskId = menuOpen ? null : row.task.id)}
                >
                  <span class={`codicon ${lifecycleIcon(row.task.lifecycle)}`} aria-hidden="true"></span>
                  <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
                </button>
              </div>
              {#if menuOpen}
                <div
                  class="task-tree-panel__status-menu"
                  role="menu"
                  aria-label={`Set status for ${row.task.goal}`}
                  style="margin-left: 30px"
                >
                  {#each lifecycleActions(row.task.lifecycle) as action (action.lifecycle)}
                    <button
                      type="button"
                      class="task-status-menu__item"
                      role="menuitem"
                      title={action.description}
                      onclick={() => setLifecycle(row.task.id, action.lifecycle)}
                    >
                      <span class="task-status-menu__item-label">{action.label}</span>
                      <span class="task-status-menu__item-desc">{action.description}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <ChatThread />

    {#if queuedTurnControls.length > 0}
      <div
        class="task-action-panel task-action-panel--info queued-turns-panel"
        data-testid="queued-turns-panel"
        aria-label="Queued follow-up turns"
      >
        <div class="font-semibold">Queued follow-ups ({queuedTurnControls.length})</div>
        <p class="task-muted" style="margin: 0;">
          Edit moves text into the message box so you can revise and send again. Delete removes
          it from the queue. Rows disappear once a turn starts.
        </p>
        <ul class="queued-turns-list">
          {#each queuedTurnControls as control (control.turnId)}
            <li
              class="queued-turn-item"
              data-turn-id={control.turnId}
              data-queued-locked={control.locked ? 'true' : 'false'}
            >
              <div class="queued-turn-item__meta">
                <span class="task-pill task-pill--muted">#{control.sequence}</span>
                <span class="task-muted">queued</span>
              </div>

              <div class="queued-turn-item__preview">
                {control.previewText || '(empty queued message)'}
              </div>
              <div class="queued-turn-item__actions">
                <button
                  type="button"
                  class="queued-turn-action"
                  disabled={control.locked || !control.canEdit}
                  aria-label={`Edit queued turn ${control.sequence}`}
                  onclick={() => editQueuedTurnToComposer(control.turnId, control.previewText)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="queued-turn-action queued-turn-action--danger"
                  disabled={control.locked || !control.canDelete}
                  aria-label={`Delete queued turn ${control.sequence}`}
                  onclick={() => submitDeleteQueuedTurn(control.turnId)}
                >
                  Delete
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if pendingAsk && tasks.focusedTaskId}
      <AskCard
        taskId={tasks.focusedTaskId}
        turnId={pendingAsk.turnId}
        askId={pendingAsk.askId}
        questions={pendingAsk.questions}
        {submissionError}
        {submissionVersion}
      />
    {/if}

    {#if runtime === 'waiting_user' && !pendingAsk}
      <div class="task-action-panel task-action-panel--attention">
        <span>{presentation.composerGuidance}</span>
        {#if !activeTurnId}
          <span class="task-muted">This task is waiting for input, but no active turn id is available.</span>
        {/if}
      </div>
    {/if}

    {#if showUncertainCard}
      <div class="task-action-panel task-action-panel--warning" data-turn-activity="uncertain">
        <div class="font-semibold">Status unclear — continue or run again?</div>
        <p class="task-muted">
          The previous turn may have partially run. Choose explicitly — nothing is replayed automatically.
        </p>
        <div class="flex flex-col gap-1">
          <vscode-button disabled={!recoveryTurnId} onclick={submitRunAgain}>
            Run again
          </vscode-button>
        </div>
        <div class="flex flex-col gap-1">
          <span>Check and continue</span>
          <vscode-textarea
            rows={2}
            placeholder="Inspect workspace then continue with a new message..."
            value={continueMessage}
            oninput={(e: Event) => {
              continueMessage = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          ></vscode-textarea>
          <vscode-button disabled={!continueMessage.trim()} onclick={submitContinue}>
            Check and continue
          </vscode-button>
        </div>
      </div>
    {:else if showFailedTurnCard}
      <div class="task-action-panel task-action-panel--danger" data-turn-activity="failed_turn">
        <div class="font-semibold">{focused?.runTimeoutMessage ? 'Agent run limit reached' : 'Could not finish'}</div>
        <p class="task-muted">
          {focused?.runTimeoutMessage ?? 'The last turn could not finish. Type a new message below to continue, or use Retry / Continue.'}
        </p>
        {#if !recoveryTurnId}
          <p class="task-muted">No retryable turn is available for this task.</p>
        {/if}

        <div class="flex flex-col gap-1">
          <span>Try again (optional instruction)</span>
          <vscode-textarea
            rows={2}
            placeholder="What should the agent do differently?"
            value={retryInstruction}
            oninput={(e: Event) => {
              retryInstruction = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          ></vscode-textarea>
          <vscode-button disabled={!recoveryTurnId} onclick={submitRetry}>
            Try again
          </vscode-button>
        </div>

        <div class="flex flex-col gap-1">
          <span>Check and continue</span>
          <vscode-textarea
            rows={2}
            placeholder="Message to queue as the next turn..."
            value={continueMessage}
            oninput={(e: Event) => {
              continueMessage = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          ></vscode-textarea>
          <vscode-button disabled={!continueMessage.trim()} onclick={submitContinue}>
            Continue
          </vscode-button>
        </div>
      </div>
    {:else if showResume}
      <div class="task-action-panel task-action-panel--info">
        <span>A queued task turn is ready to start.</span>
        <vscode-button onclick={resumeQueued}>Resume queued task</vscode-button>
      </div>
    {:else if runtime === 'queued'}
      <div class="task-action-panel task-action-panel--info">
        <span>This task is queued, but no resumable turn id is available yet.</span>
      </div>
    {/if}

    {#if showTerminalReopenHint}
      <div
        class={`task-action-panel ${
          focused.lifecycle === 'failed' ? 'task-action-panel--danger' : 'task-action-panel--warning'
        }`}
        role="status"
      >
        <span>{presentation.composerGuidance}</span>
        <vscode-button secondary onclick={() => setLifecycle(focused.id, 'open')}>Reopen</vscode-button>
      </div>
    {/if}

    <Composer
      mode="task"
      taskId={focused.id}
      turnId={activeTurnId}
      readOnly={composerReadOnly}
      task={focused}
      {pendingAsk}
    />
  {:else}
    <div class="flex-1 flex items-center justify-center text-sm" style="opacity: 0.6;">
      Select a task or create a new one.
    </div>
  {/if}
</div>
