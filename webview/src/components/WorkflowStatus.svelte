<script lang="ts">
  import type { WorkflowSummaryView } from '../lib/protocol';

  interface Props {
    workflow?: WorkflowSummaryView;
  }
  let { workflow }: Props = $props();
</script>

{#if workflow}
  <div
    class="flex flex-wrap items-center gap-2 text-xs text-[var(--vscode-descriptionForeground)]"
    role="status"
    aria-label="Workflow phase {workflow.phase}"
  >
    <span
      class="rounded px-1.5 py-0.5 font-medium bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]"
    >
      {workflow.phase}
    </span>
    {#if workflow.planRevision > 0}
      <span>plan r{workflow.planRevision}</span>
    {/if}
    {#if workflow.approvalStatus}
      <span>approval: {workflow.approvalStatus}</span>
    {/if}
    {#if workflow.confidence}
      <span>confidence: {workflow.confidence}</span>
    {/if}
  </div>
{/if}
