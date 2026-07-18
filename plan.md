# Complete SQLite Phase 6 Virtualization And Cleanup

## Target
Complete P6-W1 through P6-W3 so large loaded transcripts and expanded task trees retain bounded rendered DOM/heap while preserving paging, streaming, focus, tree interaction, Markdown export, SQLite recovery, and the Phase 4/5 storage contracts, then close Phase 6 with reproducible evidence and no verified dead storage/protocol path.

## Source Of Truth
- Plan schema: `loop-plan/v1`
- Request/report: User requested an execution-ready plan for all of Phase 6, divided into appropriate waves; authoritative scope is `docs/plans/sqlite-global-storage-refactor.vi.md:1112-1118`.
- Baseline commit: `a5864fc4262df8180b665acf7a54aca2ee90d916`
- Plan path: `plan.md`

## Current State
- Completed: SQLite Phases 1-5 are complete. Phase 4 already delivered bounded bootstrap/keyset transcript paging, lazy older-page loading, incremental `workspacePatchBatch` updates, streaming persistence, and multi-window synchronization (`b5e2ebb`, `4e6e095`, `d6dc5f5`, `d1dab9c`, `f18cc01`, `0da76a5`, `d04bd2e`, `b031242`, `0f8da39`); Phase 5 hardening/backup/reset/privacy/fault evidence is complete through baseline `a5864fc`. These flows must be integrated with, not rebuilt.
- Remaining: P6-W1 chat virtualization and large-history profiling gate; P6-W2 task-tree virtualization and large-tree interaction gate; P6-W3 profiling-backed cleanup audit, stale protocol-documentation cleanup, preservation gates, Phase 6 evidence, and source-plan closeout.
- Worktree: Clean at planning time. Branch `main` is ahead of `origin/main` by 40 commits and behind by 19; divergence is pre-existing and implementation must not rebase, reset, or push unless separately requested.

## Codebase Evidence
- Current flow: `src/extension.ts:MusterChatProvider.postSnapshotAsync/publishAfterCommit -> src/host/repository-snapshot.ts:buildRepositorySnapshot and src/host/workspace-patch.ts:projectWorkspacePatches -> webview/src/App.svelte snapshot/workspacePatchBatch/transcriptPageResult handlers -> webview/src/lib/tasks.svelte.ts:TasksState and webview/src/lib/thread.svelte.ts:TaskThread -> webview/src/components/TaskWorkspace.svelte:visibleTreeRows and webview/src/components/ChatThread.svelte:thread.items -> keyed Svelte #each DOM`; older transcript pages travel through `ChatThread.requestOlder -> loadTranscriptPage -> src/host/transcript-page-route.ts:routeLoadTranscriptPage -> src/task/repository.ts:SqliteTaskRepository.getTranscriptPage -> transcriptPageResult`.
- Existing tests: `webview/src/lib/chat-scroll.test.ts` proves pin, lock, older-page request, and prepend-anchor decisions; `webview/src/lib/transcript-page-reducer.test.ts` and `webview/src/lib/thread-page-metadata.test.ts` prove page ownership/metadata; `webview/src/lib/task-tree.test.ts` proves flatten/collapse/focused-path and owning-root behavior; `webview/src/lib/workspace-patch-reducer.test.ts` proves snapshot/patch convergence; `src/host/transcript-page-route.test.ts`, `src/host/repository-snapshot.test.ts`, and `src/task/transcript-page.test.ts` prove bounded keyset paging; `e2e/muster-webview-state.spec.ts` proves the real Svelte webview behavior from mocked host snapshots. None currently asserts a DOM or retained-heap ceiling for large chat/tree fixtures.
- Pattern to follow: `webview/src/lib/chat-scroll.ts` plus `ChatThread.svelte:requestOlder/applyRestoreFromAnchor` provide the stable-anchor, one-in-flight, pinned-tail pattern; `webview/src/lib/task-tree.ts:flattenTaskTreeCollapsible/defaultCollapsedIds/expandPathInCollapsed` provides the authoritative flattened row and expansion pattern; `scripts/bench-phase4-release.ts` plus `docs/plans/sqlite-phase4-gate-evidence.vi.md` provide the repository pattern for deterministic release-mode fixtures, explicit budgets, machine/runtime metadata, and tracked closeout evidence.
- Pattern fallback: No virtual-list implementation or dependency exists locally. Use the variable-size measured-row and fixed-size row patterns from `@tanstack/svelte-virtual` (already identified as an option in `docs/WEBVIEW.md:401-410`), with `ResizeObserver` measurement for chat and fixed row estimates for the task tree; pin the dependency in `package.json`/`package-lock.json` and keep adapter code local to the two webview surfaces rather than introducing a repository-wide abstraction.
  - Verified gap: `ChatThread.svelte:361` renders every resident `thread.items` entry and loaded older pages only grow that array; `TaskWorkspace.svelte:347` renders every `visibleTreeRows` entry when expanded. Therefore rendered elements scale one-for-one with loaded history/visible tree width, contrary to the Phase 6 gate “DOM/heap bounded trên history lớn.” Production contains no confirmed dead SQLite projection/cache candidate: `RepositoryProjection`, repository snapshots, workspace patches, Markdown export, backup, and reset all have live callers. The verified cleanup gap is stale pre-v9 protocol terminology (legacy transcript page aliases) in `docs/WEBVIEW.md:410-418` and the absence of a Phase 6 caller audit/evidence gate.

