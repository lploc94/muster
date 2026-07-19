/**
 * Current SQLite schema for the global Muster store (sqlite-global-storage-refactor §4).
 *
 * Identity model: every domain entity uses composite identity
 * `(workspace_id, entity_id)` and all foreign keys are composite. This is a hard
 * requirement (plan §4): task ids are workspace-scoped and are not globally unique.
 *
 * A field has ONE source of truth: a column promoted out of the payload must not be
 * duplicated inside `payload_json`. Query/state keys are columns; low-query payload
 * is versioned JSON text validated by a codec (added in Phase 3).
 */

/** Muster's private SQLite `application_id` (verified before reading schema, plan §3.4). */
export const MUSTER_APPLICATION_ID = 0x4d555354; // 'MUST'

/**
 * Frozen schema v7 identity. Migration input validation depends on this remaining
 * stable after the compiled current schema advances to v8.
 */
export const SCHEMA_V7 = 7 as const;

/** Schema v8 identity (workflow tables + writer-version fence). */
export const SCHEMA_V8 = 8 as const;

/** Current schema version, tracked via `PRAGMA user_version`. */
export const SQLITE_SCHEMA_VERSION = SCHEMA_V8;

/**
 * Frozen v7 required tables (migration-input / populated fixture counts).
 * Immutable after freeze — do not append workflow tables here.
 */
export const REQUIRED_SCHEMA_V7_TABLES = [
  'workspaces',
  'workspace_locations',
  'tasks',
  'task_dependencies',
  'turns',
  'messages',
  'reasoning_segments',
  'tool_calls',
  'operations',
  'send_receipts',
  'workspace_revisions',
  'change_log',
  'change_feed_watermarks',
  'turn_inputs',
  'session_claims',
  'resource_claims',
  'turn_cancel_requests',
  'runtime_claims',
  'send_outbox',
  'presentations',
  'presentation_operations',
] as const;

/**
 * Workflow tables introduced by schema v8 (additive; never rewrite v7 history).
 */
export const REQUIRED_SCHEMA_V8_WORKFLOW_TABLES = [
  'workflow_definitions',
  'workflow_runs',
  'workflow_nodes',
  'workflow_dependency_gates',
  'workflow_gate_bindings',
  'workflow_artifacts',
  'workflow_gate_fills',
  'workflow_feedback_rounds',
  'workflow_feedback_targets',
  'workflow_routed_messages',
  'workflow_continuations',
] as const;

/**
 * Required user schema objects for an owned current database (P5-W2).
 * Bounded preflight checks these names only — not full integrity_check.
 */
export const REQUIRED_SCHEMA_TABLES = [
  ...REQUIRED_SCHEMA_V7_TABLES,
  ...REQUIRED_SCHEMA_V8_WORKFLOW_TABLES,
] as const;

export const REQUIRED_SCHEMA_TRIGGERS = ['trg_send_outbox_capacity'] as const;

/** Connection-local UDF name used by v8 writer-guard triggers. */
export const MUSTER_WRITER_VERSION_UDF = 'muster_writer_version';

/**
 * Production change-feed retention bound (revisions kept after the low watermark).
 * Tests may inject a smaller bound via repository options; production does not
 * depend on test-only global state.
 */
export const CHANGE_FEED_RETAIN_REVISIONS = 4096;

/**
 * Frozen schema-v7 DDL. Immutable after freeze — a compiled v8 binary validates
 * migration candidates against this exact statement set / fingerprint, not against
 * whatever CURRENT_SCHEMA_STATEMENTS has become.
 */
