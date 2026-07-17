<script lang="ts">
  import { tasks } from '../lib/tasks.svelte';
  import { post, type TaskSummary } from '../lib/protocol';
  import { getLifecyclePresentation, isSoftTerminal } from '../lib/task-status';
  import { backendModelLabel } from '../lib/backends';
  import { selectTask as navSelectTask } from '../lib/task-nav';
  import { tip } from '../lib/tooltip';

  interface Props {
    variant?: 'full' | 'dropdown' | 'sidebar';
    onSelect?: (taskId: string) => void;
    onDelete?: (taskId: string) => void;
    onRename?: (taskId: string, goal: string) => void;
  }

  let { variant = 'sidebar', onSelect, onDelete, onRename }: Props = $props();

  const isFull = $derived(variant === 'full');
  const isCompact = $derived(variant === 'dropdown');

  // Full-variant local UI state.
  let query = $state('');
  let editingId = $state<string | null>(null);
  let editValue = $state('');
  let renameError = $state<string | null>(null);
  let confirmDeleteId = $state<string | null>(null);

  const renameErrorId = 'task-rename-error';

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks.rootTasks;
    return tasks.rootTasks.filter((t) => t.goal.toLowerCase().includes(q));
  });

  function selectTask(taskId: string) {
    if (editingId) return;
    if (onSelect) {
      onSelect(taskId);
    } else {
      navSelectTask(taskId);
    }
  }

  function shortGoal(goal: string): string {
    const trimmed = goal.trim();
    if (trimmed.length <= 48) return trimmed || '(no goal)';
    return `${trimmed.slice(0, 45)}…`;
  }

  function lifecycleClass(lifecycle: string): string {
    return `task-status task-status--${getLifecyclePresentation(lifecycle).tone}`;
  }

  function taskStateFlags(task: TaskSummary): string[] {
    const flags: string[] = [];
    const activity = task.currentTurnActivity?.state;
    flags.push(`Task ${getLifecyclePresentation(task.lifecycle).label}`);
    if (activity === 'executing') flags.push('Turn working');
    if (activity === 'waiting_you') flags.push('Waiting for you');
    if (isSoftTerminal(task.lifecycle)) flags.push('Soft failed — send to reopen');
    if (task.childOrchestration?.label) flags.push(task.childOrchestration.label);
    if (task.backend) flags.push(`Backend ${task.backend}`);
    if (task.continuationOf) flags.push('Continuation');
    return flags;
  }

  function taskAriaLabel(task: TaskSummary): string {
    const flags = taskStateFlags(task);
    return [shortGoal(task.goal), ...flags].join(' ');
  }

  /** True when host turn activity is live (executing or waiting for the user). */
  function isTurnLive(task: TaskSummary): boolean {
    const activity = task.currentTurnActivity?.state;
    return activity === 'executing' || activity === 'waiting_you';
  }

  function startRename(task: TaskSummary) {
    confirmDeleteId = null;
    renameError = null;
    editingId = task.id;
    editValue = task.goal;
  }
  function commitRename() {
    const id = editingId;
    if (!id) return;
    const v = editValue.trim();
    if (!v) {
      // Keep edit mode open and associate visible error text for AT users.
      renameError = 'Task name cannot be empty or whitespace.';
      return;
    }
    renameError = null;
    editingId = null;
    if (onRename) onRename(id, v);
  }
  function cancelRename() {
    renameError = null;
    editingId = null;
  }
  function onEditInput() {
    if (renameError) renameError = null;
  }
  function onEditKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }
  // Focus + select the rename input as soon as it mounts.
  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function requestDelete(id: string) {
    editingId = null;
    confirmDeleteId = id;
  }
  function confirmDelete(id: string) {
    confirmDeleteId = null;
    if (onDelete) onDelete(id);
  }
</script>

