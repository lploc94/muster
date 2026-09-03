# SQLite global storage — location, backup, reset, and recovery

Authoritative guide for Muster’s durable SQLite store. Implementation lives under
`context.globalStorageUri/muster.sqlite3` and the typed DB worker boundary.

**Related documents:**

- [`TASK-MANAGEMENT.md`](TASK-MANAGEMENT.md) — task/turn domain model and task-scoped Markdown export
- [`SESSION-MANAGEMENT.md`](SESSION-MANAGEMENT.md) — backend session identity (not the SQLite file layout)
- [`SETTINGS.md`](SETTINGS.md) — VS Code Settings (configuration stays outside SQLite)
- [`plans/sqlite-global-storage-refactor.vi.md`](plans/sqlite-global-storage-refactor.vi.md) — hardening plan

---

## 1. Location and scope

- **Canonical path:** `context.globalStorageUri` + `muster.sqlite3` (never hard-code a
  macOS/Windows/Linux absolute path; each VS Code / Insiders / Cursor host supplies its own URI).
- **Scope:** **one database per VS Code profile + extension-host authority**. Every workspace and
  window that share that profile and authority share the same file.
- **Not repository-local:** Muster does not create or read a data store inside the workspace folder.
- **Not cross-host:** Local desktop, Remote SSH, Dev Containers, Codespaces, and other profiles each
  have a separate `globalStorageUri`. Muster does not synchronize SQLite across authorities.

Coordinated SQLite files for one store:

```text
muster.sqlite3
muster.sqlite3-wal
muster.sqlite3-shm
```

Treat the main file, WAL, and SHM as **one unit**. Do not delete or replace one member while another
window still has the database open.

User configuration remains in **VS Code Settings**. API keys and credentials remain in
**VS Code SecretStorage**. They are not stored in the SQLite file.

---

## 2. Backup versus Markdown export

| Surface | Scope | Command / path | Purpose |
|---|---|---|---|
| **Global database backup** | Entire profile+authority Muster DB | Command Palette: **Muster: Back Up Global Database** (`muster.backupDatabase`) | SQLite-aware snapshot of all workspaces’ durable data |
| **Task Markdown export** | Focused task conversation only | Webview **Export task/chat** | Human-readable transcript; **not a backup** and not restore-capable |

Backup uses the SQLite-aware worker path (native `node:sqlite.backup` when available, otherwise
`VACUUM INTO`). It does **not** raw-copy the live main file while WAL may hold committed pages.
Success is reported only after the artifact is verified (ownership, schema version, fingerprint,
`PRAGMA quick_check`). The success toast may show the **basename** you chose in Save As; the full
path is not written to logs, diagnostics, or telemetry.

There is **no in-product restore/import command**. Muster does not ship a Command Palette action that
imports a backup or migrates foreign/legacy files.

---

## 3. Supported manual restore (all windows closed)

Manual restore is supported only as an **operator procedure**, not as an automatic or in-product
command:

1. **Close every Muster window** (and ideally every VS Code window) for that profile and
   extension-host authority so no process holds the live database open.
2. **Preserve or move the existing trio together** (`muster.sqlite3`, `-wal`, `-shm`) if you want a
   last-resort copy of the pre-restore state. Never delete only one member of a live trio.
3. Place a previously created, independently usable backup file as `muster.sqlite3` under the same
   `globalStorageUri` directory. **Do not pair the backup with stale `-wal` / `-shm` sidecars** from
   the old generation — remove or relocate the old sidecars with the old main file.
4. Reopen Muster and let normal activation run ownership and schema checks (`application_id`,
   `user_version`, fingerprint, fail-closed diagnostics).

Do **not**:

- replace files while any Muster window still has the database open;
- delete `main` / `-wal` / `-shm` separately on a live store;
- claim restore success before a normal reopen succeeds;
- expect Muster to import `.muster-tasks.json` or other legacy formats (SQLite-only; no migration path).

---

## 4. Developer reset workflow

Command Palette: **Muster: Developer Reset Global Database**
(`muster.developerResetGlobalDatabase`).

- **Scope:** permanently deletes **every** Muster conversation, task, and durable datum for **every
  workspace** in the current VS Code profile and extension-host authority. Settings and secrets are
  **not** deleted. This cannot be undone.
- Modal choices: **Back Up and Reset** or **Reset Without Backup**. Dismissing the modal is a
  **strict no-op**.
- **Back Up and Reset:** opens Save As; if you cancel or backup fails verification, **reset does not
  run** (no quiesce, no schema rebuild, no reload).