## Scope
- In scope: virtualize settled chat rows with variable-height measurement; preserve the streaming tail outside the settled virtual window; virtualize expanded task-tree rows; deterministic browser profiling for DOM and post-GC traversal heap; large-fixture interaction tests; update stale transcript protocol documentation; add a checked caller audit/evidence artifact; preserve Markdown export and SQLite recovery; update the source plan and close all Phase 6 gates.
- Out of scope: changing SQLite schema/fingerprint, retention semantics, transcript keyset ordering, repository paging direction, workspace patch wire shapes or protocol version, tree data pagination, Markdown export output, backup/reset behavior, telemetry, migration/backward compatibility, redesigning chat/tree UX, unrelated cleanup, or deleting a live projection/cache without measured redundancy and a complete caller replacement.

## Invariants
- Bootstrap remains bounded to `BOOTSTRAP_TRANSCRIPT_LIMIT`; older history remains host-owned and loaded through the existing one-in-flight `loadTranscriptPage`/`transcriptPageResult` contract with stable ownership and no duplicates or omissions.
- Streaming content remains a separate plain-text tail; settled Markdown/tool/reasoning rendering and chronological block headers remain semantically unchanged.
- A pinned chat follows the latest item/stream; an unpinned, locked, or prepend-restoring chat is never yanked to the bottom; focus/hydrate invalidates stale restore work.
- Virtualization changes mounted rows only, not `TaskThread` item ownership, workspace revisions, queued-turn previews, transcript export content, task selection, collapse state, focused-path visibility, status actions, or accessibility labels.
- Snapshot/recovery and `workspacePatchBatch` convergence remain authoritative; no full-history hydration or legacy JSON/storage path may return.
- `src/task/sqlite/schema.ts` and `src/task/sqlite/schema-fingerprint.ts` remain byte-identical to baseline `a5864fc` (and therefore to the Phase 5 schema baseline).
- Markdown export remains a bounded point-in-time export, not a backup; SQLite backup/reset/manual recovery remain worker-owned, fail-closed, redacted, and unchanged.

## Global Gates
| Gate | Command | Expected result |
|---|---|---|
| Types | `npm run compile` | TypeScript and webview production build pass. |
| Static/UI checks | `npm run check:svelte` | Svelte reports 0 errors. |
| Build | `npm run vscode:prepublish` | Packaged extension assets build successfully. |
| Full tests | `npm test && npm run test:webview && npm run test:phase6-webview && npm run test:sqlite-storage-docs && npm run test:task-export-docs` | All Vitest, legacy Chromium webview, Phase 6 virtualization browser, storage documentation, and Markdown export documentation tests pass. |
| Source boundaries/fixtures | `npm run test:source-boundary && npm run test:source-boundary:fixtures && npm run test:sqlite-phase5-evidence && npm run test:sqlite-phase6-evidence && git diff --exit-code a5864fc -- src/task/sqlite/schema.ts src/task/sqlite/schema-fingerprint.ts && git diff --check` | Existing and Phase 6 boundaries/evidence pass, canonical schema files are unchanged, and the diff has no whitespace errors. |

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
- Rounds: 3
- Open issues: None

