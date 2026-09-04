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

    expect(predicate).toContain('FROM workflow_nodes reused_node');
    expect(predicate).toContain('reused_node.workspace_id = run.workspace_id');
    expect(predicate).toContain('reused_node.source_run_id = run.run_id');
    expect(predicate).toContain('reused_node.run_id <> run.run_id');

    // Schema 8 removes nested-run return gates. Cross-run pins are represented
    // only by the run-owned gate-fill, reused-node, and artifact-source rows.
    expect(predicate).not.toContain('workflow_return_gates');
    expect(predicate).not.toContain('parent_run_id');
    expect(predicate).toContain('FROM workflow_artifact_sources derived_source');
  });

  it('retains the pinned-run predicate in the current schema version', () => {
    // Schema 8 adds immutable run-owned execution authority and removes nested
    // workflow return-gate state without weakening cross-run pin protection.
    expect(SQLITE_SCHEMA_VERSION).toBe(8);
  });
});
