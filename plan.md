# Workflow Worktree Materialization And Operational Graph View

## Target
When a workflow run is created—including a child workflow run—every new/unbound workflow node is immediately visible in the owning coordinator's worktree as an inert, status-bearing task shell; execution still creates turns, messages, sessions, and activations only when the node's dependency gate is satisfied. The workflow graph then accurately shows every node's state, all relevant dependency gates and input progress, the current execution frontier, and a usable whole-graph overview without changing durable reuse semantics.

## Source Of Truth
- Plan schema: `loop-plan/v1`
- Request/report: User request in conversation: refactor workflow visualization to meet owner expectations and fix lazy worktree task appearance.
- Baseline commit: `93d9561e623d3408af39952498132813a0462d06` (`feat: implement on-demand workflow graph modal with pan/zoom functionality`)
- Plan path: `plan.md`

## Current State
- Completed: The committed workflow graph modal renders a real DAG with node labels, basic status styling, reuse styling, one gate summary, feedback rounds, child runs, pan/zoom controls, request correlation, and on-demand loading. Durable node reuse already supports exact prior run/node/task bindings at arbitrary non-terminal destinations, partial reuse, mixed fan-in, reload, and concurrency.
- Remaining: `startWorkflowRun` and the separate `invokeChildGraphTask` path create `workflow_nodes` for all topology nodes but create `tasks`, turns, and messages only for executable entries or already-satisfied reuse boundaries. Pending consumer nodes therefore have `task_id = NULL` and cannot enter the ordinary task-tree snapshot until a later gate activation. The graph wire carries only one optional gate and no per-consumer/input execution activity; the reducer highlights only the first `active` node; `Fit view` resets rather than fitting. Workflow-start shell creation also needs to participate in the durable workspace revision/change feed rather than relying only on local projection refresh.
- Worktree: clean after baseline commit `93d9561`; do not reset or rewrite the user's commit.

## Codebase Evidence
- Current flow: `src/task/repository.ts:startWorkflowRun` builds one transaction at `5240`, inserts entry tasks only at `5947-5972`, inserts all `workflow_nodes` with pending non-entry rows at `5974-6019`, and materializes later consumers in the gate-completion path around `6234-6246`. The separate `invokeChildGraphTask` path creates child runs around `9400`, child entry tasks around `9501`, and pending child nodes around `9600-9608`. `src/task/repository-projection.ts:affectedTaskIds` (`263-314`) refreshes only task IDs returned by the command/result. `src/host/repository-snapshot.ts:buildRepositorySnapshotAttempt` (`119-190`) reads only real tasks; `src/host/snapshot.ts:buildSnapshot` (`721-800`) builds the worktree from those task rows. `webview/src/components/TaskWorkspace.svelte` renders the resulting task tree. Workspace revision/change-log publication is the separate cross-host path that must carry the new shell membership beyond a local refresh.
- Existing tests: `src/task/m018-s02-fan-in-next.test.ts` and `src/task/repository.test.ts` prove that a partially satisfied fan-in leaves the consumer taskless/pending, then creates it after the final contribution. `src/task/m018-s07-workflow-status-projection.test.ts` proves workflow status enrichment. `src/task/m024-s03-mid-tree-node-reuse.test.ts`, `src/task/m024-s03-mid-tree-reuse-durable.test.ts`, and `src/task/m024-s03-fan-in-reuse-durable.test.ts` prove exact reuse provenance, arbitrary non-terminal placement, mixed fan-in, reload, and no task/turn/message for reused nodes. `src/task/workflow-graph-webview-wiring.test.ts`, `src/task/m024-s04-workflow-graph-projection.test.ts`, `webview/src/lib/workflow-graph-view.test.ts`, and `e2e/muster-webview-state.spec.ts` cover the current graph surface.
- Pattern to follow: Use the existing transactional repository command pattern in `src/task/repository.ts:startWorkflowRun`, `invokeChildGraphTask`, and the later gate activation transaction; use `taskStatement`/`taskPayload` for schema-compatible task metadata, `RepositoryProjection.refreshTask/refreshTasks` for bounded hydration, the existing workspace revision/change-log transaction pattern for cross-host publication, `projectWorkspacePatches` for membership versus activity patches, and `WorkflowTaskStatusProjection.gates` (`src/task/workflow-types.ts:394-414`) as the established multi-gate projection shape.
- Pattern fallback: No existing project pattern creates inert workflow task shells. Use a schema-compatible optional workflow-managed marker in the persisted task payload, preserving the repository's separation between task lifecycle, workflow-node status, and turn execution. Do not create a parallel virtual `TaskSummary` identity system because the owner's explicit target is the existing worktree task surface.
- Verified gap: The current lazy materialization is intentional engine behavior, not a missing refresh: all topology nodes exist in `workflow_nodes`, but non-entry/unbound nodes have no task row until a complete gate causes the later materialization transaction. The graph is a real DAG, but its data model cannot identify all blocking consumers or distinguish a materialized/queued workflow node from a task currently executing.

