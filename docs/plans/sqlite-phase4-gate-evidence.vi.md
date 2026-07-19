# Phase 4 gate evidence

**Date:** 2026-07-17

**Schema:** `SQLITE_SCHEMA_VERSION = 7`

**Retention:** `CHANGE_FEED_RETAIN_REVISIONS = 4096`
**Status:** **Phase 4 COMPLETE — P4-W1 through P4-W11 closed.**

## Commits

| Wave | Hash | Message |
|------|------|---------|
| P4-W8 baseline | `0da76a5` | perf: batch durable transcript streaming |
| P4-W9 | `d04bd2e` | feat: add bounded workspace change feed |
| P4-W10 | `b031242` | feat: synchronize sqlite changes across windows |
| P4-W11 | `0f8da39` | feat: complete phase 4 sqlite synchronization gates |
| First hardening | `c8e09c2` | fix: harden phase 4 multi-window and durable restore paths |
| Final audit | this commit | close feed snapshots, reconciliation fences, durable surfaces and final gates |

## W9 — bounded change-feed contract

- `getWorkspaceChangesSince` reads current revision, low watermark, revision page and
  metadata in one SQL statement/implicit read snapshot. WAL writers cannot interleave
  append/prune between separate host reads.
- Cursor is a revision boundary. A page contains at most 512 revisions and never splits
  a revision; materialization is capped at 4096 metadata rows. Oversize/partial/corrupt
  input fails into bounded recovery.
- Explicit `change_feed_watermarks` produces a discriminated `gap`; an empty list is not
  guessed as a gap. Retention keeps 4096 revisions.
- Feed contains opaque entity IDs/change kinds only. Canonical workspace URI/path is not
  exposed; turn changes carry task scope and cascade deletes carry a recovery marker.

## W10 — multi-window convergence

- Poller runs only for visible/focused/hydrated UI, from 250 ms active to 5 s idle.
  Focus/visibility changes first deliver an authoritative bounded snapshot; a hidden or
  unhydrated view never advances the applied cursor without publishing state.
- Sticky `data_version` cannot hide a failed apply: observed revision remains ahead until
  reconciliation or recovery really advances the cursor.
- Reconciler drains feed, hydrates affected task/activity/transcript IDs, then checks an
  end-revision fence. A concurrent writer expands the same reconciliation loop; limits are
  8 stability attempts, 1024 revisions and 16384 metadata rows.
- Coordination-only changes advance revision without full projection refresh. Queue
  visibility resolves user messages through `turn_inputs`, so external queued follow-ups
  do not flash into chat before promotion. Protocol v9 carries `transcriptItemsRemoved`
  for stable-ID deletes; cascades/retention without a complete entity list still use bounded
  snapshot recovery.
- Automated UAT uses independent SQLite clients/workers and covers interleaved commits,
  concurrent writer during hydration, prune gap, no N+1 hydration and reducer convergence.

## W11 — durable surfaces

| Surface | Canonical ownership |
|---------|---------------------|
| Composer backend/model | VS Code Settings `muster.composerSelection` (application scope) |
| Pending/rejected sends | SQLite `send_outbox`; strict versioned payload, 32-row/workspace capacity trigger |
| Presentation documents | SQLite `presentations`, keyed by `(workspace_id, root_id, presentation_id)` |
| Presentation idempotency | SQLite `presentation_operations`; operation claim + revision update are atomic |
| Webview `setState` | Ephemeral UI chrome / opaque presentation IDs only; no message/document body |
| SecretStorage | Credentials only (unchanged) |

Outbox replay preserves `text`, `llmText`, mention bindings, skills, backend/model and
continuation. Every host reject/success path records rejection or attempts delete; durable
send receipts make a replay byte/idempotency-safe after transient cleanup failure.
Presentation restore is fail-closed, root-scoped and queued only until the SQLite store is
wired; exact opaque state, owner/revision fences, restart replay and dispose/error settlement
are regression-tested.

## Release benchmark (actual)

Command: `npm run bench:phase4-release:assert`

Mode: compiled `dist` JS + compiled SQLite worker, `node --expose-gc`

Machine: Apple M4, darwin arm64, 10 CPUs, Node v26.0.0
Fixture: 100,000 persisted messages total; 10,000 on focused task; 12 iterations.

