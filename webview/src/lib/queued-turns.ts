import type { OutMessage, QueuedTurnProjection, TranscriptItem } from './protocol';

export interface QueuedTurnControlState {
  turnId: string;
  sequence: number;
  previewText: string;
  locked: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface QueuedMutationLockOptions {
  locked?: boolean;
}

/** FIFO order matching host projectQueuedTurns: sequence → createdAt → turnId. */
export function sortQueuedTurns(turns: readonly QueuedTurnProjection[]): QueuedTurnProjection[] {
  return [...turns].sort(
    (a, b) =>
      a.sequence - b.sequence ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.turnId.localeCompare(b.turnId),
  );
}

/** Message-like row from host transcript or webview ThreadItem. */
export type QueuedPreviewMessage = {
  id: string;
  kind: string;
  content?: unknown;
  text?: string;
};

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function messageText(item: QueuedPreviewMessage): string {
  if (typeof item.text === 'string' && item.text.length > 0) return item.text;
  return asText(item.content);
}

/**
 * Resolve display/edit preview for a queued turn from its bound messageIds.
 * Accepts host transcript items or webview ThreadItems; empty when messages are missing.
 */
export function resolveQueuedTurnPreview(
  turn: Pick<QueuedTurnProjection, 'messageIds'>,
  messages: readonly QueuedPreviewMessage[] | readonly TranscriptItem[] | undefined,
): string {
  if (!messages || turn.messageIds.length === 0) return '';
  const byId = new Map(messages.map((item) => [item.id, item as QueuedPreviewMessage]));
  const parts: string[] = [];
  for (const messageId of turn.messageIds) {
    const item = byId.get(messageId);
    if (!item || item.kind !== 'user') continue;
    const text = messageText(item).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/** True only while the projection still reports status `queued`. */
export function canMutateQueuedTurn(turn: Pick<QueuedTurnProjection, 'status'> | { status: string }): boolean {
  return turn.status === 'queued';
}

/**
 * Dispatch boundary for the webview: a turn is mutable only while it remains
 * present in the live `queuedTurns` projection. Leaving the list means startCommit
 * assigned it and controls must lock.
 */
export function isQueuedTurnMutable(
  turnId: string,
  queuedTurns: readonly QueuedTurnProjection[] | undefined,
): boolean {
  if (!queuedTurns || queuedTurns.length === 0) return false;
  return queuedTurns.some((turn) => turn.turnId === turnId && canMutateQueuedTurn(turn));
}

export function queuedTurnControlState(
  turn: QueuedTurnProjection,
  messages: readonly QueuedPreviewMessage[] | readonly TranscriptItem[] | undefined,
  liveQueuedTurns: readonly QueuedTurnProjection[] | undefined,
): QueuedTurnControlState {
  const locked = !isQueuedTurnMutable(turn.turnId, liveQueuedTurns);
  return {
    turnId: turn.turnId,
    sequence: turn.sequence,
    previewText: resolveQueuedTurnPreview(turn, messages),
    locked,
    canEdit: !locked,
    canDelete: !locked,
  };
}

export function buildEditQueuedTurnMessage(
  taskId: string,
  turnId: string,
  content: string,
  opts?: QueuedMutationLockOptions,
): Extract<OutMessage, { type: 'editQueuedTurn' }> | null {
  if (opts?.locked) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    type: 'editQueuedTurn',
    taskId,
    turnId,
    content: trimmed,
  };
}

export function buildDeleteQueuedTurnMessage(
  taskId: string,
  turnId: string,
  opts?: QueuedMutationLockOptions,
): Extract<OutMessage, { type: 'deleteQueuedTurn' }> | null {
  if (opts?.locked) return null;
  return {
    type: 'deleteQueuedTurn',
    taskId,
    turnId,
  };
}