## Scope
- In scope: Durable inert task shells for every unbound topology node at both top-level and child workflow start; exact activation of an existing shell when its gate completes; atomic workspace revision/change-log publication and external patch reconciliation; scheduler, manual-turn, lifecycle, deletion, budget, reload, and patch safeguards; all-gate/per-input graph projection; explicit node execution activity, display precedence, and exclusive progress/frontier derivation; workflow progress summary; correct multi-node status styling; real fit-to-bounds behavior; focused and full regression coverage.
- Out of scope: Changing `graph_v1` topology rules such as fan-out/cycles; adding new workflow reuse semantics; duplicating a prior workflow task as a new task for a reused destination; creating placeholder turns/messages/sessions; exposing prompts, artifact bodies, secrets, paths, or host-only workflow data to agent-facing tools; replacing the existing on-demand modal with an always-open panel.

## Invariants
- Every topology node still has exactly one durable `workflow_nodes` row per run.
- Every unbound/non-reused topology node has one stable task shell from start; reused destinations remain `task_id = NULL` with complete immutable source provenance and are represented as reused graph nodes rather than duplicated tasks.
- A shell has no turn, message, activation, session, runtime claim, or scheduler reservation until its dependency gate is satisfied.
- A shell cannot be manually sent, auto-promoted, or lifecycle-sealed as an ordinary task while its workflow gate is pending; only the workflow activation path may create its first turn.
- Gate completion updates the existing shell and creates exactly one activation/message/queued turn atomically; it never inserts a second task for the same node.
- `workflow_nodes.status`, task lifecycle, and turn execution activity remain separate axes. `active` must not be presented as currently executing unless a live turn/activity says so.
- Reuse remains exact and authorized by source run/node/task/artifact; terminal destinations remain rejected; unbound nodes still execute normally.
- Existing workflow policies remain correct: topology `maxTaskCount`/host child limits are checked against the full declared topology, workflow-turn reservations count actual activations rather than shells, concurrency counts live turns rather than shells, and aggregate/artifact limits remain enforced.
- Start and activation remain idempotent and revision-ordered; all newly visible shell tasks are returned in `affectedTaskIds` and published as one consistent snapshot/patch revision.
- A successful top-level or child workflow start records the shell task membership in one durable workspace revision/change-log batch atomically with the workflow claim and shell inserts; replay creates no duplicate revision or feed rows, and external reconciliation sees all shell IDs.
- Deleting/cancelling a workflow shell cannot leave a live gate or workflow run pointing at a deleted task; the operation must use the existing workflow cleanup/closure path or fail closed.
- Selecting a pending shell never fabricates transcript content and does not enable an ordinary composer send path.

## Global Gates
| Gate | Command | Expected result |
|---|---|---|
| Types/build | `npm run compile` | Pass; extension and webview build successfully |
| Static/UI checks | `npm run check:svelte` | Pass with 0 errors and 0 warnings |
| Full tests | `npm test` | All Vitest tests pass |
| Source boundaries/fixtures | `npm run test:source-boundary && npm run test:evidence` | Both commands pass |
| Workflow webview regression | `npx playwright test e2e/muster-webview-state.spec.ts --grep "M024 S05 workflow graph|assembled journey"` | All matching workflow/reload journeys pass |

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
- Open issues: None. Round 1 issues 1-3 were accepted and fixed; round 2 re-read the saved plan and approved it.

