# Task Model and UI State Audit

**Status:** current-state audit for M003/S01/T01.  
**Purpose:** give downstream runtime-state work a source-backed baseline for the task domain model, host snapshot/protocol projection, and webview task UI state.  
**Confidence labels:** `[High confidence]` means the claim is directly implemented in referenced source; `[Medium confidence]` means the source supports the claim but behavior still depends on host/runtime wiring; `[Low confidence]` means the claim is a proof boundary or unverified runtime assumption.

## Source Map

| Area | Current source | Audit role |
|---|---|---|
| Domain design | `docs/TASK-MANAGEMENT.md`, `docs/TASK-MODEL-IMPL-PLAN.md` | Establishes intended task/turn/message semantics and implementation sequencing. |
| Task records | `src/task/types.ts` | Defines persisted task, turn, message, operation, cancellation, and store-envelope shapes. |
| Derived status | `src/task/derived-status.ts` | Computes UI-facing `TaskViewStatus` from lifecycle, turns, dependencies, and waits. |
| Store | `src/task/store.ts` | Owns JSON persistence, schema migration, locking, atomic commit, indexes, and commit notifications. |
| Engine | `src/task/engine.ts` | Owns task/turn/message transitions, scheduler, adapter event consumption, AskBridge routing, retries, reload reconciliation, and emitted host events. |
| Host projection | `src/host/snapshot.ts` | Projects store records into root task lists, focused subtree summaries, transcripts, active turn identity, and pending-ask overlay. |
| Extension host | `src/extension.ts` | Wires VS Code webview messages, `TaskStore`, `TaskEngine`, bridge server, store watcher, retention, and protocol posts. |
| Webview protocol | `webview/src/lib/protocol.ts` | Defines v2 extension/webview message types and runtime guards. |
| Webview task state | `webview/src/lib/tasks.svelte.ts` | Stores root/subtree summaries, focus, draft/continuation composer state, revision watermarks, backend selection, and command errors. |
| Webview thread state | `webview/src/lib/thread.svelte.ts` | Stores per-task transcript rendering, streaming assistant text, active turn, running/read-only state, and late-event guards. |
| Webview UI | `webview/src/App.svelte`, `webview/src/components/TaskList.svelte`, `webview/src/components/TaskWorkspace.svelte`, `webview/src/components/Composer.svelte` | Routes incoming protocol messages and renders task list, focused workspace, ask/recovery/resume controls, terminal continuation, and composer behavior. |

## Current Domain Model

[High confidence] The persisted task model is split across `MusterTask`, `TaskTurn`, and `TaskMessage` in `src/task/types.ts`. Tasks store lifecycle, role, parent/dependency graph fields, waits, backend binding, committed session, host-issued capabilities, execution policy, result/error, revision, and timestamps. Turns store a per-invocation sequence, trigger, retry link, status, inputs, candidate/observed session IDs, staged disposition, error/cancellation flags, and timestamps. Messages store role, content, delivery state, creation time, and optional turn assignment.

[High confidence] The store envelope is versioned as `TaskStoreFile` with `schemaVersion`, `revision`, `tasks`, `turns`, `messages`, and schema-2 coordination fields `operations` and `cancelRequests` in `src/task/types.ts`. `src/task/store.ts` currently sets `CURRENT_SCHEMA_VERSION = 2` and migrates schema 1 by adding operation and cancel-request maps.

[High confidence] UI status is not persisted. `src/task/derived-status.ts` derives status in this order: terminal task lifecycle; live turn (`running` or `waiting_user`); unsatisfied dependency (`waiting_dependencies`); queued turn (`queued`); children wait (`waiting_children`); external wait (`blocked`); latest failed/interrupted turn with no queued/live replacement (`needs_recovery`); otherwise `idle`.

[High confidence] `docs/TASK-MANAGEMENT.md` remains the normative design contract: turn success is not task success, task completion is explicit through dispositions or policy, terminal task outcomes are immutable, readiness is derived, and reload must not silently replay uncertain work. The current source implements these concepts through the separate task/turn/message records, staged dispositions, explicit continuation/retry APIs, and reload reconciliation.

[Medium confidence] `docs/TASK-MODEL-IMPL-PLAN.md` is historical planning context rather than current implementation state. It describes task UI and bridge work as future phases, but current source already contains `TaskEngine`, bridge wiring, snapshot projection, and Svelte task UI. Downstream work should treat source files as authoritative when plan text says a capability is not yet implemented.

## Store and Runtime State

[High confidence] `TaskStore.load` in `src/task/store.ts` reads or creates a versioned JSON envelope, preserves corrupt files before surfacing parse failures, and rebuilds derived indexes for root ownership, child IDs, and view status. Store callers can query the in-memory file, reload from disk, retrieve tasks/turns/messages, and ask for derived root/child/status indexes.

