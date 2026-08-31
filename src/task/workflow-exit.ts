import {
  WORKFLOW_FEEDBACK_MAX_BYTES,
  fitsUtf8Bytes,
} from './content-limits';
import type { TurnDisposition } from './types';
import type { WorkflowExitOutcome } from './workflow-types';

export type WorkflowExitDisposition = Extract<TurnDisposition, {
  kind: 'workflow_next' | 'workflow_prev' | 'workflow_fail';
}>;

export interface WorkflowExitResultInput {
  nodeId: string;
  title?: string;
  outcome: WorkflowExitOutcome;
  exitCode: number;
  stdout: string;
}

export type WorkflowExitMappingResult =
  | { ok: true; disposition: WorkflowExitDisposition }
  | { ok: false; reason: string };

/**
 * Pure trusted-host mapping from one completed numeric process result to the
 * immutable execute node's declared workflow disposition. Operational process
 * errors never enter this function.
 */
export function mapWorkflowExitResult(
  input: WorkflowExitResultInput,
): WorkflowExitMappingResult {
  if (!Number.isSafeInteger(input.exitCode)) {
    return { ok: false, reason: 'script executor produced an invalid exit code' };
  }
  if (input.exitCode === 0) {
    return {
      ok: true,
      disposition: {
        kind: 'workflow_next',
        change: 'updated',
        result: input.stdout,
        execution: { kind: 'script', exitCode: 0 },
      },
    };
  }

  const hasPrev = input.outcome.prev !== undefined;
  const hasFail = input.outcome.fail !== undefined;
  if (hasPrev === hasFail) {
    return { ok: false, reason: 'script workflow exit outcome authority is invalid' };
  }
  if (input.outcome.prev) {
    if (!fitsUtf8Bytes(input.stdout, WORKFLOW_FEEDBACK_MAX_BYTES)) {
      return { ok: false, reason: 'script stdout exceeds workflow feedback limit' };
    }
    const feedback = input.stdout.trim().length > 0
      ? input.stdout
      : `Execute check ${JSON.stringify(input.title ?? input.nodeId)} exited with code ${input.exitCode} without stdout. Correct the declared producer inputs and run the check again.`;
    if (!fitsUtf8Bytes(feedback, WORKFLOW_FEEDBACK_MAX_BYTES)) {
      return { ok: false, reason: 'script workflow feedback exceeds limit' };
    }
    return {
      ok: true,
      disposition: {
        kind: 'workflow_prev',
        targets: [...input.outcome.prev.targets],
        note: feedback,
      },
    };
  }
  return {
    ok: true,
    disposition: {
      kind: 'workflow_fail',
      reason: `script exited with code ${input.exitCode}`,
    },
  };
}
