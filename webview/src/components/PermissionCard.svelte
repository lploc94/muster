<script lang="ts">
  import { post } from '../lib/protocol';
  import type { PermissionClass, PermissionOptionView } from '../lib/protocol';

  interface Props {
    permissionId: string;
    title: string;
    kind: string;
    classification: PermissionClass;
    options: PermissionOptionView[];
  }

  let { permissionId, title, kind, classification, options }: Props = $props();

  let remember = $state(false);

  // Split the offered options: allow-type render as action buttons; the first
  // reject/deny option (if any) backs the explicit Deny button.
  const rejectOption = $derived(options.find((o) => /reject|deny/i.test(o.kind)));
  const allowOptions = $derived(options.filter((o) => !/reject|deny/i.test(o.kind)));

  function choose(optionId: string): void {
    post({ type: 'submitPermission', permissionId, optionId, remember });
  }

  function deny(): void {
    // Prefer an explicit reject option so the agent gets a clean "denied";
    // otherwise cancel the prompt (host maps that to a safe deny).
    if (rejectOption) {
      post({ type: 'submitPermission', permissionId, optionId: rejectOption.optionId, remember: false });
    } else {
      post({ type: 'cancelPermission', permissionId });
    }
  }

  function classLabel(cls: PermissionClass): string {
    switch (cls) {
      case 'read':
        return 'read-only';
      case 'write':
        return 'write / command';
      default:
        return 'potentially unsafe';
    }
  }
</script>

<div
  class="mx-2 my-1 rounded p-2 flex flex-col gap-2 text-xs"
  style="border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); background: var(--vscode-editor-background);"
>
  <div class="flex items-center gap-2">
    <span class="codicon codicon-shield" style="font-size: 14px;"></span>
    <span class="font-semibold">Permission request</span>
    <vscode-badge>{kind}</vscode-badge>
  </div>

  <div class="whitespace-pre-wrap font-medium">{title}</div>
  <div style="opacity: 0.85;">
    This agent wants to run a {classLabel(classification)} action.
  </div>

  <vscode-checkbox
    checked={remember}
    onchange={(e: Event) => {
      remember = !!(e.target as HTMLInputElement & { checked?: boolean })?.checked;
    }}
  >Remember for this session</vscode-checkbox>

  <div class="flex flex-wrap gap-2 justify-end">
    <vscode-button secondary onclick={deny}>Deny</vscode-button>
    {#each allowOptions as option (option.optionId)}
      <vscode-button onclick={() => choose(option.optionId)}>{option.name}</vscode-button>
    {/each}
  </div>
</div>
