import * as path from 'path';

export interface WorkspaceFileUri {
  fsPath: string;
}

export interface WorkspaceFolderLike {
  uri: WorkspaceFileUri;
}

export interface WorkspaceFileQuickPickItem {
  label: string;
  uri: WorkspaceFileUri;
}

export interface WorkspaceFilePickServices {
  workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
  findFiles(
    include: string,
    exclude?: string,
    maxResults?: number,
  ): Thenable<readonly WorkspaceFileUri[]> | Promise<readonly WorkspaceFileUri[]>;
  showQuickPick(
    items: readonly WorkspaceFileQuickPickItem[],
    options: {
      canPickMany: false;
      matchOnDescription: boolean;
      matchOnDetail: boolean;
      placeHolder: string;
    },
  ): Thenable<WorkspaceFileQuickPickItem | undefined> | Promise<WorkspaceFileQuickPickItem | undefined>;
}

export type WorkspaceFilePickResult =
  | { type: 'picked'; path: string }
  | { type: 'cancelled' }
  | { type: 'noWorkspace' }
  | { type: 'noFiles' };

const INCLUDE_WORKSPACE_FILES_GLOB = '**/*';
const EXCLUDE_WORKSPACE_FILES_GLOB = '**/{.git,node_modules,dist,out}/**';
const MAX_WORKSPACE_FILE_RESULTS = 500;

function normalizeMentionPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function mentionPathForUri(uri: WorkspaceFileUri, workspaceFolders: readonly WorkspaceFolderLike[]): string | undefined {
  for (const folder of workspaceFolders) {
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return normalizeMentionPath(relative);
    }
  }
  return undefined;
}

export async function pickWorkspaceFileMentionPath(
  services: WorkspaceFilePickServices,
): Promise<WorkspaceFilePickResult> {
  const workspaceFolders = services.workspaceFolders ?? [];
  if (workspaceFolders.length === 0) {
    return { type: 'noWorkspace' };
  }

  const files = await services.findFiles(
    INCLUDE_WORKSPACE_FILES_GLOB,
    EXCLUDE_WORKSPACE_FILES_GLOB,
    MAX_WORKSPACE_FILE_RESULTS,
  );
  if (files.length === 0) {
    return { type: 'noFiles' };
  }

  const items = files
    .flatMap((uri) => {
      const label = mentionPathForUri(uri, workspaceFolders);
      return label ? [{ label, uri }] : [];
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  if (items.length === 0) {
    return { type: 'noFiles' };
  }

  const picked = await services.showQuickPick(items, {
    canPickMany: false,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: 'Select a workspace file to add to chat',
  });

  if (!picked) {
    return { type: 'cancelled' };
  }

  const mentionPath = mentionPathForUri(picked.uri, workspaceFolders);
  return mentionPath ? { type: 'picked', path: mentionPath } : { type: 'cancelled' };
}
