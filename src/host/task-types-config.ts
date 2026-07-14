/**
 * Host-side reader for muster.taskTypes (resource-scoped VS Code setting).
 * Pure relative to VS Code: callers inject a raw-value reader.
 */

import {
  parseTaskTypeRegistry,
  type TaskTypeRegistryResult,
} from '../task/task-types';

export const TASK_TYPES_CONFIG_KEY = 'taskTypes';
export const TASK_TYPES_CONFIG_SECTION = 'muster';

/**
 * Parse raw configuration value into a full TaskTypeRegistryResult.
 * Never collapses invalid → empty.
 */
export function readTaskTypeRegistryFromRaw(raw: unknown): TaskTypeRegistryResult {
  return parseTaskTypeRegistry(raw);
}

/**
 * cwd-aware registry load. `readRaw(cwd?)` should return the effective
 * `muster.taskTypes` value for that folder (or workspace default when cwd omitted).
 * Read failures → status invalid with diagnostics (not silent empty).
 */
export function loadTaskTypeRegistry(
  readRaw: (cwd?: string) => unknown,
  cwd?: string,
): TaskTypeRegistryResult {
  try {
    return parseTaskTypeRegistry(readRaw(cwd));
  } catch {
    return {
      status: 'invalid',
      registry: new Map(),
      diagnostics: [
        {
          code: 'read_failed',
          message: 'Failed to read muster.taskTypes configuration',
        },
      ],
    };
  }
}
