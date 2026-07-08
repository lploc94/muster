<script lang="ts">
  import { tasks } from '../lib/tasks.svelte';
  import { post, statusLabel } from '../lib/protocol';
  import { backendShortLabel } from '../lib/backends';
  import { tip } from '../lib/tooltip';

  interface Props {
    variant?: 'full' | 'dropdown' | 'sidebar';
    onSelect?: (taskId: string) => void;
    onClear?: () => void;
  }

  let { variant = 'sidebar', onSelect, onClear }: Props = $props();

  function selectTask(taskId: string) {
    if (onSelect) {
      onSelect(taskId);
    } else {
      tasks.focusTask(taskId);
      post({ type: 'focusTask', taskId });
      post({ type: 'hydrateSubtree', taskId });
    }
  }

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    if (trimmed.length <= 48) return trimmed || '(no goal)';
    return `${trimmed.slice(0, 45)}…`;
  }

  const isCompact = $derived(variant === 'dropdown');
</script>

<div
  class={isCompact ? 'p-1' : 'flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 flex flex-col gap-1'}
  style={!isCompact ? 'background: var(--vscode-sideBar-background, transparent);' : ''}
>
  {#if tasks.draftMode && !isCompact}
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
      class="w-full text-left rounded px-2 py-1.5 text-xs flex flex-col gap-0.5 hover:bg-[var(--vscode-list-hoverBackground)]"
      class:selected={tasks.focusedTaskId === task.id && !tasks.draftMode && !isCompact}
      onclick={() => selectTask(task.id)}
      style={tasks.focusedTaskId === task.id && !tasks.draftMode && !isCompact
        ? 'background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);'
        : ''}
    >
      <span class="truncate font-medium">{shortGoal(task.goal)}</span>
      <span class="flex items-center gap-1 flex-wrap" style="opacity: 0.85;">
        <vscode-badge>{statusLabel(task.viewStatus)}</vscode-badge>
        {#if task.backend}
          <span class="text-[11px] leading-[14px] opacity-70">{backendShortLabel(task.backend)}</span>
        {/if}
        {#if task.continuationOf}
          <span style="font-size: 10px;">↳ cont.</span>
        {/if}
        <span class="ml-auto text-[10px] opacity-60" use:tip={task.updatedAt}>
          {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
    </button>
  {:else}
    {#if !tasks.draftMode}
      <div class="px-2 py-4 text-center text-xs" style="opacity: 0.6;">No previous tasks.</div>
    {/if}
  {/each}

  {#if variant === 'full' && tasks.rootTasks.length > 0}
    <div class="mt-3 pt-2 border-t flex justify-end" style="border-color: var(--vscode-panel-border);">
      <button
        type="button"
        class="icon-btn"
        style="width: 22px; height: 22px;"
        onclick={() => onClear && onClear()}
        aria-label="Clear history"
        use:tip={'Clear history'}
      >
        <span class="codicon codicon-trash"></span>
      </button>
    </div>
  {/if}
</div>