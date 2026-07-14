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
  }

  function setFreeText(index: number, value: string): void {
    const entry = ensureAnswer(index);
    entry.freeText = value.trim() ? value : null;
    answers = { ...answers };
  }

  let submitting = $state(false);
  let localPostError = $state<string | null>(null);
  let seenSubmissionVersion = $state(0);

  $effect(() => {
    if (submissionVersion > seenSubmissionVersion) {
      seenSubmissionVersion = submissionVersion;
      submitting = false;
    }
  });

  function submit(): void {
    if (submitting) return;
    submitting = true;
    localPostError = null;
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
    <div class="flex flex-col gap-1">
      <div class="whitespace-pre-wrap">{q.prompt}</div>

      {#if q.options && q.options.length > 0}
        {#if q.multiSelect}
          {#each q.options as option (option)}
            <label class="flex items-center gap-1">
              <input
                type="checkbox"
                checked={readAnswer(i).selected.includes(option)}
                onchange={() => selectOption(i, option, true)}
              />
              {option}
            </label>
          {/each}
        {:else}
          <vscode-radio-group
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

      {#if q.allowFreeText === true || !q.options?.length}
        <vscode-textfield
          placeholder="Your answer…"
          value={readAnswer(i).freeText ?? ''}
          oninput={(e: Event) =>
            setFreeText(i, (e.currentTarget as HTMLInputElement & { value: string }).value)}
        ></vscode-textfield>
      {/if}
    </div>
  {/each}

  <div class="flex gap-2 justify-end flex-wrap">
    <vscode-button secondary disabled={submitting} onclick={cancel}>Dismiss</vscode-button>
    <vscode-button secondary disabled={submitting} onclick={cancel}>Decline</vscode-button>
    <vscode-button disabled={submitting} onclick={submit}>Accept</vscode-button>
  </div>
</div>
