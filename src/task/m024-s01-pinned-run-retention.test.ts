import { describe, expect, it } from 'vitest';
import {
  SQLITE_SCHEMA_VERSION,
  terminalWorkflowRunSafetyPredicate,
} from './sqlite/schema';

describe('M024 pinned terminal workflow run retention', () => {
  it('keeps a run with artifacts pinned by a different run out of reclamation', () => {
    const predicate = terminalWorkflowRunSafetyPredicate('run');

    expect(predicate).toContain('FROM workflow_gate_fills gate_fill');
    expect(predicate).toContain('gate_fill.workspace_id = run.workspace_id');
    expect(predicate).toContain('COALESCE(gate_fill.artifact_run_id, gate_fill.run_id) = run.run_id');
    expect(predicate).toContain('gate_fill.run_id <> run.run_id');

    expect(predicate).toContain('FROM workflow_return_gates return_gate_artifact');
    expect(predicate).toContain('return_gate_artifact.workspace_id = run.workspace_id');
    expect(predicate).toContain('return_gate_artifact.result_run_id = run.run_id');
    expect(predicate).toContain('return_gate_artifact.continuation_run_id <> run.run_id');
  });

  it('bumps the reset-only schema version when the prune predicate changes', () => {
    // v4 added reuse provenance columns to workflow_nodes; the store stays reset-only.
    expect(SQLITE_SCHEMA_VERSION).toBe(4);
  });
});
