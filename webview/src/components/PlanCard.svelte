<script lang="ts">
  import type { WorkflowSummaryView } from '../lib/protocol';
  import { post } from '../lib/protocol';

  interface Props {
    workflow?: WorkflowSummaryView;
    taskId?: string;
  }
  let { workflow, taskId }: Props = $props();

  function approve() {
    post({ type: 'runCommand', text: '/approve', taskId });
  }
  function replan() {
    post({ type: 'runCommand', text: '/replan', taskId });
  }
</script>

{#if workflow && (workflow.phase === 'awaiting_plan_approval' || workflow.currentPlanTitle)}
  <section
    class="my-2 rounded border border-[var(--vscode-widget-border)] bg-[var(--vscode-editor-background)] p-3"
    aria-label="Plan card"
  >
    <header class="mb-1 flex items-center justify-between gap-2">
      <h3 class="m-0 text-sm font-semibold text-[var(--vscode-foreground)]">
        {workflow.currentPlanTitle ?? 'Plan'}
      </h3>
      <span class="text-xs text-[var(--vscode-descriptionForeground)]">
        r{workflow.planRevision} · {workflow.approvalStatus ?? workflow.phase}
      </span>
    </header>
    {#if workflow.currentPlanSummary}
      <p class="m-0 mb-2 text-xs text-[var(--vscode-descriptionForeground)]">
        {workflow.currentPlanSummary}
      </p>
    {/if}
    {#if workflow.phase === 'awaiting_plan_approval'}
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-xs text-[var(--vscode-button-foreground)]"
          onclick={approve}
        >
          Approve plan
        </button>
        <button
          type="button"
          class="rounded border border-[var(--vscode-button-border,transparent)] px-2 py-1 text-xs"
          onclick={replan}
        >
          Replan
        </button>
      </div>
    {/if}
  </section>
{/if}
