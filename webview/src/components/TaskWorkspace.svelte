<script lang="ts">
  import ChatThread from './ChatThread.svelte';
  import Composer from './Composer.svelte';
  import AskCard from './AskCard.svelte';
  import { tasks } from '../lib/tasks.svelte';
  import { threadStore } from '../lib/thread.svelte';
  import { post } from '../lib/protocol';
  import { getTaskStatusPresentation, isTaskStatusTerminal } from '../lib/task-status';
  import type { PendingAsk, TaskViewStatus } from '../lib/protocol';
  import { tip } from '../lib/tooltip';

  interface Props {
    pendingAsk: PendingAsk | null;
    activeTurnId: string | null;
  }

  let { pendingAsk = null, activeTurnId = null }: Props = $props();

  let retryInstruction = $state('');
  let continueMessage = $state('');

  const focused = $derived(tasks.focusedTask);
  const thread = $derived(threadStore.current);
  const presentation = $derived(getTaskStatusPresentation(focused?.viewStatus));
  const showResume = $derived(
    !!focused &&
      !!activeTurnId &&
      (focused.viewStatus === 'queued' || focused.viewStatus === 'waiting_dependencies'),
  );
  const showRecovery = $derived(focused?.viewStatus === 'needs_recovery');
  const showContinueAsNew = $derived(!!focused && isTaskStatusTerminal(focused.viewStatus));
  const hasRetryableTurn = $derived(!!activeTurnId);
  const composerReadOnly = $derived(
    !!focused && (thread.readOnly || showRecovery || focused.viewStatus === 'running' || focused.viewStatus === 'queued'),
  );

  function resumeQueued(): void {
    if (!focused || !activeTurnId) return;
    post({ type: 'resumeQueuedTurn', taskId: focused.id, turnId: activeTurnId });
  }

  function submitRetry(): void {
    if (!focused || !activeTurnId) return;
    const instruction = retryInstruction.trim();
    if (!instruction) return;
    post({ type: 'retryTurn', taskId: focused.id, turnId: activeTurnId, instruction });
    retryInstruction = '';
  }

  function submitContinue(): void {
    if (!focused || !activeTurnId) return;
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

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    return trimmed || '(no goal)';
  }

  function statusClass(status: TaskViewStatus): string {
    return `task-status task-status--${getTaskStatusPresentation(status).tone}`;
  }
</script>

<div class="flex-1 min-w-0 min-h-0 flex flex-col">
  {#if tasks.draftMode}
    <ChatThread />
    <Composer mode="draft" {pendingAsk} />
  {:else if focused}
    {#if tasks.subtree.length > 1}
      <div
        class="px-2 py-1 border-b flex flex-wrap gap-1 items-center text-xs"
        style="border-color: var(--vscode-panel-border);"
      >
        <span style="opacity: 0.7;">Subtree:</span>
        {#each tasks.subtree as node (node.id)}
          <vscode-badge use:tip={node.goal} class={statusClass(node.viewStatus)}>
            {node.id === focused.id ? '▸ ' : ''}{shortGoal(node.goal).slice(0, 24)}
          </vscode-badge>
        {/each}
      </div>
    {/if}

    <div
      class={`task-workspace-banner task-workspace-banner--${presentation.tone}`}
      data-task-status={focused.viewStatus}
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <span class="font-semibold truncate">{shortGoal(focused.goal)}</span>
          <vscode-badge class={statusClass(focused.viewStatus)}>{presentation.label}</vscode-badge>
          {#if focused.backend}
            <span class="task-pill task-pill--muted">{focused.backend}</span>
          {/if}
          {#if focused.continuationOf}
            <span class="task-pill task-pill--muted">continuation</span>
          {/if}
        </div>
        <div class="task-workspace-headline">{presentation.workspaceHeadline}</div>
        <div class="task-workspace-detail">{presentation.workspaceDetail}</div>
      </div>
      {#if focused.viewStatus === 'running' && activeTurnId}
        <div class="task-live-chip">Active turn</div>
      {:else if focused.viewStatus === 'queued' && activeTurnId}
        <div class="task-live-chip">Queued turn</div>
      {:else if focused.viewStatus === 'waiting_user'}
        <div class="task-live-chip">Waiting for answer</div>
      {/if}
    </div>

    <ChatThread />

    {#if pendingAsk && tasks.focusedTaskId}
      <AskCard
        taskId={tasks.focusedTaskId}
        turnId={pendingAsk.turnId}
        askId={pendingAsk.askId}
        questions={pendingAsk.questions}
      />
    {/if}

    {#if focused.viewStatus === 'waiting_user' && !pendingAsk}
      <div class="task-action-panel task-action-panel--attention">
        <span>{presentation.composerGuidance}</span>
        {#if !activeTurnId}
          <span class="task-muted">This task is waiting for input, but no active turn id is available.</span>
        {/if}
      </div>
    {/if}

    {#if showRecovery}
      <div class="task-action-panel task-action-panel--danger">
        <div class="font-semibold">Recovery needed</div>
        <p>{presentation.composerGuidance}</p>
        {#if !hasRetryableTurn}
          <p class="task-muted">No retryable turn is available for this task.</p>
        {/if}

        <div class="flex flex-col gap-1">
          <span>Retry (required instruction)</span>
          <vscode-textarea
            rows={2}
            placeholder="What should the agent do differently?"
            value={retryInstruction}
            oninput={(e: Event) => {
              retryInstruction = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          ></vscode-textarea>
          <vscode-button disabled={!retryInstruction.trim() || !activeTurnId} onclick={submitRetry}>
            Retry failed turn
          </vscode-button>
        </div>

        <div class="flex flex-col gap-1">
          <span>Continue (required message)</span>
          <vscode-textarea
            rows={2}
            placeholder="Message to queue as the next turn..."
            value={continueMessage}
            oninput={(e: Event) => {
              continueMessage = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          ></vscode-textarea>
          <vscode-button disabled={!continueMessage.trim() || !activeTurnId} onclick={submitContinue}>
            Continue task
          </vscode-button>
        </div>
      </div>
    {:else if showResume}
      <div class="task-action-panel task-action-panel--info">
        <span>A queued task turn is ready to start.</span>
        <vscode-button onclick={resumeQueued}>Resume queued task</vscode-button>
      </div>
    {:else if focused.viewStatus === 'queued'}
      <div class="task-action-panel task-action-panel--info">
        <span>This task is queued, but no resumable turn id is available yet.</span>
      </div>
    {/if}

    {#if showContinueAsNew}
      <div class="task-action-panel task-action-panel--muted">
        <span>{presentation.composerGuidance}</span>
        <vscode-button secondary onclick={continueAsNewTask}>Continue as new task</vscode-button>
      </div>
    {/if}

    <Composer
      mode="task"
      taskId={focused.id}
      turnId={activeTurnId}
      readOnly={composerReadOnly}
      taskStatus={focused.viewStatus}
      {pendingAsk}
    />
  {:else}
    <div class="flex-1 flex items-center justify-center text-sm" style="opacity: 0.6;">
      Select a task or create a new one.
    </div>
  {/if}
</div>
