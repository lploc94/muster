/**
 * Engine-side helpers for runtime handoff orchestration (M010/S02–S03).
 *
 * Pure functions over TaskHandoff + TaskMessage — no webview projection, no
 * backend rebinding. TaskEngine.requestRuntimeHandoff owns persistence of
 * digests; S03 receiver transfer builds an ephemeral HandoffPackage at transfer
 * time from visible TaskMessage rows + optional in-process summary text.
 *
 * Optional source-summary text is digested in-memory only; raw prompt/response
 * never become TaskMessage/TaskTurn rows (M010/S02 T02, D017/D018/D019).
 *
 * HandoffPackage / bootstrap prompt bodies are never logged, never projected
 * into EngineEvents, and never written as chat (M010/S03 T01, D020).
 */

import { createHash } from 'crypto';
import { TaskHandoff, type TaskHandoffResult } from './task-handoff';
import type { TaskHandoffPhase, TaskMessage } from './types';
import type { NormalizedEvent } from '../types';

/**
 * Prompt sent to the *source* backend during an optional internal summary turn.
 * Must never be written as a TaskMessage or projected into buildTranscript.
 */
export const HANDOFF_SOURCE_SUMMARY_PROMPT =
  'Prepare a concise handoff summary of this conversation for another agent that will continue the work. Include goals, decisions, open questions, and next steps. Do not address the user.';

/** Contract version for the in-process receiver handoff package (not store schema). */
export const HANDOFF_PACKAGE_VERSION = 1 as const;

/** Max visible user/assistant messages kept when rebuilding conversation for transfer. */
export const MAX_HANDOFF_CONVERSATION_MESSAGES = 200;

/** Max total characters of conversation content in the receiver package. */
export const MAX_HANDOFF_CONVERSATION_CHARS = 100_000;

/** Max characters of optional ephemeral source-summary text in the package. */
export const MAX_HANDOFF_SOURCE_SUMMARY_CHARS = 16_384;

/** Default continuation instructions embedded in every HandoffPackage. */
export const HANDOFF_CONTINUATION_INSTRUCTIONS =
  'Continue this existing Muster task from the provided context. Preserve the task goal, prior decisions, and open work. Do not address the user unless the conversation already requires a user-facing reply. Do not invent a new task id or resume any prior backend session.';

/** One visible conversation turn exported into the receiver package. */
export interface HandoffConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Agent-facing content (agentContent when present, else display content). */
  content: string;
}

/** Provenance carried into the receiver — backends/models only, never session ids. */
export interface HandoffPackageProvenance {
  sourceBackend: string;
  sourceModel?: string;
  targetBackend: string;
  targetModel?: string;
}

/**
 * Versioned, in-process package handed to the target runtime at transfer time.
 * Not persisted on MusterTask; rebuild from TaskMessage rows (+ optional summary
 * text held only in engine memory) whenever transfer runs (D020).
 */
export interface HandoffPackage {
  version: typeof HANDOFF_PACKAGE_VERSION;
  operationId: string;
  taskId: string;
  taskGoal: string;
  builtAt: string;
  provenance: HandoffPackageProvenance;
  conversation: HandoffConversationMessage[];
  messageCount: number;
  /** Digest of the rebuilt conversation rows (not full bodies). */
  conversationDigest: string;
  /** Optional ephemeral source-summary text — omit when unavailable/skipped. */
  sourceSummary?: string;
  continuationInstructions: string;
}

export interface RebuildHandoffConversationOptions {
  maxMessages?: number;
  maxChars?: number;
}

export interface BuildHandoffPackageInput {
  taskId: string;
  taskGoal: string;
  handoff: TaskHandoff;
  messages: readonly TaskMessage[];
  builtAt: string;
  /** Optional in-process source-summary text (never read from the store). */
  sourceSummaryText?: string;
  maxMessages?: number;
  maxChars?: number;
  maxSummaryChars?: number;
}

