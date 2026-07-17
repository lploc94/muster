import type { MusterTask, TaskStoreFile, TaskTurn, TaskViewStatus } from './types';

/**
 * Read-only compatibility port consumed by legacy JSON tests and the in-memory
 * repository projection.  Runtime domain code depends on this shape rather than
 * the filesystem-backed legacy store implementation.
 */
export interface TaskReadPort {
  getFile(): Readonly<TaskStoreFile>;
  getTask(taskId: string): MusterTask | undefined;
  getTurnsForTask(taskId: string): TaskTurn[];
  viewStatusOf(taskId: string): TaskViewStatus | undefined;
}

/** Host-only port needed by the synchronous compatibility constructor. */
export interface LegacyStorePort extends TaskReadPort {
  getStorePath(): string;
  commit(apply: (draft: TaskStoreFile) => { ok: true } | { ok: false; reason: string }): {
    ok: true;
    revision?: number;
  } | { ok: false; reason: string; detail?: string };
}
