# Phase 4 gate evidence

**Date:** 2026-07-17
**Schema:** `SQLITE_SCHEMA_VERSION = 6`
**Retention:** `CHANGE_FEED_RETAIN_REVISIONS = 4096`
**Status:** Phase 4 IN PROGRESS (W9/W10 landed; W11 durability fixes applied; final COMPLETE not claimed).

## Commits

| Wave | Hash | Message |
|------|------|---------|
| P4-W8 baseline | `0da76a5` | perf: batch durable transcript streaming |
| P4-W9 | `d04bd2e` | feat: add bounded workspace change feed |
| P4-W10 | `b031242` | feat: synchronize sqlite changes across windows |
| P4-W11 | `0f8da39` | feat: complete phase 4 sqlite synchronization gates |
| Follow-up | (working tree) | durability/poller/outbox/presentation/reconciler fixes |

## Feed contract (W9)

- APIs: `getWorkspaceRevision`, `getStorageDataVersion`, `getWorkspaceChangesSince`
- Result: `changes | gap` discriminated union
- Cursor = revision boundary; page limit = number of revisions (never split multi-row revision)
- Explicit low watermark table `change_feed_watermarks`
- Metadata only: entity kind/id, optional task id, change kind
- Initial revision 0 → `retainedFromRevision = 1`

## Multi-window (W10)

- Poller: active 250 ms → idle factor 2 → max 5 s
- Runs only when webview visible AND window focused; immediate tick on start/focus/visible
- `lastDataVersion` commits only after applied revision catches observed revision
- Failed recovery keeps sticky-data_version re-entry via `observedRevision`
- External reconciler: feed → bounded projection refresh → contiguous `workspacePatchBatch`
- Intermediate revisions: empty batches; final revision carries reconciliation patches
- Gap/corrupt/unrepresentable → awaited bounded snapshot recovery
- `send_outbox` / `presentation` treated as coordination-only
- Focused transcript delete → recovery (no stale peer items)

## Durable cleanup (W11)

| Surface | Ownership |
|---------|-----------|
| Composer backend/model | VS Code Settings `muster.composerSelection` (Global) |
| Pending/rejected sends | SQLite `send_outbox` (reject/delete on every host path) |
| Presentation documents | SQLite `presentations` (fail-closed without store; queue restore) |
| Webview setState | Ephemeral UI chrome / opaque presentation IDs only |
| SecretStorage | credentials (unchanged) |

## Benchmark (actual)

Machine: darwin arm64, Node from host, mode `tsx-worker-release-contract`, fixture 10k focused transcript items, 12 iterations.

| metric | p50 | p95 | budget |
|--------|-----|-----|--------|
| focus latest 100 | 9.43 ms | 9.62 ms | < 100 ms |
| page 100 | 10.16 ms | 10.50 ms | < 100 ms |
| stream batch commit | 0.16 ms | 0.75 ms | < 20 ms |
| bootstrap wire | 12.3 KiB | — | < 500 KiB |
| materialized page rows | 100 | — | bounded ≤ 100 |

Command: `npm run bench:phase4-release:assert` → **BUDGET PASS** (worker contract path)

Open vs plan budgets:

- activation@100k messages p95 < 300 ms — not measured
- heap on large history — not measured
- packaged/release EH bench path — not used

## Gates

| Gate | Result |
|------|--------|
| `npx tsc -p . --noEmit` | re-run after durability fixes |
| `npm run check:svelte` | re-run after durability fixes |
| `npm run build:webview` / `npm run compile` | re-run after durability fixes |
| `npm test` | re-run after durability fixes |
| `npm run test:source-boundary` | prior pass |
| `npm run bench:phase4-release:assert` | prior BUDGET PASS |
| `npm run test:sqlite-extension-host` | prior pass (fresh user-data-dir) |

## UAT coverage (automated)

- Two-client interleaved writes + feed convergence
- Local write not re-applied by poller applied-cursor
- Gap after prune → recovery path
- Focused transcript hydrate-by-id (no full listMessages)
- Call-count batching (`listTasksByIds` + activity; no N+1 `getTask`)
- Outbox memory-only + host durable put/reject/delete all paths
- Outbox snapshot ordered before task snapshot; late outbox still replays pending
- Presentation restore via opaque IDs + SQLite store; fail-closed without store
- Composer Settings read/write (no globalState key)

## Not yet claimed as Phase 4 COMPLETE

- Full suite re-green after durability follow-up
- activation@100k / heap budgets
- Two real VS Code windows UAT artifact
- Disk-full / WAL crash as Phase-4 gate (Phase 5 territory unless re-scoped)

## Known pre-existing warnings

- Svelte a11y warning on Composer textarea `aria-expanded` (pre-existing)
- Some IDE/LSP noise on unrelated e2e/webview files (tests still pass under vitest)
