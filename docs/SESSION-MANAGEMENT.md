# Session Management (MVP)

> **Scope:** Backend identity and resume behavior in this document applies to both
> flows. Sections describing one flat session per backend document the current
> legacy chat-only implementation. In the task-based flow, each task owns its
> session and `TASK-MANAGEMENT.md` is authoritative for storage, concurrency, turn
> recovery, and continuation semantics.

## Core Principle
We do **not** keep agent processes alive.
Each turn is a fresh process.
The **CLI itself** manages conversation history on disk using session IDs.

The plugin only needs to:
- Remember the **explicit session ID** from previous turns.
- Pass that ID correctly when continuing.
- Let the CLI load its own history.

## Session identity per backend

Who creates the ID, and how the coordinator learns it (flags verified in CLI-COMMANDS.md):

| Backend | New session | How we learn the ID | Resume |
|---------|-------------|---------------------|--------|
| Claude | **Muster pre-generates UUID** → `--session-id <uuid>` | Known upfront; also confirmed by the `init` system event in `stream-json` | `--resume <id>` |
| Grok | **Muster pre-generates UUID** → `--session-id <uuid>` (must be a fresh UUID) | Known upfront | `--resume <id>` |
| Codex | CLI generates a thread ID | `{"type":"thread.started","thread_id":...}` in `--json` output | `codex exec resume <id> "prompt"` |
| Antigravity | Unclear — **verify** whether `--conversation <id>` accepts a client-chosen ID on first turn | TBD (plain-text output, no structured event) | `--conversation <id>` |

**Rule of thumb: prefer pre-generated IDs wherever the CLI supports them** (Claude, Grok). The coordinator owns conversation identity from turn one and never depends on fragile output parsing. Extraction is then only needed for Codex (easy — one JSONL event) and Antigravity (hard — treat as experimental).

## Explicit Session ID vs "Continue Last"

**Do not** rely on `--continue` / `--last` as the main mechanism inside the plugin.

Reasons:
- Multiple conversations can exist in the same workspace.
- The plugin may want to let the user switch between different threads.
- "Most recent" is ambiguous if the user has multiple VS Code windows or runs the CLI manually in the same workspace.

**Rule for MVP:** always pass an explicit session ID when resuming, using the CLI's resume flag.

## Storage (current legacy chat flow)

### Current implementation: JSON file in workspace
- File: `.muster-sessions.json` in the workspace root — implemented in `src/session-store.ts` (`getSessionId` / `saveSessionId`).
- Flat structure, one active session per backend per workspace:
```json
{
  "claude": "session-uuid-123",
  "grok": "grok-session-456"
}
```
- **Add it to `.gitignore`** — session IDs are machine-local state, not project content.
- Write atomically (tmp file + rename) to prevent partial files — see the
  `atomicWrite` pattern in the reference runners (`CLI-COMMANDS.md` → reference
  implementations). Atomic replacement does not prevent lost updates between VS
  Code windows; supporting that requires a single writer, lock, or compare-and-swap
  revision.

### Legacy alternative: VS Code `workspaceState`
Easier persistence across restarts, harder to inspect manually. Migrate once the JSON file has proven the flow; keep the flat schema so migration is trivial.

Do not expand this flat file into a task store. The task flow replaces it with the
versioned task/turn store defined in `TASK-MANAGEMENT.md`.

## Storage (target task flow)

- `MusterTask.committedSessionId` is the only committed session binding.
- Candidate/observed IDs for a running invocation live on its `TaskTurn`.
- Session IDs are never shared across tasks.
- The task store commits the ID only after adapter `turnCompleted`.
- A failed/interrupted turn retains diagnostic candidate IDs but does not replace
  the committed task binding.

## Turn lifecycle & ID update rules (legacy flow)

1. User sends a message for backend B.
2. Look up stored `sessionId` for B.
3. Build `RunOptions`:
   - Stored ID exists → set `resumeId`.
   - No stored ID → new session. For Claude/Grok, pre-generate a UUID and pass it via the backend's new-session flag; that UUID is the candidate ID.
4. Spawn the fresh CLI process; stream normalized events.
5. During the turn: if `sessionStarted` carries a `sessionId`, that value is authoritative (may confirm the pre-generated one, or supply Codex's thread ID).
6. On terminal event:
   - **`turnCompleted`** → commit the ID to the store. Fallback chain if no ID was observed: `sessionStarted.sessionId` → `extractSessionId(rawOutput, lastUsedId)` → the ID we passed in (see ADAPTER-SPEC.md).
   - **`error` (including cancellation)** → do **not** commit a new ID; keep the previous stored value. (With pre-generated IDs the CLI may still have created partial history under the new ID — acceptable for MVP; the next send simply starts fresh or resumes the old ID.)

**Legacy concurrency rule:** at most one in-flight turn per backend per workspace,
because the flat flow has only one current session for that backend.

**Task-flow correctness rule:** at most one active turn per task/session. Different
task sessions may run concurrently subject to verified backend and global scheduler
limits. Never run two processes against the same session ID.

## New Session (legacy flow)

- User clicks "New Session" or switches backend → clear the stored `sessionId` for that backend.
- Next send starts without a resume flag → fresh conversation (with a fresh pre-generated UUID where supported).
- **Forking** (post-MVP): Claude and Grok support `--fork-session` when resuming — branch a new session ID from existing history instead of appending. Useful for a "duplicate conversation" UI action later.

## Cancellation

If the user cancels mid-turn:
- Abort via `RunOptions.signal`; the adapter kills the child (and process tree) and yields `{ type: 'error', isCancellation: true }` (see ADAPTER-SPEC.md).
- Do **not** update the stored session ID.
- The CLI may have persisted partial state — acceptable for MVP.

## Migration

- Keep `.muster-sessions.json` only while the chat-only path remains available.
- Do not add multiple-session metadata to that flat schema.
- Once task flow is the default, migrate or archive the current IDs and remove the
  legacy store.
- Implement conversation continuation as a new task with a fresh or explicitly
  forked session; never share one session ID between tasks.

For the current legacy UI: **one active session ID per backend per workspace,
committed only after a successful turn.**
