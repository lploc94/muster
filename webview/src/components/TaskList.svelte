<script lang="ts">
  import { tasks } from '../lib/tasks.svelte';
  import { post } from '../lib/protocol';
  import { getTaskStatusPresentation, isTaskStatusTerminal } from '../lib/task-status';
  import type { TaskSummary, TaskViewStatus } from '../lib/protocol';

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

  function statusClass(status: TaskViewStatus): string {
    return `task-status task-status--${getTaskStatusPresentation(status).tone}`;
  }

  function taskStateFlags(task: TaskSummary): string[] {
    const flags: string[] = [];
    if (task.viewStatus === 'running') flags.push('Active turn');
    if (task.viewStatus === 'queued') flags.push('Queued turn');
    if (task.viewStatus === 'waiting_user') flags.push('Waiting for answer');
    if (task.viewStatus === 'needs_recovery') flags.push('Recovery needed');
    if (task.viewStatus === 'failed') flags.push('Failed terminal task');
    if (task.viewStatus === 'cancelled') flags.push('Cancelled terminal task');
    if (isTaskStatusTerminal(task.viewStatus) && task.viewStatus !== 'failed' && task.viewStatus !== 'cancelled') {
      flags.push('Terminal task');
    }
    if (task.backend) flags.push(`Backend ${task.backend}`);
    if (task.continuationOf) flags.push('Continuation');
    return flags;
  }

  function taskAriaLabel(task: TaskSummary): string {
    const presentation = getTaskStatusPresentation(task.viewStatus);
    const flags = taskStateFlags(task);
    return [shortGoal(task.goal), presentation.label, presentation.listCopy, ...flags].join(' ');
  }

  function itemClass(task: TaskSummary): string {
    const classes = [
      'task-list-item',
      'w-full',
      'text-left',
      'rounded',
      'px-2',
      'py-1.5',
      'text-xs',
      'flex',
      'flex-col',
      'gap-1',
    ];
    if (tasks.focusedTaskId === task.id && !tasks.draftMode && variant !== 'dropdown') {
      classes.push('selected', 'task-list-item--selected');
    }
    if (task.viewStatus === 'running' || task.viewStatus === 'queued') classes.push('task-list-item--active');
    if (task.viewStatus === 'waiting_user' || task.viewStatus === 'needs_recovery' || task.viewStatus === 'blocked') {
      classes.push('task-list-item--attention');
    }
    if (isTaskStatusTerminal(task.viewStatus)) classes.push('task-list-item--terminal');
    return classes.join(' ');
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
    {@const presentation = getTaskStatusPresentation(task.viewStatus)}
    {@const flags = taskStateFlags(task)}
    <button
      type="button"
      class={itemClass(task)}
      aria-label={taskAriaLabel(task)}
      onclick={() => selectTask(task.id)}
      style={tasks.focusedTaskId === task.id && !tasks.draftMode && !isCompact
        ? 'background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);'
        : ''}
    >
      <span class="truncate font-medium">{shortGoal(task.goal)}</span>
      <span class="flex items-center gap-1 flex-wrap" style="opacity: 0.9;">
        <vscode-badge class={statusClass(task.viewStatus)}>{presentation.label}</vscode-badge>
        {#if !isCompact}
          <span class="task-list-copy">{presentation.listCopy}</span>
        {/if}
        {#if task.backend}
          <span class="task-pill task-pill--muted">{task.backend}</span>
        {/if}
        {#if task.continuationOf}
          <span class="task-pill task-pill--muted">cont.</span>
        {/if}
        <span class="ml-auto text-[10px] opacity-60" title={task.updatedAt}>
          {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
      {#if flags.length > 0}
        <span class="sr-only">{flags.join(', ')}</span>
      {/if}
    </button>
  {:else}
    {#if !tasks.draftMode}
      <div class="px-2 py-4 text-center text-xs" style="opacity: 0.6;">No previous tasks.</div>
    {/if}
  {/each}

  {#if variant === 'full' && tasks.rootTasks.length > 0}
    <div class="mt-3 pt-2 border-t flex justify-end" style="border-color: var(--vscode-panel-border);">
      <button type="button" class="text-xs underline opacity-70" onclick={() => onClear && onClear()}>Clear history</button>
    </div>
  {/if}
</div>
