/**
 * SQLite connection lifecycle + fresh-schema initialization for the global Muster store.
 *
 * Runs INSIDE the DB worker thread only (plan §3.4): `DatabaseSync` is synchronous,
 * so it must never open on the extension-host main thread where a `busy_timeout`
 * stall would freeze the VS Code UI. This module has no VS Code dependency and is
 * unit-testable directly on Node.
 *
 * Open contract (validation-before-mutation):
 * 1. Read-only preflight of application_id / user_version / user schema objects.
 * 2. Reject foreign or incompatible DBs without changing journal mode, application_id,
 *    user_version, schema, or data.
 * 3. Only a truly blank DB may be claimed (stamp + current schema bootstrap).
 * 4. Runtime pragmas including WAL are applied only after ownership is confirmed.
 *
 * Concurrent first-open is serialized by BEGIN EXCLUSIVE inside the claim path.
 * Peers either wait on the lock or observe the post-commit state
 * (Muster application_id + current user_version). They never observe a durable
 * partial claim, and they never retry a persisted incomplete Muster DB.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  CURRENT_SCHEMA_STATEMENTS,
  MUSTER_APPLICATION_ID,
  MUSTER_WRITER_VERSION_UDF,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V8_MIGRATION_STATEMENTS,
  SCHEMA_V8_WRITER_GUARD_TRIGGER_NAMES,
  SCHEMA_V9_MIGRATION_STATEMENTS,
  SCHEMA_V9_WRITER_GUARD_STATEMENTS,
  SQLITE_SCHEMA_VERSION,
} from './schema';
import { MusterSqliteError, mapToMusterSqliteError } from './errors';
import { maybeInjectFault } from './fault-inject';
import { findSchemaFingerprintFailure } from './schema-fingerprint';
import {
  createMigrationBackupReceipt,
  discardMigrationBackupReceipt,
  publishMigrationBackupReceipt,
  verifyBackupArtifact,
  type MigrationBackupReceipt,
} from './backup';

export interface OpenOptions {
  /** Filesystem path to `muster.sqlite3` (or ':memory:' in tests). */
  path: string;
  /** busy_timeout in ms (plan §3.4 default 5000). */
  busyTimeoutMs?: number;
}

const OPEN_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isRetryableOpenLock(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  // Retry only real SQLite lock contention. Permanent ownership/schema failures
  // must surface immediately with reset guidance.
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /database (?:table )?is locked|database is busy/i.test(message)
  );
}

function waitBeforeOpenRetry(attempt: number): void {
  // This module runs in the DB worker in production. A short synchronous wait
  // therefore delays only this connection bootstrap, never the extension host.
  const delayMs = Math.min(250, 10 * (2 ** Math.min(attempt, 5)));
  Atomics.wait(OPEN_RETRY_WAIT, 0, 0, delayMs);
}

/**
 * Thrown when the DB file belongs to a different application_id (not Muster's).
 * Wire-safe: message has no path; observed id stays in a non-serialized field.
 */
export class ForeignDatabaseError extends MusterSqliteError {
  constructor(readonly observedApplicationId: number) {
    super('foreign_database', 'open');
    this.name = 'ForeignDatabaseError';
  }
}

/**
 * Thrown when an existing development DB does not match the current schema, or a
 * Muster-owned file is incomplete/corrupt. Always includes developer reset guidance.
 */
export class IncompatibleSchemaError extends MusterSqliteError {
  constructor(readonly observedVersion: number) {
    super('incompatible_schema', 'open');
    this.name = 'IncompatibleSchemaError';
  }
}

/**
 * Thrown when application_id/user_version look blank but the file already has
 * user schema objects. Muster never silently claims a non-empty foreign file.
 */
export class NonEmptyUnclaimedDatabaseError extends MusterSqliteError {
  constructor() {
    super('nonempty_unclaimed', 'open');
    this.name = 'NonEmptyUnclaimedDatabaseError';
  }
}

// Schema version remains the ownership gate; it is not serialized on the RPC wire.
void SQLITE_SCHEMA_VERSION;

/**
 * Register the connection-local writer-version UDF required by v8 write-guard triggers.
 * Stale connections without this UDF (or with a different compiled version) fail closed.
 */
export function registerWriterVersionUdf(db: DatabaseSync): void {
  // deterministic: safe for WHEN-clause evaluation; Number() keeps a stable SQLite numeric.
  db.function(MUSTER_WRITER_VERSION_UDF, { deterministic: true }, () => Number(SQLITE_SCHEMA_VERSION));
}

function readScalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) {
    return 0;
  }
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

/** True when the DB already has any non-internal table/view/index/trigger. */
function hasUserSchemaObjects(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'`,
    )
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * Bounded current-schema fingerprint: required tables/indexes/triggers AND
 * critical column structure before WAL (P5-W2). Read-only; no integrity_check.
 */
function assertCurrentSchemaComplete(db: DatabaseSync): void {
  try {
    const failure = findSchemaFingerprintFailure(db);
    if (failure) {
      throw new IncompatibleSchemaError(readScalar(db, 'user_version'));
    }
  } catch (error) {
    if (error instanceof IncompatibleSchemaError) throw error;
    // Unterminated quotes / fingerprint scanner failures fail closed.
    throw new IncompatibleSchemaError(readScalar(db, 'user_version'));
  }
}

function assertOwnedV7SchemaComplete(db: DatabaseSync): void {
  try {
    const failure = findSchemaFingerprintFailure(db, SCHEMA_V7);
    if (failure) {
      throw new IncompatibleSchemaError(SCHEMA_V7);
    }
  } catch (error) {
    if (error instanceof IncompatibleSchemaError) throw error;
    throw new IncompatibleSchemaError(SCHEMA_V7);
  }
}

function assertOwnedV8SchemaComplete(db: DatabaseSync): void {
  try {
    const failure = findSchemaFingerprintFailure(db, SCHEMA_V8);
    if (failure) {
      throw new IncompatibleSchemaError(SCHEMA_V8);
    }
  } catch (error) {
    if (error instanceof IncompatibleSchemaError) throw error;
    throw new IncompatibleSchemaError(SCHEMA_V8);
  }
}

/**
 * Atomically upgrade an owned complete schema-v7 store to the compiled current
 * schema under BEGIN EXCLUSIVE. Any failure before COMMIT rolls back so the
 * original v7 store remains readable and unchanged.
 */
