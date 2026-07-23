<script lang="ts">
  import type { ToolItem } from '../lib/turn-state.svelte';

  interface Props {
    tool: ToolItem;
  }
  let { tool }: Props = $props();

  let expanded = $state(false);

  function toolIcon(name: string, kind?: string): string {
    const n = (name || '').toLowerCase();
    if (n.includes('read') || n.includes('file') || n.includes('cat')) return 'codicon-file';
    if (n.includes('write') || n.includes('edit') || n.includes('patch')) return 'codicon-edit';
    if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'codicon-search';
    if (n.includes('bash') || n.includes('exec') || n.includes('run') || n.includes('shell'))
      return 'codicon-terminal';
    if (kind === 'mcp') return 'codicon-plug';
    return 'codicon-tools';
  }

  const icon = $derived(toolIcon(tool.name, tool.toolKind));
  const resultPayload = $derived(
    tool.status === 'error' && tool.error ? tool.error : tool.output,
  );
  const hasDetails = $derived(tool.input !== undefined || tool.output !== undefined || !!tool.error);
</script>

<div class="tool-card rounded px-2 py-1 text-xs border" style="border-color: var(--vscode-panel-border);">
  <button
    type="button"
    class="flex items-center gap-2 w-full text-left"
    class:cursor-pointer={hasDetails}
    disabled={!hasDetails}
    aria-expanded={hasDetails ? expanded : undefined}
    onclick={() => {
      if (hasDetails) expanded = !expanded;
    }}
  >
    <span class="codicon {icon}"></span>
    {#if tool.toolKind === 'mcp'}<vscode-badge>MCP</vscode-badge>{/if}
    <span class="font-mono break-all flex-1">{tool.name}</span>
    <span style="color: var(--vscode-descriptionForeground); font-size: 10px;">
      {tool.status === 'running' ? 'running…' : tool.status}
    </span>
    {#if hasDetails}
      <span class="codicon {expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}" style="font-size: 12px;"></span>
    {/if}
  </button>

  {#if expanded && hasDetails}
    {#if tool.input !== undefined}
      <div class="tool-card__details mt-1.5">
        <div class="text-[10px] opacity-70 mb-0.5">params:</div>
        <pre class="tool-card__payload text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded max-h-40 whitespace-pre">{typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>
      </div>
    {/if}

    {#if resultPayload !== undefined}
      <div class="tool-card__details mt-1.5">
        <div class="text-[10px] opacity-70 mb-0.5">result:</div>
        <pre
          class="tool-card__payload text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded max-h-40 whitespace-pre"
          style:color={tool.status === 'error' ? 'var(--vscode-errorForeground)' : undefined}
        >{typeof resultPayload === 'string' ? resultPayload : JSON.stringify(resultPayload, null, 2)}</pre>
      </div>
    {/if}
  {/if}
</div>

<style>
  .tool-card,
  .tool-card__details {
    min-width: 0;
    max-width: 100%;
  }

  .tool-card {
    overflow: hidden;
  }

  .tool-card__payload {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    margin: 0;
    overflow: auto;
  }
</style>
