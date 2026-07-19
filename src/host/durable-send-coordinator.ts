/**
 * Durable host send control-flow coordinator (P5-W3).
 *
 * Puts the send into SQLite before any backend schedule / ACK. Failures surface as
 * fixed sendRejected without sendAccepted, scheduling, or projection mutation.
 * Production entry: MusterChatProvider.handleSend.
 */

import type { SendOutboxEntry, TaskRepository } from '../task/repository';

export type DurableSendHostMessage =
  | {
      type: 'sendRejected';
      clientRequestId: string;
      taskId?: string;
      reason: string;
      code: 'store' | 'validation' | 'conflict' | 'capacity' | 'unknown';
    }
  | {
      type: 'sendAccepted';
      clientRequestId: string;
      taskId: string;
      messageId: string;
      turnId?: string;
    };

export type DurableSendRejectCode = 'store' | 'validation' | 'conflict' | 'capacity' | 'unknown';

export type DurableSendEngineResult =
  | {
      ok: true;
      value: {
        taskId: string;
        messageId: string;
        turnId?: string;
        /** When set, host should post one initial snapshot (new-task only). */
        snapshotTaskId?: string;
      };
    }
  | { ok: false; reason: string; code?: DurableSendRejectCode };

export type DurableSendDeps = {
  repository: TaskRepository;
  workspaceId: string;
  postMessage: (msg: DurableSendHostMessage) => void;
  /**
   * Invoked only after durable outbox commit succeeds. Must call the real
   * TaskEngine startNewTask / sendAsync path (not a vacuous ID factory).
   */
  performSend: (input: {
    clientRequestId: string;
    taskId?: string;
    text: string;
  }) => Promise<DurableSendEngineResult>;
  /**
   * Optional initial snapshot publish for new tasks only.
   * Existing-task sends rely on post-commit workspace patches.
   */
  publishProjection: (taskId: string) => void;
  clearOutbox: (clientRequestId: string) => Promise<void>;
  rejectOutbox: (clientRequestId: string) => Promise<void>;
};

export type DurableSendRequest = {
  clientRequestId: string;
  taskId?: string;
  text: string;
  entry: SendOutboxEntry;
};

const PROCESS_REJECT_REASON = 'unable to process durably queued send';

/**
 * Queue durable outbox, then perform engine send only after commit, then ACK.
 * On store fault: sendRejected only — zero performSend / zero projection / zero ACK.
 * performSend / cleanup throws never leave the composer without ACK/reject.
 */
export async function runDurableHostSend(
  deps: DurableSendDeps,
  request: DurableSendRequest,
): Promise<void> {
  try {
    await deps.repository.execute({
      kind: 'putSendOutbox',
      workspaceId: deps.workspaceId,
      entry: request.entry,
    });
  } catch {
    deps.postMessage({
      type: 'sendRejected',
      clientRequestId: request.clientRequestId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      reason: 'unable to durably queue send',
      code: 'store',
    });
    return;
  }

  // Durable commit succeeded — only now may engine scheduling run.
  let result: DurableSendEngineResult;
  try {
    result = await deps.performSend({
      clientRequestId: request.clientRequestId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      text: request.text,
    });
  } catch {
    try {
      await deps.rejectOutbox(request.clientRequestId);
    } catch {
      // best-effort cleanup
    }
    deps.postMessage({
      type: 'sendRejected',
      clientRequestId: request.clientRequestId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      reason: PROCESS_REJECT_REASON,
      code: 'store',
    });
    return;
  }

  if (!result.ok) {
    try {
      await deps.rejectOutbox(request.clientRequestId);
    } catch {
      // still emit exactly one sendRejected
    }
    deps.postMessage({
      type: 'sendRejected',
      clientRequestId: request.clientRequestId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      reason: result.reason,
      code: result.code ?? 'store',
    });
    return;
  }

  // Publish the durable ACK before deleting its recovery record. If the host
  // dies between these operations, the pending outbox can replay through the
  // durable receipt instead of losing the ACK window.
  deps.postMessage({
    type: 'sendAccepted',
    clientRequestId: request.clientRequestId,
    taskId: result.value.taskId,
    messageId: result.value.messageId,
    ...(result.value.turnId ? { turnId: result.value.turnId } : {}),
  });
  if (result.value.snapshotTaskId) {
    deps.publishProjection(result.value.snapshotTaskId);
  }

  // clearOutbox is post-ACK cleanup; failure keeps the entry for idempotent
  // receipt replay and must never turn a committed send into a rejection.
  try {
    await deps.clearOutbox(request.clientRequestId);
  } catch {
    // best-effort cleanup
  }
}