- On confirmed reset, Muster quiesces local writers/pollers/engine, then performs an **exclusive
  in-place** rebuild of the current schema on the same database identity (never unlinks the open
  main/WAL/SHM trio). Success reloads the window; activation creates a bounded empty runtime for the
  current workspace only.
- **Contention:** if another window holds a write lock, reset fails busy with guidance to
  **close other Muster windows** and retry. Peers that observe a revision regression after a
  successful reset hard-quiesce and offer **Reload Window** — they must not keep writing a stale
  projection.
- **Never automatic:** activation, open, or write failures do **not** auto-reset the database.
- **Schema v7:** the store is **reset-only**. Any incompatible Muster-owned schema is rejected rather than migrated in place. Back up first if the history matters, then use **Developer Reset Global Database** to create the current empty schema. This can erase task and chat history; it is not a data-preserving upgrade.

---

## 5. Recovery by failure class

All diagnostics use fixed safe codes. Paths are not embedded in shared log/diagnostic payloads.
When you need to inspect files, use the host **Reveal Storage** action (or your OS file manager on
`globalStorageUri`) after closing other windows.

| Situation | Behavior | What to do |
|---|---|---|
| **Corrupt / not a database** | Fail closed; no engine/scheduler/poller; no silent empty store. **Developer Reset refuses** physically corrupt/unreadable files | Reveal storage; close all Muster windows; use the **manual restore** procedure with a verified backup. If you have no backup and intend to start empty: with all windows closed, **preserve/move the entire corrupt trio aside together**, then reopen Muster so activation can claim a blank store. Do not expect Developer Reset to repair corruption |
| **Foreign database** (`application_id` not Muster) | Reject without mutation; reset also refuses foreign files | Do not force-claim the file; move it aside only with all windows closed |
| **Incompatible / incomplete Muster schema** | Fail closed with reset guidance; reset accepts readable Muster-owned incompatible DBs | Close all windows; use **Developer Reset Global Database** (preferably with backup first) |
| **Disk full** | Transaction rolls back; no false durable ACK | Free disk space; retry |
| **Read-only / permissions** | Write fails closed | Fix directory permissions on the storage location |
| **I/O error** | Fail closed / retry per operation | Check disk health; close other windows; retry |
| **Busy / locked** | Bounded timeout; no swallowed `SQLITE_BUSY` | Close other Muster windows; retry |

Malformed durable rows remain invariant errors and are **not** silently skipped.

---

## 6. Privacy limitations

- Conversation text, reasoning, tool payloads, and related durable task data are stored in
  **plain SQLite** under the user profile’s `globalStorageUri`, and in any **user-initiated backup**
  of that database.
- **Muster does not encrypt SQLite at rest.** Protection is whatever the OS and user-profile
  permissions provide. Do not claim SQLCipher or full-disk encryption unless the host environment
  supplies it outside Muster.
- Credentials and API keys stay in **VS Code SecretStorage**, not in SQLite.
- Logs, diagnostics, Extension Host debug output, UAT/evidence ledgers, change-feed metadata, and
  command error payloads use **fixed codes and redacted fields** — not prompts, tool output, SQL
  parameters, stacks, or filesystem paths.
- Frozen workflow instruction bodies are durable executable content and therefore exist in the
  plaintext SQLite store and user backups. Catalog, status, graph, diagnostics, change-feed, and
  evidence projections expose only bounded metadata; they never expose those instruction bodies,
  script bodies, package roots, or package paths.
- There is **no telemetry framework** that uploads conversation content, workspace paths, or SQL.

---

## 7. Commands (exact IDs)

| Command ID | Title |
|---|---|
| `muster.backupDatabase` | Muster: Back Up Global Database |
| `muster.developerResetGlobalDatabase` | Muster: Developer Reset Global Database |
| `muster.compactStorage` | Muster: Compact Storage |
| `muster.reclaimOrphanedFiles` | Muster: Reclaim Orphaned Files |
| `muster.storageReport` | Muster: Show Storage Report |

### Reclaim orphaned files

Use Command Palette: **Muster: Reclaim Orphaned Files**
(`muster.reclaimOrphanedFiles`) to remove only classifier-identified, obsolete
storage files: the legacy JSON store and stale lease files. Orphan reclamation
runs only from the explicit Command Palette command. No timer, watcher, scheduled scan, or automatic sweep invokes orphan reclamation. It never removes the
live SQLite trio or active leases. Before it makes changes, the confirmation
states that **unmigrated legacy history** is permanently removed; dismissing or
declining it is a strict no-op. Cancellation emits no reclamation result.

