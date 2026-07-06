<script lang="ts">
  import { thread } from '../lib/turn-state.svelte';
  import { post } from '../lib/protocol';

  // vscode-textarea is a custom element exposing a `.value` property.
  let textareaEl: (HTMLElement & { value: string }) | undefined;

  function send() {
    if (thread.running || !textareaEl) return;
    const value = (textareaEl.value ?? '').trim();
    if (!value) return;
    post({ type: 'send', text: value });
    textareaEl.value = '';
  }

  function cancel() {
    post({ type: 'cancelTurn' });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="border-t p-2 flex flex-col gap-2" style="border-color: var(--vscode-panel-border);">
  <vscode-textarea
    bind:this={textareaEl}
    rows={3}
    placeholder="Message Claude…  (Enter to send, Shift+Enter for newline)"
    disabled={thread.running}
    onkeydown={onKeydown}
    style="width: 100%;"
  ></vscode-textarea>

  <div class="flex gap-2 justify-end">
    {#if thread.running}
      <vscode-button secondary onclick={cancel}>Cancel</vscode-button>
    {:else}
      <vscode-button onclick={send}>Send</vscode-button>
    {/if}
  </div>
</div>
