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

  function toggleOption(index: number, option: string, multi: boolean): void {
    const entry = ensureAnswer(index);
    if (multi) {
      const set = new Set(entry.selected);
      if (set.has(option)) set.delete(option);
      else set.add(option);
      entry.selected = [...set];
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
        <div class="flex flex-col gap-0.5">
          {#each q.options as option (option)}
            <label class="flex items-center gap-1 cursor-pointer">
              <input
                type={q.options && q.options.length > 1 && !q.allowFreeText ? 'checkbox' : 'radio'}
                name={`ask-${askId}-${i}`}
                checked={ensureAnswer(i).selected.includes(option)}
                onchange={() =>
                  toggleOption(i, option, !!(q.options && q.options.length > 1 && !q.allowFreeText))}
              />
              <span>{option}</span>
            </label>
          {/each}
        </div>
      {/if}

      {#if q.allowFreeText !== false || !q.options?.length}
        <input
          type="text"
          class="w-full px-1 py-0.5 rounded"
          style="background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);"
          placeholder="Your answer…"
          value={ensureAnswer(i).freeText ?? ''}
          oninput={(e) => setFreeText(i, (e.currentTarget as HTMLInputElement).value)}
        />
      {/if}
    </div>
  {/each}

  <div class="flex gap-2 justify-end">
    <vscode-button secondary onclick={cancel}>Dismiss</vscode-button>
    <vscode-button onclick={submit}>Submit</vscode-button>
  </div>
</div>