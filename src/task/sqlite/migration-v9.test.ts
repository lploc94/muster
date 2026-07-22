import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStoreDatabase } from './connection';
import { verifyBackupArtifact } from './backup';
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
