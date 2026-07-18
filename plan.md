# Batch B: SQLite live backup and explicit global reset

## Target
Deliver P5-W4 and P5-W5 as two resumable commits: a verified SQLite-aware live-backup primitive followed by user commands for database backup and an explicit, cross-process-safe developer reset of the profile/authority-wide Muster database.

## Source Of Truth
- Plan schema: `loop-plan/v1`
- Request/report: Implement Batch B (`P5-W4` and `P5-W5`) from `docs/plans/sqlite-global-storage-refactor.vi.md:928-1041`; Batch A is already complete and Batch C must not begin.
- Baseline commit: `777c900`
- Plan path: `plan.md`

## Current State
- Completed: Phase 4 is closed; commits `86dbc73`, `01506b2`, and `777c900` completed P5-W1 through P5-W3. Runtime storage is SQLite-only at `context.globalStorageUri/muster.sqlite3`; worker/RPC access, safe error taxonomy (including operation class `backup`), deterministic boundary fault injection, fail-closed open validation, durable-write rollback, bounded projections, and multi-window revision polling are present.
- Remaining: P5-W4 has no backup RPC/client/worker implementation or WAL-aware backup tests. P5-W5 has no contributed backup/reset commands, maintenance UI flow, reset primitive, runtime quiesce/reload path, or cross-process reset tests. P5-W6 and P5-W7 are explicitly outside this batch.
- Worktree: dirty only with planner-owned untracked `plan.md` at final review time on `main`, which is 32 commits ahead of `origin/main`; preserve that local commit history and any unrelated changes that appear during implementation.

## Codebase Evidence
- Current flow: `src/extension.ts:activate -> DbClient.open -> src/task/sqlite/worker.ts:handle -> openStoreDatabase -> WorkspaceRegistry.getOrCreate -> SqliteTaskRepository -> TaskEngine.loadAsync`; writes return through the worker-owned WAL transaction and `onAfterCommit` patch path. There is no backup/reset branch in `DbRequest`, `DbClient`, or `worker.handle`, and `package.json:contributes.commands` contains only `muster.openChat`.
- Existing tests: `src/task/sqlite/connection.test.ts` proves ownership validation without mutation; `src/task/sqlite/write-failure.test.ts` proves rollback/durable-before-visible; `src/task/sqlite/main-thread-nonblocking.test.ts` proves worker lock waits do not block host timers; `src/task/sqlite/crash-recovery.test.ts` and `src/task/change-feed.test.ts` cover reopen/WAL and independent-client behavior; `src/task/engine-terminal-quiesce.test.ts` and `src/task/engine-repository.test.ts` prove hard/graceful engine shutdown; `src/host/task-export-route.test.ts` proves Save-dialog cancellation and redacted failures for the existing task-scoped export.
- Pattern to follow: `src/task/sqlite/rpc.ts:DbRequest` + `src/task/sqlite/client.ts:DbClient` + `src/task/sqlite/worker.ts:handle` are the required typed worker boundary; `src/task/sqlite/connection.ts:openStoreDatabase` and `src/task/sqlite/schema-fingerprint.ts:findSchemaFingerprintFailure` are the ownership/schema verification pattern; `src/host/task-export-route.ts:handleTaskExportCommand` is the pure dependency-injected Save-dialog route pattern; `src/host/terminal-storage-coordinator.ts:applyTerminalStorageQuiesce` and `TaskEngine.shutdown` are the runtime-stop patterns; `scripts/sqlite-extension-host-smoke.ts:run` is the packaged minimum/current runtime capability pattern.
- Pattern fallback: SQLite `VACUUM INTO` is the ecosystem fallback for the minimum VS Code 1.101 Extension Host because it embeds Node 22.15.1, while official `node:sqlite` added `sqlite.backup()` only in Node 22.16.0. Use `sqlite.backup()` when runtime-probed and `VACUUM INTO` otherwise; both execute in the DB worker against the live source connection and produce a SQLite-coordinated snapshot rather than copying the live main file.
- Verified gap: Node 26 in the planning shell exposes module-level `backup`, but the minimum supported host does not. The current worker supports only `open/all/get/run/transaction/pragma/close`; there is no artifact verification/publish path. Activation throws before command registration on database-open failure, so an explicit recovery reset command is currently unavailable exactly when an owned schema is incompatible.

