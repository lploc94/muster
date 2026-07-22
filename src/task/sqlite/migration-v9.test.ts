import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStoreDatabase } from './connection';
import { migrationBackupArtifactPath, verifyBackupArtifact } from './backup';
import { MusterSqliteError } from './errors';
import { bootstrapFaultCapability, setFaultPlanForTests } from './fault-inject';
import { findSchemaFingerprintFailure } from './schema-fingerprint';
import {
  MUSTER_APPLICATION_ID,
  MUSTER_WRITER_VERSION_UDF,
  REQUIRED_SCHEMA_V9_WORKFLOW_TABLES,
  SCHEMA_V8,
  SCHEMA_V8_STATEMENTS,
  SCHEMA_V9,
} from './schema';

const tempDirs: string[] = [];

afterEach(() => {
  bootstrapFaultCapability(undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-migration-v9-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function scalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  return Number(Object.values(row ?? {})[0] ?? 0);
}

function createPopulatedV8(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of SCHEMA_V8_STATEMENTS) db.exec(statement);
    db.function(MUSTER_WRITER_VERSION_UDF, { deterministic: true }, () => SCHEMA_V8);
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_V8}`);
    db.prepare(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks
       (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
       VALUES ('task-a', 'ws', 'worker', 'open', 'released', 'goal', 'grok', 1, 'now', 'now', '{"committedSessionId":"legacy-session","runtimeEpoch":1}')`,
    ).run();
    db.prepare(
      `INSERT INTO turns
       (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
       VALUES ('turn-a', 'ws', 'task-a', 1, 'queued', 'workflow', 'now', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_definitions
       (workspace_id, definition_id, version, name, entry_node_id, topology_json, created_at)
       VALUES ('ws', 'def', 1, 'Definition', 'node-a', '{}', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs
       (workspace_id, run_id, definition_id, definition_version, status, origin, created_at, updated_at)
       VALUES ('ws', 'run', 'def', 1, 'running', 'top_level', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
       VALUES ('ws', 'run', 'node-a', 'task-a', 'active')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_dependency_gates
       (workspace_id, run_id, gate_id, consumer_node_id, status)
       VALUES ('ws', 'run', 'gate-a', 'node-a', 'satisfied')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_gate_bindings
       (workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind)
       VALUES ('ws', 'run', 'gate-a', 'input', 'node-a', 'artifact')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_artifacts
       (workspace_id, run_id, artifact_id, producer_node_id, logical_name, revision, kind, payload_json, created_at)
       VALUES ('ws', 'run', 'artifact-a', 'node-a', 'result', 1, 'next_result', '{"value":"ok"}', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_gate_fills
       (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at)
       VALUES ('ws', 'run', 'gate-a', 'input', 'artifact-a', 1, 'now')`,
    ).run();
  } finally {
    db.close();
  }
}

function mutateV8(dbPath: string, mutation: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.function(MUSTER_WRITER_VERSION_UDF, { deterministic: true }, () => SCHEMA_V8);
    mutation(db);
  } finally {
    db.close();
  }
}

function seedCurrentConstraintFixture(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
  ).run();
  for (const taskId of ['task-a', 'task-b']) {
    db.prepare(
      `INSERT INTO tasks
       (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
       VALUES (?, 'ws', 'worker', 'open', 'released', 'goal', 'grok', 1, 'now', 'now', '{}')`,
    ).run(taskId);
    db.prepare(
      `INSERT INTO turns
       (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
       VALUES (?, 'ws', ?, 1, 'running', 'workflow', 'now', '{}')`,
    ).run(`turn-${taskId}`, taskId);
  }
  db.prepare(
    `INSERT INTO workflow_definitions
     (workspace_id, definition_id, version, name, entry_node_id, topology_json, created_at)
     VALUES ('ws', 'def', 1, 'Definition', 'node-a', '{}', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs
     (workspace_id, run_id, definition_id, definition_version, status, origin, created_at, updated_at)
     VALUES ('ws', 'run', 'def', 1, 'running', 'top_level', 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
     VALUES ('ws', 'run', 'node-a', 'task-a', 'active')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_dependency_gates
     (workspace_id, run_id, gate_id, consumer_node_id, status)
     VALUES ('ws', 'run', 'gate-a', 'node-a', 'open')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_gate_bindings
     (workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind)
     VALUES ('ws', 'run', 'gate-a', 'input', 'node-a', 'artifact')`,
  ).run();
  for (const artifactId of ['artifact-a', 'artifact-b']) {
    db.prepare(
      `INSERT INTO workflow_artifacts
       (workspace_id, run_id, artifact_id, producer_node_id, logical_name, revision, kind, payload_json, created_at)
       VALUES ('ws', 'run', ?, 'node-a', 'result', 1, 'next_result', '{}', 'now')`,
    ).run(artifactId);
  }
}