## Phase 1: Materialize complete workflow task shells safely
- Status: completed
- Depends on: None
- Goal: Make every unbound workflow node visible in the owning worktree immediately after start without making pending nodes executable.
- Current behavior: `startWorkflowRun` creates only executable entry task rows and later inserts consumer task rows when gates complete; `workflow_nodes` pending rows have `task_id = NULL`, so `listTasks`/`buildRepositorySnapshot`/`buildTaskTree` cannot render them. Existing fan-in tests intentionally assert this lazy behavior. The separate `invokeChildGraphTask` transaction has the same omission for child workflow consumers, so fixing only top-level start would leave child-run nodes appearing late.
- Code evidence: `src/task/repository.ts:startWorkflowRun` at `5240`, task insertion at `5947-5972`, workflow-node insertion at `5974-6019`, gate activation insertion at `6234-6256`; `invokeChildGraphTask` child-run creation around `9400`, entry task creation around `9501`, and pending child-node insertion around `9600-9608`; `src/task/repository-projection.ts:affectedTaskIds` at `263-314`; `src/host/repository-snapshot.ts:buildRepositorySnapshotAttempt` at `119-190`; `src/host/workspace-patch.ts:projectWorkspacePatches` at `345-393`; the existing workspace revision/change-log transaction path; `src/task/types.ts:MusterTask` at `271-379`; `src/task/readiness.ts:evaluateTaskReadiness` at `94-237`; `src/task/scheduler.ts:canPromoteTurn` at `104-180`.
- Pattern to follow: Reuse the existing deterministic workflow identity and task construction fields used for entry tasks, `taskStatement`, repository projection refresh, `taskUpserted`/`turnActivityChanged` patch classification, and the repository's existing atomic workspace revision/change-log publication. Use existing optional persisted task metadata conventions rather than a new SQL table or virtual tree identity.
- Behavioral contract:
  - At start, derive one stable task ID for each non-reused topology node, set its parent to the workflow caller/root, and persist its workflow run/node marker, role, goal, backend/model, capabilities, policy, and open lifecycle.
  - Persist all non-reused shell task rows and point their `workflow_nodes.task_id` at the shell in the same start transaction. Preserve `workflow_nodes.status = 'pending'` for non-entry nodes and the existing entry status/activation behavior.
  - Create turns/messages/activations only for executable entries and already-satisfied reuse boundaries. A pending shell must have no turn/message/session and must not consume a workflow-turn reservation.
  - When a gate becomes complete, update the existing shell's workflow node and insert the aggregate message, activation, and queued turn using the existing deterministic node identity. No second task insert is allowed.
  - Reused nodes remain taskless and source-pinned; unbound terminal nodes receive shells immediately but only activate after their incoming gate is satisfied.
  - Start results and projection refresh include all created shell IDs; the worktree receives all shell summaries in the same revision and they survive reload.
  - Both top-level and child workflow starts atomically publish one workspace revision and bounded task change-log membership for every shell; `projectWorkspacePatches` consumes the bounded result IDs so an external host receives one complete shell batch, and idempotent replay produces no duplicate revision/feed rows.
  - Shell selection is inspect-only while pending: no ordinary composer send/manual turn path may create a turn, and its display must explain that it is waiting for workflow inputs.
  - Shell deletion/cancellation is guarded through an existing workflow-safe closure path or returns a clear failure without deleting a live workflow-owned shell.
