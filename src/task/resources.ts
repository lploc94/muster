/**
 * Shared-cwd resource serialization (orchestration W7).
 * Path overlap + git mutex for mutating concurrent turns.
 */

import type { MusterTask, TaskBriefV1, EngineProjection, TaskTurn } from './types';

const LIVE: ReadonlySet<TaskTurn['status']> = new Set(['running', 'waiting_user']);

/**
 * Normalize a workspace-relative path. Rejects absolute paths and `..` escape.
 */
export function normalizeWorkspacePath(
  raw: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return { ok: false, reason: 'empty path' };
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, reason: 'absolute paths not allowed' };
  }
  const parts = trimmed.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    return { ok: false, reason: 'path escapes workspace (..)' };
  }
  return { ok: true, path: parts.join('/') };
}

/** Overlap if equal or ancestor/descendant prefix. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aSlash = a.endsWith('/') ? a : `${a}/`;
  const bSlash = b.endsWith('/') ? b : `${b}/`;
  return a.startsWith(bSlash) || b.startsWith(aSlash) || aSlash.startsWith(bSlash) || bSlash.startsWith(aSlash);
}

export function isMutatingTask(task: MusterTask): boolean {
  const brief = task.brief;
  const writePaths = brief?.writePaths ?? [];
  if (writePaths.length > 0) return true;
  if (task.claimsGit === true) return true;
  if (brief?.kind === 'implement') return true;
  return false;
}

export function normalizedWritePaths(brief: TaskBriefV1 | undefined): string[] {
  if (!brief?.writePaths) return [];
  const out: string[] = [];
  for (const raw of brief.writePaths) {
    const n = normalizeWorkspacePath(raw);
    if (n.ok) out.push(n.path);
  }
  return out;
}

/**
 * True if promoting candidate would conflict with an already-running mutator.
 */
export function hasResourceConflict(
  file: EngineProjection,
  candidateTaskId: string,
): { conflict: false } | { conflict: true; reason: string } {
  const candidate = file.tasks[candidateTaskId];
  if (!candidate || !isMutatingTask(candidate)) {
    return { conflict: false };
  }
  const candPaths = normalizedWritePaths(candidate.brief);
  const candGit = candidate.claimsGit === true || candidate.brief?.kind === 'implement';
  const candUnscoped = candPaths.length === 0 && isMutatingTask(candidate);

  for (const turn of Object.values(file.turns)) {
    if (!LIVE.has(turn.status)) continue;
    if (turn.taskId === candidateTaskId) continue;
    const other = file.tasks[turn.taskId];
    if (!other || !isMutatingTask(other)) continue;
    const otherPaths = normalizedWritePaths(other.brief);
    const otherGit = other.claimsGit === true || other.brief?.kind === 'implement';
    const otherUnscoped = otherPaths.length === 0;

    if (candGit && otherGit) {
      return { conflict: true, reason: 'git mutex' };
    }
    if (candUnscoped || otherUnscoped) {
      return { conflict: true, reason: 'unscoped mutator conflict' };
    }
    for (const a of candPaths) {
      for (const b of otherPaths) {
        if (pathsOverlap(a, b)) {
          return { conflict: true, reason: `path conflict: ${a} ∩ ${b}` };
        }
      }
    }
  }
  return { conflict: false };
}
