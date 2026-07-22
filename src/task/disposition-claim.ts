import { createHash } from 'node:crypto';
import type { TurnDisposition } from './types';

export type DurableDispositionClaim = {
  turnId: string;
  taskId: string;
  runtimeEpoch: number;
  opId: string;
  family: 'ordinary' | 'workflow';
  kind: 'complete' | 'fail' | 'wait' | 'idle' | 'next' | 'prev' | 'workflow_fail';
  fingerprint: string;
  payloadJson: string;
};

function dispositionIdentity(disposition: TurnDisposition): Pick<
  DurableDispositionClaim,
  'family' | 'kind'
> {
  switch (disposition.kind) {
    case 'complete':
      return { family: 'ordinary', kind: 'complete' };
    case 'fail':
      return { family: 'ordinary', kind: 'fail' };
    case 'wait_tasks':
      return { family: 'ordinary', kind: 'wait' };
    case 'idle':
      return { family: 'ordinary', kind: 'idle' };
    case 'workflow_next':
    case 'invoke_child_workflow':
      return { family: 'workflow', kind: 'next' };
    case 'workflow_prev':
      return { family: 'workflow', kind: 'prev' };
    case 'workflow_fail':
      return { family: 'workflow', kind: 'workflow_fail' };
  }
}

export function durableDispositionClaim(input: {
  turnId: string;
  taskId: string;
  runtimeEpoch?: number;
  opId: string;
  disposition: TurnDisposition;
}): DurableDispositionClaim {
  const payloadJson = JSON.stringify(input.disposition);
  return {
    turnId: input.turnId,
    taskId: input.taskId,
    runtimeEpoch: input.runtimeEpoch ?? 1,
    opId: input.opId,
    ...dispositionIdentity(input.disposition),
    fingerprint: createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
    payloadJson,
  };
}
