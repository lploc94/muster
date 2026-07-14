<script lang="ts">
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
  import { tip } from '../lib/tooltip';

  interface Props {
    pendingAsk: PendingAsk | null;
    activeTurnId: string | null;
    submissionError?: string;
    submissionVersion?: number;
  }

  let { pendingAsk = null, activeTurnId = null, submissionError, submissionVersion = 0 }: Props = $props();

  let retryInstruction = $state('');
  let continueMessage = $state('');
  let statusMenuOpen = $state(false);
  let statusMenuRegion = $state<HTMLElement | undefined>(undefined);
  /** Collapsed by default — detail lines (headline, session, orchestration) only when expanded. */
  let detailsExpanded = $state(false);

  const focused = $derived(tasks.focusedTask);
  const thread = $derived(threadStore.current);
  const presentation = $derived(focused ? getTaskPresentation(focused) : null);
  const runtime = $derived(focused ? effectiveRuntimeActivity(focused) : null);
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

  const lifecycleActions = $derived.by((): LifecycleAction[] => {
    const current = focused?.lifecycle ?? 'open';
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
  });

  function setLifecycle(lifecycle: TaskLifecycleState) {
    if (!focused) return;
    statusMenuOpen = false;
    post({ type: 'setTaskLifecycle', taskId: focused.id, lifecycle });
  }

  /** Request host Markdown export for the focused task only (native Save As). */
  function exportTaskChat(): void {
    if (!focused) return;
    tasks.setCommandError(null);
    post({ type: 'exportTask', taskId: focused.id });
  }

  $effect(() => {
    if (!statusMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && statusMenuRegion?.contains(target)) return;
      statusMenuOpen = false;
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  // Collapse details when switching tasks so each open starts compact.
  $effect(() => {
    void focused?.id;
    detailsExpanded = false;
    statusMenuOpen = false;
  });

  const showResume = $derived(
    !!focused &&
      focused.lifecycle === 'open' &&
      !!activeTurnId &&
      (runtime === 'queued' || runtime === 'waiting_dependencies'),
  );
  const showFailedTurnCard = $derived(
    !!focused &&
      focused.lifecycle === 'open' &&
      (focused.currentTurnActivity?.state === 'failed_turn' ||
        (focused.currentTurnActivity === undefined && runtime === 'needs_recovery')),
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

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    return trimmed || '(no goal)';
  }

  function lifecycleClass(lifecycle: string): string {
    return `task-status task-status--${getLifecyclePresentation(lifecycle).tone}`;
  }

  /** Banner uses lifecycle tone only — turn activity is shown near the composer. */
  const bannerTone = $derived(presentation?.lifecycle.tone ?? 'neutral');
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
    {#if tasks.subtree.length > 1}
      <div
        class="px-2 py-1 border-b flex flex-wrap gap-1 items-center text-xs"
        style="border-color: var(--vscode-panel-border);"
      >
        <span style="opacity: 0.7;">Subtree:</span>
        {#each tasks.subtree as node (node.id)}
          {@const nodePresentation = getTaskPresentation(node)}
          <vscode-badge use:tip={`${nodePresentation.listCopy}: ${node.goal}`} class={lifecycleClass(node.lifecycle)}>
            {node.id === focused.id ? '▸ ' : ''}{shortGoal(node.goal).slice(0, 24)}
            · {nodePresentation.lifecycle.label}
          </vscode-badge>
        {/each}
      </div>
    {/if}

    <!-- Single header card: title + status (replaces App header row 2) -->
    <div
      class={`task-workspace-banner task-workspace-banner--${bannerTone}`}
      data-task-lifecycle={focused.lifecycle}
      data-task-status={focused.lifecycle}
      data-details-expanded={detailsExpanded ? 'true' : 'false'}
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <span class="font-semibold truncate text-sm min-w-0 flex-1" use:tip={focused.goal}>
            {shortGoal(focused.goal)}
          </span>
          <div bind:this={statusMenuRegion} class="task-status-menu shrink-0">
            <button
              type="button"
              class={`task-status-btn task-status task-status--${presentation.lifecycle.tone}`}
              aria-haspopup="menu"
              aria-expanded={statusMenuOpen ? 'true' : 'false'}
              aria-label={`Task status: ${presentation.lifecycle.label}. Click to change.`}
              use:tip={'Change task status'}
              onclick={() => (statusMenuOpen = !statusMenuOpen)}
            >
              {presentation.lifecycle.label}
              <span class="codicon codicon-chevron-down" style="font-size: 11px; opacity: 0.8;"></span>
            </button>
            {#if statusMenuOpen}
              <div class="task-status-menu__panel" role="menu" aria-label="Set task status">
                {#each lifecycleActions as action (action.lifecycle)}
                  <button
                    type="button"
                    class="task-status-menu__item"
                    role="menuitem"
                    title={action.description}
                    onclick={() => setLifecycle(action.lifecycle)}
                  >
                    <span class="task-status-menu__item-label">{action.label}</span>
                    <span class="task-status-menu__item-desc">{action.description}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
          {#if focused.backend}
            <span class="task-pill task-pill--muted shrink-0">{focused.backend}</span>
          {/if}
          <button
            type="button"
            class="icon-btn shrink-0"
            style="width: 22px; height: 22px;"
            aria-label="Export task/chat"
            data-testid="export-task-chat"
            use:tip={'Export task/chat'}
            onclick={exportTaskChat}
          >
            <span class="codicon codicon-export" style="font-size: 14px;"></span>
          </button>
          <button
            type="button"
            class="icon-btn shrink-0"
            style="width: 22px; height: 22px;"
            aria-label={detailsExpanded ? 'Collapse task details' : 'Expand task details'}
            aria-expanded={detailsExpanded ? 'true' : 'false'}
            use:tip={detailsExpanded ? 'Collapse details' : 'Expand details'}
            onclick={() => (detailsExpanded = !detailsExpanded)}
          >
            <span
              class="codicon"
              class:codicon-chevron-up={detailsExpanded}
              class:codicon-chevron-down={!detailsExpanded}
              style="font-size: 14px;"
            ></span>
          </button>
        </div>

        {#if detailsExpanded}
          <div class="task-workspace-details">
            <div class="task-workspace-headline">{presentation.lifecycle.workspaceHeadline}</div>
            <div class="task-workspace-detail">{presentation.lifecycle.workspaceDetail}</div>
            {#if runtime && runtime !== 'idle' && focused.lifecycle === 'open' && presentation.runtime}
              <div class="task-workspace-orchestration" use:tip={presentation.runtime.workspaceDetail}>
                Orchestration: {presentation.runtime.label}
              </div>
            {/if}
            {#if focused.hasOutcomeProposal && focused.lifecycle === 'open'}
              <div
                class="task-workspace-orchestration"
                use:tip={'Agent proposed completion; send a message to continue on the same task.'}
              >
                Agent proposed done — task stays open; chat to continue.
              </div>
            {/if}
            {#if focused.continuationOf}
              <div class="task-workspace-orchestration" style="opacity: 0.55;">
                Continuation of prior task
              </div>
            {/if}
          </div>
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
        <div class="font-semibold">Could not finish</div>
        <p class="task-muted">
          The last turn could not finish. Type a new message below to continue, or use Retry / Continue.
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
        <vscode-button secondary onclick={() => setLifecycle('open')}>Reopen</vscode-button>
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