## Scope
- In scope: P5-W4 adaptive SQLite backup, temp-sibling atomic publication, artifact verification, overwrite/cancel/failure handling, minimum/current packaged capability evidence, command contributions/registration, explicit global-scope reset confirmation with optional backup first, coordinated local quiesce, in-place transactional reset for readable Muster-owned databases, bounded empty restart, and two-client/process safety tests.
- Out of scope: P5-W6 privacy documentation/canary audit, P5-W7 packaged fault UAT/closeout, restore/import, migration/backward compatibility, JSON fallback, telemetry, Markdown export changes, activation `VACUUM`, physical unlink/replacement of an open main/WAL/SHM trio, resetting foreign databases, or silently resetting corrupt/incompatible storage during activation.

## Invariants
- `globalStorageUri/muster.sqlite3` remains the only durable runtime source; settings and secrets remain outside it.
- No host/main-thread `DatabaseSync`, raw live-main `copyFile`, partial main/WAL/SHM handling, full-workspace hydration, legacy importer, migration, or compatibility path is introduced.
- Every backup/reset error crossing worker or logging boundaries remains a fixed safe code/operation; raw SQL, params, path, content, and stack do not cross shared diagnostics. A user-selected destination may appear only in direct user UI.
- Backup never mutates, resets, or loses committed source rows; a failed/cancelled backup never damages an existing good destination.
- A backup destination must not resolve to the live source main file or either live sidecar by normalized path, symlink/canonical path, or existing-file identity, regardless of overwrite choice.
- Reset is explicit and global in scope, never automatic. Cancel and failed backup-before-reset are strict no-ops. Foreign/corrupt/unverifiable sources fail closed.
- Reset never unlinks an open database. It serializes an in-place schema/data reset under SQLite exclusive coordination, rolls back on failure, and leaves stale peers on the same database identity rather than creating split-brain files.
- Runtime-visible success follows durability and verification; no command reports success before backup publication or reset commit/reopen verification.

## Global Gates
| Gate | Command | Expected result |
|---|---|---|
| Types | `npm run compile` | TypeScript and webview build pass |
| Static/UI checks | `npm run check:svelte` | 0 errors and 0 warnings |
| Build | `npm run vscode:prepublish` | Packaged-source build passes |
| Full tests | `npm test` | All Vitest suites pass |
| Source boundaries/fixtures | `npm run test:source-boundary && npm run test:source-boundary:fixtures && git diff --check` | Production and fixture boundary audits pass; no whitespace errors |

## Execution Rules
- Execute phases in order unless a phase explicitly declares no dependency.
- For each phase: revalidate the cited code evidence, write or update contract tests first, confirm the intended failure when feasible, evaluate whether the tests reject naive shortcuts, implement the full behavioral contract using project patterns, run focused tests, run all phase gates, review the uncommitted diff, fix findings, and commit.
- Green tests alone do not complete a phase. The production diff must satisfy every implementation obligation and invariant for the full described input/state class.
- Never commit with failing gates or an unapproved implementation review.
- Preserve unrelated user changes; never reset or revert them.
- Mark a phase complete in this plan in the same commit as that phase's implementation.
- Continue automatically to the next incomplete phase. Stop only for a destructive/irreversible decision, missing credentials/infrastructure, irreconcilable requirements, or repeated failures with no new evidence.

## Plan Review
- Status: APPROVE
- Rounds: 2
- Open issues: None

