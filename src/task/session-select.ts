import type { Backend } from '../types';

export function selectCommittedSessionId(
  backend: Backend,
  turn: { observedSessionId?: string },
  rawOutput: string,
  priorCommittedId: string | undefined,
): string | undefined {
  if (turn.observedSessionId) {
    return turn.observedSessionId;
  }
  const extracted = backend.extractSessionId?.(rawOutput, priorCommittedId);
  if (extracted) {
    return extracted;
  }
  return priorCommittedId;
}