function migrateOwnedV7ToV8(db: DatabaseSync): void {
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    const applicationId = readScalar(db, 'application_id');
    const userVersion = readScalar(db, 'user_version');

    // Peer already finished migration while we waited on the exclusive lock.
    if (applicationId === MUSTER_APPLICATION_ID && userVersion >= SCHEMA_V8) {
      if (userVersion === SCHEMA_V8) {
        assertOwnedV8SchemaComplete(db);
      } else if (userVersion === SQLITE_SCHEMA_VERSION) {
        assertCurrentSchemaComplete(db);
      } else {
        throw new IncompatibleSchemaError(userVersion);
      }
      db.exec('COMMIT');
      return;
    }

    if (applicationId !== MUSTER_APPLICATION_ID || userVersion !== SCHEMA_V7) {
      throw new IncompatibleSchemaError(userVersion);
    }
    assertOwnedV7SchemaComplete(db);

    for (const statement of SCHEMA_V8_MIGRATION_STATEMENTS) {
      db.exec(statement);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_V8}`);
    assertOwnedV8SchemaComplete(db);
    // Deterministic commit-boundary seam for UAT/tests (no-op without capability).
    maybeInjectFault('migrate');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Prefer the original migration failure over a secondary rollback error.
    }
    throw error;
  }
}

class MigrationBackupStaleError extends Error {
  constructor() {
    super('migration backup no longer matches the locked source');
    this.name = 'MigrationBackupStaleError';
  }
}

function assertMigrationBackupReceipt(
  db: DatabaseSync,
  receipt: MigrationBackupReceipt,
): void {
  const verified = verifyBackupArtifact(receipt.artifactPath, SCHEMA_V8);
  if (
    receipt.schemaVersion !== SCHEMA_V8 ||
    receipt.schemaVersion !== verified.schemaVersion ||
    receipt.workspaceRevision !== verified.workspaceRevision ||
    receipt.byteSize !== verified.byteSize
  ) {
    throw new MusterSqliteError('incompatible_schema', 'backup');
  }
  if (readScalar(db, 'data_version') !== receipt.sourceDataVersion) {
    throw new MigrationBackupStaleError();
  }
}

const DEFERRED_V9_INTEGRITY_INDEXES = [
  'uq_workflow_nodes_task_owner',
  'uq_workflow_gate_fills_input',
] as const;

function isDeferredV9IntegrityStatement(statement: string): boolean {
  return DEFERRED_V9_INTEGRITY_INDEXES.some((name) => statement.includes(name));
}

function insertInvalidRunReason(
  db: DatabaseSync,
  reasonCode: string,
  selectSql: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO muster_invalid_v8_runs (workspace_id, run_id, reason_code)
     ${selectSql}`,
  ).run(reasonCode);
}

