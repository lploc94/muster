<script lang="ts">
  import type { Question } from '../lib/types';
  import { post } from '../lib/protocol';
  import type { AskAnswer } from '../lib/protocol';

  interface Props {
    taskId: string;
    turnId: string;
    askId: string;
    questions: Question[];
    submissionError?: string;
    submissionVersion?: number;
  }

  let { taskId, turnId, askId, questions, submissionError, submissionVersion = 0 }: Props = $props();

  let answers = $state<Record<string, AskAnswer>>({});
  let fieldErrors = $state<Record<string, string>>({});
  let submitting = $state(false);
  let localPostError = $state<string | null>(null);
  let seenSubmissionVersion = $state(0);
  let focusedForAskId = $state<string | null>(null);

  function defaultAnswer(): AskAnswer {
    return { selected: [], freeText: null };
  }

  function readAnswer(index: number): AskAnswer {
    return answers[String(index)] ?? defaultAnswer();
  }

  function ensureAnswer(index: number): AskAnswer {
    const key = String(index);
    const entry = answers[key] ?? defaultAnswer();
    answers = { ...answers, [key]: entry };
    return entry;
  }

  function sanitizeIdPart(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || 'q';
  }

  function questionDomId(index: number): string {
    return `ask-${sanitizeIdPart(askId)}-q${index}`;
  }

  function questionPromptId(index: number): string {
    return `${questionDomId(index)}-prompt`;
  }

  function questionErrorId(index: number): string {
    return `${questionDomId(index)}-error`;
  }

  function questionControlId(index: number): string {
    return `${questionDomId(index)}-control`;
  }

  function showsFreeText(q: Question): boolean {
    return q.allowFreeText === true || !q.options?.length;
  }

  function clearFieldError(index: number): void {
    const key = String(index);
    if (!fieldErrors[key]) return;
    const next = { ...fieldErrors };
    delete next[key];
    fieldErrors = next;
  }

  function selectOption(index: number, option: string, multi = false): void {
    const entry = ensureAnswer(index);
    if (multi) {
      const cur = [...entry.selected];
      const i = cur.indexOf(option);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(option);
      entry.selected = cur;
    } else {
      entry.selected = [option];
    }
    answers = { ...answers };
    clearFieldError(index);
  }

  function setFreeText(index: number, value: string): void {
    const entry = ensureAnswer(index);
    entry.freeText = value.trim() ? value : null;
    answers = { ...answers };
    clearFieldError(index);
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

  function firstUsefulControlId(): string | null {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (showsFreeText(q)) return questionControlId(i);
      if (q.options && q.options.length > 0) {
        // First option control (checkbox input id or radio group)
        return questionControlId(i);
      }
    }
    return null;
  }

  $effect(() => {
    if (submissionVersion > seenSubmissionVersion) {
      seenSubmissionVersion = submissionVersion;
      submitting = false;
    }
  });

  // Focus first useful control when a blocking Ask form mounts / askId changes.
  $effect(() => {
    const currentAskId = askId;
    if (focusedForAskId === currentAskId) return;
    focusedForAskId = currentAskId;
    fieldErrors = {};
    localPostError = null;
    const controlId = firstUsefulControlId();
    if (!controlId) return;
    queueMicrotask(() => focusControl(controlId));
  });

  function validateAll(): { errors: Record<string, string>; firstIndex: number | null } {
    const errors: Record<string, string> = {};
    let firstIndex: number | null = null;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = readAnswer(i);
      const hasOptions = Boolean(q.options && q.options.length > 0);
      const freeText = (answer.freeText ?? '').trim();
      let err: string | null = null;

      if (hasOptions && !showsFreeText(q)) {
        if (answer.selected.length === 0) {
          err = `${q.prompt} is required.`;
        }
      } else if (hasOptions && showsFreeText(q)) {
        if (answer.selected.length === 0 && !freeText) {
          err = `${q.prompt} is required.`;
        }
      } else if (!freeText) {
        err = `${q.prompt} is required.`;
      }

      if (err) {
        errors[String(i)] = err;
        if (firstIndex === null) firstIndex = i;
      }
    }

    return { errors, firstIndex };
  }

  function submit(): void {
    if (submitting) return;
    localPostError = null;

    const { errors, firstIndex } = validateAll();
    fieldErrors = errors;
    if (firstIndex !== null) {
      // Field-level role=alert owns validation messaging so Playwright
      // getByRole('alert') stays unambiguous.
      localPostError = null;
      console.info('[muster][elicitation-ui] validationBlocked', {
        taskId,
        turnId,
        askId,
        questionIndex: firstIndex,
        reason: 'required',
      });
      queueMicrotask(() => focusControl(questionControlId(firstIndex)));
      return;
    }

    submitting = true;
    const payload: Record<string, AskAnswer> = {};
    for (let i = 0; i < questions.length; i++) {
      // `$state` recursively proxies nested answer objects/arrays. VS Code's
      // webview bridge structured-clones messages and rejects Proxy values with
      // DataCloneError, after the button has already entered submitting state.
      const answer = readAnswer(i);
      payload[String(i)] = {
        selected: [...answer.selected],
        freeText: answer.freeText,
      };
    }
    console.info('[muster][elicitation-ui] submitAsk', {
      taskId,
      turnId,
      askId,
      answeredIndexes: Object.keys(payload),
    });
    try {
      post({ type: 'submitAsk', taskId, turnId, askId, answers: payload });
    } catch (error) {
      submitting = false;
      localPostError = `Could not send the answer: ${error instanceof Error ? error.message : String(error)}`;
      console.error('[muster][elicitation-ui] submitAsk failed', error);
    }
  }

  function cancel(): void {
    if (submitting) return;
    submitting = true;
    localPostError = null;
    fieldErrors = {};
    console.info('[muster][elicitation-ui] cancelAsk', { taskId, turnId, askId });
    try {
      post({ type: 'cancelAsk', taskId, turnId, askId });
    } catch (error) {
      submitting = false;
      localPostError = `Could not cancel the question: ${error instanceof Error ? error.message : String(error)}`;
      console.error('[muster][elicitation-ui] cancelAsk failed', error);
    }
  }
