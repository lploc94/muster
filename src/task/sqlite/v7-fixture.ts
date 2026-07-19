/**
 * Owned, complete, populated schema-v7 proof fixture (M018 S01).
 *
 * Built exclusively from SCHEMA_V7_STATEMENTS so it remains a valid migration
 * input after the compiled current schema advances to v8. Used by migration-v8
 * tests and the named S01 flow; not a production path.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  MUSTER_APPLICATION_ID,
  REQUIRED_SCHEMA_TABLES,
  SCHEMA_V7,
  SCHEMA_V7_STATEMENTS,
} from './schema';

/** Stable message content marker used by migration data-preservation proofs. */
export const POPULATED_V7_FIXTURE_MARKER = 'M018_S01_POPULATED_V7_FIXTURE';

export type PopulatedV7FixtureSummary = {
  schemaVersion: typeof SCHEMA_V7;
  applicationId: typeof MUSTER_APPLICATION_ID;
  marker: typeof POPULATED_V7_FIXTURE_MARKER;
  workspaceId: string;
  coordinatorTaskId: string;
  workerTaskId: string;
  turnId: string;
  messageId: string;
  presentationId: string;
  tableRowCounts: Record<string, number>;
};

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('invalid schema object name');
  }
  return `"${name}"`;
}

/** Count every required v7 user table (0 when empty). */
export function countPopulatedV7FixtureRows(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of REQUIRED_SCHEMA_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as
      | { n: number }
      | undefined;
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

/**
 * Write a claimed, complete, populated schema-v7 database at `dbPath`.
 * Applies frozen v7 DDL only; stamps application_id + user_version=7.
 */
export function writePopulatedV7Fixture(dbPath: string): PopulatedV7FixtureSummary {
  const workspaceId = 'ws-v7-fixture';
  const coordinatorTaskId = 'task-coord';
  const workerTaskId = 'task-worker';
  const turnId = 'turn-1';
  const messageId = 'msg-marker';
  const presentationId = 'pres-1';
  const rootId = 'root-1';
  const now = '2026-07-19T00:00:00.000Z';

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const statement of SCHEMA_V7_STATEMENTS) {
      db.exec(statement);
    }
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_V7}`);

    db.prepare(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workspaceId, 'identity-v7-fixture', 'V7 Fixture Workspace', now, now);

    db.prepare(
      `INSERT INTO workspace_locations (workspace_id, canonical_uri, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)`,
    ).run(workspaceId, 'file:///muster/v7-fixture', now, now);

    db.prepare(
      `INSERT INTO tasks
        (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
         revision, created_at, updated_at, payload_json)
       VALUES (?, ?, NULL, 'coordinator', 'open', 'released', 'coordinate fixture', 'claude', 'sonnet',
               1, ?, ?, ?)`,
    ).run(coordinatorTaskId, workspaceId, now, now, '{"kind":"v7-fixture","role":"coordinator"}');

    db.prepare(
      `INSERT INTO tasks
        (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
         revision, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, 'worker', 'open', 'draft', 'worker fixture', 'grok', NULL,
               0, ?, ?, ?)`,
    ).run(workerTaskId, workspaceId, coordinatorTaskId, now, now, '{"kind":"v7-fixture","role":"worker"}');

    db.prepare(
      `INSERT INTO task_dependencies
        (workspace_id, task_id, dependency_task_id, required_outcome, on_unsatisfied, required_verdict)
       VALUES (?, ?, ?, 'success', 'block', NULL)`,
    ).run(workspaceId, workerTaskId, coordinatorTaskId);

    db.prepare(
      `INSERT INTO turns
        (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
       VALUES (?, ?, ?, 1, 'settled', 'user', ?, ?, ?, ?)`,
    ).run(turnId, workspaceId, coordinatorTaskId, now, now, now, '{"kind":"v7-fixture-turn"}');

    db.prepare(
      `INSERT INTO messages
        (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, 'assistant', 'final', 0, ?, ?, ?, ?)`,
    ).run(messageId, workspaceId, coordinatorTaskId, turnId, POPULATED_V7_FIXTURE_MARKER, now, now, '{}');

    db.prepare(
      `INSERT INTO reasoning_segments
        (id, workspace_id, task_id, turn_id, ordering, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'fixture reasoning', ?, ?)`,
    ).run('reason-1', workspaceId, coordinatorTaskId, turnId, now, now);

    db.prepare(
      `INSERT INTO tool_calls
        (id, workspace_id, task_id, turn_id, tool_call_id, ordering, status, name, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'tc-1', 0, 'completed', 'echo', ?, ?, ?)`,
    ).run('tool-1', workspaceId, coordinatorTaskId, turnId, '{}', now, now);

    db.prepare(
      `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
       VALUES (?, 'op-fixture', 'fp-fixture', '{}', ?)`,
    ).run(workspaceId, now);

    db.prepare(
      `INSERT INTO send_receipts
        (workspace_id, client_request_id, fingerprint, task_id, message_id, turn_id, created_at)
       VALUES (?, 'client-req-1', 'fp-send', ?, ?, ?, ?)`,
    ).run(workspaceId, coordinatorTaskId, messageId, turnId, now);

    db.prepare(
      `INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, 3)`,
    ).run(workspaceId);

    db.prepare(
      `INSERT INTO change_log
        (workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)
       VALUES (?, 1, 'task', ?, ?, 'upsert', ?)`,
    ).run(workspaceId, coordinatorTaskId, coordinatorTaskId, now);
    db.prepare(
      `INSERT INTO change_log
        (workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)
       VALUES (?, 2, 'task', ?, ?, 'upsert', ?)`,
    ).run(workspaceId, workerTaskId, workerTaskId, now);
    db.prepare(
      `INSERT INTO change_log
        (workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)
       VALUES (?, 3, 'message', ?, ?, 'upsert', ?)`,
    ).run(workspaceId, messageId, coordinatorTaskId, now);

    db.prepare(
      `INSERT INTO change_feed_watermarks (workspace_id, retained_from_revision) VALUES (?, 1)`,
    ).run(workspaceId);

    db.prepare(
      `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
       VALUES (?, ?, 0, 'user_text', ?)`,
    ).run(workspaceId, turnId, '{"text":"fixture-input"}');

    // Historical claims left empty intentionally — proves empty tables survive migration.
    // send_outbox / presentations / presentation_operations get representative rows.

    db.prepare(
      `INSERT INTO send_outbox
        (workspace_id, client_request_id, status, task_id, payload_json, created_at, updated_at)
       VALUES (?, 'outbox-1', 'pending', ?, ?, ?, ?)`,
    ).run(workspaceId, coordinatorTaskId, '{"text":"pending-send"}', now, now);

    db.prepare(
      `INSERT INTO presentations
        (workspace_id, presentation_id, owner_task_id, root_id, revision, title, markdown, payload_json, updated_at)
       VALUES (?, ?, ?, ?, 1, 'v7 fixture presentation', '# Fixture', '{}', ?)`,
    ).run(workspaceId, presentationId, coordinatorTaskId, rootId, now);

    db.prepare(
      `INSERT INTO presentation_operations
        (workspace_id, operation_key, root_id, presentation_id, fingerprint, created_at)
       VALUES (?, 'pres-op-1', ?, ?, 'fp-pres', ?)`,
    ).run(workspaceId, rootId, presentationId, now);

    const tableRowCounts = countPopulatedV7FixtureRows(db);

    return {
      schemaVersion: SCHEMA_V7,
      applicationId: MUSTER_APPLICATION_ID,
      marker: POPULATED_V7_FIXTURE_MARKER,
      workspaceId,
      coordinatorTaskId,
      workerTaskId,
      turnId,
      messageId,
      presentationId,
      tableRowCounts,
    };
  } finally {
    db.close();
  }
}
