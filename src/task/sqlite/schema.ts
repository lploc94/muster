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

/** Current schema version, tracked via `PRAGMA user_version`. */
export const SQLITE_SCHEMA_VERSION = 7;

/**
 * Production change-feed retention bound (revisions kept after the low watermark).
 * Tests may inject a smaller bound via repository options; production does not
 * depend on test-only global state.
 */
export const CHANGE_FEED_RETAIN_REVISIONS = 4096;

/**
 * Current DDL applied only to a fresh database inside one exclusive transaction.
 * Existing databases with another user_version are rejected and must be reset;
 * Muster does not carry data-upgrade migrations during development.
 */
export const CURRENT_SCHEMA_STATEMENTS: readonly string[] = [
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