The **Muster Storage Report** channel records a path-free result for every
confirmed pass: numeric `removed_files`, `bytes_reclaimed`, and
`failed_removals` fields, plus one basename-only `removed:` record per deleted
file. An empty classification emits zero values without prompting. A failed
removal is counted without cancelling removal of other eligible files. If
another maintenance command is in progress, reclamation reports the shared busy
outcome and does not begin.

### VS Code uninstall

The `vscode:uninstall` lifecycle hook runs the compiled `dist/src/uninstall.js`
entrypoint after Muster is removed. It clears the extension's global storage
only when the resolved directory basename is exactly `tlelabs.muster`; a
mis-resolved directory is refused rather than removed. The hook prints one
single-line diagnostic: reclaimed bytes after removal, or an explicit `absent`
or `refused` reason. It always exits 0, including when the directory is already
absent or cleanup encounters a storage error, so uninstall is never wedged.

**Compact Storage** measures `auto_vacuum` from the live store before it reclaims pages. Stores in
INCREMENTAL mode use bounded incremental vacuum; legacy NONE stores use SQLite full compaction only
after its free-space preflight. A low-space refusal is reported in the **Muster Storage Report**
channel as numeric `required_bytes` and `available_bytes` values, not as a thrown command error.
The same channel reports `mode`, file bytes and freelist before/after, batches, WAL checkpoints, and
residual WAL bytes. FULL auto-vacuum mode is reported as `noop` rather than triggering a surprise
rewrite. These output values never include a storage path.

Backup and reset commands remain registered even when storage open fails (fail-closed activation), so recovery
actions stay available.

---

## 8. Schema v7 and reset-only notes

- Current owned schema is **v7**. Muster has no in-place migration framework: opening an owned store
  with any incompatible version fails closed with reset guidance and never rewrites user data.
- Schema v7 persists each canonical workflow definition through ordered input, output, node, and edge
  authority rows. Node authority includes display title, frozen instruction kind/reference/content/
  digest, normalized outcome, resolved task routing, and script execution provenance. Reload
  reconstructs and validates this authority against the canonical definition fingerprint before use.
- Dispatch revalidates the owning canonical authority before claiming a queued activation. Entry,
  dependency, feedback, retry, activation-recovery, and fresh-session reconstruction
  paths retain the same persisted frozen instruction body instead of rereading package files.
- Manual and safe automatic retries remain owned by the same workflow activation: the retry insert,
  per-run workflow-turn reservation, and activation `execution_turn_id` rebind commit atomically.
  Corrupt canonical authority, stale activation ownership, or exhausted turn budgets deny the retry.
  An original-input manual retry may coexist with queued follow-ups already marked held; live or
  non-held queued turns still block retry allocation.
- Before any repository-owned turn deletion—direct, queued-turn/message cleanup, graph/task
  deletion, or terminal reclamation—the same SQLite transaction prepares and applies the narrow
  schema-7 `child_return` purge. The purge runs before the terminal-history turn-delete trigger
  can evaluate its run guard, and a stale/hidden non-legacy target remains fail-closed rather than
  being made visible by cleanup. A failed ownership, lineage, or foreign-key check rolls back the
  purge and the requested deletion together.
- Workflow starts accept only complete public input-name bindings. SQLite resolves each destination
  name from the frozen definition while claiming the start; callers never supply entry coordinates.
  A prior-run binding keeps `(fromRun, outputName)` as authority and selects that frozen output's
  declared terminal `next_result` artifact and exact semantic kind. Run-level aggregate completion
  remains continuation data and is never a named-composition source. The destination stores a local
  `workflow_input` artifact whose `workflow_artifact` source row pins the exact source run, artifact,
  and revision; reference accounting prevents retention from stripping required source evidence.
- Public definition and start commands carry the authenticated root task and caller turn into the
  repository. Under the same `BEGIN IMMEDIATE` transaction that would claim an operation or write
  workflow state, the repository verifies an open top-level coordinator with `create_child`, the
  matching live caller turn, and no workflow activation of any origin. A stale or forged caller is
  rejected before replay or persistence and leaves no operation, definition, run, gate, artifact,
  task, turn, or continuation row to clean up.
