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

/** Clean-break development schema marker. Older stores require an explicit reset. */
export const SQLITE_SCHEMA_VERSION = 1 as const;

/**
 * Core task-store tables.
 */
const REQUIRED_CORE_TABLES = [
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
 * Workflow protocol tables.
 */
const REQUIRED_WORKFLOW_TABLES = [
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

const REQUIRED_WORKFLOW_AUTHORITY_TABLES = [
  'workflow_definition_nodes',
  'workflow_definition_edges',
  'workflow_entry_contracts',
  'workflow_start_claims',
  'workflow_activations',
  'workflow_return_gates',
  'workflow_artifact_sources',
  'session_owners',
  'task_session_bindings',
  'turn_disposition_claims',
] as const;

/**
 * Required user schema objects for an owned current database (P5-W2).
 * Bounded preflight checks these names only — not full integrity_check.
 */
export const REQUIRED_SCHEMA_TABLES = [
  ...REQUIRED_CORE_TABLES,
  ...REQUIRED_WORKFLOW_TABLES,
  ...REQUIRED_WORKFLOW_AUTHORITY_TABLES,
] as const;

export const REQUIRED_SCHEMA_TRIGGERS = ['trg_send_outbox_capacity'] as const;

/** Connection-local UDF name used by writer-guard triggers. */
export const MUSTER_WRITER_VERSION_UDF = 'muster_writer_version';

/**
 * Production change-feed retention bound (revisions kept after the low watermark).
 * Tests may inject a smaller bound via repository options; production does not
 * depend on test-only global state.
 */
export const CHANGE_FEED_RETAIN_REVISIONS = 4096;

/**
 * Core task-store DDL.
 */
const CORE_SCHEMA_STATEMENTS: readonly string[] = [
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

const DEFAULT_WORKFLOW_POLICY_JSON = JSON.stringify({
  maxFeedbackRoundsPerRun: 8,
  maxTurnsPerTask: 50,
  maxWorkflowTurnsPerRun: 64,
  runTimeoutMs: 1_800_000,
  maxDepth: 8,
  maxTaskCount: 64,
  maxConcurrency: 20,
  maxInputsPerGate: 64,
  maxArtifactBytes: 65_536,
  maxAggregateBytes: 262_144,
  failWorkflow: true,
});

/** Workflow topology and runtime DDL. */
const WORKFLOW_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workflow_definitions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    entry_node_id TEXT NOT NULL,
    topology_json TEXT NOT NULL,
    scope_kind TEXT NOT NULL DEFAULT 'workspace' CHECK (scope_kind IN ('workspace', 'root')),
    owner_root_task_id TEXT,
    fingerprint TEXT NOT NULL DEFAULT '',
    policy_json TEXT NOT NULL DEFAULT '${DEFAULT_WORKFLOW_POLICY_JSON}'
      CHECK (json_valid(policy_json) = 1),
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
    owner_root_task_id TEXT,
    caller_task_id TEXT,
    caller_turn_id TEXT,
    continuation_id TEXT,
    policy_json TEXT NOT NULL DEFAULT '${DEFAULT_WORKFLOW_POLICY_JSON}'
      CHECK (json_valid(policy_json) = 1),
    max_feedback_rounds INTEGER NOT NULL DEFAULT 8 CHECK (max_feedback_rounds BETWEEN 1 AND 32),
    max_turns_per_task INTEGER NOT NULL DEFAULT 50 CHECK (max_turns_per_task BETWEEN 1 AND 500),
    max_workflow_turns INTEGER NOT NULL DEFAULT 64 CHECK (max_workflow_turns BETWEEN 1 AND 256),
    max_children INTEGER NOT NULL DEFAULT 64 CHECK (max_children BETWEEN 1 AND 64),
    max_depth INTEGER NOT NULL DEFAULT 8 CHECK (max_depth BETWEEN 1 AND 8),
    max_concurrency INTEGER NOT NULL DEFAULT 20 CHECK (max_concurrency BETWEEN 1 AND 64),
    max_aggregate_bytes INTEGER NOT NULL DEFAULT 262144
      CHECK (max_aggregate_bytes BETWEEN 1 AND 1048576),
    feedback_rounds_reserved INTEGER NOT NULL DEFAULT 0 CHECK (feedback_rounds_reserved >= 0),
    workflow_turns_reserved INTEGER NOT NULL DEFAULT 0 CHECK (workflow_turns_reserved >= 0),
    children_reserved INTEGER NOT NULL DEFAULT 0 CHECK (children_reserved >= 0),
    started_at TEXT,
    deadline_at TEXT,
    terminal_reason_code TEXT,
    terminal_result_run_id TEXT,
    terminal_result_artifact_id TEXT,
    terminal_result_artifact_revision INTEGER,
    closure_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    CHECK ((owner_root_task_id IS NULL) = (caller_task_id IS NULL)),
    CHECK ((caller_task_id IS NULL) = (caller_turn_id IS NULL)),
    CHECK (
      (terminal_result_run_id IS NULL AND terminal_result_artifact_id IS NULL AND terminal_result_artifact_revision IS NULL)
      OR (terminal_result_run_id IS NOT NULL AND terminal_result_artifact_id IS NOT NULL AND terminal_result_artifact_revision IS NOT NULL)
    ),
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
    activation_id TEXT,
    reserved_turn_id TEXT,
    aggregate_message_id TEXT,
    PRIMARY KEY (workspace_id, run_id, gate_id),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_gate_bindings (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    input_ref TEXT NOT NULL,
    producer_node_id TEXT,
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
    producer_node_id TEXT,
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
    artifact_run_id TEXT,
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL,
    filled_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, gate_id, input_ref),
    FOREIGN KEY (workspace_id, run_id, gate_id)
      REFERENCES workflow_dependency_gates(workspace_id, run_id, gate_id)
      ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, run_id, gate_id, input_ref)
      REFERENCES workflow_gate_bindings(workspace_id, run_id, gate_id, input_ref)
      ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, artifact_id, artifact_revision)
      REFERENCES workflow_artifacts(workspace_id, artifact_id, revision)
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_feedback_rounds (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    requester_node_id TEXT NOT NULL,
    requester_task_id TEXT,
    requester_turn_id TEXT,
    requester_activation_id TEXT,
    inherited_round_id TEXT,
    inherited_target_id TEXT,
    resume_activation_id TEXT,
    resume_turn_id TEXT,
    status TEXT NOT NULL,
    join_mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (workspace_id, run_id, round_id),
    CHECK ((inherited_round_id IS NULL AND inherited_target_id IS NULL) OR (inherited_round_id IS NOT NULL AND inherited_target_id IS NOT NULL)),
    CHECK ((resume_activation_id IS NULL AND resume_turn_id IS NULL) OR (resume_activation_id IS NOT NULL AND resume_turn_id IS NOT NULL)),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_feedback_targets (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    target_id TEXT,
    input_ref TEXT,
    target_task_id TEXT,
    base_artifact_run_id TEXT,
    base_artifact_id TEXT,
    base_artifact_revision INTEGER,
    request_activation_id TEXT,
    request_turn_id TEXT,
    request_message_id TEXT,
    response_turn_id TEXT,
    response_artifact_run_id TEXT,
    response_artifact_id TEXT,
    response_artifact_revision INTEGER,
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
    idempotency_key TEXT,
    source_node_id TEXT NOT NULL,
    source_task_id TEXT,
    source_turn_id TEXT,
    destination_node_id TEXT NOT NULL,
    destination_task_id TEXT,
    gate_id TEXT,
    feedback_round_id TEXT,
    feedback_target_id TEXT,
    continuation_id TEXT,
    artifact_run_id TEXT,
    artifact_id TEXT,
    artifact_revision INTEGER,
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
    invocation_key TEXT,
    invocation_fingerprint TEXT,
    caller_task_id TEXT,
    caller_turn_id TEXT,
    caller_run_id TEXT,
    caller_node_id TEXT,
    child_run_id TEXT,
    return_gate_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
    reason_code TEXT,
    result_artifact_run_id TEXT,
    result_artifact_id TEXT,
    result_artifact_revision INTEGER,
    producing_turn_id TEXT,
    resolved_at TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_feedback_rounds_live_requester
     ON workflow_feedback_rounds(workspace_id, run_id, requester_node_id)
     WHERE status IN ('open', 'satisfied')`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_continuations_status
     ON workflow_continuations(workspace_id, run_id, status)`,
];

const WORKFLOW_AUTHORITY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workflow_definition_nodes (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    is_terminal INTEGER NOT NULL CHECK (is_terminal IN (0, 1)),
    role TEXT,
    task_type TEXT,
    backend TEXT,
    model TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (workspace_id, definition_id, definition_version, node_id),
    UNIQUE (workspace_id, definition_id, definition_version, ordinal),
    FOREIGN KEY (workspace_id, definition_id, definition_version)
      REFERENCES workflow_definitions(workspace_id, definition_id, version)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_definition_edges (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    source_node_id TEXT NOT NULL,
    destination_node_id TEXT NOT NULL,
    destination_input_ref TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    expected_artifact_kind TEXT NOT NULL,
    PRIMARY KEY (workspace_id, definition_id, definition_version, source_node_id),
    UNIQUE (workspace_id, definition_id, definition_version, destination_node_id, destination_input_ref),
    UNIQUE (workspace_id, definition_id, definition_version, ordinal),
    FOREIGN KEY (workspace_id, definition_id, definition_version, source_node_id)
      REFERENCES workflow_definition_nodes(workspace_id, definition_id, definition_version, node_id)
      ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, definition_id, definition_version, destination_node_id)
      REFERENCES workflow_definition_nodes(workspace_id, definition_id, definition_version, node_id)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_entry_contracts (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    entry_node_id TEXT NOT NULL,
    input_ref TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    expected_artifact_kind TEXT NOT NULL,
    PRIMARY KEY (workspace_id, definition_id, definition_version, entry_node_id, input_ref),
    UNIQUE (workspace_id, definition_id, definition_version, entry_node_id, ordinal),
    FOREIGN KEY (workspace_id, definition_id, definition_version, entry_node_id)
      REFERENCES workflow_definition_nodes(workspace_id, definition_id, definition_version, node_id)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_start_claims (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_task_id TEXT NOT NULL,
    caller_task_id TEXT NOT NULL,
    caller_turn_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (
      workspace_id, owner_task_id, caller_task_id,
      definition_id, definition_version, idempotency_key
    ),
    UNIQUE (
      workspace_id, caller_turn_id, definition_id,
      definition_version, idempotency_key
    ),
    FOREIGN KEY (workspace_id, owner_task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, caller_turn_id, caller_task_id)
      REFERENCES turns(workspace_id, id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, definition_id, definition_version)
      REFERENCES workflow_definitions(workspace_id, definition_id, version),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_activations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('entry_start', 'dependency_gate', 'feedback_request', 'feedback_resume', 'child_return')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'interrupted', 'consumed', 'cancelled')),
    source_gate_id TEXT,
    feedback_round_id TEXT,
    feedback_target_node_id TEXT,
    continuation_id TEXT,
    return_gate_id TEXT,
    inherited_feedback_round_id TEXT,
    inherited_feedback_target_node_id TEXT,
    primary_turn_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    execution_turn_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id, activation_id),
    UNIQUE (workspace_id, primary_turn_id),
    UNIQUE (workspace_id, execution_turn_id),
    CHECK ((inherited_feedback_round_id IS NULL AND inherited_feedback_target_node_id IS NULL) OR (inherited_feedback_round_id IS NOT NULL AND inherited_feedback_target_node_id IS NOT NULL)),
    CHECK (
      (kind IN ('entry_start', 'dependency_gate') AND source_gate_id IS NOT NULL AND feedback_round_id IS NULL AND continuation_id IS NULL AND return_gate_id IS NULL)
      OR (kind = 'feedback_request' AND source_gate_id IS NULL AND feedback_round_id IS NOT NULL AND feedback_target_node_id IS NOT NULL AND continuation_id IS NULL AND return_gate_id IS NULL)
      OR (kind = 'feedback_resume' AND source_gate_id IS NULL AND feedback_round_id IS NOT NULL AND feedback_target_node_id IS NULL AND continuation_id IS NULL AND return_gate_id IS NULL)
      OR (kind = 'child_return' AND source_gate_id IS NULL AND feedback_round_id IS NULL AND continuation_id IS NOT NULL AND return_gate_id IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id, run_id, node_id)
      REFERENCES workflow_nodes(workspace_id, run_id, node_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, primary_turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, execution_turn_id)
      REFERENCES turns(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, message_id)
      REFERENCES messages(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_return_gates (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    return_gate_id TEXT NOT NULL,
    continuation_run_id TEXT NOT NULL,
    continuation_id TEXT NOT NULL,
    caller_task_id TEXT NOT NULL,
    caller_turn_id TEXT NOT NULL,
    caller_run_id TEXT,
    caller_node_id TEXT,
    child_run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'satisfied', 'consumed', 'failed', 'cancelled')),
    result_run_id TEXT,
    result_artifact_id TEXT,
    result_artifact_revision INTEGER,
    return_activation_run_id TEXT,
    return_activation_id TEXT,
    return_message_id TEXT,
    execution_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, return_gate_id),
    UNIQUE (workspace_id, continuation_run_id, continuation_id),
    CHECK ((caller_run_id IS NULL AND caller_node_id IS NULL) OR (caller_run_id IS NOT NULL AND caller_node_id IS NOT NULL)),
    CHECK ((result_run_id IS NULL AND result_artifact_id IS NULL AND result_artifact_revision IS NULL) OR (result_run_id IS NOT NULL AND result_artifact_id IS NOT NULL AND result_artifact_revision IS NOT NULL)),
    CHECK ((return_activation_run_id IS NULL AND return_activation_id IS NULL) OR (return_activation_run_id IS NOT NULL AND return_activation_id IS NOT NULL)),
    FOREIGN KEY (workspace_id, continuation_run_id, continuation_id)
      REFERENCES workflow_continuations(workspace_id, run_id, continuation_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, caller_task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, caller_turn_id, caller_task_id)
      REFERENCES turns(workspace_id, id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, caller_run_id, caller_node_id)
      REFERENCES workflow_nodes(workspace_id, run_id, node_id),
    FOREIGN KEY (workspace_id, child_run_id)
      REFERENCES workflow_runs(workspace_id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, result_run_id, result_artifact_id, result_artifact_revision)
      REFERENCES workflow_artifacts(workspace_id, run_id, artifact_id, revision),
    FOREIGN KEY (workspace_id, return_activation_run_id, return_activation_id)
      REFERENCES workflow_activations(workspace_id, run_id, activation_id),
    FOREIGN KEY (workspace_id, return_message_id)
      REFERENCES messages(workspace_id, id),
    FOREIGN KEY (workspace_id, execution_turn_id)
      REFERENCES turns(workspace_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS workflow_artifact_sources (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL CHECK (artifact_revision >= 1),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('workflow_node', 'caller_turn', 'engine_start')),
    producer_run_id TEXT,
    producer_node_id TEXT,
    producer_task_id TEXT,
    producing_turn_id TEXT,
    producing_activation_id TEXT,
    caller_task_id TEXT,
    caller_turn_id TEXT,
    engine_start_operation_key TEXT,
    PRIMARY KEY (workspace_id, run_id, artifact_id, artifact_revision),
    CHECK (
      (source_kind = 'workflow_node' AND producer_run_id IS NOT NULL AND producer_node_id IS NOT NULL AND producer_task_id IS NOT NULL AND producing_turn_id IS NOT NULL AND producing_activation_id IS NOT NULL AND caller_task_id IS NULL AND caller_turn_id IS NULL AND engine_start_operation_key IS NULL)
      OR (source_kind = 'caller_turn' AND producer_run_id IS NULL AND producer_node_id IS NULL AND producer_task_id IS NULL AND producing_turn_id IS NULL AND producing_activation_id IS NULL AND caller_task_id IS NOT NULL AND caller_turn_id IS NOT NULL AND engine_start_operation_key IS NULL)
      OR (source_kind = 'engine_start' AND producer_run_id IS NULL AND producer_node_id IS NULL AND producer_task_id IS NULL AND producing_turn_id IS NULL AND producing_activation_id IS NULL AND caller_task_id IS NULL AND caller_turn_id IS NULL AND engine_start_operation_key IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id, run_id, artifact_id, artifact_revision)
      REFERENCES workflow_artifacts(workspace_id, run_id, artifact_id, revision) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, producer_run_id, producer_node_id)
      REFERENCES workflow_nodes(workspace_id, run_id, node_id),
    FOREIGN KEY (workspace_id, producer_task_id)
      REFERENCES tasks(workspace_id, id),
    FOREIGN KEY (workspace_id, producing_turn_id, producer_task_id)
      REFERENCES turns(workspace_id, id, task_id),
    FOREIGN KEY (workspace_id, producer_run_id, producing_activation_id)
      REFERENCES workflow_activations(workspace_id, run_id, activation_id),
    FOREIGN KEY (workspace_id, caller_task_id)
      REFERENCES tasks(workspace_id, id),
    FOREIGN KEY (workspace_id, caller_turn_id, caller_task_id)
      REFERENCES turns(workspace_id, id, task_id),
    FOREIGN KEY (workspace_id, engine_start_operation_key)
      REFERENCES operations(workspace_id, ledger_key)
  )`,

  `CREATE TABLE IF NOT EXISTS session_owners (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    backend TEXT NOT NULL,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    first_bound_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, backend, session_id),
    UNIQUE (workspace_id, backend, session_id, task_id),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS task_session_bindings (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 0),
    backend TEXT NOT NULL,
    session_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    bound_at TEXT NOT NULL,
    cleared_at TEXT,
    PRIMARY KEY (workspace_id, task_id, runtime_epoch),
    CHECK ((active = 1 AND cleared_at IS NULL) OR active = 0),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, backend, session_id, task_id)
      REFERENCES session_owners(workspace_id, backend, session_id, task_id)
  )`,

  `CREATE TRIGGER IF NOT EXISTS trg_task_session_binding_immutable
     BEFORE UPDATE OF task_id, runtime_epoch, backend, session_id ON task_session_bindings
     WHEN OLD.task_id <> NEW.task_id
       OR OLD.runtime_epoch <> NEW.runtime_epoch
       OR OLD.backend <> NEW.backend
       OR OLD.session_id <> NEW.session_id
     BEGIN
       SELECT RAISE(ABORT, 'session_binding_immutable');
     END`,

  `CREATE TABLE IF NOT EXISTS turn_disposition_claims (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 0),
    op_id TEXT NOT NULL,
    family TEXT NOT NULL CHECK (family IN ('ordinary', 'workflow')),
    kind TEXT NOT NULL CHECK (kind IN ('complete', 'fail', 'wait', 'idle', 'next', 'prev', 'workflow_fail')),
    fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('staged', 'consumed', 'discarded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, turn_id),
    FOREIGN KEY (workspace_id, turn_id, task_id)
      REFERENCES turns(workspace_id, id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_turns_workspace_id_task
     ON turns(workspace_id, id, task_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_nodes_task_owner
     ON workflow_nodes(workspace_id, task_id) WHERE task_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_gate_fills_input
     ON workflow_gate_fills(workspace_id, run_id, gate_id, input_ref)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_task_session_bindings_active_task
     ON task_session_bindings(workspace_id, task_id) WHERE active = 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_task_session_bindings_active_session
     ON task_session_bindings(workspace_id, backend, session_id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_activations_status
     ON workflow_activations(workspace_id, run_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_return_gates_status
     ON workflow_return_gates(workspace_id, child_run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_deadline_scan
     ON workflow_runs(workspace_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_disposition_claims_status
     ON turn_disposition_claims(workspace_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_task_session_bindings_session
     ON task_session_bindings(workspace_id, backend, session_id, active)`,
];

/**
 * Section 20 conformance columns and integrity guards.
 */
const WORKFLOW_CONFORMANCE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_artifact_lineage
     ON workflow_artifacts(workspace_id, artifact_id, revision)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_feedback_target_id
     ON workflow_feedback_targets(workspace_id, run_id, target_id)
     WHERE target_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_continuation_invocation
     ON workflow_continuations(workspace_id, caller_task_id, invocation_key)
     WHERE caller_task_id IS NOT NULL AND invocation_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_run_continuation
     ON workflow_runs(workspace_id, continuation_id)
     WHERE continuation_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_deadline_at
     ON workflow_runs(workspace_id, status, deadline_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent
     ON workflow_runs(workspace_id, parent_run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_feedback_requester
     ON workflow_feedback_rounds(workspace_id, requester_task_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_continuation_caller
     ON workflow_continuations(workspace_id, caller_task_id, status)`,

  `CREATE TRIGGER IF NOT EXISTS trg_workflow_definition_scope_insert
     BEFORE INSERT ON workflow_definitions
     WHEN (NEW.scope_kind = 'root' AND (
             NEW.owner_root_task_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM tasks owner
                WHERE owner.workspace_id = NEW.workspace_id
                  AND owner.id = NEW.owner_root_task_id
                  AND owner.parent_id IS NULL
             )
           ))
       OR (NEW.scope_kind = 'workspace' AND NEW.owner_root_task_id IS NOT NULL)
     BEGIN
       SELECT RAISE(ABORT, 'workflow_definition_scope_invalid');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_definition_semantics_immutable
     BEFORE UPDATE OF scope_kind, owner_root_task_id, fingerprint, policy_json,
                      topology_json, entry_node_id ON workflow_definitions
     WHEN OLD.scope_kind <> NEW.scope_kind
       OR OLD.owner_root_task_id IS NOT NEW.owner_root_task_id
       OR OLD.fingerprint <> NEW.fingerprint
       OR OLD.policy_json <> NEW.policy_json
       OR OLD.topology_json <> NEW.topology_json
       OR OLD.entry_node_id <> NEW.entry_node_id
     BEGIN
       SELECT RAISE(ABORT, 'workflow_definition_immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_run_authority_insert
     BEFORE INSERT ON workflow_runs
     WHEN (NEW.owner_root_task_id IS NULL) <> (NEW.caller_task_id IS NULL)
       OR (NEW.caller_task_id IS NULL) <> (NEW.caller_turn_id IS NULL)
       OR (NEW.owner_root_task_id IS NOT NULL AND NOT EXISTS (
             SELECT 1
               FROM tasks caller
               JOIN turns caller_turn
                 ON caller_turn.workspace_id = caller.workspace_id
                AND caller_turn.task_id = caller.id
                AND caller_turn.id = NEW.caller_turn_id
              WHERE caller.workspace_id = NEW.workspace_id
                AND caller.id = NEW.caller_task_id
                AND EXISTS (
                  WITH RECURSIVE ancestry(id, parent_id) AS (
                    SELECT id, parent_id FROM tasks
                     WHERE workspace_id = NEW.workspace_id AND id = caller.id
                    UNION ALL
                    SELECT parent.id, parent.parent_id FROM tasks parent
                    JOIN ancestry child ON child.parent_id = parent.id
                     WHERE parent.workspace_id = NEW.workspace_id
                  )
                  SELECT 1 FROM ancestry
                   WHERE id = NEW.owner_root_task_id AND parent_id IS NULL
                )
           ))
     BEGIN
       SELECT RAISE(ABORT, 'workflow_run_authority_invalid');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_gate_fill_authority
     BEFORE INSERT ON workflow_gate_fills
     WHEN NOT EXISTS (
       SELECT 1
         FROM workflow_gate_bindings binding
         JOIN workflow_artifacts artifact
           ON artifact.workspace_id = binding.workspace_id
          AND artifact.run_id = COALESCE(NEW.artifact_run_id, NEW.run_id)
          AND artifact.artifact_id = NEW.artifact_id
          AND artifact.revision = NEW.artifact_revision
          AND artifact.kind = binding.required_kind
         JOIN workflow_artifact_sources source
           ON source.workspace_id = artifact.workspace_id
          AND source.run_id = artifact.run_id
          AND source.artifact_id = artifact.artifact_id
          AND source.artifact_revision = artifact.revision
        WHERE binding.workspace_id = NEW.workspace_id
          AND binding.run_id = NEW.run_id
          AND binding.gate_id = NEW.gate_id
          AND binding.input_ref = NEW.input_ref
          AND (
            binding.producer_node_id IS NULL
            OR (
              source.source_kind = 'workflow_node'
              AND artifact.producer_node_id = binding.producer_node_id
              AND source.producer_node_id = binding.producer_node_id
            )
          )
     )
     BEGIN
       SELECT RAISE(ABORT, 'workflow_gate_fill_invalid');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_artifact_source_authority
     BEFORE INSERT ON workflow_artifact_sources
     WHEN (
       NEW.source_kind = 'workflow_node' AND NOT EXISTS (
         SELECT 1
           FROM workflow_nodes node
           JOIN turns producing_turn
             ON producing_turn.workspace_id = node.workspace_id
            AND producing_turn.task_id = node.task_id
            AND producing_turn.id = NEW.producing_turn_id
           JOIN workflow_activations activation
             ON activation.workspace_id = node.workspace_id
            AND activation.run_id = node.run_id
            AND activation.node_id = node.node_id
            AND activation.activation_id = NEW.producing_activation_id
            AND activation.execution_turn_id = producing_turn.id
          WHERE node.workspace_id = NEW.workspace_id
            AND node.run_id = NEW.producer_run_id
            AND node.node_id = NEW.producer_node_id
            AND node.task_id = NEW.producer_task_id
       )
     ) OR (
       NEW.source_kind = 'caller_turn' AND NOT EXISTS (
         SELECT 1 FROM workflow_runs run
          WHERE run.workspace_id = NEW.workspace_id
            AND run.run_id = NEW.run_id
            AND run.caller_task_id = NEW.caller_task_id
            AND run.caller_turn_id = NEW.caller_turn_id
       )
     )
     BEGIN
       SELECT RAISE(ABORT, 'workflow_artifact_source_invalid');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_artifact_immutable
     BEFORE UPDATE ON workflow_artifacts
     BEGIN
       SELECT RAISE(ABORT, 'workflow_artifact_immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_artifact_source_immutable
     BEFORE UPDATE ON workflow_artifact_sources
     BEGIN
       SELECT RAISE(ABORT, 'workflow_artifact_source_immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_gate_fill_immutable
     BEFORE UPDATE ON workflow_gate_fills
     BEGIN
       SELECT RAISE(ABORT, 'workflow_gate_fill_immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_workflow_terminal_run_no_queued_activation
     BEFORE UPDATE OF status ON workflow_runs
     WHEN NEW.status IN ('succeeded', 'failed', 'cancelled')
      AND EXISTS (
        SELECT 1 FROM workflow_activations activation
         JOIN turns turn
           ON turn.workspace_id = activation.workspace_id
          AND turn.id = activation.execution_turn_id
        WHERE activation.workspace_id = NEW.workspace_id
          AND activation.run_id = NEW.run_id
          AND activation.status IN ('queued', 'running')
          AND turn.status IN ('queued', 'running', 'waiting_user')
      )
     BEGIN
       SELECT RAISE(ABORT, 'workflow_terminal_run_has_live_activation');
     END`,
];

const CURRENT_SCHEMA_WRITER_GUARD_STATEMENTS: readonly string[] =
  writerGuardTriggerStatements(REQUIRED_SCHEMA_TABLES, SQLITE_SCHEMA_VERSION);

/**
 * The only supported schema manifest. This branch intentionally has no migration
 * compatibility: an older development store must be reset explicitly.
 */
export const CURRENT_SCHEMA_STATEMENTS: readonly string[] = [
  ...CORE_SCHEMA_STATEMENTS,
  ...WORKFLOW_SCHEMA_STATEMENTS,
  ...WORKFLOW_AUTHORITY_SCHEMA_STATEMENTS,
  ...WORKFLOW_CONFORMANCE_SCHEMA_STATEMENTS,
  ...CURRENT_SCHEMA_WRITER_GUARD_STATEMENTS,
];
