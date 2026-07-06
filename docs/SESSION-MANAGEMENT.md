# Session Management (MVP)

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

## Storage (MVP)

### Option 1 (current implementation): JSON file in workspace
- File: `.muster-sessions.json` in the workspace root — implemented in `src/session-store.ts` (`getSessionId` / `saveSessionId`).
- Flat structure, one active session per backend per workspace:
```json
{
  "claude": "session-uuid-123",
  "grok": "grok-session-456"
}
```
- **Add it to `.gitignore`** — session IDs are machine-local state, not project content.
- Write atomically (tmp file + rename) to survive concurrent turns/windows — see the `atomicWrite` pattern in the reference runners (CLI-COMMANDS.md → Reference implementations).

### Option 2 (later): VS Code `workspaceState`
Easier persistence across restarts, harder to inspect manually. Migrate once the JSON file has proven the flow; keep the flat schema so migration is trivial.

Richer metadata (names, timestamps, multiple sessions per backend) is a post-MVP schema change — don't add it to the file until the UI needs it.

## Turn lifecycle & ID update rules

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

**Concurrency rule:** at most **one in-flight turn per backend per workspace**. Queue or reject sends while a turn is running — two processes resuming the same session concurrently corrupts or forks history unpredictably (the reference runners gate on this too: "poll before resume").

## New Session

- User clicks "New Session" or switches backend → clear the stored `sessionId` for that backend.
- Next send starts without a resume flag → fresh conversation (with a fresh pre-generated UUID where supported).
- **Forking** (post-MVP): Claude and Grok support `--fork-session` when resuming — branch a new session ID from existing history instead of appending. Useful for a "duplicate conversation" UI action later.

## Cancellation

If the user cancels mid-turn:
- Abort via `RunOptions.signal`; the adapter kills the child (and process tree) and yields `{ type: 'error', isCancellation: true }` (see ADAPTER-SPEC.md).
- Do **not** update the stored session ID.
- The CLI may have persisted partial state — acceptable for MVP.

## Future Improvements (post MVP)

- Multiple named sessions per backend (schema: `{ backend: [{ id, name, updatedAt }] }`).
- Session list UI with names/timestamps; fork via `--fork-session`.
- Persist session metadata (last prompt, model used, etc.).
- Move storage to `workspaceState` once the flow is stable.

For now: **one active session ID per backend per workspace, committed only after a successful turn.**
