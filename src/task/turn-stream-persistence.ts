/**
 * Turn stream persistence seam (M017 S03 / D035).
 *
 * Batches assistant / reasoning / tool stream mutations so the engine no longer
 * issues a full-store TaskStore.commit (clone + stringify + fsync under lock)
 * once per delta. JsonTurnStreamBuffer is the temporary production adapter;
 * SQLite will replace it via the reserved `appendTranscriptBatch` command.
 *
 * Invariant 9 (flush-before-terminal): callers MUST flush() before settle /
 * wake / snapshot so terminal observers never see a stale unflushed transcript.
 */

import type { CommitResult, TaskStore } from './store';
import type { TaskStoreFile } from './types';

/**
 * DELETION_GATE (D035 / D041): temporary JSON full-store batch adapter.
 * M017-S07 re-gates retention post-M017 — SQLite `appendTranscriptBatch` does
 * not exist yet, so production keeps JsonTurnStreamBuffer behind this dated note.
 * Remove production references only after the SQLite repository path lands.
 */
export const JSON_TURN_STREAM_BUFFER_DELETION_GATE = {
  decision: 'D035',
  replaceWith: 'appendTranscriptBatch',
  /** Retention re-gated in M017-S07; delete after SQLite appendTranscriptBatch ships. */
  removeIn: 'post-M017',
  /** ISO date when S07 re-dated the temporary buffer retention (D041). */
  dated: '2026-07-18',
  reason:
    'Temporary batching over TaskStore.commit until SQLite transcript append exists. ' +
    'M017-S07 dated post-M017 re-gate (D041): do not invent appendTranscriptBatch here. ' +
    'Do not add new production callers outside TaskEngine stream path.',
} as const;

export type JsonTurnStreamBufferDeletionGate = typeof JSON_TURN_STREAM_BUFFER_DELETION_GATE;

/**
 * Stream mutation ops accepted by TurnStreamPersistence.
 * Engine resolves segment ids / order before enqueueing.
 */
export type TurnStreamOp =
  | {
      type: 'assistantDelta';
      turnId: string;
      taskId: string;
      segmentId: string;
      content: string;
      /** Used only when creating the segment; ignored on append. */
      order: number;
      createdAt: string;
    }
  | {
      type: 'reasoningDelta';
      turnId: string;
      taskId: string;
      content: string;
      now: string;
    }
  | {
      type: 'toolStarted';
      turnId: string;
      taskId: string;
      compositeId: string;
      toolCallId: string;
      order: number;
      name: string;
      kind?: 'mcp' | 'builtin' | 'other';
      input?: unknown;
      createdAt: string;
    }
  | {
      type: 'toolUpdated';
      turnId: string;
      taskId: string;
      compositeId: string;
      toolCallId: string;
      /** Used only on create-if-missing path (mirrors engine). */
      order: number;
      input?: unknown;
      now: string;
    }
  | {
      type: 'toolCompleted';
      turnId: string;
      taskId: string;
      compositeId: string;
      toolCallId: string;
      /** Used only on create-if-missing path (mirrors engine). */
      order: number;
      outcome: string;
      output?: unknown;
      error?: string;
      now: string;
    };

export type ApplyStreamResult = { ok: true };

/**
 * Named repository command contract reserved for the SQLite storage refactor.
 * JsonTurnStreamBuffer does NOT implement this — it is the deletion-gate target.
 */
export interface AppendTranscriptBatchInput {
  turnId: string;
  ops: readonly TurnStreamOp[];
}

/**
 * Future SQLite repository surface. Not implemented in this module.
 * Present so call sites and S07 can migrate without inventing a new name.
 */
export interface TranscriptBatchRepository {
  appendTranscriptBatch(input: AppendTranscriptBatchInput): CommitResult;
}

/**
 * Per-turn stream persistence seam.
 * apply() is in-memory only; flush() is the durable boundary.
 */
export interface TurnStreamPersistence {
  /** Enqueue a stream mutation. Does not guarantee a durable write. */
  apply(op: TurnStreamOp): ApplyStreamResult;
  /**
   * Force all pending mutations to durable storage (single commit for the
   * JSON adapter). Must complete before terminal settle/wake/snapshot.
   */
  flush(): CommitResult;
  /** Pending in-memory ops (test / debug only). */
  readonly pendingOps: number;
  /** Number of flush() invocations (test / debug only). */
  readonly flushCount: number;
}

export type TurnStreamCommitStore = Pick<TaskStore, 'commit' | 'getFile'>;

/**
 * Apply one stream op to a store draft. Shared by JsonTurnStreamBuffer flush
 * so engine-equivalent mutators stay in one place.
 *
 * @returns ok:false with reason when the target turn is missing.
 */
