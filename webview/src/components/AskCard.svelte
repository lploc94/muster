<script lang="ts">
  import type { Question } from '../lib/types';
  import { post } from '../lib/protocol';
  import type { AskAnswer } from '../lib/protocol';

  interface Props {
    taskId: string;
    turnId: string;
    askId: string;
    questions: Question[];
  }

  let { taskId, turnId, askId, questions }: Props = $props();

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

  // Single-select: options render as a radio group (at most one selection).
  function selectOption(index: number, option: string): void {
    const entry = ensureAnswer(index);
    entry.selected = [option];
    answers = { ...answers };
  }

  function setFreeText(index: number, value: string): void {
    const entry = ensureAnswer(index);
    entry.freeText = value.trim() ? value : null;
    answers = { ...answers };
  }

  let submitting = $state(false);

  function submit(): void {
    if (submitting) return;
    submitting = true;
    const payload: Record<string, AskAnswer> = {};
    for (let i = 0; i < questions.length; i++) {
      payload[String(i)] = readAnswer(i);
    }
    post({ type: 'submitAsk', taskId, turnId, askId, answers: payload });
  }

  function cancel(): void {
    if (submitting) return;
    submitting = true;
    post({ type: 'cancelAsk', taskId, turnId, askId });
  }
</script>

<div
  class="mx-2 my-1 rounded p-2 flex flex-col gap-2 text-xs"
  style="border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder)); background: var(--vscode-editor-background);"
>
  <div class="font-semibold">Agent question</div>

  {#each questions as q, i (i)}
    <div class="flex flex-col gap-1">
      <div class="whitespace-pre-wrap">{q.prompt}</div>

      {#if q.options && q.options.length > 0}
        <vscode-radio-group
          onchange={(e: Event) => {
            const target = e.target as HTMLElement & { value?: string; checked?: boolean };
            const val =
              typeof target?.value === 'string' && target.value.length > 0
                ? target.value
                : (e.currentTarget as HTMLElement)
                    ?.querySelector?.('vscode-radio[checked]')
                    ?.getAttribute?.('value') ?? undefined;
            if (typeof val === 'string' && val.length > 0) selectOption(i, val);
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

  <div class="flex gap-2 justify-end">
    <vscode-button secondary disabled={submitting} onclick={cancel}>Dismiss</vscode-button>
    <vscode-button disabled={submitting} onclick={submit}>Submit</vscode-button>
  </div>
</div>