function isVisibleHandoffMessage(message: TaskMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false;
  }
  // Pending drafts are not yet part of committed conversation history.
  if (message.state === 'pending') {
    return false;
  }
  return true;
}

function messageAgentText(message: TaskMessage): string {
  return message.agentContent ?? message.content;
}

function digestHandoffConversation(messages: readonly HandoffConversationMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(message.id);
    hash.update('\0');
    hash.update(message.role);
    hash.update('\0');
    hash.update(message.content);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Rebuild bounded conversation rows for receiver transfer from visible
 * TaskMessage rows at transfer time (D020). System and pending messages are
 * excluded; agentContent is preferred over display content. Newest messages are
 * retained when message-count or char budgets force truncation.
 */
export function rebuildHandoffConversation(
  messages: readonly TaskMessage[],
  options: RebuildHandoffConversationOptions = {},
): HandoffConversationMessage[] {
  const maxMessages = options.maxMessages ?? MAX_HANDOFF_CONVERSATION_MESSAGES;
  const maxChars = options.maxChars ?? MAX_HANDOFF_CONVERSATION_CHARS;

  const ordered = messages
    .filter(isVisibleHandoffMessage)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((message) => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      content: messageAgentText(message),
    }));

  // Keep the most recent messages under the count budget.
  let selected =
    ordered.length > maxMessages ? ordered.slice(ordered.length - maxMessages) : ordered;

  // Then enforce total char budget from the tail (newest) forward.
  let total = 0;
  for (const message of selected) {
    total += message.content.length;
  }
  if (total > maxChars) {
    const kept: HandoffConversationMessage[] = [];
    let used = 0;
    for (let i = selected.length - 1; i >= 0; i -= 1) {
      const message = selected[i];
      const next = used + message.content.length;
      if (kept.length > 0 && next > maxChars) {
        break;
      }
      if (kept.length === 0 && message.content.length > maxChars) {
        // Single oversized newest message: keep a tail slice so transfer still has context.
        kept.unshift({
          ...message,
          content: message.content.slice(message.content.length - maxChars),
        });
        used = maxChars;
        break;
      }
      kept.unshift(message);
      used = next;
    }
    selected = kept;
  }

  return selected;
}

/**
 * Build a versioned HandoffPackage for the target runtime. Conversation is always
 * rebuilt from TaskMessage rows; source-summary text is optional enrichment held
 * only ephemerally by the caller (D020). Never includes source session ids.
 */
export function buildHandoffPackage(input: BuildHandoffPackageInput): HandoffPackage {
  const state = input.handoff.toState();
  const conversation = rebuildHandoffConversation(input.messages, {
    maxMessages: input.maxMessages,
    maxChars: input.maxChars,
  });

  const maxSummaryChars = input.maxSummaryChars ?? MAX_HANDOFF_SOURCE_SUMMARY_CHARS;
  let sourceSummary: string | undefined;
  if (input.sourceSummaryText !== undefined) {
    const trimmed = input.sourceSummaryText.trim();
    if (trimmed.length > 0) {
      sourceSummary =
        trimmed.length > maxSummaryChars ? trimmed.slice(0, maxSummaryChars) : trimmed;
    }
  }

  const provenance: HandoffPackageProvenance = {
    sourceBackend: state.source.backend,
    targetBackend: state.target.backend,
  };
  if (state.source.model) {
    provenance.sourceModel = state.source.model;
  }
  if (state.target.model) {
    provenance.targetModel = state.target.model;
  }

  const pkg: HandoffPackage = {
    version: HANDOFF_PACKAGE_VERSION,
    operationId: state.operationId,
    taskId: input.taskId,
    taskGoal: input.taskGoal,
    builtAt: input.builtAt,
    provenance,
    conversation,
    messageCount: conversation.length,
    conversationDigest: digestHandoffConversation(conversation),
    continuationInstructions: HANDOFF_CONTINUATION_INSTRUCTIONS,
  };
  if (sourceSummary !== undefined) {
    pkg.sourceSummary = sourceSummary;
  }
  return pkg;
}