[High confidence] `TaskStore.commit` serializes writes with a lock file, reads the freshest on-disk file while holding the lock, applies a caller reducer, increments revision, writes through a temp file plus rename, refreshes indexes, computes affected task IDs across task/turn/message changes, releases the lock, then invokes `onCommit` best-effort after the lock is released. This means the host projection surface should key UI updates off revision and affected task IDs rather than in-memory mutation assumptions.

[High confidence] `TaskEngine.load` creates an engine and immediately calls reload reconciliation. Reload reconciliation interrupts stale `running`/`waiting_user` turns whose lease owner is not alive, cancels AskBridge and credentials for those turns, reconciles child waits without scheduling, defers persisted queued turns, reconciles task timeouts, and processes cancel requests. Persisted queued turns are intentionally held in `deferredQueuedTurns` until explicit `resumeQueuedTurn`.

[High confidence] New root tasks are created through `TaskEngine.startNewTask`, which requires an MCP-capable backend, creates a root coordinator task, persists the first user message, queues the initial turn, and schedules it after the commit. Existing tasks can receive `send`, `continueTaskWithMessage`, `continueTask`, `startTask`, `retryTurn`, `cancelTask`, `interruptTurn`, `submitAskAnswer`, `cancelAskTurn`, and `resumeQueuedTurn` calls.

[High confidence] Before a queued turn starts, `executeTurn` acquires a lease, validates the turn/task are still schedulable, atomically assigns pending user messages to that turn, flips those messages to `assigned`, persists the updated `TurnInput`, and then emits `turnStart` after the persisted state transition. This aligns with `docs/TASK-MANAGEMENT.md` guidance that persisted turn/input identity must precede process spawning.

[High confidence] Adapter events drive both persisted records and live host events. Assistant deltas create or extend `partial` assistant messages; successful turn settlement marks the turn succeeded, commits session identity, applies staged disposition effects, and flips partial assistant messages to `complete`; error or missing terminal events settle the turn as failed or interrupted. `TaskEngine.safeEmit` forwards turn lifecycle and stream events best-effort to the extension host without making event emission a state dependency.

[Medium confidence] The current scheduler includes task timeout, turn timeout, lease acquisition, queued-turn promotion, concurrency/resource checks, child wait reconciliation, dependency terminal handling, operation ledger pruning, retry effects, and cancel-request polling. This audit did not execute live backend turns, so claims about real CLI timing and concurrent VS Code window behavior remain source-level, not runtime-proven.

## Host Snapshot and Protocol Projection

[High confidence] `src/host/snapshot.ts` is the host-webview projection boundary. It exposes `TaskSummary`, `TranscriptItem`, `TaskSnapshot`, `PendingAskOverlay`, and projection functions that derive summaries, root ordering, focused subtree, transcript, active turn, and pending ask from `TaskStore` plus an in-memory ask overlay.

[High confidence] `projectTaskSummary` combines persisted task fields with `deriveViewStatus` and `projectActivityTime`. Activity time is the max of task update time, turn created/started/finished timestamps, and task message creation timestamps. Root snapshots sort root tasks by descending activity time and then id, while focused subtrees are collected breadth-first and sorted by id before projection.

[High confidence] `buildTranscript` projects only user and assistant messages for the focused task, sorted by `createdAt` and then id. Tool and error transcript item kinds exist in the webview protocol, but the current host transcript builder does not synthesize them from persisted turns or events.

[High confidence] `activeTurnIdForTask` returns the latest queued/running/waiting-user turn by sequence. If there is no queued/live turn and derived status is `needs_recovery`, it returns the latest failed/interrupted turn by sequence so recovery controls can target a retryable turn.

[High confidence] `src/extension.ts` posts full snapshots on webview visibility, initial resolve, focus, and subtree hydration. It posts incremental `taskUpdated` messages after store commits, sends `askCleared` when a waiting-user turn leaves that state, and reposts a full snapshot for focused task transcript or active-turn changes.

[High confidence] Host-to-webview turn events use `taskId` plus `turnId`: `turnStart`, `event`, `turnDone`, `turnError`, `askPending`, and `askCleared`. Webview-to-host actions include `send`, `focusTask`, `hydrateSubtree`, `newTask`, `cancelTurn`, `submitAsk`, `cancelAsk`, `retryTurn`, `continueTask`, and `resumeQueuedTurn` in `webview/src/lib/protocol.ts`.

[Medium confidence] `src/extension.ts` has no visible compatibility adapter for the older flat single-chat `runId` protocol. The current active host path initializes `TaskStore`, `TaskEngine`, `AskBridge`, credential registry, and bridge server, then routes webview sends through task-engine APIs. If older documentation still says the flat path is live, that is likely stale for this checkout and should be revalidated before relying on a fallback UX.

