<script lang="ts">
  import { thread } from '../lib/turn-state.svelte';
  import { post } from '../lib/protocol';

  function newSession() {
    post({ type: 'newSession' });
  }

  const shortId = $derived(thread.sessionId ? thread.sessionId.slice(0, 8) : null);
</script>

<div
  class="flex items-center gap-2 px-2 py-1 border-b"
  style="border-color: var(--vscode-panel-border);"
>
  <span class="font-semibold">Muster</span>

  <vscode-single-select disabled value="claude" title="Backend">
    <vscode-option value="claude">Claude</vscode-option>
  </vscode-single-select>

  {#if shortId}
    <vscode-badge title={thread.sessionId}>{shortId}</vscode-badge>
  {/if}

  <span class="flex-1"></span>

  {#if thread.running}
    <vscode-badge>running…</vscode-badge>
  {/if}

  <vscode-button secondary onclick={newSession}>New Session</vscode-button>
</div>
