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
    submissionError?: string;
    submissionVersion?: number;
  }

  let {
    promptId,
    message,
    fields,
    required,
    askLike = false,
    submissionError,
    submissionVersion = 0,
  }: Props = $props();

  let values = $state<Record<string, unknown>>({});
  let submitting = $state(false);
  let localError = $state<string | null>(null);
  let fieldErrors = $state<Record<string, string>>({});
  let seenSubmissionVersion = $state(0);
  let focusedForPromptId = $state<string | null>(null);

  $effect(() => {
    if (submissionVersion > seenSubmissionVersion) {
      seenSubmissionVersion = submissionVersion;
      submitting = false;
    }
  });

  function sanitizeIdPart(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || 'field';
  }

  function fieldDomId(key: string): string {
    return `elicitation-${sanitizeIdPart(promptId)}-${sanitizeIdPart(key)}`;
  }

  function fieldTitleId(key: string): string {
    return `${fieldDomId(key)}-title`;
  }

  function fieldDescId(key: string): string {
    return `${fieldDomId(key)}-desc`;
  }

  function fieldErrorId(key: string): string {
    return `${fieldDomId(key)}-error`;
  }

  function isRequired(f: Field): boolean {
    return Boolean(f.required || required.includes(f.key));
  }

  function fieldLabel(f: Field): string {
    return f.title || f.key;
  }

  function describedBy(f: Field): string | undefined {
    const ids: string[] = [];
    if (f.description) ids.push(fieldDescId(f.key));
    if (fieldErrors[f.key]) ids.push(fieldErrorId(f.key));
    return ids.length > 0 ? ids.join(' ') : undefined;
  }

  function focusControl(id: string): void {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el) return;
    if (typeof el.focus === 'function') {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    const focusable =
      'input, textarea, select, button, [tabindex]:not([tabindex="-1"])';
    // Prefer shadow roots (vscode-* hosts), then light-DOM children (checkbox groups).
    const inner = (el.shadowRoot?.querySelector(focusable) ??
      el.querySelector(focusable)) as HTMLElement | null;
    if (inner && typeof inner.focus === 'function') {
      try {
        inner.focus();
      } catch {
        /* ignore */
      }
    }
  }

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

  // Focus first useful control when a blocking form mounts / prompt changes.
  $effect(() => {
    const currentPromptId = promptId;
    if (focusedForPromptId === currentPromptId) return;
    focusedForPromptId = currentPromptId;
    fieldErrors = {};
    localError = null;
    const first = fields[0];
    if (!first) return;
    const id = fieldDomId(first.key);
    queueMicrotask(() => focusControl(id));
  });

  function setValue(key: string, value: unknown): void {
    values = { ...values, [key]: value };
    if (fieldErrors[key]) {
      const next = { ...fieldErrors };
      delete next[key];
      fieldErrors = next;
      if (localError && Object.keys(next).length === 0) localError = null;
    }
  }

  function toggleMulti(key: string, option: string): void {
    const cur = Array.isArray(values[key]) ? [...(values[key] as string[])] : [];
    const idx = cur.indexOf(option);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(option);
    setValue(key, cur);
  }

  function plainValues(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      result[key] = Array.isArray(value) ? [...value] : value;
    }
    return result;
  }

  function validateAll(): { errors: Record<string, string>; firstKey: string | null } {
    const errors: Record<string, string> = {};
    let firstKey: string | null = null;

    for (const f of fields) {
      const need = isRequired(f);
      const v = values[f.key];
      let err: string | null = null;

      if (need && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) {
        err = `${fieldLabel(f)} is required.`;
      } else if (typeof v === 'string') {
        const minL = (f as { minLength?: number }).minLength;
        const maxL = (f as { maxLength?: number }).maxLength;
        if (minL !== undefined && v.length < minL) {
          err = `${fieldLabel(f)} must be at least ${minL} characters.`;
        } else if (maxL !== undefined && v.length > maxL) {
          err = `${fieldLabel(f)} must be at most ${maxL} characters.`;
        }
      } else if (typeof v === 'number') {
        const min = (f as { minimum?: number }).minimum;
        const max = (f as { maximum?: number }).maximum;
        if (min !== undefined && v < min) {
          err = `${fieldLabel(f)} must be at least ${min}.`;
        } else if (max !== undefined && v > max) {
          err = `${fieldLabel(f)} must be at most ${max}.`;
        }
      } else if (Array.isArray(v)) {
        const minI = (f as { minItems?: number }).minItems;
        const maxI = (f as { maxItems?: number }).maxItems;
        if (minI !== undefined && v.length < minI) {
          err = `${fieldLabel(f)} requires at least ${minI} selections.`;
        } else if (maxI !== undefined && v.length > maxI) {
          err = `${fieldLabel(f)} allows at most ${maxI} selections.`;
        }
      }

      if (err) {
        errors[f.key] = err;
        if (!firstKey) firstKey = f.key;
      }
    }

    return { errors, firstKey };
  }

  function submit(action: 'accept' | 'decline' | 'cancel'): void {
    if (submitting) return;
    localError = null;
    if (action === 'accept') {
      // Client-side checks so host validation failure does not lock the form.
      const { errors, firstKey } = validateAll();
      fieldErrors = errors;
      if (firstKey) {
        // Field-level role=alert owns validation messaging so Playwright
        // getByRole('alert') stays unambiguous.
        localError = null;
        console.info('[muster][elicitation-ui] validationBlocked', {
          promptId,
          field: firstKey,
          reason: 'required',
        });
        queueMicrotask(() => focusControl(fieldDomId(firstKey)));
        return;
      }

      submitting = true;
      const content = plainValues();
      console.info('[muster][elicitation-ui] submitElicitation', {
        promptId,
        action,
        contentKeys: Object.keys(content),
      });
      try {
        post({ type: 'submitElicitation', promptId, action, content });
      } catch (error) {
        submitting = false;
        localError = `Could not send the response: ${error instanceof Error ? error.message : String(error)}`;
        console.error('[muster][elicitation-ui] submitElicitation failed', error);
      }
    } else {
      fieldErrors = {};
      submitting = true;
      console.info('[muster][elicitation-ui] submitElicitation', { promptId, action, contentKeys: [] });
      try {
        post({ type: 'submitElicitation', promptId, action });
      } catch (error) {
        submitting = false;
        localError = `Could not send the response: ${error instanceof Error ? error.message : String(error)}`;
        console.error('[muster][elicitation-ui] submitElicitation failed', error);
      }
    }
  }
