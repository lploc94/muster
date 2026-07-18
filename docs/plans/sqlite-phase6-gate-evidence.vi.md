# SQLite Phase 6 — Gate Evidence

## Scope

Virtualization + cleanup closeout for `docs/plans/sqlite-global-storage-refactor.vi.md` Phase 6.

## Commits

| Wave | Hash | Message |
|------|------|---------|
| P6-W1 | `f4c62bc` | perf: virtualize large chat transcripts |
| P6-W2 | `3558914` | perf: virtualize expanded task trees |
| P6-W3 | `4c7d36b` | test: close sqlite phase 6 virtualization gates |
| harden | `277fffd` | fix: harden phase 6 virtualization closeout |

Baseline: `a5864fc`.

## Caller matrix (retained)

| Surface | Production callers | Obligation | Proof |
|---------|-------------------|------------|-------|
| `RepositoryProjection` | `engine.ts`, `external-workspace-reconciler.ts` | Bounded engine observation | `repository-projection.test.ts` |
| `buildRepositorySnapshot` | `extension.ts` | Bootstrap/focus snapshot | `repository-snapshot.test.ts` |
| `projectWorkspacePatches` / snapshot projectors | `extension.ts`, reconciler, export | Incremental UI + export | `workspace-patch.test.ts`, `snapshot.test.ts` |
| `renderTaskMarkdownExport` | `task-export-route.ts` | Point-in-time Markdown export | `task-markdown-export.test.ts`, `test:task-export-docs` |
| `backupOpenDatabase` / `resetOpenDatabase` | `sqlite/worker.ts` (via maintenance commands) | Worker-owned recovery | `backup.test.ts`, `reset.test.ts`, `test:sqlite-storage-docs` |

**Deleted in P6:** none. Pre-incremental dead paths were already removed in P4/P5; W1/W2 only virtualized mounted DOM.

## Measured limits (release webview / Chromium)

Tracked artifact: [`sqlite-phase6-webview-evidence.json`](./sqlite-phase6-webview-evidence.json) (redacted, allowlisted).

- Chat: peak mounted transcript rows ≤ 80; retained heap ≤ 16 MiB; final ≤ 1.5× baseline; DOM peak/final vs baseline +2500/+250.
- Tree: peak mounted task rows ≤ 100; same heap/DOM formulas on 5000-row expanded tree.
- Commands: `npm run bench:phase6-webview`, `npm run test:phase6-webview`, plus preservation gates (`compile`, `check:svelte`, `npm test`, `test:webview`, storage/export docs, source-boundary, phase5/phase6 evidence, phase4 release assert, schema-freeze).
- Result: **BUDGET PASS** (virtualization) and preservation gates green on closeout HEAD.

## Protocol docs

`docs/WEBVIEW.md` uses `loadTranscriptPage` / `transcriptPageResult` only (legacy transcript page aliases removed). Repository paging bounds bootstrap payloads; `@tanstack` **Virtualizer** bounds mounted DOM.

## Phase 6 status

**complete** after P6-W1…W3 gates and impl-review APPROVE.
