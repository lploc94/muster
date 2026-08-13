# M024 Workflow Reuse Review Follow-up

**Status:** IMPLEMENTED
**Recorded:** 2026-08-13  
**Source review:** `feat/m024-workflow-artifact-reuse-graph-visibility` at `a6ed434`  
**Implemented:** 2026-08-13 in `de030445cfcda2709b0615b563198541234d4322`
**Disposition:** All five accepted findings were remediated on `main` after PR #41 merged.

## Scope

This ledger records the unresolved findings from the final review of PR #41. It is not evidence that the findings are fixed, and it introduces no runtime behavior. Close this ledger only after every acceptance criterion and verification gate below passes.

## Accepted Findings

### F1 - Partial reuse rejects unbound predecessors instead of materializing them

**Severity:** High

`startWorkflowRun` expands a requested reused node over its predecessor closure and rejects the start with `node reuse closure incomplete` when any predecessor lacks an explicit reuse binding. This turns node-level reuse into an all-ancestors-or-nothing contract. Unbound nodes in the new run should retain normal workflow semantics and materialize rather than forcing callers to locate and bind every historical predecessor execution.

**Acceptance criteria**

- A caller may bind one valid destination node without binding its predecessors.
- Every unbound node materializes under the normal dependency and routing rules.
- Only explicitly bound nodes receive `reused` status and source provenance.
- Mixed materialized/reused fan-in remains deterministic across reload and concurrent settlement.
- Invalid explicit bindings still fail before any consumer task is created.

### F2 - The public MCP contract requires an undiscoverable source task ID

**Severity:** High

`start_workflow` now requires `{node, fromRun, fromNode, fromTask}`, but the public workflow inspection result does not expose the producer task identity needed to construct `fromTask`. A client that did not retain internal task IDs cannot use the new exact-execution binding contract from supported public APIs.

**Acceptance criteria**

- A public read API exposes the source task ID for each reusable materialized node.
- The identifier is scoped to the existing workflow authorization boundary and is not inferred from "latest" state.
- A client can inspect a completed run and pass the returned identities directly to `start_workflow`.
- Public projection and bridge tests prove the complete inspect-then-reuse round trip.

### F3 - Reused nodes leave terminal workflow dependency gates live

**Severity:** Medium

Reused nodes do not own consumer tasks, but their dependency gates remain live after the run reaches a terminal state. Diagnostics report `terminal_run_has_live_gate`, and `reclaimTerminalWorkflowMetadata` cannot reclaim the run metadata.

**Acceptance criteria**

- A successful run containing reused nodes has no `open` or otherwise live gates after settlement.
- Reused-node inputs remain available to downstream materialized consumers.
- Terminal workflow diagnostics contain no `terminal_run_has_live_gate` for valid reuse runs.
- Retention can reclaim eligible terminal workflow metadata without special-casing a leaked gate.

### F4 - Reuse provenance and status can be rewritten after insertion

**Severity:** Medium

SQLite accepts updates that change a reused `workflow_nodes` row back to a materialized status and accepts replacement `source_run_id`, `source_node_id`, and `source_task_id` values. The durable graph can therefore cease to represent the exact source execution originally authorized by the caller.

**Acceptance criteria**

- SQLite rejects any post-insert mutation of reuse provenance.
- SQLite rejects transitions that add or remove reused identity after insertion.
- Valid lifecycle transitions for materialized nodes continue to work.
- Fresh-schema tests prove both invariants with direct SQL mutation attempts.
- If the schema changes, bump the reset-only schema version and update every pinned schema/documentation evidence check.

### F5 - Public guidance still advertises the obsolete two-field binding

**Severity:** Medium

Public tool guidance still describes reuse as `{node, fromRun}` even though the accepted MCP contract requires `{node, fromRun, fromNode, fromTask}`. This directs callers toward requests that validation rejects.

**Acceptance criteria**

- Tool descriptions, bridge guidance, task-management documentation, examples, and error recovery text describe the four-field binding consistently.
- No active public documentation advertises `{node, fromRun}` as a valid request.
- Documentation/evidence tests fail if the obsolete request shape returns.

## Completion Gate

- [x] F1 partial reuse materializes every unbound node.
- [x] F2 public inspection exposes exact reusable execution identity.
- [x] F3 terminal reuse runs leave no live dependency gates.
- [x] F4 SQLite makes reuse provenance immutable.
- [x] F5 all public guidance uses the four-field binding.
- [x] Focused workflow, bridge, projection, retention, schema, and documentation tests pass.
- [x] `npx tsc --noEmit -p .` passes.
- [x] Full CI passes on the remediation commit.

## Closure Evidence

- Implementing commit: `de030445cfcda2709b0615b563198541234d4322` (`fix: complete workflow reuse remediation`).
- F1 regression evidence:
  - `start_workflow mid-tree node reuse > persists every caller-bound node as reused with durable source provenance` proves an unbound predecessor materializes, then crosses a delayed reused cut point after source-task lineage cleanup.
  - `M024 S03 independent fan-in artifact reuse > serializes mixed materialized fan-in through a reused node and survives reload` proves concurrent settlement, exactly-once fills/activation, consumed reused gates, reload durability, and terminal completion.
- F2 regression evidence:
  - `M024 S03 durable mid-tree reuse > reuses one through four, activates and settles only five, pins the producer, and remains bounded` obtains the reusable task identity from bounded inspection.
  - `MusterBridgeServer auth > exposes the exact workflow catalog and rejects removed delegate-task tools` passes the returned public `runRef`, node, and `taskRef` directly into public `start_workflow` and asserts the exact internal four-field binding.
- F3 regression evidence: the M024 S03 durable chain and fan-in tests assert reused gates are `consumed`, valid terminal inspection has no `terminal_run_has_live_gate`, and no live gate remains after terminal settlement.
- F4 regression evidence: `workflow node reuse invariants` directly proves exact provenance requirements, source-task authority, immutable reuse identity/artifact coordinates, and valid materialized lifecycle transitions.
- F5 regression evidence: `M024 S04 agent-facing workflow graph boundary > pins exact reuse guidance across the active public surfaces` rejects the obsolete two-field shape across bridge and documentation sources.
- Schema decision: reset-only SQLite schema advanced from v4 to v5. Reused rows now pin exact source artifact coordinates, require complete provenance only for `status = 'reused'`, validate source-task authority at insertion, and reject later reuse identity/status mutation. Older owned stores fail closed with reset guidance; no in-place migration was added.
- Local verification:
  - `npm test`: 218 files and 2,678 tests passed.
  - `npm run compile`, `npm run test:source-boundary`, `npm run test:sqlite-storage-docs`, `npm run check:svelte`, and `git diff --check` passed.
  - Focused reviewer regressions: 7 files and 39 tests passed.
- Hosted verification: GitHub Actions CI run [31670707896](https://github.com/lploc94/muster/actions/runs/31670707896) passed for `de03044`, including the compile/full-webview job, SQLite Extension Host matrix, workflow graph native-host evidence, packaging gate, and real install gate.