</script>

<div
  class="mx-2 my-1 rounded p-2 flex flex-col gap-2 text-xs"
  style="border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder)); background: var(--vscode-editor-background);"
>
  <div class="font-semibold">Agent question</div>
  {#if localPostError || submissionError}
    <div role="alert" style="color: var(--vscode-errorForeground);">{localPostError || submissionError}</div>
  {/if}

  {#each questions as q, i (i)}
    {@const promptId = questionPromptId(i)}
    {@const controlId = questionControlId(i)}
    {@const errorId = questionErrorId(i)}
    {@const invalid = Boolean(fieldErrors[String(i)])}
    {@const freeTextShown = showsFreeText(q)}
    <div class="flex flex-col gap-1">
      <div id={promptId} class="whitespace-pre-wrap">{q.prompt}</div>

      {#if q.options && q.options.length > 0}
        {#if q.multiSelect}
          <div
            id={controlId}
            role="group"
            aria-labelledby={promptId}
            aria-describedby={invalid ? errorId : undefined}
          >
            {#each q.options as option (option)}
              <label class="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={readAnswer(i).selected.includes(option)}
                  aria-required="true"
                  aria-invalid={invalid ? 'true' : 'false'}
                  aria-describedby={invalid ? errorId : undefined}
                  onchange={() => selectOption(i, option, true)}
                />
                {option}
              </label>
            {/each}
          </div>
        {:else}
          <vscode-radio-group
            id={controlId}
            aria-labelledby={promptId}
            aria-describedby={invalid ? errorId : undefined}
            aria-invalid={invalid ? 'true' : 'false'}
            aria-required="true"
            onchange={(e: Event) => {
              const target = e.target as HTMLElement & { value?: string };
              const val =
                typeof target?.value === 'string' && target.value.length > 0
                  ? target.value
                  : undefined;
              if (typeof val === 'string' && val.length > 0) selectOption(i, val, false);
            }}
          >
            {#each q.options as option (option)}
              <vscode-radio
                value={option}
                name={`ask-${askId}-${i}`}
                checked={readAnswer(i).selected.includes(option)}
              >{option}</vscode-radio>
            {/each}
          </vscode-radio-group>
        {/if}
      {/if}

      {#if freeTextShown}
        <input
          id={controlId}
          type="text"
          class="px-1 py-0.5 rounded"
          style="border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground);"
          placeholder="Your answer…"
          value={readAnswer(i).freeText ?? ''}
          aria-labelledby={promptId}
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid ? 'true' : 'false'}
          aria-required="true"
          oninput={(e: Event) =>
            setFreeText(i, (e.currentTarget as HTMLInputElement).value)}
        />
      {/if}

      {#if fieldErrors[String(i)]}
        <div id={errorId} role="alert" style="color: var(--vscode-errorForeground);">
          {fieldErrors[String(i)]}
        </div>
      {/if}
    </div>
  {/each}

  <div class="flex gap-2 justify-end flex-wrap">
    <vscode-button secondary disabled={submitting} onclick={cancel}>Dismiss</vscode-button>
    <vscode-button secondary disabled={submitting} onclick={cancel}>Decline</vscode-button>
    <vscode-button disabled={submitting} onclick={submit}>Accept</vscode-button>
  </div>
</div>
