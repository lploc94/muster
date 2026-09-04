import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_STATEMENTS,
  MUSTER_WRITER_VERSION_UDF,
  SQLITE_SCHEMA_VERSION,
} from './schema';

function openFixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.function(MUSTER_WRITER_VERSION_UDF, { deterministic: true }, () => SQLITE_SCHEMA_VERSION);
  for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
  db.exec(`
    INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
    VALUES ('ws', 'ws', 'ws', 'now', 'now');
    INSERT INTO workflow_definitions (
      workspace_id, definition_id, version, name, fingerprint, created_at
    ) VALUES ('ws', 'wf', 1, 'wf', 'fixture-fingerprint', 'now');
    INSERT INTO workflow_definition_nodes (
      workspace_id, definition_id, definition_version, node_id, ordinal
    ) VALUES ('ws', 'wf', 1, 'node', 0);
    INSERT INTO workflow_definition_outputs (
      workspace_id, definition_id, definition_version, name, semantic_kind,
      source_node_id, ordinal, expected_artifact_kind
    ) VALUES ('ws', 'wf', 1, 'result', 'result', 'node', 0, 'next_result');
    INSERT INTO workflow_runs (
      workspace_id, run_id, authority_kind, authority_fingerprint, authority_name,
      authority_scope_kind, source_definition_id, source_definition_version,
      status, policy_json, created_at, updated_at
    ) VALUES
      ('ws', 'run', 'definition', '${'a'.repeat(64)}', 'wf', 'workspace', 'wf', 1,
       'running', '{"failWorkflow":true}', 'now', 'now'),
      ('ws', 'source-run', 'definition', '${'b'.repeat(64)}', 'wf', 'workspace', 'wf', 1,
       'succeeded', '{"failWorkflow":true}', 'now', 'now');
    INSERT INTO workflow_run_components (
      workspace_id, run_id, component_key, ordinal, source_kind, workflow_ref,
      source_definition_id, source_definition_version, source_fingerprint, component_fingerprint
    ) VALUES
      ('ws', 'run', 'definition', 0, 'workflow', 'wf@1', 'wf', 1, '${'c'.repeat(64)}', '${'a'.repeat(64)}'),
      ('ws', 'source-run', 'definition', 0, 'workflow', 'wf@1', 'wf', 1, '${'c'.repeat(64)}', '${'b'.repeat(64)}');
    INSERT INTO workflow_run_node_specs (
      workspace_id, run_id, node_id, ordinal, component_key, local_node_key,
      outcome_kind, outcome_json
    ) VALUES
      ('ws', 'run', 'node', 0, 'definition', 'node', 'agent', '{"kind":"agent","requireExplicitDisposition":true,"next":{"when":"next"},"fail":{"when":"fail"}}'),
      ('ws', 'source-run', 'source', 0, 'definition', 'node', 'agent', '{"kind":"agent","requireExplicitDisposition":true,"next":{"when":"next"},"fail":{"when":"fail"}}');
    INSERT INTO tasks (
      id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
      revision, created_at, updated_at, payload_json
    ) VALUES
      ('source-task', 'ws', NULL, 'worker', 'succeeded', 'released', 'source', 'grok', NULL, 0, 'now', 'now', '{}'),
      ('wrong-task', 'ws', NULL, 'worker', 'succeeded', 'released', 'wrong', 'grok', NULL, 0, 'now', 'now', '{}');
    INSERT INTO turns (
      id, workspace_id, task_id, sequence, status, trigger, created_at, settled_at, payload_json
    ) VALUES ('source-turn', 'ws', 'source-task', 1, 'succeeded', 'engine', 'now', 'now', '{}');
    INSERT INTO messages (
      id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, payload_json
    ) VALUES ('source-message', 'ws', 'source-task', 'source-turn', 'assistant', 'complete', 0, 'result', 'now', '{}');
    INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
    VALUES ('ws', 'source-run', 'source', 'source-task', 'succeeded');
    INSERT INTO workflow_activations (
      workspace_id, run_id, activation_id, node_id, kind, status, source_gate_id,
      primary_turn_id, message_id, execution_turn_id, created_at, updated_at
    ) VALUES (
      'ws', 'source-run', 'source-activation', 'source', 'entry_start', 'consumed', 'source-gate',
      'source-turn', 'source-message', 'source-turn', 'now', 'now'
    );
    INSERT INTO workflow_artifacts (
      workspace_id, run_id, artifact_id, producer_node_id, logical_name,
      revision, kind, payload_json, created_at
    ) VALUES
      ('ws', 'source-run', 'artifact', 'source', 'next_result', 1, 'next_result', '{}', 'now'),
      ('ws', 'source-run', 'artifact-other', 'source', 'next_result', 1, 'next_result', '{}', 'now');
    INSERT INTO workflow_artifact_sources (
      workspace_id, run_id, artifact_id, artifact_revision, source_kind,
      producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
      producing_activation_id
    ) VALUES
      ('ws', 'source-run', 'artifact', 1, 'workflow_node', 'source-run', 'source', 'source-task', 'source-turn', 'source-activation'),
      ('ws', 'source-run', 'artifact-other', 1, 'workflow_node', 'source-run', 'source', 'source-task', 'source-turn', 'source-activation');
  `);
  return db;
}