/**
 * Render the bootstrap prompt used to initialize a *new* target session from a
 * HandoffPackage. Callers must pass this as runTurn prompt without resumeId.
 * Prompt body must never be persisted as TaskMessage or emitted as EngineEvent.
 */
export function buildHandoffBootstrapPrompt(pkg: HandoffPackage): string {
  const lines: string[] = [
    '<!-- muster-handoff-package/v1 -->',
    'You are receiving an existing Muster task via cross-runtime handoff.',
    'Start a fresh session for this task. Do not resume any prior backend session.',
    '',
    '## Task',
    `- id: ${pkg.taskId}`,
    `- goal: ${pkg.taskGoal}`,
    `- operationId: ${pkg.operationId}`,
    `- builtAt: ${pkg.builtAt}`,
    '',
    '## Provenance',
    `- sourceBackend: ${pkg.provenance.sourceBackend}`,
  ];
  if (pkg.provenance.sourceModel) {
    lines.push(`- sourceModel: ${pkg.provenance.sourceModel}`);
  }
  lines.push(`- targetBackend: ${pkg.provenance.targetBackend}`);
  if (pkg.provenance.targetModel) {
    lines.push(`- targetModel: ${pkg.provenance.targetModel}`);
  }

  lines.push('', '## Continuation instructions', pkg.continuationInstructions, '');

  if (pkg.sourceSummary) {
    lines.push('## Source summary', pkg.sourceSummary, '');
  } else {
    lines.push(
      '## Context mode',
      'No source summary is available; continue from the conversation only.',
      '',
    );
  }

  lines.push(`## Conversation (${pkg.messageCount} messages)`);
  if (pkg.conversation.length === 0) {
    lines.push('(empty)');
  } else {
    for (const message of pkg.conversation) {
      lines.push(`[${message.role}] ${message.content}`);
    }
  }

  return lines.join('\n');
}

export interface ConversationContextExport {
  messageCount: number;
  contentDigest: string;
  exportedAt: string;
}

const ACTIVE_HANDOFF_PHASES: ReadonlySet<TaskHandoffPhase> = new Set([
  'requested',
  'exporting_context',
  'summarizing_source',
  'preparing_receiver',
  'transferring',
]);

/**
 * True while a handoff is still in flight and must block a second request.
 * Terminal phases (completed/failed/cancelled) are not active.
 */
export function isActiveHandoffPhase(phase: TaskHandoffPhase): boolean {
  return ACTIVE_HANDOFF_PHASES.has(phase);
}

/**
 * Build required conversation-context metadata from existing task messages.
 * Digests/counts only — never full bodies or credentials.
 *
 * Digest is order-stable: messages are sorted by createdAt then id before hash.
 */
