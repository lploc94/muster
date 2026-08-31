import { describe, expect, it } from 'vitest';
import { resolveConversationMenuActions } from './conversation-actions';

describe('resolveConversationMenuActions', () => {
  it('offers change model then export for a saved task', () => {
    const actions = resolveConversationMenuActions({ mode: 'task', taskId: 'task-1' });
    expect(actions.map((a) => a.id)).toEqual(['change-model', 'export-conversation']);
    expect(actions.every((a) => a.state === 'enabled')).toBe(true);
  });

  it('is empty for a draft: nothing to export and the model picker stays inline', () => {
    expect(resolveConversationMenuActions({ mode: 'draft' })).toEqual([]);
    expect(resolveConversationMenuActions({ mode: 'draft', taskId: 'task-1' })).toEqual([]);
  });

  it('disables export with a reason when the task id is missing or blank', () => {
    for (const taskId of [undefined, null, '', '   ']) {
      const actions = resolveConversationMenuActions({ mode: 'task', taskId });
      const exportAction = actions.find((a) => a.id === 'export-conversation');
      expect(exportAction?.state).toBe('disabled');
      expect(exportAction?.disabledReason).toBeTruthy();
      // Model change never depends on a persisted id.
      expect(actions.find((a) => a.id === 'change-model')?.state).toBe('enabled');
    }
  });
});
