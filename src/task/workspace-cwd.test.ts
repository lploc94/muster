import { describe, expect, it } from 'vitest';
import { resolveWorkspaceCwd } from './workspace-cwd';

describe('resolveWorkspaceCwd', () => {
  it('returns the single root when only one folder is open', () => {
    expect(resolveWorkspaceCwd(['/root/a'])).toBe('/root/a');
    expect(resolveWorkspaceCwd(['/root/a'], '/root/a/src/index.ts')).toBe('/root/a');
  });

  it('returns the folder the active file lives in (multi-root)', () => {
    const folders = ['/root/a', '/root/b'];
    expect(resolveWorkspaceCwd(folders, '/root/b/src/index.ts')).toBe('/root/b');
  });

  it('falls back to the first folder when the active file is outside all folders', () => {
    const folders = ['/root/a', '/root/b'];
    expect(resolveWorkspaceCwd(folders, '/elsewhere/x.ts')).toBe('/root/a');
  });

  it('falls back to the first folder when no active file is given', () => {
    expect(resolveWorkspaceCwd(['/root/a', '/root/b'])).toBe('/root/a');
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    // '/root/ab' must not match folder '/root/a'.
    expect(resolveWorkspaceCwd(['/root/a', '/root/b'], '/root/ab/x.ts')).toBe('/root/a');
  });

  it('returns undefined when no folders are open', () => {
    expect(resolveWorkspaceCwd([])).toBeUndefined();
    expect(resolveWorkspaceCwd([], '/root/a/x.ts')).toBeUndefined();
  });
});
