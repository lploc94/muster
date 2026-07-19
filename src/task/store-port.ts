import type { MusterTask, EngineProjection, TaskTurn, TaskViewStatus } from './types';

/** Read-only engine projection refreshed from the durable repository. */
export interface TaskReadPort {
  getFile(): Readonly<EngineProjection>;
  getTask(taskId: string): MusterTask | undefined;
  getTurnsForTask(taskId: string): TaskTurn[];
  viewStatusOf(taskId: string): TaskViewStatus | undefined;
}
