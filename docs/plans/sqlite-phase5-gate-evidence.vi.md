# Phase 5 gate evidence (P5-W7 closeout)

Cập nhật: 2026-07-18

## Scope

Packaged Extension Host fault UAT + Phase 4 regression gates cho Batch C / Phase 5.
Evidence redacted only — no paths, canaries, SQL, stacks, or session IDs.

## Packaged fault UAT

Command: `npm run test:sqlite-packaged-fault-uat`

Tracked matrix: [`sqlite-phase5-packaged-fault-uat-evidence.json`](./sqlite-phase5-packaged-fault-uat-evidence.json)

| Runtime class | VS Code | Node | Scenarios | Verdict |
|---|---|---|---|---|
| 1.101.0 | 1.101.0 | 22.15.1 | 12/12 PASS | PASS |
| stable | 1.129.1 | 24.18.0 | 12/12 PASS | PASS |

Scenario IDs (both runtimes):

- `corrupt_open`
- `not_a_database_open`
- `foreign_reject`
- `incompatible_reject`
- `write_full_rollback`
- `write_readonly_rollback`
- `busy_responsiveness`
- `backup_wal_writer`
- `backup_reopen_consistency`
- `reset_cancel`
- `reset_success`
- `cross_window_reset_contention`

## Phase 4 regression gates

| Gate | Command | Result |
|---|---|---|
| Packaged EH smoke (min) | `MUSTER_VSCODE_VERSION=1.101.0 npm run test:sqlite-extension-host` | PASS `backup=vacuum` vscode=1.101.0 node=22.15.1 |
| Packaged EH smoke (stable) | `MUSTER_VSCODE_VERSION=stable npm run test:sqlite-extension-host` | PASS `backup=api` vscode=1.129.1 node=24.18.0 |
| Live two-window UAT | `npm run test:sqlite-two-window-live-uat` | PASS scenarios A–I finalRevision=24 |
| Phase 4 release bench | `npm run bench:phase4-release:assert` | BUDGET PASS (activation p95 0.53ms, focus 12.37ms, stream 0.24ms, bootstrap 12.6 KiB) |

## Content safety

- redacted evidence only
- absolutePathsStoredInEvidence: false
- messageBodiesStoredInEvidence: false
- sessionIdsStoredInEvidence: false
- canaryStoredInEvidence: false

## Phase 5 status

P5-W1…W7 / Batch C / Phase 5 **complete** after all closeout gates green.