- Tests first:
  - Extend/add a SQLite durable fan-in fixture with at least two entries, a pending consumer, and a terminal sink. Start it and assert every unbound node has a task row, every shell has the expected parent/goal/marker, and only entry turns/messages/activations exist.
   - Assert `workflow_nodes` points to each shell, reused rows remain taskless, and `listTasks`/`listSubtree` returns all unbound nodes immediately.
   - Assert the start result's `affectedTaskIds`, `RepositoryProjection` refresh, `buildRepositorySnapshot`, and `projectWorkspacePatches` expose every shell as `taskUpserted` in one revision.
   - Extend `src/task/m018-s06-child-workflow-continuation.test.ts` to start a child graph with a pending consumer and assert immediate shell visibility, no pre-gate execution records, existing-shell activation identity, reload, and workflow-safe closure.
   - Add a two-repository/external-reconciliation fixture that observes one durable workspace revision and one bounded task change-log batch for all top-level and child-start shell IDs, then replays the same idempotency key and asserts no additional revision or feed rows.
  - Assert `evaluateTaskReadiness`, `pickRunnableTurns`/`canPromoteTurn`, and every user/agent turn-creation route reject a pending shell; assert no shell creates a session/resource/runtime claim.
  - Settle one producer and assert only gate/fill/status changes occur; settle the final producer and assert the existing consumer shell receives exactly one turn/message/activation and retains its ID.
  - Add reload, idempotent replay, mixed reuse, terminal-node, budget, and workflow-safe deletion/cancellation coverage.
- Anti-shortcut coverage:
  - Use a four/five-node fan-in chain and inspect the database before any producer settles; a solution that only eagerly creates entry tasks, refreshes once, or synthesizes empty turns fails.
  - Start a child workflow with a pending consumer and inspect the child run before any child producer settles; a solution that fixes only `startWorkflowRun` fails because the child invocation path remains lazy.
  - Assert task IDs before and after activation are equal and task/turn/message counts distinguish shells from actual executions; a solution that deletes/recreates tasks at activation fails.
  - Invoke direct turn creation/manual send against a shell and assert no queued turn is persisted; a solution relying only on “no turn currently exists” fails.
- Implementation obligations:
  - Add the smallest schema-compatible typed marker needed to identify workflow-managed shells in `MusterTask` payload hydration/serialization; keep `workflow_nodes` status authoritative and do not infer workflow ownership from missing turns alone.
  - Extend deterministic start identities/results to cover all non-reused node task IDs and return them as affected IDs without breaking existing `entryTaskId`/`entries` compatibility.
  - Change start transaction construction to insert shells separately from activation records; change gate activation to update the shell rather than insert a task.
  - Add scheduler/readiness/turn-creation guards for workflow shells and ensure pending shells do not enter host task scheduling, session creation, workflow-turn reservation, or concurrency accounting.
  - Update task summary/protocol state enough to render shell waiting status and disable unsafe lifecycle/composer actions; preserve transcript bounds by keeping shell transcript empty until activation.
  - Apply the same shell construction, workflow-node binding, gate activation, idempotency, and cleanup rules in `invokeChildGraphTask`; do not leave a second lazy child-run path.
  - Record the successful workflow claim, shell inserts, one workspace revision increment, and bounded task change-log entries atomically for both start paths; update `projectWorkspacePatches` to honor the bounded result `affectedTaskIds`, and prove external reconciliation plus replay without duplicate feed rows.
  - Define and implement safe delete/cancel behavior for shells, including workflow-node/gate/run consistency and `PRAGMA foreign_key_check` coverage.
  - Keep the existing start transaction, idempotency ledger, revision/change-log, retention, and host task-count/depth policy behavior intact.
- Acceptance criteria:
  - [x] AC-1: Immediately after starting a nontrivial top-level or child workflow, the owning worktree snapshot contains one visible shell task for every unbound topology node, including not-yet-executable consumers and unbound terminal nodes - proven by the new SQLite/repository snapshot test, child-continuation test, and the Playwright worktree journey.
  - [x] AC-2: The same start creates no turn/message/session/activation for pending shells and no shell is scheduler-runnable or manually sendable - proven by readiness/scheduler/turn-route tests and SQL assertions.
  - [x] AC-3: Completing a gate updates the pre-existing shell and creates exactly one activation/message/turn without changing its task ID - proven by durable fan-in activation tests.
  - [x] AC-4: Reused destinations remain taskless and source-pinned while all unbound nodes are visible; terminal reuse remains rejected - proven by M024 reuse regressions.
  - [x] AC-5: Start, activation, reload, and external patch reconciliation preserve all shell membership/statuses without duplicate or stale rows; each successful top-level or child start publishes exactly one revision/change-log batch and replay publishes none - proven by projection, patch, two-repository reconciliation, reload, and idempotency tests.
