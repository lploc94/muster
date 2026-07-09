import * as path from 'path';

/**
 * Resolve the working directory a task's agent should run in, given the open
 * workspace folders and the currently active editor file.
 *
 * Pure and multi-root aware (no vscode dependency) so it is unit-testable:
 * - If `activeFileFsPath` lives inside one of `folders`, that folder wins — the
 *   user is "focused" on that root, so the agent should run there.
 * - Otherwise the first folder is the default root.
 * - With no folders open, returns undefined so the caller can fall back to
 *   `process.cwd()`.
 */
export function resolveWorkspaceCwd(
  folders: string[],
  activeFileFsPath?: string,
): string | undefined {
  if (folders.length === 0) {
    return undefined;
  }
  if (activeFileFsPath) {
    const match = folders.find((folder) => isInside(folder, activeFileFsPath));
    if (match) {
      return match;
    }
  }
  return folders[0];
}

/** True when `filePath` is `folder` itself or nested beneath it. */
function isInside(folder: string, filePath: string): boolean {
  const rel = path.relative(folder, filePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
