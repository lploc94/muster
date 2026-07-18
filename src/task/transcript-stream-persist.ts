/**
 * Production transcript stream persist adapter (P5-W3).
 */
import type { TaskRepository } from './repository';
import { diagnoseSqliteError } from './sqlite/diagnostics';
import type { StreamBatchPayload } from './transcript-stream-batcher';

export function createTranscriptStreamPersist(input: {
  repository: TaskRepository;
  workspaceId: string;
  isStorageTerminal?: () => boolean;
}): (payload: StreamBatchPayload) => Promise<{ changed: boolean; reason?: string }> {
  return async (payload) => {
    if (input.isStorageTerminal?.()) {
      throw new Error('storage terminal');
    }
    try {
      const result = await input.repository.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: input.workspaceId,
        taskId: payload.taskId,
        ...(payload.messages ? { messages: payload.messages } : {}),
        ...(payload.reasoning ? { reasoning: payload.reasoning } : {}),
      });
      return { changed: result.changed === true, reason: result.reason };
    } catch (error) {
      if (input.isStorageTerminal?.()) {
        throw new Error('storage terminal');
      }
      const diagnostic = diagnoseSqliteError(error, 'transaction');
      throw new Error(diagnostic.message);
    }
  };
}