## Phase 1: P6-W1 Bound Variable-Height Chat Rendering
- Status: complete
- Depends on: None
- Goal: Keep the mounted settled-chat DOM and traversal-retained heap bounded for large loaded transcript windows without changing paging, chronology, streaming, or scroll continuity.
- Current behavior: `webview/src/components/ChatThread.svelte:361-401` mounts one row for every `thread.items` entry; every successful older-page prepend increases mounted DOM, and Markdown/tool/reasoning descendants remain mounted even far outside the viewport. Existing scroll logic queries all mounted `[data-transcript-id]` rows and assumes every item has a DOM node, so naive slicing would break prepend anchoring and access to offscreen history.
- Code evidence: `webview/src/components/ChatThread.svelte:70-96,98-151,183-315,317-426`; `webview/src/lib/chat-scroll.ts`; `webview/src/lib/chat-scroll.test.ts`; `webview/src/lib/thread.svelte.ts:TaskThread`; `webview/src/lib/transcript-page-reducer.ts`; `webview/src/App.svelte` transcript page/event handlers; `e2e/muster-webview-state.spec.ts:openWebview/postSnapshot`; `docs/WEBVIEW.md:316-429`.
- Pattern to follow: Preserve `chat-scroll.ts` stable identity, pin/lock, and request state machine; integrate `@tanstack/svelte-virtual` measured variable-size rows as prescribed by `docs/WEBVIEW.md:401-410`, with the active streaming bubble outside the settled virtual items and top/bottom spacer sizing owned by the virtualizer.
- Behavioral contract:
  - For any loaded ordered transcript containing user, assistant, tool, error, and variable-height reasoning/content rows, only viewport rows plus bounded overscan are mounted; a 2,000-item fixture at the standard Playwright desktop viewport mounts at most 80 `[data-transcript-id]` rows and browser DOM-node count does not accumulate while traversing from newest to oldest and back.
  - Initial/focused chat opens at the latest content; `Scroll to latest` reaches the final settled row and streaming tail; pinned streaming follows growth, while unpinned or `scrollLocked` state preserves the user's position.
  - Reaching virtual top overscan requests exactly one older page using the existing cursor. Applying a variable-height prepend preserves the first visible transcript item and its viewport offset within 2 CSS pixels; stale responses after focus/hydrate or a lock transition obey the existing cancellation/wait rules.
  - Block-start backend headers, reasoning, Markdown footer selection, tool updates, cancellation/error presentation, and chronological item identity use the full transcript index/neighbor, not the virtual slice index, so window boundaries do not create or omit headers.
  - Browser resource sampling is deterministic: after the initial latest-row render, wait for two animation frames plus 100 ms, invoke `HeapProfiler.collectGarbage` twice, and record `Runtime.getHeapUsage.usedSize` plus `Memory.getDOMCounters.nodes` as `baselineUsedBytes`/`baselineDomNodes`; repeat the same settle/GC sequence after visiting deterministic oldest/middle/latest stops. Define `retainedDeltaBytes = max(0, finalUsedBytes - baselineUsedBytes)`. PASS requires `retainedDeltaBytes <= 16 * 1024 * 1024`, `finalUsedBytes <= 1.5 * baselineUsedBytes`, every sampled `domNodes <= baselineDomNodes + 2500`, and `finalDomNodes <= baselineDomNodes + 250` in addition to the 80-row ceiling.
- Tests first:
  - Add `webview/src/lib/chat-virtualization.test.ts` for pure range/index/anchor integration helpers: variable estimates, overscan bounds, full-list neighbor lookup at virtual boundaries, and stale focus/prepend transitions; the pre-change implementation lacks these helpers and fails for absence of a bounded range.
  - Add `e2e/muster-webview-virtualization.spec.ts` with a protocol-conformant generated 2,000-item mixed-height history: bootstrap at most 100 latest items, then drive 19 deterministic matching `loadTranscriptPage`/`transcriptPageResult` exchanges of at most 100 older items each. At every page assert one in-flight request, matching request/task/cursor ownership, exact accumulated ID order/cardinality with no duplicates/omissions, anchor continuity, and `locator('[data-transcript-id]').count() <= 80`; after loading all pages, reach middle/oldest/latest identities and verify header/reasoning rendering at virtual boundaries.
  - In the same Playwright fixture, compare the anchor row's bounding-box Y before/after each short/tall page within 2 px and replace focus while one page is in flight to prove stale response cancellation. A direct 2,000-item snapshot is permitted only inside the isolated resource benchmark, never as the paging-contract acceptance scenario.
  - Add a streaming scenario that appends deltas while pinned and unpinned and verifies only the streaming bubble changes, plus a tool patch for an offscreen item that becomes correct when scrolled into view.
  - Add `scripts/bench-phase6-webview.mjs` and package scripts `bench:phase6-webview`/`test:phase6-webview` to launch the production webview build in Chromium, use CDP `HeapProfiler.collectGarbage`, `Runtime.getHeapUsage`, and `Memory.getDOMCounters`, traverse the fixture with the exact settle/sample formula above, and emit/assert fixture size, viewport, mounted transcript rows, baseline/peak/final DOM nodes, baseline/final heap, retained delta, duration, runtime versions, and threshold result. Update `test:webview` to run both `e2e/muster-webview-state.spec.ts` and `e2e/muster-webview-virtualization.spec.ts` so repository-wide webview gates cannot omit Phase 6 interactions.