## Webview State and Rendering

[High confidence] `webview/src/App.svelte` is the central message reducer for extension-host events. It applies snapshots to `tasks`, tracks `pendingAsk` and `activeTurnId`, focuses/hydrates the current thread, applies task patches, routes turn events to `threadStore`, appends optimistic or host-confirmed transcript items, clears asks, and surfaces `commandError`.

[High confidence] `webview/src/lib/tasks.svelte.ts` stores all known task summaries in a `Map`, derives root tasks from `parentId === null`, tracks focused task, focused subtree, store revision, per-task revision watermarks, draft mode, continuation source, selected backend, and command error. `applyTaskUpdated` rejects stale patches with `storeRevision <= watermark` for that task.

[High confidence] `webview/src/lib/thread.svelte.ts` stores one `TaskThread` per task. It hydrates transcript items, tracks streaming assistant deltas, active turn, running state, and read-only state. Turn-scoped event reducers ignore messages whose `taskId` is not currently focused or whose `turnId` is not the thread's active turn, which is the webview's current late-event guard.

[High confidence] `TaskList.svelte` renders root tasks and posts both `focusTask` and `hydrateSubtree` when a user selects a task. It also enters draft mode through `newTask`. `TaskWorkspace.svelte` renders the focused subtree, focused transcript, ask card, recovery controls for `needs_recovery`, resume controls for queued/waiting-dependency active turns, terminal `Continue as new task`, and the task composer.

[High confidence] `Composer.svelte` blocks ordinary send while the thread is running, read-only, or awaiting an ask. Draft sends include selected backend and optional `continuationOf`; task sends include `taskId`; cancel sends include `taskId` and `turnId`. Draft mode optimistically appends a local user transcript item before the host creates and snapshots the real task.

[Medium confidence] Webview guards are local to focused task state. Background task events can still update task summaries through `taskUpdated`, but streaming `event` content for non-focused tasks is ignored by `threadStore` until a later snapshot/hydration provides persisted transcript state.

## Runtime State Contract Baseline

[High confidence] The authoritative persisted facts are `TaskStoreFile.tasks`, `TaskStoreFile.turns`, and `TaskStoreFile.messages`; root lists, child lists, activity time, derived view status, focused subtree, transcript, active turn, pending ask, running state, and read-only state are projections.

[High confidence] The host owns mutation authority. The webview posts intent messages, and `src/extension.ts` validates required fields before calling `TaskEngine`. The engine validates task/turn existence, lifecycle, backend eligibility, waiting-user state, queued state, terminal state, resource limits, ownership through bridge credentials, and turn/task relationships before it mutates store state.

[High confidence] The webview's most important runtime-state reliability protections are store-revision watermarks for task patches, turn-id matching before streaming reducers apply events, read-only derivation from terminal status, and explicit recovery/resume actions instead of automatic replay.

[Medium confidence] Host projection currently mixes incremental patches and full snapshots. `reprojectChanged` posts patches for affected tasks and then snapshots the focused task when transcript or active-turn data changes. Downstream changes should preserve this split or replace it with a single ordered projection stream; otherwise stale summary patches and focused transcript snapshots can race in the webview.

[Low confidence] This audit is source-level only. It does not prove live VS Code webview activation, real backend process behavior, bridge credential expiry under wall-clock pressure, multi-window file watcher races, or Vite-rendered DOM behavior.

## Proof Boundaries and Drift Risks

- [High confidence] `docs/TASK-MANAGEMENT.md` and `src/task/types.ts` agree on the core vocabulary: task, turn, message, dependency, wait, disposition, lifecycle, and derived view status.
- [High confidence] `src/host/snapshot.ts` and `webview/src/lib/protocol.ts` agree on the snapshot fields and turn-scoped identity shape used by the current UI.
- [High confidence] `src/extension.ts` and `webview/src/lib/protocol.ts` agree on current command names for send, focus, hydration, cancellation, ask submit/cancel, retry, continue, and queued-turn resume.
- [Medium confidence] `webview/src/lib/protocol.ts` accepts transcript item kinds `tool` and `error`, while host snapshots currently project only `user` and `assistant`; live stream events can still render tools/errors while focused, but reload transcript reconstruction will not recreate tool/error UI from persisted data.
- [Medium confidence] `TaskStore.commit` notifies affected task IDs after releasing the lock, and `src/extension.ts` can make nested commits through retention. This avoids deadlock but means downstream projection code must tolerate a store revision advancing again during notification.
- [Low confidence] The current audit does not confirm whether package tests already pin root ordering, focused subtree projection, transcript projection, and active-turn selection. T03 is planned to add that focused Vitest coverage.

## Failure Modes