## Phase 1: P5-W4 SQLite-aware live backup primitive
- Status: complete
- Depends on: None
- Goal: Produce and atomically publish a verified, independent snapshot of a live Muster WAL database through the worker boundary on both minimum and current Extension Host runtimes.
- Current behavior: `DbClient` and `worker.handle` have no backup request. Copying `muster.sqlite3` would omit committed WAL pages, while the minimum host's Node 22.15.1 predates `node:sqlite.backup()`.
- Code evidence: `src/task/sqlite/rpc.ts:DbRequest/DbResponse`; `src/task/sqlite/client.ts:DbClient.send`; `src/task/sqlite/worker.ts:handle/operationFor`; `src/task/sqlite/errors.ts:SQLITE_OPERATION_CLASSES`; `src/task/sqlite/fault-inject.ts:maybeInjectFault`; `src/task/sqlite/connection.ts:openStoreDatabase`; `src/task/sqlite/schema-fingerprint.ts:findSchemaFingerprintFailure`; `scripts/sqlite-extension-host-smoke.ts:run`; official Node 22.17 docs mark `sqlite.backup` “Added in v22.16.0,” while VS Code 1.101 release notes identify Node 22.15.1.
- Pattern to follow: Extend the existing typed `DbRequest -> DbClient -> worker.handle` boundary and reuse current ownership/schema constants and fingerprint validation; extend the packaged worker smoke in `scripts/sqlite-extension-host-smoke.ts` rather than creating an unrepresentative direct-main-thread test.
- Behavioral contract:
  - `DbClient.backup(destination, { overwrite, cancellationFlag })` delegates all SQLite work to its worker and returns only fixed mechanism/schema/revision/size metadata needed by UI, never source/destination paths or row content. `cancellationFlag` is a request-scoped `SharedArrayBuffer` containing one `Int32`; the host marks it with `Atomics.store` and the worker reads it before work, during native-backup progress when available, after snapshot creation, and immediately before publication.
  - The worker runtime-probes module-level `node:sqlite.backup`; when present it backs up the already-open source connection in bounded page batches, and when absent it executes parameter-bound `VACUUM INTO` against that source connection. Neither branch copies the live main file or checkpoints/mutates source as a correctness shortcut.
  - Backup writes a unique temporary sibling of the destination, verifies it read-only as a standalone SQLite database (`application_id`, `user_version === SQLITE_SCHEMA_VERSION`, schema fingerprint, `PRAGMA quick_check` exactly `ok`, and captured workspace revision), then atomically publishes it. Default/no-overwrite refuses an existing destination; explicit overwrite replaces only after the new artifact verifies.
  - Before creating a temp file, resolve the source main/WAL/SHM and destination using normalized absolute paths, real/canonical parent paths for a non-existent destination, realpath for an existing destination, and device/inode identity where available. Reject every destination alias of the live trio under both overwrite modes.
  - Cancellation before work is a no-op. Native backup observes the shared atomic flag at progress boundaries; the synchronous minimum-host `VACUUM INTO` fallback cannot be interrupted safely, so it must re-check the flag after the statement and before verification/publication. Cancellation observed at either point removes the temporary artifact and never publishes it. Any fault, verification failure, publish failure, or cancellation cleans only artifacts owned by that invocation and preserves source plus any pre-existing destination.
  - Concurrent WAL writers may commit while backup runs. The artifact represents one internally consistent snapshot and may precede a later source commit; source remains writable/reopenable and host timers remain responsive.
- Tests first:
  - Add `src/task/sqlite/backup.test.ts`: seed a current Muster DB, force committed rows to remain in WAL, call backup, reopen the artifact independently/read-only, and assert the WAL-only row, application ID, schema version, quick-check, and captured workspace revision agree.
  - In the same suite, coordinate a second `DbClient` writer during backup and assert the artifact is exactly one valid pre-or-post commit snapshot (never a mixed revision), while the source contains all committed rows and accepts a subsequent write.
  - Table-drive destination missing/existing with `overwrite:false`/`true`, pre-cancel, controlled mid-backup/pre-publication cancellation through the shared atomic flag on both mechanism branches, injected `backup` failure, verification failure, and publication failure; assert temp siblings are removed and byte-identical existing destinations remain untouched on every unsuccessful case.
  - Add source-identity cases selecting the main path, `-wal`, `-shm`, a symlink alias, `..`/normalized aliases, and an existing hard-link alias where supported, under both overwrite modes; assert refusal occurs before temp creation and the live trio/data remain unchanged and writable.
  - Extend `scripts/sqlite-extension-host-smoke.ts` to invoke packaged `DbClient.backup`, reopen the artifact, and assert the runtime-selected mechanism is fallback on VS Code 1.101 and API-backed when the current host exposes `sqlite.backup`; never require the API on the minimum host.
  - Extend `src/task/sqlite/main-thread-nonblocking.test.ts` with a sufficiently large/controlled backup or injected worker delay and a host heartbeat oracle proving backup work does not execute on the calling thread.