- Anti-shortcut coverage:
  - The fixture mixes 1-line and multi-kilobyte Markdown, tool cards, reasoning, and errors, then accesses first/middle/last identities and patches an offscreen tool. This rejects hardcoded “render the last N,” fixed-height arithmetic, CSS-only hiding, dropping items from `TaskThread`, and virtual-slice-local header logic; the DOM/heap traversal oracle rejects retaining every row invisibly or leaking measured elements.
- Implementation obligations:
  - Add and pin `@tanstack/svelte-virtual`; update the lockfile. Keep a narrow chat-specific adapter/helper under `webview/src/lib/` rather than modifying repository/protocol data contracts.
  - Refactor `ChatThread.svelte` to virtualize only settled `thread.items`, measure each keyed row with `ResizeObserver`/virtualizer measurement, use full item indexes for chronology, and retain `data-transcript-id` on mounted rows for anchors/tests/accessibility.
  - Replace all-row DOM scans and direct `scrollHeight` assumptions with virtualizer-aware first-visible identity, offset restoration, scroll-to-index/latest, and total-size calculations while preserving epoch/request ownership and lock behavior.
  - Keep loading/retry chrome and active streaming bubble outside the settled virtual range; ensure their measured heights participate correctly in top-trigger and pinned-bottom calculations.
  - Do not cap, reorder, clone, or discard `TaskThread.items`; do not alter host queries, cursors, patch ownership, protocol version, export, or persistence. Fix benchmark/test failures in the real ChatThread path rather than special-casing fixture IDs or test mode.
- Acceptance criteria:
  - [x] AC-1: A production-build 2,000-item mixed transcript loaded from a <=100-item bootstrap through 19 owned pages mounts at most 80 transcript rows, has exact ID order/cardinality without duplicates/omissions, reaches first/middle/last, keeps `retainedDeltaBytes <= 16 MiB`, `finalUsedBytes <= 1.5 * baselineUsedBytes`, sampled DOM within baseline +2500, and final DOM within baseline +250 - proven by `e2e/muster-webview-virtualization.spec.ts` and `scripts/bench-phase6-webview.mjs`.
  - [x] AC-2: Matching older-page prepend keeps the prior first-visible row within 2 px, sends one request, and stale focus/lock cases do not restore the wrong window - proven by `e2e/muster-webview-virtualization.spec.ts`, `chat-virtualization.test.ts`, and existing `chat-scroll.test.ts`.
  - [x] AC-3: Pinned/unpinned streaming, offscreen tool patching, block headers, reasoning, and latest-footer behavior remain correct across virtual boundaries - proven by the mixed-content and streaming Playwright scenarios.
  - [x] AC-4: Transcript persistence, paging, snapshot, and reducer contracts are unchanged - proven by focused host/reducer suites and inspection showing no protocol/repository/schema edits.
- Focused verification:
  - `npx vitest run webview/src/lib/chat-virtualization.test.ts webview/src/lib/chat-scroll.test.ts webview/src/lib/transcript-page-reducer.test.ts webview/src/lib/thread-page-metadata.test.ts src/host/transcript-page-route.test.ts src/host/repository-snapshot.test.ts src/task/transcript-page.test.ts && npm run test:phase6-webview && npm run bench:phase6-webview`
- Phase gates:
  - `npm run compile && npm run check:svelte && npm run test:webview && npm run test:phase6-webview && npm run test:source-boundary && git diff --exit-code a5864fc -- src/task/sqlite/schema.ts src/task/sqlite/schema-fingerprint.ts && git diff --check`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `perf: virtualize large chat transcripts`

