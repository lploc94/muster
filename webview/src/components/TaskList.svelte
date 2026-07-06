<script lang="ts">
  import { tasks } from '../lib/tasks.svelte';
  import { post } from '../lib/protocol';
  import { statusLabel } from '../lib/protocol';

  function selectTask(taskId: string) {
    tasks.focusTask(taskId);
    post({ type: 'focusTask', taskId });
    post({ type: 'hydrateSubtree', taskId });
  }

  function newTask() {
    tasks.openNewTaskDraft();
    post({ type: 'newTask' });
  }

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    if (trimmed.length <= 48) return trimmed || '(no goal)';
    return `${trimmed.slice(0, 45)}…`;
  }
</script>

<aside
  class="w-56 shrink-0 flex flex-col border-r min-h-0"
  style="border-color: var(--vscode-panel-border); background: var(--vscode-sideBar-background, transparent);"
>
  <div
    class="flex items-center gap-2 px-2 py-2 border-b"
    style="border-color: var(--vscode-panel-border);"
  >
    <span class="font-semibold text-sm">Tasks</span>
    <span class="flex-1"></span>
    <vscode-button appearance="icon" title="New task" onclick={newTask}>
      <span class="codicon codicon-add"></span>
    </vscode-button>
  </div>

  <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1 flex flex-col gap-0.5">
    {#if tasks.draftMode}
      <div
        class="rounded px-2 py-1.5 text-xs"
        style="background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);"
      >
        New task (draft)
      </div>
    {/if}

    {#each tasks.rootTasks as task (task.id)}
      <button
        type="button"
        class="w-full text-left rounded px-2 py-1.5 text-xs flex flex-col gap-0.5"
        class:selected={tasks.focusedTaskId === task.id && !tasks.draftMode}
        onclick={() => selectTask(task.id)}
        style={tasks.focusedTaskId === task.id && !tasks.draftMode
          ? 'background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);'
          : ''}
      >
        <span class="truncate font-medium">{shortGoal(task.goal)}</span>
        <span class="flex items-center gap-1" style="opacity: 0.8;">
          <vscode-badge>{statusLabel(task.viewStatus)}</vscode-badge>
          {#if task.continuationOf}
            <span style="font-size: 10px;">↳ cont.</span>
          {/if}
        </span>
      </button>
    {:else}
      {#if !tasks.draftMode}
        <div class="px-2 py-4 text-center text-xs" style="opacity: 0.6;">No tasks yet.</div>
      {/if}
    {/each}
  </div>
</aside>