function quarantineInvalidV8WorkflowRuns(db: DatabaseSync): void {
  db.exec(
    `CREATE TEMP TABLE muster_invalid_v8_runs (
       workspace_id TEXT NOT NULL,
       run_id TEXT NOT NULL,
       reason_code TEXT NOT NULL,
       PRIMARY KEY (workspace_id, run_id)
     ) WITHOUT ROWID`,
  );

  insertInvalidRunReason(
    db,
    'duplicate_task_ownership',
    `SELECT DISTINCT node.workspace_id, node.run_id, ?
       FROM workflow_nodes node
       JOIN (
         SELECT workspace_id, task_id
           FROM workflow_nodes
          WHERE task_id IS NOT NULL
          GROUP BY workspace_id, task_id
         HAVING COUNT(*) > 1
       ) duplicate
         ON duplicate.workspace_id = node.workspace_id
        AND duplicate.task_id = node.task_id`,
  );
  insertInvalidRunReason(
    db,
    'duplicate_gate_input_fill',
    `SELECT DISTINCT fill.workspace_id, fill.run_id, ?
       FROM workflow_gate_fills fill
       JOIN (
         SELECT workspace_id, run_id, gate_id, input_ref
           FROM workflow_gate_fills
          GROUP BY workspace_id, run_id, gate_id, input_ref
         HAVING COUNT(*) > 1
       ) duplicate
         ON duplicate.workspace_id = fill.workspace_id
        AND duplicate.run_id = fill.run_id
        AND duplicate.gate_id = fill.gate_id
        AND duplicate.input_ref = fill.input_ref`,
  );
  insertInvalidRunReason(
    db,
    'unprovable_relational_identity',
    `SELECT DISTINCT invalid.workspace_id, invalid.run_id, ?
       FROM (
         SELECT gate.workspace_id, gate.run_id
           FROM workflow_dependency_gates gate
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_nodes node
             WHERE node.workspace_id = gate.workspace_id
               AND node.run_id = gate.run_id
               AND node.node_id = gate.consumer_node_id
          )
         UNION
         SELECT binding.workspace_id, binding.run_id
           FROM workflow_gate_bindings binding
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_nodes node
             WHERE node.workspace_id = binding.workspace_id
               AND node.run_id = binding.run_id
               AND node.node_id = binding.producer_node_id
          )
         UNION
         SELECT artifact.workspace_id, artifact.run_id
           FROM workflow_artifacts artifact
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_nodes node
             WHERE node.workspace_id = artifact.workspace_id
               AND node.run_id = artifact.run_id
               AND node.node_id = artifact.producer_node_id
          )
         UNION
         SELECT round.workspace_id, round.run_id
           FROM workflow_feedback_rounds round
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_nodes node
             WHERE node.workspace_id = round.workspace_id
               AND node.run_id = round.run_id
               AND node.node_id = round.requester_node_id
          )
         UNION
         SELECT target.workspace_id, target.run_id
           FROM workflow_feedback_targets target
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_nodes node
             WHERE node.workspace_id = target.workspace_id
               AND node.run_id = target.run_id
               AND node.node_id = target.target_node_id
          )
         UNION
         SELECT message.workspace_id, message.run_id
           FROM workflow_routed_messages message
          WHERE (
                  message.kind <> 'child_return'
                  AND (
                    NOT EXISTS (
                      SELECT 1 FROM workflow_nodes node
                       WHERE node.workspace_id = message.workspace_id
                         AND node.run_id = message.run_id
                         AND node.node_id = message.source_node_id
                    )
                    OR NOT EXISTS (
                      SELECT 1 FROM workflow_nodes node
                       WHERE node.workspace_id = message.workspace_id
                         AND node.run_id = message.run_id
                         AND node.node_id = message.destination_node_id
                    )
                  )
                )
             OR (
                  message.kind = 'child_return'
                  AND NOT EXISTS (
                    SELECT 1
                      FROM workflow_runs child
                      JOIN workflow_nodes source_node
                        ON source_node.workspace_id = child.workspace_id
                       AND source_node.run_id = child.run_id
                       AND source_node.node_id = message.source_node_id
                      JOIN workflow_nodes destination_node
                        ON destination_node.workspace_id = child.workspace_id
                       AND destination_node.run_id = child.parent_run_id
                       AND destination_node.node_id = message.destination_node_id
                      JOIN turns source_turn
                        ON source_turn.workspace_id = source_node.workspace_id
                       AND source_turn.task_id = source_node.task_id
                       AND source_turn.id = json_extract(
                         CASE WHEN json_valid(message.body_json) = 1 THEN message.body_json ELSE '{}' END,
                         '$.sourceTurnId'
                       )
                      JOIN workflow_continuations continuation
                        ON continuation.workspace_id = child.workspace_id
                       AND continuation.run_id = child.parent_run_id
                       AND continuation.continuation_id = json_extract(
                         CASE WHEN json_valid(message.body_json) = 1 THEN message.body_json ELSE '{}' END,
                         '$.continuationId'
                       )
                      JOIN workflow_dependency_gates return_gate
                        ON return_gate.workspace_id = continuation.workspace_id
                       AND return_gate.run_id = continuation.run_id
                       AND return_gate.gate_id = json_extract(
                         CASE WHEN json_valid(message.body_json) = 1 THEN message.body_json ELSE '{}' END,
                         '$.returnGateId'
                       )
                      JOIN workflow_gate_bindings return_binding
                        ON return_binding.workspace_id = return_gate.workspace_id
                       AND return_binding.run_id = return_gate.run_id
                       AND return_binding.gate_id = return_gate.gate_id
                       AND return_binding.input_ref = 'child_return'
                       AND return_binding.producer_node_id = destination_node.node_id
                       AND return_binding.required_kind = 'artifact'
                      JOIN workflow_gate_fills return_fill
                        ON return_fill.workspace_id = return_binding.workspace_id
                       AND return_fill.run_id = return_binding.run_id
                       AND return_fill.gate_id = return_binding.gate_id
                       AND return_fill.input_ref = return_binding.input_ref
                      JOIN workflow_artifacts return_artifact
                        ON return_artifact.workspace_id = return_fill.workspace_id
                       AND return_artifact.run_id = return_fill.run_id
                       AND return_artifact.artifact_id = return_fill.artifact_id
                       AND return_artifact.revision = return_fill.artifact_revision
                       AND return_artifact.producer_node_id = destination_node.node_id
                       AND return_artifact.logical_name = 'child_return'
                       AND return_artifact.kind = 'child_return'
                     WHERE child.workspace_id = message.workspace_id
                       AND child.run_id = json_extract(
                         CASE WHEN json_valid(message.body_json) = 1 THEN message.body_json ELSE '{}' END,
                         '$.childRunId'
                       )
                       AND child.parent_run_id = message.run_id
                       AND child.origin = 'child'
                       AND child.status = 'succeeded'
                       AND continuation.status = 'resolved'
                       AND return_gate.status IN ('satisfied', 'consumed')
                       AND return_gate.consumer_node_id = destination_node.node_id
                       AND destination_node.task_id IS NOT NULL
                       AND json_extract(
                             CASE WHEN json_valid(message.body_json) = 1 THEN message.body_json ELSE '{}' END,
                             '$.parentRunId'
                           ) = message.run_id
                       AND json_extract(
                             CASE WHEN json_valid(continuation.payload_json) = 1 THEN continuation.payload_json ELSE '{}' END,
                             '$.childRunId'
                           ) = child.run_id
                       AND json_extract(
                             CASE WHEN json_valid(continuation.payload_json) = 1 THEN continuation.payload_json ELSE '{}' END,
                             '$.returnGateId'
                           ) = return_gate.gate_id
                       AND json_extract(
                             CASE WHEN json_valid(continuation.payload_json) = 1 THEN continuation.payload_json ELSE '{}' END,
                             '$.callerNodeId'
                           ) = destination_node.node_id
                       AND json_extract(
                             CASE WHEN json_valid(continuation.payload_json) = 1 THEN continuation.payload_json ELSE '{}' END,
                             '$.callerTaskId'
                           ) = destination_node.task_id
                       AND json_extract(
                             CASE WHEN json_valid(return_artifact.payload_json) = 1 THEN return_artifact.payload_json ELSE '{}' END,
                             '$.kind'
                           ) = 'child_return'
                       AND json_extract(
                             CASE WHEN json_valid(return_artifact.payload_json) = 1 THEN return_artifact.payload_json ELSE '{}' END,
                             '$.childRunId'
                           ) = child.run_id
                       AND json_extract(
                             CASE WHEN json_valid(return_artifact.payload_json) = 1 THEN return_artifact.payload_json ELSE '{}' END,
                             '$.sourceTurnId'
                           ) = source_turn.id
                  )
                )
         UNION
         SELECT run.workspace_id, run.run_id
           FROM workflow_runs run
           JOIN workflow_definitions definition
             ON definition.workspace_id = run.workspace_id
            AND definition.definition_id = run.definition_id
            AND definition.version = run.definition_version
          WHERE json_valid(definition.topology_json) = 0
       ) invalid`,
  );
  insertInvalidRunReason(
    db,
    'invalid_gate_artifact_reference',
    `SELECT DISTINCT fill.workspace_id, fill.run_id, ?
       FROM workflow_gate_fills fill
       LEFT JOIN workflow_gate_bindings binding
         ON binding.workspace_id = fill.workspace_id
        AND binding.run_id = fill.run_id
        AND binding.gate_id = fill.gate_id
        AND binding.input_ref = fill.input_ref
       LEFT JOIN workflow_artifacts artifact
         ON artifact.workspace_id = fill.workspace_id
        AND artifact.run_id = fill.run_id
        AND artifact.artifact_id = fill.artifact_id
        AND artifact.revision = fill.artifact_revision
      WHERE binding.input_ref IS NULL
         OR artifact.artifact_id IS NULL
         OR artifact.producer_node_id <> binding.producer_node_id`,
  );
  insertInvalidRunReason(
    db,
    'malformed_task_payload',
    `SELECT DISTINCT node.workspace_id, node.run_id, ?
       FROM workflow_nodes node
       JOIN tasks task
         ON task.workspace_id = node.workspace_id
        AND task.id = node.task_id
      WHERE json_valid(task.payload_json) = 0`,
  );
  insertInvalidRunReason(
    db,
    'invalid_session_runtime_epoch',
    `SELECT DISTINCT node.workspace_id, node.run_id, ?
       FROM workflow_nodes node
       JOIN (
         SELECT task.workspace_id,
                task.id,
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END AS safe_payload_json
           FROM tasks task
       ) task
         ON task.workspace_id = node.workspace_id
        AND task.id = node.task_id
      WHERE json_type(task.safe_payload_json, '$.committedSessionId') = 'text'
        AND json_extract(task.safe_payload_json, '$.committedSessionId') <> ''
        AND json_type(task.safe_payload_json, '$.runtimeEpoch') IS NOT NULL
        AND (
          json_type(task.safe_payload_json, '$.runtimeEpoch') <> 'integer'
          OR json_extract(task.safe_payload_json, '$.runtimeEpoch') < 0
        )`,
  );
  insertInvalidRunReason(
    db,
    'duplicate_session_ownership',
    `SELECT DISTINCT node.workspace_id, node.run_id, ?
       FROM workflow_nodes node
       JOIN tasks task
         ON task.workspace_id = node.workspace_id
        AND task.id = node.task_id
       JOIN (
         SELECT workspace_id, backend,
                json_extract(
                  CASE WHEN json_valid(payload_json) = 1 THEN payload_json ELSE '{}' END,
                  '$.committedSessionId'
                ) AS session_id
           FROM tasks
          WHERE json_type(
                  CASE WHEN json_valid(payload_json) = 1 THEN payload_json ELSE '{}' END,
                  '$.committedSessionId'
                ) = 'text'
            AND json_extract(
                  CASE WHEN json_valid(payload_json) = 1 THEN payload_json ELSE '{}' END,
                  '$.committedSessionId'
                ) <> ''
          GROUP BY workspace_id, backend, session_id
         HAVING COUNT(*) > 1
       ) duplicate
         ON duplicate.workspace_id = task.workspace_id
        AND duplicate.backend = task.backend
        AND duplicate.session_id = json_extract(
              CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
              '$.committedSessionId'
            )`,
  );
  insertInvalidRunReason(
    db,
    'contradictory_feedback_identity',
    `SELECT DISTINCT message.workspace_id, message.run_id, ?
       FROM (
         SELECT routed.*,
                json_valid(routed.body_json) AS body_json_valid,
                CASE WHEN json_valid(routed.body_json) = 1 THEN routed.body_json ELSE '{}' END AS safe_body_json
           FROM workflow_routed_messages routed
       ) message
      WHERE message.kind IN ('feedback_request', 'feedback_response')
        AND (
          message.body_json_valid = 0
          OR NOT EXISTS (
            SELECT 1
              FROM workflow_feedback_rounds round
              JOIN workflow_feedback_targets target
                ON target.workspace_id = round.workspace_id
               AND target.run_id = round.run_id
               AND target.round_id = round.round_id
             WHERE round.workspace_id = message.workspace_id
               AND round.run_id = message.run_id
               AND round.round_id = json_extract(message.safe_body_json, '$.roundId')
               AND json_type(message.safe_body_json, '$.roundId') = 'text'
               AND json_type(message.safe_body_json, '$.targetNodeId') = 'text'
               AND json_type(message.safe_body_json, '$.requesterNodeId') = 'text'
               AND target.target_node_id = json_extract(message.safe_body_json, '$.targetNodeId')
               AND round.requester_node_id = json_extract(message.safe_body_json, '$.requesterNodeId')
               AND (
                 (message.kind = 'feedback_request'
                  AND message.source_node_id = round.requester_node_id
                  AND message.destination_node_id = target.target_node_id
                  AND json_type(message.safe_body_json, '$.feedbackTurnId') = 'text'
                  AND json_type(message.safe_body_json, '$.baseArtifactId') = 'text'
                  AND json_type(message.safe_body_json, '$.baseArtifactRevision') = 'integer'
                  AND EXISTS (
                    SELECT 1
                      FROM workflow_nodes feedback_node
                      JOIN turns feedback_turn
                        ON feedback_turn.workspace_id = feedback_node.workspace_id
                       AND feedback_turn.task_id = feedback_node.task_id
                       AND feedback_turn.id = json_extract(message.safe_body_json, '$.feedbackTurnId')
                     WHERE feedback_node.workspace_id = message.workspace_id
                       AND feedback_node.run_id = message.run_id
                       AND feedback_node.node_id = target.target_node_id
                  )
                  AND EXISTS (
                    SELECT 1
                      FROM workflow_artifacts artifact
                     WHERE artifact.workspace_id = message.workspace_id
                       AND artifact.run_id = message.run_id
                       AND artifact.artifact_id = json_extract(message.safe_body_json, '$.baseArtifactId')
                       AND artifact.revision = json_extract(message.safe_body_json, '$.baseArtifactRevision')
                  ))
                 OR
                 (message.kind = 'feedback_response'
                 AND message.source_node_id = target.target_node_id
                  AND message.destination_node_id = round.requester_node_id
                  AND json_type(message.safe_body_json, '$.sourceTurnId') = 'text'
                  AND EXISTS (
                    SELECT 1
                      FROM workflow_nodes feedback_node
                      JOIN turns source_turn
                        ON source_turn.workspace_id = feedback_node.workspace_id
                       AND source_turn.task_id = feedback_node.task_id
                       AND source_turn.id = json_extract(message.safe_body_json, '$.sourceTurnId')
                     WHERE feedback_node.workspace_id = message.workspace_id
                       AND feedback_node.run_id = message.run_id
                       AND feedback_node.node_id = target.target_node_id
                  ))
               )
          )
        )`,
  );
  insertInvalidRunReason(
    db,
    'partial_child_continuation',
    `SELECT DISTINCT continuation.workspace_id, continuation.run_id, ?
       FROM (
         SELECT row.*,
                json_valid(row.payload_json) AS payload_json_valid,
                CASE WHEN json_valid(row.payload_json) = 1 THEN row.payload_json ELSE '{}' END AS safe_payload_json
           FROM workflow_continuations row
       ) continuation
      WHERE continuation.kind <> 'child_wait'
         OR continuation.payload_json_valid = 0
         OR json_type(continuation.safe_payload_json, '$.childRunId') <> 'text'
         OR json_type(continuation.safe_payload_json, '$.returnGateId') <> 'text'
         OR json_type(continuation.safe_payload_json, '$.callerNodeId') <> 'text'
         OR json_type(continuation.safe_payload_json, '$.callerTaskId') <> 'text'
         OR NOT EXISTS (
           SELECT 1
             FROM workflow_runs child
             JOIN workflow_nodes caller_node
               ON caller_node.workspace_id = continuation.workspace_id
              AND caller_node.run_id = continuation.run_id
              AND caller_node.node_id = json_extract(continuation.safe_payload_json, '$.callerNodeId')
              AND caller_node.task_id = json_extract(continuation.safe_payload_json, '$.callerTaskId')
             JOIN workflow_dependency_gates return_gate
               ON return_gate.workspace_id = continuation.workspace_id
               AND return_gate.run_id = continuation.run_id
               AND return_gate.gate_id = json_extract(continuation.safe_payload_json, '$.returnGateId')
             JOIN workflow_gate_bindings return_binding
               ON return_binding.workspace_id = return_gate.workspace_id
              AND return_binding.run_id = return_gate.run_id
              AND return_binding.gate_id = return_gate.gate_id
              AND return_binding.input_ref = 'child_return'
              AND return_binding.producer_node_id = caller_node.node_id
              AND return_binding.required_kind = 'artifact'
             WHERE child.workspace_id = continuation.workspace_id
               AND child.run_id = json_extract(continuation.safe_payload_json, '$.childRunId')
               AND child.origin = 'child'
               AND child.parent_run_id = continuation.run_id
               AND return_gate.consumer_node_id = caller_node.node_id
               AND CASE continuation.status
                 WHEN 'pending' THEN child.status = 'running' AND return_gate.status = 'open'
                 WHEN 'resolved' THEN
                   child.status = 'succeeded'
                   AND return_gate.status IN ('satisfied', 'consumed')
                   AND (
                     SELECT COUNT(*)
                       FROM workflow_routed_messages return_message
                      WHERE return_message.workspace_id = continuation.workspace_id
                        AND return_message.run_id = continuation.run_id
                        AND return_message.kind = 'child_return'
                        AND json_extract(
                              CASE WHEN json_valid(return_message.body_json) = 1 THEN return_message.body_json ELSE '{}' END,
                              '$.childRunId'
                            ) = child.run_id
                        AND json_extract(
                              CASE WHEN json_valid(return_message.body_json) = 1 THEN return_message.body_json ELSE '{}' END,
                              '$.continuationId'
                            ) = continuation.continuation_id
                        AND json_extract(
                              CASE WHEN json_valid(return_message.body_json) = 1 THEN return_message.body_json ELSE '{}' END,
                              '$.returnGateId'
                            ) = return_gate.gate_id
                   ) = 1
                 WHEN 'failed' THEN child.status = 'failed' AND return_gate.status = 'failed'
                 WHEN 'cancelled' THEN child.status = 'cancelled' AND return_gate.status = 'cancelled'
                 ELSE 0
               END
          )`,
  );
  insertInvalidRunReason(
    db,
    'partial_child_continuation',
    `SELECT child.workspace_id, child.run_id, ?
       FROM workflow_runs child
      WHERE child.origin = 'child'
        AND (
          child.parent_run_id IS NULL
          OR (
            SELECT COUNT(*)
              FROM workflow_continuations continuation
             WHERE continuation.workspace_id = child.workspace_id
               AND continuation.run_id = child.parent_run_id
               AND continuation.kind = 'child_wait'
               AND json_extract(
                     CASE WHEN json_valid(continuation.payload_json) = 1 THEN continuation.payload_json ELSE '{}' END,
                     '$.childRunId'
                   ) = child.run_id
          ) <> 1
        )`,
  );
  insertInvalidRunReason(
    db,
    'terminal_run_queued_work',
    `SELECT DISTINCT run.workspace_id, run.run_id, ?
       FROM workflow_runs run
       JOIN workflow_nodes node
         ON node.workspace_id = run.workspace_id
        AND node.run_id = run.run_id
       JOIN turns turn
         ON turn.workspace_id = node.workspace_id
        AND turn.task_id = node.task_id
        AND turn.status = 'queued'
      WHERE run.status <> 'running'`,
  );

  for (;;) {
    const childChanges = db.prepare(
      `INSERT OR IGNORE INTO muster_invalid_v8_runs (workspace_id, run_id, reason_code)
       SELECT child.workspace_id, child.run_id, 'invalid_parent_run'
         FROM workflow_runs child
         JOIN muster_invalid_v8_runs parent
           ON parent.workspace_id = child.workspace_id
          AND parent.run_id = child.parent_run_id`,
    ).run().changes;
    const parentChanges = db.prepare(
      `INSERT OR IGNORE INTO muster_invalid_v8_runs (workspace_id, run_id, reason_code)
       SELECT parent.workspace_id, parent.run_id, 'invalid_child_run'
         FROM workflow_runs child
         JOIN muster_invalid_v8_runs invalid_child
           ON invalid_child.workspace_id = child.workspace_id
          AND invalid_child.run_id = child.run_id
         JOIN workflow_runs parent
           ON parent.workspace_id = child.workspace_id
          AND parent.run_id = child.parent_run_id`,
    ).run().changes;
    if (childChanges === 0 && parentChanges === 0) break;
  }

  const quarantinedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_migration_quarantine
     (workspace_id, legacy_run_id, original_status, reason_code, row_counts_json, quarantined_at)
     SELECT invalid.workspace_id,
            invalid.run_id,
            run.status,
            invalid.reason_code,
            json_object(
              'nodes', (SELECT COUNT(*) FROM workflow_nodes row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'gates', (SELECT COUNT(*) FROM workflow_dependency_gates row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'bindings', (SELECT COUNT(*) FROM workflow_gate_bindings row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'fills', (SELECT COUNT(*) FROM workflow_gate_fills row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'artifacts', (SELECT COUNT(*) FROM workflow_artifacts row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'feedbackRounds', (SELECT COUNT(*) FROM workflow_feedback_rounds row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'feedbackTargets', (SELECT COUNT(*) FROM workflow_feedback_targets row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'routedMessages', (SELECT COUNT(*) FROM workflow_routed_messages row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id),
              'continuations', (SELECT COUNT(*) FROM workflow_continuations row WHERE row.workspace_id = invalid.workspace_id AND row.run_id = invalid.run_id)
            ),
            ?
       FROM muster_invalid_v8_runs invalid
       JOIN workflow_runs run
         ON run.workspace_id = invalid.workspace_id
        AND run.run_id = invalid.run_id`,
  ).run(quarantinedAt);

  db.exec(
    `CREATE TEMP TABLE muster_quarantined_turns AS
     SELECT DISTINCT turn.workspace_id, turn.id AS turn_id
       FROM turns turn
       JOIN workflow_nodes node
         ON node.workspace_id = turn.workspace_id
        AND node.task_id = turn.task_id
       JOIN muster_invalid_v8_runs invalid
         ON invalid.workspace_id = node.workspace_id
        AND invalid.run_id = node.run_id
      WHERE turn.status = 'queued'`,
  );
  db.prepare(
    `UPDATE turns
        SET status = 'cancelled',
            settled_at = COALESCE(settled_at, ?),
            payload_json = CASE
              WHEN json_valid(payload_json) = 1
                THEN json_set(payload_json, '$.workflowMigrationQuarantined', 1)
              ELSE json_object('workflowMigrationQuarantined', 1)
            END
      WHERE EXISTS (
        SELECT 1 FROM muster_quarantined_turns quarantined
         WHERE quarantined.workspace_id = turns.workspace_id
           AND quarantined.turn_id = turns.id
      )`,
  ).run(quarantinedAt);
  for (const table of ['runtime_claims', 'session_claims', 'resource_claims', 'turn_cancel_requests']) {
    db.exec(
      `DELETE FROM ${table}
        WHERE EXISTS (
          SELECT 1 FROM muster_quarantined_turns quarantined
           WHERE quarantined.workspace_id = ${table}.workspace_id
             AND quarantined.turn_id = ${table}.turn_id
        )`,
    );
  }
  db.prepare(
    `UPDATE tasks
        SET revision = revision + 1,
            updated_at = ?,
            payload_json = json_set(
              payload_json,
              '$.attention',
              json_object(
                'code', 'workflow_run_failed',
                'message', 'workflow migration quarantine: ' || (
                  SELECT invalid.reason_code
                    FROM workflow_nodes node
                    JOIN muster_invalid_v8_runs invalid
                      ON invalid.workspace_id = node.workspace_id
                     AND invalid.run_id = node.run_id
                   WHERE node.workspace_id = tasks.workspace_id
                     AND node.task_id = tasks.id
                   LIMIT 1
                ),
                'at', ?
              )
            )
      WHERE json_valid(payload_json) = 1
        AND json_extract(
              CASE WHEN json_valid(payload_json) = 1 THEN payload_json ELSE '{}' END,
              '$.attention'
            ) IS NULL
        AND (
          SELECT COUNT(*) FROM workflow_nodes owner
           WHERE owner.workspace_id = tasks.workspace_id
             AND owner.task_id = tasks.id
        ) = 1
        AND EXISTS (
          SELECT 1
            FROM workflow_nodes node
            JOIN muster_invalid_v8_runs invalid
              ON invalid.workspace_id = node.workspace_id
             AND invalid.run_id = node.run_id
           WHERE node.workspace_id = tasks.workspace_id
             AND node.task_id = tasks.id
        )`,
  ).run(quarantinedAt, quarantinedAt);
  db.exec(
    `DELETE FROM workflow_runs
      WHERE EXISTS (
        SELECT 1 FROM muster_invalid_v8_runs invalid
         WHERE invalid.workspace_id = workflow_runs.workspace_id
           AND invalid.run_id = workflow_runs.run_id
      )`,
  );
}

export function migrateOwnedV8ToCurrent(
  db: DatabaseSync,
  receipt: MigrationBackupReceipt,
): void {
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    const applicationId = readScalar(db, 'application_id');
    const userVersion = readScalar(db, 'user_version');

    if (applicationId === MUSTER_APPLICATION_ID && userVersion === SQLITE_SCHEMA_VERSION) {
      assertCurrentSchemaComplete(db);
      db.exec('COMMIT');
      return;
    }
    if (applicationId !== MUSTER_APPLICATION_ID || userVersion !== SCHEMA_V8) {
      throw new IncompatibleSchemaError(userVersion);
    }
    assertOwnedV8SchemaComplete(db);
    assertMigrationBackupReceipt(db, receipt);
    publishMigrationBackupReceipt(receipt);

    for (const triggerName of SCHEMA_V8_WRITER_GUARD_TRIGGER_NAMES) {
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }
    for (const statement of SCHEMA_V9_MIGRATION_STATEMENTS) {
      if (isDeferredV9IntegrityStatement(statement)) continue;
      db.exec(statement);
    }
    quarantineInvalidV8WorkflowRuns(db);
    for (const statement of SCHEMA_V9_MIGRATION_STATEMENTS) {
      if (!isDeferredV9IntegrityStatement(statement)) continue;
      db.exec(statement);
    }
    db.exec(
      `INSERT INTO session_owners
       (workspace_id, backend, session_id, task_id, first_bound_at)
       SELECT task.workspace_id,
              task.backend,
              json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.committedSessionId'
              ),
              task.id,
              task.updated_at
         FROM tasks task
        WHERE typeof(json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.committedSessionId'
              )) = 'text'
          AND json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.committedSessionId'
              ) <> ''
          AND (
            json_type(
              CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
              '$.runtimeEpoch'
            ) IS NULL
            OR (
              json_type(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.runtimeEpoch'
              ) = 'integer'
              AND json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.runtimeEpoch'
              ) >= 0
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM tasks conflicting
             WHERE conflicting.workspace_id = task.workspace_id
               AND conflicting.backend = task.backend
               AND json_extract(
                     CASE WHEN json_valid(conflicting.payload_json) = 1 THEN conflicting.payload_json ELSE '{}' END,
                     '$.committedSessionId'
                   ) = json_extract(
                     CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                     '$.committedSessionId'
                   )
               AND conflicting.id <> task.id
          )`,
    );
    db.exec(
      `INSERT INTO task_session_bindings
       (workspace_id, task_id, runtime_epoch, backend, session_id, active, bound_at, cleared_at)
       SELECT task.workspace_id,
              task.id,
              COALESCE(json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.runtimeEpoch'
              ), 1),
              task.backend,
              json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.committedSessionId'
              ),
              1,
              task.updated_at,
              NULL
         FROM tasks task
         JOIN session_owners owner
          ON owner.workspace_id = task.workspace_id
          AND owner.backend = task.backend
          AND owner.session_id = json_extract(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.committedSessionId'
              )
          AND owner.task_id = task.id
        WHERE json_type(
                CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                '$.runtimeEpoch'
              ) IS NULL
           OR (
                json_type(
                  CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                  '$.runtimeEpoch'
                ) = 'integer'
                AND json_extract(
                  CASE WHEN json_valid(task.payload_json) = 1 THEN task.payload_json ELSE '{}' END,
                  '$.runtimeEpoch'
                ) >= 0
              )`,
    );
    for (const statement of SCHEMA_V9_WRITER_GUARD_STATEMENTS) {
      db.exec(statement);
    }
    const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length > 0) {
      throw new IncompatibleSchemaError(SCHEMA_V8);
    }
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    assertCurrentSchemaComplete(db);
    maybeInjectFault('migrate');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Prefer the original migration failure over a secondary rollback error.
    }
    throw error;
  }
}

function migrateOwnedV8ToCurrentWithBackup(db: DatabaseSync, sourcePath: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const receipt = createMigrationBackupReceipt(db, sourcePath, SCHEMA_V8, SQLITE_SCHEMA_VERSION);
    try {
      migrateOwnedV8ToCurrent(db, receipt);
      discardMigrationBackupReceipt(receipt);
      return;
    } catch (error) {
      discardMigrationBackupReceipt(receipt);
      if (error instanceof MigrationBackupStaleError) continue;
      throw error;
    }
  }
  throw new MusterSqliteError('busy', 'open');
}

export function migrateOwnedV7ToCurrent(db: DatabaseSync, sourcePath: string): void {
  migrateOwnedV7ToV8(db);
  migrateOwnedV8ToCurrentWithBackup(db, sourcePath);
}

/**
 * Connection-local wait policy only. Safe during preflight because busy_timeout is
 * not a durable file mutation (unlike journal_mode / application_id / user_version).
 */
function applyConnectionBusyTimeout(db: DatabaseSync, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
}

/**
 * Runtime pragmas for an owned Muster connection. WAL is durable and must only run
 * after ownership/schema validation succeeds.
 */
function applyRuntimePragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  applyConnectionBusyTimeout(db, busyTimeoutMs);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
}

type ExclusiveOpenDecision = { kind: 'current' } | { kind: 'blank_claimed' };
type ExistingOpenResult = 'current' | 'migrate_v7' | 'migrate_v8' | false;

/**
 * Private signal: state changed under concurrent first-open (peer bootstrap).
 * Caller closes and reopens a fresh connection — not a permanent ownership error.
 */
class ConcurrentOpenStateChanged extends Error {
  constructor() {
    super('concurrent open state changed after blank preflight');
    this.name = 'ConcurrentOpenStateChanged';
  }
}

/**
 * Authoritative ownership decision under BEGIN EXCLUSIVE.
 * Concurrent first-open losers block on the lock, then re-read post-commit
 * markers in the same exclusive critical section — never misclassify a peer
 * bootstrap as nonempty_unclaimed from a stale pre-claim snapshot.
 * Rejected foreign/incompatible/nonempty paths roll back with zero durable
 * schema/marker mutation.
 */
function exclusiveOpenDecision(db: DatabaseSync): ExclusiveOpenDecision {
  db.exec('BEGIN EXCLUSIVE TRANSACTION');
  try {
    const applicationId = readScalar(db, 'application_id');
    const userVersion = readScalar(db, 'user_version');

    if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
      throw new ForeignDatabaseError(applicationId);
    }

    if (applicationId === MUSTER_APPLICATION_ID) {
      if (userVersion === SQLITE_SCHEMA_VERSION) {
        assertCurrentSchemaComplete(db);
        db.exec('COMMIT');
        return { kind: 'current' };
      }
      throw new IncompatibleSchemaError(userVersion);
    }

    // application_id === 0
    if (userVersion !== 0) {
      throw new IncompatibleSchemaError(userVersion);
    }
    if (hasUserSchemaObjects(db)) {
      // Blank preflight saw no objects; exclusive sees objects without Muster
      // markers — peer commit race / header visibility. Reopen fresh.
      db.exec('ROLLBACK');
      throw new ConcurrentOpenStateChanged();
    }

    for (const statement of CURRENT_SCHEMA_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    assertCurrentSchemaComplete(db);
    db.exec('COMMIT');
    return { kind: 'blank_claimed' };
  } catch (error) {
    if (!(error instanceof ConcurrentOpenStateChanged)) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is the real signal
      }
    }
    throw error;
  }
}

/**
 * Read-only ownership probe. Never stamps markers or creates schema.
 * - current Muster → 'current'
 * - owned complete v7 → 'migrate_v7' (upgrade under exclusive)
 * - blank → false (claim under exclusive)
 * - concurrent schema-without-markers after a blank was observed → ConcurrentOpenStateChanged
 * - genuine non-empty unclaimed on first probe → NonEmptyUnclaimedDatabaseError
 */
function tryOpenExistingCurrent(
  db: DatabaseSync,
  opts: { allowConcurrentNonemptyRetry: boolean },
): ExistingOpenResult {
  const applicationId = readScalar(db, 'application_id');
  const userVersion = readScalar(db, 'user_version');
  if (applicationId !== 0 && applicationId !== MUSTER_APPLICATION_ID) {
    throw new ForeignDatabaseError(applicationId);
  }
  if (applicationId === MUSTER_APPLICATION_ID) {
    if (userVersion === SQLITE_SCHEMA_VERSION) {
      assertCurrentSchemaComplete(db);
      return 'current';
    }
    // Compare via Number so the v7 migration branch stays reachable when the
    // compiled current schema advances past SCHEMA_V7 (literal 7 vs 8).
    if (userVersion === SCHEMA_V7 && Number(SCHEMA_V7) !== Number(SQLITE_SCHEMA_VERSION)) {
      assertOwnedV7SchemaComplete(db);
      return 'migrate_v7';
    }
    if (userVersion === SCHEMA_V8 && Number(SCHEMA_V8) !== Number(SQLITE_SCHEMA_VERSION)) {
      assertOwnedV8SchemaComplete(db);
      return 'migrate_v8';
    }
    throw new IncompatibleSchemaError(userVersion);
  }
  if (userVersion !== 0) {
    throw new IncompatibleSchemaError(userVersion);
  }
  if (hasUserSchemaObjects(db)) {
    // Re-read markers once — peer commit can expose schema before header markers.
    const appAgain = readScalar(db, 'application_id');
    const verAgain = readScalar(db, 'user_version');
    if (appAgain === MUSTER_APPLICATION_ID && verAgain === SQLITE_SCHEMA_VERSION) {
      assertCurrentSchemaComplete(db);
      return 'current';
    }
    if (
      appAgain === MUSTER_APPLICATION_ID &&
      verAgain === SCHEMA_V7 &&
      Number(SCHEMA_V7) !== Number(SQLITE_SCHEMA_VERSION)
    ) {
      assertOwnedV7SchemaComplete(db);
      return 'migrate_v7';
    }
    if (
      appAgain === MUSTER_APPLICATION_ID &&
      verAgain === SCHEMA_V8 &&
      Number(SCHEMA_V8) !== Number(SQLITE_SCHEMA_VERSION)
    ) {
      assertOwnedV8SchemaComplete(db);
      return 'migrate_v8';
    }
    if (opts.allowConcurrentNonemptyRetry && appAgain === 0 && verAgain === 0) {
      throw new ConcurrentOpenStateChanged();
    }
    if (appAgain !== 0 && appAgain !== MUSTER_APPLICATION_ID) {
      throw new ForeignDatabaseError(appAgain);
    }
    if (appAgain === MUSTER_APPLICATION_ID) {
      throw new IncompatibleSchemaError(verAgain);
    }
    throw new NonEmptyUnclaimedDatabaseError();
  }
  return false; // blank — claim under exclusive
}

/**
 * Open the store DB with validation-before-mutation:
 * 1. Read-only path for already-owned current DBs (no exclusive).
 * 2. Blank DBs claim under BEGIN EXCLUSIVE (concurrent first-open safe).
 * 3. Runtime pragmas (incl. WAL) only after ownership is confirmed.
 * Rejected databases are closed without durable side effects.
 * Retry is limited to SQLite BUSY/LOCKED contention.
 */
export function openStoreDatabase(opts: OpenOptions): DatabaseSync {
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  // Concurrent first-open may contend on BEGIN EXCLUSIVE. Reopen within a budget
  // only for real lock errors; permanent ownership/schema failures fail immediately.
  const retryDeadline = Date.now() + Math.max(1_000, busyTimeoutMs * 2);
  let attempt = 0;
  /** After a blank preflight, concurrent schema-without-markers may retry. */
  let sawBlankPreflight = false;
  /** Bounded fingerprint retries for concurrent current-marker visibility. */
  let fingerprintRetries = 0;
  const MAX_FINGERPRINT_RETRIES = 6;

  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(opts.path);
      // Connection-local only — does not mutate durable journal/application markers.
      applyConnectionBusyTimeout(db, busyTimeoutMs);
      const existing = tryOpenExistingCurrent(db, {
        allowConcurrentNonemptyRetry: sawBlankPreflight,
      });
      if (existing === 'migrate_v7') {
        migrateOwnedV7ToCurrent(db, opts.path);
      } else if (existing === 'migrate_v8') {
        migrateOwnedV8ToCurrentWithBackup(db, opts.path);
      } else if (!existing) {
        sawBlankPreflight = true;
        // Fresh connection for exclusive claim so page cache cannot retain a
        // pre-peer-commit blank snapshot across BEGIN EXCLUSIVE.
        try {
          db.close();
        } catch {
          // continue with a new connection regardless
        }
        db = new DatabaseSync(opts.path);
        applyConnectionBusyTimeout(db, busyTimeoutMs);
        exclusiveOpenDecision(db);
      }
      // Writer UDF must be registered before any guarded write on this connection.
      registerWriterVersionUdf(db);
      // WAL / foreign_keys / synchronous only after ownership is confirmed.
      applyRuntimePragmas(db, busyTimeoutMs);
      return db;
    } catch (error) {
      if (db) {
        try {
          db.close();
        } catch {
          // The original initialization error is the actionable failure.
        }
      }
      if (error instanceof ConcurrentOpenStateChanged) {
        if (Date.now() >= retryDeadline) {
          // Stable non-empty without Muster markers after bounded retries.
          throw new NonEmptyUnclaimedDatabaseError();
        }
        waitBeforeOpenRetry(attempt);
        attempt += 1;
        continue;
      }
      // Concurrent first-open can briefly fail fingerprint while a peer finishes
      // bootstrap/WAL. Cap retries so permanently incompatible current-marker
      // DBs still fail closed quickly.
      if (
        error instanceof IncompatibleSchemaError &&
        error.observedVersion === SQLITE_SCHEMA_VERSION &&
        fingerprintRetries < MAX_FINGERPRINT_RETRIES &&
        Date.now() < retryDeadline
      ) {
        fingerprintRetries += 1;
        waitBeforeOpenRetry(attempt);
        attempt += 1;
        continue;
      }
      // Ownership errors already carry the safe taxonomy; map physical open failures
      // (garbage/not-a-database/corrupt) without retrying permanent conditions.
      if (error instanceof MusterSqliteError) {
        throw error;
      }
      if (!isRetryableOpenLock(error) || Date.now() >= retryDeadline) {
        throw mapToMusterSqliteError(error, 'open');
      }
      waitBeforeOpenRetry(attempt);
      attempt += 1;
    }
  }
}