export const SCHEMA_V7_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_locations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    canonical_uri TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, canonical_uri),
    UNIQUE (canonical_uri)
  )`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id TEXT,
    role TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    release_state TEXT NOT NULL CHECK (release_state IN ('draft', 'released')),
    goal TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, parent_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS task_dependencies (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    dependency_task_id TEXT NOT NULL,
    required_outcome TEXT NOT NULL,
    on_unsatisfied TEXT NOT NULL,
    required_verdict TEXT,
    PRIMARY KEY (workspace_id, task_id, dependency_task_id),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, dependency_task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS turns (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    settled_at TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, task_id, sequence),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    turn_id TEXT,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    ordering INTEGER,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS reasoning_segments (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    ordering INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    ordering INTEGER NOT NULL,
    status TEXT NOT NULL,
    name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,
  // Durable operation replay and send idempotency.

  `CREATE TABLE IF NOT EXISTS operations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    ledger_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, ledger_key)
  )`,

  `CREATE TABLE IF NOT EXISTS send_receipts (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    task_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, client_request_id)
  )`,

  // Revision / change feed for multi-extension-host coherence (plan §4).
  `CREATE TABLE IF NOT EXISTS workspace_revisions (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS change_log (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    task_id TEXT,
    change_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, revision, entity_kind, entity_id)
  )`,

  // Explicit low watermark for gap detection. retained_from_revision is the
  // smallest revision still fully readable; revision 0 workspaces use 1.
  `CREATE TABLE IF NOT EXISTS change_feed_watermarks (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    retained_from_revision INTEGER NOT NULL
  )`,

  // Minimum indexes (plan §4).
  `CREATE INDEX IF NOT EXISTS idx_change_log_workspace_revision ON change_log(workspace_id, revision)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_workspace_parent ON tasks(workspace_id, parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_workspace_lifecycle ON tasks(workspace_id, lifecycle, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_task_sequence ON turns(workspace_id, task_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_workspace_status ON turns(workspace_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_task_created ON messages(workspace_id, task_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(workspace_id, turn_id, ordering)`,
  `CREATE INDEX IF NOT EXISTS idx_reasoning_turn_order ON reasoning_segments(workspace_id, turn_id, ordering)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_order ON tool_calls(workspace_id, turn_id, ordering)`,

  // Current row-level scheduling, cancellation, and runtime ownership tables.
  `CREATE TABLE IF NOT EXISTS turn_inputs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    ordering INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, turn_id, ordering),
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS session_claims (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, session_id),
    UNIQUE (workspace_id, turn_id),
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS resource_claims (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    resource_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, resource_key),
    UNIQUE (workspace_id, turn_id, resource_key),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,

  // Cancellation is keyed by turn because one task can have multiple turns.
  `CREATE TABLE IF NOT EXISTS turn_cancel_requests (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    op_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, turn_id),
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_turn_inputs_turn_order ON turn_inputs(workspace_id, turn_id, ordering)`,
  `CREATE INDEX IF NOT EXISTS idx_session_claims_turn ON session_claims(workspace_id, turn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resource_claims_turn ON resource_claims(workspace_id, turn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cancel_requests_task ON turn_cancel_requests(workspace_id, task_id)`,
  `CREATE TABLE IF NOT EXISTS runtime_claims (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, turn_id),
    FOREIGN KEY (workspace_id, turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runtime_claims_expiry ON runtime_claims(workspace_id, expires_at)`,

  // Durable pending/rejected user sends (P4-W11). Webview setState must not hold text.
  `CREATE TABLE IF NOT EXISTS send_outbox (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'rejected')),
    task_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, client_request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_send_outbox_workspace_status
     ON send_outbox(workspace_id, status, created_at)`,
  `CREATE TRIGGER IF NOT EXISTS trg_send_outbox_capacity
     BEFORE INSERT ON send_outbox
     WHEN NOT EXISTS (
            SELECT 1 FROM send_outbox
             WHERE workspace_id = NEW.workspace_id
               AND client_request_id = NEW.client_request_id
          )
      AND (SELECT COUNT(*) FROM send_outbox WHERE workspace_id = NEW.workspace_id) >= 32
     BEGIN
       SELECT RAISE(ABORT, 'send outbox capacity reached');
     END`,

  // Canonical presentation documents (P4-W11). Serializer keeps opaque IDs only.
  `CREATE TABLE IF NOT EXISTS presentations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    presentation_id TEXT NOT NULL,
    owner_task_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, root_id, presentation_id),
    FOREIGN KEY (workspace_id, owner_task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_presentations_workspace_owner
     ON presentations(workspace_id, owner_task_id)`,
  `CREATE TABLE IF NOT EXISTS presentation_operations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL,
    root_id TEXT NOT NULL,
    presentation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, operation_key),
    FOREIGN KEY (workspace_id, root_id, presentation_id)
      REFERENCES presentations(workspace_id, root_id, presentation_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  )`,
  `CREATE INDEX IF NOT EXISTS idx_presentation_operations_document
     ON presentation_operations(workspace_id, root_id, presentation_id)`,
];

/**
 * Closed mutable-table allowlist for v8 writer-guard triggers.
 * Generated deterministically so migration output fingerprints match blank claim.
 */
export const SCHEMA_V8_WRITER_GUARD_TABLES: readonly string[] = REQUIRED_SCHEMA_TABLES;

function writerGuardTriggerStatements(
  tables: readonly string[],
  writerVersion: number,
): string[] {
  const events = ['INSERT', 'UPDATE', 'DELETE'] as const;
  const statements: string[] = [];
  for (const table of tables) {
    for (const event of events) {
      const name = `trg_wg_${table}_${event.toLowerCase()}`;
      statements.push(
        `CREATE TRIGGER IF NOT EXISTS ${name}
BEFORE ${event} ON ${table}
WHEN ${MUSTER_WRITER_VERSION_UDF}() IS NULL OR ${MUSTER_WRITER_VERSION_UDF}() <> ${writerVersion}
BEGIN
  SELECT RAISE(ABORT, 'schema_changed');
END`,
      );
    }
  }
  return statements;
}

/**
 * Additive schema-v8 DDL only (workflow tables/indexes + writer-guard triggers).
 * Applied under BEGIN EXCLUSIVE during v7→v8 migration; never rewrites v7 rows.
 */
export const SCHEMA_V8_MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workflow_definitions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    entry_node_id TEXT NOT NULL,
    topology_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, definition_id, version)
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_runs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    parent_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    FOREIGN KEY (workspace_id, definition_id, definition_version)
      REFERENCES workflow_definitions(workspace_id, definition_id, version)
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_nodes (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    task_id TEXT,
    status TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, node_id),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_dependency_gates (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    consumer_node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, gate_id),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_gate_bindings (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    input_ref TEXT NOT NULL,
    producer_node_id TEXT NOT NULL,
    required_kind TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, gate_id, input_ref),
    FOREIGN KEY (workspace_id, run_id, gate_id)
      REFERENCES workflow_dependency_gates(workspace_id, run_id, gate_id)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_artifacts (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    producer_node_id TEXT NOT NULL,
    logical_name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, artifact_id, revision),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_gate_fills (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    input_ref TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL,
    filled_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, gate_id, input_ref, artifact_id, artifact_revision),
    FOREIGN KEY (workspace_id, run_id, gate_id)
      REFERENCES workflow_dependency_gates(workspace_id, run_id, gate_id)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_feedback_rounds (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    requester_node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    join_mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, round_id),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_feedback_targets (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, round_id, target_node_id),
    FOREIGN KEY (workspace_id, run_id, round_id)
      REFERENCES workflow_feedback_rounds(workspace_id, run_id, round_id)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_routed_messages (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    destination_node_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, message_id),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_continuations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    continuation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, continuation_id),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_definition
     ON workflow_runs(workspace_id, definition_id, definition_version)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
     ON workflow_runs(workspace_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_nodes_task
     ON workflow_nodes(workspace_id, task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_gates_status
     ON workflow_dependency_gates(workspace_id, run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_logical
     ON workflow_artifacts(workspace_id, run_id, logical_name, revision)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_feedback_rounds_status
     ON workflow_feedback_rounds(workspace_id, run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_continuations_status
     ON workflow_continuations(workspace_id, run_id, status)`,

  ...writerGuardTriggerStatements(SCHEMA_V8_WRITER_GUARD_TABLES, SCHEMA_V8),
];

/**
 * Full schema-v8 statement set (frozen v7 + additive v8 objects).
 * Blank claim and golden fingerprint for version 8 use this exact array.
 */
export const SCHEMA_V8_STATEMENTS: readonly string[] = [
  ...SCHEMA_V7_STATEMENTS,
  ...SCHEMA_V8_MIGRATION_STATEMENTS,
];

/**
 * Current compiled DDL applied to fresh databases.
 * New objects must land in a version-specific array, not by mutating SCHEMA_V7_STATEMENTS.
 */
export const CURRENT_SCHEMA_STATEMENTS: readonly string[] = SCHEMA_V8_STATEMENTS;

/**
 * Resolve the immutable statement set for a supported schema version.
 * Unknown versions fail closed so migration cannot invent a golden manifest.
 */
export function schemaStatementsForVersion(version: number): readonly string[] {
  if (version === SCHEMA_V7) {
    return SCHEMA_V7_STATEMENTS;
  }
  if (version === SCHEMA_V8) {
    return SCHEMA_V8_STATEMENTS;
  }
  throw new Error(`unsupported schema version ${version}`);
}
