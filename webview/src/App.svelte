<script lang="ts">
  import { onMount } from 'svelte';
  import Toolbar from './components/Toolbar.svelte';
  import TaskHistoryList from './components/TaskList.svelte';
  import TaskWorkspace from './components/TaskWorkspace.svelte';
  import { tasks } from './lib/tasks.svelte';
  import { threadStore } from './lib/thread.svelte';
  import { isExtMessage, post, statusLabel } from './lib/protocol';
  import type { PendingAsk, TaskViewStatus } from './lib/protocol';

  let pendingAsk = $state<PendingAsk | null>(null);
  let activeTurnId = $state<string | null>(null);
  const visibleCommandError = $derived(
    tasks.commandError && (!tasks.commandError.taskId || tasks.commandError.taskId === tasks.focusedTaskId)
      ? tasks.commandError
      : null,
  );

  // When no focused task and not in draft, we show the previous tasks list as entry
  const inChat = $derived(tasks.draftMode || !!tasks.focusedTaskId);
  let historyOpen = $state(false);

  function selectTask(taskId: string) {
    tasks.focusTask(taskId);
    post({ type: 'focusTask', taskId });
    post({ type: 'hydrateSubtree', taskId });
    historyOpen = false;
  }

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    if (trimmed.length <= 48) return trimmed || '(no goal)';
    return `${trimmed.slice(0, 45)}…`;
  }

  function statusIcon(status: TaskViewStatus): string {
    switch (status) {
      case 'running':
      case 'waiting_user':
        return 'codicon-loading';
      case 'succeeded':
        return 'codicon-check';
      case 'failed':
        return 'codicon-error';
      case 'cancelled':
      case 'skipped':
        return 'codicon-circle-slash';
      case 'queued':
      case 'waiting_dependencies':
        return 'codicon-clock';
      case 'blocked':
      case 'needs_recovery':
        return 'codicon-warning';
      case 'waiting_children':
        return 'codicon-ellipsis';
      default:
        return 'codicon-circle-outline';
    }
  }

  function clearHistory() {
    historyOpen = false;
    post({ type: 'clearHistory' });
  }

  function backToList() {
    tasks.focusedTaskId = null;
    tasks.draftMode = false;
    threadStore.clearFocus();
    historyOpen = false;
  }

  onMount(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (!isExtMessage(msg)) return;

      switch (msg.type) {
        case 'snapshot': {
          tasks.applySnapshot(msg);
          pendingAsk = msg.pendingAsk ?? null;
          activeTurnId = msg.activeTurnId ?? null;

          if (msg.focusedTaskId) {
            const focused = tasks.tasks.get(msg.focusedTaskId);
            threadStore.focusTask(
              msg.focusedTaskId,
              msg.transcript,
              msg.activeTurnId,
              focused?.viewStatus,
            );
          } else if (tasks.draftMode) {
            threadStore.clearFocus();
          }
          break;
        }

        case 'taskUpdated': {
          tasks.applyTaskUpdated(msg.taskId, msg.storeRevision, msg.patch);
          if (msg.taskId === tasks.focusedTaskId && msg.patch.viewStatus) {
            threadStore.updateReadOnly(msg.patch.viewStatus);
          }
          break;
        }

        case 'turnStart':
          threadStore.onTurnStart(msg.taskId, msg.turnId);
          if (msg.taskId === tasks.focusedTaskId) {
            activeTurnId = msg.turnId;
          }
          break;

        case 'event':
          threadStore.onEvent(msg.taskId, msg.turnId, msg.event);
          break;

        case 'turnDone':
          threadStore.onTurnDone(msg.taskId, msg.turnId);
          if (msg.taskId === tasks.focusedTaskId && msg.turnId === activeTurnId) {
            activeTurnId = null;
          }
          break;

        case 'turnError':
          threadStore.onTurnError(msg.taskId, msg.turnId, msg.message);
          if (msg.taskId === tasks.focusedTaskId && msg.turnId === activeTurnId) {
            activeTurnId = null;
          }
          break;

        case 'transcriptAppend':
          threadStore.onTranscriptAppend(msg.taskId, msg.item);
          break;

        case 'askPending': {
          if (tasks.tasks.has(msg.taskId) && msg.taskId !== tasks.focusedTaskId) {
            tasks.focusTask(msg.taskId);
          }
          if (msg.taskId === tasks.focusedTaskId) {
            pendingAsk = {
              turnId: msg.turnId,
              askId: msg.askId,
              questions: msg.questions,
            };
            activeTurnId = msg.turnId;
          }
          break;
        }

        case 'askCleared':
          if (
            pendingAsk &&
            pendingAsk.askId === msg.askId &&
            pendingAsk.turnId === msg.turnId &&
            msg.taskId === tasks.focusedTaskId
          ) {
            pendingAsk = null;
          }
          break;

        case 'commandError':
          if (!msg.taskId || msg.taskId === tasks.focusedTaskId) {
            tasks.setCommandError(msg.message, msg.taskId ?? null);
          }
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

<Toolbar {inChat} {historyOpen} toggleHistory={() => (historyOpen = !historyOpen)} />

{#if visibleCommandError}
  <div class="task-command-error" role="alert">
    <div class="min-w-0">
      <div class="font-semibold">Task command failed</div>
      <div class="task-command-error__detail">{visibleCommandError.message}</div>
    </div>
    <button
      type="button"
      class="task-command-error__dismiss"
      onclick={() => tasks.setCommandError(null)}
    >Dismiss</button>
  </div>
{/if}

{#if !inChat}
  <!-- Entry: show previous coordinator tasks -->
  <div class="flex-1 min-h-0 flex flex-col p-3">
    <div class="flex items-center justify-between mb-2 px-1">
      <span class="font-semibold">Previous tasks</span>
      <button
        type="button"
        class="icon-btn"
        style="width: 22px; height: 22px;"
        onclick={() => { tasks.openNewTaskDraft(); post({ type: 'newTask' }); historyOpen = false; }}
        title="New task"
      >
        <span class="codicon codicon-add"></span>
      </button>
    </div>
    <TaskHistoryList variant="full" onSelect={(id) => { selectTask(id); historyOpen = false; }} onClear={clearHistory} />
  </div>
{:else}
  <div class="flex-1 min-h-0 flex flex-col relative">
    <!-- Chat header: two rows -->
    <div
      class="shrink-0 border-b"
      style="border-color: var(--vscode-panel-border); background: var(--vscode-sideBar-background, transparent);"
    >
      <!-- Row 1: Back | History + New task -->
      <div class="flex items-center gap-2 px-3 py-1 text-xs relative">
        <button
          type="button"
          class="icon-btn"
          style="width: 22px; height: 22px;"
          onclick={backToList}
          title="Back to tasks list"
        >
          <span class="codicon codicon-arrow-left"></span>
        </button>

        <div class="flex-1"></div>

        <button
          type="button"
          class="icon-btn"
          style="width: 22px; height: 22px;"
          onclick={() => (historyOpen = !historyOpen)}
          title="History (previous coordinator tasks)"
        >
          <span class="codicon codicon-history"></span>
        </button>

        <button
          type="button"
          class="icon-btn"
          style="width: 22px; height: 22px;"
          onclick={() => { tasks.openNewTaskDraft(); post({ type: 'newTask' }); historyOpen = false; }}
          title="New task"
        >
          <span class="codicon codicon-add"></span>
        </button>
      </div>

      <!-- Row 2: task name + status (below, left-aligned) -->
      {#if tasks.focusedTask}
        <div class="flex items-center gap-2 px-3 pb-1.5 text-sm" style="border-top: 1px solid var(--vscode-panel-border);">
          <span class="font-semibold truncate" title={tasks.focusedTask.goal}>
            {shortGoal(tasks.focusedTask.goal)}
          </span>
          <span 
            class="codicon {statusIcon(tasks.focusedTask.viewStatus)}" 
            style="font-size: 14px; vertical-align: middle; margin-left: 4px;"
            title={statusLabel(tasks.focusedTask.viewStatus)}
          ></span>
        </div>
      {:else if tasks.draftMode}
        <div class="flex items-center gap-2 px-3 pb-1.5 text-sm" style="border-top: 1px solid var(--vscode-panel-border);">
          <span class="font-semibold">
            {tasks.continuationOf ? 'Continue as new task' : 'New task'}
          </span>
          <span class="text-xs" style="opacity: 0.7;">First message creates the coordinator task.</span>
        </div>
      {/if}
    </div>

    <TaskWorkspace {pendingAsk} {activeTurnId} />

    <!-- History dropdown -->
    {#if historyOpen}
      <!-- click outside catcher -->
      <button
        type="button"
        aria-label="Close history"
        class="absolute left-0 right-0 bottom-0 top-[28px] z-40 cursor-default"
        style="background: transparent; border: none;"
        onclick={() => (historyOpen = false)}
      ></button>
      <div
        class="absolute right-3 top-[28px] z-50 w-80 max-w-[min(20rem,calc(100%-1rem))] max-h-[min(55vh,320px)] overflow-auto rounded border shadow"
        style="background: var(--vscode-editor-background); border-color: var(--vscode-panel-border);"
      >
        <div class="flex items-center justify-between px-2 py-1 border-b text-xs" style="border-color: var(--vscode-panel-border);">
          <span class="font-medium">Previous tasks</span>
          <button type="button" class="underline text-xs" onclick={() => { clearHistory(); }}>Clear</button>
        </div>
        <TaskHistoryList variant="dropdown" onSelect={(id) => { selectTask(id); }} onClear={() => { clearHistory(); }} />
      </div>
    {/if}
  </div>
{/if}