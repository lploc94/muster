<script lang="ts">
  interface Props {
    role: 'user' | 'assistant';
    text: string;
    streaming?: boolean;
  }
  let { role, text, streaming = false }: Props = $props();
</script>

<div class="flex flex-col" class:items-end={role === 'user'}>
  <div
    class="max-w-full whitespace-pre-wrap break-words rounded px-2 py-1"
    style={role === 'user'
      ? 'background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);'
      : 'background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border);'}
  >{text}{#if streaming}<span style="opacity: 0.6;">▋</span>{/if}</div>
</div>
