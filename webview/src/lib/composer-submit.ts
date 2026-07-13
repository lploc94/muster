import type { OutMessage } from './protocol';

export type ComposerMode = 'draft' | 'task';

/** Resolved keyboard intent for the task/draft composer. */
export type ComposerSubmitIntent =
  | { kind: 'none' }
  /** Host `send` — creates/continues a turn (FIFO follow-up while live). */
  | { kind: 'send' }
  /**
   * Host `sendLiveInput` — concurrent inject into the live turn.
   * Never falls through to queue creation when refused.
   */
  | { kind: 'sendLiveInput' };

export interface ComposerKeyPolicyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  isComposing: boolean;
  /** Legacy IME composition signal (keyCode 229). */
  keyCode?: number;
}

export interface ComposerKeyPolicyOptions {
  mode: ComposerMode;
  /**
   * Task mode only: true when a live turn is running and Ctrl/Meta+Enter should
   * inject. When false/undefined, Ctrl/Meta+Enter uses ordinary `send` (idle path).
   * Does not change refused-inject behavior: inject never falls through to queue.
   */
  liveInjectEligible?: boolean;
}

/**
 * Pure keyboard → submit intent mapping.
 *
 * - IME composition / keyCode 229: none
 * - Shift+Enter: none (browser inserts newline)
 * - Ctrl/Meta+Enter in task mode + live turn: sendLiveInput only (no queue fallback)
 * - Ctrl/Meta+Enter in task mode when idle / not live: send (immediate turn)
 * - Plain Enter (and Ctrl+Enter in draft): send
 */
export function resolveComposerKeyIntent(
  event: ComposerKeyPolicyInput,
  opts: ComposerKeyPolicyOptions,
): ComposerSubmitIntent {
  if (event.isComposing || event.keyCode === 229) return { kind: 'none' };
  if (event.key !== 'Enter') return { kind: 'none' };
  if (event.shiftKey) return { kind: 'none' };

  const mod = event.ctrlKey || event.metaKey;
  if (mod && opts.mode === 'task' && opts.liveInjectEligible) {
    return { kind: 'sendLiveInput' };
  }
  return { kind: 'send' };
}

/** Whether the key handler should preventDefault (submit path, not newline). */
export function shouldPreventDefaultForComposerKey(
  event: ComposerKeyPolicyInput,
  opts: ComposerKeyPolicyOptions,
): boolean {
  return resolveComposerKeyIntent(event, opts).kind !== 'none';
}

export interface TaskComposerMessageParams {
  taskId?: string;
  text: string;
  /**
   * Agent-facing expanded text (e.g. file-mention full paths). When set and
   * different from `text`, `send` includes `llmText` and `sendLiveInput` uses it
   * as the inject instruction.
   */
  llmText?: string;
}

/**
 * Build the host OutMessage for a task-mode submit intent.
 * Returns null for empty text or missing taskId — caller must not post.
 */
export function buildTaskComposerMessage(
  intent: Exclude<ComposerSubmitIntent, { kind: 'none' }>,
  params: TaskComposerMessageParams,
): Extract<OutMessage, { type: 'send' | 'sendLiveInput' }> | null {
  const taskId = params.taskId?.trim();
  if (!taskId) return null;
  const text = params.text.trim();
  if (!text) return null;
  const llmText =
    typeof params.llmText === 'string' && params.llmText.trim() ? params.llmText.trim() : text;

  if (intent.kind === 'sendLiveInput') {
    // Inject always delivers the agent-facing payload (expanded mentions).
    return { type: 'sendLiveInput', taskId, instruction: llmText };
  }
  if (llmText !== text) {
    return { type: 'send', taskId, text, llmText };
  }
  return { type: 'send', taskId, text };
}
