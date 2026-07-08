<script lang="ts">
  import ChatThread from './ChatThread.svelte';
  import Composer from './Composer.svelte';
  import AskCard from './AskCard.svelte';
  import { tasks } from '../lib/tasks.svelte';
  import { threadStore } from '../lib/thread.svelte';
  import { post, statusLabel } from '../lib/protocol';
  import type { PendingAsk } from '../lib/protocol';
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
  const showResume = $derived(
    !!focused &&
      !!activeTurnId &&
      (focused.viewStatus === 'queued' || focused.viewStatus === 'waiting_dependencies'),
  );
  const showRecovery = $derived(focused?.viewStatus === 'needs_recovery');
  const showContinueAsNew = $derived(tasks.focusedIsTerminal);

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

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    return trimmed || '(no goal)';
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
          <vscode-badge use:tip={node.goal}>
            {node.id === focused.id ? '▸ ' : ''}{shortGoal(node.goal).slice(0, 24)}
          </vscode-badge>
        {/each}
      </div>
    {/if}

    <ChatThread />

    {#if pendingAsk && tasks.focusedTaskId}
      <AskCard
        taskId={tasks.focusedTaskId}
        turnId={pendingAsk.turnId}
        askId={pendingAsk.askId}
        questions={pendingAsk.questions}
      />
    {/if}

    {#if showRecovery}
      <div
        class="mx-2 my-1 p-2 rounded flex flex-col gap-2 text-xs"
        style="border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));"
      >
        <div class="font-semibold">Recovery required</div>
        <p style="opacity: 0.85;">
          Start fresh — retry the failed turn or continue with a new message.
        </p>

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
            Retry
          </vscode-button>
        </div>

        <div class="flex flex-col gap-1">
          <span>Continue (required message)</span>
          <vscode-textarea
            rows={2}
            placeholder="Message to queue as the next turn…"
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
      <div class="mx-2 my-1 p-2 flex items-center gap-2 text-xs">
        <span>A queued turn is ready to start.</span>
        <vscode-button onclick={resumeQueued}>Resume</vscode-button>
      </div>
    {/if}

    {#if showContinueAsNew}
      <div class="mx-2 my-1 p-2 flex items-center gap-2 text-xs">
        <span>This task is terminal.</span>
        <vscode-button secondary onclick={continueAsNewTask}>Continue as new task</vscode-button>
      </div>
    {/if}

    <Composer
      mode="task"
      taskId={focused.id}
      turnId={activeTurnId}
      readOnly={thread.readOnly || showRecovery}
      {pendingAsk}
    />
  {:else}
    <div class="flex-1 flex items-center justify-center text-sm" style="opacity: 0.6;">
      Select a task or create a new one.
    </div>
  {/if}
</div>