| Metric | p50 | p95 / retained | Budget |
|--------|----:|---------------:|-------:|
| Activation @100k | 0.35 ms | 0.39 ms | < 300 ms p95 |
| Activation retained heap delta | — | 0.01 MiB | < 64 MiB |
| Focus latest 100 | 11.02 ms | 11.51 ms | < 100 ms p95 |
| Load older page 100 | 11.85 ms | 12.13 ms | < 100 ms p95 |
| Stream batch commit | 0.15 ms | 0.45 ms | < 20 ms p95 |
| Bootstrap wire | — | 12.6 KiB | < 500 KiB |

Materialized focus rows = 100; all 10 concurrent stream commits persisted. Result:
**BUDGET PASS**.

## Packaged Extension Host smoke

`npm run test:sqlite-extension-host` packaged a fresh VSIX and ran it under VS Code
1.129.0 / Extension Host Node 24.18.0 with a fresh user-data directory. Verified:

- extension activation and built-in `node:sqlite` availability;
- packaged compiled SQLite worker/client/schema resolution;
- Muster `application_id`, `foreign_keys=1`, WAL and `user_version=7`;
- `change_log`, `change_feed_watermarks`, `send_outbox`, `presentations`,
  `presentation_operations` and `trg_send_outbox_capacity` in the packaged schema.

## Live two-window Extension Host UAT

Command: `npm run test:sqlite-two-window-live-uat`

This is **not** dual-`DbClient` unit coverage. The harness packages a fresh VSIX,
launches **two real VS Code windows / Extension Hosts** (separate `--user-data-dir`,
same workspace folder), and shares one Muster global-storage directory via symlink
so both resolve the same `muster.sqlite3`.

Proof of shared DB (redacted): both hosts report equal `dbFileToken` / `workspaceId` /
`userVersion=7` / `application_id` / WAL. The runner verifies distinct Extension Host
sessions but stores only the boolean result, never either session ID.

| Scenario | Result | Detail (content-safe) |
|----------|--------|------------------------|
| A peer create converges | PASS | B converged to rev=1 without Reload Window |
| B follow-up converges | PASS | A converged after B write rev=2 |
| C interleaved writes | PASS | contiguous revs 3→4→5; both hosts same task set |
| D queue then promote | PASS | queued hidden; promote visible once |
| E hide/reveal catch-up | PASS | real sidebar hide stops polling; reveal rehydrates rev=8 |
| F transcript paging | PASS | production route returns latest=2, older=6 |
| G delete patch | PASS | protocol-v9 remove converges on both hosts without recovery |
| H durable outbox/presentation | PASS | peer restarts; pending replay rejects safely; both hosts read durable state |
| I simultaneous writers | PASS | final rev=24, 6 tasks, dbFileToken match |

Artifact: `docs/plans/sqlite-phase4-two-window-live-uat-evidence.json`
VS Code 1.129.0 / Extension Host Node 24.18.0 / schema 7. The live gate found and
closed interleaved-local revision skipping plus missing transcript-remove routing before pass.

UAT-only surface: `muster.uat.*` commands register only when `MUSTER_UAT_MODE=1` **and**
`ExtensionMode` is non-production.

## Final gates

| Gate | Result |
|------|--------|
| Targeted W9–W11 tests | 7 files / 148 tests pass |
| `npx tsc -p . --noEmit` | pass |
| `npm run check:svelte` | 0 errors; 1 pre-existing textarea a11y warning |
| `npm run build:webview` | pass |
| `npm test` | 118 files / 1678 tests pass |
| `npm run test:source-boundary` | pass after current entity matrix update |
| `npm run test:source-boundary:fixtures` | 13/13 pass |
| `npm run bench:phase4-release:assert` | BUDGET PASS |
| `npm run test:sqlite-extension-host` | pass on packaged VSIX |
| `npm run test:sqlite-two-window-live-uat` | PASS scenarios A–I (two real EH) |
| `git diff --check` | clean |

Crash/open/locking coverage remains in the SQLite connection/crash suites; W8 retains the
injected persist-failure/disk-full streaming test. Broader backup/corrupt-database recovery
UX remains Phase 5 hardening, not an unfinished Phase 4 compatibility path.

## Known non-blocking warnings

- Svelte reports the pre-existing `aria-expanded` warning on the Composer textarea.
- VSIX packaging reports the existing large unbundled dependency/file-count warning.
