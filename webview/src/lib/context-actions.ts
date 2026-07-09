import type { OutMessage } from './protocol';

export type AddContextActionId =
  | 'add-file'
  | 'browse-workspace-files'
  | 'add-skill'
  | 'add-wiki-page'
  | 'add-agent'
  | 'add-browser-tab'
  | 'add-web-search';

export type AddContextActionState = 'enabled' | 'disabled' | 'comingSoon';

interface AddContextActionBase {
  id: AddContextActionId;
  label: string;
  description: string;
  state: AddContextActionState;
}

export type AddContextHostMessage = Extract<OutMessage, { type: 'pickFile' | 'browseWorkspaceFiles' }>;

export interface EnabledAddContextAction extends AddContextActionBase {
  state: 'enabled';
  hostMessage: AddContextHostMessage;
}

export interface UnavailableAddContextAction extends AddContextActionBase {
  state: 'disabled' | 'comingSoon';
  disabledReason: string;
  hostMessage?: never;
}

export type AddContextAction = EnabledAddContextAction | UnavailableAddContextAction;

export const ADD_CONTEXT_ACTIONS = [
  {
    id: 'add-file',
    label: 'Add file',
    description: 'Pick a file and insert it as context.',
    state: 'enabled',
    hostMessage: { type: 'pickFile' },
  },
  {
    id: 'browse-workspace-files',
    label: 'Browse workspace files',
    description: 'Browse the workspace and insert selected files as context.',
    state: 'enabled',
    hostMessage: { type: 'browseWorkspaceFiles' },
  },
  {
    id: 'add-skill',
    label: 'Skill',
    description: 'Attach a project or user skill as task context.',
    state: 'comingSoon',
    disabledReason: 'Skill context is coming soon.',
  },
  {
    id: 'add-wiki-page',
    label: 'Wiki page',
    description: 'Attach a project wiki page as task context.',
    state: 'comingSoon',
    disabledReason: 'Wiki page context is coming soon.',
  },
  {
    id: 'add-agent',
    label: 'Agent',
    description: 'Attach an agent definition as task context.',
    state: 'comingSoon',
    disabledReason: 'Agent context is coming soon.',
  },
  {
    id: 'add-browser-tab',
    label: 'Browser tab',
    description: 'Attach an open browser tab as task context.',
    state: 'comingSoon',
    disabledReason: 'Browser tab context is coming soon.',
  },
  {
    id: 'add-web-search',
    label: 'Web search',
    description: 'Search the web and attach results as task context.',
    state: 'comingSoon',
    disabledReason: 'Web search context is coming soon.',
  },
] as const satisfies readonly AddContextAction[];

export function getAddContextAction(id: AddContextActionId): AddContextAction {
  return ADD_CONTEXT_ACTIONS.find((action) => action.id === id) ?? ADD_CONTEXT_ACTIONS[0];
}

export function getAddContextActionHostMessage(id: AddContextActionId): AddContextHostMessage | null {
  const action = getAddContextAction(id);
  return action.state === 'enabled' ? action.hostMessage : null;
}
