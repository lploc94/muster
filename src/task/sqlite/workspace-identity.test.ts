import { describe, expect, it } from 'vitest';
import { resolveWorkspaceIdentity } from './workspace-identity';

describe('resolveWorkspaceIdentity', () => {
  it('keys a single-root workspace by folder URI', () => {
    const id = resolveWorkspaceIdentity({
      kind: 'single-root',
      folderUri: 'file:///Users/me/projects/muster',
    });
    expect(id.identityKey).toBe('single:file:///Users/me/projects/muster');
    expect(id.locations).toEqual(['file:///Users/me/projects/muster']);
    expect(id.displayName).toBe('muster');
  });

  it('keys a multi-root workspace by its workspace file when present', () => {
    const id = resolveWorkspaceIdentity({
      kind: 'multi-root',
      workspaceFileUri: 'file:///Users/me/team.code-workspace',
      folderUris: ['file:///a', 'file:///b'],
    });
    expect(id.identityKey).toBe('multi-file:file:///Users/me/team.code-workspace');
    expect(id.locations).toContain('file:///a');
  });

  it('multi-root without a file is stable under folder reordering', () => {
    const a = resolveWorkspaceIdentity({
      kind: 'multi-root',
      folderUris: ['file:///a', 'file:///b'],
    });
    const b = resolveWorkspaceIdentity({
      kind: 'multi-root',
      folderUris: ['file:///b', 'file:///a'],
    });
    expect(a.identityKey).toBe(b.identityKey);
    expect(a.locations).toEqual(['file:///a', 'file:///b']);
  });

  it('gives an empty window a FIXED id per profile authority (never per-activation)', () => {
    const a = resolveWorkspaceIdentity({ kind: 'empty', profileAuthority: 'default' });
    const b = resolveWorkspaceIdentity({ kind: 'empty', profileAuthority: 'default' });
    expect(a.identityKey).toBe('empty:default');
    expect(a.identityKey).toBe(b.identityKey);
    expect(a.locations).toEqual([]);
  });

  it('separates empty windows across different profile authorities', () => {
    const a = resolveWorkspaceIdentity({ kind: 'empty', profileAuthority: 'default' });
    const b = resolveWorkspaceIdentity({ kind: 'empty', profileAuthority: 'ssh-remote+box' });
    expect(a.identityKey).not.toBe(b.identityKey);
  });

  it('decodes percent-encoded folder names for display', () => {
    const id = resolveWorkspaceIdentity({
      kind: 'single-root',
      folderUri: 'file:///Users/me/my%20project',
    });
    expect(id.displayName).toBe('my project');
  });
});
