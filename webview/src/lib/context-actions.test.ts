import { describe, expect, it } from 'vitest';

import { ADD_CONTEXT_ACTIONS, getAddContextAction, getAddContextActionHostMessage } from './context-actions';
import type { OutMessage } from './protocol';

const EXPECTED_ACTION_IDS = [
  'add-file',
  'browse-workspace-files',
  'add-skill',
  'add-wiki-page',
  'add-agent',
  'add-browser-tab',
  'add-web-search',
] as const;

describe('Add Context action model', () => {
  it('defines the full Add Context menu contract in stable display order', () => {
    expect(ADD_CONTEXT_ACTIONS.map((action) => action.id)).toEqual(EXPECTED_ACTION_IDS);

    for (const action of ADD_CONTEXT_ACTIONS) {
      expect(action.label.trim(), action.id).not.toBe('');
      expect(action.description.trim(), action.id).not.toBe('');
      expect(action.icon, action.id).toMatch(/^codicon-/);
    }
  });

  it('marks implemented actions as enabled host-postable messages without changing protocol payloads', () => {
    const enabled = ADD_CONTEXT_ACTIONS.filter((action) => action.state === 'enabled');

    expect(enabled.map((action) => action.id)).toEqual([
      'add-file',
      'browse-workspace-files',
      'add-skill',
    ]);

    // Host-postable enabled actions carry a protocol message.
    expect(getAddContextActionHostMessage('add-file')).toEqual({ type: 'pickFile' } satisfies OutMessage);
    expect(getAddContextActionHostMessage('browse-workspace-files')).toEqual(
      { type: 'browseWorkspaceFiles' } satisfies OutMessage,
    );

    // The skill picker is enabled but handled in-webview (client action, no host message).
    const skill = getAddContextAction('add-skill');
    expect(skill.state).toBe('enabled');
    expect(skill.state === 'enabled' ? skill.clientAction : undefined).toBe('openSkillPicker');
    expect(getAddContextActionHostMessage('add-skill')).toBeNull();
  });

  it('prevents disabled and coming-soon actions from emitting host messages', () => {
    const unavailable = ADD_CONTEXT_ACTIONS.filter((action) => action.state !== 'enabled');

    expect(unavailable.map((action) => [action.id, action.state])).toEqual([
      ['add-wiki-page', 'comingSoon'],
      ['add-agent', 'comingSoon'],
      ['add-browser-tab', 'comingSoon'],
      ['add-web-search', 'comingSoon'],
    ]);

    for (const action of unavailable) {
      expect(action.disabledReason.trim(), action.id).not.toBe('');
      expect(getAddContextActionHostMessage(action.id), action.id).toBeNull();
    }

    expect(getAddContextAction('add-file').label).toBe('Add file');
    expect(getAddContextActionHostMessage('add-file')).toEqual({ type: 'pickFile' } satisfies OutMessage);
  });
});