## Phase 2: P6-W2 Bound Expanded Task-Tree Rendering
- Status: complete
- Depends on: Phase 1
- Goal: Keep expanded task-tree DOM bounded for wide/deep owning-root subtrees while preserving collapse, selection, status actions, focused-path visibility, and snapshot/patch convergence.
- Current behavior: `TaskWorkspace.svelte:52-68` builds and flattens the full owning-root subtree, and `TaskWorkspace.svelte:347-453` mounts every `visibleTreeRows` entry when tree chrome is expanded. Default depth collapse limits deep descendants but does not bound wide levels or user-expanded branches; there is no large-tree test or virtual row window.
- Code evidence: `webview/src/components/TaskWorkspace.svelte:34-68,135-189,330-455`; `webview/src/lib/task-tree.ts:81-109,174-218,227-267`; `webview/src/lib/task-tree.test.ts`; `webview/src/lib/tasks.svelte.ts:TasksState.applySnapshot/applyPatchView`; `webview/src/lib/workspace-patch-reducer.ts`; `e2e/muster-webview-state.spec.ts` task-tree scenarios.
- Pattern to follow: Reuse the Phase 1 pinned `@tanstack/svelte-virtual` integration, but use its fixed/remeasured row-list pattern over the authoritative `flattenTaskTreeCollapsible` output; preserve `task-tree.ts` as the source for order, depth, collapse, and focused-path expansion.
- Behavioral contract:
  - Expanding a 5,000-visible-row owning-root tree mounts at most 100 `[data-testid="task-tree-row"]` rows at the standard Playwright viewport while first, middle, focused, and final visible rows remain reachable in DFS order.
  - Tree expansion/collapse recomputes the virtual count without stale blank space; collapsing a branch removes descendants, expanding restores them, and focus-driven ancestor expansion scrolls the selected/focused row into view without expanding unrelated siblings.
  - Clicking a virtualized row posts the same `focusTask`; opening a row's status menu and choosing an action posts the same lifecycle command; recycling never transfers focused/menu/ARIA state or `data-task-id` to another task.
  - Same-owning-root snapshots/patches preserve tree chrome and valid collapse overrides according to existing rules; owning-root/focus/draft transitions reset state as before. Incremental upsert/remove changes the correct flattened/virtual row set without duplicate keys.
  - Tree virtualization does not change host `rootTasks`/`subtree` projection, protocol shape/version, or task store/repository behavior.
- Tests first:
  - Extend `webview/src/lib/task-tree.test.ts` with generated wide/deep 5,000-node fixtures proving deterministic DFS order, collapse counts, focused-path expansion, and update/removal behavior independently of row mounting.
  - Extend `e2e/muster-webview-virtualization.spec.ts` with a 5,000-row expanded-tree snapshot; assert mounted row count `<= 100`, first/middle/last reachability, DFS labels/depth indentation, and focused-row visibility.
  - Add Playwright interactions across recycled ranges: collapse/expand a branch, select a far row and inspect the exact posted `focusTask`, apply the authoritative focus snapshot, open that row's status menu and inspect the lifecycle message, then patch/remove rows before the viewport and assert stable task identity/scroll continuity.
  - Add the tree fixture to `bench:phase6-webview`, recording visible logical rows, maximum mounted rows/DOM nodes, traversal heap, and duration. After initial expanded-tree render and after deterministic final-row/middle/focused/first-row/latest stops, use the Phase 1 two-frame + 100 ms + double-GC sampling procedure. Require `retainedDeltaBytes <= 16 * 1024 * 1024`, `finalUsedBytes <= 1.5 * baselineUsedBytes`, every sampled `domNodes <= baselineDomNodes + 2500`, and `finalDomNodes <= baselineDomNodes + 250`.
- Anti-shortcut coverage:
  - A wide root defeats depth-only collapsing, a deep focused branch requires ancestor expansion, and operations on middle/final recycled rows reject rendering only the first N/last N, CSS hiding, replacing the tree with a flat list, using array indexes as identity, or disabling menus/actions outside the initial viewport.