{#if isFull}
  <div class="flex-1 min-h-0 flex flex-col" style="background: var(--vscode-sideBar-background, transparent);">
    <!-- Search -->
    <div class="px-2 pt-2 pb-1 shrink-0">
      <div
        class="flex items-center gap-1.5 rounded px-2 py-1"
        style="background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);"
      >
        <span class="codicon codicon-search" style="font-size: 13px; opacity: 0.6;"></span>
        <input
          type="search"
          class="task-list__search-input flex-1 min-w-0 bg-transparent border-none text-xs"
          style="color: var(--vscode-input-foreground);"
          placeholder="Search tasks…"
          aria-label="Search tasks"
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="icon-btn shrink-0"
            aria-label="Clear search"
            use:tip={'Clear search'}
            onclick={() => (query = '')}
          >
            <span class="codicon codicon-close" style="font-size: 12px;"></span>
          </button>
        {/if}
      </div>
    </div>

    <!-- List -->
    <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 flex flex-col gap-1">
      {#if tasks.draftMode}
        <div
          class="rounded px-2 py-1.5 text-xs"
          style="background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);"
        >
          New task (draft)
        </div>
      {/if}

      {#each filtered as task (task.id)}
        {@const flags = taskStateFlags(task)}
        {@const turnLive = isTurnLive(task)}
        {@const isSel = tasks.focusedTaskId === task.id && !tasks.draftMode}
        {@const isEditing = editingId === task.id}
        {@const isConfirming = confirmDeleteId === task.id}
        <div
          class="group relative rounded flex items-center gap-1 pl-2 pr-1 py-1.5 text-xs hover:bg-[var(--vscode-list-hoverBackground)]"
          style={isSel
            ? 'background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);'
            : ''}
        >
          {#if isEditing}
            <div class="flex-1 min-w-0 flex flex-col gap-0.5">
              <div class="flex items-center gap-1 min-w-0">
                <input
                  type="text"
                  class="task-list__rename-input flex-1 min-w-0 rounded px-1 py-0.5 text-xs"
                  style="color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder);"
                  aria-label="Task name"
                  aria-invalid={renameError ? 'true' : 'false'}
                  aria-describedby={renameError ? renameErrorId : undefined}
                  bind:value={editValue}
                  oninput={onEditInput}
                  onkeydown={onEditKey}
                  onblur={commitRename}
                  use:autofocus
                />
                <button
                  type="button"
                  class="icon-btn icon-btn--dense shrink-0"
                  aria-label="Save name"
                  use:tip={'Save'}
                  onmousedown={(e) => e.preventDefault()}
                  onclick={commitRename}
                >
                  <span class="codicon codicon-check"></span>
                </button>
                <button
                  type="button"
                  class="icon-btn icon-btn--dense shrink-0"
                  aria-label="Cancel rename"
                  use:tip={'Cancel'}
                  onmousedown={(e) => e.preventDefault()}
                  onclick={cancelRename}
                >
                  <span class="codicon codicon-close"></span>
                </button>
              </div>
              {#if renameError}
                <div
                  id={renameErrorId}
                  class="task-list__rename-error"
                  role="alert"
                >
                  {renameError}
                </div>
              {/if}
            </div>
          {:else}
            <button
              type="button"
              class="flex-1 min-w-0 text-left flex flex-col gap-0.5"
              aria-label={taskAriaLabel(task)}
              onclick={() => selectTask(task.id)}
            >
              <span class="truncate font-medium">{shortGoal(task.goal)}</span>
              <span class="flex items-center gap-1 flex-wrap" style="opacity: 0.85;">
                <vscode-badge
                  class={lifecycleClass(task.lifecycle)}
                  use:tip={`Task status: ${getLifecyclePresentation(task.lifecycle).listCopy}`}
                >
                  {getLifecyclePresentation(task.lifecycle).label}
                </vscode-badge>
                {#if turnLive}
                  <span
                    class="turn-live-dot"
                    use:tip={'Turn is active (not task outcome)'}
                    aria-label="Turn active"
                  ></span>
                {/if}
                {#if task.backend}
                  <span class="text-[11px] leading-[14px] opacity-70"
                    >{backendModelLabel(task.backend, task.model)}</span
                  >
                {/if}
                {#if task.continuationOf}
                  <span style="font-size: 10px;">↳ cont.</span>
                {/if}
                {#if task.childOrchestration?.label}
                  <span class="text-[10px] leading-[12px] opacity-75" use:tip={task.childOrchestration.label}
                    >{task.childOrchestration.label}</span
                  >
                {/if}
                <span class="ml-auto text-[10px] opacity-60" use:tip={task.updatedAt}>
                  {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
              {#if flags.length > 0}
                <span class="sr-only">{flags.join(', ')}</span>
              {/if}
            </button>

            <div
              class="shrink-0 flex items-center gap-0.5 transition-opacity {isConfirming
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}"
            >
              {#if isConfirming}
                <button
                  type="button"
                  class="icon-btn icon-btn--dense"
                  aria-label="Confirm delete"
                  use:tip={'Confirm delete'}
                  onclick={() => confirmDelete(task.id)}
                >
                  <span class="codicon codicon-check" style="color: var(--vscode-errorForeground);"></span>
                </button>
                <button
                  type="button"
                  class="icon-btn icon-btn--dense"
                  aria-label="Cancel delete"
                  use:tip={'Cancel'}
                  onclick={() => (confirmDeleteId = null)}
                >
                  <span class="codicon codicon-close"></span>
                </button>
              {:else}
                <button
                  type="button"
                  class="icon-btn icon-btn--dense"
                  aria-label="Rename task"
                  use:tip={'Rename'}
                  onclick={() => startRename(task)}
                >
                  <span class="codicon codicon-edit"></span>
                </button>
                <button
                  type="button"
                  class="icon-btn icon-btn--dense"
                  aria-label="Delete task"
                  use:tip={'Delete'}
                  onclick={() => requestDelete(task.id)}
                >
                  <span class="codicon codicon-trash"></span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        {#if !tasks.draftMode}
          <div class="px-2 py-4 text-center text-xs" style="opacity: 0.6;">
            {query ? 'No matching tasks.' : 'No previous tasks.'}
          </div>
        {/if}
      {/each}
    </div>
  </div>
{:else}
  <!-- dropdown / sidebar: compact select-only rows -->
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
      {@const flags = taskStateFlags(task)}
      {@const turnLive = isTurnLive(task)}
      <button
        type="button"
        class="w-full text-left rounded px-2 py-1.5 text-xs flex flex-col gap-0.5 hover:bg-[var(--vscode-list-hoverBackground)]"
        aria-label={taskAriaLabel(task)}
        onclick={() => selectTask(task.id)}
        style={tasks.focusedTaskId === task.id && !tasks.draftMode && !isCompact
          ? 'background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);'
          : ''}
      >
        <span class="truncate font-medium">{shortGoal(task.goal)}</span>
        <span class="flex items-center gap-1 flex-wrap" style="opacity: 0.85;">
          <vscode-badge
            class={lifecycleClass(task.lifecycle)}
            use:tip={`Task status: ${getLifecyclePresentation(task.lifecycle).listCopy}`}
          >
            {getLifecyclePresentation(task.lifecycle).label}
          </vscode-badge>
          {#if turnLive}
            <span
              class="turn-live-dot"
              use:tip={'Turn is active (not task outcome)'}
              aria-label="Turn active"
            ></span>
          {/if}
          {#if task.backend}
            <span class="text-[11px] leading-[14px] opacity-70"
              >{backendModelLabel(task.backend, task.model)}</span
            >
          {/if}
          {#if task.continuationOf}
            <span style="font-size: 10px;">↳ cont.</span>
          {/if}
          <span class="ml-auto text-[10px] opacity-60" use:tip={task.updatedAt}>
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
  </div>
{/if}