- Filesystem and store IO: `TaskStore.load` and `TaskStore.commit` depend on readable/writable JSON files, lock files, temp files, and rename semantics in `src/task/store.ts`. Corrupt store reads preserve a `.corrupt-*` copy and fail load/commit; lock acquisition can fail with `io_error`; write failures return `io_error` without updating in-memory state.
- Backend factory and subprocess streams: `TaskEngine.executeTurn` depends on `makeBackend` and `runTurnFn` in `src/task/engine.ts`. Backend factory failure settles the turn failed and emits `turnError`; adapter `error` events settle failed or interrupted; stream termination without a terminal event settles failed with `turn ended without terminal event`.
- Bridge, credentials, and asks: `src/extension.ts` starts `MusterBridgeServer`, `AskBridge`, and `CredentialRegistry`; initialization failure disables the task engine and shows an error. Ask submission/cancellation in `src/task/engine.ts` rejects missing pending asks or turns that are no longer waiting for user.
- Webview messaging: `src/extension.ts` wraps `postMessage` in best-effort helpers, so projection emission failure does not corrupt store state. `webview/src/lib/protocol.ts` rejects malformed extension messages through `isExtMessage`; `src/extension.ts` posts `commandError` for malformed or invalid user commands.
- Runtime reload uncertainty: `TaskEngine.load` reconciles stale running/waiting-user turns to interrupted, revokes/cancels transient resources, defers queued turns, and avoids silent replay. This explicitly bubbles uncertainty to UI recovery/resume actions instead of reusing a dead process.

## Load Profile

- First saturation point at 10x task volume is likely projection and diff cost, not model execution. `src/extension.ts` compares tasks, turns, and messages with repeated `JSON.stringify`, while `src/host/snapshot.ts` rebuilds root lists, focused subtrees, transcripts, and activity time from object scans. At 10x roots/messages, snapshot and change detection become O(tasks + turns + messages) per projection.
- Store write serialization is intentionally single-writer through `TaskStore.commit`; this protects correctness but is also a throughput boundary for concurrent turns, file watchers, retention commits, and external windows.
- Scheduler protections include resource limits, per-task turn caps, queued/live promotion checks, task/turn timeouts, deferred reload queues, and retention pruning. These prevent unbounded turn spawning but do not make snapshot projection incremental for large stores.
- Webview protections include per-task revision watermarks, focused-thread-only stream reducers, and snapshot hydration instead of holding every background transcript in active rendering state. Root task storage still keeps known summaries in memory.

## Negative Tests

- Existing or planned test surfaces are distributed across task/unit tests and the T03/T02 tasks for this slice. T01 did not add code tests, but the current source shows negative paths that should remain pinned.
- Store negative cases to protect: corrupt JSON preservation, stale/corrupt lock reclamation, lock timeout returning `io_error`, rejected reducers not writing, migration from schema 1 to 2, and commit write failures. These belong to `src/task/store*.test.ts` coverage if not already present.
- Engine negative cases to protect: non-MCP backend rejection, missing task/turn IDs, terminal task sends, queued-turn resume for non-queued turn, missing pending ask, waiting-user mismatch, adapter `error`, backend factory throw, missing terminal event, timeout cancellation, reload interruption, dependency unsatisfied handling, duplicate/conflicting disposition op IDs, and retry/cancel request races. These belong to `src/task/engine*.test.ts` and coordinator-tool tests.
- Snapshot/protocol negative cases to protect: focused task missing, stale `taskUpdated` revisions, malformed extension messages rejected by `isExtMessage`, late stream events ignored when `turnId` does not equal active turn, transcript ordering ties, active-turn recovery selection, and subtree projection for nested children. T03 is expected to pin the snapshot-specific subset in `src/host/snapshot.test.ts`.

## Observability Impact

[High confidence] This task adds no runtime logging, metrics, status endpoint, or user-visible diagnostic command. Its observability surface is this audit document plus the executable `test -s docs/TASK-MODEL-UI-STATE-AUDIT.md` existence check for T01; T02 and T03 are planned to add stronger executable drift checks.

## Downstream Guidance

1. Treat `src/task/types.ts`, `src/task/derived-status.ts`, `src/task/store.ts`, `src/task/engine.ts`, `src/host/snapshot.ts`, `src/extension.ts`, and `webview/src/lib/*.svelte.ts` as the current contract before changing runtime behavior.
2. Preserve the `taskId` + `turnId` identity boundary across host and webview messages; do not reintroduce run-only identity for task UI state.
3. Prefer making projections more explicit and testable before changing UI behavior. The riskiest boundary is currently the mixed incremental `taskUpdated` plus full focused snapshot stream.
4. Add focused tests before runtime UX changes: snapshot root ordering/subtree/transcript/active-turn behavior, stale patch rejection, late event ignoring, and reload recovery/resume paths.
5. Keep task lifecycle immutable after terminal outcomes; user follow-up should create continuation tasks instead of reopening records.