export function exportConversationContextMetadata(
  messages: readonly TaskMessage[],
  exportedAt: string,
): ConversationContextExport {
  const ordered = [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const hash = createHash('sha256');
  for (const message of ordered) {
    hash.update(message.id);
    hash.update('\0');
    hash.update(message.role);
    hash.update('\0');
    hash.update(message.content);
    hash.update('\0');
    if (message.agentContent) {
      hash.update(message.agentContent);
    }
    hash.update('\n');
  }

  return {
    messageCount: ordered.length,
    contentDigest: hash.digest('hex').slice(0, 32),
    exportedAt,
  };
}

export interface AdvanceHandoffToPreparingReceiverInput {
  handoff: TaskHandoff;
  messages: readonly TaskMessage[];
  now: string;
  /** Reason recorded on sourceSummary when skipping the optional summary turn. */
  skipSummaryReason?: string;
  operationId?: string;
}

/**
 * Advance a freshly created handoff through:
 *   requested → exporting_context → conversation ready → skip summary → preparing_receiver
 *
 * Used by the skip-summary path of requestRuntimeHandoff. Does not rebind runtime.
 */
export function advanceHandoffToPreparingReceiver(
  input: AdvanceHandoffToPreparingReceiverInput,
): TaskHandoffResult {
  const op = {
    now: input.now,
    ...(input.operationId ? { operationId: input.operationId } : {}),
  };

  let current = input.handoff;

  const started = current.startExport(op);
  if (!started.ok) {
    return started;
  }
  current = started.next;

  const exported = exportConversationContextMetadata(input.messages, input.now);
  const ready = current.markConversationReady({
    ...op,
    messageCount: exported.messageCount,
    contentDigest: exported.contentDigest,
    exportedAt: exported.exportedAt,
  });
  if (!ready.ok) {
    return ready;
  }
  current = ready.next;

  const skipped = current.skipSummary({
    ...op,
    reason: input.skipSummaryReason ?? 'summary not requested',
  });
  if (!skipped.ok) {
    return skipped;
  }
  current = skipped.next;

  return current.beginPreparingReceiver(op);
}

/**
 * Digest of optional source-summary text for TaskHandoff.sourceSummary.
 * Raw summary text is never persisted — only this digest.
 */
export function digestSourceSummaryText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Collect assistant text (and optional error) from a backend turn stream.
 * Used only for the hidden internal handoff summary turn — callers must not
 * persist the returned text as TaskMessage/TaskTurn content.
 */
export async function collectInternalSummaryTurnText(
  events: AsyncIterable<NormalizedEvent>,
): Promise<{ text: string; errorMessage?: string }> {
  let text = '';
  let errorMessage: string | undefined;
  for await (const event of events) {
    if (event.type === 'assistantDelta') {
      text += event.content;
    } else if (event.type === 'error' && !event.isCancellation) {
      errorMessage = event.message;
    }
  }
  return errorMessage !== undefined ? { text, errorMessage } : { text };
}

export type SourceSummaryOutcome =
  | { kind: 'ready'; contentDigest: string; summarizedAt: string; text?: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'skipped'; reason: string };

export interface AdvanceHandoffWithSourceSummaryInput {
  handoff: TaskHandoff;
  messages: readonly TaskMessage[];
  now: string;
  operationId?: string;
  /** Outcome of the optional internal summary turn (or skip). */
  summary: SourceSummaryOutcome;
}

/**
 * Advance a freshly created handoff through context export and optional summary
 * resolution into preparing_receiver.
 *
 * When summary.kind is 'ready'/'unavailable', walks summarizing_source.
 * When 'skipped', uses the skip path (no summarizing_source phase).
 */
export function advanceHandoffWithSourceSummary(
  input: AdvanceHandoffWithSourceSummaryInput,
): TaskHandoffResult {
  const op = {
    now: input.now,
    ...(input.operationId ? { operationId: input.operationId } : {}),
  };

  let current = input.handoff;

  const started = current.startExport(op);
  if (!started.ok) {
    return started;
  }
  current = started.next;

  const exported = exportConversationContextMetadata(input.messages, input.now);
  const ready = current.markConversationReady({
    ...op,
    messageCount: exported.messageCount,
    contentDigest: exported.contentDigest,
    exportedAt: exported.exportedAt,
  });
  if (!ready.ok) {
    return ready;
  }
  current = ready.next;

  if (input.summary.kind === 'skipped') {
    const skipped = current.skipSummary({
      ...op,
      reason: input.summary.reason,
    });
    if (!skipped.ok) {
      return skipped;
    }
    current = skipped.next;
    return current.beginPreparingReceiver(op);
  }

  const summarizing = current.beginSummarizing(op);
  if (!summarizing.ok) {
    return summarizing;
  }
  current = summarizing.next;

  if (input.summary.kind === 'ready') {
    const marked = current.markSummaryReady({
      ...op,
      contentDigest: input.summary.contentDigest,
      summarizedAt: input.summary.summarizedAt,
    });
    if (!marked.ok) {
      return marked;
    }
    current = marked.next;
  } else {
    const marked = current.markSummaryUnavailable({
      ...op,
      reason: input.summary.reason,
    });
    if (!marked.ok) {
      return marked;
    }
    current = marked.next;
  }

  return current.beginPreparingReceiver(op);
}