export function applyTurnStreamOpToDraft(
  draft: TaskStoreFile,
  op: TurnStreamOp,
): { ok: true } | { ok: false; reason: string } {
  const draftTurn = draft.turns[op.turnId];
  if (!draftTurn) {
    return { ok: false, reason: 'turn not found' };
  }

  switch (op.type) {
    case 'assistantDelta': {
      const existing = draft.messages[op.segmentId];
      if (!existing) {
        draft.messages[op.segmentId] = {
          id: op.segmentId,
          taskId: op.taskId,
          role: 'assistant',
          content: op.content,
          state: 'partial',
          createdAt: op.createdAt,
          turnId: op.turnId,
          order: op.order,
        };
      } else {
        draft.messages[op.segmentId] = {
          ...existing,
          content: existing.content + op.content,
        };
      }
      return { ok: true };
    }
    case 'reasoningDelta': {
      draft.reasoning = draft.reasoning ?? {};
      const existing = draft.reasoning[op.turnId];
      draft.reasoning[op.turnId] = existing
        ? { ...existing, content: existing.content + op.content, updatedAt: op.now }
        : {
            id: op.turnId,
            taskId: op.taskId,
            turnId: op.turnId,
            content: op.content,
            createdAt: op.now,
            updatedAt: op.now,
          };
      return { ok: true };
    }
    case 'toolStarted': {
      draft.toolCalls = draft.toolCalls ?? {};
      if (!draft.toolCalls[op.compositeId]) {
        draft.toolCalls[op.compositeId] = {
          id: op.compositeId,
          taskId: op.taskId,
          turnId: op.turnId,
          toolCallId: op.toolCallId,
          order: op.order,
          name: op.name,
          kind: op.kind,
          status: 'running',
          input: op.input,
          createdAt: op.createdAt,
          updatedAt: op.createdAt,
        };
      }
      return { ok: true };
    }
    case 'toolUpdated': {
      draft.toolCalls = draft.toolCalls ?? {};
      const existing = draft.toolCalls[op.compositeId];
      // Adapter toolUpdated.input is a full snapshot — replace, not merge.
      draft.toolCalls[op.compositeId] = existing
        ? {
            ...existing,
            input: op.input !== undefined ? op.input : existing.input,
            updatedAt: op.now,
          }
        : {
            id: op.compositeId,
            taskId: op.taskId,
            turnId: op.turnId,
            toolCallId: op.toolCallId,
            order: op.order,
            name: 'tool',
            status: 'running',
            input: op.input,
            createdAt: op.now,
            updatedAt: op.now,
          };
      return { ok: true };
    }
    case 'toolCompleted': {
      draft.toolCalls = draft.toolCalls ?? {};
      const existing = draft.toolCalls[op.compositeId];
      const base =
        existing ??
        {
          id: op.compositeId,
          taskId: op.taskId,
          turnId: op.turnId,
          toolCallId: op.toolCallId,
          order: op.order,
          name: 'tool',
          status: 'running' as const,
          createdAt: op.now,
          updatedAt: op.now,
        };
      draft.toolCalls[op.compositeId] = {
        ...base,
        status: op.outcome === 'error' ? 'error' : 'success',
        updatedAt: op.now,
        ...(op.outcome === 'error'
          ? { error: op.error, output: undefined }
          : { output: op.output, error: undefined }),
      };
      return { ok: true };
    }
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/**
 * Temporary JSON adapter: buffers stream ops in memory and flushes them as a
 * single TaskStore.commit. Marked for deletion once SQLite appendTranscriptBatch
 * exists (see JSON_TURN_STREAM_BUFFER_DELETION_GATE / D035).
 */
export class JsonTurnStreamBuffer implements TurnStreamPersistence {
  /** @see JSON_TURN_STREAM_BUFFER_DELETION_GATE */
  static readonly DELETION_GATE = JSON_TURN_STREAM_BUFFER_DELETION_GATE;

  private readonly pending: TurnStreamOp[] = [];
  private _flushCount = 0;

  constructor(private readonly store: TurnStreamCommitStore) {}

  get pendingOps(): number {
    return this.pending.length;
  }

  get flushCount(): number {
    return this._flushCount;
  }

  apply(op: TurnStreamOp): ApplyStreamResult {
    this.pending.push(op);
    return { ok: true };
  }

  flush(): CommitResult {
    this._flushCount += 1;
    if (this.pending.length === 0) {
      // No durable write when nothing is pending — still counts as a flush for
      // terminal-ordering callers (invariant 9).
      const file = this.store.getFile();
      return { ok: true, revision: file.revision, file };
    }

    // Snapshot then clear only after a successful commit so a failed flush can
    // retain ops for the caller (settleFailed / retry policy).
    const batch = this.pending.slice();
    const result = this.store.commit((draft) => {
      for (const op of batch) {
        const applied = applyTurnStreamOpToDraft(draft, op);
        if (!applied.ok) {
          return { ok: false, reason: applied.reason };
        }
      }
      return { ok: true };
    });

    if (result.ok) {
      this.pending.length = 0;
    }
    // TaskStore maps apply rejections to reason:'rejected' with optional detail.
    return result;
  }
}

/**
 * Factory helper for engine wiring (T02). Kept thin so tests can construct the
 * class directly while production still has one creation site.
 */
export function createJsonTurnStreamBuffer(store: TurnStreamCommitStore): JsonTurnStreamBuffer {
  return new JsonTurnStreamBuffer(store);
}
