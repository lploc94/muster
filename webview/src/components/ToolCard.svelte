<script lang="ts">
  import type { ToolItem } from '../lib/turn-state.svelte';

  interface Props {
    tool: ToolItem;
  }
  let { tool }: Props = $props();

  let expanded = $state(false);

  function getToolIcon(name: string, kind?: string) {
    const n = (name || '').toLowerCase();
    if (n.includes('read') || n.includes('file') || n.includes('cat')) return '📄';
    if (n.includes('write') || n.includes('edit') || n.includes('patch')) return '✏️';
    if (n.includes('search') || n.includes('grep') || n.includes('find')) return '🔍';
    if (n.includes('bash') || n.includes('exec') || n.includes('run') || n.includes('shell')) return '💻';
    if (kind === 'mcp') return '🔌';
    return '⚙️';
  }

  const icon = $derived(getToolIcon(tool.name, tool.toolKind));
  const hasDetails = $derived(tool.input !== undefined || tool.output !== undefined || tool.error);
</script>

<div class="rounded px-2 py-1 text-xs border" style="border-color: var(--vscode-panel-border);">
  <div 
    class="flex items-center gap-2 cursor-pointer"
    onclick={() => { if (hasDetails) expanded = !expanded; }}
  >
    <span class="text-base">{icon}</span>
    {#if tool.toolKind === 'mcp'}<vscode-badge>MCP</vscode-badge>{/if}
    <span class="font-mono break-all flex-1">{tool.name}</span>
    <span style="color: var(--vscode-descriptionForeground); font-size: 10px;">
      {tool.status === 'running' ? 'running…' : tool.status}
    </span>
    {#if hasDetails}
      <span class="text-[10px] opacity-60">{expanded ? '▼' : '▶'}</span>
    {/if}
  </div>

  {#if expanded && hasDetails}
    {#if tool.input !== undefined}
      <div class="mt-1.5">
        <div class="text-[10px] opacity-70 mb-0.5">params:</div>
        <pre class="text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded overflow-auto max-h-40 whitespace-pre">{typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>
      </div>
    {/if}

    {#if tool.output !== undefined}
      <div class="mt-1.5">
        <div class="text-[10px] opacity-70 mb-0.5">result:</div>
        <pre class="text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded overflow-auto max-h-40 whitespace-pre">{typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}</pre>
      </div>
    {/if}

    {#if tool.status === 'error' && tool.error}
      <div class="mt-1 text-[var(--vscode-errorForeground)] whitespace-pre-wrap">{tool.error}</div>
    {/if}
  {/if}
</div>
