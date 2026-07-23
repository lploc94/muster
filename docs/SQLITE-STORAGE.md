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
- There is **no telemetry framework** that uploads conversation content, workspace paths, or SQL.

---

## 7. Commands (exact IDs)

| Command ID | Title |
|---|---|
| `muster.backupDatabase` | Muster: Back Up Global Database |
| `muster.developerResetGlobalDatabase` | Muster: Developer Reset Global Database |

Both commands remain registered even when storage open fails (fail-closed activation), so recovery
actions stay available.

---

## 8. Schema v8 and migration notes

- Current owned schema is **v8**. Opening a populated **v7** store migrates under `BEGIN EXCLUSIVE`
  with commit-boundary rollback; injected migration failure leaves readable v7 unchanged.
- v8 adds workflow definition/run/node/gate tables and registers writer-version UDF + write-guard
  triggers so already-open v7 connections fail closed with terminal `schema_changed` (Reload Window).
- Diagnostics never expose database paths, SQL/parameters, credentials, prompt text, or artifact bodies.

## 9. Verification (contributors)

```bash
npm run test:sqlite-storage-docs
npx vitest run src/task/sqlite/privacy-redaction.test.ts src/task/sqlite/migration-v8.test.ts
npm run test:source-boundary && npm run test:source-boundary:fixtures
```