- Implementation obligations:
  - Introduce a bounded scroll viewport only for expanded tree chrome and virtualize `treeRows` with stable task IDs, fixed estimates plus measurement where status menus change height, and overscan sufficient for keyboard/pointer continuity; the collapsed single-row chrome remains unchanged.
  - Preserve `buildTaskTree`, `defaultCollapsedIds`, `expandPathInCollapsed`, and `flattenTaskTreeCollapsible` semantics. Recompute/measure after collapse, status-menu, snapshot, and patch changes; scroll focused/pending navigation into view when necessary.
  - Keep row presentation, indentation cap, twisties, role icons, lifecycle status/menu, ARIA attributes, tooltip text, Escape handling, and `navSelectTask`/`setLifecycle` messages behaviorally identical.
  - Reuse the Phase 1 dependency and established adapter style without creating a generic framework or changing host/protocol/storage code. Ensure a row leaving the virtual range closes or correctly reanchors its status menu rather than leaking menu state onto a recycled row.
- Acceptance criteria:
  - [x] AC-1: A 5,000-visible-row expanded tree mounts at most 100 task rows, traverses first/middle/last in DFS order, keeps `retainedDeltaBytes <= 16 MiB`, `finalUsedBytes <= 1.5 * baselineUsedBytes`, sampled DOM within baseline +2500, and final DOM within baseline +250 - proven by Phase 6 Playwright and benchmark tree scenarios.
  - [x] AC-2: Collapse/expand, deep focused-path reveal, selection, lifecycle menu action, patch insertion/removal, owning-root change, and draft reset retain exact task identity and existing state rules - proven by `task-tree.test.ts` and large-tree Playwright interactions.
  - [x] AC-3: No tree pagination, wire, repository, or schema behavior changes - proven by reducer/snapshot focused tests and diff inspection.
- Focused verification:
  - `npx vitest run webview/src/lib/task-tree.test.ts webview/src/lib/workspace-patch-reducer.test.ts src/host/snapshot.test.ts src/host/repository-snapshot.test.ts src/host/workspace-patch.test.ts && npm run test:phase6-webview && npm run bench:phase6-webview`
- Phase gates:
  - `npm run compile && npm run check:svelte && npm run test:webview && npm run test:phase6-webview && npm run test:source-boundary && git diff --exit-code a5864fc -- src/task/sqlite/schema.ts src/task/sqlite/schema-fingerprint.ts && git diff --check`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `perf: virtualize expanded task trees`

## Phase 3: P6-W3 Audit Cleanup And Close Phase 6
- Status: complete
- Depends on: Phase 2
- Goal: Remove the verified stale protocol documentation, prove every retained projection/cache/storage path has a live obligation, preserve export/recovery, publish reproducible P6 evidence, and mark Phase 6 complete.
  - Current behavior: `docs/WEBVIEW.md:410-418` still names removed legacy transcript page aliases although production uses `loadTranscriptPage`/`transcriptPageResult`. The master plan has only a high-level P6 gate and no Phase 6 evidence artifact/verifier. Caller tracing found no production projection/cache safe to delete: `src/task/repository-projection.ts:RepositoryProjection`, `src/host/repository-snapshot.ts:buildRepositorySnapshot`, `src/host/snapshot.ts` projectors, and `src/host/workspace-patch.ts` are all live; export and recovery are explicitly required.
