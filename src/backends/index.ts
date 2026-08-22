import type { Backend } from '../types';
import { ACP_EXECUTOR_FAMILY, resolveExecutor } from './executor-registry';

/**
 * Agent-only backend IDs. Derived from the ACP family so registering another
 * executor family cannot silently widen this closed surface.
 */
export const BACKEND_IDS = ACP_EXECUTOR_FAMILY.executorIds;
export type BackendId = (typeof BACKEND_IDS)[number];

export function isKnownBackendId(name: string): name is BackendId {
  return (BACKEND_IDS as readonly string[]).includes(name);
}

/** Public backend construction seam retained for all existing callers. */
export function makeBackend(name: string): Backend {
  return resolveExecutor(name);
}
