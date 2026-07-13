<script lang="ts">
  import { post } from '../lib/protocol';

  interface Field {
    key: string;
    type: string;
    title?: string;
    description?: string;
    options?: string[];
    required?: boolean;
    default?: unknown;
  }

  interface Props {
    promptId: string;
    message: string;
    fields: Field[];
    required: string[];
    askLike?: boolean;
  }

  let { promptId, message, fields, required, askLike = false }: Props = $props();

  let values = $state<Record<string, unknown>>({});
  let submitting = $state(false);

  function initDefaults(): void {
    const next: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.default !== undefined) next[f.key] = f.default;
      else if (f.type === 'boolean') next[f.key] = false;
      else if (f.type === 'multiEnum') next[f.key] = [];
    }
    values = next;
  }
  initDefaults();

  function setValue(key: string, value: unknown): void {
    values = { ...values, [key]: value };
  }

  function toggleMulti(key: string, option: string): void {
    const cur = Array.isArray(values[key]) ? [...(values[key] as string[])] : [];
    const idx = cur.indexOf(option);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(option);
    setValue(key, cur);
  }

  function submit(action: 'accept' | 'decline' | 'cancel'): void {
    if (submitting) return;
    if (action === 'accept') {
      // Client-side checks so host validation failure does not lock the form.
      for (const f of fields) {
        const need = f.required || required.includes(f.key);
        const v = values[f.key];
        if (need && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) {
          return;
        }
        if (typeof v === 'string') {
          const minL = (f as { minLength?: number }).minLength;
          const maxL = (f as { maxLength?: number }).maxLength;
          if (minL !== undefined && v.length < minL) return;
          if (maxL !== undefined && v.length > maxL) return;
        }
        if (typeof v === 'number') {
          const min = (f as { minimum?: number }).minimum;
          const max = (f as { maximum?: number }).maximum;
          if (min !== undefined && v < min) return;
          if (max !== undefined && v > max) return;
        }
        if (Array.isArray(v)) {
          const minI = (f as { minItems?: number }).minItems;
          const maxI = (f as { maxItems?: number }).maxItems;
          if (minI !== undefined && v.length < minI) return;
          if (maxI !== undefined && v.length > maxI) return;
        }
      }
      // Do not lock permanently on host rejection — only disable during post.
      post({ type: 'submitElicitation', promptId, action, content: { ...values } });
    } else {
      submitting = true;
      post({ type: 'submitElicitation', promptId, action });
    }
  }
</script>

<div
  class="mx-2 my-1 rounded p-2 flex flex-col gap-2 text-xs"
  style="border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder)); background: var(--vscode-editor-background);"
>
  <div class="font-semibold">{askLike ? 'Agent question' : 'Agent request'}</div>
  {#if message}
    <div class="whitespace-pre-wrap opacity-90">{message}</div>
  {/if}

  {#each fields as f (f.key)}
    <div class="flex flex-col gap-1">
      <div class="font-medium">{f.title || f.key}{#if f.required || required.includes(f.key)} *{/if}</div>
      {#if f.description}
        <div class="opacity-80 whitespace-pre-wrap">{f.description}</div>
      {/if}

      {#if f.type === 'enum' && f.options}
        <vscode-radio-group
          onchange={(e: Event) => {
            const target = e.target as HTMLElement & { value?: string };
            if (typeof target?.value === 'string') setValue(f.key, target.value);
          }}
        >
          {#each f.options as option (option)}
            <vscode-radio value={option} name={`el-${promptId}-${f.key}`} checked={values[f.key] === option}
              >{option}</vscode-radio
            >
          {/each}
        </vscode-radio-group>
      {:else if f.type === 'multiEnum' && f.options}
        {#each f.options as option (option)}
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              checked={Array.isArray(values[f.key]) && (values[f.key] as string[]).includes(option)}
              onchange={() => toggleMulti(f.key, option)}
            />
            {option}
          </label>
        {/each}
      {:else if f.type === 'boolean'}
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!values[f.key]}
            onchange={(e: Event) =>
              setValue(f.key, (e.currentTarget as HTMLInputElement).checked)}
          />
          Yes
        </label>
      {:else if f.type === 'number' || f.type === 'integer'}
        <input
          type="number"
          class="px-1 py-0.5 rounded"
          style="border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground);"
          value={values[f.key] ?? ''}
          oninput={(e: Event) => {
            const raw = (e.currentTarget as HTMLInputElement).value;
            setValue(f.key, raw === '' ? undefined : Number(raw));
          }}
        />
      {:else}
        <vscode-textfield
          value={String(values[f.key] ?? '')}
          oninput={(e: Event) =>
            setValue(f.key, (e.currentTarget as HTMLInputElement & { value: string }).value)}
        ></vscode-textfield>
      {/if}
      {#if (f as { allowCustom?: boolean }).allowCustom}
        <vscode-textfield
          placeholder="Other…"
          value={String(values[`${f.key}_custom`] ?? '')}
          oninput={(e: Event) =>
            setValue(
              `${f.key}_custom`,
              (e.currentTarget as HTMLInputElement & { value: string }).value,
            )}
        ></vscode-textfield>
      {/if}
    </div>
  {/each}

  <div class="flex gap-2 justify-end flex-wrap">
    <vscode-button secondary disabled={submitting} onclick={() => submit('cancel')}>Dismiss</vscode-button>
    <vscode-button secondary disabled={submitting} onclick={() => submit('decline')}>Decline</vscode-button>
    <vscode-button disabled={submitting} onclick={() => submit('accept')}>Accept</vscode-button>
  </div>
</div>