- Code evidence: `docs/WEBVIEW.md:401-429`; `docs/plans/sqlite-global-storage-refactor.vi.md:1112-1118`; `src/task/repository-projection.ts:RepositoryProjection/withRepositoryProjection` called by `src/task/engine.ts` and `src/host/external-workspace-reconciler.ts`; `src/host/repository-snapshot.ts:buildRepositorySnapshot` called by `src/extension.ts`; `src/host/snapshot.ts:buildTranscript/projectTaskSummary` called by repository snapshot, workspace patches, reconciler, and `src/host/task-markdown-export.ts`; `src/host/task-export-route.ts`; `src/task/sqlite/backup.ts`; `src/task/sqlite/reset.ts`; `src/host/sqlite-maintenance-commands.ts`; `scripts/repository-boundary-smoke.mjs`; Phase 4/5 evidence verifier patterns.
- Pattern to follow: Follow `scripts/verify-sqlite-phase5-evidence.test.mjs` plus `scripts/sqlite-phase5-evidence-schema.mjs` for allowlisted, mutation-tested evidence validation; follow `scripts/repository-boundary-smoke.mjs` for forbidden dead protocol/full-hydration markers; follow `docs/plans/sqlite-phase5-gate-evidence.vi.md` for command/result/commit closeout recording.
- Behavioral contract:
  - Documentation names only the shipped v9 transcript messages and accurately explains that repository paging bounds bootstrap/query payloads while virtualization bounds mounted DOM; it does not claim the full transcript is resident, encrypted, automatically restored, or exported as a backup.
  - A checked Phase 6 caller matrix lists each retained projection/cache/storage/export/recovery surface, its production callers, its current obligation, and the test/boundary proving it. The verifier fails if a listed symbol/path disappears, gains no production caller, or if forbidden legacy protocol/storage markers return.
  - Because baseline inspection found no redundant live projection/cache, this wave does not delete `RepositoryProjection`, snapshot projectors, workspace patches, export, backup, or reset. If revalidation finds a candidate changed by P6-W1/W2, deletion is allowed only when the same commit removes all production callers and adds a boundary/test proving the replacement; otherwise record it as retained, not speculative debt.
  - Phase 6 evidence is allowlisted and reproducible: baseline commit, W1/W2 implementation commits, runtime/browser/platform, fixture cardinalities/content classes, viewport, logical/mounted row maxima, baseline/peak/final DOM nodes, post-GC heap baselines/finals/retained deltas, exact formulas/thresholds, commands, and PASS results for chat/tree plus preservation gates. It contains no self-referential W3/final commit field and no conversation content, workspace paths, SQL, secrets, or user identifiers; W3 identity is resolved after commit from git history.
  - Markdown export parity and SQLite backup/reset/privacy/fault contracts remain green and Phase 4 release budgets do not regress. Closeout follows one non-circular order: run producer/behavioral gates; populate final evidence and provisional completion/status rows in the uncommitted source/execution-plan diff; run the evidence verifier and every final gate against that complete diff; obtain `codex-impl-review` APPROVE over the same diff; then commit once. The provisional markers become authoritative only when that approved W3 commit is created, and no post-review edit is permitted except fixes that trigger gates and review again.
- Tests first:
  - Add `scripts/sqlite-phase6-evidence-schema.mjs` and `scripts/sqlite-phase6-evidence-schema.test.mjs` with exact-key/type/range/runtime/result validation and mutation cases for missing fixture, excessive mounted rows/heap, FAIL status, unknown keys, absolute paths, canaries/content, SQL, stack traces, or non-finite metrics.
  - Add `scripts/verify-sqlite-phase6-evidence.test.mjs` and `test:sqlite-phase6-evidence`; validate `docs/plans/sqlite-phase6-webview-evidence.json`, the caller matrix in `docs/plans/sqlite-phase6-gate-evidence.vi.md`, completion markers, current `loadTranscriptPage`/`transcriptPageResult` terminology, and absence of stale legacy transcript page aliases.
  - Extend `scripts/repository-boundary-smoke.mjs` and its fixture tests with Phase 6 source/document boundaries that reject reintroduced unbounded ChatThread/TaskWorkspace direct full-list rendering and stale transcript protocol names while accepting the measured virtualizer integration.
  - Run focused export/recovery tests and verifiers before documentation/evidence edits to establish preservation, then mutation-test the new verifier so a copied PASS artifact or fixture-specific count cannot satisfy closeout.
- Anti-shortcut coverage:
  - Evidence mutation tests alter each independent chat/tree metric and inject forbidden content; boundary fixtures include deceptive CSS-hidden full lists and hardcoded fixture-count exceptions; caller-matrix verification resolves actual imports/call sites rather than accepting prose. This rejects fabricated PASS JSON, deleting live recovery/export/projectors to satisfy text search, or documenting cleanup without production/test evidence.
- Implementation obligations:
  - Correct stale protocol/performance sections in `docs/WEBVIEW.md`; do not rewrite unrelated architecture documentation.
  - Add the Phase 6 evidence schema, verifier, package script, tracked JSON, and Vietnamese gate ledger. Populate metrics only from final production-build benchmark output; keep machine variance metadata and exact commands.
  - Re-audit all callers listed under code evidence after W1/W2. Remove only artifacts made genuinely dead by those waves and update all imports/tests/boundaries atomically; baseline-live projection/cache/export/recovery surfaces must remain unless objective caller and profiling evidence proves replacement.
  - Run preservation suites for `task-markdown-export`, export route/docs, SQLite backup/reset/maintenance/privacy, repository projection/snapshot/patches, Phase 4 benchmark, and Phase 5 evidence. Do not rerun packaged fault/two-window UAT unless these production surfaces changed; if they did change, run their existing exact package gates before closeout.
  - Before final W3 verification/review, update `docs/plans/sqlite-global-storage-refactor.vi.md` with P6-W1/W2 commit hashes, label P6-W3 as the pending closeout commit discoverable by its unique proposed commit message (without attempting to embed its own hash), and record measured limits, retained/deleted caller audit, gate results, and provisional Phase 6 completion. In the same uncommitted diff, update this plan's phase statuses, Completion Criteria, and Progress Log; do not alter the already-approved Plan Review verdict. Run all gates and review that exact complete diff, then create the single W3 commit without further edits.
