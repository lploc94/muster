# Session Management (MVP)

> **Scope:** Backend identity and resume behavior in this document applies to the
> **task-based flow** (the sole shipping path). The legacy flat chat flow and
> `.muster-sessions.json` were retired in Phase E — existing files are archived on
> activation. `TASK-MANAGEMENT.md` is authoritative for storage, concurrency, turn
> recovery, and continuation semantics.

## Core Principle
We do **not** keep ACP sessions alive across unrelated turns.
Each turn is one adapter `run()` = one **ACP session** (`session/new` or `session/load`) on the backend's shared agent stdio connection.

The **agent** manages conversation history on disk using `sessionId` values returned by `session/new`.

The plugin only needs to:
- Remember the **explicit session ID** from previous turns.
- Pass that ID correctly when continuing.
- Let the CLI load its own history.

## Session identity per backend

Who creates the ID, and how the coordinator learns it (flags verified in CLI-COMMANDS.md):

| Backend | New session | How we learn the ID | Resume |
|---------|-------------|---------------------|--------|
| All (ACP) | `session/new { cwd, mcpServers }` | `sessionStarted` from `session/new` response (emit immediately) | `session/load { sessionId, cwd, mcpServers }` |

**Rule of thumb:** session IDs are **server-assigned** via `session/new`. The coordinator stores the ID after a successful turn and passes it as `resumeId` on continue. Do not parse stdout for IDs (legacy headless paths).

## Explicit Session ID vs "Continue Last"

**Do not** rely on `--continue` / `--last` as the main mechanism inside the plugin.

Reasons:
- Multiple conversations can exist in the same workspace.
- The plugin may want to let the user switch between different threads.
- "Most recent" is ambiguous if the user has multiple VS Code windows or runs the CLI manually in the same workspace.

**Rule for MVP:** always pass an explicit session ID when resuming, using the CLI's resume flag.

## Storage (retired legacy chat flow)

### `.muster-sessions.json` — archived, not used

The flat per-backend session file is **retired**. On extension activation, if
`.muster-sessions.json` exists in the workspace root it is **archived** by atomic
rename to `.muster-sessions.json.migrated` (or `.muster-sessions.json.corrupt` if
unparseable). A one-time notice is shown; there is **no** session-import path.

The authoritative store is `.muster-tasks.json` (versioned `TaskStoreFile`). Per-task
`committedSessionId` replaces the flat `{ backend: sessionId }` map.

## Storage (target task flow)

- `MusterTask.committedSessionId` is the only committed session binding.
- Candidate/observed IDs for a running invocation live on its `TaskTurn`.
- Session IDs are never shared across tasks.
- The task store commits the ID only after adapter `turnCompleted`.
- A failed/interrupted turn retains diagnostic candidate IDs but does not replace
  the committed task binding.

## Turn lifecycle & ID update rules (task flow)

1. User sends a message on a task (or starts a new root task).
2. `TaskEngine` reads `MusterTask.committedSessionId` for resume.
3. Build `RunOptions`:
   - Committed ID exists → set `resumeId`.
   - No committed ID → ACP `session/new` and capture the server-assigned `sessionId`.
4. Drive `session/prompt`; stream `session/update` → normalized events.
5. During the turn: candidate IDs live on `TaskTurn`; `sessionStarted` is authoritative.
6. On terminal event:
   - **`turnCompleted`** → commit the ID to `MusterTask.committedSessionId` (see `TASK-MANAGEMENT.md` §10).
   - **`error` / interrupt** → do **not** replace the committed binding.

**Task-flow correctness rule:** at most one active turn per task/session. Different
task sessions may run concurrently subject to verified backend and global scheduler
limits. Never run two processes against the same session ID.

## New task (replaces New Session)

- User clicks **New task** → unpersisted composer; first `send` calls `startNewTask`.
- **Continue as new task** on a terminal task creates a new root coordinator with
  `continuationOf` set — UI grouping only, never reopens the old task.

## Cancellation

If the user cancels mid-turn:
- Abort via `RunOptions.signal`; adapter sends ACP `session/cancel` and yields `{ type: 'error', isCancellation: true }` (see ADAPTER-SPEC.md).
- Do **not** update the stored session ID.
- The CLI may have persisted partial state — acceptable for MVP.

## Migration (Phase E — complete)

- Legacy `.muster-sessions.json` is **archive-only** on activation (`src/task/migration-sessions.ts`).
- Marker: `muster.sessionMigration.v1` in `workspaceState` (idempotent).
- No adopt/import of legacy session IDs — start new tasks instead.