- Anti-shortcut coverage:
  - The WAL-only committed-row fixture fails a raw main-file copy; source-identity aliases fail “trust the Save dialog” implementations; shared-flag cancellation after snapshot creation fails host-only pre-checks; concurrent revision assertions fail independent table dumps or mixed snapshots; forced verification/publish failure with an existing destination fails delete-then-copy and premature overwrite implementations; minimum-host smoke fails an unconditional `sqlite.backup()` call.
- Implementation obligations:
  - Add exact request/response guards and client typing for backup; make worker dispatch safely await the asynchronous API branch without changing FIFO ordering or terminal-latch semantics.
  - Isolate backup mechanics in a focused `src/task/sqlite/backup.ts` worker-side module. Use runtime feature detection, bound the native API page rate, bind/escape the fallback destination safely, and keep all synchronous SQLite/filesystem work off the extension-host thread.
  - Implement invocation-owned temp naming/cleanup and atomic publish with explicit no-clobber versus overwrite semantics. Perform path/canonical/file-identity rejection against the open source main/WAL/SHM before temp creation. Do not expose a host-side filesystem writer that could be reused to copy the live database.
  - Carry only the request-scoped `SharedArrayBuffer` cancellation flag over worker RPC. Check it at every safe native progress boundary and all branches immediately before verification/publication; document and test that fallback cancellation is publication-cancellation, not unsafe interruption of SQLite's synchronous statement.
  - Verify through a read-only connection that does not invoke `openStoreDatabase` (and therefore cannot stamp, bootstrap, or switch journal mode). Reuse `findSchemaFingerprintFailure`, `MUSTER_APPLICATION_ID`, and `SQLITE_SCHEMA_VERSION`; close every verification handle on all paths.
  - Invoke `maybeInjectFault('backup')` at the pre-publication durability boundary and map all failures through the P5-W1 safe error contract. Add source-boundary rules/fixtures that reject `copyFile*` of the live Muster database and direct host `node:sqlite` backup work without banning safe temp-artifact publication.
  - Record the verified minimum/current capability choice and mark only P5-W4 complete in `docs/plans/sqlite-global-storage-refactor.vi.md`; do not mark P5-W5 or Batch B complete.
- Acceptance criteria:
  - [x] AC-1: A backup made with committed-but-uncheckpointed WAL data reopens independently with current Muster ownership/schema, quick-check `ok`, and the captured consistent revision - proven by `src/task/sqlite/backup.test.ts` WAL snapshot cases.
  - [x] AC-2: Concurrent source writing yields a valid pre-or-post snapshot, never mixed state, and source remains writable/reopenable without row loss - proven by `src/task/sqlite/backup.test.ts` concurrent-client case.
  - [x] AC-3: Cancel/fault/invalid artifact/publish failure leaves no invocation temp and preserves any existing destination byte-for-byte; overwrite occurs only when explicitly true - proven by table-driven backup failure/overwrite tests.
  - [x] AC-4: VS Code 1.101 and stable packaged workers both create and verify a backup using only capabilities present in that host, and host heartbeat continues during worker work - proven by packaged smoke plus `main-thread-nonblocking.test.ts`.
  - [x] AC-5: Static boundaries contain no raw live-main copy or host-thread SQLite backup path, and backup errors/metadata contain no path, SQL, params, or content - proven by source-boundary fixtures and RPC/error assertions.
  - [x] AC-6: Main/WAL/SHM destinations and normalized, symlink, or existing-file aliases are rejected under both overwrite modes before artifact creation, and mid-operation cancellation cannot publish - proven by source-identity and shared-flag cancellation cases in `backup.test.ts`.