describe('workflow node reuse invariants', () => {
  it('requires provenance exactly for reused rows', () => {
    const db = openFixture();
    try {
      expect(() => db.exec(`
        INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
        VALUES ('ws', 'run', 'node', NULL, 'reused')
      `)).toThrow();
      expect(() => db.exec(`
        INSERT INTO workflow_nodes (
          workspace_id, run_id, node_id, task_id, status,
          source_run_id, source_node_id, source_task_id,
          source_artifact_id, source_artifact_revision
        ) VALUES ('ws', 'run', 'node', NULL, 'pending', 'source-run', 'source', 'source-task', 'artifact', 1)
      `)).toThrow();
    } finally {
      db.close();
    }
  });

  it('makes reused status and provenance immutable while allowing materialized transitions', () => {
    const db = openFixture();
    try {
      db.exec(`
        INSERT INTO workflow_nodes (
          workspace_id, run_id, node_id, task_id, status,
          source_run_id, source_node_id, source_task_id,
          source_artifact_id, source_artifact_revision
        ) VALUES ('ws', 'run', 'node', NULL, 'reused', 'source-run', 'source', 'source-task', 'artifact', 1)
      `);
      expect(() => db.exec(`
        UPDATE workflow_nodes SET status = 'pending'
        WHERE workspace_id = 'ws' AND run_id = 'run' AND node_id = 'node'
      `)).toThrow(/workflow_node_reuse_immutable/);
      expect(() => db.exec(`
        UPDATE workflow_nodes SET source_task_id = 'replacement'
        WHERE workspace_id = 'ws' AND run_id = 'run' AND node_id = 'node'
      `)).toThrow(/workflow_node_reuse_immutable/);
      expect(() => db.exec(`
        UPDATE workflow_nodes SET source_artifact_id = 'artifact-other'
        WHERE workspace_id = 'ws' AND run_id = 'run' AND node_id = 'node'
      `)).toThrow(/workflow_node_reuse_immutable/);

      db.exec(`
        DELETE FROM workflow_nodes WHERE workspace_id = 'ws' AND run_id = 'run';
        INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
        VALUES ('ws', 'run', 'node', NULL, 'pending');
        UPDATE workflow_nodes SET status = 'active'
        WHERE workspace_id = 'ws' AND run_id = 'run' AND node_id = 'node';
        UPDATE workflow_nodes SET status = 'succeeded'
        WHERE workspace_id = 'ws' AND run_id = 'run' AND node_id = 'node';
      `);
      expect(db.prepare(`SELECT status FROM workflow_nodes`).get()).toEqual({ status: 'succeeded' });
    } finally {
      db.close();
    }
  });

  it('rejects a reused row whose source task did not produce the pinned artifact', () => {
    const db = openFixture();
    try {
      expect(() => db.exec(`
        INSERT INTO workflow_nodes (
          workspace_id, run_id, node_id, task_id, status,
          source_run_id, source_node_id, source_task_id,
          source_artifact_id, source_artifact_revision
        ) VALUES (
          'ws', 'run', 'node', NULL, 'reused',
          'source-run', 'source', 'wrong-task', 'artifact', 1
        )
      `)).toThrow(/workflow_node_reuse_invalid/);
    } finally {
      db.close();
    }
  });
});
