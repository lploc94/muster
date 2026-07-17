# Phase 4 gate evidence

**Date:** 2026-07-17  
**Schema:** `SQLITE_SCHEMA_VERSION = 6`  
**Retention:** `CHANGE_FEED_RETAIN_REVISIONS = 4096`  
**Status:** Phase 4 COMPLETE; Phase 5 not started.

## Commits

| Wave | Hash | Message |
|------|------|---------|
| P4-W8 baseline | `0da76a5` | perf: batch durable transcript streaming |
| P4-W9 | (this series) | feat: add bounded workspace change feed |
| P4-W10 | (this series) | feat: synchronize sqlite changes across windows |
| P4-W11 | (this series) | feat: complete phase 4 sqlite synchronization gates |

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
- External reconciler: feed → bounded projection refresh → contiguous `workspacePatchBatch`
- Intermediate revisions: empty batches; final revision carries reconciliation patches
- Gap/corrupt/unrepresentable → bounded `postSnapshot` recovery

## Durable cleanup (W11)

| Surface | Ownership |
|---------|-----------|
| Composer backend/model | VS Code Settings `muster.composerSelection` (Global) |
| Pending/rejected sends | SQLite `send_outbox` |
| Presentation documents | SQLite `presentations` |
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

Command: `npm run bench:phase4-release:assert` → **BUDGET PASS**

## Gates

| Gate | Result |
|------|--------|
| `npx tsc -p . --noEmit` | pass |
| `npm run check:svelte` | 0 errors |
| `npm run build:webview` / `npm run compile` | pass |
| `npm test` | 115 files / 1650 tests pass |
| `npm run test:source-boundary` | pass |
| `npm run test:source-boundary:fixtures` | 13 pass |
| `npm run bench:phase4-release:assert` | BUDGET PASS |
| `npm run test:sqlite-extension-host` | pass (VSIX packages worker/client; EH opens node:sqlite; schema v6) |
| `git diff --check` | pass |

## UAT coverage (automated)

- Two-client interleaved writes + feed convergence
- Local write not re-applied by poller applied-cursor
- Gap after prune → recovery path
- Focused transcript hydrate-by-id (no full listMessages)
- Call-count batching (no N+1 activity queries)
- Outbox memory-only + host durable put/reject/delete
- Presentation restore via opaque IDs + SQLite store
- Composer Settings read/write (no globalState key)

## Known pre-existing warnings

- Svelte a11y warning on Composer textarea `aria-expanded` (pre-existing)
- Some IDE/LSP noise on unrelated e2e/webview files (tests still pass under vitest)