</script>

<div
  class="mx-2 my-1 rounded p-2 flex flex-col gap-2 text-xs"
  style="border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder)); background: var(--vscode-editor-background);"
>
  <div class="font-semibold">{askLike ? 'Agent question' : 'Agent request'}</div>
  {#if localError || submissionError}
    <div role="alert" style="color: var(--vscode-errorForeground);">{localError || submissionError}</div>
  {/if}
  {#if message}
    <div class="whitespace-pre-wrap opacity-90">{message}</div>
  {/if}

  {#each fields as f (f.key)}
    {@const controlId = fieldDomId(f.key)}
    {@const titleId = fieldTitleId(f.key)}
    {@const descId = fieldDescId(f.key)}
    {@const errorId = fieldErrorId(f.key)}
    {@const need = isRequired(f)}
    {@const invalid = Boolean(fieldErrors[f.key])}
    <div class="flex flex-col gap-1">
      <div class="font-medium">
        <label id={titleId} for={controlId}>{fieldLabel(f)}</label>
        {#if need}<span aria-hidden="true"> *</span>{/if}
      </div>
      {#if f.description}
        <div id={descId} class="opacity-80 whitespace-pre-wrap">{f.description}</div>
      {/if}

      {#if f.type === 'enum' && f.options}
        <vscode-radio-group
          id={controlId}
          aria-labelledby={titleId}
          aria-describedby={describedBy(f)}
          aria-required={need ? 'true' : undefined}
          aria-invalid={invalid ? 'true' : 'false'}
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
        <div
          id={controlId}
          role="group"
          aria-labelledby={titleId}
          aria-describedby={describedBy(f)}
        >
          {#each f.options as option (option)}
            <label class="flex items-center gap-1">
              <input
                type="checkbox"
                checked={Array.isArray(values[f.key]) && (values[f.key] as string[]).includes(option)}
                aria-required={need ? 'true' : undefined}
                aria-invalid={invalid ? 'true' : 'false'}
                aria-describedby={describedBy(f)}
                onchange={() => toggleMulti(f.key, option)}
              />
              {option}
            </label>
          {/each}
        </div>
      {:else if f.type === 'boolean'}
        <label class="flex items-center gap-1">
          <input
            id={controlId}
            type="checkbox"
            checked={!!values[f.key]}
            aria-labelledby={titleId}
            aria-describedby={describedBy(f)}
            aria-required={need ? 'true' : undefined}
            aria-invalid={invalid ? 'true' : 'false'}
            onchange={(e: Event) =>
              setValue(f.key, (e.currentTarget as HTMLInputElement).checked)}
          />
          Yes
        </label>
      {:else if f.type === 'number' || f.type === 'integer'}
        <input
          id={controlId}
          type="number"
          class="px-1 py-0.5 rounded"
          style="border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground);"
          value={values[f.key] ?? ''}
          aria-labelledby={titleId}
          aria-describedby={describedBy(f)}
          aria-required={need ? 'true' : undefined}
          aria-invalid={invalid ? 'true' : 'false'}
          oninput={(e: Event) => {
            const raw = (e.currentTarget as HTMLInputElement).value;
            setValue(f.key, raw === '' ? undefined : Number(raw));
          }}
        />
      {:else}
        <input
          id={controlId}
          type="text"
          class="px-1 py-0.5 rounded"
          style="border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground);"
          value={String(values[f.key] ?? '')}
          aria-labelledby={titleId}
          aria-describedby={describedBy(f)}
          aria-required={need ? 'true' : undefined}
          aria-invalid={invalid ? 'true' : 'false'}
          oninput={(e: Event) =>
            setValue(f.key, (e.currentTarget as HTMLInputElement).value)}
        />
      {/if}
      {#if (f as { allowCustom?: boolean }).allowCustom}
        <input
          type="text"
          class="px-1 py-0.5 rounded"
          style="border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground);"
          placeholder="Other…"
          value={String(values[`${f.key}_custom`] ?? '')}
          aria-label={`Other value for ${fieldLabel(f)}`}
          oninput={(e: Event) =>
            setValue(
              `${f.key}_custom`,
              (e.currentTarget as HTMLInputElement).value,
            )}
        />
      {/if}
      {#if fieldErrors[f.key]}
        <div id={errorId} role="alert" style="color: var(--vscode-errorForeground);">{fieldErrors[f.key]}</div>
      {/if}
    </div>
  {/each}

  <div class="flex gap-2 justify-end flex-wrap">
    <vscode-button secondary disabled={submitting} onclick={() => submit('cancel')}>Dismiss</vscode-button>
    <vscode-button secondary disabled={submitting} onclick={() => submit('decline')}>Decline</vscode-button>
    <vscode-button disabled={submitting} onclick={() => submit('accept')}>Accept</vscode-button>
  </div>
</div>
