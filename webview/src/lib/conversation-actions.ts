/**
 * Conversation-scoped composer menu (the "more" kebab next to Add Context).
 *
 * Scope is the point of this module: the top toolbar is app-scoped (back,
 * history, workflows, settings) while these actions act on the one open
 * conversation. Keeping the list + state policy here makes ordering, labels and
 * disabled reasons testable without mounting the composer.
 */

export type ConversationActionId = 'change-model' | 'export-conversation';

export type ConversationActionState = 'enabled' | 'disabled';

export interface ConversationAction {
  id: ConversationActionId;
  label: string;
  description: string;
  /** Full codicon class for the menu glyph. */
  icon: string;
  state: ConversationActionState;
  /** Present only when `state` is 'disabled'. */
  disabledReason?: string;
}

export interface ConversationMenuInput {
  /**
   * Composer mode. A draft has no conversation yet: its model choice is the
   * inline picker (a required first-run step, never buried in an overflow menu)
   * and there is nothing to export, so the menu is empty and must not render.
   */
  mode: 'draft' | 'task';
  /** Task backing this composer — the export target. */
  taskId?: string | null;
}

/**
 * Menu actions in display order for the given composer scope.
 * Returns an empty list when there is no conversation to act on.
 */
export function resolveConversationMenuActions(
  input: ConversationMenuInput,
): ConversationAction[] {
  if (input.mode !== 'task') return [];
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';

  return [
    {
      id: 'change-model',
      label: 'Change model',
      // Model change on an existing task is always a runtime handoff, never a
      // plain chat turn — say so before the user commits to it.
      description: 'Hand this task off to another backend or model.',
      icon: 'codicon-server-environment',
      state: 'enabled',
    },
    taskId
      ? {
          id: 'export-conversation',
          label: 'Export conversation',
          description: 'Save this task and its transcript to a file.',
          icon: 'codicon-export',
          state: 'enabled',
        }
      : {
          id: 'export-conversation',
          label: 'Export conversation',
          description: 'Save this task and its transcript to a file.',
          icon: 'codicon-export',
          state: 'disabled',
          disabledReason: 'Export needs a saved task.',
        },
  ];
}