- Focused verification:
  - `npx vitest run src/task/m018-s02-fan-in-next.test.ts src/task/m018-s06-child-workflow-continuation.test.ts src/task/m024-s03-mid-tree-node-reuse.test.ts src/task/m024-s03-mid-tree-reuse-durable.test.ts src/task/m024-s03-fan-in-reuse-durable.test.ts src/task/repository-projection.test.ts src/host/repository-snapshot.test.ts src/host/workspace-patch.test.ts src/task/readiness.test.ts src/task/scheduler.test.ts`
- Phase gates:
  - `npm run compile`
  - `npm run check:svelte`
  - `npx vitest run src/task/m018-s02-fan-in-next.test.ts src/task/m018-s06-child-workflow-continuation.test.ts src/task/repository.test.ts src/task/repository-projection.test.ts src/host/repository-snapshot.test.ts src/host/workspace-patch.test.ts`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow): materialize inert task shells at start`

## Phase 2: Expose complete workflow execution and dependency state
- Status: completed
- Depends on: Phase 1
- Goal: Make the host graph data model explain which nodes are executing, waiting, completed, reused, or not started, and which consumer/input gates are blocking progress.
- Current behavior: `WorkflowGraphProjection`/`WorkflowGraphWireGraph` expose `status: string`, topology edges, reuse density, feedback/child runs, and one optional `activeGate`. `getWorkflowGraphForTask` reads at most two gates and selects one open/satisfied row; the gate has no consumer node ID or input details. The UI treats the first node with `status === 'active'` as the only active node, although entry node rows can be `active` while their turn is still `queued`.
- Code evidence: `src/task/workflow-types.ts:WorkflowTaskStatusProjection` at `394-414` and `WorkflowGraphProjection` at `416-455`; `src/task/repository.ts:getWorkflowGraphForTask` at `2570-2709`; `src/shared/workflow-graph-wire.ts:27-47`; `webview/src/lib/workflow-graph-view.ts:12-178`; workflow gate/fill schema and existing status projection queries around `src/task/repository.ts:2280-2545`.
- Pattern to follow: Reuse the existing bounded `gates: readonly WorkflowGateStatusProjection[]` shape and gate/fill count queries from `getWorkflowStatusForTask`; preserve the host-only closed parser and collection limits in `src/shared/workflow-graph-wire.ts`; use task/turn activity semantics already represented by `TaskSummary.currentTurnActivity` and `TurnActivity` in `src/host/snapshot.ts:34-95` rather than overloading workflow-node status.
- Behavioral contract:
  - Return every bounded dependency gate with its `gateId`, `consumerNodeId`, status, required/satisfied counts, and bounded per-input contribution state sufficient to identify which incoming edge/input is missing or supplied.
  - Return edges with stable input references and enough derived state to distinguish supplied/reused, supplied/live, pending, and blocking contributions without exposing artifact bodies.
  - Return every node on separate authoritative axes: `workflowNodeStatus` from the workflow row, `executionActivity` from task/turn/activation rows, and an explicit derived `displayState`/exclusive `progressBucket`. `executionActivity` distinguishes none, queued, executing, waiting-for-feedback, completed, failed, cancelled, and skipped as applicable; `active` alone must never imply a live executing turn.
  - Apply a deterministic precedence table: live or queued feedback/turn activity controls the execution indicator even when the workflow node row is already `succeeded`; otherwise succeeded/reused workflow status is green/completed, failed/cancelled/skipped workflow status controls its terminal outcome, an incomplete gate makes a pending shell waiting/blocked, and a never-activated shell after run closure remains not-started with a closed-run reason. Upstream succeeded nodes remain completed/green when a downstream node fails. Progress buckets are mutually exclusive and sum to total nodes.
  - Return a bounded workflow-level progress summary: total nodes, completed/reused nodes, queued/executing/waiting nodes, blocked nodes, not-started nodes, failed/cancelled/skipped nodes, and a deterministic frontier/active-node set, using the explicit exclusive bucket rules above.
  - Preserve diagnostics/truncation and fail-closed wire validation; no prompts, message bodies, artifact values, paths, credentials, or unbounded IDs cross the host/webview boundary.
  - Root-owner graph reads and worker-task graph reads use the same complete run projection; root selection remains deterministic and does not discard live gate state.
- Tests first:
  - Add repository projection tests for a fan-in graph where A is succeeded, B is queued/executing, B's consumer gate is partially satisfied, and C remains pending; assert all gates/consumer IDs/input states and activity fields.
  - Add a concurrent-entry test with two active workflow turns and assert both nodes are marked active/executing, not only the first node order entry.
  - Add tests for queued-but-not-executing, executing, waiting feedback, reused, succeeded, failed, cancelled, skipped, and never-activated nodes.
  - Add the cross-axis state matrix: a succeeded node with queued/executing feedback remains visibly live; an upstream succeeded node stays green when a downstream node fails; and a never-activated shell after run closure remains not-started/closed rather than being reported as executed or failed.
  - Assert progress buckets are exclusive and reconcile exactly to total nodes for each matrix case.
  - Extend wire parser tests for the new exact fields, bounds, malformed input, missing gate consumer identity, inconsistent counts, and forbidden body/path fields.
  - Add root-owner and worker-task integration tests proving the same run projection returns all gates and status data.
- Anti-shortcut coverage:
  - Assert multiple gates with different consumers are returned and the UI can locate the blocking gate by consumer node; a solution that preserves one `activeGate` or sorts/selects the first row fails.
  - Assert a node with workflow status `active` but a queued turn is displayed as queued/waiting, while a live turn is displayed as executing; a solution that renames `active` to `running` fails.
  - Assert a pending downstream node includes a concrete missing input/frontier reason; a solution that only adds aggregate counts fails.
  - Assert a succeeded node with a live feedback turn is not counted as completed at the same time, while an unrelated succeeded upstream node remains completed after downstream failure; a solution that collapses lifecycle and activity into one status fails.
- Implementation obligations:
  - Extend internal workflow graph projection types, repository SQL, host adapter, shared wire types, parsers, and bounded diagnostics consistently; keep field names and limits exact across every layer.
  - Join workflow nodes to the bounded task/turn/activation data already available in the repository, or add one bounded query, to derive execution activity without loading transcripts or bodies.
  - Query all relevant gates/fills within a fixed limit, include `consumerNodeId`, and retain deterministic ordering/truncation diagnostics.
  - Implement and test the explicit state precedence and exclusive progress-bucket truth table; derive progress/frontier from authoritative node/activity/gate state, not from array order or UI heuristics. Preserve reuse density and feedback/child-run data.
  - Update host and webview tests together so no caller can silently accept an older graph shape.
- Acceptance criteria:
  - [x] AC-1: A graph response identifies all nodes, all bounded consumer gates, each gate's progress, and the exact missing/supplied incoming input state - proven by the fan-in repository and wire tests.
  - [x] AC-2: Queued, executing, waiting, completed, reused, failed, cancelled/skipped, and not-started states are distinguishable with explicit cross-axis precedence; live feedback overrides stale terminal display for that node, while unrelated succeeded upstream nodes remain green and never-activated closed-run shells remain not-started - proven by the activity/state matrix tests.
  - [x] AC-3: Multiple concurrently executing nodes and multiple live gates are represented simultaneously - proven by concurrent repository/protocol tests.
  - [x] AC-4: Root-owner and worker-focused graph requests return the same bounded state for the selected run, with no sensitive payload leakage - proven by host route and privacy assertions.
  - [x] AC-5: Progress/frontier counts are deterministic, bounded, mutually exclusive, and sum to total nodes across partial gate fills, reuse, feedback, and failure/closure states - proven by projection tests.
- Focused verification:
  - `npx vitest run src/task/m018-s07-workflow-status-projection.test.ts src/task/m024-s04-workflow-graph-projection.test.ts src/host/workflow-graph.test.ts src/host/workflow-graph-route.test.ts src/shared/workflow-graph-wire.test.ts`
- Phase gates:
  - `npm run compile`
  - `npm run check:svelte`
  - `npx vitest run src/task/m018-s07-workflow-status-projection.test.ts src/task/m024-s04-workflow-graph-projection.test.ts src/host/workflow-graph.test.ts src/host/workflow-graph-route.test.ts src/shared/workflow-graph-wire.test.ts`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow): expose complete gate and execution state`

