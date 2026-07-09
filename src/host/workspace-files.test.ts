import { describe, expect, it, vi } from 'vitest';
import { pickWorkspaceFileMentionPath } from './workspace-files';

describe('workspace file Quick Pick helper', () => {
  it('finds workspace files, shows normalized labels, and returns the selected mention path', async () => {
    const findFiles = vi.fn().mockResolvedValue([
      { fsPath: '/workspace/src/extension.ts' },
      { fsPath: '/workspace/README.md' },
    ]);
    const showQuickPick = vi.fn().mockResolvedValue({ uri: { fsPath: '/workspace/src/extension.ts' } });

    await expect(
      pickWorkspaceFileMentionPath({
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        findFiles,
        showQuickPick,
      }),
    ).resolves.toEqual({ type: 'picked', path: 'src/extension.ts' });

    expect(findFiles).toHaveBeenCalledWith('**/*', '**/{.git,node_modules,dist,out}/**', 500);
    expect(showQuickPick).toHaveBeenCalledWith(
      [
        { label: 'README.md', uri: { fsPath: '/workspace/README.md' } },
        { label: 'src/extension.ts', uri: { fsPath: '/workspace/src/extension.ts' } },
      ],
      {
        canPickMany: false,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Select a workspace file to add to chat',
      },
    );
  });

  it('returns noWorkspace without touching file discovery when no workspace folder is open', async () => {
    const findFiles = vi.fn();
    const showQuickPick = vi.fn();

    await expect(
      pickWorkspaceFileMentionPath({
        workspaceFolders: undefined,
        findFiles,
        showQuickPick,
      }),
    ).resolves.toEqual({ type: 'noWorkspace' });

    expect(findFiles).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('returns noFiles without opening Quick Pick when workspace discovery is empty', async () => {
    const findFiles = vi.fn().mockResolvedValue([]);
    const showQuickPick = vi.fn();

    await expect(
      pickWorkspaceFileMentionPath({
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        findFiles,
        showQuickPick,
      }),
    ).resolves.toEqual({ type: 'noFiles' });

    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('ignores discovered files outside workspace folders instead of showing an empty Quick Pick', async () => {
    const findFiles = vi.fn().mockResolvedValue([{ fsPath: '/tmp/outside.txt' }]);
    const showQuickPick = vi.fn();

    await expect(
      pickWorkspaceFileMentionPath({
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        findFiles,
        showQuickPick,
      }),
    ).resolves.toEqual({ type: 'noFiles' });

    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('returns cancelled without a picked path when the user dismisses Quick Pick', async () => {
    const findFiles = vi.fn().mockResolvedValue([{ fsPath: '/workspace/README.md' }]);
    const showQuickPick = vi.fn().mockResolvedValue(undefined);

    await expect(
      pickWorkspaceFileMentionPath({
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        findFiles,
        showQuickPick,
      }),
    ).resolves.toEqual({ type: 'cancelled' });
  });

  it('bubbles workspace discovery failures so the extension host can report actionable errors', async () => {
    const error = new Error('workspace discovery failed');

    await expect(
      pickWorkspaceFileMentionPath({
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        findFiles: vi.fn().mockRejectedValue(error),
        showQuickPick: vi.fn(),
      }),
    ).rejects.toBe(error);
  });
});