describe('schema v8 to v9 migration', () => {
  it('verifies a frozen v8 pre-migration backup independently of compiled current', () => {
    const dbPath = tempDbPath('backup-input-v8.sqlite');
    createPopulatedV8(dbPath);
    expect(verifyBackupArtifact(dbPath, SCHEMA_V8)).toMatchObject({
      schemaVersion: SCHEMA_V8,
      byteSize: expect.any(Number),
    });
    expect(() => verifyBackupArtifact(dbPath)).toThrow(MusterSqliteError);
  });

  it('migrates a populated valid v8 store and preserves stable workflow identities', () => {
    const dbPath = tempDbPath('valid-v8.sqlite');
    createPopulatedV8(dbPath);

    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(scalar(db, 'user_version')).toBe(SCHEMA_V9);
      expect(findSchemaFingerprintFailure(db, SCHEMA_V9)).toBeUndefined();
      expect(
        db.prepare(`SELECT task_id FROM workflow_nodes WHERE workspace_id = 'ws' AND run_id = 'run'`).get(),
      ).toMatchObject({ task_id: 'task-a' });
      expect(
        db.prepare(`SELECT artifact_id, artifact_revision FROM workflow_gate_fills WHERE workspace_id = 'ws'`).get(),
      ).toMatchObject({ artifact_id: 'artifact-a', artifact_revision: 1 });
      for (const table of REQUIRED_SCHEMA_V9_WORKFLOW_TABLES) {
        if (table === 'session_owners' || table === 'task_session_bindings') continue;
        expect(
          db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get(),
        ).toMatchObject({ n: 0 });
      }
      expect(
        db.prepare(`SELECT task_id FROM session_owners WHERE workspace_id = 'ws' AND session_id = 'legacy-session'`).get(),
      ).toMatchObject({ task_id: 'task-a' });
      expect(
        db.prepare(`SELECT task_id, runtime_epoch, active FROM task_session_bindings WHERE workspace_id = 'ws'`).get(),
      ).toMatchObject({ task_id: 'task-a', runtime_epoch: 1, active: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }

    const backupPath = migrationBackupArtifactPath(dbPath, SCHEMA_V8, SCHEMA_V9);
    expect(verifyBackupArtifact(backupPath, SCHEMA_V8)).toMatchObject({
      schemaVersion: SCHEMA_V8,
      byteSize: expect.any(Number),
    });
  });

  it('requires a verified backup receipt before mutation and preserves v8 bytes on backup failure', () => {
    const dbPath = tempDbPath('backup-failure-v8.sqlite');
    createPopulatedV8(dbPath);
    const before = fs.readFileSync(dbPath);
    bootstrapFaultCapability({ faultCapability: true });
    setFaultPlanForTests({ code: 'full', operation: 'backup', remaining: 1 });

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(MusterSqliteError);
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(fs.existsSync(migrationBackupArtifactPath(dbPath, SCHEMA_V8, SCHEMA_V9))).toBe(false);

    setFaultPlanForTests(undefined);
    bootstrapFaultCapability(undefined);
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(scalar(source, 'user_version')).toBe(SCHEMA_V8);
      expect(findSchemaFingerprintFailure(source, SCHEMA_V8)).toBeUndefined();
    } finally {
      source.close();
    }
  });

  it('rolls back to an exact readable v8 manifest on a migration commit fault', () => {
    const dbPath = tempDbPath('rollback-v8.sqlite');
    createPopulatedV8(dbPath);
    bootstrapFaultCapability({ faultCapability: true });
    setFaultPlanForTests({ code: 'full', operation: 'migrate', remaining: 1 });

    expect(() => openStoreDatabase({ path: dbPath })).toThrow(MusterSqliteError);
    setFaultPlanForTests(undefined);
    bootstrapFaultCapability(undefined);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(scalar(db, 'user_version')).toBe(SCHEMA_V8);
      expect(findSchemaFingerprintFailure(db, SCHEMA_V8)).toBeUndefined();
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_activations'`).get(),
      ).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: 'duplicate fills',
      reason: 'duplicate_gate_input_fill',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO workflow_artifacts
           (workspace_id, run_id, artifact_id, producer_node_id, logical_name, revision, kind, payload_json, created_at)
           VALUES ('ws', 'run', 'artifact-b', 'node-a', 'result', 1, 'next_result', '{}', 'now')`,
        ).run();
        db.prepare(
          `INSERT INTO workflow_gate_fills
           (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at)
           VALUES ('ws', 'run', 'gate-a', 'input', 'artifact-b', 1, 'now')`,
        ).run();
      },
    },
    {
      name: 'missing artifact rows',
      reason: 'invalid_gate_artifact_reference',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `UPDATE workflow_gate_fills SET artifact_id = 'missing-artifact'
            WHERE workspace_id = 'ws' AND run_id = 'run'`,
        ).run();
      },
    },
    {
      name: 'orphan relational identities',
      reason: 'unprovable_relational_identity',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `UPDATE workflow_gate_bindings SET producer_node_id = 'missing-node'
            WHERE workspace_id = 'ws' AND run_id = 'run'`,
        ).run();
        db.prepare(
          `UPDATE workflow_artifacts SET producer_node_id = 'missing-node'
            WHERE workspace_id = 'ws' AND run_id = 'run'`,
        ).run();
      },
    },
    {
      name: 'malformed task payload JSON',
      reason: 'malformed_task_payload',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `UPDATE tasks SET payload_json = '{'
            WHERE workspace_id = 'ws' AND id = 'task-a'`,
        ).run();
      },
    },
    {
      name: 'duplicate session ownership',
      reason: 'duplicate_session_ownership',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO tasks
           (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
           VALUES ('task-b', 'ws', 'worker', 'open', 'released', 'goal', 'grok', 1, 'now', 'now',
                   '{"committedSessionId":"legacy-session","runtimeEpoch":1}')`,
        ).run();
        db.prepare(
          `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
           VALUES ('ws', 'run', 'node-b', 'task-b', 'pending')`,
        ).run();
      },
    },
    {
      name: 'invalid session runtime epoch',
      reason: 'invalid_session_runtime_epoch',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `UPDATE tasks
              SET payload_json = '{"committedSessionId":"legacy-session","runtimeEpoch":-1}'
            WHERE workspace_id = 'ws' AND id = 'task-a'`,
        ).run();
      },
    },
    {
      name: 'contradictory feedback identities',
      reason: 'contradictory_feedback_identity',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO workflow_feedback_rounds
           (workspace_id, run_id, round_id, requester_node_id, status, join_mode, created_at)
           VALUES ('ws', 'run', 'round-a', 'node-a', 'open', 'ALL', 'now')`,
        ).run();
        db.prepare(
          `INSERT INTO workflow_feedback_targets
           (workspace_id, run_id, round_id, target_node_id, status)
           VALUES ('ws', 'run', 'round-a', 'node-a', 'pending')`,
        ).run();
        db.prepare(
          `INSERT INTO workflow_routed_messages
           (workspace_id, run_id, message_id, source_node_id, destination_node_id, kind, body_json, created_at)
           VALUES ('ws', 'run', 'feedback-a', 'node-a', 'node-a', 'feedback_request',
                   '{"roundId":"round-a","requesterNodeId":"node-a","targetNodeId":"wrong-node","feedbackTurnId":"turn-a","baseArtifactId":"artifact-a","baseArtifactRevision":1}',
                   'now')`,
        ).run();
      },
    },
    {
      name: 'malformed feedback JSON',
      reason: 'contradictory_feedback_identity',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO workflow_routed_messages
           (workspace_id, run_id, message_id, source_node_id, destination_node_id, kind, body_json, created_at)
           VALUES ('ws', 'run', 'feedback-malformed', 'node-a', 'node-a', 'feedback_request', '{', 'now')`,
        ).run();
      },
    },
    {
      name: 'partial child continuations',
      reason: 'partial_child_continuation',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO workflow_continuations
           (workspace_id, run_id, continuation_id, kind, status, payload_json, created_at)
           VALUES ('ws', 'run', 'continuation-a', 'child_wait', 'pending', '{}', 'now')`,
        ).run();
      },
    },
    {
      name: 'malformed continuation JSON',
      reason: 'partial_child_continuation',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO workflow_continuations
           (workspace_id, run_id, continuation_id, kind, status, payload_json, created_at)
           VALUES ('ws', 'run', 'continuation-malformed', 'child_wait', 'pending', '{', 'now')`,
        ).run();
      },
    },
    {
      name: 'terminal runs with queued work',
      reason: 'terminal_run_queued_work',
      mutate: (db: DatabaseSync) => {
        db.prepare(
          `UPDATE workflow_runs SET status = 'succeeded'
            WHERE workspace_id = 'ws' AND run_id = 'run'`,
        ).run();
      },
    },
  ])('quarantines $name without preventing open', ({ name: _name, reason, mutate }) => {
    const dbPath = tempDbPath(`quarantine-${reason}.sqlite`);
    createPopulatedV8(dbPath);
    mutateV8(dbPath, mutate);

    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(scalar(db, 'user_version')).toBe(SCHEMA_V9);
      expect(
        db.prepare(
          `SELECT reason_code, original_status, row_counts_json
             FROM workflow_migration_quarantine
            WHERE workspace_id = 'ws' AND legacy_run_id = 'run'`,
        ).get(),
      ).toMatchObject({
        reason_code: reason,
        original_status: reason === 'terminal_run_queued_work' ? 'succeeded' : 'running',
        row_counts_json: expect.any(String),
      });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE workspace_id = 'ws'`).get(),
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare(`SELECT status FROM turns WHERE workspace_id = 'ws' AND id = 'turn-a'`).get(),
      ).toMatchObject({ status: 'cancelled' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('quarantines every run with duplicate task ownership', () => {
    const dbPath = tempDbPath('quarantine-duplicate-owner.sqlite');
    createPopulatedV8(dbPath);
    mutateV8(dbPath, (db) => {
      db.prepare(
        `INSERT INTO workflow_runs
         (workspace_id, run_id, definition_id, definition_version, status, origin, created_at, updated_at)
         VALUES ('ws', 'run-b', 'def', 1, 'running', 'top_level', 'now', 'now')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
         VALUES ('ws', 'run-b', 'node-b', 'task-a', 'active')`,
      ).run();
    });

    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(
        db.prepare(
          `SELECT COUNT(*) AS n FROM workflow_migration_quarantine
            WHERE workspace_id = 'ws' AND reason_code = 'duplicate_task_ownership'`,
        ).get(),
      ).toMatchObject({ n: 2 });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE workspace_id = 'ws'`).get(),
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare(`SELECT status FROM turns WHERE workspace_id = 'ws' AND id = 'turn-a'`).get(),
      ).toMatchObject({ status: 'cancelled' });
    } finally {
      db.close();
    }
  });

  it('preserves valid runs while quarantining an invalid run in the same v8 store', () => {
    const dbPath = tempDbPath('quarantine-all-or-nothing.sqlite');
    createPopulatedV8(dbPath);
    mutateV8(dbPath, (db) => {
      db.prepare(
        `INSERT INTO tasks
         (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES ('task-b', 'ws', 'worker', 'open', 'released', 'goal', 'grok', 1, 'now', 'now', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO turns
         (id, workspace_id, task_id, sequence, status, trigger, created_at, payload_json)
         VALUES ('turn-b', 'ws', 'task-b', 1, 'queued', 'workflow', 'now', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs
         (workspace_id, run_id, definition_id, definition_version, status, origin, created_at, updated_at)
         VALUES ('ws', 'run-b', 'def', 1, 'running', 'top_level', 'now', 'now')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
         VALUES ('ws', 'run-b', 'node-b', 'task-b', 'active')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_dependency_gates
         (workspace_id, run_id, gate_id, consumer_node_id, status)
         VALUES ('ws', 'run-b', 'gate-b', 'node-b', 'satisfied')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_gate_bindings
         (workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind)
         VALUES ('ws', 'run-b', 'gate-b', 'input', 'node-b', 'artifact')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_gate_fills
         (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at)
         VALUES ('ws', 'run-b', 'gate-b', 'input', 'missing-artifact', 1, 'now')`,
      ).run();
    });

    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(
        db.prepare(`SELECT run_id FROM workflow_runs WHERE workspace_id = 'ws'`).all(),
      ).toEqual([{ run_id: 'run' }]);
      expect(
        db.prepare(
          `SELECT reason_code FROM workflow_migration_quarantine
            WHERE workspace_id = 'ws' AND legacy_run_id = 'run-b'`,
        ).get(),
      ).toMatchObject({ reason_code: 'invalid_gate_artifact_reference' });
      expect(
        db.prepare(`SELECT status FROM turns WHERE workspace_id = 'ws' AND id = 'turn-a'`).get(),
      ).toMatchObject({ status: 'queued' });
      expect(
        db.prepare(`SELECT status FROM turns WHERE workspace_id = 'ws' AND id = 'turn-b'`).get(),
      ).toMatchObject({ status: 'cancelled' });
    } finally {
      db.close();
    }
  });

  it('quarantines child inputs whose exact caller-turn authorization is absent from v8', () => {
    const dbPath = tempDbPath('valid-child-cross-run-provenance.sqlite');
    createPopulatedV8(dbPath);
    mutateV8(dbPath, (db) => {
      db.prepare(
        `INSERT INTO tasks
         (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES ('task-child', 'ws', 'worker', 'open', 'released', 'goal', 'grok', 1, 'now', 'now', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO turns
         (id, workspace_id, task_id, sequence, status, trigger, created_at, settled_at, payload_json)
         VALUES ('turn-child', 'ws', 'task-child', 1, 'succeeded', 'workflow', 'now', 'now', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs
         (workspace_id, run_id, definition_id, definition_version, status, origin, parent_run_id, created_at, updated_at)
         VALUES ('ws', 'run-child', 'def', 1, 'succeeded', 'child', 'run', 'now', 'now')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
         VALUES ('ws', 'run-child', 'child-node', 'task-child', 'completed')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_dependency_gates
         (workspace_id, run_id, gate_id, consumer_node_id, status)
         VALUES ('ws', 'run-child', 'child-gate', 'child-node', 'consumed')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_artifacts
         (workspace_id, run_id, artifact_id, producer_node_id, logical_name, revision, kind, payload_json, created_at)
         SELECT workspace_id, 'run-child', artifact_id, producer_node_id, logical_name, revision, kind, payload_json, created_at
           FROM workflow_artifacts
          WHERE workspace_id = 'ws' AND run_id = 'run' AND artifact_id = 'artifact-a'`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_gate_fills
         (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at)
         VALUES ('ws', 'run-child', 'child-gate', 'input', 'artifact-a', 1, 'now')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_dependency_gates
         (workspace_id, run_id, gate_id, consumer_node_id, status)
         VALUES ('ws', 'run', 'return-gate', 'node-a', 'satisfied')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_continuations
         (workspace_id, run_id, continuation_id, kind, status, payload_json, created_at)
         VALUES ('ws', 'run', 'continuation-child', 'child_wait', 'resolved',
                 '{"childRunId":"run-child","returnGateId":"return-gate","callerNodeId":"node-a","callerTaskId":"task-a"}',
                 'now')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_routed_messages
         (workspace_id, run_id, message_id, source_node_id, destination_node_id, kind, body_json, created_at)
         VALUES ('ws', 'run', 'child-return', 'child-node', 'node-a', 'child_return',
                 '{"kind":"child_return","childRunId":"run-child","parentRunId":"run","continuationId":"continuation-child","returnGateId":"return-gate","sourceTurnId":"turn-child"}',
                 'now')`,
      ).run();
    });

    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE workspace_id = 'ws'`).get(),
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM workflow_migration_quarantine WHERE workspace_id = 'ws'`).get(),
      ).toMatchObject({ n: 2 });
      expect(
        db.prepare(
          `SELECT reason_code FROM workflow_migration_quarantine
            WHERE workspace_id = 'ws' AND legacy_run_id = 'run-child'`,
        ).get(),
      ).toMatchObject({ reason_code: 'unprovable_relational_identity' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('schema v9 workflow authority constraints', () => {
  it('rejects duplicate task owners, conflicting gate pins, and cross-family disposition claims', () => {
    const db = openStoreDatabase({ path: tempDbPath('constraints.sqlite') });
    try {
      seedCurrentConstraintFixture(db);
      expect(() =>
        db.prepare(
          `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
           VALUES ('ws', 'run', 'node-b', 'task-a', 'pending')`,
        ).run(),
      ).toThrow(/UNIQUE/i);

      db.prepare(
        `INSERT INTO workflow_gate_fills
         (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at)
         VALUES ('ws', 'run', 'gate-a', 'input', 'artifact-a', 1, 'now')`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO workflow_gate_fills
           (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision, filled_at)
           VALUES ('ws', 'run', 'gate-a', 'input', 'artifact-b', 1, 'now')`,
        ).run(),
      ).toThrow(/UNIQUE/i);

      db.prepare(
        `INSERT INTO turn_disposition_claims
         (workspace_id, turn_id, task_id, runtime_epoch, op_id, family, kind, fingerprint, payload_json, status, created_at, updated_at)
         VALUES ('ws', 'turn-task-a', 'task-a', 0, 'op-complete', 'ordinary', 'complete', 'fp-a', '{}', 'staged', 'now', 'now')`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO turn_disposition_claims
           (workspace_id, turn_id, task_id, runtime_epoch, op_id, family, kind, fingerprint, payload_json, status, created_at, updated_at)
           VALUES ('ws', 'turn-task-a', 'task-a', 0, 'op-next', 'workflow', 'next', 'fp-b', '{}', 'staged', 'now', 'now')`,
        ).run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('rejects duplicate session owners and foreign caller artifact provenance', () => {
    const db = openStoreDatabase({ path: tempDbPath('ownership.sqlite') });
    try {
      seedCurrentConstraintFixture(db);
      db.prepare(
        `INSERT INTO session_owners
         (workspace_id, backend, session_id, task_id, first_bound_at)
         VALUES ('ws', 'grok', 'session-1', 'task-a', 'now')`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO session_owners
           (workspace_id, backend, session_id, task_id, first_bound_at)
           VALUES ('ws', 'grok', 'session-1', 'task-b', 'now')`,
        ).run(),
      ).toThrow(/UNIQUE/i);

      expect(() =>
        db.prepare(
          `INSERT INTO workflow_artifact_sources
           (workspace_id, run_id, artifact_id, artifact_revision, source_kind, caller_task_id, caller_turn_id)
           VALUES ('ws', 'run', 'artifact-a', 1, 'caller_turn', 'task-a', 'turn-task-b')`,
        ).run(),
      ).toThrow(/FOREIGN KEY/i);

      expect(() =>
        db.prepare(
          `INSERT INTO workflow_artifact_sources
           (workspace_id, run_id, artifact_id, artifact_revision, source_kind)
           VALUES ('ws', 'run', 'artifact-a', 1, 'caller_turn')`,
        ).run(),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });
});
