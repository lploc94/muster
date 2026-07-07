<script lang="ts">
  import type { ToolItem } from '../lib/turn-state.svelte';

  interface Props {
    tool: ToolItem;
  }
  let { tool }: Props = $props();
</script>

<div class="rounded px-2 py-1 text-xs" style="border: 1px solid var(--vscode-panel-border);">
  <div class="flex items-center gap-2">
    {#if tool.toolKind === 'mcp'}<vscode-badge>MCP</vscode-badge>{/if}
    <span class="font-mono break-all">{tool.name}</span>
    <span class="flex-1"></span>
    <span style="color: var(--vscode-descriptionForeground);">
      {tool.status === 'running' ? 'running…' : tool.status}
    </span>
  </div>

  {#if tool.input !== undefined}
    <div class="mt-1 text-[10px] opacity-70">params:</div>
    <pre class="mt-0.5 text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(tool.input, null, 2)}</pre>
  {/if}

  {#if tool.output !== undefined}
    <div class="mt-1 text-[10px] opacity-70">result:</div>
    <pre class="mt-0.5 text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(tool.output, null, 2)}</pre>
  {/if}

  {#if tool.status === 'error' && tool.error}
    <div class="mt-1 whitespace-pre-wrap" style="color: var(--vscode-errorForeground);">{tool.error}</div>
  {/if}
</div>