- Focused verification:
  - `npx vitest run src/task/sqlite/backup.test.ts src/task/sqlite/client.test.ts src/task/sqlite/protocol.test.ts src/task/sqlite/main-thread-nonblocking.test.ts src/task/sqlite/connection.test.ts`
- Phase gates:
  - `npm run compile && npm run check:svelte && npm run test:source-boundary && npm run test:source-boundary:fixtures && MUSTER_VSCODE_VERSION=1.101.0 npm run test:sqlite-extension-host && MUSTER_VSCODE_VERSION=stable npm run test:sqlite-extension-host && git diff --check`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat: add sqlite-aware live backup`

## Phase 2: P5-W5 backup command and explicit developer reset
- Status: pending
- Depends on: Phase 1
- Goal: Expose safe Command Palette workflows for backup and explicit global reset, including optional verified backup, complete local quiesce, transactional cross-process coordination, and bounded empty restart.
- Current behavior: `package.json` contributes only `muster.openChat`; `src/extension.ts:activate` opens SQLite before registering commands and throws on open failure. Existing terminal recovery can only reveal storage. No code can reset global data or restart an empty runtime.
- Code evidence: `package.json:contributes.commands`; `src/extension.ts:activate/deactivate` and module-level `sqliteClient/taskEngine/taskRepository/chatProvider`; `src/host/task-export-route.ts:handleTaskExportCommand`; `src/host/terminal-storage-coordinator.ts:applyTerminalStorageQuiesce`; `src/task/engine.ts:shutdown/quiesceForTerminalStorage`; `src/task/sqlite/connection.ts:exclusiveOpenDecision`; `src/task/sqlite/schema.ts:CURRENT_SCHEMA_STATEMENTS`; every durable table in `schema.ts` is workspace-owned/cascaded from `workspaces`.
- Pattern to follow: Use pure dependency-injected command handlers like `src/host/task-export-route.ts`, register through `context.subscriptions` like `muster.openChat`, stop pollers through `MusterChatProvider.disposeRevisionPoller`, gracefully drain streams through `TaskEngine.shutdown`, and perform reset only in the DB worker using the transactional DDL/ownership practices in `openStoreDatabase`.
- Behavioral contract:
  - Contribute/register exact commands `muster.backupDatabase` (“Muster: Back Up Global Database”) and `muster.developerResetGlobalDatabase` (“Muster: Developer Reset Global Database”). Registration remains available when storage open fails; normal engine/scheduler/poller/writers still remain fail-closed.
  - Backup command shows a Save dialog, treats dismissal as a strict no-op, obtains explicit overwrite confirmation from the dialog/host seam, invokes Phase 1 backup, and reports success only after verified atomic publication. Fixed-code failure UI does not echo raw exceptions; only direct success UI may show the selected path.
  - Reset uses one modal whose body states that it deletes every Muster conversation, task, and durable datum for every workspace in the current VS Code profile and extension-host authority. Choices are `Back Up and Reset` and `Reset Without Backup`; dismissing is a strict no-op. Choosing backup opens the Save dialog and aborts reset if selection, backup, verification, or publication does not succeed.
  - Before reset mutation, a single-flight maintenance coordinator detaches runtime write entrypoints, stops production/UAT pollers, gracefully drains `TaskEngine.shutdown` (including stream timers/live runs), closes bridge/user-interaction writers, and awaits `DbClient.close` so earlier queued RPC writes settle before reset begins. New commands/writes are rejected while maintenance is active.
  - A fresh maintenance worker performs reset in place on the same database identity: read ownership without mutation, reject foreign/unreadable/corrupt files, acquire an exclusive write transaction with bounded busy timeout, remove all existing user schema/data, execute `CURRENT_SCHEMA_STATEMENTS`, restore Muster application ID/current user version, verify fingerprint/quick-check, and commit atomically. It never unlinks/replaces main, WAL, or SHM. Any lock/fault/DDL/verification failure rolls back and leaves the host fail-closed with close-other-windows guidance.
  - On success, the command triggers `workbench.action.reloadWindow`; the normal activation path recreates only the current workspace registry row and bounded empty projection/snapshot. It never imports or restores old rows. A peer holding a write transaction makes reset fail busy rather than allowing a partial reset or second database lineage.
  - An idle peer remains attached to the same file. When its `WorkspaceRevisionPoller` observes `currentRevision < appliedRevision`, it treats that regression as an explicit external-reset signal: stop/dispose polling single-shot, detach repository/write entrypoints, hard-quiesce the stale engine without repository writes, and show one fixed `Reload Window` action. It must not lower only the UI cursor, repeatedly recover, or allow the stale projection to write after the signal.
- Tests first:
  - Add `src/host/sqlite-maintenance-commands.test.ts` for command handlers: manifest/IDs, Save-dialog cancel, backup success/fixed failure, exact global-scope reset copy and choices, reset cancel, backup-before-reset ordering, backup cancel/failure preventing quiesce/reset, single-flight rejection, and success invoking reload only after reset verification.
  - Add `src/task/sqlite/reset.test.ts`: seed at least two workspace graphs plus durable outbox/presentation rows, reset, reopen normally, and assert current ownership/schema with zero old workspace/domain rows; then create a new registry/task to prove source usability.
  - In `reset.test.ts`, hold a real writer transaction in a second worker and assert reset returns safe busy/close-other-windows guidance with all original rows/revisions intact; repeat with an idle second client and assert one database identity, atomic empty state, stale workspace writes cannot resurrect partial old state, and both clients see the same schema/application markers.
  - Extend `src/host/workspace-revision-poller.test.ts` and the provider/terminal coordinator tests with an applied revision above the post-reset zero/current revision. Assert one reset callback, poller disposal/no re-arm, stale engine hard-quiesce and write-entrypoint detachment, one reload prompt, no snapshot cursor downgrade loop, and no repository writes during peer quiesce.
  - Table-drive injected reset failure before commit, schema verification failure, foreign database, corrupt/not-a-database, and incompatible Muster-owned schema. Assert foreign/corrupt fail closed without mutation, current/incompatible owned reset either commits a complete current empty schema or rolls back to byte/data-equivalent readable state, and no main/WAL/SHM file is individually unlinked.
  - Extend activation/terminal tests so open failure still registers maintenance commands but starts no engine/scheduler/poller; reset cancellation leaves fail-closed state; successful reset requests reload and subsequent activation yields bounded no-focus/empty UI.
- Anti-shortcut coverage:
  - Two seeded workspaces reject workspace-local “clear history”; backup-before-reset ordering rejects reset-first implementations; second-worker lock rejects unchecked file deletion; idle-peer same-identity plus poller-regression tests reject rename/unlink split-brain and cursor-only recovery; injected mid-DDL failure rejects nontransactional drop/recreate; incompatible-owned and foreign fixtures reject “delete any file” shortcuts.
- Implementation obligations:
  - Add pure host command routes and a narrowly scoped runtime maintenance coordinator; keep dialog labels/result unions fixed and dependency-injected for deterministic tests. Do not route database backup through Markdown export or add webview protocol aliases.
  - Reorder activation only as needed to register recovery commands before storage open. Preserve W2 fail-closed behavior: an open failure reports once and returns with no engine/provider poller/writer rather than silently activating an empty store.
  - Extend typed RPC/client/worker with a dedicated reset request and safe operation classification. Put reset DDL/verification in a focused worker-side module, with bound/internal SQL and rollback around all schema/data changes; accept only blank or Muster-owned readable databases and never claim/delete foreign content.
  - Implement local quiesce as an awaitable barrier, not the terminal-storage best-effort zero-write path: capture runtime references, prevent new access, stop polling, await graceful engine flush/abort/settlement and all queued client work, then close. On reset failure, do not reconnect to uncertain state; surface a fixed fail-closed diagnostic.
  - Preserve the physical database identity and let SQLite coordinate WAL/SHM; do not call `unlink`, `rm`, `rename`, or raw-copy on the live trio. Map busy contention to `close_other_windows` guidance for this command without swallowing the underlying fixed `busy` code.
  - Add an explicit reset/regression reason to `WorkspaceRevisionPoller` and wire it through `MusterChatProvider` to a single-shot peer-reset lifecycle. Reuse `applyTerminalStorageQuiesce`/`TaskEngine.quiesceForTerminalStorage` so the stale peer performs zero repository writes, then offer `workbench.action.reloadWindow`; do not attempt ordinary bounded snapshot recovery with a lower revision.
  - After reset verification, request window reload and rely on existing `WorkspaceRegistry.getOrCreate -> TaskEngine.loadAsync -> bounded snapshot` activation flow. Add a source-boundary rule preventing automatic reset calls from activation/open/write error handlers.
  - Mark P5-W5 and Batch B complete in `docs/plans/sqlite-global-storage-refactor.vi.md`, update this plan's phase/progress state in the same commit, and do not begin or mark P5-W6/P5-W7.
- Acceptance criteria:
  - [ ] AC-1: Both exact commands are contributed and registered even after storage-open failure, while engine/scheduler/poller remain absent - proven by manifest/activation command tests.
  - [ ] AC-2: Backup command cancel is a no-op and success/failure is reported only after Phase 1 verification/publication with no raw diagnostic leakage - proven by `sqlite-maintenance-commands.test.ts`.
  - [ ] AC-3: Reset modal states profile+authority-wide/all-workspace scope; cancel and failed/cancelled backup-before-reset perform zero reset/quiesce/reload work - proven by command route call-order assertions.
  - [ ] AC-4: Successful reset removes data from multiple workspaces and all durable surfaces, leaves a complete current Muster schema, reloads, and permits a new bounded empty runtime - proven by `reset.test.ts` and activation restart tests.
  - [ ] AC-5: A concurrent writer causes atomic busy failure with original state intact; an idle peer remains on the same database identity and cannot observe or create split-brain/partial state - proven by two-client/worker reset contention cases.
  - [ ] AC-6: Foreign/corrupt reset attempts fail closed without mutation, incompatible owned reset is all-or-nothing, and no code individually manipulates the live main/WAL/SHM files - proven by reset fixtures and source-boundary audit.
  - [ ] AC-7: All Batch B global gates pass and git history contains separate P5-W4 and P5-W5 commits without P5-W6/W7 work - proven by commands below plus `git log --oneline -2` inspection.
  - [ ] AC-8: A stale peer that observes revision regression hard-quiesces once, rejects later writes, stops polling, and offers reload without a repeated recovery loop - proven by poller/provider/terminal reset-regression tests.
- Focused verification:
  - `npx vitest run src/host/sqlite-maintenance-commands.test.ts src/task/sqlite/reset.test.ts src/task/sqlite/backup.test.ts src/host/terminal-storage-coordinator.test.ts src/task/engine-terminal-quiesce.test.ts src/task/sqlite/connection.test.ts`
- Phase gates:
  - `npm run compile && npm run check:svelte && npm test && npm run test:source-boundary && npm run test:source-boundary:fixtures && MUSTER_VSCODE_VERSION=1.101.0 npm run test:sqlite-extension-host && MUSTER_VSCODE_VERSION=stable npm run test:sqlite-extension-host && git diff --check`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat: add sqlite backup and developer reset commands`

## Completion Criteria
- [ ] Every phase is complete and committed exactly once.
- [ ] Every acceptance criterion is checked.
- [ ] All global gates pass on final HEAD.
- [ ] Final `codex-impl-review` verdict is APPROVE for the complete plan range.
- [ ] Worktree is clean apart from pre-existing unrelated changes.

## Progress Log
| Phase | Status | Commit | Verification | Review |
|---|---|---|---|---|
| 1 | complete | pending | focused tests + compile + boundaries + EH 1.101(vacuum)/stable(api) green | APPROVE |
| 2 | pending | N/A | pending | pending |
