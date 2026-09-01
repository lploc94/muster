/**
 * M023/S09 T01 guard.
 *
 * `trg_terminal_workflow_history_prune_before_turn_delete` is compared by
 * `schema-fingerprint.ts` between the runtime golden manifest and the trigger
 * text physically stored in a user's database. A token-order change there is
 * reported as `trigger_mismatch`, which `connection.ts` escalates to
 * `IncompatibleSchemaError`. This reset-only development store deliberately
 * requires an explicit reset after predicate changes.
 *
 * These assertions pin the normalized fingerprint and guard inventory so any
 * future edit is accompanied by the required reset-only schema-version decision.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  CURRENT_SCHEMA_STATEMENTS,
  terminalWorkflowPayloadReclamationSafetyPredicate,
  terminalWorkflowRunSafetyPredicate,
} from './schema';
import { normalizeSchemaSql } from './schema-fingerprint';

const TRIGGER_NAME = 'trg_terminal_workflow_history_prune_before_turn_delete';

/** Captured from the schema-7 decision-repair and cross-run artifact-pin predicate. */
const PINNED_NORMALIZED_LENGTH = 3446;
const PINNED_NORMALIZED_SHA256 =
  '2472b74e9cfc9698902cf5a052fcfc00ceb587b194d7c3c51499911c49237141';
const PINNED_TRIGGER_COUNT = 160;

function openCurrentSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
  return db;
}

function storedTriggerSql(db: DatabaseSync, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?`)
    .get(name) as { sql: string | null } | undefined;
  if (!row?.sql) throw new Error(`trigger not found: ${name}`);
  return row.sql;
}

describe('terminal workflow prune trigger fingerprint', () => {
  it('pins the normalized trigger SQL for the current reset-only schema', () => {
    const db = openCurrentSchema();
    try {
      const normalized = normalizeSchemaSql(storedTriggerSql(db, TRIGGER_NAME));
      expect(normalized).toHaveLength(PINNED_NORMALIZED_LENGTH);
      expect(createHash('sha256').update(normalized).digest('hex')).toBe(
        PINNED_NORMALIZED_SHA256,
      );
    } finally {
      db.close();
    }
  });

  it('keeps the total trigger count stable', () => {
    const db = openCurrentSchema();
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger'`)
        .get() as { count: number };
      expect(row.count).toBe(PINNED_TRIGGER_COUNT);
    } finally {
      db.close();
    }
  });
});

describe('terminalWorkflowRunSafetyPredicate', () => {
  it('correlates every guard on the requested outer alias', () => {
    const predicate = terminalWorkflowRunSafetyPredicate('run');
    expect(predicate).toContain('run.workspace_id');
    expect(predicate).toContain('run.run_id');
    // A workspace-wide reclamation query must not correlate on the bare table name.
    expect(predicate).not.toContain('workflow_runs.workspace_id');
    expect(predicate).not.toContain('workflow_runs.run_id');
  });

  it('emits all eight liveness and four cross-run artifact-pin guards', () => {
    const predicate = terminalWorkflowRunSafetyPredicate('run');
    expect(predicate.match(/AND NOT EXISTS/g) ?? []).toHaveLength(12);
    for (const table of [
      'workflow_runs child',
      'workflow_nodes node',
      'workflow_dependency_gates gate_row',
      'workflow_feedback_rounds round_row',
      'workflow_activations activation',
      'workflow_decision_repairs repair',
      'workflow_continuations continuation',
      'workflow_return_gates return_gate',
      'workflow_gate_fills gate_fill',
      'workflow_nodes reused_node',
      'workflow_artifact_sources derived_source',
      'workflow_return_gates return_gate_artifact',
    ]) {
      expect(predicate).toContain(table);
    }
  });

  it('omits only the open-repair guard when reclaiming terminal payload bodies', () => {
    const predicate = terminalWorkflowPayloadReclamationSafetyPredicate('run');
    expect(predicate.match(/AND NOT EXISTS/g) ?? []).toHaveLength(11);
    expect(predicate).not.toContain('workflow_decision_repairs repair');
    for (const table of [
      'workflow_runs child',
      'workflow_nodes node',
      'workflow_dependency_gates gate_row',
      'workflow_feedback_rounds round_row',
      'workflow_activations activation',
      'workflow_continuations continuation',
      'workflow_return_gates return_gate',
      'workflow_gate_fills gate_fill',
      'workflow_nodes reused_node',
      'workflow_artifact_sources derived_source',
      'workflow_return_gates return_gate_artifact',
    ]) {
      expect(predicate).toContain(table);
    }
  });
});
