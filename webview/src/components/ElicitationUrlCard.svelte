<script lang="ts">
  import { post } from '../lib/protocol';

  interface Props {
    promptId: string;
    elicitationId: string;
    url: string;
    message: string;
    waiting?: boolean;
  }

  let { promptId, url, message, waiting = false }: Props = $props();
  let submitting = $state(false);

  function submit(action: 'accept' | 'decline' | 'cancel'): void {
    if (submitting || waiting) return;
    submitting = true;
    post({ type: 'submitElicitation', promptId, action });
  }

  function domainOf(u: string): string {
    try {
      return new URL(u).hostname;
    } catch {
      return u;
    }
  }
</script>

<div
  class="mx-2 my-1 rounded p-2 flex flex-col gap-2 text-xs"
  style="border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); background: var(--vscode-editor-background);"
>
  <div class="font-semibold">{waiting ? 'Waiting for external auth…' : 'External authorization'}</div>
  {#if message}
    <div class="whitespace-pre-wrap">{message}</div>
  {/if}
  <div class="break-all">
    <span class="opacity-80">URL:</span>
    <strong>{domainOf(url)}</strong>
    <div class="opacity-70 text-[11px] mt-0.5">{url}</div>
  </div>
  {#if !waiting}
    <div class="flex gap-2 justify-end flex-wrap">
      <vscode-button secondary disabled={submitting} onclick={() => submit('cancel')}>Dismiss</vscode-button>
      <vscode-button secondary disabled={submitting} onclick={() => submit('decline')}>Decline</vscode-button>
      <vscode-button disabled={submitting} onclick={() => submit('accept')}>Open & continue</vscode-button>
    </div>
  {/if}
</div>
