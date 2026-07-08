<script lang="ts">
  interface Props {
    inChat?: boolean;
    historyOpen?: boolean;
    toggleHistory?: () => void;
  }

  let { inChat = false }: Props = $props();
</script>

<div
  class="flex items-center gap-2 pl-5 pr-3 py-1 border-b shrink-0"
  style="border-color: var(--vscode-panel-border); background: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background));"
>
  <span class="font-semibold">Muster{#if !inChat}<span class="text-xs opacity-60 font-normal">&nbsp;- Previous Tasks</span>{/if}</span>

  <span class="flex-1"></span>
</div>