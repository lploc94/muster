/**
 * SQLite schema v1 for the global Muster store (sqlite-global-storage-refactor §4).
 *
 * Identity model: every domain entity uses composite identity
 * `(workspace_id, entity_id)` and all foreign keys are composite. This is a hard
 * requirement (plan §4): `TaskEngine.createTask` lets callers supply a task id, so
 * ids are NOT globally unique across the legacy JSON stores that get imported.
 *
 * A field has ONE source of truth: a column promoted out of the payload must not be
 * duplicated inside `payload_json`. Query/state keys are columns; low-query payload
 * is versioned JSON text validated by a codec (added in Phase 3).
 */

/** Muster's private SQLite `application_id` (verified before reading schema, plan §3.4). */
export const MUSTER_APPLICATION_ID = 0x4d555354; // 'MUST'

/** Current schema version, tracked via `PRAGMA user_version`. */
export const SQLITE_SCHEMA_VERSION = 1;

/**
 * Ordered DDL statements for schema v1. Applied inside a single exclusive
 * migration transaction (see {@link migrateToLatest}). Every statement is
 * idempotent via `IF NOT EXISTS` so a process that loses the migration race and
 * re-enters after version verification is a no-op rather than a hard failure.
 */
export const SCHEMA_V1_STATEMENTS: readonly string[] = [
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
    release_state TEXT,
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

  // Parity tables for TaskStoreFile: operations ledger, cancel requests, send
  // receipts. Each keeps composite identity + FK to the owning workspace/task so
  // idempotency and scheduler decisions stay queryable (plan §4 handoff rule).
  `CREATE TABLE IF NOT EXISTS operations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    ledger_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, ledger_key)
  )`,

  `CREATE TABLE IF NOT EXISTS cancel_requests (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    op_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, task_id),
    FOREIGN KEY (workspace_id, task_id)
      REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
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

  // Migration bookkeeping (plan §7): per-workspace import state machine.
  `CREATE TABLE IF NOT EXISTS migration_state (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    source_digest TEXT,
    source_path TEXT,
    updated_at TEXT NOT NULL,
    detail TEXT
  )`,

  // Minimum indexes (plan §4).
  `CREATE INDEX IF NOT EXISTS idx_tasks_workspace_parent ON tasks(workspace_id, parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_workspace_lifecycle ON tasks(workspace_id, lifecycle, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_task_sequence ON turns(workspace_id, task_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_workspace_status ON turns(workspace_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_task_created ON messages(workspace_id, task_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(workspace_id, turn_id, ordering)`,
  `CREATE INDEX IF NOT EXISTS idx_reasoning_turn_order ON reasoning_segments(workspace_id, turn_id, ordering)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_order ON tool_calls(workspace_id, turn_id, ordering)`,
];
