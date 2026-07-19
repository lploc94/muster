import type { EngineProjection } from '../task/types';

export type PresentationChatLinkResult =
  | { ok: true; code: 'revealed' }
  | { ok: false; code: 'not-found' | 'not-owner' | 'host-failure' };

export interface PresentationTaskReader { getFile(): Pick<EngineProjection, 'tasks'> }
export interface PresentationChatHost { executeCommand(command: string): PromiseLike<unknown> }
export interface PresentationChatFocus { focusTask(taskId: string): void }

/** Reveals and hydrates an existing root coordinator; it never creates or mutates tasks. */
export function createPresentationChatLink(
  store: PresentationTaskReader,
  host: PresentationChatHost,
  chat: PresentationChatFocus,
): (ownerTaskId: string) => Promise<PresentationChatLinkResult> {
  return async (ownerTaskId) => {
    const owner = store.getFile().tasks[ownerTaskId];
    if (!owner) return { ok: false, code: 'not-found' };
    if (owner.role !== 'coordinator' || owner.parentId !== null) {
      return { ok: false, code: 'not-owner' };
    }
    try {
      await host.executeCommand('muster.openChat');
      chat.focusTask(ownerTaskId);
      return { ok: true, code: 'revealed' };
    } catch {
      return { ok: false, code: 'host-failure' };
    }
  };
}