## Phase 3: Deliver an operational graph view and end-to-end worktree journey
- Status: completed
- Depends on: Phase 2
- Goal: Let an operator understand the full workflow at a glance: all nodes are visible, statuses are truthful and visually distinct, blockers/frontier are obvious, progress is summarized, and the graph fits the available modal.
- Current behavior: `WorkflowGraphCanvas.svelte` renders a real layered DAG and basic status styling, but `workflow-graph-view.ts` marks only the first `active` node, the modal displays one detached gate, there is no workflow progress summary, and `fitView()` is identical to reset. The canvas exposes node buttons without wiring `onNodeClick` to a meaningful action.
- Code evidence: `webview/src/lib/workflow-graph-view.ts:12-178`; `webview/src/components/WorkflowGraphCanvas.svelte:15-120`; `webview/src/components/WorkflowGraphModal.svelte:7-181`; `webview/src/lib/workflow-graph-layout.ts:36-136`; current E2E coverage at `e2e/muster-webview-state.spec.ts` workflow graph tests and source wiring at `src/task/workflow-graph-webview-wiring.test.ts`.
- Pattern to follow: Keep the pure reducer/layout split already used by `workflow-graph-view.ts` and `workflow-graph-layout.ts`; follow existing Svelte 5 `$state`/`$derived` patterns, modal focus restoration, bounded `TaskSummary` status copy, and `untrack`-guarded on-demand store synchronization in `webview/src/App.svelte`.
- Behavioral contract:
  - Render every returned node in a deterministic layered DAG with visible status text and semantic colors/icons: succeeded/reused green, executing attention, queued/waiting blue, blocked/missing-input warning, failed red, and not-started/pending neutral or informational.
  - Highlight every executing node, not merely the first array item; queued and waiting nodes must not be labeled currently executing.
  - Associate each gate/input state with its consumer node and incoming edge, visibly showing which inputs are supplied, reused, pending, or blocking activation. A downstream node such as C must visibly remain not executed when its gate is incomplete.
  - Show a compact progress/frontier summary with totals and counts from the host projection, plus a concise explanation of the current blocking/waiting state.
  - Implement actual fit-to-bounds using the measured modal viewport and layout dimensions, clamping scale/translation to safe limits; reset remains a separate deterministic action. Fit must work for the bounded maximum graph and resize/reopen.
  - Preserve on-demand loading, request correlation, retry-only-after-error behavior, modal focus/keyboard accessibility, and no request storm.
  - Interactive nodes either perform a real, tested inspect/focus action or are rendered as non-button graphics; no inert button affordance remains.
