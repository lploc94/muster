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

  function ensureAnswer(index: number): AskAnswer {
    const key = String(index);
    if (!answers[key]) {
      answers[key] = { selected: [], freeText: null };
    }
    return answers[key];
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

  function submit(): void {
    const payload: Record<string, AskAnswer> = {};
    for (let i = 0; i < questions.length; i++) {
      payload[String(i)] = ensureAnswer(i);
    }
    post({ type: 'submitAsk', taskId, turnId, askId, answers: payload });
  }

  function cancel(): void {
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
            const val = (e.target as HTMLElement & { value?: string })?.value;
            if (typeof val === 'string') selectOption(i, val);
          }}
        >
          {#each q.options as option (option)}
            <vscode-radio
              value={option}
              name={`ask-${askId}-${i}`}
              checked={ensureAnswer(i).selected.includes(option)}
            >{option}</vscode-radio>
          {/each}
        </vscode-radio-group>
      {/if}

      {#if q.allowFreeText === true || !q.options?.length}
        <vscode-textfield
          placeholder="Your answer…"
          value={ensureAnswer(i).freeText ?? ''}
          oninput={(e: Event) =>
            setFreeText(i, (e.currentTarget as HTMLInputElement & { value: string }).value)}
        ></vscode-textfield>
      {/if}
    </div>
  {/each}

  <div class="flex gap-2 justify-end">
    <vscode-button secondary onclick={cancel}>Dismiss</vscode-button>
    <vscode-button onclick={submit}>Submit</vscode-button>
  </div>
</div>