- Pre-cutover child-workflow rows may still exist physically in a schema-v7 store, but no production
  writer, scheduler, recovery path, or execution reader consumes them. Task-facing list and snapshot
  queries suppress tasks attached to those runs while preserving ordinary delegated children and
  canonical top-level workflow tasks. At the cleanup/terminalization boundary, a narrow
  workspace-qualified purge removes obsolete `child_return` activation/retry-lineage state and
  its child-only durable dependents in one transaction before the terminal-run guard; it is
  idempotent, FK-ordered, and rolls back on ambiguous ownership or failure. Each artifact-source,
  routed-message, and start-claim candidate must match the retired activation's complete
  workspace/run/turn/message identity; a source turn or task ID by itself never authorizes a
  delete, and a forward retry edge at the configured depth boundary fails closed before any
  mutation. Shared/unscoped operations, ordinary tasks, active canonical rows, cross-run pins,
  and the bounded `run_closure`
  record are not removed. This is not a schema migration or nested recovery path. The reset-only
  schema cutover removes the obsolete structure.
- Schema v7 owns one activation-scoped `workflow_decision_repairs` row for bounded agent outcome
  repair. An authenticated invalid route attempt records only a closed error code before any
  disposition claim; a later valid claim remains authoritative. Every accepted agent node requires
  an explicit disposition, so a text-only completion never becomes final-message NEXT. Missing
  decisions and every invalid decision settle through the repair transition. Attempts one and two
  atomically persist bounded evidence and reserve one deterministic same-task correction turn;
  attempt three marks the row exhausted and closes the run with `decision_missing` or
  `decision_invalid`. A valid `workflow_fail` claim instead closes immediately as `agent_fail` with
  its bounded reason. Typed ACP refusal is stored as `backend_refusal` evidence and closes the
  workflow run without correction or generic runtime fallback. Replay, reload, competing settlement,
  task/run turn limits, and the workflow deadline are checked in that same transition, without a
  side store or feedback round.
- Task-status and workflow-graph reads join those durable activation/repair rows; they do not infer
  repair from transient engine memory, assistant text, or error-message matching. The bounded
  projection may include display title, the required decision-gate marker, and attempt
  `N of 3` with a closed waiting/correcting/decided/exhausted state. It excludes outcome condition
  text, prior assistant responses, prompt bodies, host paths, durable physical IDs, and artifacts.
- Each failed/cancelled workflow run retains one validated bounded `run_closure` failure detail with
  closed source/code, safe semantic node identity when applicable, one UTF-8-bounded report and
  truncation state, and the decision attempt when applicable. The detail survives completion,
  root-continuation delivery, reload, and safe reclamation; malformed/private/raw values are never
  projected.
- Schema v6 and every earlier marker are rejected rather than interpreted as canonical workflow
  authority. There is no `ALTER TABLE`, row reinterpretation, compatibility decoder, or automatic
  migration path. An already-open stale writer fails closed with terminal `schema_changed` and must
  reload.
- A Developer Reset creates an empty current-schema store; it is destructive replacement, not a
  data-preserving migration. Back up first when existing task or chat history matters.
- Diagnostics never expose database paths, SQL/parameters, credentials, prompt text, or artifact bodies.

## 9. Verification (contributors)

```bash
npm run test:sqlite-storage-docs
npx vitest run src/task/m024-s06-schema-evidence.test.ts src/task/sqlite/reset.test.ts src/task/sqlite/privacy-redaction.test.ts
npm run test:source-boundary && npm run test:source-boundary:fixtures
```

## 10. Retention-truncated file-change rendering proof

`docs/plans/m023-s07-truncated-render-evidence.json` is the M023/S07 evidence
ledger for the specific claim that retention-truncated file changes remain
usable in the rendered task transcript. It is generated by a packaged VSIX
inside a live Extension Development Host DOM session, not by a Vitest, jsdom,
or browser-only component test.

The disposable UAT workspace sets the normal
`muster.retention.maxRetainedTurnsPerTask` setting to one, seeds four aged
settled file changes plus one live change, runs the production retention pass,
and captures the real webview's explicitly marked DOM through the UAT-only
`MUSTER_UAT_MODE=1` probe. A PASS requires every rendered file-change group to
contain a row, every retention row to have a path and retention-summary label
with no diff-body element, and a live row to retain a diff body.

The ledger records only the VS Code version, host/probe provenance, and bounded
row facts. It does not record diff bodies, message bodies, session IDs, or absolute paths.
The diagnostic is unavailable outside UAT mode; normal product
sessions do not expose a DOM-scraping command. Revalidate the committed proof
with `npm run test:m023-s07-render-evidence`; rerun
`npm run test:m023-s07-truncated-render-live-uat` only when intentionally
refreshing the live-host evidence.
