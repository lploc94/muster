<script lang="ts">
  import { onMount } from 'svelte';
  import Toolbar from './components/Toolbar.svelte';
  import TaskList from './components/TaskList.svelte';
  import TaskWorkspace from './components/TaskWorkspace.svelte';
  import { tasks } from './lib/tasks.svelte';
  import { threadStore } from './lib/thread.svelte';
  import { isExtMessage } from './lib/protocol';
  import type { PendingAsk } from './lib/protocol';

  let pendingAsk = $state<PendingAsk | null>(null);
  let activeTurnId = $state<string | null>(null);

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

        case 'askPending':
          if (msg.taskId === tasks.focusedTaskId) {
            pendingAsk = {
              turnId: msg.turnId,
              askId: msg.askId,
              questions: msg.questions,
            };
            activeTurnId = msg.turnId;
          }
          break;

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
          tasks.setCommandError(msg.message);
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

<Toolbar />

{#if tasks.commandError}
  <div
    class="px-3 py-1 text-xs"
    style="color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));"
  >
    {tasks.commandError}
    <button
      type="button"
      class="ml-2 underline"
      onclick={() => tasks.setCommandError(null)}
    >Dismiss</button>
  </div>
{/if}

<div class="flex flex-1 min-h-0">
  <TaskList />
  <TaskWorkspace {pendingAsk} {activeTurnId} />
</div>