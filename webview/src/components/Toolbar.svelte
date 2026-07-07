<script lang="ts">
  interface Props {
    inChat?: boolean;
    historyOpen?: boolean;
    toggleHistory?: () => void;
  }

  let { inChat = false }: Props = $props();
</script>

<div
  class="flex items-center gap-2 px-3 py-1 border-b shrink-0"
  style="border-color: var(--vscode-panel-border); background: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background));"
>
  <span class="font-semibold">Muster</span>

  {#if !inChat}
    <span class="text-xs opacity-60">— previous tasks</span>
  {/if}

  <span class="flex-1"></span>
</div>