- Acceptance criteria:
  - [x] AC-1: Documentation and source boundaries contain only current transcript protocol terminology and reject stale/unbounded rendering fixtures - proven by Phase 6 verifier, repository-boundary fixture tests, and inspection.
  - [x] AC-2: Every retained/deleted projection/cache/storage/export/recovery surface has a verified caller/replacement and test oracle; no confirmed dead path remains and no live required path is removed - proven by the caller matrix verifier, focused suites, and final diff review.
  - [x] AC-3: Tracked evidence validates exact chat/tree DOM and heap thresholds from the final production build and mutation tests reject missing, excessive, fabricated, or sensitive evidence - proven by `test:sqlite-phase6-evidence` and `bench:phase6-webview`.
  - [x] AC-4: Markdown export, SQLite recovery/privacy, full tests, Phase 4 release budgets, schema freeze, and all global gates pass - proven by the listed phase/global commands.
  - [x] AC-5: The complete pre-review diff contains provisional source/execution-plan completion rows with W1/W2 hashes and identifies W3 by `test: close sqlite phase 6 virtualization gates`; all gates and W3 review approve that exact diff, which is then committed without edits. After commit those markers are authoritative, and `git log --oneline --grep='virtualize large chat transcripts\|virtualize expanded task trees\|close sqlite phase 6 virtualization gates' a5864fc..HEAD` resolves exactly one commit per wave - proven by both plan files, review record, and git log without a self-referential metadata commit.
- Focused verification:
  - `node --test scripts/sqlite-phase6-evidence-schema.test.mjs scripts/verify-sqlite-phase6-evidence.test.mjs scripts/repository-boundary-smoke.test.mjs && npx vitest run src/task/repository-projection.test.ts src/host/repository-snapshot.test.ts src/host/snapshot.test.ts src/host/workspace-patch.test.ts src/host/task-markdown-export.test.ts src/host/task-export-route.test.ts src/task/sqlite/backup.test.ts src/task/sqlite/reset.test.ts src/host/sqlite-maintenance-commands.test.ts src/task/sqlite/privacy-redaction.test.ts && npm run test:task-export-docs && npm run test:sqlite-storage-docs && npm run bench:phase6-webview`
- Phase gates:
  - `npm run compile && npm run check:svelte && npm run vscode:prepublish && npm test && npm run test:webview && npm run test:phase6-webview && npm run test:source-boundary && npm run test:source-boundary:fixtures && npm run test:evidence && npm run test:task-export-docs && npm run test:sqlite-storage-docs && npm run test:sqlite-phase5-evidence && npm run test:sqlite-phase6-evidence && npm run bench:phase4-release:assert && npm run bench:phase6-webview && git diff --exit-code a5864fc -- src/task/sqlite/schema.ts src/task/sqlite/schema-fingerprint.ts && git diff --check`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `test: close sqlite phase 6 virtualization gates`

## Completion Criteria
- [x] Every phase is complete and committed exactly once.
- [x] Every acceptance criterion is checked.
- [x] All global gates pass on final HEAD.
- [x] Final `codex-impl-review` verdict is APPROVE for the complete plan range.
- [x] Worktree is clean apart from pre-existing unrelated changes.

## Progress Log
| Phase | Status | Commit | Verification | Review |
|---|---|---|---|---|
| 1 | complete | f4c62bc | vitest chat helpers + phase6 webview 5/5 + bench BUDGET PASS + compile/svelte/boundaries green; schema unchanged; impl-review APPROVE (5 rounds) | APPROVE |
| 2 | complete | 3558914 | task-tree unit large fixtures + phase6 webview 6/6 + bench tree BUDGET PASS + existing tree chrome e2e; schema unchanged; impl-review APPROVE | APPROVE |
| 3 | complete | 4c7d36b (+ 277fffd) | phase6 evidence schema/verifier + WEBVIEW protocol cleanup + caller matrix + boundary scan; test:webview/phase6/bench/source-boundary green; schema unchanged; impl-review APPROVE; final-range harden APPROVE | APPROVE |
