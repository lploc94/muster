import type { TaskRepository } from './repository';
import type { TaskTurn, TurnDisposition } from './types';

export function stageDispositionForSettlement(
  repository: TaskRepository,
  turn: TaskTurn,
  disposition: TurnDisposition,
  opId: string = `settle:${turn.id}`,
) {
  return repository.execute({
    kind: 'stageDisposition',
    workspaceId: 'ws',
    turnId: turn.id,
    opId,
    turn: { ...turn, disposition },
    expectedStatuses: ['running'],
    expectedRuntimeEpoch: turn.runtimeEpoch,
  });
}
