/**
 * M023/S09 T01 guard.
 *
 * `trg_terminal_workflow_history_prune_before_turn_delete` is compared by
 * `schema-fingerprint.ts` between the runtime golden manifest and the trigger
 * text physically stored in a user's database. A token-order change there is
 * reported as `trigger_mismatch`, which `connection.ts` escalates to
 * `IncompatibleSchemaError` — forcing a store reset and breaking the M023
 * promise that existing users keep their data.
 *
 * These assertions pin the normalized fingerprint so the S09 predicate
 * extraction is provably behavior-preserving, and so any future edit to that
 * trigger fails loudly here instead of silently invalidating stores in the field.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { CURRENT_SCHEMA_STATEMENTS, terminalWorkflowRunSafetyPredicate } from './schema';
import { normalizeSchemaSql } from './schema-fingerprint';

const TRIGGER_NAME = 'trg_terminal_workflow_history_prune_before_turn_delete';

/** Captured from source immediately before the S09 extraction. */
const PINNED_NORMALIZED_LENGTH = 2209;
const PINNED_NORMALIZED_SHA256 =
  'd7d2baddb185b957b631f4efcdbc1dc87d8631fa0045a38699c2a5a909f12711';
const PINNED_TRIGGER_COUNT = 138;

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
  it('preserves the normalized trigger SQL so existing stores stay compatible', () => {
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

  it('emits all seven liveness guards', () => {
    const predicate = terminalWorkflowRunSafetyPredicate('run');
    expect(predicate.match(/AND NOT EXISTS/g) ?? []).toHaveLength(7);
    for (const table of [
      'workflow_runs child',
      'workflow_nodes node',
      'workflow_dependency_gates gate_row',
      'workflow_feedback_rounds round_row',
      'workflow_activations activation',
      'workflow_continuations continuation',
      'workflow_return_gates return_gate',
    ]) {
      expect(predicate).toContain(table);
    }
  });
});