- Tests first:
  - Extend `webview/src/lib/workflow-graph-view.test.ts` with the owner scenario A succeeded, B executing/queued distinction, B gate partial, C not executed, multiple executing nodes, per-input blockers, and progress summary oracles.
  - Add pure layout/fit tests for a five-node chain, multi-entry fan-in, maximum bounded node count, resize, and scale/translation clamping.
  - Extend the Playwright M024 S05 journey to open the real seeded graph, assert every workflow task is already present in the worktree immediately after start, assert status-only changes after producer settlement, and assert the modal shows all gates/frontier/progress/fit behavior.
  - Add a Playwright pending-shell interaction test: selecting a shell shows waiting/inspect-only state and does not emit a turn/send request; after activation the same row becomes executable with the real queued activity.
  - Add reload and external patch journeys proving no task appears late solely because execution reached it.
- Anti-shortcut coverage:
  - Use a graph with at least two simultaneous executing nodes and multiple downstream gates; a solution that highlights one node or displays one detached gate fails.
  - Use a viewport narrower than the graph's natural width and assert Fit changes scale/translation so all bounded nodes are inside the viewport; a reset/no-op implementation fails.
  - Assert the worktree contains all shell IDs before any gate settlement and that settlement changes status/turn activity without increasing task membership; a solution that still lazy-creates tasks fails.
- Implementation obligations:
  - Refactor the pure graph reducer to consume the richer projection without inventing state from array order; preserve closed-world parser assumptions and truncation UX.
  - Update canvas edge/node rendering and modal details to associate gates with consumers and expose progress/frontier in concise operator language.
  - Implement measured fit-to-bounds with lifecycle cleanup and reduced-motion/accessibility-safe behavior; do not regress pan/zoom or Retry click handling.
  - Decide and test the pending-shell focus UX: no transcript fabrication, composer/lifecycle guard while pending, clear waiting message, and normal task behavior after activation.
  - Update E2E fixtures to seed durable start state through repository-shaped messages rather than mocking only a successful graph result; retain the existing protocol correlation and error tests.
- Acceptance criteria:
  - [x] AC-1: The owner scenario is visually observable in one graph: completed inputs are green, live execution nodes are accurately marked, blocked downstream gates identify the consumer and missing input, and not-yet-executed nodes remain visibly pending - proven by reducer and Playwright assertions.
  - [x] AC-2: All workflow task shells appear in the worktree immediately after workflow creation and later execution only changes their status/activity, not membership - proven by the end-to-end worktree journey.
  - [x] AC-3: Workflow progress/frontier summary and simultaneous active-node rendering remain correct for fan-in/concurrent graphs - proven by pure view and E2E tests.
  - [x] AC-4: Fit view genuinely fits the bounded graph while reset/pan/zoom/reopen continue to work - proven by layout/UI tests.
  - [x] AC-5: Pending shells cannot be accidentally executed from the worktree, and activated shells transition to ordinary workflow execution without duplicate task rows - proven by interaction and repository tests.
- Focused verification:
  - `npx vitest run webview/src/lib/workflow-graph-view.test.ts webview/src/lib/workflow-graph-layout.test.ts src/task/workflow-graph-webview-wiring.test.ts src/host/snapshot.test.ts src/host/workspace-patch.test.ts`
  - `npx playwright test e2e/muster-webview-state.spec.ts --grep "M024 S05 workflow graph|workflow shell|assembled journey"`
- Phase gates:
  - `npm run compile`
  - `npm run check:svelte`
  - `npm test`
  - `npx playwright test e2e/muster-webview-state.spec.ts --grep "M024 S05 workflow graph|assembled journey"`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow): complete operational graph visualization`

## Completion Criteria
- [ ] Every phase is complete and committed exactly once.
- [ ] Every acceptance criterion is checked.
- [ ] All global gates pass on final HEAD.
- [ ] Final `codex-impl-review` verdict is APPROVE for the complete plan range.
- [ ] Worktree is clean apart from pre-existing unrelated changes.

## Progress Log
| Phase | Status | Commit | Verification | Review |
|---|---|---|---|---|
| 1 | completed | this phase commit (`feat(workflow): materialize inert task shells at start`) | compile; svelte-check; focused 10 files/91 tests; phase gate 6 files/84 tests; broader 14 files/138 tests; focused Playwright | codex-impl-review round 9 APPROVE |
| 2 | completed | this phase commit (`feat(workflow): expose complete gate and execution state`) | compile; svelte-check; focused 5 files/34 tests; supplemental 3 files/115 tests | codex-impl-review round 6 APPROVE; 19 issues fixed |
| 3 | completed | this phase commit (`feat(workflow): complete operational graph visualization`) | compile; svelte-check; focused 5 files/45 tests; full 221 files/2720 tests; focused Playwright 4/4 | codex-impl-review round 3 APPROVE; 3 issues fixed |
